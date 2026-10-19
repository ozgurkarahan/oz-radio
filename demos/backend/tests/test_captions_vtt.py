"""WebVTT captions of the public library (contracts v1.2 §2.3).

``GET /api/{video,podcast}/library/{job_id}/captions.vtt`` serves the SRT timed on the video rendition as WebVTT,
under the visibility rules of the item route: anonymous callers get published items only, admins any item. The
conversion (``podcast_models.srt_to_vtt``) is pure; the routes run over the real libraries on an in-memory blob
service that fails the way the SDK does.
"""
from __future__ import annotations

import json

import pytest
from azure.core.exceptions import HttpResponseError, ResourceNotFoundError, ServiceRequestError

from config import load_config
from services import demo_protocol as dp
from services.podcast_models import srt_to_vtt

SRT = (
    "1\n00:00:01,000 --> 00:00:03,500\nHello there\n\n"
    "2\n00:00:03,500 --> 00:00:05,000\nSecond line one\nSecond line two\n"
)
VTT = (
    "WEBVTT\n\n"
    "00:00:01.000 --> 00:00:03.500\nHello there\n\n"
    "00:00:03.500 --> 00:00:05.000\nSecond line one\nSecond line two\n"
)


# ---------------------------------------------------------------------------
# SRT -> WebVTT (pure)
# ---------------------------------------------------------------------------
def test_srt_becomes_webvtt_with_header_dot_timestamps_and_no_numeric_ids():
    assert srt_to_vtt(SRT) == VTT


def test_bom_is_stripped_and_crlf_and_cr_become_lf():
    assert srt_to_vtt("\ufeff" + SRT.replace("\n", "\r\n")) == VTT
    assert srt_to_vtt(SRT.replace("\n", "\r")) == VTT
    out = srt_to_vtt("\ufeff" + SRT.replace("\n", "\r\n"))
    assert out.startswith("WEBVTT\n\n") and "\r" not in out and "\ufeff" not in out


def test_cues_without_text_or_duration_are_dropped():
    srt = (
        "1\n00:00:00,000 --> 00:00:01,000\nkept\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\n\n\n"          # empty cue
        "3\n00:00:02,000 --> 00:00:03,000\n   \n\n"        # blank text
        "4\n00:00:03,000 --> 00:00:03,000\nzero length\n\n"
        "5\n00:00:05,000 --> 00:00:04,000\nreversed\n\n"
        "6\n00:00:06,000 --> 00:00:07,000\nalso kept\n"
    )
    assert srt_to_vtt(srt) == (
        "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nkept\n\n00:00:06.000 --> 00:00:07.000\nalso kept\n"
    )


@pytest.mark.parametrize("garbage", ["", "   \n\n", "not an srt at all", "1\n\nonly an index\n\n",
                                     "1\n00:00:01,000 --> 00:00:02,000\n"])
def test_a_document_without_a_usable_cue_has_no_webvtt(garbage):
    assert srt_to_vtt(garbage) is None


@pytest.mark.parametrize("text,expected", [
    ("<script>alert(1)</script>", "&lt;script>alert(1)&lt;/script>"),
    ("<img src=x onerror=alert(1)>", "&lt;img src=x onerror=alert(1)>"),
    ("Tom & Jerry", "Tom &amp; Jerry"),
    ("&lt;already&gt; escaped", "&amp;lt;already&amp;gt; escaped"),
    ("<i>kept</i> <b>kept</b> <u>kept</u>", "<i>kept</i> <b>kept</b> <u>kept</u>"),
    ("<I>case</I> <B>folded</B>", "<i>case</i> <b>folded</b>"),
    ("<font color=red>no</font>", "&lt;font color=red>no&lt;/font>"),
    ("<i onclick=x>no</i>", "&lt;i onclick=x>no</i>"),
    ("<v Bob>voice</v> <c.red>class</c> <ruby>r</ruby>", "&lt;v Bob>voice&lt;/v> &lt;c.red>class&lt;/c> &lt;ruby>r&lt;/ruby>"),
    ("a --> b", "a --&gt; b"),
    ("-->", "--&gt;"),
    ("Économie circulaire — café ☕ 日本語", "Économie circulaire — café ☕ 日本語"),
])
def test_cue_text_is_escaped_except_for_i_b_u(text, expected):
    out = srt_to_vtt(f"1\n00:00:00,000 --> 00:00:01,000\n{text}\n")
    assert out == f"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n{expected}\n"
    body = out.split("\n", 3)[3]
    assert "<script" not in body and "<img" not in body and "<font" not in body  # nothing but i/b/u survives
    assert "-->" not in body


def test_timestamps_are_normalised():
    srt = (
        "1\n00:00:01,5 --> 00:00:02.25\ndots and short fractions\n\n"
        "2\n01:75:00,000 --> 100:00:00,001\nminutes beyond 59 carry into the hours\n\n"
        "3\n00:00:09,000 --> 00:00:10,000 X1:63 X2:223 Y1:10 Y2:20\npositions are dropped\n"
    )
    assert srt_to_vtt(srt) == (
        "WEBVTT\n\n"
        "00:00:01.500 --> 00:00:02.250\ndots and short fractions\n\n"
        "02:15:00.000 --> 100:00:00.001\nminutes beyond 59 carry into the hours\n\n"
        "00:00:09.000 --> 00:00:10.000\npositions are dropped\n"
    )


def test_a_huge_hour_field_is_not_a_timestamp():
    assert srt_to_vtt("1\n" + "9" * 5000 + ":00:00,000 --> 00:00:01,000\ntext\n") is None


def test_a_large_document_converts_every_cue():
    cues = "".join(f"{n}\n00:00:00,000 --> 00:00:01,000\ncue {n} & <b>bold</b>\n\n" for n in range(20_000))
    out = srt_to_vtt(cues)
    assert out.count(" --> ") == 20_000 and out.startswith("WEBVTT\n\n") and "cue 19999 &amp; <b>bold</b>" in out


# ---------------------------------------------------------------------------
# Routes over the real libraries (in-memory blobs)
# ---------------------------------------------------------------------------
class _Stream:
    def __init__(self, data: bytes, *, with_size: bool = True):
        self._data = data
        self.read = False
        if with_size:
            self.size = len(data)

    def readall(self) -> bytes:
        self.read = True
        return self._data


class _BlobClient:
    def __init__(self, svc: "FakeBlobService", name: str):
        self.svc, self.name = svc, name
        self.url = f"https://acct.blob.core.windows.net/media/{name}"

    def download_blob(self):
        self.svc.reads.append(self.name)
        if self.svc.fail_all is not None:
            raise self.svc.fail_all
        if self.name in self.svc.fail:
            raise self.svc.fail[self.name]
        if self.name not in self.svc.store:
            raise ResourceNotFoundError("The specified blob does not exist.")
        stream = _Stream(self.svc.store[self.name], with_size=not self.svc.hide_size)
        self.svc.streams[self.name] = stream
        return stream


class _Container:
    def __init__(self, svc: "FakeBlobService"):
        self.svc = svc

    def list_blobs(self, name_starts_with: str = ""):
        return [type("B", (), {"name": n})() for n in sorted(self.svc.store) if n.startswith(name_starts_with)]


class FakeBlobService:
    """In-memory blob service that fails like the SDK: a missing blob raises ``ResourceNotFoundError``."""

    def __init__(self):
        self.store: dict[str, bytes] = {}
        self.reads: list[str] = []
        self.streams: dict[str, _Stream] = {}
        self.fail: dict[str, Exception] = {}
        self.fail_all: Exception | None = None
        self.hide_size = False

    def get_container_client(self, _container):
        return _Container(self)

    def get_blob_client(self, container, blob):
        return _BlobClient(self, blob)


def podcast_manifest(job: str, **overrides) -> dict:
    prefix = f"podcast-library/{job}"
    manifest = {
        "schema_version": 2, "job_id": job, "title": "Episode", "document_title": "Deck.pptx",
        "created_at": "2026-10-17T10:00:00+00:00", "format": "video", "duration_sec": 60.0, "language": "en-US",
        "style": "casual", "audience_level": "beginner", "speaker_names": ["Ann", "Bob"], "turn_count": 4,
        "audio_kind": "radio_mix", "video_blob": f"{prefix}/video.mp4", "subtitle_blob": f"{prefix}/subtitles.srt",
        "audio_blob": f"{prefix}/audio.mp3", "audio_subtitle_blob": f"{prefix}/audio.srt",
        "thumbnail_blob": f"{prefix}/thumb.jpg", "published": True,
    }
    manifest.update(overrides)
    return manifest


def video_manifest(job: str, **overrides) -> dict:
    prefix = f"videos/{job}"
    manifest = {
        "schema_version": 1, "job_id": job, "title": "Clip", "document_title": "Deck.pptx",
        "created_at": "2026-10-17T10:00:00+00:00", "duration_sec": 60.0, "language": "en-US", "voice": "v",
        "audience_level": "beginner", "slide_count": 3, "video_blob": f"{prefix}/video.mp4",
        "audio_blob": f"{prefix}/audio.mp3", "subtitle_blob": f"{prefix}/subtitles.srt",
        "thumbnail_blob": f"{prefix}/thumb.jpg", "scorm_blob": None, "published": True,
    }
    manifest.update(overrides)
    return manifest


class World:
    def __init__(self, kind: str, lib, svc: FakeBlobService):
        self.kind, self.lib, self.svc = kind, lib, svc
        self.job = "job-0000aaaa" if kind == "podcast" else "sv-0000aaaa"
        self.prefix = f"podcast-library/{self.job}" if kind == "podcast" else f"videos/{self.job}"
        self.make = podcast_manifest if kind == "podcast" else video_manifest

    def url(self, job: str | None = None) -> str:
        return f"/api/{self.kind}/library/{job or self.job}/captions.vtt"

    def item_url(self, job: str | None = None) -> str:
        return f"/api/{self.kind}/library/{job or self.job}"

    def put(self, manifest: dict | None = None, srt: str | bytes | None = SRT, job: str | None = None) -> str:
        job = job or self.job
        manifest = manifest if manifest is not None else self.make(job)
        prefix = f"podcast-library/{job}" if self.kind == "podcast" else f"videos/{job}"
        self.svc.store[f"{prefix}/manifest.json"] = json.dumps(manifest).encode("utf-8")
        if srt is not None:
            self.svc.store[f"{prefix}/subtitles.srt"] = srt.encode("utf-8") if isinstance(srt, str) else srt
        return job


@pytest.fixture(params=["podcast", "video"])
def world(request, monkeypatch) -> World:
    import routers.podcast as pc
    import routers.video as rv
    from services import podcast_library as pl
    from services import video_library as vl

    svc = FakeBlobService()
    if request.param == "podcast":
        lib = pl.PodcastLibrary(load_config())
        monkeypatch.setattr(pc, "_get_library", lambda cfg: lib)
    else:
        lib = vl.VideoLibrary(load_config())
        monkeypatch.setattr(rv, "_get_library", lambda cfg: lib)
    lib._initialised = True
    lib._blob = svc
    lib._sas = lambda blob, lifetime=0: f"https://sas.example/{blob}"  # type: ignore[assignment]
    return World(request.param, lib, svc)


def test_a_visitor_gets_webvtt_of_a_published_item(client, easyauth, world):
    world.put()
    r = client.get(world.url())
    assert r.status_code == 200
    assert r.headers["content-type"] == dp.CAPTIONS_VTT_MEDIA_TYPE == "text/vtt; charset=utf-8"
    assert r.headers["cache-control"] == dp.CAPTIONS_VTT_CACHE_CONTROL == "public, max-age=600"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.content.decode("utf-8") == VTT
    assert world.svc.reads == [f"{world.prefix}/manifest.json", f"{world.prefix}/subtitles.srt"]


def test_the_webvtt_is_utf8_and_hostile_cue_text_cannot_inject_markup(client, easyauth, world):
    world.put(srt="\ufeff1\r\n00:00:00,000 --> 00:00:02,000\r\nÉconomie circulaire ☕ <script>alert(1)</script> & </i>\r\n")
    r = client.get(world.url())
    assert r.status_code == 200
    body = r.content.decode("utf-8")
    assert "Économie circulaire ☕ &lt;script>alert(1)&lt;/script> &amp; </i>" in body
    assert "<script" not in body


def test_unpublished_items_are_invisible_to_visitors_and_readable_by_admins_uncached(client, easyauth, world):
    world.put(world.make(world.job, published=False))
    r = client.get(world.url())
    assert r.status_code == 404 and r.json() == {"detail": "Library item not found"}
    assert r.headers["cache-control"] == "no-store"
    assert world.svc.reads == [f"{world.prefix}/manifest.json"]  # the subtitles of a hidden item are never read

    r = client.get(world.url(), headers=easyauth())
    assert r.status_code == 200 and r.content.decode("utf-8") == VTT
    assert r.headers["cache-control"] == "no-store"  # an unpublished item must not sit in a browser cache


def test_an_admin_reading_a_published_item_gets_the_cacheable_answer(client, easyauth, world):
    world.put()
    r = client.get(world.url(), headers=easyauth())
    assert r.status_code == 200 and r.headers["cache-control"] == "public, max-age=600"


def test_ids_are_validated_and_unknown_items_are_404(client, easyauth, world):
    world.put()
    other = "job-0000ffff" if world.kind == "podcast" else "sv-0000ffff"
    for job in ("nope", "..", "job-1", "sv-1", other.upper(), f"{other}%2F..", "job-0000AAAA", "sv-0000AAAA"):
        r = client.get(world.url(job))
        assert r.status_code == 404, job
    r = client.get(world.url(other))
    assert r.status_code == 404 and r.json() == {"detail": "Library item not found"}
    assert r.headers["cache-control"] == "no-store"


def test_an_item_without_captions_answers_404_captions_not_available(client, easyauth, world):
    world.put(world.make(world.job, subtitle_blob=None), srt=None)
    r = client.get(world.url())
    assert r.status_code == 404 and r.json() == {"detail": "Captions not available"}
    assert r.headers["cache-control"] == "no-store"


def test_a_subtitle_blob_that_is_gone_answers_404_captions_not_available(client, easyauth, world):
    world.put(srt=None)  # the manifest names a subtitle blob that no longer exists
    r = client.get(world.url())
    assert r.status_code == 404 and r.json() == {"detail": "Captions not available"}


def test_a_document_without_cues_answers_404_captions_not_available(client, easyauth, world):
    world.put(srt="1\n00:00:00,000 --> 00:00:01,000\n\n")
    r = client.get(world.url())
    assert r.status_code == 404 and r.json() == {"detail": "Captions not available"}


def test_a_source_over_512_kib_is_unavailable(client, easyauth, world):
    cap = dp.CAPTIONS_VTT_MAX_SOURCE_BYTES
    assert cap == 512 * 1024

    def srt_of(size: int) -> bytes:
        head = b"1\n00:00:00,000 --> 00:00:01,000\n"
        return head + b"x" * (size - len(head))

    world.put(srt=srt_of(cap))
    assert client.get(world.url()).status_code == 200  # exactly the cap is fine

    world.put(srt=srt_of(cap + 1))
    r = client.get(world.url())
    assert r.status_code == 404 and r.json() == {"detail": "Captions not available"}
    assert world.svc.streams[f"{world.prefix}/subtitles.srt"].read is False  # refused from the blob's size alone


def test_the_size_cap_also_holds_when_the_service_reports_no_size(client, easyauth, world):
    cap = dp.CAPTIONS_VTT_MAX_SOURCE_BYTES
    world.svc.hide_size = True
    world.put(srt=b"1\n00:00:00,000 --> 00:00:01,000\n" + b"x" * cap)
    r = client.get(world.url())
    assert r.status_code == 404 and r.json() == {"detail": "Captions not available"}


def test_only_the_items_own_subtitles_are_ever_read(client, easyauth, world):
    """A manifest that points elsewhere (corrupt or hostile) cannot turn the route into a blob reader."""
    secret = "other-container/secret.srt" if world.kind == "video" else "podcast-library/job-0000bbbb/audio.srt"
    world.svc.store[secret] = SRT.encode("utf-8")
    for blob in (secret, "../secret.srt", f"{world.prefix}/../job-0000bbbb/subtitles.srt", f"{world.prefix}/x.srt", 7):
        world.put(world.make(world.job, subtitle_blob=blob))
        r = client.get(world.url())
        assert r.status_code == 404 and r.json() == {"detail": "Captions not available"}, blob
    assert secret not in world.svc.reads and "../secret.srt" not in world.svc.reads


def test_a_storage_failure_is_503_never_404_or_empty_captions(client, easyauth, world):
    world.put()
    world.svc.fail_all = ServiceRequestError("connection reset")
    r = client.get(world.url())
    assert r.status_code == 503 and r.json() == {"detail": dp.LIBRARY_UNAVAILABLE_DETAIL}
    assert r.headers["cache-control"] == "no-store"
    assert client.get(world.url(), headers=easyauth()).status_code == 503


def test_a_failing_subtitle_read_is_503_even_when_the_manifest_reads(client, easyauth, world):
    world.put()
    world.svc.fail[f"{world.prefix}/subtitles.srt"] = HttpResponseError("403 AuthorizationPermissionMismatch")
    r = client.get(world.url())
    assert r.status_code == 503 and r.json() == {"detail": dp.LIBRARY_UNAVAILABLE_DETAIL}
    assert r.headers["cache-control"] == "no-store"


def test_storage_that_never_connected_is_503(client, easyauth, world):
    world.lib._blob = None  # initialised, but no client: storage is down
    r = client.get(world.url())
    assert r.status_code == 503 and r.json() == {"detail": dp.LIBRARY_UNAVAILABLE_DETAIL}
    assert r.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# Podcast specifics: only the video rendition has captions
# ---------------------------------------------------------------------------
@pytest.fixture
def podcasts(monkeypatch):
    import routers.podcast as pc
    from services import podcast_library as pl

    svc = FakeBlobService()
    lib = pl.PodcastLibrary(load_config())
    lib._initialised = True
    lib._blob = svc
    lib._sas = lambda blob, lifetime=0: f"https://sas.example/{blob}"  # type: ignore[assignment]
    monkeypatch.setattr(pc, "_get_library", lambda cfg: lib)
    return svc


def _audio_only(job: str, **overrides) -> dict:
    prefix = f"podcast-library/{job}"
    manifest = podcast_manifest(job, format="audio", video_blob=None, subtitle_blob=None)
    manifest["audio_subtitle_blob"] = f"{prefix}/audio.srt"
    manifest.update(overrides)
    return manifest


@pytest.mark.parametrize("public_audio", ["false", "true"])
def test_an_audio_only_episode_has_no_captions(client, easyauth, podcasts, monkeypatch, public_audio):
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", public_audio)
    job = "job-0000cccc"
    podcasts.store[f"podcast-library/{job}/manifest.json"] = json.dumps(_audio_only(job)).encode()
    podcasts.store[f"podcast-library/{job}/audio.srt"] = SRT.encode()
    r = client.get(f"/api/podcast/library/{job}/captions.vtt")
    assert r.status_code == 404
    # Hidden altogether without public audio (like its item route); with it, visible but without captions.
    assert r.json() == {"detail": "Library item not found" if public_audio == "false" else "Captions not available"}
    assert f"podcast-library/{job}/audio.srt" not in podcasts.reads  # the radio captions are not served here
    assert client.get(f"/api/podcast/library/{job}/captions.vtt", headers=easyauth()).status_code == 404


def test_even_an_audio_only_item_that_names_a_video_subtitle_blob_has_no_captions(client, easyauth, podcasts):
    job = "job-0000cccc"
    manifest = _audio_only(job, subtitle_blob=f"podcast-library/{job}/subtitles.srt")
    podcasts.store[f"podcast-library/{job}/manifest.json"] = json.dumps(manifest).encode()
    podcasts.store[f"podcast-library/{job}/subtitles.srt"] = SRT.encode()
    for headers in ({}, easyauth()):
        r = client.get(f"/api/podcast/library/{job}/captions.vtt", headers=headers)
        assert r.status_code == 404 and r.json()["detail"] in ("Captions not available", "Library item not found")


def test_a_legacy_v1_podcast_manifest_has_captions(client, easyauth, podcasts):
    job = "job-0000dddd"
    prefix = f"podcast-library/{job}"
    v1 = {"schema_version": 1, "job_id": job, "title": "Old", "created_at": "2026-01-01T00:00:00+00:00",
          "duration_sec": 42.5, "language": "fr-FR", "style": "casual", "speaker_names": ["Ann", "Bob"],
          "turn_count": 4, "video_blob": f"{prefix}/video.mp4", "audio_blob": f"{prefix}/audio.mp3",
          "subtitle_blob": f"{prefix}/subtitles.srt", "thumbnail_blob": f"{prefix}/thumb.jpg", "published": True}
    podcasts.store[f"{prefix}/manifest.json"] = json.dumps(v1).encode()
    podcasts.store[f"{prefix}/subtitles.srt"] = SRT.encode()
    r = client.get(f"/api/podcast/library/{job}/captions.vtt")
    assert r.status_code == 200 and r.content.decode() == VTT


# ---------------------------------------------------------------------------
# Default deny: the captions routes are public by design — and nothing else was added
# ---------------------------------------------------------------------------
def test_the_public_routers_expose_exactly_the_documented_get_routes():
    import routers.decks as dk
    import routers.podcast as pc
    import routers.video as rv

    def public(router):
        return sorted((route.path, tuple(sorted(route.methods))) for route in router.routes)

    assert public(pc.public_router) == [
        ("/api/podcast/library", ("GET",)),
        ("/api/podcast/library/{job_id}", ("GET",)),
        ("/api/podcast/library/{job_id}/captions.vtt", ("GET",)),
    ]
    assert public(rv.public_router) == [
        ("/api/video/library", ("GET",)),
        ("/api/video/library/{job_id}", ("GET",)),
        ("/api/video/library/{job_id}/captions.vtt", ("GET",)),
    ]
    assert public(dk.public_router) == [("/api/decks", ("GET",)), ("/api/decks/{deck_id}", ("GET",))]
    for router in (pc.router, rv.router, dk.router):
        assert not any(route.path.endswith("captions.vtt") for route in router.routes)
