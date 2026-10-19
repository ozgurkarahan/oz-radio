"""maintenance.content — operator CLI for seeding/rendering/purging content.

Fully offline: the Cosmos store, blob libraries, OpenAI script generators and
render workers are replaced with in-memory fakes.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path

import pytest

from maintenance import content as mc
from services import avatar_registry
from services.podcast_models import DialogueTurn, ReactionHint
from services.video_models import SlideNarration

CUSTOM = json.dumps([
    {"id": "photo_female", "display_name": "Sofia", "character": "F_char",
     "gender": "female", "thumbnail": "photo_female.png", "default": True},
    {"id": "photo_male", "display_name": "Lucas", "character": "M_char",
     "gender": "male", "thumbnail": "photo_male.png"},
])

OLD_DECKS = {
    "climate-action": "340f50b9-c198-4453-aef4-e89295647ab6",
    "transition-energetique": "0f26e968-a26e-417e-a73f-c40a47ec3e16",
}


class FakeStore:
    cosmos_available = True
    available = True

    def __init__(self):
        self.docs: dict[str, dict] = {}
        self.blobs: dict[str, bytes] = {}

    def get_presentation(self, pid):
        d = self.docs.get(pid)
        return dict(d) if d else None

    def list_decks(self):
        return [dict(d) for d in self.docs.values() if d.get("source") == "deck"]

    def save_presentation(self, doc):
        self.docs[doc["id"]] = dict(doc)
        return True

    def set_deck_published(self, deck_id, published):
        from services.storage import PresentationStore
        return PresentationStore.set_deck_published(self, deck_id, published)  # type: ignore[arg-type]

    def set_deck_live_demo(self, deck_id, enabled):
        from services.storage import PresentationStore
        return PresentationStore.set_deck_live_demo(self, deck_id, enabled)  # type: ignore[arg-type]

    def set_deck_title(self, deck_id, title):
        from services.storage import PresentationStore
        return PresentationStore.set_deck_title(self, deck_id, title)  # type: ignore[arg-type]

    def delete_presentation(self, pid):
        return self.docs.pop(pid, None) is not None

    def delete_slide_images(self, pid):
        return True

    def list_playlists(self):
        return [dict(d) for d in self.docs.values() if d.get("source") == "playlist"]

    def get_playlist(self, pid):
        d = self.docs.get(pid)
        return dict(d) if d and d.get("source") == "playlist" else None

    def save_playlist(self, doc):
        self.docs[doc["id"]] = dict(doc)
        return True

    def delete_playlist(self, pid):
        return self.docs.pop(pid, None) is not None

    def playlists_referencing_deck(self, deck_id):
        return [p for p in self.list_playlists() if any(s["deck_id"] == deck_id for s in p.get("steps", []))]

    # Blob side (rebrand-decks)
    def upload_slide_image(self, pid, idx, png):
        self.blobs[f"{pid}/{idx}.png"] = png
        return f"https://acct.blob/{pid}/{idx}.png"

    def get_slide_image_url(self, pid, idx, expiry_minutes=60):
        return None

    def upload_pptx(self, pid, filename, data):
        self.blobs[f"{pid}/{filename}"] = data
        return f"https://acct.blob/{pid}/{filename}"


class FakeLibrary:
    available = True

    def __init__(self, prefix):
        self.prefix = prefix
        self.items: dict[str, dict] = {}

    def add(self, job_id, title, published=True, **extra):
        self.items[job_id] = {"job_id": job_id, "title": title, "published": published,
                              "thumbnail_url": "https://x/thumb?sig=SECRET", **extra}

    def list(self, published_only=False):
        return [dict(i) for i in self.items.values() if i["published"] or not published_only]

    def set_published(self, job_id, published):
        if job_id not in self.items:
            return None
        self.items[job_id]["published"] = published
        return dict(self.items[job_id])

    def set_title(self, job_id, title, *, document_title=None):
        if job_id not in self.items:
            return None
        self.items[job_id]["title"] = title
        if document_title:
            self.items[job_id]["document_title"] = document_title
        return dict(self.items[job_id])

    def delete(self, job_id):
        return self.items.pop(job_id, None) is not None


@pytest.fixture
def env(monkeypatch, tmp_path):
    from routers import decks as dr
    from routers import playlists as plr
    from routers import podcast as pr
    from routers import video as vr

    avatar_registry.reload(CUSTOM)
    monkeypatch.chdir(tmp_path)
    store = FakeStore()
    plib, vlib = FakeLibrary("podcast"), FakeLibrary("video")
    monkeypatch.setattr(dr, "_store", lambda cfg: store)
    monkeypatch.setattr(plr, "_store", lambda cfg: store)
    monkeypatch.setattr(pr, "_get_library", lambda cfg: plib)
    monkeypatch.setattr(vr, "_get_library", lambda cfg: vlib)

    uploads: list[tuple[str, str]] = []

    def fake_ingest(content, filename, language, cfg, *, title=None):
        assert content[:4] == b"PK\x03\x04"
        deck_id = str(uuid.uuid4())
        store.docs[deck_id] = {
            "id": deck_id, "source": "deck", "filename": filename, "title": title, "slide_count": 5,
            "language": language or "en-US", "published": False, "live_demo": False,
            "slides": [{"index": 0, "title": "t", "notes": "n"}],
        }
        uploads.append((filename, language))
        return dr.UploadResponse(deck_id=deck_id, title=title or filename.rsplit(".", 1)[0], slide_count=5,
                                 indexed_slides=5)

    translations: list[tuple[str, str]] = []

    async def fake_translate(deck_id, lang, cfg, *, charge=None):
        assert charge is None
        translations.append((deck_id, lang))
        return dr.TranslateDeckNotesResponse(deck_id=deck_id, target_language=lang,
                                             translated_notes={"0": "x"}, cached=False)

    monkeypatch.setattr(dr, "ingest_deck_bytes", fake_ingest)
    monkeypatch.setattr(dr, "translate_deck_notes_for", fake_translate)

    class Env:
        pass

    e = Env()
    e.store, e.plib, e.vlib, e.uploads, e.translations = store, plib, vlib, uploads, translations
    from config import load_config

    e.cfg = load_config()
    return e


def _deck_ids(store):
    return {d["filename"].rsplit(".", 1)[0]: d["id"] for d in store.list_decks()}


def test_seed_uploads_publishes_translates_and_is_idempotent(env):
    report = asyncio.run(mc.seed(env.cfg))
    assert [u[0] for u in env.uploads] == [s.file for s in mc.SEED_DECKS]
    assert dict(env.uploads)["ai-enablement-demo-beginner-fr.pptx"] == "fr-FR"
    assert dict(env.uploads)["ai-enablement-2-practitioner.pptx"] == "en-US"
    ids = _deck_ids(env.store)
    for spec in mc.SEED_DECKS:
        doc = env.store.docs[ids[spec.slug]]
        assert doc["published"] is True
        assert doc["live_demo"] is spec.live_demo
        assert doc["title"] == mc.DISPLAY_TITLES[spec.slug]
    assert {t for _, t in env.translations} == {"fr-FR", "en-US"}
    assert (ids["ai-enablement-demo-beginner-fr"], "en-US") in env.translations
    playlists = env.store.list_playlists()
    assert len(playlists) == 1 and playlists[0]["title"] == mc.PLAYLIST_TITLE
    steps = sorted(playlists[0]["steps"], key=lambda s: s["order"])
    assert [s["deck_title"] for s in steps] == [mc.DISPLAY_TITLES[t] for t in mc.PLAYLIST_STEPS]
    assert report["playlist"]["action"] == "created"

    # Second run: nothing new is uploaded or created.
    again = asyncio.run(mc.seed(env.cfg))
    assert len(env.uploads) == len(mc.SEED_DECKS)
    assert {d["action"] for d in again["decks"]} == {"exists"}
    assert again["playlist"]["action"] == "exists"
    assert len(env.store.list_playlists()) == 1


def test_seed_dry_run_writes_nothing(env):
    report = asyncio.run(mc.seed(env.cfg, dry_run=True))
    assert env.uploads == [] and env.translations == [] and env.store.docs == {}
    assert {d["action"] for d in report["decks"]} == {"would upload"}
    assert report["playlist"]["action"] == "would create"


def _fake_podcast_pipeline(monkeypatch, env, *, fail=False, turns=None):
    from routers import podcast as pr
    from services import podcast_ingest, podcast_script
    from services.podcast_models import Document, JobState

    seen: dict = {}

    def fake_ingest_file(path, lo):
        seen["ingested"] = seen.get("ingested", 0) + 1
        return Document(id=str(uuid.uuid4()), title="tmp", source_kind="pptx", slide_images=["a.png"],
                        slide_titles=["One", "Two", "Three"])

    async def fake_script(cfg, doc, req):
        seen["req"] = req
        if turns is not None:
            for t in turns:
                yield t.model_copy(deep=True)
            return
        for i in range(4):
            yield DialogueTurn(idx=i, speaker="interviewer" if i % 2 == 0 else "expert", text=f"line {i}",
                               slide_idx=0)

    async def fake_render(job_id, cfg):
        job = pr.JOBS[job_id]
        seen["job"] = job
        seen["script"] = pr.SCRIPTS[job.script_id]
        seen["turns"] = list(seen["script"].turns)
        seen["doc_title"] = pr.DOCUMENTS[pr.SCRIPTS[job.script_id].document_id].title
        if fail:
            job.state = JobState.failed
            return
        env.plib.add(job_id, seen["doc_title"], published=False)
        job.archive_state = "published"
        job.state = JobState.done

    monkeypatch.setattr(podcast_ingest, "ingest_file", fake_ingest_file)
    monkeypatch.setattr(podcast_script, "generate_script_stream", fake_script)
    monkeypatch.setattr(pr, "_render_job_body", fake_render)
    return seen


def test_render_podcast_uses_photo_avatars_and_spec(env, monkeypatch):
    seen = _fake_podcast_pipeline(monkeypatch, env)
    out = asyncio.run(mc.render_podcast(env.cfg, "expert"))
    job = seen["job"]
    assert job.roles.interviewer.display_name == "Sofia" and job.roles.interviewer.avatar == "photo_female"
    assert job.roles.expert.display_name == "Lucas" and job.roles.expert.avatar == "photo_male"
    assert job.roles.interviewer.voice.startswith("en-US-Ava") and job.roles.expert.voice.startswith("en-US-Andrew")
    assert job.layout == "split_screen_with_slides"
    req = seen["req"]
    assert (req.language, req.style, req.audience_level, req.length) == ("en-US", "debate", "expert", "medium")
    assert seen["doc_title"] == "Under the hood · Expert"
    assert out["action"] == "rendered" and env.plib.items[out["job_id"]]["published"] is True

    # Idempotent: an item with the same title is reused, not re-rendered.
    seen.clear()
    again = asyncio.run(mc.render_podcast(env.cfg, "expert"))
    assert again["action"] == "exists" and "job" not in seen


def test_render_podcast_french_voices(env, monkeypatch):
    seen = _fake_podcast_pipeline(monkeypatch, env)
    asyncio.run(mc.render_podcast(env.cfg, "demo-fr"))
    roles = seen["job"].roles
    assert roles.interviewer.voice.startswith("fr-FR-Vivienne") and roles.expert.voice.startswith("fr-FR-Remy")
    assert seen["req"].language == "fr-FR" and seen["req"].audience_level == "beginner"


def test_render_podcast_failure_does_not_publish(env, monkeypatch):
    _fake_podcast_pipeline(monkeypatch, env, fail=True)
    with pytest.raises(mc.MaintenanceError):
        asyncio.run(mc.render_podcast(env.cfg, "beginner"))
    assert env.plib.items == {}


def test_render_podcast_requires_photo_avatars(env, monkeypatch):
    avatar_registry.reload("")
    _fake_podcast_pipeline(monkeypatch, env)
    with pytest.raises(mc.MaintenanceError, match="photo_female"):
        asyncio.run(mc.render_podcast(env.cfg, "beginner"))


def _fake_video_pipeline(monkeypatch, env, *, slides=1, reverse=False, narrations=None):
    from routers import video as vr
    from services import video_ingest, video_script
    from services.video_models import JobState, SlideRef, VideoDocument

    seen: dict = {}

    def fake_ingest(path, original_name=None):
        seen["ingested"] = seen.get("ingested", 0) + 1
        doc_id = str(uuid.uuid4())
        return VideoDocument(doc_id=doc_id, title=original_name.rsplit(".", 1)[0], source_kind="pptx",
                             slides=[SlideRef(index=i, image_ref=f"{doc_id}/slide-{i}.png", title=f"Slide {i}")
                                     for i in range(slides)])

    async def fake_script(cfg, doc, req):
        seen["req"] = req
        if narrations is not None:
            for n in narrations(doc, req):
                yield n
            return
        for sl in (reversed(doc.slides) if reverse else doc.slides):
            yield SlideNarration(slide_index=sl.index, slide_image_ref=sl.image_ref, title=sl.title,
                                 narration=f"hello {sl.index}", voice=req.voice,
                                 speaking_style="calm" if sl.index == 0 else None,
                                 duration_hint_s=4.5 if sl.index == 0 else None)

    async def fake_render(job_id, cfg):
        job = vr.JOBS[job_id]
        seen["script"] = vr.SCRIPTS[job.doc_id]
        seen["doc"] = vr.DOCUMENTS[job.doc_id]
        env.vlib.add(job_id, vr.DOCUMENTS[job.doc_id].title, published=False)
        job.archive_state = "published"
        job.state = JobState.done

    monkeypatch.setattr(video_ingest, "ingest", fake_ingest)
    monkeypatch.setattr(video_script, "generate_script_stream", fake_script)
    monkeypatch.setattr(vr, "_render_job_body", fake_render)
    return seen


def test_render_video_french_male_presenter(env, monkeypatch):
    seen = _fake_video_pipeline(monkeypatch, env)
    out = asyncio.run(mc.render_video(env.cfg, "demo-fr"))
    script = seen["script"]
    assert script.voice.startswith("fr-FR-Remy") and script.language == "fr-FR"
    assert script.audience_level == "beginner"
    assert avatar_registry.for_voice(script.voice).id == "photo_male"
    assert out["title"] == "L’IA en trois minutes · Démo en direct"
    assert env.vlib.items[out["job_id"]]["title"] == out["title"]
    assert env.vlib.items[out["job_id"]]["published"] is True


def test_render_video_aborts_when_voice_maps_to_other_avatar(env, monkeypatch):
    _fake_video_pipeline(monkeypatch, env)
    monkeypatch.setitem(mc.VIDEOS, "demo-en", mc.VideoSpec(
        "ai-enablement-demo-beginner.pptx", "en-US", "photo_male", "female", "beginner"))
    with pytest.raises(mc.MaintenanceError, match="resolves to avatar"):
        asyncio.run(mc.render_video(env.cfg, "demo-en"))
    assert env.vlib.items == {}


def _seed_all_new(env):
    asyncio.run(mc.seed(env.cfg))
    for spec in mc.PODCASTS.values():
        env.plib.add(f"job-{uuid.uuid4().hex[:8]}", spec.title)
    for spec in mc.VIDEOS.values():
        env.vlib.add(f"sv-{uuid.uuid4().hex[:8]}", spec.title)


def _add_old(env):
    for title, deck_id in OLD_DECKS.items():
        env.store.docs[deck_id] = {"id": deck_id, "source": "deck", "filename": f"{title}.pptx",
                                   "slide_count": 3, "language": "en-US", "published": True, "live_demo": True}
    env.store.docs["pl_0123456789ab"] = {
        "id": "pl_0123456789ab", "source": "playlist", "title": "Sustainability path", "status": "active",
        "steps": [{"deck_id": OLD_DECKS["climate-action"], "order": 0, "deck_title": "climate-action"}]}
    env.plib.add("job-22d144ee", "circular-economy")
    env.vlib.add("sv-b89d3ed5", "circular-economy")


def _purge(env, tmp_path, **kw):
    args = dict(deck_titles=list(OLD_DECKS), podcast_ids=["job-22d144ee"], video_ids=["sv-b89d3ed5"],
                record=tmp_path / "deleted.json", allow_missing=set())
    args.update(kw)
    return mc.purge(env.cfg, **args)


def test_purge_refuses_until_new_content_is_published(env, tmp_path):
    _add_old(env)
    asyncio.run(mc.seed(env.cfg))
    with pytest.raises(mc.MaintenanceError, match="not ready"):
        _purge(env, tmp_path)
    assert OLD_DECKS["climate-action"] in env.store.docs and "job-22d144ee" in env.plib.items


def test_purge_dry_run_then_delete(env, tmp_path):
    _add_old(env)
    _seed_all_new(env)
    dry = _purge(env, tmp_path, dry_run=True)
    assert {d["title"] for d in dry["decks"]} == set(OLD_DECKS)
    assert [p["id"] for p in dry["playlists"]] == ["pl_0123456789ab"]
    assert OLD_DECKS["climate-action"] in env.store.docs

    result = _purge(env, tmp_path)
    assert result["errors"] == [] and result["not_found"] == []
    for deck_id in OLD_DECKS.values():
        assert deck_id not in env.store.docs
    assert "pl_0123456789ab" not in env.store.docs
    assert "job-22d144ee" not in env.plib.items and "sv-b89d3ed5" not in env.vlib.items
    titles = {d["filename"].rsplit(".", 1)[0] for d in env.store.list_decks()}
    assert titles == {s.slug for s in mc.SEED_DECKS}
    assert [p["title"] for p in env.store.list_playlists()] == [mc.PLAYLIST_TITLE]
    record = json.loads((tmp_path / "deleted.json").read_text(encoding="utf-8"))
    assert {d["deck_id"] for d in record["decks"]} == set(OLD_DECKS.values())
    assert "sig=" not in json.dumps(record)


def test_purge_protects_new_decks(env, tmp_path):
    _seed_all_new(env)
    with pytest.raises(mc.MaintenanceError, match="refusing"):
        _purge(env, tmp_path, deck_titles=["ai-enablement-1-beginner"])


def test_purge_allow_missing(env, tmp_path):
    _add_old(env)
    asyncio.run(mc.seed(env.cfg))
    for spec in mc.PODCASTS.values():
        env.plib.add(f"job-{uuid.uuid4().hex[:8]}", spec.title)
    for name, spec in mc.VIDEOS.items():
        if name != "practitioner":
            env.vlib.add(f"sv-{uuid.uuid4().hex[:8]}", spec.title)
    result = _purge(env, tmp_path, allow_missing={"video:practitioner"})
    assert result["errors"] == []


def test_inventory_has_no_signed_urls(env):
    _seed_all_new(env)
    inv = mc.inventory(env.cfg)
    assert "sig=" not in json.dumps(inv)
    assert len(inv["podcasts"]) == len(mc.PODCASTS) and len(inv["videos"]) == len(mc.VIDEOS)


def test_specs_match_requirements():
    assert {n: (s.style, s.audience_level, s.language) for n, s in mc.PODCASTS.items()} == {
        "beginner": ("explainer", "beginner", "en-US"),
        "practitioner": ("casual", "practitioner", "en-US"),
        "expert": ("debate", "expert", "en-US"),
        "demo-fr": ("casual", "beginner", "fr-FR"),
    }
    assert {n: (s.avatar, s.language) for n, s in mc.VIDEOS.items()} == {
        "demo-en": ("photo_female", "en-US"),
        "demo-fr": ("photo_male", "fr-FR"),
        "practitioner": ("photo_female", "en-US"),
    }
    from services.voice_catalog import is_allowed_voice
    assert all(is_allowed_voice(v) for by_gender in mc.VOICES.values() for v in by_gender.values())
    for spec in mc.SEED_DECKS:
        assert mc._deck_path(spec.file).is_file()


def test_cli_dry_run_seed(env, monkeypatch, capsys):
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    assert mc.main(["seed", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "would upload" in out and env.store.docs == {}


def test_publish_all_continues_past_a_failed_item(env, monkeypatch):
    calls: list[str] = []

    async def fake_podcast(cfg, name, *, dry_run=False, deck_dir=None):
        calls.append(f"podcast:{name}")
        if name == "practitioner":
            raise mc.MaintenanceError("boom")
        return {"name": name, "action": "rendered"}

    async def fake_video(cfg, name, *, dry_run=False, deck_dir=None):
        calls.append(f"video:{name}")
        return {"name": name, "action": "rendered"}

    monkeypatch.setattr(mc, "render_podcast", fake_podcast)
    monkeypatch.setattr(mc, "render_video", fake_video)
    summary = asyncio.run(mc.publish_all(env.cfg, skip={"video:practitioner"}))
    assert summary["seed"]["playlist"]["action"] == "created"
    assert calls == [f"podcast:{n}" for n in mc.PODCASTS] + ["video:demo-en", "video:demo-fr"]
    assert [e["item"] for e in summary["errors"]] == ["podcast:practitioner"]
    assert summary["videos"][-1] == {"name": "practitioner", "action": "skipped"}


def test_logtail_redacts_signed_urls(tmp_path):
    log = tmp_path / "x.log"
    log.write_text("ok line\nGET https://acct.blob.core.windows.net/c/v.mp4?sv=2024&sig=ABC123 failed\n"
                   "api key=SuperSecret1 here\n", encoding="utf-8")
    out = "\n".join(mc.logtail(log, 10))
    assert "ABC123" not in out and "SuperSecret1" not in out
    assert "https://acct.blob.core.windows.net/c/v.mp4?<redacted>" in out and "ok line" in out
    assert mc.logtail(tmp_path / "missing.log", 5)[0].startswith("(no log")


def test_background_flag_parses():
    args = mc.build_parser().parse_args(["--background", "/tmp/all.log", "all", "--skip", "video:practitioner"])
    assert str(args.background).replace("\\", "/").endswith("tmp/all.log")
    assert args.cmd == "all" and args.skip == ["video:practitioner"]


# ---------------------------------------------------------------------------
# Display titles / retitle
# ---------------------------------------------------------------------------
LEGACY_PODCASTS = {"job-4e563815": "ai-enablement-1-beginner", "job-a71481bd": "ai-enablement-2-practitioner",
                   "job-002473aa": "ai-enablement-3-expert", "job-2f1b33f2": "ai-enablement-demo-beginner-fr"}
LEGACY_VIDEOS = {"sv-87a87b7e": "ai-enablement-demo-beginner", "sv-72e901b9": "ai-enablement-demo-beginner-fr",
                 "sv-ba2ccb22": "ai-enablement-2-practitioner"}


class FakeSearch:
    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def set_deck_title(self, deck_id, title):
        self.calls.append((deck_id, title))
        return 3


def _legacy(env, monkeypatch):
    """Production state before retitle: slug titles everywhere."""
    from routers import decks as dr

    for spec in mc.SEED_DECKS:
        deck_id = str(uuid.uuid4())
        env.store.docs[deck_id] = {"id": deck_id, "source": "deck", "filename": spec.file, "slide_count": 5,
                                   "language": spec.language, "published": True, "live_demo": spec.live_demo}
    other = str(uuid.uuid4())
    env.store.docs[other] = {"id": other, "source": "deck", "filename": "team-onboarding.pptx",
                             "slide_count": 2, "language": "en-US", "published": True}
    ids = _deck_ids(env.store)
    env.store.docs["pl_0123456789ab"] = {
        "id": "pl_0123456789ab", "source": "playlist", "title": mc.PLAYLIST_TITLE, "status": "active",
        "steps": [{"deck_id": ids[t], "order": i, "deck_title": t} for i, t in enumerate(mc.PLAYLIST_STEPS)]}
    for job_id, slug in LEGACY_PODCASTS.items():
        env.plib.add(job_id, slug, document_title=slug)
    for job_id, slug in LEGACY_VIDEOS.items():
        env.vlib.add(job_id, slug, document_title=slug)
    env.plib.add("job-0000beef", "Hand-made episode", document_title="notes")
    search = FakeSearch()
    monkeypatch.setattr(dr, "get_deck_search", lambda cfg, client: search)
    monkeypatch.setattr(dr, "get_openai_client", lambda cfg: None)
    return ids, other, search


def _summary_titles(env):
    from routers import decks as dr
    return {dr._doc_to_summary(d).title for d in env.store.list_decks()}


def test_display_titles_cover_every_seeded_item():
    slugs = {s.slug for s in mc.SEED_DECKS}
    assert set(mc.DISPLAY_TITLES) == slugs
    for spec in (*mc.SEED_DECKS, *mc.PODCASTS.values(), *mc.VIDEOS.values()):
        assert spec.title == mc.DISPLAY_TITLES[spec.slug] and spec.titles == {spec.slug, spec.title}
    assert mc.DISPLAY_TITLES["ai-enablement-demo-beginner-fr"] == "L’IA en trois minutes · Démo en direct"


def test_retitle_dry_run_writes_nothing(env, monkeypatch):
    ids, other, search = _legacy(env, monkeypatch)
    before = json.dumps(env.store.docs, sort_keys=True)
    plib_before, vlib_before = json.dumps(env.plib.items), json.dumps(env.vlib.items)
    report = mc.retitle(env.cfg, dry_run=True)
    assert json.dumps(env.store.docs, sort_keys=True) == before
    assert json.dumps(env.plib.items) == plib_before and json.dumps(env.vlib.items) == vlib_before
    assert search.calls == []
    assert {d["action"] for d in report["decks"]} == {"would rename"}
    assert {(d["before"], d["after"]) for d in report["decks"]} == set(mc.DISPLAY_TITLES.items())
    assert other not in {d["deck_id"] for d in report["decks"]}
    assert report["playlists"][0]["action"] == "would update"
    assert {i["job_id"] for i in report["podcasts"]} == set(LEGACY_PODCASTS)
    assert {i["job_id"] for i in report["videos"]} == set(LEGACY_VIDEOS)
    assert report["errors"] == []


def test_retitle_applies_and_is_idempotent(env, monkeypatch):
    ids, other, search = _legacy(env, monkeypatch)
    report = mc.retitle(env.cfg)
    assert report["errors"] == []
    assert {d["action"] for d in report["decks"]} == {"renamed"}
    assert _summary_titles(env) == set(mc.DISPLAY_TITLES.values()) | {"team-onboarding"}
    for slug, deck_id in ids.items():
        if slug in mc.DISPLAY_TITLES:
            assert env.store.docs[deck_id]["filename"] == f"{slug}.pptx"
    assert "title" not in env.store.docs[other]
    assert sorted(search.calls) == sorted((ids[s], t) for s, t in mc.DISPLAY_TITLES.items())
    steps = env.store.docs["pl_0123456789ab"]["steps"]
    assert [s["deck_title"] for s in steps] == [mc.DISPLAY_TITLES[t] for t in mc.PLAYLIST_STEPS]
    for job_id, slug in LEGACY_PODCASTS.items():
        assert env.plib.items[job_id]["title"] == mc.DISPLAY_TITLES[slug]
        assert env.plib.items[job_id]["document_title"] == mc.DISPLAY_TITLES[slug]
    for job_id, slug in LEGACY_VIDEOS.items():
        assert env.vlib.items[job_id]["title"] == mc.DISPLAY_TITLES[slug]
    assert env.plib.items["job-0000beef"]["title"] == "Hand-made episode"

    snapshot = (json.dumps(env.store.docs, sort_keys=True), json.dumps(env.plib.items), json.dumps(env.vlib.items))
    again = mc.retitle(env.cfg)
    assert again["errors"] == [] and again["playlists"] == []
    assert {d["action"] for d in again["decks"] + again["podcasts"] + again["videos"]} == {"already"}
    assert (json.dumps(env.store.docs, sort_keys=True), json.dumps(env.plib.items),
            json.dumps(env.vlib.items)) == snapshot
    assert "sig=" not in json.dumps(report) + json.dumps(again)


def test_seed_and_renders_do_not_duplicate_retitled_content(env, monkeypatch):
    _legacy(env, monkeypatch)
    # Before retitle: slug-titled decks are recognised.
    report = asyncio.run(mc.seed(env.cfg))
    assert env.uploads == [] and {d["action"] for d in report["decks"]} == {"exists"}
    assert report["playlist"]["action"] == "exists"
    mc.retitle(env.cfg)
    # After retitle: display-titled decks are recognised too.
    report = asyncio.run(mc.seed(env.cfg))
    assert env.uploads == [] and {d["action"] for d in report["decks"]} == {"exists"}
    assert len(env.store.list_decks()) == len(mc.SEED_DECKS) + 1
    seen = _fake_podcast_pipeline(monkeypatch, env)
    assert asyncio.run(mc.render_podcast(env.cfg, "expert"))["action"] == "exists" and "job" not in seen
    assert asyncio.run(mc.render_video(env.cfg, "practitioner"))["action"] == "exists"
    assert mc.missing_new_content(mc.inventory(env.cfg), set()) == []


def test_missing_new_content_accepts_slug_titles(env, monkeypatch):
    _legacy(env, monkeypatch)
    assert mc.missing_new_content(mc.inventory(env.cfg), set()) == []


def test_cli_retitle_dry_run(env, monkeypatch, capsys):
    _legacy(env, monkeypatch)
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    assert mc.main(["retitle", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "would rename" in out and "sig=" not in out
    assert all("title" not in d for d in env.store.list_decks())


def test_deck_title_prefers_stored_title():
    from routers import decks as dr
    from services.storage import deck_title

    assert deck_title({"id": "x", "filename": "ai-enablement-3-expert.pptx"}) == "ai-enablement-3-expert"
    assert deck_title({"id": "x", "filename": "a.pptx", "title": "  Under the hood · Expert "}) == \
        "Under the hood · Expert"
    assert deck_title({"id": "x", "filename": "a.pptx", "title": ""}) == "a"
    doc = {"id": str(uuid.uuid4()), "filename": "a.pptx", "title": "Nice title"}
    assert dr._doc_to_summary(doc).title == "Nice title"


@pytest.mark.parametrize("kind", ["podcast", "video"])
def test_library_set_title_rewrites_manifest_without_urls(kind):
    from config import load_config
    from types import SimpleNamespace

    if kind == "podcast":
        from services.podcast_library import LIBRARY_PREFIX, PodcastLibrary as Lib
        job = "job-4e563815"
    else:
        from services.video_library import LIBRARY_PREFIX, VideoLibrary as Lib
        job = "sv-87a87b7e"
    lib = Lib(load_config())
    name = f"{LIBRARY_PREFIX}/{job}/manifest.json"
    store = {name: json.dumps({"job_id": job, "title": "ai-enablement-1-beginner",
                               "document_title": "ai-enablement-1-beginner", "published": True,
                               "video_blob": f"{LIBRARY_PREFIX}/{job}/v.mp4"})}
    lib._initialised = True
    lib._blob = SimpleNamespace()
    lib._upload = lambda n, data, content_type: store.__setitem__(n, data)  # type: ignore[assignment]
    lib._read_json_blob = lambda n: json.loads(store[n]) if n in store else None  # type: ignore[assignment]
    lib._sas = lambda blob, minutes=24 * 60: f"https://x/{blob}?sig=SECRET" if blob else None  # type: ignore

    item = lib.set_title(job, "AI, demystified · Beginner")
    assert item["title"] == "AI, demystified · Beginner"
    saved = json.loads(store[name])
    assert saved["title"] == "AI, demystified · Beginner"
    assert saved["document_title"] == "ai-enablement-1-beginner" and saved["published"] is True
    assert not any(k.endswith("_url") for k in saved) and b"sig=" not in store[name]

    lib.set_title(job, "AI, demystified · Beginner", document_title="AI, demystified · Beginner")
    assert json.loads(store[name])["document_title"] == "AI, demystified · Beginner"
    assert lib.set_title(job, "   ") is None
    assert lib.set_title("job-deadbeef" if kind == "podcast" else "sv-deadbeef", "x") is None


def test_deck_search_set_deck_title_merges_only_the_title():
    from types import SimpleNamespace
    from services.deck_search import DeckSearchService

    calls: dict = {}

    class Client:
        def search(self, **kw):
            calls["search"] = kw
            return [{"id": "d-0"}, {"id": "d-1"}]

        def merge_documents(self, docs):
            calls["merge"] = docs
            return [SimpleNamespace(succeeded=True) for _ in docs]

    svc = object.__new__(DeckSearchService)
    svc._search_client = Client()
    assert svc.set_deck_title("d", "Under the hood · Expert") == 2
    assert calls["search"]["filter"] == "deck_id eq 'd'"
    assert calls["merge"] == [{"id": "d-0", "deck_title": "Under the hood · Expert"},
                              {"id": "d-1", "deck_title": "Under the hood · Expert"}]


# ---------------------------------------------------------------------------
# Media re-render (--force) + media-only purge
# ---------------------------------------------------------------------------
def test_render_podcast_force_renders_a_replacement(env, monkeypatch):
    seen = _fake_podcast_pipeline(monkeypatch, env)
    first = asyncio.run(mc.render_podcast(env.cfg, "beginner"))
    seen.clear()
    assert asyncio.run(mc.render_podcast(env.cfg, "beginner", dry_run=True, force=True))["action"] == "would render"
    again = asyncio.run(mc.render_podcast(env.cfg, "beginner", force=True))
    assert again["action"] == "rendered" and again["replaces"] == first["job_id"] and "job" in seen
    assert again["job_id"] != first["job_id"] and len(env.plib.items) == 2


def test_render_video_force_renders_a_replacement(env, monkeypatch):
    _fake_video_pipeline(monkeypatch, env)
    first = asyncio.run(mc.render_video(env.cfg, "demo-en"))
    again = asyncio.run(mc.render_video(env.cfg, "demo-en", force=True))
    assert again["action"] == "rendered" and again["replaces"] == first["job_id"]
    assert {i["title"] for i in env.vlib.items.values()} == {mc.VIDEOS["demo-en"].title}


def _playlists_snapshot(env):
    return json.dumps(sorted(env.store.list_playlists(), key=lambda p: p["id"]), sort_keys=True)


def test_purge_media_only_retires_superseded_items_and_keeps_playlists(env, tmp_path):
    _seed_all_new(env)
    env.store.docs["pl_broken000001"] = {"id": "pl_broken000001", "source": "playlist", "title": "Old path",
                                         "status": "broken", "steps": []}
    env.plib.add("job-0dd00001", mc.PODCASTS["beginner"].title)  # superseded by the seeded re-render
    env.vlib.add("sv-0dd00001", mc.VIDEOS["demo-fr"].title)
    before = _playlists_snapshot(env)
    deck_count = len(env.store.list_decks())
    result = _purge(env, tmp_path, deck_titles=[], podcast_ids=["job-0dd00001"], video_ids=["sv-0dd00001"])
    assert result["errors"] == [] and result["playlists"] == [] and result["decks"] == []
    assert "job-0dd00001" not in env.plib.items and "sv-0dd00001" not in env.vlib.items
    assert len(env.plib.items) == len(mc.PODCASTS) and len(env.vlib.items) == len(mc.VIDEOS)
    assert _playlists_snapshot(env) == before and len(env.store.list_decks()) == deck_count


def test_purge_refuses_the_last_published_copy_of_a_new_item(env, tmp_path):
    _seed_all_new(env)
    only = next(j for j, i in env.plib.items.items() if i["title"] == mc.PODCASTS["expert"].title)
    with pytest.raises(mc.MaintenanceError, match="refusing to delete new item"):
        _purge(env, tmp_path, deck_titles=[], podcast_ids=[only], video_ids=[])
    assert only in env.plib.items


# ---------------------------------------------------------------------------
# rebrand-decks (in place, same deck ids)
# ---------------------------------------------------------------------------
LEGACY_BRAND = "Legacy Brand"


class FakeIndex:
    def __init__(self):
        self.calls: list[list] = []

    def index_deck(self, slides):
        self.calls.append(list(slides))
        return len(slides)


def _rebrand_env(env, monkeypatch, tmp_path, images=None):
    from routers import decks as dr
    from services import pptx_parser as pp

    asyncio.run(mc.seed(env.cfg))
    ids = _deck_ids(env.store)
    for spec in mc.SEED_DECKS:
        text = mc._slide_text(mc._deck_path(spec.file).read_bytes())
        doc = env.store.docs[ids[spec.slug]]
        doc["slide_count"] = len(text)
        doc["slides"] = [{"index": i, "title": t["title"], "body": t["body"].replace("Oz Radio", LEGACY_BRAND),
                          "notes": t["notes"], "image_url": f"https://acct.blob/{doc['id']}/{i}.png?sig=OLD",
                          "translated_notes": {"fr-FR": f"traduction {i}"}} for i, t in enumerate(text)]
    renders: list[str] = []

    def fake_parse(content, filename, libreoffice_path="soffice"):
        renders.append(filename)
        text = mc._slide_text(content)
        imgs = images(len(text)) if images else [(i, f"PNG {filename} {i}".encode()) for i in range(len(text))]
        return pp.PresentationData(id=str(uuid.uuid4()), filename=filename, slide_count=len(text),
                                   slides=[pp.SlideData(index=i, **t) for i, t in enumerate(text)],
                                   slide_images=imgs, pptx_bytes=content)

    monkeypatch.setattr(pp, "parse_pptx", fake_parse)
    monkeypatch.setattr(dr, "SLIDES_DIR", tmp_path / "slides")
    index = FakeIndex()
    monkeypatch.setattr(mc, "_deck_search", lambda cfg: index)

    def no_delete(*a, **k):
        raise AssertionError("rebrand-decks must never delete")

    for name in ("delete_presentation", "delete_slide_images", "delete_playlist"):
        monkeypatch.setattr(env.store, name, no_delete)
    return ids, renders, index


def test_rebrand_decks_overwrites_images_and_text_in_place(env, monkeypatch, tmp_path):
    ids, renders, index = _rebrand_env(env, monkeypatch, tmp_path)
    before = json.loads(json.dumps(env.store.docs))
    playlists = _playlists_snapshot(env)
    report = mc.rebrand_decks(env.cfg)
    assert report["errors"] == [] and {d["action"] for d in report["decks"]} == {"rebranded"}
    assert _deck_ids(env.store) == ids and _playlists_snapshot(env) == playlists
    total = 0
    for spec in mc.SEED_DECKS:
        deck_id = ids[spec.slug]
        old, new = before[deck_id], env.store.docs[deck_id]
        for key in ("id", "title", "filename", "language", "published", "live_demo", "slide_count"):
            assert new[key] == old[key], key
        assert new["published"] is True and new["live_demo"] is spec.live_demo
        assert [s["notes"] for s in new["slides"]] == [s["notes"] for s in old["slides"]]
        assert [s["translated_notes"] for s in new["slides"]] == [s["translated_notes"] for s in old["slides"]]
        assert all(LEGACY_BRAND not in s["body"] and "Oz Radio" in s["body"] for s in new["slides"])
        assert new["images_version"] == 1 and len(new["source_sha256"]) == 64
        assert [s["image_url"] for s in new["slides"]] == [
            f"/api/slides/{deck_id}/{i}.png?v=1" for i in range(new["slide_count"])]
        for i in range(new["slide_count"]):
            png = env.store.blobs[f"{deck_id}/{i}.png"]
            assert png == f"PNG {spec.file} {i}".encode()
            assert (tmp_path / "slides" / deck_id / f"{i}.png").read_bytes() == png
        total += new["slide_count"]
    assert len(env.store.blobs) == total and sorted(renders) == sorted(s.file for s in mc.SEED_DECKS)
    indexed = {c[0].deck_id: c for c in index.calls}
    assert set(indexed) == set(ids.values())
    beginner = indexed[ids["ai-enablement-1-beginner"]]
    assert beginner[0].deck_title == mc.DISPLAY_TITLES["ai-enablement-1-beginner"]
    assert all("Oz Radio" in s.body for s in beginner)
    assert "sig=" not in json.dumps(report)

    # Idempotent: nothing is re-rendered or rewritten on a second run.
    snapshot = json.dumps(env.store.docs, sort_keys=True)
    again = mc.rebrand_decks(env.cfg)
    assert again["errors"] == [] and {d["action"] for d in again["decks"]} == {"already"}
    assert len(renders) == len(mc.SEED_DECKS) and json.dumps(env.store.docs, sort_keys=True) == snapshot


def test_rebrand_decks_dry_run_writes_nothing(env, monkeypatch, tmp_path):
    _, renders, index = _rebrand_env(env, monkeypatch, tmp_path)
    before = json.dumps(env.store.docs, sort_keys=True)
    report = mc.rebrand_decks(env.cfg, dry_run=True)
    assert report["errors"] == [] and {d["action"] for d in report["decks"]} == {"would rebrand"}
    assert all(d["text_changes"] > 0 for d in report["decks"])
    assert renders == [] and env.store.blobs == {} and index.calls == []
    assert json.dumps(env.store.docs, sort_keys=True) == before


def test_rebrand_decks_aborts_a_deck_whose_notes_or_slide_count_differ(env, monkeypatch, tmp_path):
    ids, renders, _ = _rebrand_env(env, monkeypatch, tmp_path)
    notes_id, count_id = ids["ai-enablement-2-practitioner"], ids["ai-enablement-demo-beginner-fr"]
    env.store.docs[notes_id]["slides"][3]["notes"] += " (edited)"
    env.store.docs[count_id]["slides"].pop()
    env.store.docs[count_id]["slide_count"] -= 1
    before = {i: json.dumps(env.store.docs[i], sort_keys=True) for i in (notes_id, count_id)}
    report = mc.rebrand_decks(env.cfg)
    actions = {d["deck_id"]: d for d in report["decks"]}
    assert actions[notes_id]["action"] == "aborted" and "slides [4]" in actions[notes_id]["error"]
    assert actions[count_id]["action"] == "aborted" and "slide count" in actions[count_id]["error"]
    assert len(report["errors"]) == 2
    assert sum(d["action"] == "rebranded" for d in report["decks"]) == len(mc.SEED_DECKS) - 2
    for i in (notes_id, count_id):
        assert json.dumps(env.store.docs[i], sort_keys=True) == before[i]
        assert not any(k.startswith(f"{i}/") for k in env.store.blobs)


def test_rebrand_decks_refuses_placeholder_renders(env, monkeypatch, tmp_path):
    from services.pptx_parser import _fallback_placeholders

    _rebrand_env(env, monkeypatch, tmp_path, images=_fallback_placeholders)
    report = mc.rebrand_decks(env.cfg, only={"ai-enablement-demo-beginner"})
    assert [d["action"] for d in report["decks"]] == ["aborted"]
    assert "placeholders" in report["decks"][0]["error"] and env.store.blobs == {}


def test_rebrand_decks_reports_missing_decks(env, monkeypatch, tmp_path):
    report = mc.rebrand_decks(env.cfg, dry_run=True)
    assert len(report["errors"]) == len(mc.SEED_DECKS)
    assert {d["error"] for d in report["decks"]} == {"deck not found (run seed first)"}


def test_cli_rebrand_decks_dry_run_single_deck(env, monkeypatch, tmp_path, capsys):
    _rebrand_env(env, monkeypatch, tmp_path)
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    assert mc.main(["rebrand-decks", "--deck", "ai-enablement-1-beginner", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "would rebrand" in out and out.count('"deck_id"') == 1 and env.store.blobs == {}


# ---------------------------------------------------------------------------
# Podcast formats (video | audio), listener warm-up, publish/unpublish
# ---------------------------------------------------------------------------
def test_render_podcast_defaults_to_video_with_reactions_and_reports_warnings(env, monkeypatch):
    from routers import podcast as pr

    seen = _fake_podcast_pipeline(monkeypatch, env)
    inner = pr._render_job_body

    async def render_with_warnings(job_id, cfg):
        await inner(job_id, cfg)
        pr.JOBS[job_id].warnings = ["listener_static"]
        pr.JOBS[job_id].listener_mode = "idle_loop"

    monkeypatch.setattr(pr, "_render_job_body", render_with_warnings)
    out = asyncio.run(mc.render_podcast(env.cfg, "practitioner"))
    job = seen["job"]
    assert job.format == "video" and job.reactions is True
    assert out["format"] == "video" and out["action"] == "rendered"
    assert out["warnings"] == ["listener_static"] and out["listener_mode"] == "idle_loop"


def test_render_podcast_audio_format(env, monkeypatch):
    seen = _fake_podcast_pipeline(monkeypatch, env)
    out = asyncio.run(mc.render_podcast(env.cfg, "demo-fr", fmt="audio"))
    job = seen["job"]
    assert job.format == "audio" and job.reactions is True
    # The cast keeps its avatars: they become the radio cover/player portraits.
    assert job.roles.interviewer.avatar == "photo_female" and job.roles.expert.avatar == "photo_male"
    assert job.roles.interviewer.voice.startswith("fr-FR-Vivienne")
    assert out["format"] == "audio" and env.plib.items[out["job_id"]]["published"] is True


def test_render_podcast_spec_format_is_the_default(env, monkeypatch):
    seen = _fake_podcast_pipeline(monkeypatch, env)
    spec = mc.PODCASTS["beginner"]
    monkeypatch.setitem(mc.PODCASTS, "beginner", mc.PodcastSpec(
        spec.deck, spec.language, spec.style, spec.audience_level, format="audio"))
    assert asyncio.run(mc.render_podcast(env.cfg, "beginner"))["format"] == "audio"
    assert seen["job"].format == "audio"
    assert asyncio.run(mc.render_podcast(env.cfg, "beginner", fmt="video", force=True))["format"] == "video"
    assert seen["job"].format == "video"


def test_render_podcast_existing_item_matches_title_and_format(env, monkeypatch):
    seen = _fake_podcast_pipeline(monkeypatch, env)
    title = mc.PODCASTS["expert"].title
    env.plib.add("job-0000000a", title)  # manifest v1 summary: no "format" key = video
    assert asyncio.run(mc.render_podcast(env.cfg, "expert", dry_run=True))["action"] == "exists"
    plan = asyncio.run(mc.render_podcast(env.cfg, "expert", dry_run=True, fmt="audio"))
    assert plan["action"] == "would render" and "job" not in seen
    env.plib.add("job-0000000b", title, format="audio")
    again = asyncio.run(mc.render_podcast(env.cfg, "expert", dry_run=True, fmt="audio"))
    assert again["action"] == "exists" and again["job_id"] == "job-0000000b"


def test_render_podcast_rejects_unknown_format(env, monkeypatch):
    _fake_podcast_pipeline(monkeypatch, env)
    with pytest.raises(mc.MaintenanceError, match="format"):
        asyncio.run(mc.render_podcast(env.cfg, "beginner", fmt="radio"))
    assert env.plib.items == {}


def test_cli_render_podcast_format_flag():
    parse = mc.build_parser().parse_args
    assert parse(["render-podcast", "all"]).fmt is None
    assert parse(["render-podcast", "beginner", "--format", "audio", "--force"]).fmt == "audio"
    with pytest.raises(SystemExit):
        parse(["render-podcast", "beginner", "--format", "radio"])


def test_specs_default_to_video():
    assert {s.format for s in mc.PODCASTS.values()} == {"video"}
    assert mc.PODCAST_FORMATS == ("video", "audio")


def _fake_kit(avatar_id, voice, *, fallback=False):
    from pathlib import Path

    from services.podcast_media import IdleLoop, ListenerKit, ReactionClip

    if fallback:
        return ListenerKit(avatar_id=avatar_id, voice=voice, mode="procedural", idle=None, reactions={},
                           warnings=("listener_fallback", "reactions_skipped"))
    kit_dir = Path("data/podcast/listener_kit/0123456789abcdef01234567")
    idle = IdleLoop(path=kit_dir / "aaaaaaaaaaaaaaaaaaaa.webm", duration_sec=6.123, has_alpha=True,
                    signature_path=kit_dir / "bbbbbbbbbbbbbbbbbbbb.npz", motion_score=0.41234, static=False)
    clip = ReactionClip(reaction_id="ack", text="Mm-hmm.", audio_path=kit_dir / "c.wav",
                        video_path=kit_dir / "d.webm", duration_sec=0.53, has_alpha=True)
    return ListenerKit(avatar_id=avatar_id, voice=voice, mode="idle_loop", idle=idle,
                       reactions={"ack": clip, "right": clip}, warnings=())


def _fake_listener(monkeypatch, *, fallback_for=()):
    from services import podcast_listener

    calls: list[dict] = []

    def fake_ensure(cfg, avatar_id, voice, language, *, want_reactions, deadline=None):
        calls.append({"avatar_id": avatar_id, "voice": voice, "language": language,
                      "want_reactions": want_reactions, "deadline": deadline})
        return _fake_kit(avatar_id, voice, fallback=(avatar_id, language) in fallback_for)

    monkeypatch.setattr(podcast_listener, "ensure_listener_kit", fake_ensure)
    return calls


def test_warm_listeners_ensures_each_cast_kit(env, monkeypatch):
    import time

    calls = _fake_listener(monkeypatch)
    before = time.monotonic()
    report = mc.warm_listeners(env.cfg)
    assert [(c["avatar_id"], c["voice"], c["language"]) for c in calls] == [
        ("photo_female", mc.VOICES["en-US"]["female"], "en-US"),
        ("photo_male", mc.VOICES["en-US"]["male"], "en-US"),
        ("photo_female", mc.VOICES["fr-FR"]["female"], "fr-FR"),
        ("photo_male", mc.VOICES["fr-FR"]["male"], "fr-FR"),
    ]
    assert all(c["want_reactions"] is True for c in calls)
    # Default budget per kit = PODCAST_LISTENER_TIMEOUT_SEC (60 s in the offline test env).
    assert report["timeout_sec"] == 60 and all(before + 59 < c["deadline"] < time.monotonic() + 61 for c in calls)
    assert report["errors"] == [] and report["listener_mode"] == "still"
    kit = report["kits"][0]
    assert kit["ok"] is True and kit["mode"] == "idle_loop" and kit["reactions"] == ["ack", "right"]
    assert kit["idle"] == {"duration_sec": 6.12, "motion_score": 0.412, "static": False}
    text = json.dumps(report)
    # Registry ids and voices only: no Speech character names, no cache paths.
    assert "F_char" not in text and "M_char" not in text and "listener_kit" not in text


def test_warm_listeners_reports_fallback_kits(env, monkeypatch, capsys):
    _fake_listener(monkeypatch, fallback_for={("photo_male", "fr-FR")})
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    assert mc.main(["warm-listeners", "--language", "fr-FR", "--timeout", "120"]) == 1
    out = capsys.readouterr().out
    report = json.loads(out[out.index("{"):out.rindex("}") + 1])
    assert [k["ok"] for k in report["kits"]] == [True, False]
    assert report["timeout_sec"] == 120
    assert report["errors"] == [{"item": "listener kit photo_male (fr-FR)",
                                 "error": "listener_fallback, reactions_skipped"}]
    assert "F_char" not in out and "M_char" not in out


def test_warm_listeners_dry_run_builds_nothing(env, monkeypatch):
    from services import podcast_listener

    def boom(*a, **k):
        raise AssertionError("dry run must not build kits")

    monkeypatch.setattr(podcast_listener, "ensure_listener_kit", boom)
    report = mc.warm_listeners(env.cfg, languages=["en-US"], dry_run=True)
    assert [(k["avatar_id"], k["language"], k["action"]) for k in report["kits"]] == [
        ("photo_female", "en-US", "would warm"), ("photo_male", "en-US", "would warm")]


def test_warm_listeners_requires_the_registered_cast(env, monkeypatch):
    calls = _fake_listener(monkeypatch)
    avatar_registry.reload("")
    with pytest.raises(mc.MaintenanceError, match="photo_female"):
        mc.warm_listeners(env.cfg)
    with pytest.raises(mc.MaintenanceError, match="positive"):
        mc.warm_listeners(env.cfg, timeout_sec=0)
    assert calls == []


def _two_copies(env):
    """A superseded item and its re-render, both published under the same title."""
    title = mc.PODCASTS["beginner"].title
    env.plib.add("job-0000aaa1", title, format="video")
    env.plib.add("job-0000bbb2", title, format="video")
    return title


def test_publish_off_hides_superseded_items_and_warns_on_the_last_copy(env):
    _two_copies(env)
    report = mc.publish_podcasts(env.cfg, ["job-0000aaa1"], published=False)
    assert report["errors"] == []
    assert report["podcasts"] == [{"job_id": "job-0000aaa1", "title": mc.PODCASTS["beginner"].title,
                                   "format": "video", "action": "unpublished", "published": False}]
    assert env.plib.items["job-0000aaa1"]["published"] is False
    assert "job-0000aaa1" in env.plib.items  # hidden, never deleted

    last = mc.publish_podcasts(env.cfg, ["job-0000bbb2"], published=False)
    assert last["podcasts"][0]["warning"] == "no published item left with this title"
    again = mc.publish_podcasts(env.cfg, ["job-0000bbb2"], published=False)
    assert again["podcasts"][0]["action"] == "already"


def test_publish_on_warns_about_duplicate_titles(env):
    _two_copies(env)
    env.plib.items["job-0000aaa1"]["published"] = False
    report = mc.publish_podcasts(env.cfg, ["job-0000aaa1"])
    entry = report["podcasts"][0]
    assert entry["action"] == "published" and entry["published"] is True
    assert entry["warning"] == "also published with this title: ['job-0000bbb2']"


def test_publish_dry_run_and_invalid_ids(env):
    _two_copies(env)
    before = json.dumps(env.plib.items, sort_keys=True)
    report = mc.publish_podcasts(env.cfg, ["job-0000aaa1", "job-0000bbb2"], published=False, dry_run=True)
    assert [e["action"] for e in report["podcasts"]] == ["would unpublish", "would unpublish"]
    assert report["podcasts"][1]["warning"] == "no published item left with this title"
    assert json.dumps(env.plib.items, sort_keys=True) == before
    with pytest.raises(mc.MaintenanceError, match="invalid podcast ids"):
        mc.publish_podcasts(env.cfg, ["sv-0000aaa1"])


def test_cli_publish_off_and_not_found(env, monkeypatch, capsys):
    _two_copies(env)
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    assert mc.main(["publish", "--podcast-id", "job-0000aaa1", "--off"]) == 0
    out = capsys.readouterr().out
    assert '"unpublished"' in out and "sig=" not in out and "_url" not in out
    assert env.plib.items["job-0000aaa1"]["published"] is False
    assert mc.main(["publish", "--podcast-id", "job-deadbeef"]) == 1
    assert '"not found"' in capsys.readouterr().out
    assert mc.main(["publish", "--podcast-id", "nope"]) == 2
    with pytest.raises(SystemExit):
        mc.build_parser().parse_args(["publish"])


# ---------------------------------------------------------------------------
# Staged re-render: --unpublished, publish/unpublish by id, plan-switch / switch / rollback
# ---------------------------------------------------------------------------
OLDER, NEWER = "2026-09-01T10:00:00+00:00", "2026-10-19T08:00:00+00:00"
RENDERED_LINE = re.compile(r"^RENDERED (podcast|video) (\S+) ((?:job|sv)-[0-9a-f]{8})$", re.MULTILINE)


def _spy(lib, calls, *, fail=(), lose=(), after=None):
    """Record ``(job_id, published)`` for every set_published call on ``lib``.

    Ids in ``fail`` are not written (the library answers None); ids in ``lose`` are written but the
    library still answers None (a storage error after the write); ``after`` runs after each write."""
    real = lib.set_published

    def set_published(job_id, published):
        calls.append((job_id, published))
        if job_id in fail:
            return None
        item = real(job_id, published)
        if after:
            after()
        return None if job_id in lose else item

    lib.set_published = set_published


def _never_delete(env, monkeypatch):
    def boom(job_id):
        raise AssertionError("the staged switch must never delete")

    monkeypatch.setattr(env.plib, "delete", boom)
    monkeypatch.setattr(env.vlib, "delete", boom)


def _visible(env):
    """(kind, title) of every published item: a title leaving this set is a gap for visitors."""
    return ({("podcast", i["title"]) for i in env.plib.items.values() if i["published"]}
            | {("video", i["title"]) for i in env.vlib.items.values() if i["published"]})


def _lib_of(env, kind):
    return env.plib if kind == "podcast" else env.vlib


def _flags(env, pairs):
    """(old published, new published) of each ``(kind, old, new)`` pair."""
    return [(_lib_of(env, k).items[o]["published"], _lib_of(env, k).items[n]["published"]) for k, o, n in pairs]


def _rerenders(env):
    """Two podcasts and a video, each published with a newer private re-render waiting beside it."""
    pairs = []
    for old, new, name in (("job-0000aa01", "job-0000bb01", "beginner"), ("job-0000aa02", "job-0000bb02", "expert")):
        spec = mc.PODCASTS[name]
        env.plib.add(old, spec.title, published=True, format="video", language=spec.language, created_at=OLDER)
        env.plib.add(new, spec.title, published=False, format="video", language=spec.language, created_at=NEWER)
        pairs.append(("podcast", old, new))
    spec = mc.VIDEOS["demo-en"]
    env.vlib.add("sv-0000aa03", spec.title, published=True, language=spec.language, created_at=OLDER)
    env.vlib.add("sv-0000bb03", spec.title, published=False, language=spec.language, created_at=NEWER)
    pairs.append(("video", "sv-0000aa03", "sv-0000bb03"))
    return pairs


def _manifest(tmp_path, pairs, name="switch.json"):
    """A hand-written manifest: only kind, old_id and new_id."""
    path = tmp_path / name
    path.write_text(json.dumps({"pairs": [{"kind": k, "old_id": o, "new_id": n} for k, o, n in pairs]}),
                    encoding="utf-8")
    return path


def _planned(env, tmp_path):
    """The re-render scenario and the manifest ``plan-switch`` writes for it."""
    pairs = _rerenders(env)
    path = tmp_path / "switch.json"
    assert mc.plan_switch(env.cfg, out=path)["errors"] == []
    return pairs, path


def _printed_json(out):
    return json.loads(out[out.index("{"):out.rindex("}") + 1])


# --- render --unpublished ---------------------------------------------------
def test_render_podcast_unpublished_never_publishes(env, monkeypatch, capsys):
    seen = _fake_podcast_pipeline(monkeypatch, env)
    calls: list = []
    _spy(env.plib, calls)
    out = asyncio.run(mc.render_podcast(env.cfg, "beginner", unpublished=True))
    stdout = capsys.readouterr().out
    assert out["action"] == "rendered" and out["published"] is False and "job" in seen
    assert env.plib.items[out["job_id"]]["published"] is False and calls == []
    assert RENDERED_LINE.findall(stdout) == [("podcast", "beginner", out["job_id"])]
    assert "://" not in stdout and "sig=" not in stdout


def test_render_video_unpublished_never_publishes(env, monkeypatch, capsys):
    seen = _fake_video_pipeline(monkeypatch, env)
    calls: list = []
    _spy(env.vlib, calls)
    out = asyncio.run(mc.render_video(env.cfg, "demo-fr", unpublished=True))
    stdout = capsys.readouterr().out
    assert out["action"] == "rendered" and out["published"] is False and "script" in seen
    assert env.vlib.items[out["job_id"]]["published"] is False and calls == []
    assert RENDERED_LINE.findall(stdout) == [("video", "demo-fr", out["job_id"])]
    assert "://" not in stdout and "sig=" not in stdout


def test_render_unpublished_reports_but_never_publishes_an_existing_item(env, monkeypatch, capsys):
    seen = _fake_podcast_pipeline(monkeypatch, env)
    env.plib.add("job-0000aa01", mc.PODCASTS["beginner"].title, published=False)
    calls: list = []
    _spy(env.plib, calls)
    out = asyncio.run(mc.render_podcast(env.cfg, "beginner", unpublished=True))
    assert out["action"] == "exists" and out["job_id"] == "job-0000aa01" and out["published"] is False
    assert "job" not in seen and calls == [] and env.plib.items["job-0000aa01"]["published"] is False
    out_text = capsys.readouterr().out
    assert "RENDERED" not in out_text and "add --force to render a new private item" in out_text
    # Without the flag the same private item is published, exactly as before.
    plain = asyncio.run(mc.render_podcast(env.cfg, "beginner"))
    assert plain["action"] == "exists" and plain["published"] is True and calls == [("job-0000aa01", True)]
    assert "--force" not in capsys.readouterr().out

    _fake_video_pipeline(monkeypatch, env)
    env.vlib.add("sv-0000aa01", mc.VIDEOS["demo-en"].title, published=False)
    vcalls: list = []
    _spy(env.vlib, vcalls)
    assert asyncio.run(mc.render_video(env.cfg, "demo-en", unpublished=True))["action"] == "exists"
    assert vcalls == [] and env.vlib.items["sv-0000aa01"]["published"] is False
    assert asyncio.run(mc.render_video(env.cfg, "demo-en"))["published"] is True and vcalls == [("sv-0000aa01", True)]


def test_render_podcast_unpublished_force_adds_a_private_item_beside_the_published_one(env, monkeypatch, capsys):
    _fake_podcast_pipeline(monkeypatch, env)
    first = asyncio.run(mc.render_podcast(env.cfg, "beginner"))
    capsys.readouterr()
    fresh = asyncio.run(mc.render_podcast(env.cfg, "beginner", force=True, unpublished=True))
    assert fresh["action"] == "rendered" and fresh["replaces"] == first["job_id"] and fresh["published"] is False
    assert fresh["job_id"] != first["job_id"] and len(env.plib.items) == 2
    assert env.plib.items[first["job_id"]]["published"] is True
    assert env.plib.items[fresh["job_id"]]["published"] is False
    assert RENDERED_LINE.findall(capsys.readouterr().out) == [("podcast", "beginner", fresh["job_id"])]


def test_render_video_unpublished_force_adds_a_private_item_beside_the_published_one(env, monkeypatch, capsys):
    _fake_video_pipeline(monkeypatch, env)
    first = asyncio.run(mc.render_video(env.cfg, "demo-en"))
    capsys.readouterr()
    fresh = asyncio.run(mc.render_video(env.cfg, "demo-en", force=True, unpublished=True))
    assert fresh["action"] == "rendered" and fresh["replaces"] == first["job_id"] and fresh["published"] is False
    assert fresh["job_id"] != first["job_id"] and len(env.vlib.items) == 2
    assert env.vlib.items[first["job_id"]]["published"] is True
    assert env.vlib.items[fresh["job_id"]]["published"] is False
    assert RENDERED_LINE.findall(capsys.readouterr().out) == [("video", "demo-en", fresh["job_id"])]


def test_render_without_unpublished_still_publishes_and_prints_no_rendered_line(env, monkeypatch, capsys):
    _fake_podcast_pipeline(monkeypatch, env)
    _fake_video_pipeline(monkeypatch, env)
    podcast = asyncio.run(mc.render_podcast(env.cfg, "beginner"))
    video = asyncio.run(mc.render_video(env.cfg, "demo-en"))
    assert podcast["published"] is True and env.plib.items[podcast["job_id"]]["published"] is True
    assert video["published"] is True and env.vlib.items[video["job_id"]]["published"] is True
    assert "RENDERED" not in capsys.readouterr().out


def test_render_unpublished_dry_run_and_failed_render_leave_no_trace(env, monkeypatch, capsys):
    _fake_podcast_pipeline(monkeypatch, env)
    published = asyncio.run(mc.render_podcast(env.cfg, "beginner"))
    capsys.readouterr()
    before = json.dumps(env.plib.items, sort_keys=True)
    plan = asyncio.run(mc.render_podcast(env.cfg, "beginner", force=True, unpublished=True, dry_run=True))
    assert plan["action"] == "would render" and plan["replaces"] == published["job_id"]
    assert json.dumps(env.plib.items, sort_keys=True) == before and "RENDERED" not in capsys.readouterr().out

    _fake_podcast_pipeline(monkeypatch, env, fail=True)
    with pytest.raises(mc.MaintenanceError):
        asyncio.run(mc.render_podcast(env.cfg, "expert", unpublished=True))
    assert json.dumps(env.plib.items, sort_keys=True) == before and "RENDERED" not in capsys.readouterr().out


def test_cli_render_unpublished_prints_one_machine_readable_line_per_item(env, monkeypatch, capsys):
    _fake_podcast_pipeline(monkeypatch, env)
    _fake_video_pipeline(monkeypatch, env)
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    assert mc.main(["render-podcast", "all", "--force", "--unpublished"]) == 0
    assert mc.main(["render-video", "all", "--force", "--unpublished"]) == 0
    out = capsys.readouterr().out
    rendered = RENDERED_LINE.findall(out)
    assert [(k, n) for k, n, _ in rendered] == [("podcast", n) for n in mc.PODCASTS] + \
        [("video", n) for n in mc.VIDEOS]
    assert {j for _, _, j in rendered} == set(env.plib.items) | set(env.vlib.items)
    assert not any(i["published"] for i in (*env.plib.items.values(), *env.vlib.items.values()))
    assert "://" not in out and "sig=" not in out


def test_cli_render_unpublished_flag_parses():
    parse = mc.build_parser().parse_args
    assert parse(["render-podcast", "beginner"]).unpublished is False
    assert parse(["render-podcast", "all", "--force", "--unpublished"]).unpublished is True
    assert parse(["render-video", "all"]).unpublished is False
    assert parse(["render-video", "all", "--unpublished"]).unpublished is True


# --- publish / unpublish podcasts and videos by id --------------------------
def test_publish_items_hides_and_shows_videos_by_id(env):
    title = mc.VIDEOS["demo-en"].title
    env.vlib.add("sv-0000aaa1", title)
    env.vlib.add("sv-0000bbb2", title)
    report = mc.publish_items(env.cfg, video_ids=["sv-0000aaa1"], published=False)
    assert report["errors"] == [] and report["podcasts"] == []
    assert report["videos"] == [{"job_id": "sv-0000aaa1", "title": title, "action": "unpublished",
                                 "published": False}]
    assert env.vlib.items["sv-0000aaa1"]["published"] is False  # hidden, never deleted
    last = mc.publish_items(env.cfg, video_ids=["sv-0000bbb2"], published=False)
    assert last["videos"][0]["warning"] == "no published item left with this title"
    assert mc.publish_items(env.cfg, video_ids=["sv-0000bbb2"], published=False)["videos"][0]["action"] == "already"
    back = mc.publish_items(env.cfg, video_ids=["sv-0000aaa1", "sv-0000bbb2"])
    assert [e["action"] for e in back["videos"]] == ["published", "published"]
    assert back["videos"][0]["warning"] == "also published with this title: ['sv-0000bbb2']"


def test_publish_items_reports_missing_ids_and_dry_runs_without_writing(env):
    title = mc.VIDEOS["demo-en"].title
    env.vlib.add("sv-0000aaa1", title)
    env.vlib.add("sv-0000bbb2", title)
    before = json.dumps(env.vlib.items, sort_keys=True)
    calls: list = []
    _spy(env.vlib, calls)
    dry = mc.publish_items(env.cfg, video_ids=["sv-0000aaa1", "sv-0000deaf"], published=False, dry_run=True)
    assert dry["videos"][0]["action"] == "would unpublish" and dry["videos"][1] == {
        "job_id": "sv-0000deaf", "action": "not found"}
    assert dry["errors"] == [{"item": "video sv-0000deaf", "error": "not found"}]
    assert calls == [] and json.dumps(env.vlib.items, sort_keys=True) == before


def test_publish_items_mixes_kinds_and_validates_before_writing(env):
    _two_copies(env)
    env.vlib.add("sv-0000aaa1", mc.VIDEOS["demo-en"].title)
    calls: list = []
    _spy(env.plib, calls)
    _spy(env.vlib, calls)
    report = mc.publish_items(env.cfg, podcast_ids=["job-0000aaa1"], video_ids=["sv-0000aaa1"], published=False)
    assert report["errors"] == [] and calls == [("job-0000aaa1", False), ("sv-0000aaa1", False)]
    assert report["podcasts"][0]["format"] == "video" and "format" not in report["videos"][0]

    calls.clear()
    with pytest.raises(mc.MaintenanceError, match="invalid video ids"):
        mc.publish_items(env.cfg, podcast_ids=["job-0000bbb2"], video_ids=["job-0000bbb2"], published=False)
    with pytest.raises(mc.MaintenanceError, match="invalid podcast ids"):
        mc.publish_items(env.cfg, podcast_ids=["sv-0000aaa1"])
    with pytest.raises(mc.MaintenanceError, match="at least one"):
        mc.publish_items(env.cfg)
    env.vlib.available = False
    with pytest.raises(mc.MaintenanceError, match="video library storage unavailable"):
        mc.publish_items(env.cfg, podcast_ids=["job-0000bbb2"], video_ids=["sv-0000aaa1"], published=False)
    assert calls == []  # whatever is wrong with the request, nothing is written


@pytest.mark.parametrize("bad", ["sv-0000aaa", "sv-0000aaa1\n", "SV-0000AAA1", "sv-0000aaa1/..", "job-0000aaa1", ""])
def test_publish_items_validates_video_ids_with_the_router_regex(env, bad):
    env.vlib.add("sv-0000aaa1", "T")
    with pytest.raises(mc.MaintenanceError, match="invalid video ids"):
        mc.publish_items(env.cfg, video_ids=[bad], published=False)
    assert env.vlib.items["sv-0000aaa1"]["published"] is True


def test_cli_unpublish_alias_and_video_flag(env, monkeypatch, capsys):
    _two_copies(env)
    env.vlib.add("sv-0000aaa1", mc.VIDEOS["demo-en"].title)
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    assert mc.main(["unpublish", "--podcast-id", "job-0000aaa1", "--video-id", "sv-0000aaa1", "--dry-run"]) == 0
    assert capsys.readouterr().out.count('"would unpublish"') == 2
    assert env.plib.items["job-0000aaa1"]["published"] and env.vlib.items["sv-0000aaa1"]["published"]
    assert mc.main(["unpublish", "--podcast-id", "job-0000aaa1", "--video-id", "sv-0000aaa1"]) == 0
    out = capsys.readouterr().out
    assert out.count('"unpublished"') == 2 and "sig=" not in out and "_url" not in out
    assert not env.plib.items["job-0000aaa1"]["published"] and not env.vlib.items["sv-0000aaa1"]["published"]
    assert mc.main(["publish", "--video-id", "sv-0000aaa1"]) == 0
    assert env.vlib.items["sv-0000aaa1"]["published"] is True
    assert mc.main(["publish", "--off", "--video-id", "sv-0000aaa1"]) == 0
    assert env.vlib.items["sv-0000aaa1"]["published"] is False
    capsys.readouterr()
    assert mc.main(["publish", "--video-id", "sv-0000dead"]) == 1
    assert '"not found"' in capsys.readouterr().out
    assert mc.main(["unpublish", "--video-id", "nope"]) == 2
    assert "invalid video ids" in capsys.readouterr().out
    assert "job-0000bbb2" in env.plib.items and "job-0000aaa1" in env.plib.items  # nothing was deleted


def test_publish_commands_need_an_id_of_either_kind():
    parse = mc.build_parser().parse_args
    assert parse(["publish", "--video-id", "sv-0000aaa1"]).video_id == ["sv-0000aaa1"]
    args = parse(["unpublish", "--podcast-id", "job-0000aaa1"])
    assert args.off is True and args.podcast_id == ["job-0000aaa1"] and args.video_id == []
    for argv in (["publish"], ["publish", "--off"], ["unpublish"], ["unpublish", "--dry-run"]):
        with pytest.raises(SystemExit):
            parse(argv)


# --- plan-switch ------------------------------------------------------------
def test_plan_switch_pairs_published_items_with_their_newer_private_rerender(env, tmp_path):
    pairs = _rerenders(env)
    beginner, practitioner = mc.PODCASTS["beginner"].title, mc.PODCASTS["practitioner"].title
    # Items that must not become a pair:
    env.plib.add("job-0000cc01", beginner, published=False, format="video", language="en-US",
                 created_at="2026-01-01T00:00:00+00:00")  # older leftover kept for rollback
    env.plib.add("job-0000cc02", practitioner, published=True, format="video", language="en-US",
                 created_at=OLDER)  # nothing re-rendered yet
    env.plib.add("job-0000cc03", beginner, published=False, format="audio", language="en-US",
                 created_at=NEWER)  # another rendition, not a re-render of the video item
    env.plib.add("job-0000cc04", "Hand-made draft", published=False, created_at=NEWER)  # nothing to replace
    calls: list = []
    _spy(env.plib, calls)
    _spy(env.vlib, calls)
    out = tmp_path / "plans" / "switch.json"
    report = mc.plan_switch(env.cfg, out=out)
    assert report["errors"] == [] and report["written"] is True and report["manifest"] == str(out)
    assert [(p["kind"], p["old_id"], p["new_id"]) for p in report["pairs"]] == pairs
    assert report["unmatched"] == [{"kind": "podcast", "job_id": "job-0000cc02", "title": practitioner,
                                    "reason": "no newer unpublished re-render"}]
    text = out.read_text(encoding="utf-8")
    manifest = json.loads(text)
    assert manifest["version"] == mc.MANIFEST_VERSION and manifest["pairs"] == report["pairs"]
    assert manifest["pairs"][0] == {"kind": "podcast", "old_id": "job-0000aa01", "new_id": "job-0000bb01",
                                    "title": beginner, "format": "video", "language": "en-US",
                                    "old_created_at": OLDER, "new_created_at": NEWER}
    assert "format" not in manifest["pairs"][2]  # videos have no format
    assert calls == [] and "sig=" not in text and "thumbnail" not in text  # planning writes no flags, no URLs


def test_plan_switch_matches_slug_titled_and_v1_items(env, tmp_path):
    title = mc.PODCASTS["beginner"].title
    # Seeded before ``retitle`` (filename slug) and archived by manifest v1 (no format = video).
    env.plib.add("job-0000aa01", "ai-enablement-1-beginner", published=True, language="en-US", created_at=OLDER)
    env.plib.add("job-0000bb01", title, published=False, format="video", language="en-US", created_at=NEWER)
    path = tmp_path / "switch.json"
    report = mc.plan_switch(env.cfg, out=path)
    assert [(p["old_id"], p["new_id"]) for p in report["pairs"]] == [("job-0000aa01", "job-0000bb01")]
    assert mc.switch(env.cfg, path)["errors"] == []
    assert env.plib.items["job-0000bb01"]["published"] and not env.plib.items["job-0000aa01"]["published"]


def test_plan_switch_refuses_ambiguous_matches(env, tmp_path, monkeypatch, capsys):
    pairs = _rerenders(env)
    beginner, expert = mc.PODCASTS["beginner"].title, mc.PODCASTS["expert"].title
    other = "2026-10-19T09:00:00+00:00"
    # Two newer private re-renders of one item: which one to promote is not ours to guess.
    env.plib.add("job-0000dd01", beginner, published=False, format="video", language="en-US", created_at=other)
    # Two published copies: which one is the "old" one?
    env.plib.add("job-0000dd02", expert, published=True, format="video", language="en-US", created_at=OLDER)
    out = tmp_path / "switch.json"
    report = mc.plan_switch(env.cfg, out=out)
    assert [(p["kind"], p["old_id"], p["new_id"]) for p in report["pairs"]] == pairs[2:]  # only the video
    errors = {e["item"]: e for e in report["errors"]}
    assert set(errors) == {f"podcast {beginner}", f"podcast {expert}"}
    assert errors[f"podcast {beginner}"]["published"] == ["job-0000aa01"]
    assert errors[f"podcast {beginner}"]["candidates"] == [{"job_id": "job-0000bb01", "created_at": NEWER},
                                                          {"job_id": "job-0000dd01", "created_at": other}]
    assert errors[f"podcast {expert}"]["published"] == ["job-0000aa02", "job-0000dd02"]
    assert "candidates" not in errors[f"podcast {expert}"]
    assert json.loads(out.read_text(encoding="utf-8"))["pairs"] == report["pairs"]  # only what is decidable

    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    assert mc.main(["plan-switch", "--out", str(tmp_path / "second.json")]) == 1  # the plan is incomplete
    text = capsys.readouterr().out
    assert "several newer unpublished re-renders" in text and "several published items" in text


def test_plan_switch_writes_nothing_when_nothing_is_decidable(env, tmp_path):
    title = mc.PODCASTS["beginner"].title
    env.plib.add("job-0000aa01", title, published=True, format="video", language="en-US", created_at=OLDER)
    out = tmp_path / "switch.json"
    nothing = mc.plan_switch(env.cfg, out=out)
    assert nothing["pairs"] == [] and nothing["written"] is False and not out.exists()
    assert nothing["errors"] == [{"item": "plan",
                                  "error": "no published item has a newer unpublished re-render"}]
    for new in ("job-0000bb01", "job-0000bb02"):
        env.plib.add(new, title, published=False, format="video", language="en-US", created_at=NEWER)
    ambiguous = mc.plan_switch(env.cfg, out=out)
    assert ambiguous["pairs"] == [] and ambiguous["written"] is False and not out.exists()
    assert len(ambiguous["errors"]) == 1 and "candidates" in ambiguous["errors"][0]


def test_plan_switch_never_overwrites_a_manifest_and_dry_run_writes_nothing(env, tmp_path):
    _rerenders(env)
    out = tmp_path / "switch.json"
    dry = mc.plan_switch(env.cfg, out=out, dry_run=True)
    assert dry["written"] is False and len(dry["pairs"]) == 3 and not out.exists()
    mc.plan_switch(env.cfg, out=out)
    before = out.read_bytes()
    for dry_run in (False, True):
        with pytest.raises(mc.MaintenanceError, match="refusing to overwrite"):
            mc.plan_switch(env.cfg, out=out, dry_run=dry_run)
    assert out.read_bytes() == before


# --- switch -----------------------------------------------------------------
def test_switch_publishes_each_new_item_before_hiding_the_old_one(env, monkeypatch, tmp_path):
    pairs, path = _planned(env, tmp_path)
    _never_delete(env, monkeypatch)
    calls: list = []
    visible: list = []
    initial = _visible(env)
    for lib in (env.plib, env.vlib):
        _spy(lib, calls, after=lambda: visible.append(_visible(env)))
    report = mc.switch(env.cfg, path)
    assert report["errors"] == [] and report["command"] == "switch" and report["dry_run"] is False
    assert calls == [c for _, old, new in pairs for c in ((new, True), (old, False))]
    assert len(visible) == 6 and all(v >= initial for v in visible)  # no title ever loses its last published item
    assert _flags(env, pairs) == [(False, True)] * 3
    assert [p["status"] for p in report["pairs"]] == ["switched"] * 3
    assert [(p["old_published"], p["new_published"]) for p in report["pairs"]] == [(False, True)] * 3
    assert [s["step"] for s in report["pairs"][0]["steps"]] == ["publish_new", "unpublish_old"]

    text = path.read_text(encoding="utf-8")
    saved = json.loads(text)
    assert saved["version"] == mc.MANIFEST_VERSION and saved["pairs"][0]["title"] == mc.PODCASTS["beginner"].title
    for pair, (_, old, new) in zip(saved["pairs"], pairs):
        assert pair["status"] == "switched"
        assert [(e["command"], e["step"], e["id"], e["outcome"]) for e in pair["log"]] == [
            ("switch", "publish_new", new, "published"), ("switch", "unpublish_old", old, "unpublished")]
        stamps = [datetime.fromisoformat(e["at"]) for e in pair["log"]]
        assert stamps == sorted(stamps)
    assert "sig=" not in text + json.dumps(report) and "://" not in text + json.dumps(report)
    assert not list(tmp_path.glob("*.tmp"))


def test_switch_is_idempotent_and_can_run_again_after_a_rollback(env, tmp_path):
    pairs, path = _planned(env, tmp_path)
    calls: list = []
    _spy(env.plib, calls)
    _spy(env.vlib, calls)
    mc.switch(env.cfg, path)
    calls.clear()
    again = mc.switch(env.cfg, path)
    assert again["errors"] == [] and calls == []
    assert {s["outcome"] for p in again["pairs"] for s in p["steps"]} == {"already"}
    assert [p["status"] for p in again["pairs"]] == ["switched"] * 3
    saved = json.loads(path.read_text(encoding="utf-8"))["pairs"]
    assert all(len(p["log"]) == 4 and [e["outcome"] for e in p["log"][2:]] == ["already", "already"] for p in saved)

    mc.rollback(env.cfg, path)
    assert _flags(env, pairs) == [(True, False)] * 3
    assert mc.switch(env.cfg, path)["errors"] == [] and _flags(env, pairs) == [(False, True)] * 3


def test_switch_dry_run_writes_nothing(env, tmp_path):
    pairs, path = _planned(env, tmp_path)
    calls: list = []
    _spy(env.plib, calls)
    _spy(env.vlib, calls)
    before = path.read_bytes()
    libs = (json.dumps(env.plib.items, sort_keys=True), json.dumps(env.vlib.items, sort_keys=True))
    plan = mc.switch(env.cfg, path, dry_run=True)
    assert plan["dry_run"] is True and plan["errors"] == []
    assert [[s["outcome"] for s in p["steps"]] for p in plan["pairs"]] == [["would publish", "would unpublish"]] * 3
    assert [p["status"] for p in plan["pairs"]] == ["would change"] * 3
    assert all("old_published" not in p and "new_published" not in p for p in plan["pairs"])  # nothing is live yet
    assert calls == [] and path.read_bytes() == before
    assert (json.dumps(env.plib.items, sort_keys=True), json.dumps(env.vlib.items, sort_keys=True)) == libs
    # Nothing to undo before the switch; after it, the dry runs flip.
    assert {p["status"] for p in mc.rollback(env.cfg, path, dry_run=True)["pairs"]} == {"nothing to do"}
    mc.switch(env.cfg, path)
    done = path.read_bytes()
    assert {p["status"] for p in mc.switch(env.cfg, path, dry_run=True)["pairs"]} == {"nothing to do"}
    assert {p["status"] for p in mc.rollback(env.cfg, path, dry_run=True)["pairs"]} == {"would change"}
    assert path.read_bytes() == done and _flags(env, pairs) == [(False, True)] * 3


def test_switch_stops_at_the_first_failure_and_records_it(env, tmp_path, monkeypatch, capsys):
    pairs, path = _planned(env, tmp_path)
    fail = {pairs[1][2]}  # the second pair's new item cannot be published
    calls: list = []
    _spy(env.plib, calls, fail=fail)
    _spy(env.vlib, calls, fail=fail)
    report = mc.switch(env.cfg, path)
    assert report["errors"] == [{"item": f"podcast {pairs[1][1]} -> {pairs[1][2]}", "error": "publish_new failed"}]
    assert [p["status"] for p in report["pairs"]] == ["switched", "switch_failed", "not attempted"]
    assert calls == [(pairs[0][2], True), (pairs[0][1], False), (pairs[1][2], True)]  # the third pair is untouched
    assert _flags(env, pairs) == [(False, True), (True, False), (True, False)]  # the failed pair stays as it was
    assert [(p["old_published"], p["new_published"]) for p in report["pairs"]] == _flags(env, pairs)
    saved = json.loads(path.read_text(encoding="utf-8"))["pairs"]
    assert [p.get("status") for p in saved] == ["switched", "switch_failed", None]
    assert saved[1]["log"][-1]["outcome"] == "failed" and "log" not in saved[2]

    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    assert mc.main(["switch", "--manifest", str(path)]) == 1  # still failing
    assert _printed_json(capsys.readouterr().out)["errors"][0]["error"] == "publish_new failed"

    fail.clear()
    calls.clear()
    again = mc.switch(env.cfg, path)
    assert again["errors"] == [] and _flags(env, pairs) == [(False, True)] * 3
    assert [[s["outcome"] for s in p["steps"]] for p in again["pairs"]] == [
        ["already", "already"], ["published", "unpublished"], ["published", "unpublished"]]
    assert calls == [(pairs[1][2], True), (pairs[1][1], False), (pairs[2][2], True), (pairs[2][1], False)]


def test_a_failed_unpublish_leaves_both_items_visible_never_neither(env, tmp_path):
    pairs, path = _planned(env, tmp_path)
    fail = {pairs[0][1]}  # the first pair's old item cannot be hidden
    calls: list = []
    _spy(env.plib, calls, fail=fail)
    report = mc.switch(env.cfg, path)
    first = report["pairs"][0]
    assert [p["status"] for p in report["pairs"]] == ["switch_failed", "not attempted", "not attempted"]
    assert [s["outcome"] for s in first["steps"]] == ["published", "failed"]
    assert (first["old_published"], first["new_published"]) == (True, True)  # a duplicate card, but no gap
    assert report["errors"][0]["error"] == "unpublish_old failed"
    assert _flags(env, pairs) == [(True, True), (True, False), (True, False)]
    fail.clear()
    assert mc.switch(env.cfg, path)["errors"] == [] and _flags(env, pairs) == [(False, True)] * 3


def test_a_failed_step_reports_the_flag_that_is_really_live(env, tmp_path):
    pairs, path = _planned(env, tmp_path)
    _spy(env.plib, [], lose={pairs[0][2]})  # the write lands, the library still answers None
    first = mc.switch(env.cfg, path)["pairs"][0]
    assert first["status"] == "switch_failed"
    assert first["steps"] == [{"step": "publish_new", "id": pairs[0][2], "outcome": "failed"}]
    assert (first["old_published"], first["new_published"]) == (True, True)  # re-read from storage
    retry = mc.switch(env.cfg, path)
    assert retry["errors"] == [] and retry["pairs"][0]["steps"][0]["outcome"] == "already"
    assert _flags(env, pairs) == [(False, True)] * 3


def test_a_failed_step_is_recorded_even_when_the_library_cannot_be_re_read(env, tmp_path):
    pairs, path = _planned(env, tmp_path)
    _spy(env.plib, [], fail={pairs[0][2]})
    real_list, reads = env.plib.list, []

    def flaky_list(published_only=False):
        reads.append(1)
        if len(reads) > 1:  # the manifest check reads fine; the re-read after the failure breaks
            raise RuntimeError("storage down")
        return real_list(published_only=published_only)

    env.plib.list = flaky_list
    report = mc.switch(env.cfg, path)
    first = report["pairs"][0]
    assert first["status"] == "switch_failed" and report["errors"][0]["error"] == "publish_new failed"
    assert (first["old_published"], first["new_published"]) == (None, None)  # unknown, not guessed
    saved = json.loads(path.read_text(encoding="utf-8"))["pairs"][0]
    assert saved["status"] == "switch_failed" and saved["log"][-1]["outcome"] == "failed"


def test_a_raising_library_is_recorded_as_a_failed_step(env, tmp_path):
    pairs, path = _planned(env, tmp_path)

    def boom(job_id, published):
        raise RuntimeError("storage down")

    env.plib.set_published = boom
    report = mc.switch(env.cfg, path)
    assert report["pairs"][0]["status"] == "switch_failed" and report["errors"]
    assert json.loads(path.read_text(encoding="utf-8"))["pairs"][0]["log"][-1]["outcome"] == "failed"
    assert _flags(env, pairs) == [(True, False)] * 3


BAD_MANIFESTS = {
    "unknown kind": ([{"kind": "audio", "old_id": "job-0000aa01", "new_id": "job-0000bb01"}], "kind must be"),
    "video id in a podcast pair": ([{"kind": "podcast", "old_id": "sv-0000aa03", "new_id": "job-0000bb01"}],
                                   "not a valid podcast id"),
    "uppercase id": ([{"kind": "podcast", "old_id": "JOB-0000AA01", "new_id": "job-0000bb01"}],
                     "not a valid podcast id"),
    "id with a newline": ([{"kind": "podcast", "old_id": "job-0000aa01\n", "new_id": "job-0000bb01"}],
                          "not a valid podcast id"),
    "missing new_id": ([{"kind": "podcast", "old_id": "job-0000aa01"}], "new_id"),
    "old and new are the same": ([{"kind": "podcast", "old_id": "job-0000aa01", "new_id": "job-0000aa01"}],
                                 "more than once"),
    "id reused by another pair": ([{"kind": "podcast", "old_id": "job-0000aa01", "new_id": "job-0000bb01"},
                                   {"kind": "podcast", "old_id": "job-0000aa02", "new_id": "job-0000bb01"}],
                                  "more than once"),
    "unknown item": ([{"kind": "podcast", "old_id": "job-0000aa01", "new_id": "job-0000ee05"}], "not found"),
    "other title": ([{"kind": "podcast", "old_id": "job-0000aa01", "new_id": "job-0000bb02"}],
                    "differ in title"),
    "other format": ([{"kind": "podcast", "old_id": "job-0000aa01", "new_id": "job-0000ff01"}],
                     "differ in title, format or language"),
    "other language": ([{"kind": "podcast", "old_id": "job-0000aa01", "new_id": "job-0000ff02"}],
                       "differ in title, format or language"),
    "log is not a list": ([{"kind": "podcast", "old_id": "job-0000aa01", "new_id": "job-0000bb01", "log": "x"}],
                          "log must be a list"),
}


@pytest.mark.parametrize("name", list(BAD_MANIFESTS))
def test_switch_and_rollback_refuse_an_invalid_manifest_before_changing_anything(env, tmp_path, name):
    _rerenders(env)
    title = mc.PODCASTS["beginner"].title
    env.plib.add("job-0000ff01", title, published=False, format="audio", language="en-US", created_at=NEWER)
    env.plib.add("job-0000ff02", title, published=False, format="video", language="fr-FR", created_at=NEWER)
    pairs, match = BAD_MANIFESTS[name]
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"pairs": pairs}), encoding="utf-8")
    calls: list = []
    _spy(env.plib, calls)
    _spy(env.vlib, calls)
    before = path.read_bytes()
    for run in (mc.switch, mc.rollback):
        for dry_run in (False, True):
            with pytest.raises(mc.MaintenanceError, match=match):
                run(env.cfg, path, dry_run=dry_run)
    assert calls == [] and path.read_bytes() == before


def test_switch_rejects_unreadable_manifests(env, tmp_path, monkeypatch, capsys):
    path = tmp_path / "m.json"
    with pytest.raises(mc.MaintenanceError, match="cannot read manifest"):
        mc.switch(env.cfg, path)
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(mc.MaintenanceError, match="not valid JSON"):
        mc.switch(env.cfg, path)
    for text in ("[]", '{"pairs": []}', '{"pairs": "x"}'):
        path.write_text(text, encoding="utf-8")
        with pytest.raises(mc.MaintenanceError, match="at least one pair"):
            mc.rollback(env.cfg, path)
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    assert mc.main(["switch", "--manifest", str(path)]) == 2
    assert "ERROR: manifest must be" in capsys.readouterr().out


def test_switch_refuses_to_start_when_the_record_cannot_be_written(env, monkeypatch, tmp_path):
    pairs, path = _planned(env, tmp_path)
    calls: list = []
    _spy(env.plib, calls)
    _spy(env.vlib, calls)

    def deny(src, dst):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(mc.os, "replace", deny)
    with pytest.raises(mc.MaintenanceError, match="cannot write manifest"):
        mc.switch(env.cfg, path)
    assert calls == [] and _flags(env, pairs) == [(True, False)] * 3 and not list(tmp_path.glob("*.tmp"))


def test_switch_reads_a_hand_written_manifest_saved_with_a_utf8_bom(env, tmp_path):
    pairs = _rerenders(env)
    body = json.dumps({"pairs": [{"kind": k, "old_id": o, "new_id": n} for k, o, n in pairs]})
    path = tmp_path / "bom.json"
    path.write_bytes(b"\xef\xbb\xbf" + body.encode("utf-8"))
    assert mc.switch(env.cfg, path)["errors"] == []
    assert _flags(env, pairs) == [(False, True)] * 3
    assert json.loads(path.read_text(encoding="utf-8"))["pairs"][0]["status"] == "switched"


def test_switch_only_needs_the_libraries_its_pairs_use(env, tmp_path):
    pairs = _rerenders(env)
    env.plib.available = False
    assert mc.switch(env.cfg, _manifest(tmp_path, pairs[2:], "video.json"))["errors"] == []
    with pytest.raises(mc.MaintenanceError, match="podcast library storage unavailable"):
        mc.switch(env.cfg, _manifest(tmp_path, pairs[:1], "podcast.json"))
    assert env.plib.items[pairs[0][1]]["published"] is True


# --- rollback ---------------------------------------------------------------
def test_rollback_publishes_the_old_item_before_hiding_the_new_one(env, monkeypatch, tmp_path):
    pairs, path = _planned(env, tmp_path)
    mc.switch(env.cfg, path)
    _never_delete(env, monkeypatch)
    live = _visible(env)
    calls: list = []
    visible: list = []
    for lib in (env.plib, env.vlib):
        _spy(lib, calls, after=lambda: visible.append(_visible(env)))
    report = mc.rollback(env.cfg, path)
    assert report["errors"] == [] and [p["status"] for p in report["pairs"]] == ["rolled_back"] * 3
    assert calls == [c for _, old, new in pairs for c in ((old, True), (new, False))]
    assert len(visible) == 6 and all(v >= live for v in visible)
    assert _flags(env, pairs) == [(True, False)] * 3
    for pair, (_, old, new) in zip(json.loads(path.read_text(encoding="utf-8"))["pairs"], pairs):
        assert pair["status"] == "rolled_back"
        assert [(e["command"], e["step"], e["id"], e["outcome"]) for e in pair["log"]] == [
            ("switch", "publish_new", new, "published"), ("switch", "unpublish_old", old, "unpublished"),
            ("rollback", "publish_old", old, "published"), ("rollback", "unpublish_new", new, "unpublished")]


def test_rollback_is_idempotent_and_needs_no_record(env, tmp_path):
    pairs = _rerenders(env)
    path = _manifest(tmp_path, pairs)  # hand-written, never switched
    calls: list = []
    _spy(env.plib, calls)
    _spy(env.vlib, calls)
    report = mc.rollback(env.cfg, path)
    assert report["errors"] == [] and calls == []
    assert {s["outcome"] for p in report["pairs"] for s in p["steps"]} == {"already"}

    mc.switch(env.cfg, path)
    lost = _manifest(tmp_path, pairs, "rebuilt-from-the-plan.json")  # the switch record was lost
    calls.clear()
    assert mc.rollback(env.cfg, lost)["errors"] == [] and _flags(env, pairs) == [(True, False)] * 3
    assert calls == [c for _, old, new in pairs for c in ((old, True), (new, False))]
    calls.clear()
    again = mc.rollback(env.cfg, lost)
    assert calls == [] and {s["outcome"] for p in again["pairs"] for s in p["steps"]} == {"already"}


def test_rollback_stops_at_the_first_failure(env, tmp_path):
    pairs, path = _planned(env, tmp_path)
    mc.switch(env.cfg, path)
    fail = {pairs[1][1]}  # the second pair's old item cannot be published again
    calls: list = []
    _spy(env.plib, calls, fail=fail)
    _spy(env.vlib, calls, fail=fail)
    report = mc.rollback(env.cfg, path)
    assert [p["status"] for p in report["pairs"]] == ["rolled_back", "rollback_failed", "not attempted"]
    assert report["errors"][0]["error"] == "publish_old failed"
    assert calls == [(pairs[0][1], True), (pairs[0][2], False), (pairs[1][1], True)]
    assert _flags(env, pairs) == [(True, False), (False, True), (False, True)]  # the new item stays live: no gap
    saved = json.loads(path.read_text(encoding="utf-8"))["pairs"]
    assert [p["status"] for p in saved] == ["rolled_back", "rollback_failed", "switched"]
    fail.clear()
    assert mc.rollback(env.cfg, path)["errors"] == [] and _flags(env, pairs) == [(True, False)] * 3


# --- CLI --------------------------------------------------------------------
def test_cli_plan_switch_then_switch_then_rollback(env, monkeypatch, tmp_path, capsys):
    pairs = _rerenders(env)
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    path = tmp_path / "switch.json"
    assert mc.main(["plan-switch", "--out", str(path), "--dry-run"]) == 0 and not path.exists()
    assert mc.main(["plan-switch", "--out", str(path)]) == 0 and path.is_file()
    assert mc.main(["plan-switch", "--out", str(path)]) == 2  # never overwrites the record
    capsys.readouterr()
    assert mc.main(["switch", "--manifest", str(path), "--dry-run"]) == 0
    assert _printed_json(capsys.readouterr().out)["dry_run"] is True
    assert _flags(env, pairs) == [(True, False)] * 3

    assert mc.main(["switch", "--manifest", str(path)]) == 0
    out = capsys.readouterr().out
    report = _printed_json(out)
    assert report["command"] == "switch" and [p["status"] for p in report["pairs"]] == ["switched"] * 3
    assert "sig=" not in out and "_url" not in out and "://" not in out
    assert _flags(env, pairs) == [(False, True)] * 3

    assert mc.main(["rollback", "--manifest", str(path)]) == 0
    assert _printed_json(capsys.readouterr().out)["command"] == "rollback"
    assert _flags(env, pairs) == [(True, False)] * 3


@pytest.mark.parametrize("cmd, flags", [
    ("render-podcast", ["--unpublished", "--force", "--format", "--from-script"]),
    ("render-video", ["--unpublished", "--force", "--from-script"]),
    ("script-podcast", ["--out", "--dry-run"]),
    ("script-video", ["--out", "--dry-run"]),
    ("publish", ["--podcast-id", "--video-id", "--off"]),
    ("unpublish", ["--podcast-id", "--video-id", "--dry-run"]),
    ("plan-switch", ["--out", "--dry-run"]),
    ("switch", ["--manifest", "--dry-run"]),
    ("rollback", ["--manifest", "--dry-run"]),
])
def test_cli_help_of_the_staged_commands_needs_no_azure(monkeypatch, capsys, cmd, flags):
    def no_azure():
        raise AssertionError("--help must not load the Azure configuration")

    monkeypatch.setattr(mc, "_cfg", no_azure)
    with pytest.raises(SystemExit) as stop:
        mc.main([cmd, "--help"])
    assert stop.value.code == 0
    out = capsys.readouterr().out
    assert cmd in out and all(flag in out for flag in flags)


def test_module_usage_documents_the_staged_commands():
    doc = mc.__doc__
    for token in ("--unpublished", "--video-id", "RENDERED <podcast|video> <name> <job id>",
                  "unpublish [--podcast-id", "plan-switch --out", "switch --manifest", "rollback --manifest",
                  '"pairs"', "never a gap", "script-podcast", "script-video", "--from-script",
                  "SCRIPTED <kind> <name> <sha256> <file>", "USING_SCRIPT <kind> <name> <sha256> <file>",
                  "content_sha256"):
        assert token in doc, token


# ---------------------------------------------------------------------------
# Reviewed scripts: script-podcast / script-video, then render --from-script
# ---------------------------------------------------------------------------
TURN_TEXTS = (
    "Welcome to the show — what is a “model”, café-style?",
    "A model is a function learned from data. It predicts the next word.",
    "And what is an agent?",
    "An agent loops: it plans, calls a tool and looks at the result.",
)
SCRIPT_TURNS = [
    DialogueTurn(idx=0, speaker="interviewer", text=TURN_TEXTS[0], slide_idx=0),
    DialogueTurn(idx=1, speaker="expert", text=TURN_TEXTS[1], slide_idx=0,
                 reaction=ReactionHint(after_sentence=1, reaction_id="ack")),
    DialogueTurn(idx=2, speaker="interviewer", text=TURN_TEXTS[2], slide_idx=None),
    DialogueTurn(idx=3, speaker="expert", text=TURN_TEXTS[3], slide_idx=2),
]
SCRIPT_LINES = [  # what the file holds for SCRIPT_TURNS, written out by hand
    {"idx": 0, "speaker": "interviewer", "text": TURN_TEXTS[0], "slide_idx": 0, "reaction": None},
    {"idx": 1, "speaker": "expert", "text": TURN_TEXTS[1], "slide_idx": 0,
     "reaction": {"after_sentence": 1, "reaction_id": "ack"}},
    {"idx": 2, "speaker": "interviewer", "text": TURN_TEXTS[2], "slide_idx": None, "reaction": None},
    {"idx": 3, "speaker": "expert", "text": TURN_TEXTS[3], "slide_idx": 2, "reaction": None},
]
TURN_ROW = re.compile(r"^\s*(\d+) s(\d+|-)\s+(interviewer|expert)\s+(.*)$", re.MULTILINE)
SLIDE_ROW = re.compile(r"^slide\s+(\d+)(?: \((.+?)\))?: (.*)$", re.MULTILINE)


def _no_library(monkeypatch):
    from routers import podcast as pr
    from routers import video as vr

    def boom(cfg):
        raise AssertionError("a script must be produced without touching the library")

    monkeypatch.setattr(pr, "_get_library", boom)
    monkeypatch.setattr(vr, "_get_library", boom)


def _no_render(monkeypatch):
    from routers import podcast as pr
    from routers import video as vr

    async def boom(job_id, cfg):
        raise AssertionError("a script must be produced without rendering")

    monkeypatch.setattr(pr, "_render_job_body", boom)
    monkeypatch.setattr(vr, "_render_job_body", boom)


def _no_generation(monkeypatch):
    from services import podcast_script, video_script

    async def boom(cfg, doc, req):
        raise AssertionError("the reviewed script must not be generated again")
        yield  # makes this an async generator

    monkeypatch.setattr(podcast_script, "generate_script_stream", boom)
    monkeypatch.setattr(video_script, "generate_script_stream", boom)


def _digest(lines):
    return hashlib.sha256(json.dumps(lines, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _script_podcast(env, monkeypatch, tmp_path, name="expert", turns=SCRIPT_TURNS):
    seen = _fake_podcast_pipeline(monkeypatch, env, turns=turns)
    out = tmp_path / f"podcast-{name}.json"
    return seen, out, asyncio.run(mc.script_podcast(env.cfg, name, out=out))


def _script_video(env, monkeypatch, tmp_path, name="demo-en", **pipeline):
    seen = _fake_video_pipeline(monkeypatch, env, **pipeline)
    out = tmp_path / f"video-{name}.json"
    return seen, out, asyncio.run(mc.script_video(env.cfg, name, out=out))


def _tamper(path, mutate, *, rehash=False):
    """Edit a script file; ``rehash`` keeps content_sha256 valid so a check other than the digest is hit."""
    data = json.loads(path.read_text(encoding="utf-8"))
    mutate(data)
    if rehash:
        data["content_sha256"] = _digest(data["turns" if data.get("kind") == "podcast" else "narrations"])
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


# --- script-podcast / script-video ------------------------------------------
def test_script_podcast_writes_the_script_and_never_touches_the_library(env, monkeypatch, tmp_path, capsys):
    seen = _fake_podcast_pipeline(monkeypatch, env, turns=SCRIPT_TURNS)
    from routers import podcast as pr

    stores = (dict(pr.SCRIPTS), dict(pr.JOBS), dict(pr.DOCUMENTS))
    _no_library(monkeypatch)
    _no_render(monkeypatch)
    out = tmp_path / "scripts" / "podcast-expert.json"
    result = asyncio.run(mc.script_podcast(env.cfg, "expert", out=out))
    spec = mc.PODCASTS["expert"]
    text = out.read_text(encoding="utf-8")
    data = json.loads(text)
    assert set(data) == mc.SCRIPT_KEYS["podcast"]
    assert (data["schema_version"], data["kind"], data["key"], data["title"]) == (1, "podcast", "expert", spec.title)
    assert (data["deck"], data["language"], data["style"], data["audience_level"]) == (
        spec.deck, "en-US", "debate", "expert")
    assert data["deck_sha256"] == hashlib.sha256(mc._deck_path(spec.deck).read_bytes()).hexdigest()
    assert datetime.fromisoformat(data["generated_at"]).tzinfo is not None
    assert data["turns"] == SCRIPT_LINES and "word_timings" not in text  # what the model wrote, nothing of the render
    assert data["content_sha256"] == _digest(SCRIPT_LINES)
    req = seen["req"]  # the very request the render sends
    assert (req.language, req.style, req.audience_level, req.length, req.num_turns) == (
        "en-US", "debate", "expert", "medium", 8)
    assert (result["action"], result["turns"], result["content_sha256"]) == ("scripted", 4, data["content_sha256"])
    assert (dict(pr.SCRIPTS), dict(pr.JOBS), dict(pr.DOCUMENTS)) == stores  # no router state either

    stdout = capsys.readouterr().out
    rows = TURN_ROW.findall(stdout)
    assert [(int(i), s, who) for i, s, who, _ in rows] == [(0, "0", "interviewer"), (1, "0", "expert"),
                                                          (2, "-", "interviewer"), (3, "2", "expert")]
    assert [row[3] for row in rows] == [TURN_TEXTS[0], TURN_TEXTS[1] + "  [+ack@1]", TURN_TEXTS[2], TURN_TEXTS[3]]
    words = sum(len(t.split()) for t in TURN_TEXTS)
    assert f"== 4 turns, {words} words, slides referenced 2/3, sha256 {data['content_sha256'][:12]} ==" in stdout
    assert f"== podcast expert: {spec.title} | en-US | debate | expert ==" in stdout
    assert f"SCRIPTED podcast expert {data['content_sha256']} {out}" in stdout.splitlines()
    assert "://" not in stdout and "sig=" not in stdout


def test_script_video_writes_the_script_and_never_touches_the_library(env, monkeypatch, tmp_path, capsys):
    seen = _fake_video_pipeline(monkeypatch, env, slides=3, reverse=True)  # the model answers out of order
    _no_library(monkeypatch)
    _no_render(monkeypatch)
    out = tmp_path / "video-demo-fr.json"
    result = asyncio.run(mc.script_video(env.cfg, "demo-fr", out=out))
    spec = mc.VIDEOS["demo-fr"]
    text = out.read_text(encoding="utf-8")
    data = json.loads(text)
    assert set(data) == mc.SCRIPT_KEYS["video"]
    assert (data["kind"], data["key"], data["title"], data["deck"]) == ("video", "demo-fr", spec.title, spec.deck)
    assert (data["language"], data["style"], data["audience_level"], data["voice"]) == (
        "fr-FR", "explainer", "beginner", spec.voice)
    assert data["deck_sha256"] == hashlib.sha256(mc._deck_path(spec.deck).read_bytes()).hexdigest()
    narrations = [{"slide_index": 0, "narration": "hello 0", "speaking_style": "calm", "duration_hint_s": 4.5},
                  {"slide_index": 1, "narration": "hello 1", "speaking_style": None, "duration_hint_s": None},
                  {"slide_index": 2, "narration": "hello 2", "speaking_style": None, "duration_hint_s": None}]
    assert data["narrations"] == narrations  # sorted by slide, as the render consumes them
    assert data["content_sha256"] == _digest(narrations)
    assert "slide_image_ref" not in text and "slide-0.png" not in text  # paths of this ingest are not stored
    req = seen["req"]
    assert (req.language, req.style, req.audience_level, req.voice) == ("fr-FR", "explainer", "beginner", spec.voice)
    assert (result["action"], result["narrations"]) == ("scripted", 3)

    stdout = capsys.readouterr().out
    assert SLIDE_ROW.findall(stdout) == [("0", "calm", "hello 0"), ("1", "", "hello 1"), ("2", "", "hello 2")]
    assert (f"== 3 narrations, 6 words, slides without narration: none, sha256 {data['content_sha256'][:12]} =="
            in stdout)
    assert f"SCRIPTED video demo-fr {data['content_sha256']} {out}" in stdout.splitlines()
    assert "://" not in stdout


def test_script_video_reports_slides_without_a_narration(env, monkeypatch, tmp_path, capsys):
    def only_first(doc, req):
        return [SlideNarration(slide_index=0, slide_image_ref="", narration="just one", voice=req.voice)]

    _script_video(env, monkeypatch, tmp_path, slides=3, narrations=only_first)
    assert "slides without narration: [1, 2]" in capsys.readouterr().out


@pytest.mark.parametrize("kind, name", [("podcast", "beginner"), ("video", "demo-en")])
def test_script_commands_refuse_to_overwrite_and_dry_run_calls_no_model(env, monkeypatch, tmp_path, kind, name):
    seen = (_fake_podcast_pipeline if kind == "podcast" else _fake_video_pipeline)(monkeypatch, env)
    run = mc.script_podcast if kind == "podcast" else mc.script_video
    _no_library(monkeypatch)
    _no_render(monkeypatch)
    out = tmp_path / "s.json"
    plan = asyncio.run(run(env.cfg, name, out=out, dry_run=True))
    assert (plan["action"], plan["kind"], plan["name"], plan["out"]) == ("would generate", kind, name, str(out))
    assert seen == {} and not out.exists()  # no ingest, no model call, nothing written

    out.write_text("precious", encoding="utf-8")
    for dry_run in (False, True):
        with pytest.raises(mc.MaintenanceError, match="refusing to overwrite"):
            asyncio.run(run(env.cfg, name, out=out, dry_run=dry_run))
    assert out.read_text(encoding="utf-8") == "precious" and seen == {}
    with pytest.raises(mc.MaintenanceError, match="refusing to overwrite"):  # also when it appears mid-run
        mc._write_script(out, {"x": 1})
    assert out.read_text(encoding="utf-8") == "precious"


def test_a_failed_generation_writes_no_script(env, monkeypatch, tmp_path):
    from services import podcast_script

    _fake_podcast_pipeline(monkeypatch, env)

    async def boom(cfg, doc, req):
        raise RuntimeError("model unavailable")
        yield

    monkeypatch.setattr(podcast_script, "generate_script_stream", boom)
    out = tmp_path / "s.json"
    with pytest.raises(RuntimeError, match="model unavailable"):
        asyncio.run(mc.script_podcast(env.cfg, "beginner", out=out))
    assert not out.exists() and not list(tmp_path.glob("*.json")) and not list(tmp_path.glob("*.tmp"))


def _line(i, **extra):
    return DialogueTurn(idx=i, speaker="interviewer" if i % 2 == 0 else "expert", text=f"line {i}", **extra)


@pytest.mark.parametrize("turns, match", [
    ([_line(0), DialogueTurn(idx=1, speaker="expert", text="  ")], "non-empty text"),
    ([_line(0), _line(0)], "appears twice"),
    ([_line(i) for i in range(41)], "Too many turns"),
    ([_line(0), DialogueTurn(idx=1, speaker="expert", text="x" * 3001)], "too long"),
], ids=["empty line", "duplicate idx", "too many turns", "line too long"])
def test_script_podcast_refuses_a_script_the_render_would_refuse(env, monkeypatch, tmp_path, turns, match):
    _fake_podcast_pipeline(monkeypatch, env, turns=turns)
    out = tmp_path / "s.json"
    with pytest.raises(mc.MaintenanceError, match=match):
        asyncio.run(mc.script_podcast(env.cfg, "beginner", out=out))
    assert not out.exists()


def test_script_video_refuses_a_script_the_render_would_refuse(env, monkeypatch, tmp_path):
    def narrations(lines):
        return lambda doc, req: [SlideNarration(slide_index=i, slide_image_ref="", narration=text, voice=req.voice)
                                 for i, text in lines]

    out = tmp_path / "s.json"
    for lines, slides, match in (([(0, "ok"), (1, "x" * 3001)], 2, "narration too long"),
                                 ([(i, "ok") for i in range(61)], 61, "too many slides"),
                                 ([(0, "ok"), (5, "no such slide")], 3, "the deck has no slide"),
                                 ([(0, "ok"), (1, "  ")], 2, "non-empty text"),
                                 ([(0, "ok"), (0, "again")], 2, "appears twice")):
        _fake_video_pipeline(monkeypatch, env, slides=slides, narrations=narrations(lines))
        with pytest.raises(mc.MaintenanceError, match=match):
            asyncio.run(mc.script_video(env.cfg, "demo-en", out=out))
        assert not out.exists()


def test_output_survives_an_ascii_only_console(env, monkeypatch, tmp_path):
    raw = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(raw, encoding="ascii", errors="strict", write_through=True))
    mc._out("café – “déjà vu” · fin")
    mc._print({"title": "AI, demystified · Beginner"})
    text = raw.getvalue().decode("ascii")
    assert "caf\\xe9 \\u2013 \\u201cd\\xe9j\\xe0 vu\\u201d \\xb7 fin" in text
    assert "AI, demystified \\xb7 Beginner" in text

    # End to end: the transcript prints (as escapes) while the file keeps the real characters.
    _fake_podcast_pipeline(monkeypatch, env, turns=SCRIPT_TURNS)
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    raw.seek(0)
    raw.truncate()
    out = tmp_path / "s.json"
    assert mc.main(["script-podcast", "expert", "--out", str(out)]) == 0
    printed = raw.getvalue().decode("ascii")
    assert "welcome to the show".lower() in printed.lower() and "\\u201cmodel\\u201d" in printed
    assert "“model”" in out.read_text(encoding="utf-8")
    raw.seek(0)
    raw.truncate()
    assert mc.main(["script-podcast", "beginner", "--out", str(tmp_path / "dry.json"), "--dry-run"]) == 0
    assert '"action": "would generate"' in raw.getvalue().decode("ascii") and not (tmp_path / "dry.json").exists()


# --- render --from-script ---------------------------------------------------
def test_render_podcast_from_script_renders_exactly_the_reviewed_turns(env, monkeypatch, tmp_path, capsys):
    seen, out, scripted = _script_podcast(env, monkeypatch, tmp_path)
    digest = scripted["content_sha256"]
    reviewed = capsys.readouterr().out
    assert f"SCRIPTED podcast expert {digest} {out}" in reviewed.splitlines()
    before = out.read_bytes()
    seen.clear()
    _no_generation(monkeypatch)  # the model must not be asked again
    result = asyncio.run(mc.render_podcast(env.cfg, "expert", from_script=out, force=True, unpublished=True))
    stdout = capsys.readouterr().out
    spec = mc.PODCASTS["expert"]
    assert result["action"] == "rendered" and result["published"] is False and seen["ingested"] == 1
    assert result["script"] == {"file": str(out), "turns": 4, "content_sha256": digest,
                                "generated_at": scripted["generated_at"]}
    assert seen["turns"] == SCRIPT_TURNS  # the render worker got the reviewed turns, unchanged
    assert [t.model_dump(exclude={"word_timings"}) for t in seen["turns"]] == SCRIPT_LINES
    script = seen["script"]
    assert (script.language, script.style, script.length, script.audience_level) == ("en-US", "debate", "medium",
                                                                                        "expert")
    assert seen["doc_title"] == spec.title and seen["job"].format == "video"
    assert f"USING_SCRIPT podcast expert {digest} {out}" in stdout.splitlines()  # the digest the review saw
    assert RENDERED_LINE.findall(stdout) == [("podcast", "expert", result["job_id"])]
    assert env.plib.items[result["job_id"]]["published"] is False and out.read_bytes() == before


def test_render_podcast_from_script_without_unpublished_publishes_and_audio_still_works(env, monkeypatch, tmp_path):
    seen, out, _ = _script_podcast(env, monkeypatch, tmp_path)
    seen.clear()
    _no_generation(monkeypatch)
    result = asyncio.run(mc.render_podcast(env.cfg, "expert", from_script=out, fmt="audio"))
    assert result["published"] is True and env.plib.items[result["job_id"]]["published"] is True
    assert seen["job"].format == "audio" and seen["turns"] == SCRIPT_TURNS


def test_render_video_from_script_renders_exactly_the_reviewed_narrations(env, monkeypatch, tmp_path, capsys):
    seen, out, scripted = _script_video(env, monkeypatch, tmp_path, slides=3, reverse=True)
    generation_doc = seen["req"]  # noqa: F841 - the script was generated from a different ingest
    digest = scripted["content_sha256"]
    capsys.readouterr()
    seen.clear()
    _no_generation(monkeypatch)
    result = asyncio.run(mc.render_video(env.cfg, "demo-en", from_script=out, force=True, unpublished=True))
    stdout = capsys.readouterr().out
    spec = mc.VIDEOS["demo-en"]
    expected = json.loads(out.read_text(encoding="utf-8"))["narrations"]
    script, doc = seen["script"], seen["doc"]
    assert result["action"] == "rendered" and result["published"] is False and seen["ingested"] == 1
    assert result["script"]["content_sha256"] == digest and result["script"]["narrations"] == 3
    assert [(n.slide_index, n.narration, n.speaking_style, n.duration_hint_s) for n in script.narrations] == [
        (e["slide_index"], e["narration"], e["speaking_style"], e["duration_hint_s"]) for e in expected]
    # Slide images and titles come from the deck ingested for THIS render, not from the script.
    assert [n.slide_image_ref for n in script.narrations] == [s.image_ref for s in doc.slides]
    assert all(n.slide_image_ref.startswith(doc.doc_id) for n in script.narrations)
    assert [n.title for n in script.narrations] == ["Slide 0", "Slide 1", "Slide 2"]
    assert all(n.voice == spec.voice for n in script.narrations) and script.voice == spec.voice
    assert (script.language, script.style, script.audience_level) == ("en-US", "explainer", "beginner")
    assert f"USING_SCRIPT video demo-en {digest} {out}" in stdout.splitlines()
    assert RENDERED_LINE.findall(stdout) == [("video", "demo-en", result["job_id"])]
    assert env.vlib.items[result["job_id"]]["published"] is False


def test_render_from_script_dry_run_validates_without_any_work(env, monkeypatch, tmp_path, capsys):
    seen, out, scripted = _script_podcast(env, monkeypatch, tmp_path)
    capsys.readouterr()
    seen.clear()
    plan = asyncio.run(mc.render_podcast(env.cfg, "expert", from_script=out, dry_run=True, force=True))
    assert plan["action"] == "would render" and plan["script"]["content_sha256"] == scripted["content_sha256"]
    assert seen == {} and "USING_SCRIPT" not in capsys.readouterr().out
    _tamper(out, lambda d: d["turns"][0].update(text="edited"))
    with pytest.raises(mc.MaintenanceError, match="edited after it was generated"):
        asyncio.run(mc.render_podcast(env.cfg, "expert", from_script=out, dry_run=True))


def test_render_from_script_leaves_an_existing_item_alone_without_force(env, monkeypatch, tmp_path, capsys):
    seen, out, _ = _script_podcast(env, monkeypatch, tmp_path)
    env.plib.add("job-0000aa01", mc.PODCASTS["expert"].title, published=True, format="video")
    capsys.readouterr()
    seen.clear()
    plan = asyncio.run(mc.render_podcast(env.cfg, "expert", from_script=out, unpublished=True))
    assert plan["action"] == "exists" and seen == {} and len(env.plib.items) == 1
    assert "USING_SCRIPT" not in capsys.readouterr().out


def test_a_reformatted_script_file_is_still_the_same_script(env, monkeypatch, tmp_path):
    seen, out, scripted = _script_podcast(env, monkeypatch, tmp_path)
    data = json.loads(out.read_text(encoding="utf-8"))
    out.write_bytes(b"\xef\xbb\xbf" + json.dumps(data, sort_keys=True, ensure_ascii=True).encode("utf-8"))
    seen.clear()
    plan = asyncio.run(mc.render_podcast(env.cfg, "expert", from_script=out, dry_run=True, force=True))
    assert plan["script"]["content_sha256"] == scripted["content_sha256"]  # digest = content, not bytes


def test_render_refuses_a_script_made_from_another_deck(env, monkeypatch, tmp_path):
    seen, out, _ = _script_podcast(env, monkeypatch, tmp_path)
    decks = tmp_path / "decks"
    decks.mkdir()
    (decks / mc.PODCASTS["expert"].deck).write_bytes(mc._deck_path(mc.PODCASTS["expert"].deck).read_bytes() + b"x")
    seen.clear()
    with pytest.raises(mc.MaintenanceError, match="the deck changed since this script was generated"):
        asyncio.run(mc.render_podcast(env.cfg, "expert", from_script=out, deck_dir=decks, force=True))
    assert seen == {}


BAD_PODCAST_SCRIPTS = {  # name: (edit, keep content_sha256 valid, expected problem)
    "a video script": (lambda d: d.update(kind="video"), False, "kind is 'video', expected 'podcast'"),
    "another episode": (lambda d: d.update(key="beginner"), False, "key is 'beginner', expected 'expert'"),
    "other schema version": (lambda d: d.update(schema_version=2), False, "schema_version is 2"),
    "extra top-level key": (lambda d: d.update(voice="x"), False, "unexpected keys"),
    "missing top-level key": (lambda d: d.pop("generated_at"), False, "missing keys"),
    "bad timestamp": (lambda d: d.update(generated_at="yesterday"), False, "ISO timestamp"),
    "other language": (lambda d: d.update(language="fr-FR"), False, "language is 'fr-FR'"),
    "other audience": (lambda d: d.update(audience_level="beginner"), False, "audience_level is 'beginner'"),
    "other style": (lambda d: d.update(style="casual"), False, "style is 'casual'"),
    "other deck": (lambda d: d.update(deck="other.pptx"), False, "deck is 'other.pptx'"),
    "deck changed": (lambda d: d.update(deck_sha256="0" * 64), False, "the deck changed since"),
    "turns is not a list": (lambda d: d.update(turns={"idx": 0}), False, "turns must be a non-empty list"),
    "no turns": (lambda d: d.update(turns=[]), False, "turns must be a non-empty list"),
    "edited text": (lambda d: d["turns"][0].update(text=d["turns"][0]["text"] + " (edited)"), False,
                    "edited after it was generated"),
    "reordered turns": (lambda d: d["turns"].reverse(), False, "edited after it was generated"),
    "unknown turn key": (lambda d: d["turns"][0].update(emotion="happy"), True, "exactly the keys"),
    "missing turn key": (lambda d: d["turns"][0].pop("slide_idx"), True, "exactly the keys"),
    "word timings smuggled in": (lambda d: d["turns"][0].update(word_timings=[]), True, "exactly the keys"),
    "unknown speaker": (lambda d: d["turns"][1].update(speaker="host"), True, "speaker must be"),
    "blank text": (lambda d: d["turns"][0].update(text="  "), True, "non-empty text"),
    "duplicate idx": (lambda d: d["turns"][1].update(idx=0), True, "appears twice"),
    "boolean idx": (lambda d: d["turns"][0].update(idx=True), True, "non-negative integer"),
    "negative idx": (lambda d: d["turns"][0].update(idx=-1), True, "non-negative integer"),
    "text slide index": (lambda d: d["turns"][0].update(slide_idx="3"), True, "slide_idx must be"),
    "reaction at sentence 0": (lambda d: d["turns"][1].update(reaction={"after_sentence": 0, "reaction_id": "ack"}),
                               True, "reaction must be"),
    "unknown reaction id": (lambda d: d["turns"][1].update(reaction={"after_sentence": 1, "reaction_id": "wow"}),
                            True, "reaction must be"),
    "reaction with extra key": (lambda d: d["turns"][1].update(
        reaction={"after_sentence": 1, "reaction_id": "ack", "text": "x"}), True, "reaction must be"),
    "too many turns": (lambda d: d.update(turns=[{"idx": i, "speaker": "expert", "text": f"t{i}", "slide_idx": None,
                                                  "reaction": None} for i in range(41)]), True, "Too many turns"),
    "turn too long": (lambda d: d["turns"][0].update(text="x" * 3001), True, "too long"),
}


@pytest.mark.parametrize("case", list(BAD_PODCAST_SCRIPTS))
def test_render_podcast_refuses_an_invalid_script_before_any_work(env, monkeypatch, tmp_path, case):
    seen, out, _ = _script_podcast(env, monkeypatch, tmp_path)
    edit, rehash, problem = BAD_PODCAST_SCRIPTS[case]
    _tamper(out, edit, rehash=rehash)
    seen.clear()
    _no_library(monkeypatch)
    _no_generation(monkeypatch)
    for dry_run in (False, True):
        with pytest.raises(mc.MaintenanceError, match=re.escape(problem)):
            asyncio.run(mc.render_podcast(env.cfg, "expert", from_script=out, dry_run=dry_run, force=True,
                                          unpublished=True))
    assert seen == {}  # no ingest, no model call, no render


BAD_VIDEO_SCRIPTS = {
    "a podcast script": (lambda d: d.update(kind="podcast"), False, "kind is 'podcast', expected 'video'"),
    "another video": (lambda d: d.update(key="demo-fr"), False, "key is 'demo-fr', expected 'demo-en'"),
    "other voice": (lambda d: d.update(voice="en-US-Andrew:DragonHDLatestNeural"), False, "voice is"),
    "missing voice": (lambda d: d.pop("voice"), False, "missing keys ['voice']"),
    "deck changed": (lambda d: d.update(deck_sha256="f" * 64), False, "the deck changed since"),
    "edited narration": (lambda d: d["narrations"][1].update(narration="edited"), False,
                         "edited after it was generated"),
    "unknown narration key": (lambda d: d["narrations"][0].update(slide_image_ref="/etc/passwd"), True,
                              "exactly the keys"),
    "missing narration key": (lambda d: d["narrations"][0].pop("duration_hint_s"), True, "exactly the keys"),
    "blank narration": (lambda d: d["narrations"][0].update(narration=""), True, "non-empty text"),
    "duplicate slide": (lambda d: d["narrations"][1].update(slide_index=0), True, "appears twice"),
    "negative slide": (lambda d: d["narrations"][0].update(slide_index=-1), True, "non-negative integer"),
    "style is a number": (lambda d: d["narrations"][0].update(speaking_style=3), True, "speaking_style must be"),
    "negative duration": (lambda d: d["narrations"][0].update(duration_hint_s=-1), True, "duration_hint_s must be"),
    "boolean duration": (lambda d: d["narrations"][0].update(duration_hint_s=True), True, "duration_hint_s must be"),
    "narration too long": (lambda d: d["narrations"][0].update(narration="x" * 3001), True, "narration too long"),
    "too many narrations": (lambda d: d.update(narrations=[{"slide_index": i, "narration": "n", "speaking_style": None,
                                                            "duration_hint_s": None} for i in range(61)]),
                            True, "too many slides"),
}


@pytest.mark.parametrize("case", list(BAD_VIDEO_SCRIPTS))
def test_render_video_refuses_an_invalid_script_before_any_work(env, monkeypatch, tmp_path, case):
    seen, out, _ = _script_video(env, monkeypatch, tmp_path, slides=3)
    edit, rehash, problem = BAD_VIDEO_SCRIPTS[case]
    _tamper(out, edit, rehash=rehash)
    seen.clear()
    _no_library(monkeypatch)
    _no_generation(monkeypatch)
    for dry_run in (False, True):
        with pytest.raises(mc.MaintenanceError, match=re.escape(problem)):
            asyncio.run(mc.render_video(env.cfg, "demo-en", from_script=out, dry_run=dry_run, force=True,
                                        unpublished=True))
    assert seen == {}


def test_render_video_refuses_a_narration_for_a_slide_the_deck_does_not_have(env, monkeypatch, tmp_path):
    seen, out, _ = _script_video(env, monkeypatch, tmp_path, slides=3)
    _tamper(out, lambda d: d["narrations"][2].update(slide_index=7), rehash=True)
    seen.clear()
    with pytest.raises(mc.MaintenanceError, match=re.escape("the deck has no slide [7]")):
        asyncio.run(mc.render_video(env.cfg, "demo-en", from_script=out, force=True, unpublished=True))
    assert "script" not in seen and not env.vlib.items  # refused after the ingest, before any render


def test_render_from_script_refuses_unreadable_oversized_and_malformed_files(env, monkeypatch, tmp_path):
    seen, out, _ = _script_podcast(env, monkeypatch, tmp_path)
    seen.clear()
    _no_library(monkeypatch)
    _no_generation(monkeypatch)

    def refused(match):
        with pytest.raises(mc.MaintenanceError, match=match):
            asyncio.run(mc.render_podcast(env.cfg, "expert", from_script=out, force=True))
        assert seen == {}

    good = out.read_bytes()
    monkeypatch.setattr(mc, "MAX_SCRIPT_FILE_BYTES", len(good) - 1)  # one byte over the cap
    refused("byte cap")
    monkeypatch.setattr(mc, "MAX_SCRIPT_FILE_BYTES", len(good))  # exactly at the cap is fine
    spec = mc.PODCASTS["expert"]
    assert mc._load_script(out, "podcast", "expert", spec, mc._deck_path(spec.deck)).kind == "podcast"
    monkeypatch.setattr(mc, "MAX_SCRIPT_FILE_BYTES", 1024 * 1024)
    for raw, match in ((b"not json", "not valid JSON"), (b"\xff\xfe\x00", "not valid JSON"),
                       (b"[" * 100_000, "not valid JSON"), (b"[1, 2]", "must be a JSON object"),
                       (b"", "not valid JSON")):
        out.write_bytes(raw)
        refused(match)
    out.unlink()
    refused("cannot read script file")


def test_render_all_cannot_take_a_script_and_cli_wiring(env, monkeypatch, tmp_path, capsys):
    _fake_podcast_pipeline(monkeypatch, env, turns=SCRIPT_TURNS)
    _fake_video_pipeline(monkeypatch, env, slides=2)
    monkeypatch.setattr(mc, "_cfg", lambda: env.cfg)
    p_out, v_out = tmp_path / "p.json", tmp_path / "v.json"
    assert mc.main(["script-podcast", "expert", "--out", str(p_out)]) == 0
    assert mc.main(["script-video", "demo-en", "--out", str(v_out)]) == 0
    out = capsys.readouterr().out
    assert "SCRIPTED podcast expert" in out and "SCRIPTED video demo-en" in out and "://" not in out
    assert not env.plib.items and not env.vlib.items  # nothing archived, so nothing to publish

    _no_generation(monkeypatch)
    assert mc.main(["render-podcast", "expert", "--from-script", str(p_out), "--force", "--unpublished"]) == 0
    assert mc.main(["render-video", "demo-en", "--from-script", str(v_out), "--force", "--unpublished"]) == 0
    rendered = RENDERED_LINE.findall(capsys.readouterr().out)
    assert [(k, n) for k, n, _ in rendered] == [("podcast", "expert"), ("video", "demo-en")]
    assert len(env.plib.items) == 1 and len(env.vlib.items) == 1
    assert not any(i["published"] for i in (*env.plib.items.values(), *env.vlib.items.values()))

    assert mc.main(["render-podcast", "all", "--from-script", str(p_out)]) == 2
    assert "name the episode, not 'all'" in capsys.readouterr().out
    assert mc.main(["render-video", "all", "--from-script", str(v_out)]) == 2
    assert mc.main(["render-podcast", "expert", "--from-script", str(v_out)]) == 2  # a video script
    assert "invalid script file" in capsys.readouterr().out
    assert len(env.plib.items) == 1 and len(env.vlib.items) == 1


def test_script_digest_is_the_same_in_the_review_and_in_the_render(env, monkeypatch, tmp_path, capsys):
    seen, out, scripted = _script_podcast(env, monkeypatch, tmp_path)
    expected = _digest(SCRIPT_LINES)
    assert scripted["content_sha256"] == expected == json.loads(out.read_text(encoding="utf-8"))["content_sha256"]
    assert f"SCRIPTED podcast expert {expected} {out}" in capsys.readouterr().out.splitlines()
    seen.clear()
    asyncio.run(mc.render_podcast(env.cfg, "expert", from_script=out, force=True, unpublished=True))
    assert f"USING_SCRIPT podcast expert {expected} {out}" in capsys.readouterr().out.splitlines()


def test_cli_script_commands_parse():
    parse = mc.build_parser().parse_args
    args = parse(["--background", "/tmp/s.log", "script-podcast", "expert", "--out", "/tmp/e.json"])
    assert args.cmd == "script-podcast" and args.name == "expert" and args.dry_run is False
    assert str(args.background).replace("\\", "/").endswith("tmp/s.log") and args.out == Path("/tmp/e.json")
    assert parse(["script-video", "demo-fr", "--out", "v.json", "--dry-run"]).dry_run is True
    for argv in (["script-podcast", "all", "--out", "x"], ["script-podcast", "demo-en", "--out", "x"],
                 ["script-video", "beginner", "--out", "x"], ["script-podcast", "expert"], ["script-video", "demo-en"]):
        with pytest.raises(SystemExit):
            parse(argv)
    assert parse(["render-podcast", "expert", "--from-script", "e.json", "--unpublished"]).from_script == Path("e.json")
    assert parse(["render-video", "demo-en", "--from-script", "v.json"]).from_script == Path("v.json")
    assert parse(["render-podcast", "all"]).from_script is None and parse(["render-video", "all"]).from_script is None

