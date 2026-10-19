"""Speaker notes on the Decks present page: admin payload carries cached
translations; the anonymous payload never carries body, notes or translations
(only the slide's visible text, as ``text``)."""
from __future__ import annotations

import copy

import pytest

DECK_PUB = "2d7f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
DECK_PRIV = "3e8f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"

# Anonymous slides gain the visible text (contracts v1.2 §2.2); the admin payload (body, notes, translations) is
# deliberately unchanged: it has its own `body` and must never gain `text`.
PUBLIC_SLIDE_KEYS = {"index", "title", "image_url", "text"}
ADMIN_SLIDE_KEYS = {"index", "title", "image_url", "body", "notes", "translated_notes"}


class FakeDeckStore:
    cosmos_available = True
    available = False

    def __init__(self):
        slides = [
            {"index": 0, "title": "Intro", "body": "BODY-0", "notes": "NOTES-0",
             "translated_notes": {"fr-FR": "NOTES-FR-0", "es-ES": "", "bad": 3}},
            {"index": 1, "title": "Next", "body": "BODY-1", "notes": "NOTES-1"},
            {"index": 2, "title": "Empty", "body": "", "notes": "  "},
        ]
        self.docs = {
            DECK_PUB: {"id": DECK_PUB, "source": "deck", "filename": "Pub.pptx", "slide_count": 3,
                       "published": True, "live_demo": True, "slides": copy.deepcopy(slides)},
            DECK_PRIV: {"id": DECK_PRIV, "source": "deck", "filename": "Priv.pptx", "slide_count": 3,
                        "slides": copy.deepcopy(slides)},
        }
        self.saved: list[dict] = []

    def get_presentation(self, pid, strict=False):
        return copy.deepcopy(self.docs.get(pid))

    def save_presentation(self, doc):
        self.saved.append(copy.deepcopy(doc))
        self.docs[doc["id"]] = copy.deepcopy(doc)
        return True


@pytest.fixture
def store(monkeypatch):
    import routers.decks as decks

    st = FakeDeckStore()
    monkeypatch.setattr(decks, "_store", lambda cfg: st)
    return st


def test_anonymous_deck_has_no_notes_body_or_translations(client, easyauth, store):
    r = client.get(f"/api/decks/{DECK_PUB}")
    assert r.status_code == 200
    data = r.json()
    for slide in data["slides"]:
        assert set(slide) == PUBLIC_SLIDE_KEYS
        assert "notes" not in slide and "translated_notes" not in slide and "body" not in slide
    # The body is visible slide text (served as `text`); the speaker notes and their translations never leak.
    for secret in ("NOTES-0", "NOTES-FR-0", "NOTES-1", "translated_notes", '"notes"', '"body"'):
        assert secret not in r.text
    assert data["slides"][0] == {"index": 0, "title": "Intro", "image_url": f"/api/slides/{DECK_PUB}/0.png",
                                 "text": "BODY-0"}
    assert [s["text"] for s in data["slides"]] == ["BODY-0", "BODY-1", ""]
    assert data["live_demo"] is True and data["published"] is True
    assert data["audience_level"] is None


def test_admin_deck_includes_only_cached_translated_notes(client, easyauth, store):
    r = client.get(f"/api/decks/{DECK_PRIV}", headers=easyauth())
    assert r.status_code == 200
    slides = r.json()["slides"]
    assert all(set(s) == ADMIN_SLIDE_KEYS for s in slides)
    assert all("text" not in s for s in slides)  # the admin payload has `body`, never the public `text`
    assert slides[0]["notes"] == "NOTES-0" and slides[0]["body"] == "BODY-0"
    assert slides[0]["translated_notes"] == {"fr-FR": "NOTES-FR-0"}
    assert slides[1]["translated_notes"] == {}


def test_auth_disabled_local_dev_gets_admin_payload(client, store):
    # AUTH_MODE=disabled (local dev) treats every caller as admin.
    slide = client.get(f"/api/decks/{DECK_PUB}").json()["slides"][0]
    assert slide["translated_notes"] == {"fr-FR": "NOTES-FR-0"}


def test_translate_notes_is_admin_only(client, easyauth, store):
    url = f"/api/decks/{DECK_PRIV}/translate-notes"
    assert client.post(url, json={"target_language": "fr-FR"}).status_code == 401
    assert client.post(url, json={"target_language": "fr-FR"},
                       headers=easyauth(oid="99999999-8888-7777-6666-555555555555")).status_code == 403
    assert store.saved == []


def test_translate_notes_rejects_bad_language(client, easyauth, store):
    r = client.post(f"/api/decks/{DECK_PRIV}/translate-notes", json={"target_language": "fr; drop"},
                    headers=easyauth())
    assert r.status_code == 422


def test_translate_notes_translates_missing_and_caches(client, easyauth, store, monkeypatch):
    import routers.decks as decks

    monkeypatch.setattr(decks, "get_openai_client", lambda cfg: object())
    calls: list[tuple[str, str]] = []

    def fake_translate(_client, text, lang, _deployment):
        calls.append((text, lang))
        return f"{text}-{lang}"

    monkeypatch.setattr(decks, "translate_text", fake_translate)
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")

    url = f"/api/decks/{DECK_PRIV}/translate-notes"
    r = client.post(url, json={"target_language": "es-ES"}, headers=easyauth())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cached"] is False
    assert body["translated_notes"] == {"0": "NOTES-0-es-ES", "1": "NOTES-1-es-ES"}
    assert sorted(calls) == [("NOTES-0", "es-ES"), ("NOTES-1", "es-ES")]
    saved = store.docs[DECK_PRIV]["slides"]
    assert saved[0]["translated_notes"]["es-ES"] == "NOTES-0-es-ES"
    assert saved[0]["translated_notes"]["fr-FR"] == "NOTES-FR-0"
    assert saved[1]["translated_notes"] == {"es-ES": "NOTES-1-es-ES"}
    assert "translated_notes" not in saved[2]
    assert store.docs[DECK_PRIV]["source"] == "deck"

    # Second call is served from the cache: no translation, no extra save.
    calls.clear()
    n_saved = len(store.saved)
    r = client.post(url, json={"target_language": "es-ES"}, headers=easyauth())
    assert r.json()["cached"] is True and calls == [] and len(store.saved) == n_saved

    # The admin deck payload now exposes the cached translation.
    slide = client.get(f"/api/decks/{DECK_PRIV}", headers=easyauth()).json()["slides"][1]
    assert slide["translated_notes"] == {"es-ES": "NOTES-1-es-ES"}


def test_translate_notes_unknown_deck(client, easyauth, store):
    r = client.post("/api/decks/4f9f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/translate-notes",
                    json={"target_language": "fr-FR"}, headers=easyauth())
    assert r.status_code == 404


def test_rebranded_deck_image_urls_are_cache_busted(client, easyauth, store):
    # `rebrand-decks` overwrites slide PNGs under the same names and bumps images_version.
    store.docs[DECK_PUB]["images_version"] = 2
    anon = client.get(f"/api/decks/{DECK_PUB}").json()["slides"][0]
    assert anon["image_url"] == f"/api/slides/{DECK_PUB}/0.png?v=2"
    admin = client.get(f"/api/decks/{DECK_PUB}", headers=easyauth()).json()["slides"][1]
    assert admin["image_url"] == f"/api/slides/{DECK_PUB}/1.png?v=2"
