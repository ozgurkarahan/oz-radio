"""Authentication / authorization matrix, /api/me and /ws/voice handshake checks."""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
from collections.abc import Mapping
from pathlib import Path

import pytest
from starlette.websockets import WebSocketDisconnect

import auth
from _helpers import ADMIN_OID, OTHER_OID, TENANT

UUID = "0b5f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"

# (method, path, kwargs) — a sample of gated (cost-bearing / admin) routes.
GATED = [
    ("post", "/api/upload", {"files": {"file": ("a.pptx", b"PK\x03\x04", "application/octet-stream")}}),
    ("post", "/api/decks/upload", {"files": {"file": ("a.pptx", b"PK\x03\x04", "application/octet-stream")}}),
    ("post", "/api/video/ingest", {"files": {"file": ("a.pdf", b"%PDF", "application/pdf")}}),
    ("post", "/api/podcast/ingest", {"files": {"file": ("a.txt", b"hello", "text/plain")}}),
    ("post", "/api/podcast/render", {"json": {}}),
    ("post", f"/api/video/render/{UUID}", {}),
    ("delete", "/api/podcast/library/job-1234abcd", {}),
    ("delete", "/api/video/library/sv-1234abcd", {}),
    ("delete", f"/api/decks/{UUID}", {}),
    ("delete", f"/api/presentations/{UUID}", {}),
    ("post", "/api/video/library/sv-1234abcd/publish", {"json": {"published": True}}),
    ("post", "/api/podcast/library/job-1234abcd/publish", {"json": {"published": True}}),
    ("post", f"/api/decks/{UUID}/publish", {"json": {"published": True}}),
    ("post", "/api/agent/chat", {"json": {"messages": [{"role": "user", "content": "hi"}]}}),
    ("post", "/api/translate", {"json": {"text": "hi", "target_language": "fr-FR"}}),
    ("post", "/api/avatar/batch", {"json": {"presentation_id": UUID}}),
    ("post", "/api/playlists/recommend", {"json": {"topic": "safety"}}),
    ("post", "/api/playlists/pl_0123456789ab/progress", {"json": {"deck_id": UUID, "slide_index": 0}}),
    ("get", "/api/presentations", {}),
    ("get", f"/api/slides/{UUID}", {}),
    ("get", "/api/podcast/voices", {}),
    ("get", "/api/playlists", {}),
    ("post", "/api/search", {"json": {"query": "x"}}),
]


@pytest.mark.parametrize("method,path,kwargs", GATED)
def test_anonymous_is_401(client, easyauth, method, path, kwargs):
    r = getattr(client, method)(path, **kwargs)
    assert r.status_code == 401, (path, r.status_code, r.text)
    assert r.json() == {"detail": "Sign-in required"}


@pytest.mark.parametrize("method,path,kwargs", GATED)
def test_wrong_tenant_is_403(client, easyauth, method, path, kwargs):
    headers = easyauth(oid=ADMIN_OID, tid="00000000-0000-0000-0000-000000000000")
    r = getattr(client, method)(path, headers=headers, **kwargs)
    assert r.status_code == 403, (path, r.status_code, r.text)
    assert r.json() == {"detail": "Not authorized"}


@pytest.mark.parametrize("method,path,kwargs", GATED[:6])
def test_not_allowlisted_is_403(client, easyauth, method, path, kwargs):
    r = getattr(client, method)(path, headers=easyauth(oid=OTHER_OID), **kwargs)
    assert r.status_code == 403
    assert r.json() == {"detail": "Not authorized"}


def test_principal_without_aad_idp_is_anonymous(client, easyauth):
    r = client.get("/api/presentations", headers=easyauth(idp="github"))
    assert r.status_code == 401


def test_garbage_principal_is_anonymous(client, easyauth):
    r = client.get(
        "/api/presentations",
        headers={"X-MS-CLIENT-PRINCIPAL": "not-base64!!", "X-MS-CLIENT-PRINCIPAL-IDP": "aad"},
    )
    assert r.status_code == 401


def test_allowlisted_admin_passes(client, easyauth):
    r = client.get("/api/presentations", headers=easyauth())
    assert r.status_code == 200
    r = client.get("/api/podcast/voices", headers=easyauth())
    assert r.status_code == 200 and len(r.json()) >= 16


def test_empty_tenant_setting_means_nobody_is_admin(client, easyauth, monkeypatch):
    monkeypatch.setenv("AUTH_TENANT_ID", "")
    assert client.get("/api/presentations", headers=easyauth()).status_code == 403


def test_disabled_mode_is_admin(client):
    r = client.get("/api/presentations")
    assert r.status_code == 200


def test_anonymous_routes_stay_open(client, easyauth):
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/me").status_code == 200
    assert client.get("/api/avatars").status_code == 200
    assert client.get("/api/video/library").status_code == 200
    assert client.get("/api/podcast/library").status_code == 200
    assert client.get("/api/decks").status_code == 200


# ---------------------------------------------------------------------------
# /api/me
# ---------------------------------------------------------------------------
def test_me_anonymous(client, easyauth):
    assert client.get("/api/me").json() == {
        "authenticated": False, "is_admin": False, "name": None, "auth_mode": "easyauth",
    }


def test_me_signed_in_not_admin(client, easyauth):
    body = client.get("/api/me", headers=easyauth(oid=OTHER_OID, name="Someone")).json()
    assert body == {"authenticated": True, "is_admin": False, "name": "Someone", "auth_mode": "easyauth"}


def test_me_admin(client, easyauth):
    body = client.get("/api/me", headers=easyauth()).json()
    assert body == {"authenticated": True, "is_admin": True, "name": "Test Admin", "auth_mode": "easyauth"}


def test_me_disabled(client):
    body = client.get("/api/me").json()
    assert body["auth_mode"] == "disabled" and body["is_admin"] is True and body["authenticated"] is True


# ---------------------------------------------------------------------------
# /ws/voice — rejected before accept()
# ---------------------------------------------------------------------------
def _ws_close_code(client, headers=None):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/voice", headers=headers or {}):
            pass
    return exc.value.code


def test_ws_anonymous_rejected(client, easyauth):
    assert _ws_close_code(client, {"origin": "http://testserver"}) == 4401


def test_ws_not_admin_rejected(client, easyauth):
    headers = {**easyauth(oid=OTHER_OID), "origin": "http://testserver"}
    assert _ws_close_code(client, headers) == 4403


def test_ws_bad_origin_rejected(client, easyauth):
    headers = {**easyauth(), "origin": "https://evil.example"}
    assert _ws_close_code(client, headers) == 4403


def test_ws_missing_origin_rejected_in_easyauth(client, easyauth):
    assert _ws_close_code(client, easyauth()) == 4403


def test_ws_allowed_origins_list(client, easyauth, monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://app.example")
    headers = {**easyauth(), "origin": "https://evil.example"}
    assert _ws_close_code(client, headers) == 4403


def test_origin_allowlist_is_additive(monkeypatch):
    from security import origin_allowed

    monkeypatch.setenv("AUTH_MODE", "easyauth")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://teams.example")
    assert origin_allowed({"origin": "https://app.example", "host": "app.example"})
    assert origin_allowed({"origin": "https://teams.example", "host": "app.example"})
    assert not origin_allowed({"origin": "https://evil.example", "host": "app.example"})


def test_ws_concurrency_cap(client, easyauth, monkeypatch, app_module):
    from security import VOICE_SESSIONS

    monkeypatch.setenv("MAX_VOICE_SESSIONS", "1")
    monkeypatch.setattr(app_module, "config", object())
    assert VOICE_SESSIONS.try_acquire()
    headers = {**easyauth(), "origin": "http://testserver"}
    with client.websocket_connect("/ws/voice", headers=headers) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1013


def test_origin_helper_same_origin_and_dev(monkeypatch):
    from security import origin_allowed

    monkeypatch.setenv("AUTH_MODE", "easyauth")
    assert origin_allowed({"origin": "https://app.example", "host": "app.example"})
    assert not origin_allowed({"origin": "https://evil.example", "host": "app.example"})
    assert not origin_allowed({"host": "app.example"})
    monkeypatch.setenv("AUTH_MODE", "disabled")
    assert origin_allowed({"origin": "http://localhost:5173", "host": "127.0.0.1:8000"})
    assert not origin_allowed({"origin": "https://evil.example", "host": "127.0.0.1:8000"})


def test_token_route_removed(client):
    r = client.get("/api/avatar/token")
    assert r.status_code == 404
    import services.avatar as avatar_mod

    assert not hasattr(avatar_mod, "get_speech_token")
    assert not any(getattr(rt, "path", "") == "/api/avatar/token" for rt in client.app.routes)


def test_user_id_comes_from_principal(monkeypatch):
    from auth import principal_from_headers
    from _helpers import principal_headers

    monkeypatch.setenv("AUTH_MODE", "easyauth")
    monkeypatch.setenv("AUTH_TENANT_ID", TENANT)
    monkeypatch.setenv("ALLOWED_OBJECT_IDS", ADMIN_OID)
    hdrs = {k.lower(): v for k, v in principal_headers().items()}
    assert principal_from_headers(hdrs).user_id == ADMIN_OID
    monkeypatch.setenv("AUTH_MODE", "disabled")
    assert principal_from_headers({}).user_id == "local-dev"


def test_admin_client_ip_diagnostic_is_admin_only(client, easyauth):
    assert client.get("/api/admin/client-ip").status_code == 401
    r = client.get("/api/admin/client-ip", headers={**easyauth(), "x-forwarded-for": "1.2.3.4, 203.0.113.9"})
    assert r.status_code == 200 and r.json()["client_ip"] == "203.0.113.9"


# ---------------------------------------------------------------------------
# Azure Container Apps guard: AUTH_MODE=disabled is never honoured on Azure
# ---------------------------------------------------------------------------
ACA_MARKERS = ("CONTAINER_APP_NAME", "CONTAINER_APP_REVISION")
ACA_ENV = {"CONTAINER_APP_NAME": "ca-test", "CONTAINER_APP_REVISION": "ca-test--0000001"}


@pytest.fixture
def fresh_guard(monkeypatch):
    """Start the test with the once-per-process CRITICAL flag unset."""
    monkeypatch.setattr(auth, "_refusal_logged", False)


def _criticals(caplog):
    return [r for r in caplog.records if r.levelno == logging.CRITICAL]


@pytest.mark.parametrize(
    "markers",
    [{"CONTAINER_APP_NAME": "ca-test"}, {"CONTAINER_APP_REVISION": "ca-test--0000001"}, ACA_ENV],
    ids=["name", "revision", "both"],
)
def test_disabled_is_refused_on_container_apps(client, fresh_guard, monkeypatch, markers):
    for name, value in markers.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("AUTH_MODE", "disabled")
    assert auth.auth_mode() == "easyauth"
    assert auth.principal_from_headers({}) == auth.ANONYMOUS
    assert auth.principal_from_headers({}).user_id == "anonymous"
    assert client.get("/api/presentations").status_code == 401
    assert client.get("/api/me").json() == {
        "authenticated": False, "is_admin": False, "name": None, "auth_mode": "easyauth",
    }


def test_refused_disabled_also_closes_the_websocket_and_localhost_origins(client, fresh_guard, monkeypatch):
    from security import origin_allowed

    for name, value in ACA_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("AUTH_MODE", "disabled")
    assert not origin_allowed({"origin": "http://localhost:5173", "host": "127.0.0.1:8000"})
    assert not origin_allowed({"host": "app.example"})
    assert _ws_close_code(client, {"origin": "http://testserver"}) == 4401


def test_easyauth_principals_are_still_parsed_under_the_guard(client, easyauth, fresh_guard, monkeypatch):
    for name, value in ACA_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("AUTH_MODE", "disabled")  # asked for, refused
    assert client.get("/api/presentations", headers=easyauth()).status_code == 200
    assert client.get("/api/presentations", headers=easyauth(oid=OTHER_OID)).status_code == 403
    wrong_tenant = easyauth(tid="00000000-0000-0000-0000-000000000000")
    assert client.get("/api/presentations", headers=wrong_tenant).status_code == 403
    assert client.get("/api/presentations").status_code == 401
    assert client.get("/api/me", headers=easyauth()).json() == {
        "authenticated": True, "is_admin": True, "name": "Test Admin", "auth_mode": "easyauth",
    }


def test_critical_is_logged_once_per_process(client, fresh_guard, monkeypatch, caplog):
    monkeypatch.setenv("CONTAINER_APP_NAME", "ca-secret-name-123")
    monkeypatch.setenv("AUTH_MODE", "disabled")
    with caplog.at_level(logging.DEBUG, logger="auth"):
        for _ in range(5):
            assert auth.auth_mode() == "easyauth"
        client.get("/api/me")
        client.get("/api/presentations")
        auth.log_startup_warnings()
    [record] = _criticals(caplog)
    assert "AUTH_MODE=disabled was refused" in record.getMessage()
    assert "Azure Container Apps" in record.getMessage()
    assert "ca-secret-name-123" not in caplog.text


def test_critical_is_logged_once_across_threads(fresh_guard, monkeypatch, caplog):
    monkeypatch.setenv("CONTAINER_APP_REVISION", "ca-test--0000001")
    monkeypatch.setenv("AUTH_MODE", "disabled")
    barrier = threading.Barrier(8)
    modes: list[str] = []

    def hammer():
        barrier.wait()
        modes.extend(auth.auth_mode() for _ in range(50))

    with caplog.at_level(logging.CRITICAL, logger="auth"):
        threads = [threading.Thread(target=hammer) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert len(modes) == 400 and set(modes) == {"easyauth"}
    assert len(_criticals(caplog)) == 1


@pytest.mark.parametrize("requested", [None, "", "easyauth", "EasyAuth", "bogus"])
def test_guard_is_silent_unless_disabled_was_requested(fresh_guard, monkeypatch, caplog, requested):
    monkeypatch.setenv("CONTAINER_APP_NAME", "ca-test")
    if requested is None:
        monkeypatch.delenv("AUTH_MODE", raising=False)
    else:
        monkeypatch.setenv("AUTH_MODE", requested)
    with caplog.at_level(logging.DEBUG, logger="auth"):
        assert auth.auth_mode() == "easyauth"
    assert not _criticals(caplog)


@pytest.mark.parametrize(
    "markers", [{}, {"CONTAINER_APP_NAME": "", "CONTAINER_APP_REVISION": ""}], ids=["unset", "empty"]
)
@pytest.mark.parametrize("value", ["disabled", "Disabled", " DISABLED "])
def test_local_disabled_mode_is_unchanged_outside_container_apps(
    client, fresh_guard, monkeypatch, caplog, markers, value
):
    for name in ACA_MARKERS:
        monkeypatch.delenv(name, raising=False)
    for name, marker_value in markers.items():
        monkeypatch.setenv(name, marker_value)
    monkeypatch.setenv("AUTH_MODE", value)
    with caplog.at_level(logging.DEBUG, logger="auth"):
        assert auth.auth_mode() == "disabled"
        assert client.get("/api/presentations").status_code == 200
        body = client.get("/api/me").json()
    assert body == {"authenticated": True, "is_admin": True, "name": "local-dev", "auth_mode": "disabled"}
    assert auth.principal_from_headers({}).user_id == "local-dev"
    assert not _criticals(caplog)


def test_startup_warnings_do_not_claim_admin_for_everyone_on_azure(fresh_guard, monkeypatch, caplog):
    for name, value in ACA_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("AUTH_MODE", "disabled")
    with caplog.at_level(logging.DEBUG, logger="auth"):
        auth.log_startup_warnings()
    assert "treated as admin" not in caplog.text
    assert len(_criticals(caplog)) == 1
    # The usual Easy Auth checks still run (tenant and allowlist are empty in the offline env).
    assert "AUTH_TENANT_ID is not set" in caplog.text and "ALLOWED_OBJECT_IDS is empty" in caplog.text


def test_startup_warning_for_local_disabled_mode_is_unchanged(fresh_guard, monkeypatch, caplog):
    for name in ACA_MARKERS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AUTH_MODE", "disabled")
    with caplog.at_level(logging.DEBUG, logger="auth"):
        auth.log_startup_warnings()
    assert "every caller is treated as admin" in caplog.text
    assert not _criticals(caplog)


class _EnvSpy(Mapping):
    """Read-only environment snapshot that records every key looked up."""

    def __init__(self, data):
        self._data = dict(data)
        self.reads: set[str] = set()

    def __getitem__(self, key):
        self.reads.add(key)
        return self._data[key]

    def __iter__(self):
        return iter(self._data)

    def __len__(self):
        return len(self._data)


@pytest.mark.parametrize(
    "extra",
    [{}, ACA_ENV, {**ACA_ENV, "ALLOW_INSECURE_NO_AUTH": "true"}],
    ids=["local", "azure", "azure-with-insecure-flag"],
)
def test_no_flag_can_bypass_the_guard(monkeypatch, extra):
    monkeypatch.setattr(auth, "_refusal_logged", True)  # keep logging out of the lookups
    spy = _EnvSpy({**os.environ, "AUTH_MODE": "disabled", **extra})
    with monkeypatch.context() as patch:
        patch.setattr(os, "environ", spy)
        mode = auth.auth_mode()
    assert mode == ("easyauth" if extra.get("CONTAINER_APP_NAME") else "disabled")
    assert spy.reads <= {"AUTH_MODE", *ACA_MARKERS}


def test_offline_test_env_clears_the_container_apps_markers():
    from conftest import _OFFLINE_ENV

    for name in ACA_MARKERS:
        assert _OFFLINE_ENV[name] == ""
        assert not os.environ.get(name)


# ---------------------------------------------------------------------------
# azd preprovision hooks: AUTH_MODE is read from the azd environment only
# ---------------------------------------------------------------------------
HOOKS_DIR = Path(__file__).resolve().parents[3] / "hooks"
AUTH_VALUES_OK = {
    "AUTH_CLIENT_ID": UUID,
    "AUTH_CLIENT_SECRET": "not-a-real-secret",
    "ALLOWED_OBJECT_IDS": ADMIN_OID,
}
HOOK_VARS = (
    "AUTH_MODE", "AUTH_CLIENT_ID", "AUTH_CLIENT_SECRET", "ALLOWED_OBJECT_IDS", "AUTH_TENANT_ID",
    "ALLOW_INSECURE_NO_AUTH",
)
HOOKS = [
    pytest.param("ps1", marks=pytest.mark.skipif(shutil.which("pwsh") is None, reason="pwsh is not installed")),
    pytest.param(
        "sh", marks=pytest.mark.skipif(os.name == "nt" or shutil.which("sh") is None, reason="needs a POSIX sh")
    ),
]
AZD_STUB = """\
import os, sys

args = sys.argv[1:]
with open(os.environ["AZD_STUB_LOG"], "a", encoding="utf-8") as log:
    log.write(" ".join(args) + "\\n")
if args[:2] != ["env", "get-value"] or len(args) != 3:
    sys.exit(2)
values = {}
with open(os.environ["AZD_STUB_VALUES"], encoding="utf-8") as fh:
    for line in fh:
        key, sep, value = line.rstrip("\\r\\n").partition("=")
        if sep:
            values[key] = value
if args[2] not in values:
    sys.stderr.write("ERROR: key not found\\n")
    sys.exit(1)
print(values[args[2]])
"""


def _run_hook(hook, workdir, azd_env, process_env=None):
    """Run a preprovision hook against a stand-in `azd` serving `azd_env` (the real azd is never invoked)."""
    bin_dir = workdir / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "azd_stub.py").write_text(AZD_STUB, encoding="utf-8")
    if os.name == "nt":
        (bin_dir / "azd.cmd").write_bytes(
            f'@echo off\r\n"{sys.executable}" "%~dp0azd_stub.py" %*\r\nexit /b %ERRORLEVEL%\r\n'.encode("utf-8")
        )
    else:
        wrapper = bin_dir / "azd"
        wrapper.write_text(
            f'#!/bin/sh\nexec "{sys.executable}" "$(dirname "$0")/azd_stub.py" "$@"\n', encoding="utf-8"
        )
        wrapper.chmod(0o755)
    values, calls = workdir / "azd-env.txt", workdir / "azd-calls.log"
    values.write_text("".join(f"{k}={v}\n" for k, v in azd_env.items()), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k not in HOOK_VARS}
    env.update(process_env or {})
    env.update(
        PATH=os.pathsep.join([str(bin_dir), env.get("PATH", "")]),
        AZD_STUB_VALUES=str(values),
        AZD_STUB_LOG=str(calls),
    )
    command = (
        [shutil.which("pwsh"), "-NoProfile", "-NonInteractive", "-File", str(HOOKS_DIR / "preprovision.ps1")]
        if hook == "ps1"
        else ["sh", str(HOOKS_DIR / "preprovision.sh")]
    )
    proc = subprocess.run(
        command, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120
    )
    return proc, (calls.read_text(encoding="utf-8").splitlines() if calls.exists() else [])


@pytest.mark.parametrize("hook", HOOKS)
def test_hook_refuses_auth_mode_disabled_in_the_azd_env(hook, tmp_path):
    proc, calls = _run_hook(hook, tmp_path, {**AUTH_VALUES_OK, "AUTH_MODE": "Disabled"})
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "AUTH_MODE=disabled" in proc.stdout + proc.stderr
    assert "env get-value AUTH_MODE" in calls


@pytest.mark.parametrize("hook", HOOKS)
def test_hook_refuses_auth_mode_disabled_even_with_allow_insecure_no_auth(hook, tmp_path):
    proc, _ = _run_hook(hook, tmp_path, {"ALLOW_INSECURE_NO_AUTH": "true", "AUTH_MODE": "disabled"})
    assert proc.returncode == 1, proc.stdout + proc.stderr


@pytest.mark.parametrize("hook", HOOKS)
def test_hook_ignores_auth_mode_in_the_process_environment(hook, tmp_path):
    # run-local sets AUTH_MODE=disabled in developer shells: only the azd environment decides.
    proc, calls = _run_hook(hook, tmp_path, AUTH_VALUES_OK, process_env={"AUTH_MODE": "disabled"})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Easy Auth configuration present" in proc.stdout
    assert "env get-value AUTH_MODE" in calls


@pytest.mark.parametrize("hook", HOOKS)
def test_hook_still_refuses_to_provision_without_authentication(hook, tmp_path):
    proc, _ = _run_hook(hook, tmp_path, {})
    assert proc.returncode == 1
    assert "refusing to provision without authentication" in proc.stdout + proc.stderr
