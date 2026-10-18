"""Podcast render orchestration (``routers.podcast``) with fake engines.

Every engine module (avatar render, listener kits, TTS, reactions, compose,
radio mix) is replaced in ``sys.modules`` by a recording fake, so these tests
pin the orchestration contract without Azure or ffmpeg: format paths, order
and concurrency, planned pauses, per-rendition reactions, the compose limiter,
radio fallbacks with stable warning codes, outputs and job files, render
validation, the reaction kill switch and the sentinel (Speech character names
never leak).
"""
from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import shutil
import subprocess
import sys
import threading
import time
import types
import wave
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional
from urllib.parse import unquote

import pytest
from PIL import Image

from services import podcast_media as pm
from services.podcast_models import (
    DialogueTurn,
    Document,
    PodcastHost,
    PodcastJob,
    ReactionHint,
    RenderRoles,
    RoleConfig,
    Script,
    Transcript,
    TranscriptCue,
    TranscriptTurn,
)

SENTINEL = "SentinelCharacterQ7"
SCRIPT_ID = "scr-0000abcd"
DOC_ID = "doc-0001"
VOICE_I = "en-US-Ava:DragonHDLatestNeural"      # interviewer
VOICE_E = "en-US-Andrew:DragonHDLatestNeural"   # expert
TEXTS = [
    "Welcome to the show. Today we talk about the circular economy and why it matters.",
    "Thanks for having me. It changes how products are designed, used and recovered.",
    "That sounds ambitious. Where should a company start on that journey today?",
    "Start small. Measure material flows first, then redesign one product line.",
]
PLANNED = [
    pm.PlannedReaction(turn_idx=1, listener="interviewer", reaction_id="ack", after_sentence=1, pause_ms=600),
    pm.PlannedReaction(turn_idx=2, listener="expert", reaction_id="right", after_sentence=1, pause_ms=650),
]
PAUSES = {1: {1: 600}, 2: {1: 650}}
OFFSETS = {i: (2.0 + 4 * i, 5.5 + 4 * i) for i in range(len(TEXTS))}
VIDEO_SRT = ("1\n00:00:02,000 --> 00:00:05,500\nAnn: Hello there.\n\n"
             "2\n00:00:06,000 --> 00:00:09,500\nBob: Hi Ann.\n")


class Engines:
    """Recording fakes of every podcast engine (signatures per ``podcast_media``)."""

    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()
        self.events: list[str] = []
        self.calls: dict[str, list[dict]] = defaultdict(list)
        self.probes: dict[str, tuple] = {}
        self.barrier: Optional[threading.Barrier] = None
        self.fail: set[str] = set()
        self.mix_fail_sources: set[str] = set()
        self.kit_reactions = True
        self.kit_warnings: tuple[str, ...] = ()
        self.kit_delay = 0.0
        self.compose_delay = 0.0
        self.compose_warnings: list[str] = []
        self.mix_warnings: list[str] = []
        self.compose_active = 0
        self.compose_max = 0
        self.library: Any = None

    # -- helpers -----------------------------------------------------------
    def _enter(self, name: str, **info: Any) -> None:
        import routers.podcast as pc

        jobs = list(pc.JOBS.values())
        with self.lock:
            self.events.append(f"{name}:start")
            self.calls[name].append({"t": time.monotonic(), **info})
            if len(jobs) == 1:
                job = jobs[0]
                self.probes.setdefault(name, (job.state.value, job.progress.stage, job.progress.message))
        if name in self.fail:
            raise RuntimeError(f"{name} failed for {SENTINEL}")

    def _leave(self, name: str) -> None:
        with self.lock:
            self.events.append(f"{name}:end")

    def _sync(self) -> None:
        if self.barrier is not None:
            self.barrier.wait()

    def _file(self, rel: str, data: bytes = b"x") -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def first(self, name: str) -> dict:
        return self.calls[name][0]

    def count(self, name: str) -> int:
        return len(self.calls[name])

    # -- services.podcast_render -------------------------------------------
    def render_podcast(self, cfg, script, roles, progress_cb=None, language="en-US", *args,
                       pauses=None, deadline=None, **kwargs):
        self._enter("render_podcast", pauses=pauses, language=language, deadline=deadline)
        self._sync()
        clips = []
        for n, turn in enumerate(sorted(script.turns, key=lambda t: t.idx), 1):
            path = self._file(f"avatar/turn_{turn.idx:03d}.mp4", b"avatar clip")
            clips.append(SimpleNamespace(turn_idx=turn.idx, speaker=turn.speaker, blob_url=str(path),
                                         duration_sec=4.0))
            if progress_cb:
                progress_cb(n)
        self._leave("render_podcast")
        return list(reversed(clips))  # the router must order them by turn

    # -- services.podcast_listener -----------------------------------------
    def resolve_listener_kits(self, cfg, roles, language, *, want_reactions, deadline):
        self._enter("resolve_listener_kits", want_reactions=want_reactions, deadline=deadline)
        self._sync()
        time.sleep(self.kit_delay)
        kits = {}
        for role in ("interviewer", "expert"):
            conf = getattr(roles, role)
            reactions = {}
            if want_reactions and self.kit_reactions:
                for rid in pm.REACTION_IDS:
                    reactions[rid] = pm.ReactionClip(
                        reaction_id=rid, text=pm.reaction_text(language, rid),
                        audio_path=self._file(f"kit/{role}_{rid}.wav"),
                        video_path=self._file(f"kit/{role}_{rid}.webm"), duration_sec=0.5, has_alpha=True)
            kits[role] = pm.ListenerKit(avatar_id=conf.avatar, voice=conf.voice, mode="idle_loop", idle=None,
                                        reactions=reactions, warnings=self.kit_warnings)
        self._leave("resolve_listener_kits")
        return kits

    # -- services.podcast_tts ----------------------------------------------
    def synthesize_turns(self, cfg, script, roles, work_dir, *, pauses=None, progress_cb=None, deadline=None):
        self._enter("synthesize_turns", pauses=pauses, work_dir=Path(work_dir),
                    progress=progress_cb is not None)
        self._sync()
        turns = []
        for n, turn in enumerate(sorted(script.turns, key=lambda t: t.idx), 1):
            path = Path(work_dir) / f"turn_{turn.idx:03d}.wav"
            path.write_bytes(b"RIFF tts")
            turns.append(pm.TurnAudio(turn_idx=turn.idx, speaker=turn.speaker, path=path, source="tts",
                                      duration_sec=3.5))
            if progress_cb:
                progress_cb(n)
        self._leave("synthesize_turns")
        return turns

    def synthesize_reaction_audio(self, cfg, voice, language, reaction_ids, cache_dir):
        self._enter("synthesize_reaction_audio", voice=voice, ids=list(reaction_ids), cache_dir=Path(cache_dir))
        tag = hashlib.sha1(voice.encode()).hexdigest()[:8]
        return {rid: pm.ReactionClip(reaction_id=rid, text=pm.reaction_text(language, rid),
                                     audio_path=self._file(f"rx/{tag}_{rid}.wav"), video_path=None,
                                     duration_sec=0.45)
                for rid in reaction_ids}

    # -- services.podcast_reactions ----------------------------------------
    def plan_reactions(self, turns, language, seed, enabled):
        self._enter("plan_reactions", enabled=enabled, seed=seed, language=language, turns=len(turns))
        return list(PLANNED) if enabled else []

    def place_reactions(self, planned, turn_audio, clips, *, texts=None, **kwargs):
        suffixes = {Path(p).suffix for p in turn_audio.values()}
        rendition = {frozenset({".mp4"}): "avatar", frozenset({".wav"}): "tts"}.get(frozenset(suffixes), "mixed")
        self._enter("place_reactions", rendition=rendition, planned=list(planned), clips=clips, texts=texts,
                    turns=sorted(turn_audio))
        placed = []
        for p in planned:
            clip = (clips.get(p.listener) or {}).get(p.reaction_id)
            if clip is not None:
                placed.append(pm.ReactionPlacement(turn_idx=p.turn_idx, listener=p.listener,
                                                   reaction_id=p.reaction_id, at_sec=1.2,
                                                   duration_sec=clip.duration_sec))
        return placed

    # -- services.podcast_compose ------------------------------------------
    def compose_podcast(self, clips, document, script, roles, out_dir, music=True, intro=True,
                        music_path=None, layout="split_screen_with_slides", *, listener_kits=None,
                        reactions=None, reaction_clips=None, seed=""):
        import routers.podcast as pc

        with self.lock:
            self.compose_active += 1
            self.compose_max = max(self.compose_max, self.compose_active)
        try:
            self._enter("compose_podcast", clips=[c.turn_idx for c in clips], document=document,
                        kits=listener_kits, reactions=reactions, reaction_clips=reaction_clips, seed=seed,
                        music=music, intro=intro, layout=layout, slot_active=pc.COMPOSE_SLOTS.active)
            time.sleep(self.compose_delay)
            out = Path(out_dir)
            out.mkdir(parents=True, exist_ok=True)
            (out / "final.mp4").write_bytes(b"MP4 video")
            (out / "final.mp3").write_bytes(b"ID3 soundtrack")
            (out / "final.srt").write_text(VIDEO_SRT, encoding="utf-8")
            timeline = pm.ComposeTimeline(turn_video_offsets=dict(OFFSETS), listener_mode="idle_loop",
                                          duration_sec=20.0)
            return SimpleNamespace(mp4=out / "final.mp4", mp3=out / "final.mp3", srt=out / "final.srt",
                                   timeline=timeline, warnings=list(self.compose_warnings))
        finally:
            with self.lock:
                self.compose_active -= 1
            self._leave("compose_podcast")

    # -- services.podcast_radio --------------------------------------------
    def mix_radio(self, turn_audio, placements, clips, script, roles, hosts, *, title, language, out_dir,
                  intro, seed, video_offsets=None, music_path=None, avatar_images=None, warnings=None):
        source = turn_audio[0].source
        self._enter("mix_radio", source=source, turns=[t.turn_idx for t in turn_audio],
                    placements=list(placements), clips=clips, hosts=list(hosts), title=title, language=language,
                    out_dir=Path(out_dir), intro=intro, seed=seed, video_offsets=video_offsets,
                    music_path=music_path, avatar_images=avatar_images)
        if source in self.mix_fail_sources:
            raise RuntimeError(f"radio mix failed for {SENTINEL}")
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "audio.mp3").write_bytes(b"ID3 radio mix")
        (out / "audio.srt").write_text("1\n00:00:00,080 --> 00:00:03,400\nAnn: Hello there.\n", encoding="utf-8")
        Image.new("RGB", (64, 64), "orange").save(out / "cover.jpg", "JPEG")
        transcript = Transcript(
            duration_sec=18.5, hosts=list(hosts),
            turns=[TranscriptTurn(turn_idx=t.turn_idx, speaker=t.speaker, start=3.6 * i, end=3.6 * i + 3.4)
                   for i, t in enumerate(turn_audio)],
            cues=[TranscriptCue(start=0.08, end=3.4, speaker="interviewer", turn_idx=0, text="Hello there.")],
            peaks=[0.1, 0.7, 0.3],
        )
        (out / "transcript.json").write_text(transcript.model_dump_json(), encoding="utf-8")
        if warnings is not None:
            warnings.extend(self.mix_warnings)
        self._leave("mix_radio")
        return pm.RadioResult(mp3=out / "audio.mp3", srt=out / "audio.srt", transcript_path=out / "transcript.json",
                              transcript=transcript, cover=out / "cover.jpg", duration_sec=18.5)

    # -- services.scorm_packager -------------------------------------------
    def build_scorm_package(self, *, title, language, media_path, srt_path, out_dir, thumbnail_path=None):
        self._enter("build_scorm_package", title=title, media_path=Path(media_path), srt_path=Path(srt_path))
        path = Path(out_dir) / "scorm.zip"
        path.write_bytes(b"PK scorm")
        return path


class RecordingLibrary:
    available = True

    def __init__(self):
        self.published: list[SimpleNamespace] = []

    def publish(self, job_id, files, **kwargs):
        self.published.append(SimpleNamespace(job_id=job_id, files=files, kwargs=kwargs))
        return {"job_id": job_id}


class MemBlobs:
    """In-memory blob service for the real PodcastLibrary."""

    def __init__(self):
        self.store: dict[str, bytes] = {}

    def get_container_client(self, _container):
        return SimpleNamespace(
            list_blobs=lambda name_starts_with="": [SimpleNamespace(name=n) for n in sorted(self.store)
                                                    if n.startswith(name_starts_with)],
            delete_blob=lambda name: self.store.pop(name),
        )

    def get_blob_client(self, container, blob):
        store = self.store

        class _Blob:
            url = f"https://acct.blob.core.windows.net/media/{blob}"

            def upload_blob(self, data, overwrite=False, content_settings=None):
                store[blob] = bytes(data)

            def download_blob(self):
                data = store[blob]
                return SimpleNamespace(readall=lambda: data)

        return _Blob()


ENGINE_MODULES = {
    "podcast_render": ("render_podcast",),
    "podcast_listener": ("resolve_listener_kits",),
    "podcast_tts": ("synthesize_turns", "synthesize_reaction_audio"),
    "podcast_reactions": ("plan_reactions", "place_reactions"),
    "podcast_compose": ("compose_podcast",),
    "podcast_radio": ("mix_radio",),
}


def _script() -> Script:
    return Script(id=SCRIPT_ID, document_id=DOC_ID, language="en-US",
                  turns=[DialogueTurn(idx=i, speaker="interviewer" if i % 2 == 0 else "expert", text=text)
                         for i, text in enumerate(TEXTS)])


@pytest.fixture
def stores(monkeypatch, tmp_path):
    """Fresh in-memory router stores (script + document), work dirs under tmp_path."""
    import routers.podcast as pc
    from security import COMPOSE_SLOTS

    monkeypatch.setattr(pc, "OUT_ROOT", tmp_path / "out")
    monkeypatch.setattr(pc, "REACTION_AUDIO_CACHE", tmp_path / "reaction_cache")
    for store in ("JOBS", "SCRIPTS", "DOCUMENTS", "_JOB_FILES"):
        monkeypatch.setattr(pc, store, {})
    pc.SCRIPTS[SCRIPT_ID] = _script()
    pc.DOCUMENTS[DOC_ID] = Document(id=DOC_ID, title="Circular Economy", source_kind="txt")
    COMPOSE_SLOTS.reset()
    yield pc
    COMPOSE_SLOTS.reset()


@pytest.fixture
def engines(stores, monkeypatch, tmp_path):
    """Fake engines in ``sys.modules`` and a recording library."""
    import services

    pc = stores
    eng = Engines(tmp_path / "engines")
    for short, names in ENGINE_MODULES.items():
        module = types.ModuleType(f"services.{short}")
        for name in names:
            setattr(module, name, getattr(eng, name))
        monkeypatch.setitem(sys.modules, f"services.{short}", module)
        monkeypatch.setattr(services, short, module, raising=False)
    sys.modules["services.podcast_render"].batch_create_per_min = lambda: 2
    eng.library = RecordingLibrary()
    monkeypatch.setattr(pc, "_get_library", lambda cfg: eng.library)
    monkeypatch.setattr(pc, "build_scorm_package", eng.build_scorm_package)
    return eng


@pytest.fixture
def photo_avatars(monkeypatch):
    """The production cast: custom photo avatars whose Speech character names are sentinels."""
    from services import avatar_registry

    raw = json.dumps([
        {"id": "photo_female", "display_name": "Sofia", "character": f"{SENTINEL}-Female", "gender": "female",
         "thumbnail": "photo_female.png", "default": True},
        {"id": "photo_male", "display_name": "Lucas", "character": f"{SENTINEL}-Male", "gender": "male",
         "thumbnail": "photo_male.png"},
    ])
    monkeypatch.setenv("CUSTOM_AVATARS_JSON", raw)
    monkeypatch.setenv("HIDE_STOCK_AVATARS", "true")
    avatar_registry.reload(raw)


def _job(fmt: str = "video", *, job_id: str = "job-0000aaaa", reactions: bool = True,
         avatars: tuple[str, str] = ("photo_female", "photo_male")) -> PodcastJob:
    import routers.podcast as pc

    roles = RenderRoles(interviewer=RoleConfig(display_name="Ann", avatar=avatars[0], voice=VOICE_I),
                        expert=RoleConfig(display_name="Bob", avatar=avatars[1], voice=VOICE_E))
    now = "2026-10-17T10:00:00+00:00"
    job = PodcastJob(id=job_id, script_id=SCRIPT_ID, roles=roles, layout="split_screen_with_slides", music=True,
                     intro=True, created_at=now, updated_at=now, format=fmt, reactions=reactions)
    pc.JOBS[job_id] = job
    return job


def _run(*jobs: PodcastJob) -> None:
    import routers.podcast as pc
    from config import load_config

    async def main() -> None:
        await asyncio.gather(*(pc._render_job_body(job.id, load_config()) for job in jobs))

    asyncio.run(main())


def _files_base(job: PodcastJob) -> str:
    return f"/api/podcast/jobs/{job.id}/file/"


def _turns(placements) -> list[tuple[int, str, str]]:
    return [(p.turn_idx, p.listener, p.reaction_id) for p in placements]


# ---------------------------------------------------------------------------
# Video + audio
# ---------------------------------------------------------------------------
def test_video_runs_avatar_listener_and_radio_voices_in_parallel_then_composes_and_mixes(
        engines, photo_avatars, monkeypatch):
    monkeypatch.setenv("PODCAST_REACTIONS", "true")
    # Avatar turns, listener kits and radio TTS must all be in flight at once.
    engines.barrier = threading.Barrier(3, timeout=10)
    job = _job("video")
    before = time.monotonic()
    _run(job)

    assert job.state.value == "done" and job.error is None and job.archive_state == "published"
    assert job.warnings == [] and job.listener_mode == "idle_loop"

    plan = engines.first("plan_reactions")
    assert plan["enabled"] is True and plan["seed"] == job.id and plan["language"] == "en-US"
    # The same planned pauses go to the avatar turns and to the radio TTS turns.
    assert engines.first("render_podcast")["pauses"] == PAUSES
    assert engines.first("synthesize_turns")["pauses"] == PAUSES
    kits = engines.first("resolve_listener_kits")
    assert kits["want_reactions"] is True
    assert 50 <= kits["deadline"] - before <= 70  # PODCAST_LISTENER_TIMEOUT_SEC=60 (conftest)
    # Radio backchannels: one call per listener voice, with only the ids it says.
    assert sorted((c["voice"], c["ids"]) for c in engines.calls["synthesize_reaction_audio"]) == [
        (VOICE_E, ["right"]), (VOICE_I, ["ack"])]

    # Reactions are placed per rendition: the avatar clips with the kits' lip-synced
    # clips, then the TTS turns with audio-only clips.
    video_place, radio_place = engines.calls["place_reactions"]
    assert (video_place["rendition"], radio_place["rendition"]) == ("avatar", "tts")
    assert video_place["planned"] == PLANNED == radio_place["planned"]
    assert video_place["clips"]["interviewer"]["ack"].video_path is not None
    assert radio_place["clips"]["interviewer"]["ack"].video_path is None
    assert video_place["texts"] == radio_place["texts"] == dict(enumerate(TEXTS))

    compose = engines.first("compose_podcast")
    assert compose["clips"] == [0, 1, 2, 3] and compose["slot_active"] == 1
    assert compose["document"].title == "Circular Economy" and compose["seed"] == job.id
    assert set(compose["kits"]) == {"interviewer", "expert"}
    assert _turns(compose["reactions"]) == [(1, "interviewer", "ack"), (2, "expert", "right")]
    assert compose["reaction_clips"]["expert"]["right"].video_path is not None

    (mix,) = engines.calls["mix_radio"]
    assert mix["source"] == "tts" and mix["turns"] == [0, 1, 2, 3]
    assert _turns(mix["placements"]) == [(1, "interviewer", "ack"), (2, "expert", "right")]
    assert mix["clips"]["expert"]["right"].video_path is None
    assert mix["video_offsets"] == OFFSETS and mix["seed"] == job.id and mix["intro"] is True
    assert mix["title"] == "Circular Economy" and mix["language"] == "en-US" and mix["music_path"] is None
    assert mix["hosts"] == [PodcastHost(role="interviewer", display_name="Ann", avatar_id="photo_female"),
                            PodcastHost(role="expert", display_name="Bob", avatar_id="photo_male")]
    assert {role: p.name for role, p in mix["avatar_images"].items()} == {
        "interviewer": "photo_female.png", "expert": "photo_male.png"}

    events = engines.events
    assert events.index("compose_podcast:start") > max(
        events.index("render_podcast:end"), events.index("resolve_listener_kits:end"),
        events.index("place_reactions:start"))
    assert events.index("mix_radio:start") > events.index("compose_podcast:end")

    # Friendly, format-aware progress.
    state, stage, message = engines.probes["render_podcast"]
    assert (state, stage) == ("rendering", "rendering") and "rate-limited to 2 per minute" in message
    assert engines.probes["compose_podcast"] == ("composing", "composing", "Composing the video…")
    assert engines.probes["mix_radio"] == ("composing", "mixing", "Mixing the radio version…")
    assert (job.progress.stage, job.progress.completed, job.progress.total) == ("done", 4, 4)


def test_video_outputs_job_files_scorm_and_library(engines, photo_avatars, client):
    import routers.podcast as pc

    job = _job("video")
    _run(job)
    base = _files_base(job)
    assert job.outputs.model_dump() == {
        "mp4_url": base + "mp4", "mp3_url": base + "mp3", "srt_url": base + "srt", "duration_sec": 20.0,
        "audio_srt_url": base + "audio_srt", "transcript_url": base + "transcript", "cover_url": base + "cover",
        "audio_duration_sec": 18.5, "video_duration_sec": 20.0, "audio_kind": "radio_mix",
    }
    files = pc._JOB_FILES[job.id]
    assert set(files) == {"mp4", "mp3", "srt", "audio_srt", "transcript", "cover", "scorm"}
    assert (files["mp3"].parent.name, files["mp3"].name) == ("radio", "audio.mp3")  # never the soundtrack
    assert files["mp4"].name == "final.mp4" and files["srt"].name == "final.srt"
    scorm = engines.first("build_scorm_package")
    assert (scorm["media_path"], scorm["srt_path"]) == (files["mp3"], files["audio_srt"])

    mime = {"mp4": "video/mp4", "mp3": "audio/mpeg", "srt": "application/x-subrip",
            "audio_srt": "application/x-subrip", "transcript": "application/json", "cover": "image/jpeg",
            "scorm": "application/zip"}
    for kind, media_type in mime.items():
        r = client.get(base + kind)
        assert r.status_code == 200, kind
        assert r.headers["content-type"].split(";")[0] == media_type, kind
    assert client.get(base + "mp3").content == b"ID3 radio mix"
    assert Transcript.model_validate_json(client.get(base + "transcript").content).turns
    assert client.get(base + "wav").status_code == 404
    assert client.get("/api/podcast/jobs/job-0000ffff/file/mp3").status_code == 404

    (pub,) = engines.library.published
    assert isinstance(pub.files, pm.LibraryFiles) and pub.files.format == "video"
    assert (pub.files.mp4, pub.files.srt, pub.files.mp3, pub.files.audio_srt, pub.files.transcript,
            pub.files.cover, pub.files.scorm) == (files["mp4"], files["srt"], files["mp3"], files["audio_srt"],
                                                 files["transcript"], files["cover"], files["scorm"])
    kwargs = pub.kwargs
    assert (kwargs["audio_kind"], kwargs["listener_mode"]) == ("radio_mix", "idle_loop")
    assert kwargs["title"] == kwargs["document_title"] == "Circular Economy"
    assert kwargs["speaker_names"] == ["Ann", "Bob"] and kwargs["turn_count"] == 4
    assert [h.avatar_id for h in kwargs["hosts"]] == ["photo_female", "photo_male"]
    assert job.archive_state == "published" and job.library_job_id == job.id


def test_lazy_scorm_packages_the_radio_mp3_with_its_srt(engines, photo_avatars, client):
    engines.library.available = False
    job = _job("video")
    _run(job)
    assert job.state.value == "done" and job.archive_state == "failed"
    assert engines.count("build_scorm_package") == 0
    r = client.get(_files_base(job) + "scorm")
    assert r.status_code == 200 and "Circular Economy-scorm.zip" in unquote(r.headers["content-disposition"])
    scorm = engines.first("build_scorm_package")
    assert (scorm["media_path"].name, scorm["srt_path"].name) == ("audio.mp3", "audio.srt")


def test_radio_uses_the_avatar_audio_when_tts_fails(engines, photo_avatars, monkeypatch, caplog):
    monkeypatch.setenv("PODCAST_REACTIONS", "true")
    engines.fail = {"synthesize_turns"}
    job = _job("video")
    with caplog.at_level(logging.INFO):
        _run(job)
    assert job.state.value == "done" and job.warnings == [] and job.outputs.audio_kind == "radio_mix"
    # The avatar clips are the video's audio: their placements are reused as is.
    assert [c["rendition"] for c in engines.calls["place_reactions"]] == ["avatar"]
    (mix,) = engines.calls["mix_radio"]
    assert mix["source"] == "avatar" and mix["turns"] == [0, 1, 2, 3]
    assert _turns(mix["placements"]) == [(1, "interviewer", "ack"), (2, "expert", "right")]
    assert mix["clips"]["interviewer"]["ack"].video_path is not None
    assert SENTINEL not in caplog.text


def test_radio_mix_failure_is_retried_with_the_avatar_audio(engines, photo_avatars):
    engines.mix_fail_sources = {"tts"}
    job = _job("video")
    _run(job)
    assert [c["source"] for c in engines.calls["mix_radio"]] == ["tts", "avatar"]
    assert job.state.value == "done" and job.warnings == [] and job.outputs.audio_kind == "radio_mix"


def test_radio_falls_back_to_the_video_soundtrack(engines, photo_avatars, client, caplog):
    import routers.podcast as pc
    from services.podcast_library import LibraryFiles as SoundtrackFiles

    engines.mix_fail_sources = {"tts", "avatar"}
    job = _job("video")
    with caplog.at_level(logging.INFO):
        _run(job)
    assert job.state.value == "done" and job.warnings == [pm.WARNING_RADIO_FALLBACK]
    out = job.outputs
    assert out.audio_kind == "soundtrack" and out.cover_url is None
    assert all((out.mp4_url, out.mp3_url, out.srt_url, out.audio_srt_url, out.transcript_url))
    assert out.audio_duration_sec == out.video_duration_sec == out.duration_sec == 20.0
    files = pc._JOB_FILES[job.id]
    assert files["mp3"].name == "final.mp3" and files["audio_srt"] == files["srt"]
    transcript = Transcript.model_validate_json(files["transcript"].read_bytes())
    assert [t.speaker for t in transcript.turns] == ["interviewer", "expert"]
    assert transcript.turns[0].video_start == transcript.turns[0].start == 2.0

    (pub,) = engines.library.published
    assert type(pub.files) is SoundtrackFiles and pub.kwargs["audio_kind"] == "soundtrack"
    assert (pub.files.mp4, pub.files.mp3, pub.files.srt) == (files["mp4"], files["mp3"], files["srt"])
    scorm = engines.first("build_scorm_package")
    assert (scorm["media_path"].name, scorm["srt_path"].name) == ("final.mp3", "final.srt")
    base = _files_base(job)
    assert client.get(base + "cover").status_code == 404
    assert client.get(base + "mp3").content == b"ID3 soundtrack"
    assert SENTINEL not in caplog.text and SENTINEL not in job.model_dump_json()


# ---------------------------------------------------------------------------
# Audio only
# ---------------------------------------------------------------------------
def test_audio_render_makes_zero_avatar_calls(engines, client):
    job = _job("audio", avatars=("", ""))
    _run(job)
    assert job.state.value == "done" and job.warnings == [] and job.listener_mode is None
    for name in ("render_podcast", "resolve_listener_kits", "compose_podcast"):
        assert engines.count(name) == 0, name
    assert engines.first("plan_reactions")["enabled"] is False  # conftest: PODCAST_REACTIONS=false
    tts = engines.first("synthesize_turns")
    assert tts["pauses"] == {} and tts["progress"] is True
    assert engines.probes["synthesize_turns"] == ("rendering", "synthesizing", "Synthesizing voices…")
    assert engines.probes["mix_radio"] == ("composing", "mixing", "Mixing the radio version…")
    (mix,) = engines.calls["mix_radio"]
    assert mix["source"] == "tts" and mix["video_offsets"] is None and mix["avatar_images"] == {}
    assert mix["hosts"] == [PodcastHost(role="interviewer", display_name="Ann"),
                            PodcastHost(role="expert", display_name="Bob")]

    base = _files_base(job)
    assert job.outputs.model_dump() == {
        "mp4_url": None, "mp3_url": base + "mp3", "srt_url": None, "duration_sec": 18.5,
        "audio_srt_url": base + "audio_srt", "transcript_url": base + "transcript", "cover_url": base + "cover",
        "audio_duration_sec": 18.5, "video_duration_sec": None, "audio_kind": "radio_mix",
    }
    for kind in ("mp4", "srt"):
        assert client.get(base + kind).status_code == 404, kind
    for kind in ("mp3", "audio_srt", "transcript", "cover", "scorm"):
        assert client.get(base + kind).status_code == 200, kind

    (pub,) = engines.library.published
    assert pub.files.format == "audio" and pub.files.mp4 is None and pub.files.srt is None
    assert pub.kwargs["listener_mode"] is None and pub.kwargs["audio_kind"] == "radio_mix"
    assert [h.avatar_id for h in pub.kwargs["hosts"]] == [None, None]


def test_audio_render_places_reactions_on_the_tts_turns(engines, monkeypatch, tmp_path):
    monkeypatch.setenv("PODCAST_REACTIONS", "true")
    job = _job("audio", avatars=("lisa", ""))
    _run(job)
    assert job.state.value == "done" and job.warnings == []
    assert engines.first("synthesize_turns")["pauses"] == PAUSES
    assert [c["rendition"] for c in engines.calls["place_reactions"]] == ["tts"]
    assert {c["cache_dir"] for c in engines.calls["synthesize_reaction_audio"]} == {tmp_path / "reaction_cache"}
    (mix,) = engines.calls["mix_radio"]
    assert _turns(mix["placements"]) == [(1, "interviewer", "ack"), (2, "expert", "right")]
    assert set(mix["clips"]) == {"interviewer", "expert"}
    # In audio mode an avatar is only the host's portrait (stock avatars have no static thumbnail).
    assert [h.avatar_id for h in mix["hosts"]] == ["lisa", None] and mix["avatar_images"] == {}
    assert engines.count("render_podcast") == engines.count("compose_podcast") == 0


def test_audio_render_fails_without_a_radio_mix(engines):
    engines.mix_fail_sources = {"tts"}
    job = _job("audio", avatars=("", ""))
    _run(job)
    assert job.state.value == "failed" and job.error == "Render failed; see server logs"
    assert job.outputs.mp3_url is None and job.archive_state == "none" and not engines.library.published
    assert SENTINEL not in job.model_dump_json()


def test_audio_render_fails_when_speech_synthesis_fails(engines):
    engines.fail = {"synthesize_turns"}
    job = _job("audio", avatars=("", ""))
    _run(job)
    assert job.state.value == "failed" and engines.count("mix_radio") == 0
    assert SENTINEL not in job.model_dump_json()


# ---------------------------------------------------------------------------
# Reactions, warnings, failures
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("env, requested, expected", [
    ("false", True, False), ("", True, False), ("true", False, False), ("true", True, True),
])
def test_reactions_need_the_request_and_the_kill_switch(engines, monkeypatch, env, requested, expected):
    monkeypatch.setenv("PODCAST_REACTIONS", env)
    job = _job("audio", avatars=("", ""), reactions=requested)
    _run(job)
    assert engines.first("plan_reactions")["enabled"] is expected
    assert engines.count("synthesize_reaction_audio") == (2 if expected else 0)
    assert engines.first("synthesize_turns")["pauses"] == (PAUSES if expected else {})


def test_unplaced_reactions_raise_reactions_skipped(engines, photo_avatars, monkeypatch):
    monkeypatch.setenv("PODCAST_REACTIONS", "true")
    engines.kit_reactions = False  # no lip-synced clips: the video cannot place them
    job = _job("video")
    _run(job)
    assert job.state.value == "done" and job.warnings == [pm.WARNING_REACTIONS_SKIPPED]
    assert engines.first("compose_podcast")["reactions"] == []
    assert len(engines.first("mix_radio")["placements"]) == 2


def test_engine_warnings_are_kept_as_stable_codes_only(engines, photo_avatars):
    engines.kit_warnings = (pm.WARNING_LISTENER_STATIC, f"listener failed for {SENTINEL}")
    engines.compose_warnings = [pm.WARNING_LISTENER_FALLBACK, pm.WARNING_LISTENER_STATIC]
    engines.mix_warnings = [pm.WARNING_COVER_FALLBACK, f"C:\\work\\{SENTINEL}.wav"]
    job = _job("video")
    _run(job)
    assert job.warnings == [pm.WARNING_LISTENER_STATIC, pm.WARNING_LISTENER_FALLBACK, pm.WARNING_COVER_FALLBACK]
    assert SENTINEL not in job.model_dump_json()


def test_listener_kit_crash_degrades_to_the_still_listener(engines, photo_avatars):
    engines.fail = {"resolve_listener_kits"}
    job = _job("video")
    _run(job)
    assert job.state.value == "done" and job.warnings == [pm.WARNING_LISTENER_FALLBACK]
    assert engines.first("compose_podcast")["kits"] == {}


def test_hung_side_work_is_capped_and_never_blocks_the_render(engines, photo_avatars, monkeypatch):
    import routers.podcast as pc

    monkeypatch.setattr(pm, "listener_timeout_sec", lambda: 0.1)
    monkeypatch.setattr(pc, "SIDE_WORK_MIN_SEC", 0.2)
    monkeypatch.setattr(pc, "SIDE_WORK_GRACE_SEC", 0.1)
    engines.kit_delay = 1.5  # a kit build that ignores its deadline
    job = _job("video")
    _run(job)
    assert job.state.value == "done" and job.warnings == [pm.WARNING_LISTENER_TIMEOUT]
    assert engines.first("compose_podcast")["kits"] == {}
    assert engines.first("mix_radio")["source"] == "tts"
    assert engines.events.index("compose_podcast:start") < engines.events.index("resolve_listener_kits:end")


def test_avatar_failure_fails_the_job_once_the_side_work_stopped(engines, photo_avatars):
    engines.fail = {"render_podcast"}
    engines.kit_delay = 0.3
    job = _job("video")
    _run(job)
    assert job.state.value == "failed" and job.error == "Render failed; see server logs"
    # The render slot is held until the listener kits and the radio voices stopped.
    assert "resolve_listener_kits:end" in engines.events and "synthesize_turns:end" in engines.events
    assert engines.count("compose_podcast") == engines.count("mix_radio") == 0
    assert job.warnings == [] and job.outputs.mp4_url is None
    assert SENTINEL not in job.model_dump_json()


def test_compose_limiter_serializes_video_composes(engines, photo_avatars):
    from security import COMPOSE_SLOTS

    engines.compose_delay = 0.3
    jobs = [_job("video", job_id=f"job-0000aaa{i}") for i in range(2)]
    _run(*jobs)
    assert [j.state.value for j in jobs] == ["done", "done"]
    assert engines.count("compose_podcast") == 2 and engines.compose_max == 1
    assert all(c["slot_active"] == 1 for c in engines.calls["compose_podcast"])
    assert COMPOSE_SLOTS.active == 0


def test_blocking_limiter_waits_for_a_free_slot(monkeypatch):
    from security import BlockingLimiter

    monkeypatch.setenv("TEST_COMPOSE_SLOTS", "1")
    limiter = BlockingLimiter("TEST_COMPOSE_SLOTS", 3)
    assert limiter.acquire(timeout=0) is True
    assert limiter.acquire(timeout=0.05) is False
    got: list[bool] = []
    waiter = threading.Thread(target=lambda: got.append(limiter.acquire(timeout=5)))
    waiter.start()
    time.sleep(0.1)
    assert got == []
    limiter.release()
    waiter.join(3)
    assert got == [True] and limiter.active == 1
    limiter.release()
    with limiter.slot():
        assert limiter.active == 1
        with pytest.raises(TimeoutError):
            with limiter.slot(timeout=0):
                pass
    assert limiter.active == 0
    # Raising the limit frees a waiter without any release.
    limiter.acquire()
    got.clear()
    waiter = threading.Thread(target=lambda: got.append(limiter.acquire(timeout=5)))
    waiter.start()
    time.sleep(0.1)
    monkeypatch.setenv("TEST_COMPOSE_SLOTS", "2")
    waiter.join(4)
    assert got == [True] and limiter.active == 2


# ---------------------------------------------------------------------------
# start_render
# ---------------------------------------------------------------------------
def _render_body(fmt: str, interviewer: str, expert: str, *, voice: str = VOICE_I, **extra: Any) -> dict:
    return {"script_id": SCRIPT_ID, "format": fmt, **extra, "roles": {
        "interviewer": {"display_name": "Ann", "avatar": interviewer, "voice": voice},
        "expert": {"display_name": "Bob", "avatar": expert, "voice": VOICE_E}}}


def test_start_render_validates_avatars_per_format(engines, photo_avatars, client):
    import routers.podcast as pc

    post = lambda body: client.post("/api/podcast/render", json=body)  # noqa: E731
    assert post(_render_body("video", "photo_female", "nobody")).status_code == 400
    assert post(_render_body("video", "photo_female", "")).status_code == 422
    assert post(_render_body("audio", "nobody", "")).status_code == 400
    assert post(_render_body("audio", "", "", voice="evil'/><x")).status_code == 400
    assert pc.JOBS == {}

    for fmt, avatars in (("audio", ("", "")), ("audio", ("photo_female", "")), ("video", ("photo_female", "photo_male"))):
        r = post(_render_body(fmt, *avatars, reactions=False))
        assert r.status_code == 200, r.text
        job = pc.JOBS[r.json()["id"]]
        assert (job.format, job.reactions) == (fmt, False)
        assert job.state.value == "done", job.error  # the background render ran on the fake engines
    assert engines.count("render_podcast") == engines.count("compose_podcast") == 1
    assert engines.count("synthesize_turns") == 3  # both audio renders + the video's radio voices
    assert all(c["enabled"] is False for c in engines.calls["plan_reactions"])


# ---------------------------------------------------------------------------
# Sentinel: Speech character names never leak
# ---------------------------------------------------------------------------
def test_speech_character_names_never_leak(engines, photo_avatars, client, easyauth, monkeypatch, caplog):
    import routers.podcast as pc
    from config import load_config
    from services import podcast_library as pl

    blobs = MemBlobs()
    lib = pl.PodcastLibrary(load_config())
    lib._initialised = True
    lib._blob = blobs
    lib._sas = lambda blob, minutes=pl.DEFAULT_SAS_MINUTES: f"https://sas.example/{blob}?se={minutes}m"
    monkeypatch.setattr(pl, "_ffprobe_duration", lambda path: None)
    monkeypatch.setattr(pl, "_extract_thumbnail", lambda mp4, out, *, ts: False)
    monkeypatch.setattr(pc, "_get_library", lambda cfg: lib)
    monkeypatch.setenv("PODCAST_REACTIONS", "true")
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    # Engines misbehave with the character name in warnings and error texts.
    engines.kit_warnings = (f"listener failed for {SENTINEL}",)
    engines.fail = {"synthesize_reaction_audio"}
    engines.mix_fail_sources = {"tts"}
    job = _job("video")
    with caplog.at_level(logging.DEBUG):
        _run(job)
    assert job.state.value == "done" and job.archive_state == "published"
    assert lib.set_published(job.id, True)

    texts = [job.model_dump_json(), json.dumps(job.warnings), caplog.text,
             *(data.decode("utf-8", "replace") for data in blobs.store.values()),
             *(name for name in blobs.store)]
    for path in (pc.OUT_ROOT / job.id).rglob("*"):
        texts.append(str(path))
    listing = client.get("/api/podcast/library")
    detail = client.get(f"/api/podcast/library/{job.id}")
    assert listing.status_code == detail.status_code == 200
    assert detail.json()["audio_url"] and detail.json()["transcript"]
    texts += [listing.text, detail.text]
    assert all(SENTINEL not in text for text in texts)


# ---------------------------------------------------------------------------
# Real engines
# ---------------------------------------------------------------------------
def test_router_calls_bind_to_the_real_engine_signatures():
    """Drift guard: every engine call shape used by the router binds to the real function."""
    from services import (
        podcast_compose, podcast_listener, podcast_radio, podcast_reactions, podcast_render, podcast_tts,
    )

    def binds(fn, *args, **kwargs):
        inspect.signature(fn).bind(*args, **kwargs)

    x, here = object(), Path(".")
    binds(podcast_render.render_podcast, x, x, x, lambda n: None, "en-US", pauses={})
    binds(podcast_listener.resolve_listener_kits, x, x, "en-US", want_reactions=True, deadline=1.0)
    binds(podcast_tts.synthesize_turns, x, x, x, here, pauses={}, progress_cb=None)
    binds(podcast_tts.synthesize_reaction_audio, x, VOICE_I, "en-US", ["ack"], here)
    binds(podcast_reactions.plan_reactions, [], "en-US", "job-0000aaaa", enabled=True)
    binds(podcast_reactions.place_reactions, [], {}, {}, texts={})
    binds(podcast_compose.compose_podcast, [], None, x, x, here, True, True, layout="split_screen_only",
          listener_kits={}, reactions=[], reaction_clips={}, seed="job-0000aaaa")
    binds(podcast_radio.mix_radio, [], [], {}, x, x, [], title="t", language="en-US", out_dir=here, intro=True,
          seed="job-0000aaaa", video_offsets=None, music_path=None, avatar_images={}, warnings=[])
    assert int(podcast_render.batch_create_per_min()) >= 1
    assert {"mp4", "mp3", "srt", "timeline", "warnings"} <= set(podcast_compose.ComposeResult.__dataclass_fields__)


FFMPEG, FFPROBE = shutil.which("ffmpeg"), shutil.which("ffprobe")
TONE_HZ = {"interviewer": 220.0, "expert": 330.0}


def _write_wav(path: Path, segments: list[tuple[float, Optional[float]]], rate: int) -> float:
    """16-bit mono WAV of (seconds, tone Hz | None for silence) segments; returns its duration."""
    import numpy as np

    parts = []
    for seconds, freq in segments:
        n = int(round(seconds * rate))
        parts.append(np.zeros(n) if freq is None else 0.3 * np.sin(2 * np.pi * freq * np.arange(n) / rate))
    samples = np.concatenate(parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes((samples * 32767).astype("<i2").tobytes())
    return len(samples) / rate


def _green_clip(wav: Path, seconds: float) -> Path:
    mp4 = wav.with_suffix(".mp4")
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"color=c=0x00FF00:s=512x512:r=25:d={seconds:.3f}", "-i", str(wav), "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(mp4)], check=True, timeout=120)
    return mp4


class AzureFakes:
    """Synthetic stand-ins for the Azure calls only: avatar batch jobs, TTS and kit synthesis.

    "Speech" is two tone sentences separated by a silence that honours the
    planned pause (pause + 0.3 s, as measured in spike S2).
    """

    def __init__(self, root: Path):
        self.root = root
        self.calls: dict[str, int] = defaultdict(int)

    @staticmethod
    def _speech(path: Path, turn, pauses, rate: int) -> float:
        planned = (pauses or {}).get(turn.idx) or {}
        gap = max(planned.values()) / 1000.0 + 0.3 if planned else 0.3
        tone = TONE_HZ[turn.speaker]
        return _write_wav(path, [(0.27, None), (0.9, tone), (gap, None), (1.1, tone), (0.2, None)], rate)

    def render_podcast(self, cfg, script, roles, progress_cb=None, language="en-US", *args, pauses=None,
                       deadline=None, **kwargs):
        from services.podcast_render import ClipManifest

        self.calls["render_podcast"] += 1
        clips = []
        for n, turn in enumerate(sorted(script.turns, key=lambda t: t.idx), 1):
            wav = self.root / "avatar" / f"turn_{turn.idx:03d}.wav"
            seconds = self._speech(wav, turn, pauses, 16000)  # avatar audio is band-limited
            clips.append(ClipManifest(turn_idx=turn.idx, speaker=turn.speaker, blob_url=str(_green_clip(wav, seconds)),
                                      duration_sec=seconds, chroma_key=True,
                                      avatar_id=getattr(roles, turn.speaker).avatar))
            if progress_cb:
                progress_cb(n)
        return clips

    def synthesize_turns(self, cfg, script, roles, work_dir, *, pauses=None, progress_cb=None, deadline=None):
        self.calls["synthesize_turns"] += 1
        turns = []
        for n, turn in enumerate(sorted(script.turns, key=lambda t: t.idx), 1):
            path = Path(work_dir) / f"tts_turn_{turn.idx:03d}.wav"
            turns.append(pm.TurnAudio(turn_idx=turn.idx, speaker=turn.speaker, path=path, source="tts",
                                      duration_sec=self._speech(path, turn, pauses, 24000)))
            if progress_cb:
                progress_cb(n)
        return turns

    def synthesize_reaction_audio(self, cfg, voice, language, reaction_ids, cache_dir, *, deadline=None):
        self.calls["synthesize_reaction_audio"] += 1
        clips = {}
        for rid in reaction_ids:
            path = Path(cache_dir) / f"{hashlib.sha256(f'{voice}|{rid}'.encode()).hexdigest()[:16]}.wav"
            seconds = _write_wav(path, [(0.4, 440.0)], 24000)
            clips[rid] = pm.ReactionClip(reaction_id=rid, text=pm.reaction_text(language, rid), audio_path=path,
                                         video_path=None, duration_sec=seconds)
        return clips

    def resolve_listener_kits(self, cfg, roles, language, *, want_reactions, deadline):
        self.calls["resolve_listener_kits"] += 1
        kits = {}
        for role in ("interviewer", "expert"):
            reactions = {}
            if want_reactions:
                wav = self.root / "kit" / f"{role}_ack.wav"
                seconds = _write_wav(wav, [(0.45, 520.0)], 16000)
                reactions["ack"] = pm.ReactionClip(reaction_id="ack", text=pm.reaction_text(language, "ack"),
                                                   audio_path=wav, video_path=_green_clip(wav, seconds),
                                                   duration_sec=seconds)
            conf = getattr(roles, role)
            kits[role] = pm.ListenerKit(avatar_id=conf.avatar, voice=conf.voice, mode="still", idle=None,
                                        reactions=reactions)
        return kits


@pytest.mark.slow
@pytest.mark.skipif(FFMPEG is None or FFPROBE is None, reason="ffmpeg/ffprobe not on PATH")
def test_integration_smoke_on_the_real_media_engines(stores, photo_avatars, monkeypatch, tmp_path, client,
                                                     easyauth):
    """Router + real reactions, compose, radio mix, jingle, cover, SCORM and library;
    only the Azure calls are synthetic."""
    from config import load_config
    from services import podcast_library as pl
    from services import podcast_listener, podcast_render, podcast_tts

    pc = stores
    monkeypatch.setenv("PODCAST_REACTIONS", "true")
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    azure = AzureFakes(tmp_path / "azure")
    monkeypatch.setattr(podcast_render, "render_podcast", azure.render_podcast)
    monkeypatch.setattr(podcast_tts, "synthesize_turns", azure.synthesize_turns)
    monkeypatch.setattr(podcast_tts, "synthesize_reaction_audio", azure.synthesize_reaction_audio)
    monkeypatch.setattr(podcast_listener, "resolve_listener_kits", azure.resolve_listener_kits)
    blobs = MemBlobs()
    lib = pl.PodcastLibrary(load_config())
    lib._initialised = True
    lib._blob = blobs
    lib._sas = lambda blob, minutes=pl.DEFAULT_SAS_MINUTES: f"https://sas.example/{blob}?se={minutes}m"
    monkeypatch.setattr(pc, "_get_library", lambda cfg: lib)
    pc.SCRIPTS[SCRIPT_ID].turns[1].reaction = ReactionHint(after_sentence=1, reaction_id="ack")

    job = _job("video")
    _run(job)
    assert job.state.value == "done", job.error
    assert job.archive_state == "published" and job.listener_mode == "still"
    assert job.warnings == []
    assert dict(azure.calls) == {"render_podcast": 1, "resolve_listener_kits": 1, "synthesize_turns": 1,
                                 "synthesize_reaction_audio": 1}
    out = job.outputs
    assert out.audio_kind == "radio_mix" and out.video_duration_sec > 8 and out.audio_duration_sec > 6
    files = pc._JOB_FILES[job.id]
    assert set(files) == {"mp4", "mp3", "srt", "audio_srt", "transcript", "cover", "scorm"}
    transcript = Transcript.model_validate_json(files["transcript"].read_bytes())
    reactions = [c for c in transcript.cues if c.kind == "reaction"]
    assert [(c.turn_idx, c.speaker) for c in reactions] == [(1, "interviewer")]
    assert all(t.video_start is not None and t.video_end is not None for t in transcript.turns)
    assert transcript.peaks

    manifest = json.loads(blobs.store[f"podcast-library/{job.id}/manifest.json"])
    assert (manifest["format"], manifest["audio_kind"], manifest["listener_mode"]) == ("video", "radio_mix", "still")
    assert manifest["has_video"] and manifest["has_audio"] and manifest["scorm_blob"]
    assert lib.set_published(job.id, True)
    body = client.get(f"/api/podcast/library/{job.id}").json()
    assert body["video_url"] and body["audio_url"] and body["cover_url"]
    assert [c["kind"] for c in body["transcript"]["cues"]].count("reaction") == 1
    for path in files.values():
        assert SENTINEL.encode() not in path.read_bytes(), path.name
    for name, data in blobs.store.items():
        assert SENTINEL not in name and SENTINEL.encode() not in data, name


@pytest.mark.slow
@pytest.mark.skipif(FFMPEG is None or FFPROBE is None, reason="ffmpeg/ffprobe not on PATH")
def test_integration_smoke_audio_only_on_the_real_media_engines(stores, monkeypatch, tmp_path, client,
                                                                easyauth):
    from config import load_config
    from services import podcast_library as pl
    from services import podcast_listener, podcast_render, podcast_tts

    pc = stores
    monkeypatch.setenv("PODCAST_REACTIONS", "true")
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    azure = AzureFakes(tmp_path / "azure")
    monkeypatch.setattr(podcast_render, "render_podcast", azure.render_podcast)
    monkeypatch.setattr(podcast_tts, "synthesize_turns", azure.synthesize_turns)
    monkeypatch.setattr(podcast_tts, "synthesize_reaction_audio", azure.synthesize_reaction_audio)
    monkeypatch.setattr(podcast_listener, "resolve_listener_kits", azure.resolve_listener_kits)
    blobs = MemBlobs()
    lib = pl.PodcastLibrary(load_config())
    lib._initialised = True
    lib._blob = blobs
    lib._sas = lambda blob, minutes=pl.DEFAULT_SAS_MINUTES: f"https://sas.example/{blob}?se={minutes}m"
    monkeypatch.setattr(pc, "_get_library", lambda cfg: lib)
    pc.SCRIPTS[SCRIPT_ID].turns[1].reaction = ReactionHint(after_sentence=1, reaction_id="ack")

    job = _job("audio", avatars=("", ""))
    _run(job)
    assert job.state.value == "done", job.error
    assert job.archive_state == "published" and job.warnings == [] and job.listener_mode is None
    assert dict(azure.calls) == {"synthesize_turns": 1, "synthesize_reaction_audio": 1}
    out = job.outputs
    assert out.mp4_url is None and out.srt_url is None and out.audio_kind == "radio_mix"
    assert out.duration_sec == out.audio_duration_sec > 6
    transcript = Transcript.model_validate_json(pc._JOB_FILES[job.id]["transcript"].read_bytes())
    assert [(c.turn_idx, c.speaker) for c in transcript.cues if c.kind == "reaction"] == [(1, "interviewer")]
    assert all(t.video_start is None for t in transcript.turns)

    manifest = json.loads(blobs.store[f"podcast-library/{job.id}/manifest.json"])
    assert (manifest["format"], manifest["has_video"], manifest["has_audio"]) == ("audio", False, True)
    assert manifest["video_blob"] is None and manifest["thumbnail_blob"]  # thumbnail from the cover
    assert lib.set_published(job.id, True)
    body = client.get(f"/api/podcast/library/{job.id}").json()
    assert body["format"] == "audio" and body["video_url"] is None and body["audio_url"]
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "false")
    assert client.get(f"/api/podcast/library/{job.id}").status_code == 404
