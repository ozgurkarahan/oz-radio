"""Boot block (contracts v1.2 §3): the first-paint data the server inlines into index.html.

Covers the injection (every index.html response, an explicit /index.html included), the escaping of hostile
titles, the fail-closed answer, the 10 s / 60 s cache with one background refresh, the kill switch and the
guarantee that the page is never delayed beyond the cold wait.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from html.parser import HTMLParser

import pytest

from services import demo_protocol as dp
from services.storage import StorageUnavailable

EN_ID = "2d7f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
FR_ID = "3e8f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
PLAIN_ID = "4f9f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
STALE_FLAG_ID = "5a0f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
EN_TITLE = "AI in three minutes · Live demo"
FR_TITLE = "L’IA en trois minutes · Démo en direct"
COLD_WAIT = dp.BOOT_COLD_WAIT_SECONDS                  # the contract value, captured before any test patches it

INDEX = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Oz Radio</title>'
    "<!--OZ_BOOT-->"
    '<script type="module" src="/assets/index-abc123de.js"></script></head>'
    '<body><div id="root">Opening Oz Radio…</div></body></html>'
)
NO_STORE = "no-cache, no-store, must-revalidate"
ELEMENT = re.compile(r'<script type="application/json" id="oz-boot">(.*?)</script>', re.S)


def deck_row(deck_id, title, *, language="en-US", published=True, live=True, **extra):
    row = {"id": deck_id, "source": "deck", "title": title, "filename": f"{title}.pptx", "slide_count": 3,
           "language": language, "published": published, "live_demo": live}
    row.update(extra)
    return row


def default_rows():
    return [
        deck_row(FR_ID, FR_TITLE, language="fr-FR"),
        deck_row(EN_ID, EN_TITLE),
        deck_row(PLAIN_ID, "A published deck", live=False),                    # published, not a live demo
        deck_row(STALE_FLAG_ID, "Unpublished", published=False, live=True),    # a stale flag on an unpublished deck
    ]


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


class FakeStore:
    cosmos_available = True

    def __init__(self, rows=None):
        self.rows = default_rows() if rows is None else rows
        self.fail: Exception | None = None
        self.hang: threading.Event | None = None
        self.calls = 0
        self.strict_args: list[bool] = []

    def list_decks(self, strict=False):
        self.calls += 1
        self.strict_args.append(strict)
        if self.hang is not None:
            self.hang.wait(30)
        if self.fail is not None:
            raise self.fail
        return [dict(r) for r in self.rows]


class Boot:
    def __init__(self, static, store, cache, clock):
        self.static, self.store, self.cache, self.clock = static, store, cache, clock

    def write_index(self, html):
        (self.static / "index.html").write_text(html, encoding="utf-8")


@pytest.fixture
def boot(tmp_path, monkeypatch, app_module):
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text(INDEX, encoding="utf-8")
    monkeypatch.setattr(app_module, "STATIC_DIR", str(static))
    monkeypatch.setenv("AUTH_MODE", "easyauth")
    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "true")
    store = FakeStore()
    monkeypatch.setattr(app_module, "store", store)
    # A loaded machine must not turn a data test into a fail-closed one: the real 0.15 s is pinned by the hang test.
    monkeypatch.setattr(dp, "BOOT_COLD_WAIT_SECONDS", 3.0)
    clock = FakeClock()
    cache = app_module.BootDataCache(app_module._fetch_boot_data, clock=clock)
    monkeypatch.setattr(app_module, "_boot_cache", cache)
    return Boot(static, store, cache, clock)


def boot_of(response):
    """(parsed boot JSON, raw element body) of an HTML response."""
    match = ELEMENT.search(response.text)
    assert match, f"no boot element in {response.text[:300]!r}"
    return json.loads(match.group(1)), match.group(1)


def until(predicate, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


# ---------------------------------------------------------------------------
# Injection
# ---------------------------------------------------------------------------
def test_boot_block_replaces_the_marker_with_the_live_decks(client, boot):
    r = client.get("/")
    assert r.status_code == 200
    data, _ = boot_of(r)
    assert data == {
        "v": 1, "ok": True,
        "demo": {"enabled": True, "session_seconds": 180, "qa": {"enabled": False, "max_questions": 2},
                 "remaining_today": 20},
        "live_demo_decks": [{"deck_id": EN_ID, "language": "en-US", "title": EN_TITLE},
                            {"deck_id": FR_ID, "language": "fr-FR", "title": FR_TITLE}],
        "telemetry": {"enabled": False},
    }
    assert "<!--OZ_BOOT-->" not in r.text and r.text.count('id="oz-boot"') == 1
    assert r.text.index('id="oz-boot"') < r.text.index('<script type="module"')    # before the app, in <head>
    assert r.text.replace(ELEMENT.search(r.text).group(0), "<!--OZ_BOOT-->") == INDEX
    assert boot.store.strict_args == [True]            # strict: a storage failure must never read as "no decks"


def test_boot_block_compact_json_and_key_order(client, boot):
    _, body = boot_of(client.get("/"))
    assert body.startswith('{"v":1,"ok":true,"demo":{"enabled":true,"session_seconds":180,'
                           '"qa":{"enabled":false,"max_questions":2},"remaining_today":20},"live_demo_decks":[')
    assert body.endswith('],"telemetry":{"enabled":false}}') and ", " not in body and ": " not in body


@pytest.mark.parametrize("path", ["/", "/decks", "/decks/abc/present", "/index.html", "/index.html/"])
def test_every_index_response_has_the_block_and_keeps_csp_and_no_store(client, boot, path):
    """§3.5: `/`, client routes and an explicit /index.html all go through the same path."""
    r = client.get(path)
    assert r.status_code == 200 and 'id="oz-boot"' in r.text and "<!--OZ_BOOT-->" not in r.text
    assert r.headers["cache-control"] == NO_STORE
    assert r.headers["content-type"] == "text/html; charset=utf-8"
    assert r.headers["content-security-policy"].startswith("frame-ancestors ")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert int(r.headers["content-length"]) == len(r.content)
    assert "content-encoding" not in r.headers


def test_a_page_without_the_marker_is_served_unchanged(client, boot):
    html = "<!doctype html><html><head><title>x</title></head><body>no marker é</body></html>"
    boot.write_index(html)
    r = client.get("/")
    assert r.content == html.encode("utf-8")
    assert r.headers["cache-control"] == NO_STORE and boot.store.calls == 0
    assert client.get("/index.html").content == html.encode("utf-8")


def test_only_the_first_marker_is_replaced(client, boot):
    boot.write_index(INDEX.replace("</body>", "<!--OZ_BOOT--></body>"))
    r = client.get("/")
    assert r.text.count('id="oz-boot"') == 1 and r.text.count("<!--OZ_BOOT-->") == 1


def test_other_static_files_are_not_touched(client, boot):
    (boot.static / "robots.txt").write_text("User-agent: *", encoding="utf-8")
    r = client.get("/robots.txt")
    assert r.text == "User-agent: *" and boot.store.calls == 0


# ---------------------------------------------------------------------------
# Escaping (injection safety)
# ---------------------------------------------------------------------------
HOSTILE_TITLES = [
    "</script><img src=x onerror=alert(1)>",
    "Q&A <b>bold</b> & more",
    "line\u2028separator\u2029paragraph",
    '"quoted" \\ back\\slash',
    "emoji 😀 and accents éàü",
    "--> <!-- <script>alert(1)</script>",
]


class _Tags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags: list[str] = []
        self.boot_data = ""
        self._in_boot = False

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        self._in_boot = tag == "script" and ("id", "oz-boot") in attrs

    def handle_endtag(self, tag):
        self._in_boot = False

    def handle_data(self, data):
        if self._in_boot:
            self.boot_data += data


def test_hostile_titles_round_trip_and_never_end_the_element(client, boot):
    boot.store.rows = [deck_row(f"{i:08x}-1c2d-4e5f-8a9b-0c1d2e3f4a5b", t, language="en-US")
                       for i, t in enumerate(HOSTILE_TITLES)]
    r = client.get("/")
    assert r.status_code == 200
    data, body = boot_of(r)
    assert sorted(d["title"] for d in data["live_demo_decks"]) == sorted(HOSTILE_TITLES)     # exact round trip
    # the element body holds none of the characters that could end it or confuse a parser
    for ch in ("<", ">", "&", "\u2028", "\u2029"):
        assert ch not in body
    assert body.isascii()
    parser = _Tags()
    parser.feed(r.text)
    assert parser.tags == ["html", "head", "meta", "title", "script", "script", "body", "div"]   # no injected element
    assert json.loads(parser.boot_data) == data
    outside = r.text.replace(body, "")                      # the page around the element: nothing of the title leaked
    assert "onerror" not in outside and "alert(1)" not in outside and "<img" not in r.text
    assert r.text.count("</script>") == INDEX.count("</script>") + 1


def test_lone_surrogates_and_oversize_titles_cannot_break_the_page(client, boot):
    boot.store.rows = [deck_row(EN_ID, "broken \ud800 title"), deck_row(FR_ID, "x" * 400, language="fr-FR")]
    r = client.get("/")
    assert r.status_code == 200
    data, _ = boot_of(r)
    by_id = {d["deck_id"]: d["title"] for d in data["live_demo_decks"]}
    assert by_id[EN_ID] == "broken \ud800 title"
    assert by_id[FR_ID] == "x" * 300                       # bounded: a title cannot bloat every page load


def test_other_fields_are_validated_not_just_escaped(client, boot):
    boot.store.rows = [
        deck_row(EN_ID, "ok", language='en-US"><script>alert(1)</script>'),
        deck_row("<img src=x>", "bad id"),
        deck_row(FR_ID, "no language", language=None),
        deck_row(PLAIN_ID, "numeric language", language=5),
    ]
    data, _ = boot_of(client.get("/"))
    assert {d["deck_id"]: d["language"] for d in data["live_demo_decks"]} == {
        EN_ID: "en-US", FR_ID: "en-US", PLAIN_ID: "en-US"}


def test_escape_boot_json_helper(app_module):
    raw = '{"a":"</script>&<>\u2028\u2029"}'
    assert app_module._escape_boot_json(raw) == '{"a":"\\u003c/script\\u003e\\u0026\\u003c\\u003e\\u2028\\u2029"}'
    assert json.loads(app_module._escape_boot_json(raw)) == json.loads(raw)


def test_live_decks_are_capped_and_sorted_by_casefolded_title_then_id(client, boot):
    rows = [deck_row(f"{i:08x}-1c2d-4e5f-8a9b-0c1d2e3f4a5b", f"deck {i % 5}") for i in range(30)]
    rows.append(deck_row("ffffffff-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "DECK 0"))      # sorts with the "deck 0" group
    boot.store.rows = rows
    decks = boot_of(client.get("/"))[0]["live_demo_decks"]
    assert len(decks) == dp.BOOT_MAX_LIVE_DECKS == 20
    keys = [(d["title"].casefold(), d["deck_id"]) for d in decks]
    assert keys == sorted(keys)
    # 7 x "deck 0" (6 + "DECK 0", whose id sorts last of them), 6 x "deck 1", 6 x "deck 2", then the first "deck 3"
    assert [d["title"] for d in decks[:7]].count("DECK 0") == 1 and decks[6]["title"] == "DECK 0"
    assert [d["title"].casefold() for d in decks].count("deck 3") == 1 and "deck 4" not in {d["title"] for d in decks}


# ---------------------------------------------------------------------------
# Fail closed / empty / off
# ---------------------------------------------------------------------------
def test_t1_04_a_store_failure_serves_the_html_with_ok_false(client, boot):
    """The page still loads (200) and carries the fail-closed block: never ok:true with an empty list."""
    boot.store.fail = StorageUnavailable("Cosmos DB query failed")
    r = client.get("/")
    assert r.status_code == 200 and r.headers["cache-control"] == NO_STORE
    data, _ = boot_of(r)
    assert data == dp.BOOT_FAIL_CLOSED and data["ok"] is False
    assert data["demo"]["enabled"] is False and data["live_demo_decks"] == []
    assert r.text.replace(ELEMENT.search(r.text).group(0), "<!--OZ_BOOT-->") == INDEX


def test_t1_04_an_uninitialised_store_also_fails_closed(client, boot, app_module, monkeypatch):
    monkeypatch.setattr(app_module, "store", None)
    assert boot_of(client.get("/"))[0] == dp.BOOT_FAIL_CLOSED


def test_t1_07a_an_empty_catalog_is_ok_true_with_no_decks(client, boot):
    """An empty list that is true (nothing live, or Cosmos not configured) is not a failure."""
    boot.store.rows = []
    data, _ = boot_of(client.get("/"))
    assert data["ok"] is True and data["demo"]["enabled"] is True and data["live_demo_decks"] == []
    assert data["demo"]["remaining_today"] == 20


def test_t3_01_the_demo_off_is_ok_true_at_once_and_never_reads_the_store(client, boot, monkeypatch):
    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "false")
    boot.store.fail = StorageUnavailable("must not matter")
    data, _ = boot_of(client.get("/"))
    assert data == {"v": 1, "ok": True,
                    "demo": {"enabled": False, "session_seconds": 180, "qa": {"enabled": False, "max_questions": 2},
                             "remaining_today": None},
                    "live_demo_decks": [], "telemetry": {"enabled": False}}
    assert boot.store.calls == 0 and boot.cache._last_start is None        # no Cosmos call, no refresh


def test_the_kill_switch_and_the_flags_are_read_on_every_request(client, boot, monkeypatch):
    first, _ = boot_of(client.get("/"))
    assert first["demo"]["enabled"] is True and len(first["live_demo_decks"]) == 2 and boot.store.calls == 1
    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "false")                   # immediate, although the cache is warm
    off, _ = boot_of(client.get("/"))
    assert off["demo"]["enabled"] is False and off["live_demo_decks"] == [] and off["demo"]["remaining_today"] is None
    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "true")
    monkeypatch.setenv("DEMO_QA_ENABLED", "true")
    monkeypatch.setenv("DEMO_QA_MAX_QUESTIONS", "3")
    monkeypatch.setenv("DEMO_QA_SESSION_SECONDS", "240")
    monkeypatch.setenv("DEMO_SESSION_SECONDS", "90")
    on, _ = boot_of(client.get("/"))
    assert on["demo"]["session_seconds"] == 240 and on["demo"]["qa"] == {"enabled": True, "max_questions": 3}
    monkeypatch.setenv("DEMO_QA_ENABLED", "false")
    qa_off, _ = boot_of(client.get("/"))
    assert qa_off["demo"]["session_seconds"] == 90 and qa_off["demo"]["qa"]["enabled"] is False
    assert boot.store.calls == 1                                         # none of that touched the store again


def test_remaining_today_unknown_is_null_and_used_up_is_zero(client, boot, monkeypatch):
    from security import DEMO_QUOTA

    class BrokenQuotaStore:
        def read_doc(self, doc_id):
            raise RuntimeError("cosmos down")

    DEMO_QUOTA.set_store(BrokenQuotaStore())
    data, _ = boot_of(client.get("/"))
    assert data["ok"] is True and data["demo"]["remaining_today"] is None and len(data["live_demo_decks"]) == 2
    DEMO_QUOTA.reset()
    boot.cache.reset()
    monkeypatch.setenv("DEMO_DAILY_SESSIONS", "1")
    assert DEMO_QUOTA.try_consume("198.51.100.1") is None
    assert boot_of(client.get("/"))[0]["demo"]["remaining_today"] == 0


# ---------------------------------------------------------------------------
# Never delays the page beyond the cold wait; never raises
# ---------------------------------------------------------------------------
def test_a_hanging_store_costs_the_html_at_most_the_cold_wait(client, boot, monkeypatch):
    monkeypatch.setattr(dp, "BOOT_COLD_WAIT_SECONDS", COLD_WAIT)               # the contract's 0.15 s
    assert COLD_WAIT == 0.15
    release = threading.Event()
    boot.store.hang = release
    try:
        started = time.monotonic()
        r = client.get("/")
        elapsed = time.monotonic() - started
        assert r.status_code == 200 and boot_of(r)[0] == dp.BOOT_FAIL_CLOSED
        assert elapsed < 1.5                                                # 0.15 s wait + request overhead
        # a second request while the refresh is still hung does not start another one (single flight) …
        client.get("/")
        assert boot.store.calls == 1
    finally:
        release.set()
    # … and once the store answers, the next page has the data
    assert until(lambda: boot.cache._snapshot is not None)
    assert len(boot_of(client.get("/"))[0]["live_demo_decks"]) == 2


def test_stale_data_is_served_while_one_refresh_runs_in_the_background(client, boot):
    old, _ = boot_of(client.get("/"))
    assert [d["deck_id"] for d in old["live_demo_decks"]] == [EN_ID, FR_ID] and boot.store.calls == 1
    boot.store.rows = [deck_row(PLAIN_ID, "Brand new live deck")]
    boot.clock.t += 5
    assert [d["deck_id"] for d in boot_of(client.get("/"))[0]["live_demo_decks"]] == [EN_ID, FR_ID]   # fresh (< 10 s)
    assert boot.store.calls == 1
    boot.clock.t += 20                                                    # 25 s old: stale, within 60 s
    stale, _ = boot_of(client.get("/"))
    assert [d["deck_id"] for d in stale["live_demo_decks"]] == [EN_ID, FR_ID]                      # served at once
    assert until(lambda: boot.store.calls == 2)                           # the background refresh
    assert until(lambda: [d["deck_id"] for d in boot_of(client.get("/"))[0]["live_demo_decks"]] == [PLAIN_ID])
    assert boot.store.calls == 2


def test_a_dead_store_is_not_hammered_and_never_reads_as_no_decks(client, boot):
    boot_of(client.get("/"))
    boot.store.fail = StorageUnavailable("down")
    boot.clock.t += 15                                                    # stale: refresh fails in the background
    for _ in range(5):
        data, _ = boot_of(client.get("/"))
        assert data["ok"] is True and len(data["live_demo_decks"]) == 2   # the last good data, never an empty list
    assert until(lambda: boot.store.calls == 2)
    boot.clock.t += 5                                                     # 20 s: the retry is 10 s after the last start
    for _ in range(5):
        client.get("/")
    time.sleep(0.05)
    assert boot.store.calls == 2                                          # cooling down: no new attempt yet
    boot.clock.t += 6                                                     # 26 s: another attempt is allowed
    client.get("/")
    assert until(lambda: boot.store.calls == 3)
    boot.clock.t += 40                                                    # 66 s since the last good read: too old
    data, _ = boot_of(client.get("/"))
    assert data == dp.BOOT_FAIL_CLOSED


def test_the_html_path_adds_no_store_load(client, boot):
    for _ in range(60):
        assert client.get("/").status_code == 200
    assert boot.store.calls == 1                                          # a page flood is not a Cosmos flood


def test_the_block_is_built_even_when_the_payload_builder_explodes(client, boot, app_module, monkeypatch):
    async def explode():
        raise RuntimeError("bug")

    monkeypatch.setattr(app_module, "_boot_payload", explode)
    r = client.get("/")
    assert r.status_code == 200 and boot_of(r)[0] == dp.BOOT_FAIL_CLOSED


# ---------------------------------------------------------------------------
# BootDataCache (fake clock, no HTTP)
# ---------------------------------------------------------------------------
class Fetcher:
    def __init__(self):
        self.calls = 0
        self.fail: Exception | None = None
        self.gate: threading.Event | None = None
        self.value = ((), 7)

    def __call__(self):
        self.calls += 1
        if self.gate is not None:
            self.gate.wait(30)
        if self.fail is not None:
            raise self.fail
        return self.value


@pytest.fixture
def cache_of(app_module):
    made = []

    def make(fetch, clock):
        cache = app_module.BootDataCache(fetch, clock=clock)
        made.append(cache)
        return cache

    yield make


def test_cache_fresh_for_ten_seconds_then_stale_up_to_sixty(cache_of):
    fetch, clock = Fetcher(), FakeClock()
    cache = cache_of(fetch, clock)

    async def run():
        first = await cache.get(cold_wait=2.0)
        assert first is not None and first.remaining_today == 7 and fetch.calls == 1
        clock.t += 9.9
        assert await cache.get() is first and fetch.calls == 1             # fresh
        fetch.value = ((), 6)
        clock.t += 0.2                                                      # 10.1 s: stale -> one background refresh
        assert await cache.get() is first                                   # served at once
        await _until_async(lambda: fetch.calls == 2)
        await _until_async(lambda: cache._snapshot is not first)
        assert (await cache.get()).remaining_today == 6
        clock.t += 59.9                                                     # still within 60 s of the refresh
        assert (await cache.get()).remaining_today == 6

    asyncio.run(run())


async def _until_async(predicate, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        await asyncio.sleep(0.005)
    assert predicate()


def test_cache_single_flight_under_concurrent_requests(cache_of):
    fetch, clock = Fetcher(), FakeClock()
    fetch.gate = threading.Event()
    cache = cache_of(fetch, clock)

    async def run():
        threading.Timer(0.05, fetch.gate.set).start()
        results = await asyncio.gather(*[cache.get(cold_wait=2.0) for _ in range(50)])
        assert fetch.calls == 1 and all(r is results[0] and r is not None for r in results)

    asyncio.run(run())


def test_cache_cold_wait_is_bounded_when_the_fetch_hangs(cache_of):
    fetch, clock = Fetcher(), FakeClock()
    fetch.gate = threading.Event()
    cache = cache_of(fetch, clock)

    async def run():
        started = time.monotonic()
        assert await cache.get() is None                                    # the first refresh hangs: fail closed
        elapsed = time.monotonic() - started
        assert 0.14 <= elapsed < 1.0
        started = time.monotonic()
        assert await cache.get() is None and time.monotonic() - started < 1.0
        assert fetch.calls == 1                                             # single flight even while it hangs
        fetch.gate.set()
        await _until_async(lambda: cache._snapshot is not None)
        assert await cache.get() is not None

    try:
        asyncio.run(run())
    finally:
        fetch.gate.set()


def test_cache_stale_older_than_sixty_seconds_with_a_failing_refresh_is_fail_closed(cache_of):
    fetch, clock = Fetcher(), FakeClock()
    cache = cache_of(fetch, clock)

    async def run():
        assert await cache.get(cold_wait=2.0) is not None
        fetch.fail = StorageUnavailable("down")
        clock.t += 30
        assert await cache.get() is not None                                # stale but usable
        await _until_async(lambda: fetch.calls == 2)
        clock.t += 31                                                       # 61 s old
        assert await cache.get(cold_wait=0.3) is None                       # the refresh fails: fail closed
        fetch.fail = None
        clock.t += 11
        assert await cache.get(cold_wait=1.0) is not None                   # a later refresh heals it

    asyncio.run(run())


def test_cache_failure_is_not_retried_before_the_ttl_and_is_logged_once_a_minute(cache_of, caplog):
    fetch, clock = Fetcher(), FakeClock()
    fetch.fail = RuntimeError("secret-connection-string=abc")
    cache = cache_of(fetch, clock)

    async def run():
        with caplog.at_level(logging.WARNING, logger="app"):
            assert await cache.get(cold_wait=0.3) is None
            await _until_async(lambda: fetch.calls == 1)
            for _ in range(5):
                clock.t += 1
                assert await cache.get(cold_wait=0.05) is None
            assert fetch.calls == 1                                         # 5 s after the failure: cooling down
            clock.t += 6                                                    # 11 s: a retry is allowed
            assert await cache.get(cold_wait=0.3) is None
            assert fetch.calls == 2
            warnings = [r for r in caplog.records if "Boot block refresh failed" in r.getMessage()]
            assert len(warnings) == 1                                       # at most once a minute
            clock.t += 61
            await cache.get(cold_wait=0.3)
            warnings = [r for r in caplog.records if "Boot block refresh failed" in r.getMessage()]
            assert len(warnings) == 2

    asyncio.run(run())
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "RuntimeError" in text and "secret-connection-string" not in text    # the type, never the message


def test_warm_starts_the_refresh_without_blocking_and_only_when_the_demo_is_on(cache_of, monkeypatch):
    fetch, clock = Fetcher(), FakeClock()
    fetch.gate = threading.Event()
    cache = cache_of(fetch, clock)
    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "false")
    cache.warm()
    time.sleep(0.05)
    assert fetch.calls == 0                                                 # the demo is off: no Cosmos call
    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "true")
    started = time.monotonic()
    cache.warm()                                                            # the fetch hangs; warm() must not
    assert time.monotonic() - started < 0.5
    assert until(lambda: fetch.calls == 1)
    cache.warm()
    time.sleep(0.05)
    assert fetch.calls == 1                                                 # single flight
    fetch.gate.set()
    assert until(lambda: cache._snapshot is not None)


def test_startup_warms_the_boot_cache_without_blocking_readiness(boot, app_module, monkeypatch):
    """lifespan() starts the refresh in the background and returns at once, even if the store hangs."""
    fetch = Fetcher()
    fetch.gate = threading.Event()
    cache = app_module.BootDataCache(fetch, clock=FakeClock())
    monkeypatch.setattr(app_module, "_boot_cache", cache)
    monkeypatch.setattr(app_module, "config", app_module.config)          # lifespan reassigns both: restore after
    monkeypatch.setattr(app_module, "store", app_module.store)

    async def run():
        started = time.monotonic()
        async with app_module.lifespan(app_module.app):
            assert time.monotonic() - started < 5.0
            assert until(lambda: fetch.calls == 1)                          # the warm-up is running in the background

    try:
        asyncio.run(run())
    finally:
        fetch.gate.set()

    off = Fetcher()
    monkeypatch.setattr(app_module, "_boot_cache", app_module.BootDataCache(off, clock=FakeClock()))
    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "false")

    async def run_off():
        async with app_module.lifespan(app_module.app):
            pass

    asyncio.run(run_off())
    time.sleep(0.05)
    assert off.calls == 0                                                   # demo off: nothing is read at startup
