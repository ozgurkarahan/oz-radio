"""Podcast library v2: radio renditions, raw vs normalized manifests, public audio flag."""
from __future__ import annotations

import dataclasses
import io
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from config import load_config
from services import podcast_library as pl
from services import podcast_media as pm
from services.podcast_models import (
    LibraryItem,
    LibrarySummary,
    PodcastHost,
    Transcript,
    TranscriptCue,
    TranscriptTurn,
)

JOB = "job-0123abcd"
PREFIX = f"podcast-library/{JOB}"
MANIFEST = f"{PREFIX}/manifest.json"
PUBLIC = pl.PUBLIC_SAS_MINUTES
SECRET_VOICE = "en-US-Sentinel:DragonHDLatestNeural"
SECRET_CHARACTER = "SentinelCharacterZ9"

HOSTS = [PodcastHost(role="interviewer", display_name="Ann", avatar_id="photo_female"),
         PodcastHost(role="expert", display_name="Bob", avatar_id="photo_male")]
HOST_DICTS = [h.model_dump() for h in HOSTS]
NAME_HOSTS = [{"role": "interviewer", "display_name": "Ann", "avatar_id": None},
              {"role": "expert", "display_name": "Bob", "avatar_id": None}]

V2_MANIFEST_KEYS = {
    "schema_version", "job_id", "title", "document_title", "created_at", "format", "has_video", "has_audio",
    "duration_sec", "audio_duration_sec", "video_duration_sec", "language", "style", "audience_level",
    "speaker_names", "hosts", "turn_count", "audio_kind", "listener_mode", "video_blob", "subtitle_blob",
    "audio_blob", "audio_subtitle_blob", "transcript_blob", "cover_blob", "thumbnail_blob", "scorm_blob",
    "published",
}
CONTENT_TYPES = {
    "thumb.jpg": "image/jpeg", "cover.jpg": "image/jpeg", "transcript.json": "application/json",
    "audio.srt": "application/x-subrip", "audio.mp3": "audio/mpeg", "video.mp4": "video/mp4",
    "subtitles.srt": "application/x-subrip", "scorm.zip": "application/zip", "manifest.json": "application/json",
}
URL_KEYS = ("mp4_url", "mp3_url", "audio_url", "srt_url", "audio_srt_url", "thumbnail_url", "cover_url",
            "scorm_url")

RADIO_SRT = ("1\n00:00:00,000 --> 00:00:04,000\nAnn: Welcome.\n\n"
             "2\n00:00:04,200 --> 00:00:09,000\nBob: Thanks.\n")
# v1 captions: "Name: text" cues timed on the video (= its ripped soundtrack MP3).
V1_SRT = (
    "1\n00:00:02,000 --> 00:00:04,500\nAnn: Welcome to the show.\n\n"
    "2\n00:00:04,500 --> 00:00:06,250\nAnn: Today: circular economy.\n\n"
    "3\n00:00:06,400 --> 00:00:09,000\nBob: Thanks, Ann.\n\n"
    "4\n00:00:09,000 --> 00:00:10,000\nGuest Speaker: Unknown voice.\n\n"
    "5\n00:00:10,100 --> 00:00:12,000\nAnn: Back to you.\n\n"
    "6\n00:00:12,000 --> 00:00:13,500\nBob: Two\nlines.\n"
)


# ---------------------------------------------------------------------------
# Fake blob storage (real _upload/_read_*; only SAS minting is faked)
# ---------------------------------------------------------------------------
class _BlobClient:
    def __init__(self, svc: "FakeBlobService", name: str):
        self.svc, self.name = svc, name
        self.url = f"https://acct.blob.core.windows.net/media/{name}"

    def upload_blob(self, data, overwrite=False, content_settings=None):
        assert overwrite is True
        self.svc.store[self.name] = bytes(data)
        self.svc.content_types[self.name] = content_settings.content_type
        self.svc.uploads.append(self.name)

    def download_blob(self):
        if self.name not in self.svc.store:
            raise FileNotFoundError(self.name)
        data = self.svc.store[self.name]
        return SimpleNamespace(readall=lambda: data)


class _Container:
    def __init__(self, svc: "FakeBlobService"):
        self.svc = svc

    def list_blobs(self, name_starts_with: str = ""):
        self.svc.listed.append(name_starts_with)
        return [SimpleNamespace(name=n) for n in sorted(self.svc.store) if n.startswith(name_starts_with)]

    def delete_blob(self, name: str):
        del self.svc.store[name]


class FakeBlobService:
    def __init__(self):
        self.store: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        self.uploads: list[str] = []
        self.listed: list[str] = []
        self.minted: list[tuple] = []

    def get_container_client(self, _container):
        return _Container(self)

    def get_blob_client(self, container, blob):
        return _BlobClient(self, blob)


@pytest.fixture
def svc() -> FakeBlobService:
    return FakeBlobService()


@pytest.fixture
def lib(svc):
    library = pl.PodcastLibrary(load_config())
    library._initialised = True
    library._blob = svc

    def fake_sas(blob, minutes=pl.DEFAULT_SAS_MINUTES):
        svc.minted.append((blob, minutes))
        return f"https://sas.example/{blob}?se={minutes}m"

    library._sas = fake_sas  # type: ignore[assignment]
    return library


@pytest.fixture
def probes(monkeypatch):
    """Deterministic ffprobe/ffmpeg: 61 s video, 55.5 s MP3, a 480x270 video frame."""
    calls: list[float] = []
    monkeypatch.setattr(pl, "_ffprobe_duration", lambda path: {".mp4": 61.0, ".mp3": 55.5}.get(Path(path).suffix))

    def fake_frame(mp4, out, *, ts):
        calls.append(ts)
        _jpeg(out, (480, 270), "navy")
        return True

    monkeypatch.setattr(pl, "_extract_thumbnail", fake_frame)
    return calls


def _jpeg(path: Path, size: tuple[int, int], color: str = "orange") -> Path:
    Image.new("RGB", size, color).save(path, "JPEG")
    return path


def _transcript() -> dict:
    return Transcript(
        duration_sec=54.75,
        hosts=HOSTS,
        turns=[TranscriptTurn(turn_idx=0, speaker="interviewer", start=0.0, end=4.0, video_start=2.0, video_end=6.5),
               TranscriptTurn(turn_idx=1, speaker="expert", start=4.2, end=9.0, video_start=6.7, video_end=12.0)],
        cues=[TranscriptCue(start=0.0, end=4.0, speaker="interviewer", turn_idx=0, text="Welcome."),
              TranscriptCue(start=4.2, end=9.0, speaker="expert", turn_idx=1, text="Thanks."),
              TranscriptCue(start=6.0, end=6.4, speaker="interviewer", turn_idx=1, text="Mm-hmm.",
                            kind="reaction")],
        peaks=[0.1, 0.8, 0.3],
    ).model_dump()


def _render_outputs(tmp_path: Path, *, name: str = "out", video: bool = True, scorm: bool = True,
                    transcript: dict | None = None) -> pm.LibraryFiles:
    out = tmp_path / name
    out.mkdir()
    (out / "audio.mp3").write_bytes(b"ID3 radio mix")
    (out / "audio.srt").write_bytes(RADIO_SRT.encode("utf-8"))
    (out / "transcript.json").write_bytes(json.dumps(transcript or _transcript()).encode("utf-8"))
    _jpeg(out / "cover.jpg", (1400, 1400))
    files = pm.LibraryFiles(mp3=out / "audio.mp3", audio_srt=out / "audio.srt",
                            transcript=out / "transcript.json", cover=out / "cover.jpg")
    if video:
        (out / "final.mp4").write_bytes(b"MP4 video")
        (out / "final.srt").write_bytes(V1_SRT.encode("utf-8"))
        files = dataclasses.replace(files, mp4=out / "final.mp4", srt=out / "final.srt")
    if scorm:
        (out / "scorm.zip").write_bytes(b"PK scorm")
        files = dataclasses.replace(files, scorm=out / "scorm.zip")
    return files


def _publish(lib, files, *, job: str = JOB, **overrides):
    kwargs = dict(title="Radio days", document_title="Deck.pptx", language="en-US", style="casual",
                  speaker_names=["Ann", "Bob"], turn_count=2, created_at="2026-10-17T10:00:00+00:00",
                  audience_level="expert", hosts=HOSTS, audio_kind="radio_mix", listener_mode="idle_loop")
    kwargs.update(overrides)
    return lib.publish(job, files, **kwargs)


def _v1(job: str = JOB, **overrides) -> dict:
    prefix = f"podcast-library/{job}"
    manifest = {
        "schema_version": 1, "job_id": job, "title": "Économie circulaire · Expert", "document_title": "Deck",
        "created_at": "2026-01-01T00:00:00+00:00", "duration_sec": 42.5, "language": "fr-FR", "style": "casual",
        "audience_level": "guru", "speaker_names": ["Ann", "Bob"], "turn_count": 4,
        "video_blob": f"{prefix}/video.mp4", "audio_blob": f"{prefix}/audio.mp3",
        "subtitle_blob": f"{prefix}/subtitles.srt", "thumbnail_blob": f"{prefix}/thumb.jpg",
        "scorm_blob": None, "published": True,
    }
    manifest.update(overrides)
    return manifest


def _seed_v1(svc: FakeBlobService, job: str = JOB, **overrides) -> dict:
    """A v1 manifest exactly as the v1 publisher serialized it, plus its video SRT."""
    manifest = _v1(job, **overrides)
    svc.store[f"podcast-library/{job}/manifest.json"] = json.dumps(manifest, indent=2).encode("utf-8")
    svc.store[f"podcast-library/{job}/subtitles.srt"] = V1_SRT.encode("utf-8")
    return manifest


def _populated(item: dict) -> set[str]:
    assert all(k in item for k in URL_KEYS)
    return {k for k in URL_KEYS if item[k]}


# ---------------------------------------------------------------------------
# Publish
# ---------------------------------------------------------------------------
def test_publish_video_uploads_every_rendition_and_writes_the_v2_manifest_last(lib, svc, probes, tmp_path):
    files = _render_outputs(tmp_path)
    manifest = _publish(lib, files)

    assert manifest is not None
    assert svc.uploads[-1] == MANIFEST
    assert set(svc.uploads) == {f"{PREFIX}/{n}" for n in CONTENT_TYPES}
    assert svc.content_types == {f"{PREFIX}/{n}": ct for n, ct in CONTENT_TYPES.items()}
    stored = json.loads(svc.store[MANIFEST])
    assert stored == manifest and set(stored) == V2_MANIFEST_KEYS
    assert stored["schema_version"] == pl.SCHEMA_VERSION == 2
    assert (stored["format"], stored["has_video"], stored["has_audio"]) == ("video", True, True)
    assert (stored["audio_kind"], stored["listener_mode"], stored["published"]) == ("radio_mix", "idle_loop", False)
    # duration_sec is the primary (video) rendition's; both renditions are probed.
    assert (stored["duration_sec"], stored["video_duration_sec"], stored["audio_duration_sec"]) == (61.0, 61.0, 55.5)
    assert {k: stored[k] for k in pl.BLOB_KEYS} == {
        "video_blob": f"{PREFIX}/video.mp4", "subtitle_blob": f"{PREFIX}/subtitles.srt",
        "audio_blob": f"{PREFIX}/audio.mp3", "audio_subtitle_blob": f"{PREFIX}/audio.srt",
        "transcript_blob": f"{PREFIX}/transcript.json", "cover_blob": f"{PREFIX}/cover.jpg",
        "thumbnail_blob": f"{PREFIX}/thumb.jpg", "scorm_blob": f"{PREFIX}/scorm.zip",
    }
    assert stored["hosts"] == HOST_DICTS and stored["speaker_names"] == ["Ann", "Bob"]
    assert stored["audience_level"] == "expert"
    assert svc.store[f"{PREFIX}/video.mp4"] == b"MP4 video" and svc.store[f"{PREFIX}/audio.mp3"] == b"ID3 radio mix"
    assert svc.store[f"{PREFIX}/subtitles.srt"].decode() == V1_SRT
    assert svc.store[f"{PREFIX}/audio.srt"].decode() == RADIO_SRT
    assert json.loads(svc.store[f"{PREFIX}/transcript.json"]) == _transcript()
    assert len(probes) == 1  # the thumbnail is a video frame
    assert not (files.mp4.parent / f"{JOB}-thumb.jpg").exists()  # temp thumbnail removed


def test_publish_audio_only_skips_video_assets_and_thumbnails_the_cover(lib, svc, probes, monkeypatch, tmp_path):
    monkeypatch.setattr(pl, "_extract_thumbnail", lambda *a, **k: pytest.fail("no video frame to grab"))
    files = _render_outputs(tmp_path, video=False, scorm=False)
    assert files.format == "audio"
    manifest = _publish(lib, files, listener_mode="idle_loop")

    assert set(svc.uploads) == {f"{PREFIX}/{n}" for n in
                                ("thumb.jpg", "cover.jpg", "transcript.json", "audio.srt", "audio.mp3",
                                 "manifest.json")}
    assert svc.uploads[-1] == MANIFEST
    assert set(manifest) == V2_MANIFEST_KEYS
    assert (manifest["format"], manifest["has_video"], manifest["has_audio"]) == ("audio", False, True)
    assert manifest["video_blob"] is manifest["subtitle_blob"] is manifest["scorm_blob"] is None
    assert (manifest["duration_sec"], manifest["audio_duration_sec"], manifest["video_duration_sec"]) == (
        55.5, 55.5, None)
    assert manifest["listener_mode"] is None  # no video, no listener rendering
    assert manifest["thumbnail_blob"] == f"{PREFIX}/thumb.jpg"
    with Image.open(io.BytesIO(svc.store[f"{PREFIX}/thumb.jpg"])) as thumb:
        assert (thumb.format, thumb.size) == ("JPEG", (480, 480))


def test_publish_without_probes_takes_the_audio_duration_from_the_transcript(lib, svc, monkeypatch, tmp_path):
    monkeypatch.setattr(pl, "_ffprobe_duration", lambda path: None)
    manifest = _publish(lib, _render_outputs(tmp_path, video=False, scorm=False))
    assert manifest["duration_sec"] == manifest["audio_duration_sec"] == 54.75


def test_publish_defaults_hosts_to_the_transcript_then_to_speaker_names(lib, svc, probes, tmp_path):
    assert _publish(lib, _render_outputs(tmp_path, name="a"), hosts=None)["hosts"] == HOST_DICTS
    files = _render_outputs(tmp_path, name="b", transcript={**_transcript(), "hosts": []})
    assert _publish(lib, files, hosts=None)["hosts"] == NAME_HOSTS


def test_publish_accepts_legacy_library_files_as_a_soundtrack_video(lib, svc, probes, tmp_path):
    for name in ("final.mp4", "final.mp3", "final.srt"):
        (tmp_path / name).write_bytes(b"x")
    legacy = pl.LibraryFiles(mp4=tmp_path / "final.mp4", mp3=tmp_path / "final.mp3", srt=tmp_path / "final.srt")
    assert (legacy.format, legacy.has_video, legacy.scorm, legacy.cover) == ("video", True, None, None)
    manifest = lib.publish(JOB, legacy, title="t", document_title="d", language="en-US", style="casual",
                           speaker_names=["Ann", "Bob"], turn_count=2, created_at="2026-01-01")

    assert set(manifest) == V2_MANIFEST_KEYS and manifest["schema_version"] == 2
    assert (manifest["format"], manifest["has_video"], manifest["has_audio"]) == ("video", True, True)
    assert manifest["audio_kind"] == "soundtrack"  # no radio-timed assets: the MP3 is the soundtrack
    assert manifest["transcript_blob"] is manifest["cover_blob"] is manifest["audio_subtitle_blob"] is None
    assert manifest["hosts"] == NAME_HOSTS and manifest["listener_mode"] is None
    assert set(svc.uploads) == {f"{PREFIX}/{n}" for n in
                                ("thumb.jpg", "audio.mp3", "video.mp4", "subtitles.srt", "manifest.json")}
    assert svc.uploads[-1] == MANIFEST


def test_publish_never_stores_voices_character_names_or_urls(lib, svc, probes, tmp_path):
    leaky = _transcript()
    leaky["voice"] = SECRET_VOICE
    leaky["hosts"][0].update(voice=SECRET_VOICE, character=SECRET_CHARACTER)
    hosts = [{**HOST_DICTS[0], "voice": SECRET_VOICE, "character": SECRET_CHARACTER},
             {**HOST_DICTS[1], "voice": SECRET_VOICE}]
    manifest = _publish(lib, _render_outputs(tmp_path, transcript=leaky), hosts=hosts)

    assert manifest["hosts"] == HOST_DICTS
    assert json.loads(svc.store[f"{PREFIX}/transcript.json"]) == _transcript()
    for name in (MANIFEST, f"{PREFIX}/transcript.json"):
        text = svc.store[name].decode("utf-8")
        assert SECRET_VOICE not in text and SECRET_CHARACTER not in text and "DragonHD" not in text
        assert "https://" not in text and "?se=" not in text
    assert not any(SECRET_CHARACTER in n or "DragonHD" in n for n in svc.store)


def test_publish_survives_thumbnail_failures(lib, svc, probes, monkeypatch, tmp_path):
    def boom(*_a, **_k):
        raise RuntimeError("ffmpeg exploded")

    monkeypatch.setattr(pl, "_extract_thumbnail", boom)
    files = _render_outputs(tmp_path)
    files.cover.write_bytes(b"not an image")  # the cover fallback fails too
    manifest = _publish(lib, files)
    assert manifest is not None and manifest["thumbnail_blob"] is None
    assert f"{PREFIX}/thumb.jpg" not in svc.store and svc.uploads[-1] == MANIFEST
    assert manifest["cover_blob"] == f"{PREFIX}/cover.jpg"


def test_publish_skips_an_invalid_transcript_and_get_falls_back_to_the_radio_srt(lib, svc, probes, tmp_path):
    files = _render_outputs(tmp_path)
    files.transcript.write_text("{not json", encoding="utf-8")
    manifest = _publish(lib, files)
    assert manifest["transcript_blob"] is None and manifest["audio_kind"] == "radio_mix"
    assert f"{PREFIX}/transcript.json" not in svc.store

    transcript = lib.get(JOB)["transcript"]
    assert [(c["speaker"], c["start"], c["end"], c["text"]) for c in transcript["cues"]] == [
        ("interviewer", 0.0, 4.0, "Welcome."), ("expert", 4.2, 9.0, "Thanks.")]
    # Radio timeline: the video positions of a radio mix are unknown here.
    assert all(t["video_start"] is None for t in transcript["turns"])
    assert transcript["duration_sec"] == 55.5


def test_publish_fails_cleanly_without_a_media_rendition(lib, svc, probes, tmp_path):
    files = _render_outputs(tmp_path)
    files.mp4.unlink()
    assert _publish(lib, files) is None
    assert MANIFEST not in svc.store
    assert _publish(lib, dataclasses.replace(files, mp4=None, mp3=None)) is None
    assert _publish(lib, _render_outputs(tmp_path, name="ok"), job="job-../x") is None
    assert MANIFEST not in svc.store


# ---------------------------------------------------------------------------
# Raw vs normalized manifests
# ---------------------------------------------------------------------------
def test_normalize_manifest_reads_v1_as_a_soundtrack_video_without_mutating_it():
    raw = _v1()
    snapshot = json.dumps(raw)
    m = pl.normalize_manifest(raw)

    assert json.dumps(raw) == snapshot
    assert (m["format"], m["has_video"], m["has_audio"], m["audio_kind"]) == ("video", True, True, "soundtrack")
    assert m["hosts"] == NAME_HOSTS
    assert (m["duration_sec"], m["audio_duration_sec"], m["video_duration_sec"]) == (42.5, 42.5, 42.5)
    assert m["audience_level"] is None and m["published"] is True and m["listener_mode"] is None
    assert m["audio_subtitle_blob"] is m["transcript_blob"] is m["cover_blob"] is None
    summary = LibrarySummary.model_validate(m)
    assert (summary.format, summary.has_audio, summary.hosts[1].role) == ("video", True, "expert")


def test_normalize_manifest_is_the_identity_on_v2_manifests(lib, svc, probes, tmp_path):
    stored = json.loads(json.dumps(_publish(lib, _render_outputs(tmp_path))))
    m = pl.normalize_manifest(stored)
    assert {k: m[k] for k in stored} == stored


def test_normalize_manifest_falls_back_on_unknown_values():
    m = pl.normalize_manifest({
        "job_id": JOB, "format": "podcast", "audio_kind": "dolby", "speaker_names": "Ann",
        "hosts": [{"role": "host", "display_name": "X"}, "junk", {"role": "expert", "display_name": "  "}],
        "turn_count": True, "duration_sec": -3, "listener_mode": "dance", "video_blob": "",
        "audio_blob": 7, "published": "yes",
    })
    assert (m["format"], m["audio_kind"], m["hosts"], m["speaker_names"]) == ("video", "soundtrack", [], [])
    assert (m["turn_count"], m["duration_sec"], m["listener_mode"], m["published"]) == (0, None, None, False)
    assert (m["has_video"], m["has_audio"], m["video_blob"], m["audio_blob"]) == (False, False, None, None)
    assert m["audio_duration_sec"] is m["video_duration_sec"] is None


def test_writers_change_only_their_key_of_a_raw_v1_manifest(lib, svc):
    v1 = _seed_v1(svc, published=False)

    item = lib.set_published(JOB, True)
    assert item["published"] is True and item["format"] == "video" and item["transcript"]  # reader view
    assert svc.store[MANIFEST] == json.dumps({**v1, "published": True}, indent=2).encode("utf-8")

    lib.set_title(JOB, "  New title  ")
    assert svc.store[MANIFEST] == json.dumps({**v1, "published": True, "title": "New title"},
                                             indent=2).encode("utf-8")
    stored = json.loads(svc.store[MANIFEST])
    assert stored["audience_level"] == "guru"  # reader normalization is never persisted
    assert not {"format", "has_video", "has_audio", "hosts", "audio_kind", "transcript"} & set(stored)
    assert not any(k.endswith("_url") for k in stored) and b"sas.example" not in svc.store[MANIFEST]


def test_writers_keep_a_v2_manifest_identical_but_for_their_key(lib, svc, probes, tmp_path):
    before = json.loads(json.dumps(_publish(lib, _render_outputs(tmp_path))))
    lib.set_published(JOB, True)
    assert svc.store[MANIFEST] == json.dumps({**before, "published": True}, indent=2).encode("utf-8")
    lib.set_title(JOB, "Renamed", document_title="Doc")
    assert json.loads(svc.store[MANIFEST]) == {**before, "published": True, "title": "Renamed",
                                               "document_title": "Doc"}


def test_writers_reject_missing_items_and_failed_writes(lib, svc, monkeypatch):
    assert lib.set_published("job-deadbeef", True) is None and lib.set_title("job-deadbeef", "x") is None
    assert svc.uploads == []
    _seed_v1(svc)
    monkeypatch.setattr(lib, "_upload", lambda *a, **k: (_ for _ in ()).throw(OSError("blob down")))
    assert lib.set_published(JOB, False) is None


# ---------------------------------------------------------------------------
# Admin get + transcripts
# ---------------------------------------------------------------------------
def test_admin_get_signs_every_rendition_and_inlines_the_transcript(lib, svc, probes, tmp_path):
    _publish(lib, _render_outputs(tmp_path))
    svc.minted.clear()
    item = lib.get(JOB)

    assert _populated(item) == set(URL_KEYS)
    assert item["audio_url"] == item["mp3_url"] == f"https://sas.example/{PREFIX}/audio.mp3?se=1440m"
    assert item["audio_srt_url"].startswith(f"https://sas.example/{PREFIX}/audio.srt?")
    assert {m for _, m in svc.minted} == {pl.DEFAULT_SAS_MINUTES} and all(b for b, _ in svc.minted)
    assert item["transcript"] == _transcript()
    assert item["hosts"] == HOST_DICTS and item["audio_duration_sec"] == 55.5
    dto = LibraryItem.model_validate(item)
    assert dto.transcript is not None and dto.transcript.cues[2].kind == "reaction"


def test_admin_get_tolerates_a_corrupt_or_missing_transcript_blob(lib, svc, probes, tmp_path):
    _publish(lib, _render_outputs(tmp_path))
    svc.store[f"{PREFIX}/transcript.json"] = b"{broken"
    assert lib.get(JOB)["transcript"] is None
    svc.store[f"{PREFIX}/transcript.json"] = json.dumps({"duration_sec": "long"}).encode()
    assert lib.get(JOB)["transcript"] is None
    del svc.store[f"{PREFIX}/transcript.json"]
    item = lib.get(JOB)
    assert item["transcript"] is None and item["mp4_url"]


def test_admin_get_derives_a_transcript_from_the_v1_srt(lib, svc):
    _seed_v1(svc)
    item = lib.get(JOB)
    t = item["transcript"]

    assert t == Transcript.model_validate(t).model_dump()
    assert (t["duration_sec"], t["hosts"], t["peaks"]) == (42.5, NAME_HOSTS, [])
    assert [(c["speaker"], c["turn_idx"], c["start"], c["end"], c["text"], c["kind"]) for c in t["cues"]] == [
        ("interviewer", 0, 2.0, 4.5, "Welcome to the show.", "speech"),
        ("interviewer", 0, 4.5, 6.25, "Today: circular economy.", "speech"),
        ("expert", 1, 6.4, 9.0, "Thanks, Ann.", "speech"),
        ("expert", 1, 9.0, 10.0, "Unknown voice.", "speech"),  # unknown name -> expert
        ("interviewer", 2, 10.1, 12.0, "Back to you.", "speech"),
        ("expert", 3, 12.0, 13.5, "Two lines.", "speech"),
    ]
    # Soundtrack MP3 of the video: both timelines are the same.
    assert [(tr["turn_idx"], tr["speaker"], tr["start"], tr["end"], tr["video_start"], tr["video_end"])
            for tr in t["turns"]] == [
        (0, "interviewer", 2.0, 6.25, 2.0, 6.25), (1, "expert", 6.4, 10.0, 6.4, 10.0),
        (2, "interviewer", 10.1, 12.0, 10.1, 12.0), (3, "expert", 12.0, 13.5, 12.0, 13.5),
    ]
    # BOM + CRLF captions parse the same.
    svc.store[f"{PREFIX}/subtitles.srt"] = ("\ufeff" + V1_SRT.replace("\n", "\r\n")).encode("utf-8")
    assert lib.get(JOB)["transcript"] == t
    # No captions blob -> no transcript.
    del svc.store[f"{PREFIX}/subtitles.srt"]
    assert lib.get(JOB)["transcript"] is None


def test_transcript_from_srt_edge_cases():
    assert pl.transcript_from_srt("", NAME_HOSTS) is None
    assert pl.transcript_from_srt("garbage\n\nmore garbage", NAME_HOSTS) is None
    t = pl.transcript_from_srt("1\n00:00:01.5 --> 00:00:02,25\nNo label here.\n\n"
                               "2\n00:00:03,000 --> 00:00:04,000\nann: lower-case label.\n", NAME_HOSTS)
    assert [(c["speaker"], c["start"], c["end"], c["text"]) for c in t["cues"]] == [
        ("expert", 1.5, 2.25, "No label here."), ("interviewer", 3.0, 4.0, "lower-case label.")]
    assert t["duration_sec"] == 4.0 and t["turns"][0]["video_start"] is None


# ---------------------------------------------------------------------------
# Public get (anonymous) + PODCAST_PUBLIC_AUDIO
# ---------------------------------------------------------------------------
def test_public_get_without_public_audio_serves_video_and_thumbnail_only(lib, svc, probes, tmp_path):
    _publish(lib, _render_outputs(tmp_path))
    assert lib.get(JOB, public=True) is None  # never auto-published
    lib.set_published(JOB, True)
    svc.minted.clear()
    item = lib.get(JOB, public=True)

    assert _populated(item) == {"mp4_url", "thumbnail_url"}
    assert sorted(svc.minted) == [(f"{PREFIX}/thumb.jpg", PUBLIC), (f"{PREFIX}/video.mp4", PUBLIC)]
    assert PUBLIC == 15
    assert item["transcript"] is None and item["hosts"] == [] and item["speaker_names"] == []
    assert (item["has_video"], item["has_audio"], item["audio_duration_sec"]) == (True, False, None)


def test_public_get_with_public_audio_adds_audio_cover_hosts_and_transcript(lib, svc, probes, tmp_path,
                                                                            monkeypatch):
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    _publish(lib, _render_outputs(tmp_path))
    lib.set_published(JOB, True)
    svc.minted.clear()
    item = lib.get(JOB, public=True)

    assert _populated(item) == {"mp4_url", "thumbnail_url", "mp3_url", "audio_url", "cover_url"}
    assert item["audio_url"] == item["mp3_url"]
    assert item["srt_url"] is item["audio_srt_url"] is item["scorm_url"] is None
    assert sorted(svc.minted) == sorted((f"{PREFIX}/{n}", PUBLIC) for n in
                                        ("video.mp4", "thumb.jpg", "audio.mp3", "cover.jpg"))
    assert item["transcript"] == _transcript()
    assert (item["hosts"], item["speaker_names"], item["has_audio"]) == (HOST_DICTS, ["Ann", "Bob"], True)


@pytest.mark.parametrize("flag", ["false", "true"])
def test_public_get_of_an_audio_only_item_needs_public_audio(lib, svc, probes, tmp_path, monkeypatch, flag):
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", flag)
    _publish(lib, _render_outputs(tmp_path, video=False, scorm=False))
    lib.set_published(JOB, True)
    svc.minted.clear()
    item = lib.get(JOB, public=True)
    if flag == "false":
        assert item is None and svc.minted == []
        return
    assert _populated(item) == {"thumbnail_url", "mp3_url", "audio_url", "cover_url"}
    assert item["format"] == "audio" and item["mp4_url"] is None and item["transcript"]["cues"]
    assert {m for _, m in svc.minted} == {PUBLIC}


def test_public_get_of_a_v1_item_with_public_audio_derives_the_transcript(lib, svc, monkeypatch):
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    _seed_v1(svc)
    item = lib.get(JOB, public=True)
    assert _populated(item) == {"mp4_url", "thumbnail_url", "mp3_url", "audio_url"}  # v1: no cover
    assert item["transcript"]["cues"][0]["text"] == "Welcome to the show."
    assert item["hosts"] == NAME_HOSTS
    assert {m for _, m in svc.minted} == {PUBLIC}


# ---------------------------------------------------------------------------
# List / delete
# ---------------------------------------------------------------------------
def test_list_normalizes_items_and_hides_audio_only_ones_from_visitors(lib, svc, probes, tmp_path, monkeypatch):
    _seed_v1(svc, "job-0000000a", created_at="2026-01-01T00:00:00+00:00")
    _publish(lib, _render_outputs(tmp_path, name="b", video=False, scorm=False), job="job-0000000b",
             created_at="2026-03-01T00:00:00+00:00")
    _publish(lib, _render_outputs(tmp_path, name="c"), job="job-0000000c", created_at="2026-02-01T00:00:00+00:00")
    lib.set_published("job-0000000b", True)
    # Ignored: nested, mismatched-folder, non-job and cache manifests.
    svc.store["podcast-library/job-0000000d/nested/manifest.json"] = json.dumps(_v1("job-0000000d")).encode()
    svc.store["podcast-library/job-0000000e/manifest.json"] = json.dumps(_v1("job-0000000a")).encode()
    svc.store["podcast-library/notajob/manifest.json"] = json.dumps(_v1("job-0000000f")).encode()
    svc.store["podcast-cache/job-00000010/manifest.json"] = json.dumps(_v1("job-00000010")).encode()

    admin = lib.list()
    assert [i["job_id"] for i in admin] == ["job-0000000b", "job-0000000c", "job-0000000a"]
    assert set(svc.listed) == {"podcast-library/job-"}
    by_id = {i["job_id"]: i for i in admin}
    facts = ("format", "has_video", "has_audio", "audio_duration_sec", "hosts", "published")
    assert {k: by_id["job-0000000a"][k] for k in facts} == {
        "format": "video", "has_video": True, "has_audio": True, "audio_duration_sec": 42.5,
        "hosts": NAME_HOSTS, "published": True}
    assert {k: by_id["job-0000000b"][k] for k in facts} == {
        "format": "audio", "has_video": False, "has_audio": True, "audio_duration_sec": 55.5,
        "hosts": HOST_DICTS, "published": True}
    assert by_id["job-0000000c"]["published"] is False and by_id["job-0000000c"]["duration_sec"] == 61.0
    for summary in admin:
        LibrarySummary.model_validate(summary)
        assert {k for k in summary if k.endswith("_url")} == {"thumbnail_url"}

    svc.minted.clear()
    visitors = lib.list(published_only=True)
    assert [i["job_id"] for i in visitors] == ["job-0000000a"]
    assert (visitors[0]["has_audio"], visitors[0]["hosts"], visitors[0]["speaker_names"]) == (False, [], [])
    assert visitors[0]["audio_duration_sec"] is None
    assert svc.minted == [("podcast-library/job-0000000a/thumb.jpg", PUBLIC)]

    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    visitors = lib.list(published_only=True)
    assert [i["job_id"] for i in visitors] == ["job-0000000b", "job-0000000a"]
    assert visitors[0]["hosts"] == HOST_DICTS and visitors[1]["has_audio"] is True


def test_delete_removes_only_the_items_own_blobs(lib, svc, probes, tmp_path):
    _publish(lib, _render_outputs(tmp_path))
    svc.store["podcast-cache/listener/kit.webm"] = b"cache"
    svc.store["podcast-library/job-0123abce/manifest.json"] = b"{}"
    assert lib.delete(JOB) is True
    assert set(svc.store) == {"podcast-cache/listener/kit.webm", "podcast-library/job-0123abce/manifest.json"}
    assert lib.delete("podcast-cache") is False and lib.delete("job-") is False


# ---------------------------------------------------------------------------
# Real ffmpeg/ffprobe (skipped when not on PATH)
# ---------------------------------------------------------------------------
@pytest.mark.slow
@pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg/ffprobe not on PATH")
def test_publish_probes_real_renditions(lib, svc, tmp_path):
    files = _render_outputs(tmp_path)
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=navy:s=320x180:d=2:r=25",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "mpeg4",
                        "-c:a", "aac", str(files.mp4)], check=True, timeout=120, capture_output=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
                        "-c:a", "libmp3lame", "-b:a", "64k", str(files.mp3)], check=True, timeout=120,
                       capture_output=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        pytest.skip(f"ffmpeg cannot synthesize test media: {type(exc).__name__}")

    manifest = _publish(lib, files)
    assert manifest["video_duration_sec"] == pytest.approx(2.0, abs=0.2)
    assert manifest["audio_duration_sec"] == pytest.approx(1.5, abs=0.2)
    assert manifest["duration_sec"] == manifest["video_duration_sec"]
    with Image.open(io.BytesIO(svc.store[f"{PREFIX}/thumb.jpg"])) as thumb:
        assert (thumb.format, thumb.size) == ("JPEG", (480, 270))
