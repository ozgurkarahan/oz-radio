"""Pure tests for the radio mix (services/podcast_radio.py) and the cover art
(services/podcast_cover.py): timing, levels, graphs, metadata, transcript and
SRT shaping. No ffmpeg needed — the real renders are in
``test_podcast_radio_smoke.py``.
"""

from __future__ import annotations

import json
import math
import re
import statistics
import struct
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

# Make `services.*` importable when pytest is run from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services import podcast_cover as pc  # noqa: E402
from services import podcast_radio as pr  # noqa: E402
from services.podcast_media import ReactionClip, ReactionPlacement  # noqa: E402
from services.podcast_models import (  # noqa: E402
    PodcastHost, RenderRoles, RoleConfig, Transcript,
)

SR = pr.SAMPLE_RATE
HOSTS = [PodcastHost(role="expert", display_name="Lucas", avatar_id="photo_male"),
         PodcastHost(role="interviewer", display_name="Sofia", avatar_id="photo_female")]

# Filters the radio graphs may use: all present in FFmpeg 5.1 and 7.1.
ALLOWED_FILTERS = {
    "atrim", "asetpts", "afade", "pan", "apad", "concat", "adelay", "amix", "anull", "asplit",
    "volume", "alimiter", "aresample", "aformat", "sidechaincompress",
}


def _filter_names(graph: str) -> set[str]:
    names = set()
    for chain in graph.split(";"):
        for part in chain.split(","):
            names.add(re.sub(r"^(\[[^\]]*\])+", "", part).split("=", 1)[0].split("[", 1)[0])
    return names


# ---------------------------------------------------------------------------
# Gaps and panning
# ---------------------------------------------------------------------------

def test_gaps_are_deterministic_per_seed_and_bounded():
    speakers = ["interviewer", "expert"] * 20 + ["expert"]
    gaps = pr.turn_gaps(speakers, "job-1")
    assert gaps == pr.turn_gaps(speakers, "job-1")
    assert gaps != pr.turn_gaps(speakers, "job-2")
    assert len(gaps) == len(speakers) - 1
    changes = gaps[:-1]
    assert all(pr.GAP_MIN_SEC <= g <= pr.GAP_MAX_SEC for g in changes)
    assert gaps[-1] == pr.SAME_SPEAKER_GAP_SEC           # expert → expert continuation


def test_gap_distribution_is_natural():
    gaps = pr.turn_gaps(["interviewer", "expert"] * 1500, "stats")
    assert statistics.mean(gaps) == pytest.approx(pr.GAP_MEAN_SEC, abs=0.01)
    assert 0.04 < statistics.pstdev(gaps) < 0.07
    assert min(gaps) >= 0.120 and max(gaps) <= 0.350
    assert len({round(g, 4) for g in gaps}) > 100          # varied, not a constant


def test_single_turn_has_no_gap():
    assert pr.turn_gaps(["expert"], "x") == []


def test_constant_power_pan():
    for pan in (-1.0, -0.15, 0.0, 0.15, 1.0):
        left, right = pr.pan_gains(pan)
        assert left ** 2 + right ** 2 == pytest.approx(1.0)
    left, right = pr.pan_gains(pr.PAN["interviewer"])
    assert left > right > 0.5
    left, right = pr.pan_gains(pr.PAN["expert"])
    assert right > left > 0.5
    assert pr.pan_gains(0.0)[0] == pytest.approx(pr.pan_gains(0.0)[1])
    assert pr.PAN["interviewer"] == -pr.PAN["expert"] and abs(pr.PAN["expert"]) <= 0.25


# ---------------------------------------------------------------------------
# Speech detection
# ---------------------------------------------------------------------------

SILENCE_LOG = """
[silencedetect @ 0x1] silence_start: -0.00133333
[silencedetect @ 0x1] silence_end: 0.262854 | silence_duration: 0.264188
[silencedetect @ 0x1] silence_start: 1.84
[silencedetect @ 0x1] silence_end: 2.79 | silence_duration: 0.95
[silencedetect @ 0x1] silence_start: 4.4125
"""


def test_parse_silences_clamps_and_keeps_open_tail():
    assert pr.parse_silences(SILENCE_LOG) == [(0.0, 0.262854), (1.84, 2.79), (4.4125, None)]
    assert pr.parse_silences("") == []


def test_speech_bounds_ignore_internal_pauses():
    assert pr.speech_bounds(pr.parse_silences(SILENCE_LOG), 4.6) == (0.262854, 4.4125)
    # Trailing silence reported with an end at EOF (newer ffmpeg).
    assert pr.speech_bounds([(0.0, 0.3), (2.0, 2.5)], 2.5) == (0.3, 2.0)
    # No leading silence long enough to be reported: onset stays at 0.
    assert pr.speech_bounds([(1.9, None)], 2.5) == (0.0, 1.9)
    assert pr.speech_bounds([], 2.5) == (0.0, 2.5)


def test_speech_bounds_none_when_silent_or_empty():
    assert pr.speech_bounds([(0.0, None)], 2.0) is None
    assert pr.speech_bounds([(0.0, 1.995)], 2.0) is None
    assert pr.speech_bounds([], 0.0) is None


def test_detect_span_in_samples_and_untrimmed_fallback():
    span = pr.detect_span(4 * SR, [(0.0, 0.25), (3.5, None)])
    assert (span.onset, span.offset, span.detected) == (12000, 168000, True)
    silent = pr.detect_span(SR, [(0.0, None)])
    assert (silent.onset, silent.offset, silent.detected) == (0, SR, False)


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------

SPANS = [
    pr.TurnSpan(frames=96000, onset=14400, offset=72000),     # 0.30 → 1.50 s of 2 s
    pr.TurnSpan(frames=144000, onset=12000, offset=120000),   # 0.25 → 2.50 s of 3 s
    pr.TurnSpan(frames=48000, onset=4800, offset=43200),      # 0.10 → 0.90 s of 1 s
]
SPEAKERS = ["interviewer", "expert", "interviewer"]


def _slots(gaps=(0.30, 0.15)):
    return pr.plan_timeline([10, 11, 12], SPEAKERS, SPANS, list(gaps))


def test_timeline_places_words_exactly_one_gap_apart():
    slots = _slots()
    assert [s.turn_idx for s in slots] == [10, 11, 12]
    assert slots[1].onset - slots[0].offset == round(0.30 * SR)
    assert slots[2].onset - slots[1].offset == round(0.15 * SR)
    for prev, cur in zip(slots, slots[1:]):
        assert cur.bus_start == prev.bus_start + prev.length + prev.pad_after


def test_timeline_keeps_preroll_and_tail_and_never_cuts_speech():
    s0, s1, s2 = _slots()
    # Wide gap: nominal 80 ms pre-roll / 120 ms tail, silence inserted after turn 0.
    assert (s0.src_start, s0.src_end, s0.pad_after) == (14400 - 3840, 72000 + 5760, 4800)
    assert s0.onset - s0.bus_start == round(pr.PREROLL_SEC * SR)
    # 150 ms gap < 120 + 80 ms: tail and pre-roll shrink proportionally (still silence only).
    assert (s1.src_end - 120000, 4800 - s2.src_start) == (4320, 2880)
    assert s1.pad_after == 0
    # The last turn rings out up to LAST_TAIL_SEC (here limited by the clip end).
    assert s2.src_end == 48000
    for slot, span in zip((s0, s1, s2), SPANS):
        assert 0 <= slot.src_start <= span.onset and span.offset <= slot.src_end <= span.frames
        assert slot.offset - slot.onset == span.offset - span.onset


def test_timeline_untrimmed_when_detection_failed():
    spans = [pr.TurnSpan(48000, 0, 48000, detected=False), SPANS[1]]
    s0, s1 = pr.plan_timeline([0, 1], ["interviewer", "expert"], spans, [0.24])
    assert (s0.src_start, s0.src_end) == (0, 48000)
    assert s0.pad_after == round(0.24 * SR) - 3840          # only the next pre-roll is kept
    assert s1.onset - s0.offset == round(0.24 * SR)


def test_timeline_rejects_mismatched_inputs():
    with pytest.raises(ValueError):
        pr.plan_timeline([0, 1], SPEAKERS, SPANS, [0.2])


def test_reaction_absolute_start_includes_the_lead_trim():
    # at_sec is relative to the untrimmed turn audio; 170 ms of lead were trimmed.
    assert pr.reaction_mix_start(1.5, 0.17, 1.4) == pytest.approx(2.73)
    s1 = _slots()[1]
    clip = ReactionClip(reaction_id="ack", text="Mm-hmm.", audio_path=Path(__file__),
                        video_path=None, duration_sec=0.35)
    placed, skipped = pr.map_reactions(
        [ReactionPlacement(turn_idx=11, listener="interviewer", reaction_id="ack",
                           at_sec=1.4, duration_sec=0.35, gain_db=-4.0)],
        _slots(), {"interviewer": {"ack": clip}})
    assert skipped == 0 and len(placed) == 1
    r = placed[0]
    assert r.bus_start == s1.bus_start + round(1.4 * SR) - s1.src_start
    assert r.bus_start / SR == pytest.approx(pr.reaction_mix_start(s1.bus_start / SR, s1.src_start / SR, 1.4))
    assert (r.listener, r.text, r.gain_db, r.duration_sec) == ("interviewer", "Mm-hmm.", -4.0, 0.35)


def test_reactions_that_cannot_be_mixed_are_skipped(tmp_path):
    clip = ReactionClip(reaction_id="ack", text="Mm-hmm.", audio_path=Path(__file__),
                        video_path=None, duration_sec=0.35)
    gone = ReactionClip(reaction_id="yeah", text="Yeah.", audio_path=tmp_path / "missing.wav",
                        video_path=None, duration_sec=0.3)

    def at(turn, listener, rid, sec):
        return ReactionPlacement(turn_idx=turn, listener=listener, reaction_id=rid, at_sec=sec, duration_sec=0.35)

    placements = [
        at(11, "expert", "ack", 1.4),          # the speaker cannot react to itself
        at(11, "interviewer", "right", 1.4),   # no such clip
        at(11, "interviewer", "yeah", 1.4),    # clip file missing
        at(99, "interviewer", "ack", 1.4),     # unknown turn
        at(11, "interviewer", "ack", 0.05),    # inside the trimmed lead
        at(11, "interviewer", "ack", 2.55),    # runs past the kept audio
    ]
    clips = {"interviewer": {"ack": clip, "yeah": gone}, "expert": {"ack": clip}}
    placed, skipped = pr.map_reactions(placements, _slots(), clips)
    assert placed == [] and skipped == len(placements)


def test_program_layout_with_and_without_logo():
    slots = _slots()
    bus_len = slots[-1].bus_start + slots[-1].length
    layout = pr.plan_program(slots, [], bus_len, intro_len=96000, outro_len=72000)
    first_word = (layout.voice_offset + slots[0].onset) / SR
    assert first_word == pytest.approx(2.0 - pr.INTRO_UNDER_SPEECH_SEC)
    last_word = (layout.voice_offset + slots[-1].offset) / SR
    assert layout.outro_start / SR == pytest.approx(last_word + pr.OUTRO_AFTER_SPEECH_SEC)
    assert layout.total == layout.outro_start + 72000
    plain = pr.plan_program(slots, [], bus_len, intro_len=None, outro_len=None)
    assert (plain.voice_offset + slots[0].onset) / SR == pytest.approx(pr.LEAD_IN_SEC)
    assert plain.outro_start is None and plain.total == plain.voice_offset + bus_len


def test_outro_waits_for_a_late_reaction():
    slots = _slots()
    bus_len = slots[-1].bus_start + slots[-1].length
    late = pr.PlacedReaction(turn_idx=12, listener="expert", reaction_id="ack", text="Mm-hmm.",
                             audio_path=Path("x.wav"), bus_start=slots[-1].offset, duration_sec=0.5, gain_db=-4)
    layout = pr.plan_program(slots, [late], bus_len, intro_len=96000, outro_len=72000)
    assert layout.outro_start == layout.voice_offset + slots[-1].offset + round(0.5 * SR) + round(
        pr.OUTRO_AFTER_SPEECH_SEC * SR)


# ---------------------------------------------------------------------------
# Levels
# ---------------------------------------------------------------------------

def test_turns_are_levelled_to_a_common_loudness():
    gains = pr.level_gains(["interviewer", "expert", "expert", "interviewer"], [-24.0, -18.0, None, -60.0])
    assert gains[0] == pytest.approx(pr.TURN_LEVEL_LUFS + 24.0)
    assert gains[1] == pytest.approx(pr.TURN_LEVEL_LUFS + 18.0)
    assert gains[2] == gains[1]                                   # unknown: borrows its voice's gain
    assert gains[3] == pr.TURN_GAIN_RANGE_DB[1]                   # clamped
    assert pr.level_gains(["expert"], [None]) == [0.0]
    voices = pr.voice_gains(["interviewer", "expert", "interviewer"], [2.0, -1.0, 4.0])
    assert voices == {"interviewer": 3.0, "expert": -1.0}


def test_combined_loudness_is_an_energy_average():
    assert pr.combined_loudness([(1.0, -20.0), (1.0, -20.0)]) == pytest.approx(-20.0)
    assert pr.combined_loudness([(1.0, -20.0), (1.0, None)]) == pytest.approx(-20.0)
    assert pr.combined_loudness([(1.0, -20.0), (1.0, -30.0)]) == pytest.approx(
        10 * math.log10((10 ** -2 + 10 ** -3) / 2))
    assert pr.combined_loudness([(1.0, None)]) is None


# ---------------------------------------------------------------------------
# Loudness measurement parsing
# ---------------------------------------------------------------------------

LOUDNORM_LOG = """
[Parsed_loudnorm_0 @ 0x55]
{
	"input_i" : "-21.69",
	"input_tp" : "-4.34",
	"input_lra" : "7.60",
	"input_thresh" : "-31.95",
	"output_i" : "-16.02",
	"output_tp" : "-1.50",
	"output_lra" : "6.10",
	"output_thresh" : "-26.25",
	"normalization_type" : "dynamic",
	"target_offset" : "0.02"
}
"""


def test_loudnorm_json_and_linear_feasibility():
    data = pr.parse_loudnorm_json(LOUDNORM_LOG)
    assert data["normalization_type"] == "dynamic"
    stats = pr.loudnorm_stats(data)
    assert stats == pr.LoudnormStats(i=-21.69, tp=-4.34, lra=7.6, thresh=-31.95, offset=0.02)
    # +5.69 dB of gain would put the true peak at +1.35 dBTP: linear is unreachable.
    assert not pr.linear_feasible(stats)
    assert pr.linear_feasible(pr.LoudnormStats(i=-19.3, tp=-5.5, lra=8.3, thresh=-30.0, offset=0.15))
    assert not pr.linear_feasible(pr.LoudnormStats(i=-19.3, tp=-5.5, lra=12.0, thresh=-30.0, offset=0.15))
    assert pr.loudnorm_stats({**data, "input_i": "-inf"}) is None
    assert pr.loudnorm_stats({"input_i": "-20"}) is None
    assert pr.parse_loudnorm_json("no json here") is None


def test_loudnorm_filters():
    assert pr.loudnorm_filter(None) == "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json"
    second = pr.loudnorm_filter(pr.LoudnormStats(i=-19.29, tp=-5.5, lra=8.3, thresh=-29.96, offset=0.15))
    assert second == ("loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-19.29:measured_TP=-5.50:measured_LRA=8.30"
                      ":measured_thresh=-29.96:offset=0.15:linear=true:print_format=json")
    chain = pr.limiter_chain(3.0)
    assert chain.startswith("volume=3.00dB,alimiter=limit=0.5309:") and chain.endswith(":level=0")
    assert "limit=0.0631" in pr.limiter_chain(0.0, -40.0)           # clamped to alimiter's range


def test_ebur128_summary_parsing():
    log = "[Parsed_ebur128_4 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -22.4 LUFS\n"
    assert pr.parse_ebur128_integrated(log) == pytest.approx(-22.4)
    assert pr.parse_ebur128_integrated(log.replace("-22.4", "-70.0")) is None
    assert pr.parse_ebur128_integrated("frame log only I: -20.0 LUFS") is None


# ---------------------------------------------------------------------------
# Graphs and encode arguments
# ---------------------------------------------------------------------------

def test_voice_bus_graph():
    slots = _slots()
    reaction = pr.PlacedReaction(turn_idx=11, listener="interviewer", reaction_id="ack", text="Mm-hmm.",
                                 audio_path=Path("a.wav"), bus_start=131040, duration_sec=0.35, gain_db=-4.0)
    graph = pr.voice_bus_graph(slots, [(3, reaction)], turn_gains=[2.0, 0.0, -1.0],
                               listener_gains={"interviewer": 2.0})
    assert _filter_names(graph) <= ALLOWED_FILTERS
    assert "[0:a]atrim=start_sample=10560:end_sample=77760,asetpts=N/SR/TB" in graph
    assert "apad=pad_len=4800[t0]" in graph and "[t0][t1][t2]concat=n=3:v=0:a=1[speech]" in graph
    left, right = pr.pan_gains(pr.PAN["interviewer"])
    g = 10 ** (2.0 / 20)
    assert f"pan=stereo|c0={left * g:.6f}*c0|c1={right * g:.6f}*c0" in graph        # turn 0: +2 dB
    g = 10 ** (-2.0 / 20)                                                             # −4 placement + 2 voice
    assert f"[3:a]pan=stereo|c0={left * g:.6f}*c0|c1={right * g:.6f}*c0,adelay=delays=131040S|131040S[r0]" in graph
    assert graph.endswith("[speech][r0]amix=inputs=2:normalize=0:duration=first[voice]")
    plain = pr.voice_bus_graph(slots, [])
    assert plain.endswith("concat=n=3:v=0:a=1[voice]") and "amix" not in plain


def test_program_graph():
    layout = pr.ProgramLayout(voice_offset=77760, total=386400, outro_start=314400)
    graph = pr.program_graph(layout, intro_gain_db=6.0, outro_gain_db=5.5,
                             bed=pr.BedSpec(gain_db=-30.0, level_sc=1.2), pre_gain_db=1.0)
    assert _filter_names(graph) <= ALLOWED_FILTERS
    assert graph.startswith("[1:a]adelay=delays=77760S|77760S,asplit=2[v][sc]")
    assert "[2:a]volume=6.00dB[ji]" in graph
    assert "[3:a]volume=5.50dB,adelay=delays=314400S|314400S[jo]" in graph
    assert "[sc]apad=whole_len=386400[scp]" in graph and "sidechaincompress=" in graph
    assert "[0:a][v][ji][jo][bed]amix=inputs=5:normalize=0:duration=first,atrim=end_sample=386400" in graph
    assert "alimiter=limit=0.5309" in graph and ":level=0" in graph
    plain = pr.program_graph(pr.ProgramLayout(voice_offset=0, total=1000))
    assert plain.startswith("[1:a]anull[v];[0:a][v]amix=inputs=2:normalize=0") and "alimiter" not in plain


def test_mp3_encode_args_allow_list_and_reencoded_cover():
    meta = pr.id3_metadata("Episode", HOSTS, "fr-FR", 2026)
    args = pr.mp3_encode_args(Path("p.wav"), Path("c.jpg"), Path("o.mp3"), "loudnorm=I=-16", {**meta, "voice": "x"})
    joined = " ".join(args)
    assert "-c:a libmp3lame -b:a 128k -ar 44100 -ac 2" in joined
    assert "-c:v mjpeg" in joined and "copy" not in args          # stream copy would carry EXIF
    assert "-disposition:v:0 attached_pic" in joined and "-map 1:v:0" in joined
    assert "-id3v2_version 3 -write_id3v1 0" in joined and "-map_metadata -1" in joined
    assert "-fflags +bitexact" in joined                          # no TSSE encoder tag
    keys = [args[i + 1].split("=", 1)[0] for i, a in enumerate(args) if a == "-metadata"]
    assert keys == list(pr.ID3_KEYS)
    assert args[-1] == "o.mp3" and args[-3:-1] == ["-f", "mp3"]
    no_cover = pr.mp3_encode_args(Path("p.wav"), None, Path("o.mp3"), "anull", meta)
    assert "1:v:0" not in no_cover and "-c:v" not in no_cover


# ---------------------------------------------------------------------------
# ID3 metadata
# ---------------------------------------------------------------------------

def test_id3_metadata_is_an_allow_list():
    meta = pr.id3_metadata("Les données — épisode 1", HOSTS, "fr-FR", 2026)
    assert list(meta) == list(pr.ID3_KEYS)
    assert meta == {
        "title": "Les données — épisode 1",
        "artist": "Sofia & Lucas",                # interviewer first
        "album_artist": "Oz Radio",
        "album": "Oz Radio Podcasts",
        "genre": "Podcast",
        "date": "2026",
        "language": "fra",
        "comment": "AI-generated voices",
    }


def test_id3_metadata_sanitizes_and_falls_back():
    hosts = [PodcastHost(role="interviewer", display_name="Ann\nLee\u202e"),
             PodcastHost(role="expert", display_name="Ann Lee")]
    meta = pr.id3_metadata("  Title\twith\r\ncontrols\x00 " + "x" * 300, hosts, "xx", 2026)
    assert meta["title"].startswith("Title with controls x") and len(meta["title"]) <= pr.ID3_TITLE_MAX
    assert meta["artist"] == "Ann Lee"           # de-duplicated
    assert meta["language"] == "und"
    empty = pr.id3_metadata("", [], "en-US", 2026)
    assert empty["title"] == "Oz Radio" and empty["artist"] == "Oz Radio"


@pytest.mark.parametrize("language,code", [
    ("en-US", "eng"), ("fr-FR", "fra"), ("es-ES", "spa"), ("de-DE", "deu"), ("it-IT", "ita"),
    ("pt-BR", "por"), ("zh-CN", "zho"), ("ja-JP", "jpn"), ("en-GB", "eng"), ("fr_CA", "fra"),
    ("FR", "fra"), ("", "und"), ("nl-NL", "und"),
])
def test_iso_639_2_codes(language, code):
    assert pr.iso639_2(language) == code


def test_hosts_from_roles_never_carry_voices():
    roles = RenderRoles(
        interviewer=RoleConfig(display_name="Sofia", avatar="", voice="en-US-Secret:DragonHDLatestNeural"),
        expert=RoleConfig(display_name="Lucas", avatar="photo_male", voice="en-US-Other:DragonHDLatestNeural"),
    )
    hosts = pr.ordered_hosts([], roles)
    assert [(h.role, h.display_name, h.avatar_id) for h in hosts] == [
        ("interviewer", "Sofia", None), ("expert", "Lucas", "photo_male")]
    assert [h.role for h in pr.ordered_hosts(HOSTS, roles)] == ["interviewer", "expert"]
    assert "Secret" not in json.dumps([h.model_dump() for h in hosts])


# ---------------------------------------------------------------------------
# Peaks, cues, transcript, SRT
# ---------------------------------------------------------------------------

def test_peaks_are_normalized_with_a_sqrt_curve():
    samples = np.concatenate([np.full(1000, 16384), np.full(1000, -32768), np.zeros(400)]).astype(np.int16)
    peaks = pr.compute_peaks(samples, buckets=6)
    assert len(peaks) == 6 and max(peaks) == 1.0 and min(peaks) == 0.0
    assert peaks[0] == pytest.approx(math.sqrt(0.5), abs=1e-3)   # half amplitude → ≈ 0.707
    assert pr.compute_peaks(np.zeros(100, dtype=np.int16)) == [0.0] * pr.PEAK_BUCKETS
    assert pr.compute_peaks(np.array([], dtype=np.int16)) == [0.0] * pr.PEAK_BUCKETS
    short = pr.compute_peaks(np.array([5, -10], dtype=np.int16))
    assert len(short) == pr.PEAK_BUCKETS and max(short) == 1.0


def test_speech_cues_are_chunked_and_timed_by_words():
    text = ("Natural turn-taking is fast. Most gaps between speakers sit around two hundred milliseconds, "
            "with a lot of variance. That is why we randomize them!")
    cues = pr.speech_cues(text, 10.0, 18.0, speaker="expert", turn_idx=3)
    assert len(cues) >= 2
    assert cues[0].start == 10.0 and cues[-1].end == 18.0
    for prev, cur in zip(cues, cues[1:]):
        assert prev.end == cur.start
    for cue in cues:
        assert 10.0 <= cue.start < cue.end <= 18.0
        assert len(cue.text) <= 80 and cue.kind == "speech" and cue.speaker == "expert" and cue.turn_idx == 3
    assert " ".join(c.text for c in cues).split() == text.split()
    words = [len(c.text.split()) for c in cues]
    durations = [c.end - c.start for c in cues]
    assert durations[0] / durations[1] == pytest.approx(words[0] / words[1], rel=0.01)
    assert pr.speech_cues("", 0.0, 1.0, speaker="expert", turn_idx=0) == []
    assert pr.speech_cues("Hi.", 1.0, 1.0, speaker="expert", turn_idx=0) == []


def _transcript():
    slots = _slots()
    reaction = pr.PlacedReaction(turn_idx=11, listener="interviewer", reaction_id="ack", text="Mm-hmm.",
                                 audio_path=Path("a.wav"), bus_start=131040, duration_sec=0.35, gain_db=-4.0)
    texts = {10: "Welcome to the show. Today we talk about radio.", 11: "Thanks. Timing is everything.",
             12: "Indeed."}
    return pr.build_transcript(
        slots, [reaction], voice_offset=77760, duration_sec=386400 / SR, texts=texts, hosts=HOSTS[::-1],
        peaks=[0.0, 1.0], video_offsets={10: (2.0, 3.6), 11: (3.6, 6.7)},
    )


def test_transcript_turns_are_ordered_and_non_overlapping():
    transcript = _transcript()
    turns = transcript.turns
    assert [t.turn_idx for t in turns] == [10, 11, 12] and [t.speaker for t in turns] == SPEAKERS
    assert turns[0].start == pytest.approx(2.0 - pr.INTRO_UNDER_SPEECH_SEC)
    for prev, cur in zip(turns, turns[1:]):
        assert prev.start < prev.end < cur.start < cur.end
    assert (turns[0].video_start, turns[0].video_end) == (2.0, 3.6)
    assert (turns[2].video_start, turns[2].video_end) == (None, None)
    assert transcript.duration_sec == pytest.approx(386400 / SR)


def test_transcript_cues_speech_and_reaction():
    transcript = _transcript()
    speech = [c for c in transcript.cues if c.kind == "speech"]
    by_turn = {t.turn_idx: t for t in transcript.turns}
    for cue in speech:
        turn = by_turn[cue.turn_idx]
        assert turn.start <= cue.start < cue.end <= turn.end and cue.speaker == turn.speaker
    assert [c.start for c in transcript.cues] == sorted(c.start for c in transcript.cues)
    (ack,) = [c for c in transcript.cues if c.kind == "reaction"]
    assert (ack.speaker, ack.turn_idx, ack.text) == ("interviewer", 11, "Mm-hmm.")
    assert ack.start == pytest.approx((77760 + 131040) / SR, abs=1e-3)
    assert ack.end == pytest.approx(ack.start + 0.35, abs=1e-3)
    assert by_turn[11].start < ack.start < ack.end < by_turn[11].end


def test_transcript_round_trips_as_json():
    transcript = _transcript()
    text = json.dumps(transcript.model_dump(mode="json"), ensure_ascii=False)
    assert Transcript.model_validate_json(text) == transcript


def test_srt_matches_the_video_srt_style():
    cues = _transcript().cues
    srt = pr.srt_text(cues, {"interviewer": "Sofia", "expert": "Lucas"})
    blocks = srt.strip("\n").split("\n\n")
    speech = [c for c in cues if c.kind == "speech"]
    assert len(blocks) == len(speech)                       # reactions are not in the SRT
    first = blocks[0].split("\n")
    assert first[0] == "1"
    assert re.fullmatch(r"\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}", first[1])
    assert first[2] == f"Sofia: {speech[0].text}"
    assert srt.endswith("\n") and "Mm-hmm." not in srt


# ---------------------------------------------------------------------------
# WAV header
# ---------------------------------------------------------------------------

def test_wav_frames_from_pcm_and_float_wavs(tmp_path):
    pcm = tmp_path / "pcm.wav"
    with wave.open(str(pcm), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"\x00" * 4 * 1234)
    assert pr.wav_frames(pcm) == 1234
    # IEEE float mono with a fact chunk and an odd-sized LIST chunk before the data.
    data = b"\x00" * 4 * 777
    fmt = struct.pack("<HHIIHH", 3, 1, SR, SR * 4, 4, 32)
    chunks = (b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"fact" + struct.pack("<I", 4) + struct.pack("<I", 777)
              + b"LIST" + struct.pack("<I", 3) + b"abc\x00" + b"data" + struct.pack("<I", len(data)) + data)
    flt = tmp_path / "float.wav"
    flt.write_bytes(b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks)
    assert pr.wav_frames(flt) == 777
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"not a wav")
    with pytest.raises(ValueError):
        pr.wav_frames(bad)


# ---------------------------------------------------------------------------
# Entry-point guards (no ffmpeg needed)
# ---------------------------------------------------------------------------

def test_mix_radio_needs_turns_and_ffmpeg(monkeypatch, tmp_path):
    kwargs = dict(title="t", language="en-US", out_dir=tmp_path, intro=True, seed="s")
    with pytest.raises(ValueError):
        pr.mix_radio([], [], {}, None, None, [], **kwargs)
    from services.podcast_media import TurnAudio

    monkeypatch.setattr(pr.shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="ffmpeg"):
        pr.mix_radio([TurnAudio(0, "expert", tmp_path / "t.wav", "tts")], [], {}, None, None, [], **kwargs)
    assert list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------
# Cover art
# ---------------------------------------------------------------------------

def _green_avatar(path: Path) -> Path:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (512, 512), (0, 255, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((156, 60, 356, 300), fill=(198, 140, 110))
    draw.rectangle((120, 300, 392, 512), fill=(40, 60, 120))
    img.save(path)
    return path


def _photo(path: Path) -> Path:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (600, 800), (200, 190, 170))
    ImageDraw.Draw(img).ellipse((200, 150, 400, 400), fill=(150, 100, 80))
    img.save(path, "JPEG")
    return path


def _green_share(img, box) -> float:
    region = np.asarray(img.crop(box).convert("RGB"), dtype=np.int16)
    r, g, b = region[..., 0], region[..., 1], region[..., 2]
    return float(((g > 150) & (r < 100) & (b < 100)).mean())


def test_cover_with_keyed_and_plain_portraits(tmp_path):
    from PIL import Image

    out = pc.make_cover("How generative AI reshapes customer relations in construction", HOSTS,
                        tmp_path / "cover.jpg",
                        avatar_images={"interviewer": _green_avatar(tmp_path / "g.png"),
                                       "expert": _photo(tmp_path / "p.jpg")})
    with Image.open(out) as img:
        assert img.format == "JPEG" and img.size == (1400, 1400)
        rgb = img.convert("RGB")
    cx = pc.COVER_SIZE // 2 - pc.PORTRAIT_DX
    disc = (cx - 150, pc.PORTRAIT_CY - 150, cx + 150, pc.PORTRAIT_CY + 150)
    assert _green_share(rgb, disc) < 0.001                  # green screen keyed out
    face = rgb.getpixel((cx, pc.PORTRAIT_CY - 90))
    assert face[0] > face[2] and face[0] > 120               # the keyed "face" is visible
    corner = rgb.getpixel((cx - 120, pc.PORTRAIT_CY - 120))  # keyed background → disc colour
    assert all(abs(a - b) < 25 for a, b in zip(corner, pc.DISC_BG)), corner
    assert rgb.getpixel((5, 5))[2] < 60                      # dark brand gradient


def test_cover_monograms_without_images(tmp_path):
    from PIL import Image

    out = pc.make_cover("Short", HOSTS, tmp_path / "cover.jpg",
                        avatar_images={"expert": tmp_path / "missing.png"})
    with Image.open(out) as img:
        assert img.size == (1400, 1400)
        px = img.convert("RGB").getpixel((pc.COVER_SIZE // 2 + pc.PORTRAIT_DX, pc.PORTRAIT_CY + 150))
    assert px[0] > px[2] + 40                                # clay monogram disc
    assert pc.initials_of("Sofia Maria Martin") == "SM"
    assert pc.initials_of("  ", "expert") == "E"
    assert pc.initials_of("ann") == "A"


def test_cover_falls_back_on_rendering_errors(monkeypatch, tmp_path):
    from PIL import Image

    def boom(*args, **kwargs):
        raise RuntimeError("font engine exploded")

    monkeypatch.setattr(pc, "render_cover", boom)
    warnings: list[str] = []
    out = pc.make_cover("Title", HOSTS, tmp_path / "cover.jpg", warnings=warnings)
    assert warnings == ["cover_fallback"]
    with Image.open(out) as img:
        assert img.format == "JPEG" and img.size == (1400, 1400)
    assert [p.name for p in tmp_path.iterdir()] == ["cover.jpg"]   # no temp file left behind


def test_cover_omits_cjk_text_without_a_cjk_font(monkeypatch, tmp_path):
    from PIL import Image

    monkeypatch.setattr(pc, "_cjk_font_path", lambda: None)
    assert not pc._drawable("人工智能") and pc._drawable("Données")
    out = pc.make_cover("人工智能如何改变客户关系", [PodcastHost(role="expert", display_name="李明")],
                        tmp_path / "cover.jpg")
    with Image.open(out) as img:
        title_area = np.asarray(img.convert("L").crop((pc.MARGIN, pc.TITLE_TOP, 1290, 700)))
    assert title_area.max() < 120                            # no white title (no tofu boxes)
    assert pc.initials_of("李明", "expert") == "E"


def test_cover_title_wraps_to_three_lines(tmp_path):
    from PIL import Image, ImageDraw

    draw = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    font = pc._font(pc.TITLE_SIZES[-1], bold=True)
    lines = pc.wrap_text(draw, "word " * 200, font, 1180, max_lines=3)
    assert len(lines) == 4                                   # stops once overflow is known
    long_word = pc.wrap_text(draw, "A" * 300, font, 1180)
    assert all(draw.textlength(line, font=font) <= 1180 for line in long_word)
    assert "".join(long_word) == "A" * 300
    out = pc.make_cover("Supercalifragilistic " * 30, HOSTS, tmp_path / "c.jpg")
    with Image.open(out) as img:
        assert img.size == (1400, 1400)


def test_green_screen_detection():
    from PIL import Image

    assert pc.is_green_screen(Image.new("RGB", (64, 64), (0, 255, 0)))
    assert pc.is_green_screen(Image.new("RGB", (64, 64), (20, 230, 30)))
    assert not pc.is_green_screen(Image.new("RGB", (64, 64), (200, 190, 170)))
    keyed = pc.key_green(Image.new("RGB", (32, 32), (0, 255, 0)))
    assert keyed.mode == "RGBA" and keyed.getchannel("A").getextrema()[1] < 5
