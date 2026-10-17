"""Publication boundary: anonymous callers only see published items as public DTOs."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

UUID_PUB = "0b5f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
UUID_PRIV = "1c6f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"

VIDEO_PUBLIC_KEYS = {
    "job_id", "title", "created_at", "duration_sec", "language", "thumbnail_url", "video_url",
    "audio_url", "srt_url", "scorm_url", "script",
}
# One schema whatever PODCAST_PUBLIC_AUDIO says: the flag only decides the values.
PODCAST_PUBLIC_KEYS = {
    "job_id", "title", "created_at", "duration_sec", "audio_duration_sec", "language", "format",
    "has_video", "has_audio", "thumbnail_url", "cover_url", "video_url", "mp4_url", "audio_url", "mp3_url",
    "hosts", "speaker_names", "transcript", "srt_url", "audio_srt_url", "scorm_url", "script",
}
PODCAST_ALWAYS_NONE = ("srt_url", "audio_srt_url", "scorm_url", "script")
PODCAST_AUDIO_KEYS = ("audio_url", "mp3_url", "cover_url", "transcript", "audio_duration_sec")
SECRET_DOC = "Confidential-Source-Deck.pptx"
SECRET_VOICE = "en-US-SentinelVoice:DragonHDLatestNeural"


class FakeLibrary:
    """Mimics VideoLibrary without blob storage."""

    def __init__(self, kind: str = "video"):
        self.kind = kind
        self.available = True
        pfx = "sv-"
        self.items = {
            f"{pfx}0000aaaa": {"job_id": f"{pfx}0000aaaa", "title": "Public", "created_at": "2026-01-02",
                               "duration_sec": 12.5, "language": "en-US", "published": True,
                               "document_title": "secret doc", "voice": "en-US-Ava:DragonHDLatestNeural",
                               "speaker_names": ["A", "B"]},
            f"{pfx}0000bbbb": {"job_id": f"{pfx}0000bbbb", "title": "Private", "created_at": "2026-01-01",
                               "duration_sec": 3.0, "language": "fr-FR", "published": False},
        }
        self.sas_minutes: list[int] = []
        self.published_calls: list = []

    def list(self, *, published_only: bool = False):
        out = []
        for it in self.items.values():
            if published_only and not it["published"]:
                continue
            out.append({**it, "thumbnail_url": "https://blob/thumb?sas"})
        return out

    def get(self, job_id, *, public: bool = False):
        it = self.items.get(job_id)
        if not it:
            return None
        if public and not it["published"]:
            return None
        full = {**it, "thumbnail_url": "https://blob/thumb?sas"}
        full.update(video_url="https://blob/video?sas", audio_url=None if public else "https://blob/a",
                    srt_url=None if public else "https://blob/s", scorm_url=None if public else "https://blob/z")
        return full

    def set_published(self, job_id, published):
        if job_id not in self.items:
            return None
        self.published_calls.append((job_id, published))
        self.items[job_id]["published"] = published
        return self.get(job_id)

    def delete(self, job_id):
        return self.items.pop(job_id, None) is not None


@pytest.fixture
def video_lib(monkeypatch):
    import routers.video as sv

    lib = FakeLibrary("video")
    monkeypatch.setattr(sv, "_get_library", lambda cfg: lib)
    return lib


# ---------------------------------------------------------------------------
# Video library
# ---------------------------------------------------------------------------
def test_video_anonymous_list_only_published(client, easyauth, video_lib):
    r = client.get("/api/video/library")
    assert r.status_code == 200
    items = r.json()
    assert [i["job_id"] for i in items] == ["sv-0000aaaa"]
    assert set(items[0]) == VIDEO_PUBLIC_KEYS
    assert items[0]["audio_url"] is None and items[0]["srt_url"] is None and items[0]["scorm_url"] is None
    assert "document_title" not in items[0] and "voice" not in items[0]


def test_video_anonymous_detail(client, easyauth, video_lib):
    r = client.get("/api/video/library/sv-0000aaaa")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == VIDEO_PUBLIC_KEYS
    assert body["video_url"] and body["audio_url"] is None and body["scorm_url"] is None
    assert client.get("/api/video/library/sv-0000bbbb").status_code == 404


def test_video_admin_sees_everything(client, easyauth, video_lib):
    r = client.get("/api/video/library", headers=easyauth())
    assert {i["job_id"]: i["published"] for i in r.json()} == {"sv-0000aaaa": True, "sv-0000bbbb": False}
    r = client.get("/api/video/library/sv-0000bbbb", headers=easyauth())
    assert r.status_code == 200 and r.json()["audio_url"] and r.json()["published"] is False


def test_video_publish_flow(client, easyauth, video_lib):
    assert client.post("/api/video/library/sv-0000bbbb/publish", json={"published": True}).status_code == 401
    r = client.post("/api/video/library/sv-0000bbbb/publish", json={"published": True}, headers=easyauth())
    assert r.status_code == 200 and r.json()["published"] is True
    assert video_lib.published_calls == [("sv-0000bbbb", True)]
    assert len(client.get("/api/video/library").json()) == 2
    assert client.post("/api/video/library/sv-0000cccc/publish", json={"published": True},
                       headers=easyauth()).status_code == 404


# ---------------------------------------------------------------------------
# Podcast library: the router over the real PodcastLibrary (in-memory blobs)
# ---------------------------------------------------------------------------
class _MemBlob:
    def __init__(self, store: dict, name: str):
        self.store, self.name = store, name
        self.url = f"https://acct.blob.core.windows.net/media/{name}"

    def upload_blob(self, data, overwrite=False, content_settings=None):
        self.store[self.name] = bytes(data)

    def download_blob(self):
        data = self.store[self.name]
        return SimpleNamespace(readall=lambda: data)


class MemBlobService:
    def __init__(self):
        self.store: dict[str, bytes] = {}

    def get_container_client(self, _container):
        return SimpleNamespace(
            list_blobs=lambda name_starts_with="": [SimpleNamespace(name=n) for n in sorted(self.store)
                                                    if n.startswith(name_starts_with)],
            delete_blob=lambda name: self.store.pop(name),
        )

    def get_blob_client(self, container, blob):
        return _MemBlob(self.store, blob)


def _transcript_dict(hosts) -> dict:
    from services.podcast_models import Transcript, TranscriptCue, TranscriptTurn

    return Transcript(
        duration_sec=9.0, hosts=hosts,
        turns=[TranscriptTurn(turn_idx=0, speaker="interviewer", start=0.0, end=4.0),
               TranscriptTurn(turn_idx=1, speaker="expert", start=4.2, end=9.0)],
        cues=[TranscriptCue(start=0.0, end=4.0, speaker="interviewer", turn_idx=0, text="Welcome."),
              TranscriptCue(start=4.2, end=9.0, speaker="expert", turn_idx=1, text="Thanks."),
              TranscriptCue(start=5.0, end=5.4, speaker="interviewer", turn_idx=1, text="Mm-hmm.",
                            kind="reaction")],
        peaks=[0.2, 0.9, 0.4],
    ).model_dump()


def _rendition(tmp_path: Path, name: str, *, video: bool, hosts):
    from services import podcast_media as pm

    out = tmp_path / name
    out.mkdir()
    (out / "audio.mp3").write_bytes(b"ID3 radio mix")
    (out / "audio.srt").write_text("1\n00:00:00,000 --> 00:00:04,000\nAnn: Welcome.\n", encoding="utf-8")
    (out / "transcript.json").write_text(json.dumps(_transcript_dict(hosts)), encoding="utf-8")
    Image.new("RGB", (1400, 1400), "orange").save(out / "cover.jpg", "JPEG")
    (out / "scorm.zip").write_bytes(b"PK scorm")
    files = pm.LibraryFiles(mp3=out / "audio.mp3", audio_srt=out / "audio.srt",
                            transcript=out / "transcript.json", cover=out / "cover.jpg", scorm=out / "scorm.zip")
    if video:
        (out / "final.mp4").write_bytes(b"MP4 video")
        (out / "final.srt").write_text("1\n00:00:02,000 --> 00:00:06,000\nAnn: Welcome.\n", encoding="utf-8")
        files.mp4, files.srt = out / "final.mp4", out / "final.srt"
    return files


@pytest.fixture
def podcast_library(monkeypatch, tmp_path):
    """Real PodcastLibrary with three items: a published video, a published audio-only
    episode and an unpublished video. SAS URLs encode their lifetime (``se=<minutes>m``)."""
    import routers.podcast as pc
    from config import load_config
    from services import podcast_library as pl
    from services.podcast_models import PodcastHost

    lib = pl.PodcastLibrary(load_config())
    lib._initialised = True
    lib._blob = MemBlobService()
    lib._sas = lambda blob, minutes=pl.DEFAULT_SAS_MINUTES: f"https://sas.example/{blob}?se={minutes}m"
    monkeypatch.setattr(pl, "_ffprobe_duration", lambda p: {".mp4": 61.0, ".mp3": 55.5}.get(Path(p).suffix))

    def fake_frame(mp4, out, *, ts):
        Image.new("RGB", (480, 270), "navy").save(out, "JPEG")
        return True

    monkeypatch.setattr(pl, "_extract_thumbnail", fake_frame)
    monkeypatch.setattr(pc, "_get_library", lambda cfg: lib)
    hosts = [PodcastHost(role="interviewer", display_name="Ann", avatar_id="photo_female"),
             PodcastHost(role="expert", display_name="Bob", avatar_id="photo_male")]
    for job, video, published, created in (("job-0000aaaa", True, True, "2026-01-03"),
                                           ("job-0000cccc", False, True, "2026-01-02"),
                                           ("job-0000bbbb", True, False, "2026-01-01")):
        manifest = lib.publish(
            job, _rendition(tmp_path, job, video=video, hosts=hosts),
            title=f"Episode {job[-4:]}", document_title=SECRET_DOC, language="en-US", style="casual",
            speaker_names=["Ann", "Bob"], turn_count=2, created_at=created, audience_level="expert",
            hosts=hosts, audio_kind="radio_mix", listener_mode="idle_loop" if video else None,
        )
        assert manifest is not None
        if published:
            assert lib.set_published(job, True)
    return lib


def _assert_public_shape(body: dict) -> None:
    assert set(body) == PODCAST_PUBLIC_KEYS
    assert all(body[k] is None for k in PODCAST_ALWAYS_NONE)
    assert body["mp4_url"] == body["video_url"] and body["mp3_url"] == body["audio_url"]
    text = json.dumps(body)
    for secret in (SECRET_DOC, "document_title", "audio.srt", "subtitles.srt", "scorm.zip", "se=1440m"):
        assert secret not in text


def test_podcast_anonymous_without_public_audio(client, easyauth, podcast_library):
    r = client.get("/api/podcast/library")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    items = r.json()
    assert [i["job_id"] for i in items] == ["job-0000aaaa"]  # audio-only + unpublished hidden
    item = items[0]
    _assert_public_shape(item)
    assert (item["format"], item["has_video"], item["has_audio"]) == ("video", True, False)
    assert item["thumbnail_url"].endswith("se=15m")
    assert all(item[k] is None for k in PODCAST_AUDIO_KEYS)
    assert item["hosts"] == [] and item["speaker_names"] == []

    r = client.get("/api/podcast/library/job-0000aaaa")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    _assert_public_shape(body)
    assert body["mp4_url"] == "https://sas.example/podcast-library/job-0000aaaa/video.mp4?se=15m"
    assert all(body[k] is None for k in PODCAST_AUDIO_KEYS)
    assert body["hosts"] == [] and body["speaker_names"] == [] and body["has_audio"] is False

    # Audio-only episodes need PODCAST_PUBLIC_AUDIO, even by direct link.
    assert client.get("/api/podcast/library/job-0000cccc").status_code == 404
    assert client.get("/api/podcast/library/job-0000bbbb").status_code == 404


def test_podcast_anonymous_with_public_audio(client, easyauth, podcast_library, monkeypatch):
    from services.podcast_models import Transcript

    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    r = client.get("/api/podcast/library")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    items = {i["job_id"]: i for i in r.json()}
    assert list(items) == ["job-0000aaaa", "job-0000cccc"]
    for item in items.values():
        _assert_public_shape(item)
        assert item["hosts"] == [{"role": "interviewer", "display_name": "Ann", "avatar_id": "photo_female"},
                                 {"role": "expert", "display_name": "Bob", "avatar_id": "photo_male"}]
        assert item["speaker_names"] == ["Ann", "Bob"] and item["has_audio"] is True
    assert (items["job-0000cccc"]["format"], items["job-0000cccc"]["has_video"]) == ("audio", False)

    r = client.get("/api/podcast/library/job-0000cccc")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    _assert_public_shape(body)
    assert body["video_url"] is None and body["has_video"] is False
    assert body["audio_url"] == "https://sas.example/podcast-library/job-0000cccc/audio.mp3?se=15m"
    assert body["cover_url"].endswith("cover.jpg?se=15m") and body["thumbnail_url"].endswith("se=15m")
    assert set(body["transcript"]) == set(Transcript.model_fields)
    assert [c["kind"] for c in body["transcript"]["cues"]] == ["speech", "speech", "reaction"]
    assert body["audio_duration_sec"] == 55.5

    body = client.get("/api/podcast/library/job-0000aaaa").json()
    _assert_public_shape(body)
    assert body["video_url"].endswith("video.mp4?se=15m") and body["audio_url"].endswith("audio.mp3?se=15m")
    assert client.get("/api/podcast/library/job-0000bbbb").status_code == 404


def test_podcast_admin_dtos_carry_every_rendition(client, easyauth, podcast_library):
    from services.podcast_models import LibraryItem, LibrarySummary

    r = client.get("/api/podcast/library", headers=easyauth())
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    items = r.json()
    assert [i["job_id"] for i in items] == ["job-0000aaaa", "job-0000cccc", "job-0000bbbb"]
    assert all(set(i) == set(LibrarySummary.model_fields) for i in items)
    assert [i["published"] for i in items] == [True, True, False]
    assert items[1]["format"] == "audio" and items[1]["has_video"] is False and items[1]["has_audio"] is True

    r = client.get("/api/podcast/library/job-0000cccc", headers=easyauth())
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    assert set(body) == set(LibraryItem.model_fields)
    assert body["document_title"] == SECRET_DOC
    assert body["audio_srt_url"].endswith("audio.srt?se=1440m") and body["scorm_url"].endswith("se=1440m")
    assert body["audio_url"] == body["mp3_url"] and body["mp4_url"] is None and body["srt_url"] is None
    assert body["transcript"]["cues"]


def test_podcast_publish_admin_only(client, easyauth, podcast_library):
    from _helpers import OTHER_OID
    from services.podcast_models import LibraryItem

    assert client.post("/api/podcast/library/job-0000bbbb/publish", json={"published": True},
                       headers=easyauth(oid=OTHER_OID)).status_code == 403
    r = client.post("/api/podcast/library/job-0000bbbb/publish", json={"published": True}, headers=easyauth())
    assert r.status_code == 200 and r.json()["published"] is True
    assert r.headers["cache-control"] == "no-store"
    assert set(r.json()) == set(LibraryItem.model_fields)
    assert [i["job_id"] for i in client.get("/api/podcast/library").json()] == ["job-0000aaaa", "job-0000bbbb"]


class LeakyLibrary:
    """A library that (wrongly) returns everything: the router's allow-list must hold."""
    available = True

    def __init__(self):
        transcript = _transcript_dict([{"role": "interviewer", "display_name": "Ann", "avatar_id": None}])
        transcript["voice"] = SECRET_VOICE
        self.item = {
            "job_id": "job-0000dddd", "title": "Leaky", "created_at": "2026-01-01", "duration_sec": 9.0,
            "language": "en-US", "format": "audio", "has_video": False, "has_audio": True,
            "audio_duration_sec": 9.0, "document_title": SECRET_DOC, "voice": SECRET_VOICE,
            "published": True, "thumbnail_url": "https://blob/thumb?sas", "cover_url": "https://blob/cover?sas",
            "mp3_url": "https://blob/audio?sas", "audio_url": "https://blob/audio?sas",
            "srt_url": "https://blob/srt?sas", "audio_srt_url": "https://blob/asrt?sas",
            "scorm_url": "https://blob/scorm?sas", "script": [{"text": "secret"}], "transcript": transcript,
            "hosts": [{"role": "interviewer", "display_name": "Ann", "avatar_id": None, "voice": SECRET_VOICE},
                      {"role": "bogus"}],
            "speaker_names": ["Ann", 3],
        }

    def list(self, *, published_only: bool = False):
        return [dict(self.item)]

    def get(self, job_id, *, public: bool = False):
        return dict(self.item) if job_id == self.item["job_id"] else None


@pytest.mark.parametrize("public_audio", [False, True])
def test_podcast_public_dto_is_an_allow_list(client, easyauth, monkeypatch, public_audio):
    import routers.podcast as pc

    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true" if public_audio else "false")
    monkeypatch.setattr(pc, "_get_library", lambda cfg: LeakyLibrary())
    for r in (client.get("/api/podcast/library"), client.get("/api/podcast/library/job-0000dddd")):
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
        body = r.json()[0] if isinstance(r.json(), list) else r.json()
        _assert_public_shape(body)
        assert SECRET_VOICE not in r.text and "secret" not in r.text
        if public_audio:
            assert body["audio_url"] == "https://blob/audio?sas" and body["cover_url"] == "https://blob/cover?sas"
            assert body["hosts"] == [{"role": "interviewer", "display_name": "Ann", "avatar_id": None}]
            assert body["speaker_names"] == ["Ann"] and "voice" not in body["transcript"]
        else:
            assert body["has_audio"] is False and body["hosts"] == [] and body["speaker_names"] == []
            assert all(body[k] is None for k in PODCAST_AUDIO_KEYS)


# ---------------------------------------------------------------------------
# Library classes: unpublished hidden, 15-minute SAS, video/thumb only
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("kind", ["video", "podcast"])
def test_library_public_get_uses_short_sas(kind):
    from config import load_config

    if kind == "video":
        from services.video_library import PUBLIC_SAS_MINUTES, VideoLibrary as Lib
        job, video_key, extra = "sv-0123abcd", "video_url", ("audio_url", "srt_url", "scorm_url")
    else:
        from services.podcast_library import PUBLIC_SAS_MINUTES, PodcastLibrary as Lib
        job, video_key, extra = "job-0123abcd", "mp4_url", ("mp3_url", "srt_url", "scorm_url")

    lib = Lib(load_config())
    lib._initialised = True
    lib._blob = object()
    manifest = {"job_id": job, "title": "t", "video_blob": "v", "thumbnail_blob": "t",
                "audio_blob": "a", "subtitle_blob": "s", "scorm_blob": "z"}
    lib._read_json_blob = lambda name: dict(manifest)  # type: ignore[assignment]
    minted: list[tuple[str, int]] = []
    lib._sas = lambda blob, minutes=24 * 60: minted.append((blob, minutes)) or f"sas:{blob}"  # type: ignore[assignment]

    assert lib.get(job, public=True) is None  # published flag absent => false
    manifest["published"] = True
    item = lib.get(job, public=True)
    assert item[video_key] == "sas:v"
    assert all(item[k] is None for k in extra)
    assert {b for b, _ in minted} == {"v", "t"}
    assert all(m == PUBLIC_SAS_MINUTES == 15 for _, m in minted)
    assert lib.get("../" + job, public=True) is None


# ---------------------------------------------------------------------------
# Decks catalog
# ---------------------------------------------------------------------------
class FakeStore:
    cosmos_available = True
    available = False

    def __init__(self):
        slides = [{"index": 0, "title": "Intro", "body": "BODY-TEXT", "notes": "SECRET-NOTES",
                   "image_url": "https://blob/0.png?old-sas"}]
        self.docs = {
            UUID_PUB: {"id": UUID_PUB, "source": "deck", "filename": "Public.pptx", "slide_count": 1,
                       "published": True, "pptx_url": "https://blob/x.pptx", "slides": slides},
            UUID_PRIV: {"id": UUID_PRIV, "source": "deck", "filename": "Private.pptx", "slide_count": 1,
                        "slides": slides},
        }

    def list_decks(self):
        return [{k: v for k, v in d.items() if k != "slides"} for d in self.docs.values()]

    def get_presentation(self, pid):
        return self.docs.get(pid)

    def set_deck_published(self, pid, published):
        d = self.docs.get(pid)
        if not d:
            return None
        d["published"] = published
        return d


@pytest.fixture
def decks_store(monkeypatch):
    import routers.decks as decks

    st = FakeStore()
    monkeypatch.setattr(decks, "_store", lambda cfg: st)
    return st


def test_decks_anonymous_list_only_published(client, easyauth, decks_store):
    decks = client.get("/api/decks").json()
    assert [d["deck_id"] for d in decks] == [UUID_PUB]
    admin = client.get("/api/decks", headers=easyauth()).json()
    assert {d["deck_id"] for d in admin} == {UUID_PUB, UUID_PRIV}


def test_decks_anonymous_detail_has_no_notes_body_or_pptx(client, easyauth, decks_store):
    r = client.get(f"/api/decks/{UUID_PUB}")
    assert r.status_code == 200
    text = r.text
    assert "SECRET-NOTES" not in text and "BODY-TEXT" not in text
    assert "pptx_url" not in r.json() and "old-sas" not in text
    slide = r.json()["slides"][0]
    assert slide["title"] == "Intro" and slide["image_url"] == f"/api/slides/{UUID_PUB}/0.png"
    assert client.get(f"/api/decks/{UUID_PRIV}").status_code == 404
    admin = client.get(f"/api/decks/{UUID_PRIV}", headers=easyauth()).json()
    assert admin["slides"][0]["notes"] == "SECRET-NOTES"


def test_decks_publish(client, easyauth, decks_store):
    assert client.post(f"/api/decks/{UUID_PRIV}/publish", json={"published": True}).status_code == 401
    r = client.post(f"/api/decks/{UUID_PRIV}/publish", json={"published": True}, headers=easyauth())
    assert r.status_code == 200 and r.json()["published"] is True
    assert len(client.get("/api/decks").json()) == 2


# ---------------------------------------------------------------------------
# Legacy /api/presentations — admin only, tolerant of malformed items
# ---------------------------------------------------------------------------
def test_presentations_list_skips_malformed_items(client, app_module, monkeypatch):
    class Store:
        cosmos_available = True
        available = False

        def list_presentations(self):
            return [
                {"id": UUID_PUB, "slide_count": 3},                       # no filename
                {"id": UUID_PRIV, "filename": "deck.pptx", "slide_count": None},
                {"id": "pl_0123456789ab", "title": "a playlist"},         # not a presentation
                {"filename": "orphan.pptx"},                              # no id
            ]

    monkeypatch.setattr(app_module, "store", Store())
    r = client.get("/api/presentations")
    assert r.status_code == 200
    assert r.json() == [
        {"id": UUID_PUB, "filename": UUID_PUB, "slide_count": 3},
        {"id": UUID_PRIV, "filename": "deck.pptx", "slide_count": 0},
    ]
