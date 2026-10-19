"""Cookieless telemetry flags (WU-J): ships dark, never raises, validated before it reaches the page.

The server decides whether the browser may report anything: ``TELEMETRY_ENABLED`` (default off) AND a usable
``TELEMETRY_CONNECTION_STRING`` (default empty) turn the ``telemetry`` section of the boot block on. Off is exactly
``{"enabled": false}``, the shape the page has always had. These tests pin the defaults (code, IaC, test env), the boot
shape in both states, the validation of the connection string (https endpoint, GUID key, nothing else), the fail-closed
behaviour and the escaping of the boot element.
"""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path

import pytest

import config
from services import demo_protocol as dp

KEY = "9826f519-9441-42e8-8f60-17224f150fce"
ENDPOINT = "https://swedencentral-0.in.applicationinsights.azure.com/"
ORIGIN = "https://swedencentral-0.in.applicationinsights.azure.com"
GOOD = (
    f"InstrumentationKey={KEY};IngestionEndpoint={ENDPOINT};"
    "LiveEndpoint=https://swedencentral.livediagnostics.monitor.azure.com/;ApplicationId=8d1f1f0e-7e43-4e0a-9d1e-0a6f3c2b9a11"
)
REPO = Path(__file__).resolve().parents[3]

INDEX = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Oz Radio</title>'
    "<!--OZ_BOOT-->"
    '<script type="module" src="/assets/index-abc123de.js"></script></head>'
    '<body><div id="root">Opening Oz Radio…</div></body></html>'
)
ELEMENT = re.compile(r'<script type="application/json" id="oz-boot">(.*?)</script>', re.S)
OFF = {"enabled": False}


def on(monkeypatch, connection_string: str | None = GOOD, flag: str = "true") -> None:
    monkeypatch.setenv("TELEMETRY_ENABLED", flag)
    if connection_string is None:
        monkeypatch.delenv("TELEMETRY_CONNECTION_STRING", raising=False)
    else:
        monkeypatch.setenv("TELEMETRY_CONNECTION_STRING", connection_string)


@pytest.fixture(autouse=True)
def _warm_process(monkeypatch):
    """A process that has been up for an hour: `server_cold` is false unless a test says otherwise."""
    monkeypatch.setattr(config, "PROCESS_STARTED", time.monotonic() - 3600)
    monkeypatch.setattr(config, "_telemetry_misconfig_logged", False)


@pytest.fixture
def page(tmp_path, monkeypatch, app_module, client):
    """The SPA shell served from a temp dir (demo off: the boot block needs no store), returning the boot of a GET."""
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text(INDEX, encoding="utf-8")
    monkeypatch.setattr(app_module, "STATIC_DIR", str(static))
    monkeypatch.setenv("AUTH_MODE", "easyauth")

    def get(path: str = "/"):
        response = client.get(path)
        assert response.status_code == 200
        match = ELEMENT.search(response.text)
        assert match, f"no boot element in {response.text[:300]!r}"
        return json.loads(match.group(1)), match.group(1), response

    return get


# ---------------------------------------------------------------------------
# Defaults: off in the code, in the test environment and in the infrastructure
# ---------------------------------------------------------------------------
def test_defaults_are_off_in_the_code_with_nothing_set(monkeypatch):
    monkeypatch.delenv("TELEMETRY_ENABLED", raising=False)
    monkeypatch.delenv("TELEMETRY_CONNECTION_STRING", raising=False)
    assert config.telemetry_enabled() is False
    assert config.telemetry_boot() == OFF


def test_the_test_environment_pins_both_defaults():
    import conftest

    assert conftest._OFFLINE_ENV["TELEMETRY_ENABLED"] == "false"
    assert conftest._OFFLINE_ENV["TELEMETRY_CONNECTION_STRING"] == ""


def test_the_boot_block_telemetry_is_exactly_enabled_false_by_default(page):
    data, body, _ = page()
    assert data["telemetry"] == OFF
    assert body.endswith('"telemetry":{"enabled":false}}')
    assert data["ok"] is True


@pytest.mark.parametrize("flag", ["", "0", "false", "False", "no", "off", "2", "enabled", "tru", "y"])
def test_anything_but_a_truthy_flag_is_off_even_with_a_valid_connection_string(page, monkeypatch, flag):
    on(monkeypatch, flag=flag)
    assert config.telemetry_enabled() is False
    assert page()[0]["telemetry"] == OFF


@pytest.mark.parametrize("flag", ["1", "true", "TRUE", "True", "yes", "on", " true ", "ON"])
def test_every_truthy_flag_spelling_turns_it_on_with_a_valid_connection_string(page, monkeypatch, flag):
    on(monkeypatch, flag=flag)
    assert config.telemetry_enabled() is True
    assert page()[0]["telemetry"]["enabled"] is True


def test_the_flag_alone_is_not_enough(page, monkeypatch):
    on(monkeypatch, connection_string=None)
    assert config.telemetry_enabled() is True
    assert page()[0]["telemetry"] == OFF
    on(monkeypatch, connection_string="   ")
    assert page()[0]["telemetry"] == OFF


def test_a_connection_string_alone_is_not_enough(page, monkeypatch):
    on(monkeypatch, flag="false")
    assert page()[0]["telemetry"] == OFF


def test_the_infrastructure_defaults_equal_the_code_defaults_and_the_flags_flow_through():
    infra = REPO / "infra"
    if not (infra / "main.bicep").is_file():
        pytest.skip("infra/ is not part of this checkout")
    parameters = json.loads((infra / "main.parameters.json").read_text(encoding="utf-8"))["parameters"]
    assert parameters["telemetryEnabled"]["value"] == "${TELEMETRY_ENABLED=false}"
    assert parameters["telemetryConnectionString"]["value"] == "${TELEMETRY_CONNECTION_STRING=}"

    main = (infra / "main.bicep").read_text(encoding="utf-8")
    module = (infra / "modules" / "containerapp.bicep").read_text(encoding="utf-8")
    for text in (main, module):
        assert re.search(r"^param telemetryEnabled string = 'false'$", text, re.M)
        assert re.search(r"^param telemetryConnectionString string = ''$", text, re.M)
    assert "telemetryEnabled: telemetryEnabled" in main
    assert "telemetryConnectionString: telemetryConnectionString" in main
    assert "{ name: 'TELEMETRY_ENABLED', value: telemetryEnabled }" in module
    assert "{ name: 'TELEMETRY_CONNECTION_STRING', value: telemetryConnectionString }" in module

    readme = (infra / "README.md").read_text(encoding="utf-8")
    assert re.search(r"^\| `TELEMETRY_ENABLED` \| `false` \|", readme, re.M)
    assert re.search(r"^\| `TELEMETRY_CONNECTION_STRING` \| empty \|", readme, re.M)


# ---------------------------------------------------------------------------
# On: the validated fields
# ---------------------------------------------------------------------------
def test_on_with_a_valid_connection_string_the_fields_are_present_and_validated(page, monkeypatch):
    on(monkeypatch)
    data, body, _ = page()
    assert data["telemetry"] == {"enabled": True, "ingestion": ORIGIN, "ikey": KEY, "server_cold": False}
    # compact, in the documented order; only the two validated values and the flag, nothing of the rest of the string
    assert body.endswith(f'"telemetry":{{"enabled":true,"ingestion":"{ORIGIN}","ikey":"{KEY}","server_cold":false}}}}')
    assert "LiveEndpoint" not in body and "ApplicationId" not in body and "livediagnostics" not in body
    assert re.fullmatch(dp.BOOT_TELEMETRY_INGESTION_PATTERN, data["telemetry"]["ingestion"])
    assert re.fullmatch(dp.BOOT_TELEMETRY_IKEY_PATTERN, data["telemetry"]["ikey"], re.I)


def test_server_cold_is_true_in_the_first_minute_and_false_afterwards(page, monkeypatch):
    on(monkeypatch)
    monkeypatch.setattr(config, "PROCESS_STARTED", time.monotonic() - 30)
    assert page()[0]["telemetry"]["server_cold"] is True
    monkeypatch.setattr(config, "PROCESS_STARTED", time.monotonic() - 120)
    assert page()[0]["telemetry"]["server_cold"] is False
    assert dp.BOOT_TELEMETRY_SERVER_COLD_SECONDS == 60


def test_a_process_that_has_just_started_is_cold(monkeypatch):
    on(monkeypatch)
    monkeypatch.setattr(config, "PROCESS_STARTED", time.monotonic())
    assert config.telemetry_boot()["server_cold"] is True


def test_the_switch_is_read_on_every_request(page, monkeypatch):
    on(monkeypatch)
    assert page()[0]["telemetry"]["enabled"] is True
    monkeypatch.setenv("TELEMETRY_ENABLED", "false")
    assert page()[0]["telemetry"] == OFF                    # immediate: no restart, no cache
    monkeypatch.setenv("TELEMETRY_ENABLED", "true")
    monkeypatch.setenv("TELEMETRY_CONNECTION_STRING", "")
    assert page()[0]["telemetry"] == OFF


def test_telemetry_does_not_depend_on_the_demo_flag(page, monkeypatch):
    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "false")
    on(monkeypatch)
    data = page()[0]
    assert data["demo"]["enabled"] is False and data["ok"] is True
    assert data["telemetry"]["enabled"] is True


@pytest.mark.parametrize("connection_string, ingestion, ikey", [
    # names are case-insensitive, an upper-case key is normalised, the endpoint's trailing slash is dropped
    (f"INSTRUMENTATIONKEY={KEY.upper()};ingestionendpoint={ENDPOINT}", ORIGIN, KEY),
    (f"InstrumentationKey={KEY};IngestionEndpoint={ORIGIN}", ORIGIN, KEY),
    # order, spaces, a trailing semicolon and unknown settings do not matter
    (f" IngestionEndpoint = {ENDPOINT} ; InstrumentationKey = {KEY} ;; Authorization=ikey;", ORIGIN, KEY),
    # scheme and host are lower-cased
    (f"InstrumentationKey={KEY};IngestionEndpoint=HTTPS://SwedenCentral-0.In.ApplicationInsights.Azure.COM/", ORIGIN, KEY),
    # any DNS name is accepted (sovereign clouds, private ingestion): https and a GUID are the rules
    (f"InstrumentationKey={KEY};IngestionEndpoint=https://usgovvirginia-1.in.applicationinsights.azure.us", "https://usgovvirginia-1.in.applicationinsights.azure.us", KEY),
])
def test_accepted_connection_string_forms(connection_string, ingestion, ikey):
    assert config.parse_telemetry_connection_string(connection_string) == (ingestion, ikey)


BAD_STRINGS = {
    "empty": "",
    "blank": "   ",
    "no key": f"IngestionEndpoint={ENDPOINT}",
    "no endpoint": f"InstrumentationKey={KEY}",
    "key not a guid": f"InstrumentationKey=not-a-guid;IngestionEndpoint={ENDPOINT}",
    "key too short": f"InstrumentationKey={KEY[:-1]};IngestionEndpoint={ENDPOINT}",
    "key too long": f"InstrumentationKey={KEY}0;IngestionEndpoint={ENDPOINT}",
    "key in braces": f"InstrumentationKey={{{KEY}}};IngestionEndpoint={ENDPOINT}",
    "key with a script": f"InstrumentationKey={KEY}</script>;IngestionEndpoint={ENDPOINT}",
    "http endpoint": f"InstrumentationKey={KEY};IngestionEndpoint=http://swedencentral-0.in.applicationinsights.azure.com/",
    "no scheme": f"InstrumentationKey={KEY};IngestionEndpoint=swedencentral-0.in.applicationinsights.azure.com",
    "scheme-relative": f"InstrumentationKey={KEY};IngestionEndpoint=//swedencentral-0.in.applicationinsights.azure.com/",
    "javascript url": f"InstrumentationKey={KEY};IngestionEndpoint=javascript:alert(1)",
    "credentials": f"InstrumentationKey={KEY};IngestionEndpoint=https://user:pw@swedencentral-0.in.applicationinsights.azure.com/",
    "userinfo trick": f"InstrumentationKey={KEY};IngestionEndpoint=https://swedencentral-0.in.applicationinsights.azure.com@evil.example.net/",
    "port": f"InstrumentationKey={KEY};IngestionEndpoint=https://swedencentral-0.in.applicationinsights.azure.com:8443/",
    "path": f"InstrumentationKey={KEY};IngestionEndpoint=https://swedencentral-0.in.applicationinsights.azure.com/v2/track",
    "query": f"InstrumentationKey={KEY};IngestionEndpoint=https://swedencentral-0.in.applicationinsights.azure.com/?a=1",
    "fragment": f"InstrumentationKey={KEY};IngestionEndpoint=https://swedencentral-0.in.applicationinsights.azure.com/#a",
    "two slashes": f"InstrumentationKey={KEY};IngestionEndpoint=https://swedencentral-0.in.applicationinsights.azure.com//",
    "ipv4": f"InstrumentationKey={KEY};IngestionEndpoint=https://203.0.113.7/",
    "ipv6": f"InstrumentationKey={KEY};IngestionEndpoint=https://[::1]/",
    "localhost": f"InstrumentationKey={KEY};IngestionEndpoint=https://localhost/",
    "one label": f"InstrumentationKey={KEY};IngestionEndpoint=https://intranet/",
    "underscore": f"InstrumentationKey={KEY};IngestionEndpoint=https://bad_host.example.com/",
    "leading hyphen": f"InstrumentationKey={KEY};IngestionEndpoint=https://-bad.example.com/",
    "trailing dot": f"InstrumentationKey={KEY};IngestionEndpoint=https://swedencentral-0.in.applicationinsights.azure.com./",
    "backslash": f"InstrumentationKey={KEY};IngestionEndpoint=https://swedencentral-0.in.applicationinsights.azure.com\\@evil.example.net/",
    "space in host": f"InstrumentationKey={KEY};IngestionEndpoint=https://swedencentral-0.in applicationinsights.azure.com/",
    "unicode host": f"InstrumentationKey={KEY};IngestionEndpoint=https://exämple.azure.com/",
    "script in host": f"InstrumentationKey={KEY};IngestionEndpoint=https://</script><img src=x onerror=alert(1)>.example.com/",
    "quote in host": f'InstrumentationKey={KEY};IngestionEndpoint=https://a".example.com/',
    "empty endpoint": f"InstrumentationKey={KEY};IngestionEndpoint=",
    "duplicate key": f"InstrumentationKey={KEY};InstrumentationKey={KEY};IngestionEndpoint={ENDPOINT}",
    "duplicate endpoint": f"InstrumentationKey={KEY};IngestionEndpoint={ENDPOINT};IngestionEndpoint=https://evil.example.net/",
    "a setting without a value separator": f"InstrumentationKey={KEY};garbage;IngestionEndpoint={ENDPOINT}",
    "too long": f"InstrumentationKey={KEY};IngestionEndpoint={ENDPOINT};Pad=" + "x" * 4100,
}


@pytest.mark.parametrize("connection_string", BAD_STRINGS.values(), ids=BAD_STRINGS.keys())
def test_an_invalid_connection_string_is_rejected(connection_string):
    assert config.parse_telemetry_connection_string(connection_string) is None


@pytest.mark.parametrize("connection_string", BAD_STRINGS.values(), ids=BAD_STRINGS.keys())
def test_an_invalid_connection_string_keeps_the_page_telemetry_off(page, monkeypatch, connection_string):
    on(monkeypatch, connection_string=connection_string)
    data, body, response = page()
    assert data["telemetry"] == OFF
    assert data["ok"] is True                                # a telemetry problem never degrades the rest of the block
    assert "evil.example.net" not in response.text and "alert(1)" not in response.text


def test_none_and_non_strings_never_raise():
    assert config.parse_telemetry_connection_string(None) is None
    assert config.parse_telemetry_connection_string(42) is None                 # type: ignore[arg-type]


def test_a_misconfiguration_is_logged_once_without_the_value(page, monkeypatch, caplog):
    on(monkeypatch, connection_string="InstrumentationKey=nope;IngestionEndpoint=https://secret-looking.example.com/")
    with caplog.at_level(logging.WARNING, logger="config"):
        for _ in range(3):
            assert page()[0]["telemetry"] == OFF
    warnings = [r for r in caplog.records if "TELEMETRY_CONNECTION_STRING" in r.getMessage()]
    assert len(warnings) == 1
    assert "secret-looking" not in warnings[0].getMessage() and "nope" not in warnings[0].getMessage()


# ---------------------------------------------------------------------------
# Fail closed, and the boot element stays safe
# ---------------------------------------------------------------------------
def test_a_telemetry_error_turns_telemetry_off_and_nothing_else(page, monkeypatch):
    on(monkeypatch)

    def explode(_raw):
        raise RuntimeError("boom")

    monkeypatch.setattr(config, "parse_telemetry_connection_string", explode)
    assert config.telemetry_boot() == OFF
    data = page()[0]
    assert data["telemetry"] == OFF
    assert data["ok"] is True and data["demo"]["enabled"] is False


def test_the_fail_closed_block_is_always_telemetry_off(page, monkeypatch, app_module):
    on(monkeypatch)
    assert dp.BOOT_FAIL_CLOSED["telemetry"] == OFF and dp.BOOT_FAIL_CLOSED["ok"] is False
    # demo on with a store that is not there: the boot block is the fail-closed one, whatever the telemetry flags say
    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "true")
    monkeypatch.setattr(app_module, "store", None)
    monkeypatch.setattr(app_module, "_boot_cache", app_module.BootDataCache(app_module._fetch_boot_data))
    data = page()[0]
    assert data["ok"] is False and data["telemetry"] == OFF


class FakeStore:
    cosmos_available = True

    def __init__(self, rows):
        self.rows = rows

    def list_decks(self, strict=False):
        return [dict(r) for r in self.rows]


def test_escaping_still_makes_the_element_safe_with_telemetry_on(page, monkeypatch, app_module):
    hostile = "</script><img src=x onerror=alert(1)> & <b> line\u2028separator\u2029paragraph"
    rows = [{"id": "2d7f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "source": "deck", "title": hostile, "filename": "x.pptx",
             "slide_count": 3, "language": "en-US", "published": True, "live_demo": True}]
    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "true")
    monkeypatch.setattr(app_module, "store", FakeStore(rows))
    monkeypatch.setattr(dp, "BOOT_COLD_WAIT_SECONDS", 3.0)
    monkeypatch.setattr(app_module, "_boot_cache", app_module.BootDataCache(app_module._fetch_boot_data))
    on(monkeypatch)
    data, body, response = page()
    assert data["telemetry"]["enabled"] is True
    assert data["live_demo_decks"][0]["title"] == hostile                       # round-trips through JSON.parse
    assert not re.search(r"[<>&\u2028\u2029]", body)                            # never ends the element
    assert response.text.count('id="oz-boot"') == 1
    assert response.headers["cache-control"] == "no-cache, no-store, must-revalidate"
    assert response.headers["content-security-policy"].startswith("frame-ancestors ")


def test_the_ingestion_origin_and_key_are_ascii_and_free_of_html_metacharacters(page, monkeypatch):
    on(monkeypatch)
    _, body, _ = page()
    telemetry = json.loads(body)["telemetry"]
    for value in (telemetry["ingestion"], telemetry["ikey"]):
        assert value.isascii() and not re.search(r"[<>&\"'\\\s]", value)
