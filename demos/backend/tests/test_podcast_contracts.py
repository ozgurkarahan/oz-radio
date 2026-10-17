"""Shared podcast contracts: request/job/library models and ``podcast_media`` helpers."""
from __future__ import annotations

import dataclasses
import re
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from services import podcast_media as pm
from services.podcast_models import (
    AudioKind,
    DialogueTurn,
    JobFileKind,
    JobOutputs,
    LibraryItem,
    LibrarySummary,
    PodcastFormat,
    PodcastHost,
    PodcastJob,
    ProgressStage,
    ReactionHint,
    ReactionId,
    RenderRequest,
    RenderRoles,
    RoleConfig,
    Transcript,
    TranscriptCue,
    TranscriptCueKind,
    TranscriptTurn,
    podcast_format_or_default,
)

LOCALES = ("en-US", "fr-FR", "es-ES", "de-DE", "it-IT", "pt-BR", "zh-CN", "ja-JP")
PODCAST_ENV = ("PODCAST_PUBLIC_AUDIO", "PODCAST_REACTIONS", "PODCAST_LISTENER_MODE",
               "PODCAST_LISTENER_TIMEOUT_SEC")
FRONTEND_PODCAST_TS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "services" / "podcast.ts"


def _roles(interviewer_avatar: str = "lisa", expert_avatar: str = "harry") -> dict:
    return {
        "interviewer": {"display_name": "Ann", "avatar": interviewer_avatar,
                        "voice": "en-US-Ava:DragonHDLatestNeural"},
        "expert": {"display_name": "Bob", "avatar": expert_avatar,
                   "voice": "en-US-Andrew:DragonHDLatestNeural"},
    }


def _job(**overrides) -> PodcastJob:
    fields = dict(id="job-0000aaaa", script_id="scr-0000aaaa", roles=RenderRoles.model_validate(_roles()),
                  layout="split_screen_with_slides", music=True, intro=True, created_at="t", updated_at="t")
    return PodcastJob(**{**fields, **overrides})


def _transcript() -> Transcript:
    return Transcript(
        duration_sec=12.5,
        hosts=[PodcastHost(role="interviewer", display_name="Ann", avatar_id="photo_female"),
               PodcastHost(role="expert", display_name="Bob")],
        turns=[TranscriptTurn(turn_idx=0, speaker="interviewer", start=0.0, end=5.0,
                              video_start=2.25, video_end=7.5),
               TranscriptTurn(turn_idx=1, speaker="expert", start=5.2, end=12.5)],
        cues=[TranscriptCue(start=0.0, end=2.4, speaker="interviewer", turn_idx=0, text="Welcome."),
              TranscriptCue(start=5.2, end=8.0, speaker="expert", turn_idx=1, text="Thanks. It works."),
              TranscriptCue(start=8.1, end=8.6, speaker="interviewer", turn_idx=1, text="Mm-hmm.",
                            kind="reaction")],
        peaks=[0.0, 0.5, 1.0],
    )


# ---------------------------------------------------------------------------
# Render request / roles
# ---------------------------------------------------------------------------
def test_render_request_defaults_keep_todays_video_render():
    req = RenderRequest(script_id="scr-0000aaaa", roles=_roles())
    assert (req.format, req.reactions) == ("video", True)
    assert (req.layout, req.music, req.intro, req.background_image) == (
        "split_screen_with_slides", True, True, None)


@pytest.mark.parametrize("avatars", [("", "harry"), ("lisa", ""), ("", ""), ("  ", "harry")])
def test_video_needs_an_avatar_for_both_hosts(avatars):
    with pytest.raises(ValidationError, match="avatar"):
        RenderRequest(script_id="scr-0000aaaa", roles=_roles(*avatars))
    with pytest.raises(ValidationError, match="avatar"):
        RenderRequest(script_id="scr-0000aaaa", roles=_roles(*avatars), format="video")


def test_video_with_omitted_avatar_field_is_rejected():
    roles = _roles()
    del roles["expert"]["avatar"]
    with pytest.raises(ValidationError, match="expert"):
        RenderRequest(script_id="scr-0000aaaa", roles=roles)


def test_audio_allows_empty_or_omitted_avatars():
    roles = _roles("", "")
    del roles["expert"]["avatar"]
    req = RenderRequest(script_id="scr-0000aaaa", roles=roles, format="audio", reactions=False)
    assert (req.format, req.reactions) == ("audio", False)
    assert (req.roles.interviewer.avatar, req.roles.expert.avatar) == ("", "")
    # An avatar stays usable as an optional portrait for audio-only renders.
    portrait = RenderRequest(script_id="scr-0000aaaa", roles=_roles("photo_female", ""), format="audio")
    assert portrait.roles.interviewer.avatar == "photo_female"


def test_unknown_format_is_rejected():
    with pytest.raises(ValidationError):
        RenderRequest(script_id="scr-0000aaaa", roles=_roles(), format="radio")


def test_role_config_avatar_is_optional_but_bounded():
    assert RoleConfig(display_name="Ann", voice="v").avatar == ""
    with pytest.raises(ValidationError):
        RoleConfig(display_name="Ann", voice="v", avatar="x" * 65)


def test_render_endpoint_answers_422_for_video_without_avatars(client):
    r = client.post("/api/podcast/render", json={"script_id": "scr-0000aaaa", "roles": _roles("", "")})
    assert r.status_code == 422
    assert "avatar" in r.text


# ---------------------------------------------------------------------------
# Reaction hints
# ---------------------------------------------------------------------------
def test_reaction_hint_ids_and_sentence_bounds():
    for rid in get_args(ReactionId):
        assert ReactionHint(after_sentence=1, reaction_id=rid).reaction_id == rid
    assert ReactionHint(after_sentence=20, reaction_id="ack").after_sentence == 20
    for bad in (0, -1, 21):
        with pytest.raises(ValidationError):
            ReactionHint(after_sentence=bad, reaction_id="ack")
    for bad_id in ("ACK", "wow", "", "Mm-hmm."):
        with pytest.raises(ValidationError):
            ReactionHint(after_sentence=1, reaction_id=bad_id)


def test_dialogue_turn_reaction_is_optional_and_round_trips():
    assert DialogueTurn(idx=0, speaker="interviewer", text="Hi.").reaction is None
    turn = DialogueTurn.model_validate({"idx": 1, "speaker": "expert", "text": "One. Two.",
                                        "reaction": {"after_sentence": 1, "reaction_id": "right"}})
    assert turn.reaction == ReactionHint(after_sentence=1, reaction_id="right")
    assert DialogueTurn.model_validate_json(turn.model_dump_json()) == turn
    with pytest.raises(ValidationError):
        DialogueTurn.model_validate({"idx": 1, "speaker": "expert", "text": "One.",
                                     "reaction": {"after_sentence": 1, "reaction_id": "lol"}})


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------
def test_podcast_job_defaults_are_backward_compatible():
    job, other = _job(), _job()
    assert (job.format, job.reactions, job.warnings, job.listener_mode) == ("video", True, [], None)
    job.warnings.append(pm.WARNING_RADIO_FALLBACK)
    assert other.warnings == []
    audio = _job(format="audio", reactions=False, roles=RenderRoles.model_validate(_roles("", "")))
    assert audio.format == "audio" and audio.roles.expert.avatar == ""


def test_job_outputs_additions_default_to_none():
    assert JobOutputs().model_dump() == {
        "mp4_url": None, "mp3_url": None, "srt_url": None, "duration_sec": None,
        "audio_srt_url": None, "transcript_url": None, "cover_url": None,
        "audio_duration_sec": None, "video_duration_sec": None, "audio_kind": None,
    }
    assert JobOutputs(audio_kind="soundtrack").audio_kind == "soundtrack"
    with pytest.raises(ValidationError):
        JobOutputs(audio_kind="remix")


def test_job_file_kinds_and_progress_stages_are_frozen():
    assert get_args(JobFileKind) == ("mp4", "mp3", "srt", "audio_srt", "transcript", "cover", "scorm")
    assert set(get_args(ProgressStage)) == {"queued", "rendering", "synthesizing", "composing", "mixing",
                                            "done", "failed"}


# ---------------------------------------------------------------------------
# Transcript + library DTOs
# ---------------------------------------------------------------------------
def test_transcript_round_trip_and_defaults():
    t = _transcript()
    assert t.version == 1
    assert Transcript.model_validate_json(t.model_dump_json()) == t
    minimal = Transcript(duration_sec=1.0)
    assert (minimal.hosts, minimal.turns, minimal.cues, minimal.peaks) == ([], [], [], [])
    assert TranscriptCue(start=0, end=1, speaker="expert", turn_idx=0, text="x").kind == "speech"
    assert PodcastHost(role="expert", display_name="Bob").avatar_id is None
    assert TranscriptTurn(turn_idx=0, speaker="expert", start=0, end=1).video_start is None
    assert "chapters" not in Transcript.model_fields
    with pytest.raises(ValidationError):
        TranscriptCue(start=0, end=1, speaker="expert", turn_idx=0, text="x", kind="music")
    with pytest.raises(ValidationError):
        PodcastHost(role="host", display_name="Bob")


def test_library_item_round_trip_with_transcript():
    item = LibraryItem(job_id="job-0000aaaa", title="T", created_at="2026-10-17T00:00:00+00:00",
                       format="audio", has_video=False, has_audio=True, audio_duration_sec=12.5,
                       hosts=_transcript().hosts, audio_url="https://x/audio.mp3?sas",
                       cover_url="https://x/cover.jpg?sas", transcript=_transcript())
    dumped = item.model_dump()
    assert dumped["transcript"]["cues"][2]["kind"] == "reaction"
    assert dumped["hosts"][0] == {"role": "interviewer", "display_name": "Ann", "avatar_id": "photo_female"}
    assert LibraryItem(**dumped) == item
    assert LibraryItem.model_validate_json(item.model_dump_json()) == item


def test_legacy_library_entries_read_as_video_with_audio():
    legacy = {"job_id": "job-0000aaaa", "title": "Old", "created_at": "t", "duration_sec": 60.0,
              "mp4_url": "v", "mp3_url": "a", "srt_url": "s", "scorm_url": None,
              "thumbnail_url": "th", "published": True}
    item = LibraryItem(**legacy)
    assert (item.format, item.has_video, item.has_audio, item.hosts, item.transcript) == (
        "video", True, True, [], None)
    assert (item.audio_url, item.cover_url, item.audio_srt_url, item.audio_duration_sec) == (None,) * 4
    summary = LibrarySummary(**legacy)
    assert summary.format == "video" and "mp4_url" not in summary.model_dump()


@pytest.mark.parametrize("value,expected", [("audio", "audio"), ("video", "video"), (None, "video"),
                                            ("", "video"), ("podcast", "video"), (1, "video")])
def test_podcast_format_or_default(value, expected):
    assert podcast_format_or_default(value) == expected


@pytest.mark.parametrize("ts_name,expected", [
    ("PodcastFormat", get_args(PodcastFormat)),
    ("AudioKind", get_args(AudioKind)),
    ("ReactionId", get_args(ReactionId)),
    ("TranscriptCueKind", get_args(TranscriptCueKind)),
    ("ProgressStage", get_args(ProgressStage)),
    ("JobFileKind", get_args(JobFileKind)),
    ("ListenerMode", pm.LISTENER_MODES),
    ("PodcastWarningCode", tuple(pm.WARNING_CODES)),
])
def test_frontend_mirror_matches_backend_literals(ts_name, expected):
    if not FRONTEND_PODCAST_TS.exists():
        pytest.skip("frontend sources not available")
    source = FRONTEND_PODCAST_TS.read_text(encoding="utf-8")
    match = re.search(rf"export type {ts_name} =([^;]+);", source)
    assert match, ts_name
    assert set(re.findall(r"'([^']+)'", match.group(1))) == set(expected)


# ---------------------------------------------------------------------------
# podcast_media engine types
# ---------------------------------------------------------------------------
def test_library_files_v2_requires_radio_assets_and_keeps_video_optional(tmp_path: Path):
    files = pm.LibraryFiles(mp3=tmp_path / "audio.mp3", audio_srt=tmp_path / "audio.srt",
                            transcript=tmp_path / "transcript.json", cover=tmp_path / "cover.jpg")
    assert (files.mp4, files.srt, files.scorm) == (None, None, None)
    assert (files.has_video, files.format) == (False, "audio")
    video = dataclasses.replace(files, mp4=tmp_path / "final.mp4", srt=tmp_path / "final.srt")
    assert (video.has_video, video.format) == (True, "video")
    with pytest.raises(TypeError):
        pm.LibraryFiles(mp3=tmp_path / "audio.mp3", audio_srt=tmp_path / "audio.srt",  # type: ignore[call-arg]
                        transcript=tmp_path / "transcript.json")


def test_engine_types_are_frozen_with_documented_defaults(tmp_path: Path):
    turn = pm.TurnAudio(turn_idx=0, speaker="interviewer", path=tmp_path / "t0.wav", source="tts")
    clip = pm.ReactionClip(reaction_id="ack", text="Mm-hmm.", audio_path=tmp_path / "ack.wav",
                           video_path=None, duration_sec=0.4)
    idle = pm.IdleLoop(path=tmp_path / "idle.webm", duration_sec=6.0, has_alpha=True,
                       signature_path=None, motion_score=1.5, static=False)
    kit = pm.ListenerKit(avatar_id="photo_female", voice="en-US-Ava:DragonHDLatestNeural",
                         mode="idle_loop", idle=idle, reactions={"ack": clip})
    planned = pm.PlannedReaction(turn_idx=2, listener="expert", reaction_id="ack", after_sentence=1,
                                 pause_ms=600)
    placed = pm.ReactionPlacement(turn_idx=2, listener="expert", reaction_id="ack", at_sec=3.1,
                                  duration_sec=0.4)
    assert (turn.duration_sec, clip.has_alpha, kit.warnings, placed.gain_db) == (0.0, False, (), -4.0)
    for obj in (turn, clip, idle, kit, planned, placed):
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(obj, dataclasses.fields(obj)[0].name, None)

    radio = pm.RadioResult(mp3=tmp_path / "audio.mp3", srt=tmp_path / "audio.srt",
                           transcript_path=tmp_path / "transcript.json", transcript=_transcript(),
                           cover=tmp_path / "cover.jpg", duration_sec=12.5)
    assert radio.audio_kind == "radio_mix"
    timeline = pm.ComposeTimeline(turn_video_offsets={0: (2.0, 7.5)}, listener_mode="still", duration_sec=12.0)
    assert timeline.turn_video_offsets[0] == (2.0, 7.5)


def test_planned_pauses_map_turns_to_sentence_breaks():
    planned = [
        pm.PlannedReaction(turn_idx=1, listener="interviewer", reaction_id="ack", after_sentence=2, pause_ms=600),
        pm.PlannedReaction(turn_idx=3, listener="expert", reaction_id="interesting", after_sentence=1,
                           pause_ms=850),
    ]
    assert pm.planned_pauses(planned) == {1: {2: 600}, 3: {1: 850}}
    assert pm.planned_pauses([]) == {}


def test_listener_modes_are_ordered_by_fidelity():
    assert pm.LISTENER_MODES == ("idle_loop", "procedural", "still")
    assert pm.LISTENER_MODE_SETTINGS == ("auto", "idle_loop", "procedural", "still")


def test_warning_codes_are_stable_and_deduplicated():
    assert pm.WARNING_CODES == {"listener_fallback", "listener_static", "listener_timeout",
                                "reactions_skipped", "radio_fallback", "cover_fallback"}
    warnings: list[str] = []
    pm.add_warning(warnings, pm.WARNING_RADIO_FALLBACK)
    pm.add_warning(warnings, "radio_fallback")
    pm.add_warning(warnings, pm.WARNING_LISTENER_STATIC)
    assert warnings == ["radio_fallback", "listener_static"]
    with pytest.raises(ValueError):
        pm.add_warning(warnings, "Traceback (most recent call last): boom")
    assert warnings == ["radio_fallback", "listener_static"]


# ---------------------------------------------------------------------------
# Reaction phrases
# ---------------------------------------------------------------------------
def test_reaction_phrases_cover_every_locale_and_id():
    from services.voice_catalog import HD_VOICES

    assert pm.REACTION_IDS == get_args(ReactionId) == (
        "ack", "right", "yeah", "exactly", "isee", "interesting")
    assert set(pm.REACTION_PHRASES) == set(LOCALES)
    assert {language for _, _, language, _ in HD_VOICES} <= set(pm.REACTION_PHRASES)
    for locale, phrases in pm.REACTION_PHRASES.items():
        assert set(phrases) == set(pm.REACTION_IDS), locale
        assert all(isinstance(text, str) and text.strip() and len(text) <= 24
                   for text in phrases.values()), locale
    assert pm.REACTION_PHRASES["en-US"] == {"ack": "Mm-hmm.", "right": "Right.", "yeah": "Yeah.",
                                           "exactly": "Exactly.", "isee": "I see.",
                                           "interesting": "Interesting."}
    assert set(pm.REACTION_PAUSE_MS) == set(LOCALES)
    for locale, pauses in pm.REACTION_PAUSE_MS.items():
        assert set(pauses) == set(pm.REACTION_IDS), locale
        assert all(isinstance(ms, int) and 300 <= ms <= 1200 for ms in pauses.values()), locale
    assert set(pm.DEFAULT_REACTION_PAUSE_MS) == set(pm.REACTION_IDS)
    assert pm.reaction_pause_ms("en-US", "ack") == pm.REACTION_PAUSE_MS["en-US"]["ack"]
    assert pm.reaction_pause_ms("ko-KR", "isee") == pm.REACTION_PAUSE_MS["en-US"]["isee"]
    with pytest.raises(ValueError):
        pm.reaction_pause_ms("en-US", "lol")


@pytest.mark.parametrize("language,expected", [
    ("fr-FR", "Ah, je vois."), ("fr", "Ah, je vois."), ("fr-CA", "Ah, je vois."), ("FR_fr", "Ah, je vois."),
    ("en-GB", "I see."), ("ko-KR", "I see."), ("", "I see."), ("ja-JP", "なるほど。"),
])
def test_reaction_text_falls_back_to_en_us(language, expected):
    assert pm.reaction_text(language, "isee") == expected


def test_reaction_text_rejects_unknown_ids():
    with pytest.raises(ValueError):
        pm.reaction_text("en-US", "lol")


# ---------------------------------------------------------------------------
# Env flags
# ---------------------------------------------------------------------------
def test_env_helper_defaults(monkeypatch):
    for name in PODCAST_ENV:
        monkeypatch.delenv(name, raising=False)
    assert pm.public_audio_enabled() is False
    assert pm.reactions_enabled() is False
    assert pm.effective_reactions(True) is False
    assert pm.listener_mode() == "auto"
    assert pm.listener_timeout_sec() == 900.0


def test_offline_test_env_is_conservative():
    assert pm.public_audio_enabled() is False and pm.reactions_enabled() is False
    assert pm.listener_mode() == "still" and pm.listener_timeout_sec() == 60.0


@pytest.mark.parametrize("raw,expected", [
    ("true", True), ("1", True), (" YES ", True), ("on", True),
    ("false", False), ("0", False), ("off", False), ("", False), ("maybe", False),
])
def test_boolean_flags_parse_tolerantly(monkeypatch, raw, expected):
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", raw)
    monkeypatch.setenv("PODCAST_REACTIONS", raw)
    assert pm.public_audio_enabled() is expected
    assert pm.reactions_enabled() is expected


def test_effective_reactions_needs_request_and_kill_switch(monkeypatch):
    monkeypatch.setenv("PODCAST_REACTIONS", "true")
    assert pm.effective_reactions(True) is True
    assert pm.effective_reactions(False) is False
    monkeypatch.setenv("PODCAST_REACTIONS", "false")
    assert pm.effective_reactions(True) is False


@pytest.mark.parametrize("raw,expected", [
    ("auto", "auto"), ("idle_loop", "idle_loop"), (" Idle-Loop ", "idle_loop"),
    ("PROCEDURAL", "procedural"), ("still", "still"), ("", "auto"), ("video", "auto"),
])
def test_listener_mode_parsing(monkeypatch, raw, expected):
    monkeypatch.setenv("PODCAST_LISTENER_MODE", raw)
    assert pm.listener_mode() == expected


@pytest.mark.parametrize("raw,expected", [
    ("120", 120.0), ("45.5", 45.5), ("30", 30.0), ("5", 30.0), ("-1", 30.0),
    ("", 900.0), ("abc", 900.0), ("nan", 900.0), ("inf", 900.0),
])
def test_listener_timeout_parsing(monkeypatch, raw, expected):
    monkeypatch.setenv("PODCAST_LISTENER_TIMEOUT_SEC", raw)
    assert pm.listener_timeout_sec() == expected
