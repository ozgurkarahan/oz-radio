"""Durable demo quota: survives restarts / scale-to-zero, fails closed, hashes IPs."""
from __future__ import annotations

import json

import pytest

from security import DemoQuota


class FakeStore:
    """In-memory stand-in for PresentationStore.read_doc / write_doc with etags."""

    def __init__(self):
        self.docs: dict[str, tuple[dict, int]] = {}
        self.conflicts_to_inject = 0
        self.fail = False

    def read_doc(self, doc_id):
        if self.fail:
            raise RuntimeError("cosmos down")
        if doc_id not in self.docs:
            return None, None
        doc, ver = self.docs[doc_id]
        return {**json.loads(json.dumps(doc)), "_etag": str(ver)}, str(ver)

    def write_doc(self, doc, etag):
        if self.fail:
            raise RuntimeError("cosmos down")
        if self.conflicts_to_inject:
            self.conflicts_to_inject -= 1
            return False
        current = self.docs.get(doc["id"])
        if etag is None:
            if current is not None:
                return False
            self.docs[doc["id"]] = (json.loads(json.dumps(doc)), 1)
            return True
        if current is None or str(current[1]) != etag:
            return False
        self.docs[doc["id"]] = (json.loads(json.dumps(doc)), current[1] + 1)
        return True


def _quota(store):
    q = DemoQuota()
    q.set_store(store)
    return q


def test_counters_survive_restart(monkeypatch):
    monkeypatch.setenv("DEMO_DAILY_SESSIONS", "2")
    monkeypatch.setenv("DEMO_DAILY_SESSIONS_PER_IP", "5")
    store = FakeStore()
    assert _quota(store).try_consume("203.0.113.1") is None
    # "restart": brand-new process-level object, same durable store
    assert _quota(store).try_consume("203.0.113.2") is None
    assert _quota(store).try_consume("203.0.113.3") == "global"


def test_per_ip_cap_and_ip_is_hashed(monkeypatch):
    monkeypatch.setenv("DEMO_DAILY_SESSIONS_PER_IP", "1")
    store = FakeStore()
    q = _quota(store)
    assert q.try_consume("198.51.100.7") is None
    assert q.try_consume("198.51.100.7") == "ip"
    assert q.try_consume("198.51.100.8") is None
    raw = json.dumps(store.docs)
    assert "198.51.100.7" not in raw and "198.51.100.8" not in raw


def test_minutes_cap(monkeypatch):
    monkeypatch.setenv("DEMO_DAILY_MINUTES", "1")
    store = FakeStore()
    q = _quota(store)
    assert q.try_consume("192.0.2.1") is None
    q.add_seconds(61)
    assert _quota(store).try_consume("192.0.2.2") == "minutes"


def test_conflicts_are_retried():
    store = FakeStore()
    store.conflicts_to_inject = 3
    q = _quota(store)
    assert q.try_consume("192.0.2.10") is None
    doc = next(iter(store.docs.values()))[0]
    assert doc["total"] == 1


def test_persistent_conflicts_refuse():
    store = FakeStore()
    store.conflicts_to_inject = 100
    assert _quota(store).try_consume("192.0.2.11") == "busy"


def test_fails_closed_when_store_down():
    store = FakeStore()
    store.fail = True
    q = _quota(store)
    assert q.try_consume("192.0.2.12") == "unavailable"
    assert q.remaining_today() == 0
    q.add_seconds(30)  # must not raise


def test_remaining_today_or_none_tells_an_outage_from_an_empty_budget(monkeypatch):
    """The boot block shows "unknown" (None) for a store outage; /api/demo/config keeps answering 0."""
    monkeypatch.setenv("DEMO_DAILY_SESSIONS", "3")
    store = FakeStore()
    q = _quota(store)
    assert q.remaining_today_or_none() == 3 and q.remaining_today() == 3
    assert q.try_consume("192.0.2.30") is None
    assert q.remaining_today_or_none() == 2
    store.fail = True
    assert q.remaining_today_or_none() is None
    assert q.remaining_today() == 0
    store.fail = False
    monkeypatch.setenv("DEMO_DAILY_SESSIONS", "1")
    assert q.remaining_today_or_none() == 0          # a genuinely used-up budget is 0, not None


def test_remaining_today_or_none_in_memory_without_store(monkeypatch):
    monkeypatch.setenv("DEMO_DAILY_SESSIONS", "2")
    q = DemoQuota()
    assert q.remaining_today_or_none() == 2
    q.try_consume("192.0.2.31")
    assert q.remaining_today_or_none() == 1


def test_in_memory_fallback_without_store(monkeypatch):
    monkeypatch.setenv("DEMO_DAILY_SESSIONS", "1")
    q = DemoQuota()
    assert q.try_consume("192.0.2.20") is None
    assert q.try_consume("192.0.2.21") == "global"


@pytest.mark.parametrize("reason", ["busy", "unavailable"])
def test_ws_maps_store_failure_to_4503_not_busy(reason, client, monkeypatch):
    """[T3-02] A quota store that is busy or down closes 4503 (outage), never 1013 ("another visitor");
    quota exhaustion stays 4429 and 1013 is only the demo slot being taken."""
    from security import DEMO_QUOTA

    monkeypatch.setattr(DEMO_QUOTA, "try_consume", lambda ip: reason)
    import app as app_module
    from starlette.websockets import WebSocketDisconnect

    monkeypatch.setenv("PUBLIC_DEMO_ENABLED", "true")
    deck_id = "11111111-1111-4111-8111-111111111111"
    deck = {"id": deck_id, "source": "deck", "published": True, "live_demo": True,
            "language": "en-US", "slides": [{"index": 0, "title": "t", "notes": "n"}]}

    class _Store:
        cosmos_available = True

        def get_presentation(self, _id):
            return deck

    monkeypatch.setattr(app_module, "store", _Store())
    monkeypatch.setattr(app_module, "config", object())
    with client.websocket_connect(f"/ws/voice/demo?deck_id={deck_id}", headers={"origin": "http://testserver"}) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 4503
    assert exc.value.reason == "Live demo temporarily unavailable"
    from security import DEMO_SESSIONS

    assert DEMO_SESSIONS.active == 0


def test_slide_narration_fallbacks():
    from services.voice_proxy import slide_narration

    assert slide_narration({"title": "AI Fundamentals", "body": "Oz Radio - Demo", "notes": "Welcome."}) == "Welcome."
    assert slide_narration({"title": "AI Fundamentals", "body": "Oz Radio - Demo"}) == "AI Fundamentals. Oz Radio - Demo"
    assert slide_narration({"title": "Only title"}) == "Only title"
    assert slide_narration({}) == ""
