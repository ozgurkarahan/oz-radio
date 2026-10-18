"""Listener backchannels: script hints, planning on the text, placement in measured pauses."""
from __future__ import annotations

import math
import random
import shutil
import struct
import subprocess
import wave
from pathlib import Path

import pytest

from services import avatar
from services import podcast_media as pm
from services import podcast_reactions as pr
from services.podcast_models import DialogueTurn, Document, ReactionHint, ScriptRequest, Section

LOCALES = ("en-US", "fr-FR", "es-ES", "de-DE", "it-IT", "pt-BR", "zh-CN", "ja-JP")
FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")

# 3 sentences, 31 words (~12 s at 2.6 words/s).
LONG = ("Most teams do not fail because the model is weak at all. They fail because nobody owns the "
        "workflow around it every single day. That is the part we fix first.")
# 2 sentences, 14 words (~5.4 s): turns close enough for the 20 s rule to matter.
SHORT = "We start with one process only. Then we measure it twice before anything else."


def _turns(n: int, text: str = LONG, hints: dict[int, ReactionHint] | None = None) -> list[DialogueTurn]:
    return [DialogueTurn(idx=i, speaker="interviewer" if i % 2 == 0 else "expert", text=text,
                         reaction=(hints or {}).get(i)) for i in range(n)]


def _reaction_times(turns: list[DialogueTurn], planned: list[pm.PlannedReaction]) -> list[float]:
    """Estimated episode time of each planned reaction (documented timeline model)."""
    start, clock = {}, 0.0
    for t in sorted(turns, key=lambda t: t.idx):
        start[t.idx] = clock
        clock += pr.SSML_LEAD_SEC + pr.estimate_speech_sec(t.text) + pr.TURN_GAP_SEC
    by_idx = {t.idx: t for t in turns}
    return [start[p.turn_idx] + pr.SSML_LEAD_SEC + pr.estimate_speech_sec(
        " ".join(pr.split_sentences(by_idx[p.turn_idx].text)[:p.after_sentence])) for p in planned]


def _assert_density(turns: list[DialogueTurn], planned: list[pm.PlannedReaction]) -> None:
    order = [t.idx for t in sorted(turns, key=lambda t: t.idx)]
    pos = {idx: i for i, idx in enumerate(order)}
    by_idx = {t.idx: t for t in turns}
    assert len(planned) <= pr.MAX_PER_EPISODE
    assert [p.turn_idx for p in planned] == sorted({p.turn_idx for p in planned})  # sorted, <= 1 per turn
    for p in planned:
        turn = by_idx[p.turn_idx]
        assert 0 < pos[p.turn_idx] < len(order) - 1
        assert 1 <= p.after_sentence < len(pr.split_sentences(turn.text))
        assert pr.word_count(turn.text) >= pr.MIN_WORDS
        assert p.listener != turn.speaker
    for a, b in zip(planned, planned[1:]):
        assert pos[b.turn_idx] - pos[a.turn_idx] > 1
    times = _reaction_times(turns, planned)
    for i, a in enumerate(times):
        for b in times[i + 1:]:
            assert abs(a - b) >= pr.MIN_GAP_SEC


# ---------------------------------------------------------------------------
# Phrase + pause tables
# ---------------------------------------------------------------------------
def test_every_locale_has_text_and_pause_for_every_id():
    assert set(pm.REACTION_PHRASES) == set(pm.REACTION_PAUSE_MS) == set(LOCALES)
    for locale in LOCALES:
        for rid in pm.REACTION_IDS:
            assert pm.reaction_text(locale, rid).strip()
            ms = pm.reaction_pause_ms(locale, rid)
            assert isinstance(ms, int) and 350 <= ms <= 1200 and ms % 10 == 0, (locale, rid)
            budget = pm.reaction_clip_budget_sec(locale, rid)
            assert budget == pytest.approx(ms / 1000 + pm.MIN_BOUNDARY_SILENCE_SEC - 2 * pm.REACTION_MARGIN_SEC)
    assert set(pm.DEFAULT_REACTION_PAUSE_MS) == set(pm.REACTION_IDS)


def test_reaction_pause_falls_back_by_locale_then_id(monkeypatch):
    assert pm.reaction_pause_ms("fr", "isee") == pm.REACTION_PAUSE_MS["fr-FR"]["isee"]
    assert pm.reaction_pause_ms("ko-KR", "right") == pm.REACTION_PAUSE_MS["en-US"]["right"]
    monkeypatch.setitem(pm.REACTION_PAUSE_MS, "de-DE", {})
    assert pm.reaction_pause_ms("de-DE", "exactly") == pm.DEFAULT_REACTION_PAUSE_MS["exactly"]
    with pytest.raises(ValueError):
        pm.reaction_pause_ms("en-US", "lol")


def test_french_backchannels_are_lexical_and_distinct():
    fr = pm.REACTION_PHRASES["fr-FR"]
    assert fr["ack"] != fr["yeah"]
    # Hums were not recognised; these read as questions with the French voices.
    assert not {"Mm-hmm.", "Hum hum.", "D'accord.", "Intéressant.", "C'est ça.", "Ah, oui."} & set(fr.values())


def test_tables_keep_ack_and_yeah_distinct_everywhere():
    for locale, phrases in pm.REACTION_PHRASES.items():
        assert len(set(phrases.values())) == len(pm.REACTION_IDS), locale


# ---------------------------------------------------------------------------
# plan_reactions
# ---------------------------------------------------------------------------
def test_disabled_or_tiny_scripts_plan_nothing():
    assert pr.plan_reactions(_turns(10), "en-US", "job-1", enabled=False) == []
    assert pr.plan_reactions(_turns(2), "en-US", "job-1", enabled=True) == []
    assert pr.plan_reactions([], "en-US", "job-1", enabled=True) == []


def test_kill_switch_wins_over_the_request(monkeypatch):
    hints = {3: ReactionHint(after_sentence=1, reaction_id="exactly")}
    turns = _turns(10, LONG, hints)
    monkeypatch.setenv("PODCAST_REACTIONS", "false")
    assert pr.plan_reactions(turns, "fr-FR", "job-1", enabled=pm.effective_reactions(True)) == []
    monkeypatch.setenv("PODCAST_REACTIONS", "true")
    assert pr.plan_reactions(turns, "fr-FR", "job-1", enabled=pm.effective_reactions(False)) == []
    plan = pr.plan_reactions(turns, "fr-FR", "job-1", enabled=pm.effective_reactions(True))
    assert (3, "exactly") in {(p.turn_idx, p.reaction_id) for p in plan}


def test_plan_is_deterministic_per_seed():
    turns = _turns(16)
    plans = {seed: pr.plan_reactions(turns, "en-US", seed, True) for seed in (f"job-{i}" for i in range(12))}
    for seed, plan in plans.items():
        assert pr.plan_reactions(list(reversed(turns)), "en-US", seed, True) == plan
    assert len({tuple(plan) for plan in plans.values()}) > 1
    assert any(plans.values())


@pytest.mark.parametrize("text", [LONG, SHORT])
def test_neutral_plans_obey_density_rules(text):
    turns = _turns(40, text)
    total = 0
    for i in range(40):
        plan = pr.plan_reactions(turns, "en-US", f"seed-{i}", True)
        _assert_density(turns, plan)
        assert {p.reaction_id for p in plan} <= set(pr.NEUTRAL_REACTION_IDS)
        total += len(plan)
    assert total > 0


def test_short_or_single_sentence_turns_get_nothing():
    few_words = "It works. It ships. We win."  # 3 sentences, 6 words
    one_sentence = ("This single long sentence keeps going with plenty of words but never stops for a "
                    "breath anywhere at all")
    for text in (few_words, one_sentence):
        hints = {i: ReactionHint(after_sentence=1, reaction_id="exactly") for i in range(8)}
        assert pr.plan_reactions(_turns(8, text, hints), "en-US", "job", True) == []


@pytest.mark.parametrize("seed", ["job-a", "job-b", "job-c", "job-d"])
def test_valid_hints_win_for_every_seed(seed):
    hints = {2: ReactionHint(after_sentence=1, reaction_id="exactly"),
             5: ReactionHint(after_sentence=2, reaction_id="interesting"),
             8: ReactionHint(after_sentence=1, reaction_id="isee")}
    turns = _turns(10, LONG, hints)
    plan = pr.plan_reactions(turns, "fr-FR", seed, True)
    assert [(p.turn_idx, p.reaction_id, p.after_sentence, p.listener) for p in plan] == [
        (2, "exactly", 1, "expert"), (5, "interesting", 2, "interviewer"), (8, "isee", 1, "expert")]
    assert [p.pause_ms for p in plan] == [pm.reaction_pause_ms("fr-FR", p.reaction_id) for p in plan]
    _assert_density(turns, plan)


def test_hints_still_obey_density():
    # Consecutive hinted turns: only the first survives, and the hints on the first
    # and last turns are ignored.
    hints = {i: ReactionHint(after_sentence=1, reaction_id="exactly") for i in (0, 3, 4, 9)}
    turns = _turns(10, LONG, hints)
    plan = pr.plan_reactions(turns, "en-US", "job", True)
    hinted = [p for p in plan if p.reaction_id == "exactly"]
    assert [p.turn_idx for p in hinted] == [3]
    _assert_density(turns, plan)
    # Close turns: a hint less than 20 s after another one is dropped.
    close = _turns(10, SHORT, {2: ReactionHint(after_sentence=1, reaction_id="exactly"),
                               4: ReactionHint(after_sentence=1, reaction_id="interesting")})
    plan = pr.plan_reactions(close, "en-US", "job", True)
    assert "interesting" not in {p.reaction_id for p in plan}
    _assert_density(close, plan)
    # Every turn hinted: never more than 6 per episode.
    many = _turns(60, LONG, {i: ReactionHint(after_sentence=1, reaction_id="right") for i in range(60)})
    plan = pr.plan_reactions(many, "en-US", "job", True)
    assert len(plan) == pr.MAX_PER_EPISODE
    _assert_density(many, plan)


def test_hints_are_checked_against_the_real_sentence_count():
    # The splitter only breaks before an upper-case letter, so the LLM's "3 sentences"
    # may really be fewer: hints are validated against what build_ssml will count.
    merged = ("The first idea is simple and it matters a lot for teams. second thought starts in lower "
              "case so the splitter keeps it attached here. Third sentence closes the turn nicely.")
    n = len(pr.split_sentences(merged))
    assert n == 2
    hints = {3: ReactionHint(after_sentence=n, reaction_id="interesting"),
             6: ReactionHint(after_sentence=n + 5, reaction_id="exactly")}
    turns = _turns(10, merged, hints)
    for i in range(20):
        plan = pr.plan_reactions(turns, "en-US", f"job-{i}", True)
        assert not {"interesting", "exactly"} & {p.reaction_id for p in plan}
        assert all(1 <= p.after_sentence < n for p in plan)
        _assert_density(turns, plan)


def test_sentences_are_counted_like_the_ssml_pause_option(monkeypatch):
    text = "One idea here. Another idea there."
    assert pr.split_sentences(text) == avatar._split_sentences(text) == ["One idea here.", "Another idea there."]
    monkeypatch.setattr(avatar, "split_sentences_for_pauses", lambda t: ["a", "b", "c"], raising=False)
    assert pr.split_sentences(text) == ["a", "b", "c"]


def test_cjk_speaking_time_is_estimated_by_characters():
    zh = "人工智能正在改变我们的工作方式"  # 15 CJK characters
    assert pr.estimate_speech_sec(zh) == pytest.approx(15 / pr.CJK_CHARS_PER_SEC)
    assert pr.estimate_speech_sec("今日はAI活用") == pytest.approx(5 / pr.CJK_CHARS_PER_SEC + 1 / pr.WORDS_PER_SEC)
    assert pr.estimate_speech_sec("Hello there, it's a well-known fact.") == pytest.approx(6 / pr.WORDS_PER_SEC)
    assert pr.word_count(zh * 2) == pytest.approx(30 / pr.CJK_CHARS_PER_SEC * pr.WORDS_PER_SEC)


def test_cjk_turns_plan_with_a_cjk_aware_splitter(monkeypatch):
    import re

    monkeypatch.setattr(avatar, "split_sentences_for_pauses",
                        lambda text: [s for s in re.split(r"(?<=[。！？])", text or "") if s.strip()],
                        raising=False)
    text = "我们先从一个流程开始，认真地测量它的效果。然后我们再决定是否扩大到更多的团队和部门。"
    assert len(pr.split_sentences(text)) == 2
    turns = _turns(12, text)
    plans = [pr.plan_reactions(turns, "zh-CN", f"job-{i}", True) for i in range(20)]
    assert any(plans)
    for plan in plans:
        _assert_density(turns, plan)
        assert all(p.pause_ms == pm.reaction_pause_ms("zh-CN", p.reaction_id) for p in plan)


@pytest.mark.skipif(not hasattr(avatar, "split_sentences_for_pauses"), reason="CJK-aware splitter not available")
@pytest.mark.parametrize("language,text", [
    ("zh-CN", "我们先从一个流程开始，认真地测量它的效果。然后我们再决定是否扩大到更多的团队和部门。"),
    ("ja-JP", "まず一つの業務プロセスを選んで、今の状態をしっかり測ります。それから、アシスタントを入れて結果を比べます。"),
])
def test_cjk_turns_get_reactions_with_the_real_pause_splitter(language, text):
    assert pr.split_sentences(text) == avatar.split_sentences_for_pauses(text)
    assert len(pr.split_sentences(text)) == 2
    turns = _turns(12, text)
    plans = [pr.plan_reactions(turns, language, f"job-{i}", True) for i in range(20)]
    assert any(plans)
    for plan in plans:
        _assert_density(turns, plan)


def test_planned_pauses_map_the_plan_for_the_speech_engines():
    plan = pr.plan_reactions(_turns(16), "de-DE", "job-7", True)
    assert plan
    assert pm.planned_pauses(plan) == {
        p.turn_idx: {p.after_sentence: pm.reaction_pause_ms("de-DE", p.reaction_id)} for p in plan}
    needed = pr.needed_reaction_ids(plan)
    assert set(needed) == {p.listener for p in plan}
    for role, ids in needed.items():
        assert ids == [rid for rid in pm.REACTION_IDS if any(
            p.listener == role and p.reaction_id == rid for p in plan)]


# ---------------------------------------------------------------------------
# Script prompt + hint parsing
# ---------------------------------------------------------------------------
def test_prompt_is_radio_safe_and_documents_reaction_ids():
    from services.podcast_script import _build_system_prompt

    doc = Document(id="d", title="T", source_kind="pptx", slide_titles=["Intro"], slide_notes=[""],
                   sections=[Section(text="x")])
    prompt = _build_system_prompt(ScriptRequest(document_id="d"), doc)
    for marker in ("RADIO-SAFE", "audio only", "as you can see", "on this slide", "look at",
                   "`reaction`", "after_sentence", "OTHER host", "at most one reaction per turn",
                   "about one turn in three", "never on the first", "at least 2 sentences",
                   "smaller than the number of sentences"):
        assert marker in prompt, marker
    for rid, meaning in (("ack", "neutral acknowledgement"), ("right", "agreement"),
                         ("yeah", "casual agreement"), ("exactly", "strong agreement"),
                         ("isee", "understanding"), ("interesting", "curiosity")):
        assert f"{rid} ({meaning})" in prompt
    assert prompt.endswith("Return ONLY the JSON object, no prose before or after.")


@pytest.mark.parametrize("raw,expected", [
    ({"after_sentence": 1, "reaction_id": "ack"}, ReactionHint(after_sentence=1, reaction_id="ack")),
    ({"after_sentence": 3, "reaction_id": "interesting"},
     ReactionHint(after_sentence=3, reaction_id="interesting")),
    ({"after_sentence": "2", "reaction_id": " Exactly "}, ReactionHint(after_sentence=2, reaction_id="exactly")),
    ({"after_sentence": 2.0, "reaction_id": "isee", "text": "ignored"},
     ReactionHint(after_sentence=2, reaction_id="isee")),
    (None, None), ("ack", None), ([1, "ack"], None), ({}, None),
    ({"after_sentence": 1}, None), ({"reaction_id": "ack"}, None),
    ({"after_sentence": 0, "reaction_id": "ack"}, None),
    ({"after_sentence": -1, "reaction_id": "ack"}, None),
    ({"after_sentence": 21, "reaction_id": "ack"}, None),
    ({"after_sentence": True, "reaction_id": "ack"}, None),
    ({"after_sentence": 1.5, "reaction_id": "ack"}, None),
    ({"after_sentence": "one", "reaction_id": "ack"}, None),
    ({"after_sentence": "\u00b2", "reaction_id": "ack"}, None),
    ({"after_sentence": 1, "reaction_id": "Mm-hmm."}, None),
    ({"after_sentence": 1, "reaction_id": "wow"}, None),
    ({"after_sentence": 1, "reaction_id": 3}, None),
    ({"after_sentence": 1, "reaction_id": None}, None),
])
def test_coerce_turn_parses_reaction_hints_safely(raw, expected):
    from services.podcast_script import _coerce_turn

    turn = _coerce_turn({"idx": 3, "speaker": "expert", "text": " One. Two. ", "slide_idx": "1",
                         "reaction": raw}, 0)
    assert turn.reaction == expected
    assert (turn.idx, turn.speaker, turn.text, turn.slide_idx) == (3, "expert", "One. Two.", 1)


def test_streamed_turns_keep_nested_reaction_objects():
    from services.podcast_script import _extract_turns

    buf = ('{"turns": [{"idx": 0, "speaker": "interviewer", "text": "Hi.", "slide_idx": null}, '
           '{"idx": 1, "speaker": "expert", "text": "One. Two.", "slide_idx": 0, '
           '"reaction": {"after_sentence": 1, "reaction_id": "right"}}, {"idx": 2, "speaker": "inter')
    emitted: set[int] = set()
    turns = list(_extract_turns(buf, emitted))
    assert [t.idx for t in turns] == [0, 1] and emitted == {0, 1}
    assert turns[0].reaction is None
    assert turns[1].reaction == ReactionHint(after_sentence=1, reaction_id="right")
    partial = '{"turns": [{"idx": 0, "speaker": "expert", "text": "A. B.", "reaction": {"after_sen'
    assert list(_extract_turns(partial, set())) == []


# ---------------------------------------------------------------------------
# place_reactions
# ---------------------------------------------------------------------------
SR = 16000


def _write_wav(path: Path, layout: list[tuple[str, float]]) -> list[tuple[float, float]]:
    """Tone ("speech") / zero ("sil") segments; returns the true silence intervals."""
    samples: list[int] = []
    silences, clock = [], 0.0
    for kind, dur in layout:
        n = int(round(dur * SR))
        if kind == "sil":
            samples.extend([0] * n)
            silences.append((clock, clock + n / SR))
        else:
            samples.extend(int(0.3 * 32767 * math.sin(2 * math.pi * 220 * i / SR)) for i in range(n))
        clock += n / SR
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return silences


def _clip(tmp_path: Path, rid: str = "ack", duration: float = 0.5) -> pm.ReactionClip:
    return pm.ReactionClip(reaction_id=rid, text=pm.reaction_text("en-US", rid),
                           audio_path=tmp_path / f"{rid}.wav", video_path=None, duration_sec=duration)


def _planned(turn_idx: int = 3, after: int = 1, pause_ms: int = 600, rid: str = "ack",
             listener: str = "interviewer") -> pm.PlannedReaction:
    return pm.PlannedReaction(turn_idx=turn_idx, listener=listener, reaction_id=rid,
                              after_sentence=after, pause_ms=pause_ms)


EQUAL_2 = "Alpha beta gamma delta. Epsilon zeta eta theta."
EQUAL_3 = "Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu."


def test_parse_silencedetect_handles_negative_starts_and_open_tails():
    stderr = "\n".join([
        "Input #0, wav, from 'turn.wav':",
        "  Duration: 00:00:05.50, bitrate: 768 kb/s",
        "[silencedetect @ 0x55d0] silence_start: -0.0213",
        "[silencedetect @ 0x55d0] silence_end: 0.278 | silence_duration: 0.299",
        "[silencedetect @ 0x55d0] silence_start: 1.95",
        "[silencedetect @ 0x55d0] silence_end: 2.91 | silence_duration: 0.96",
        "[silencedetect @ 0x55d0] silence_start: 5.32",
    ])
    duration, raw = pr._parse_silencedetect(stderr)
    assert duration == pytest.approx(5.5)
    assert raw == [(0.0, 0.278), (1.95, 2.91), (5.32, None)]


@needs_ffmpeg
def test_reaction_is_placed_inside_the_inserted_pause(tmp_path):
    audio = tmp_path / "turn3.wav"
    _write_wav(audio, [("sil", 0.25), ("tone", 2.0), ("sil", 1.0), ("tone", 2.0), ("sil", 0.3)])
    smap = pr.detect_silences(audio)
    assert smap is not None
    assert smap.duration_sec == pytest.approx(5.55, abs=0.01)
    assert smap.speech_start == pytest.approx(0.25, abs=0.02)
    assert smap.speech_end == pytest.approx(5.25, abs=0.02)
    assert len(smap.internal) == 1 and smap.internal[0][0] == pytest.approx(2.25, abs=0.02)
    planned = [_planned()]
    placed = pr.place_reactions(planned, {3: audio}, {"interviewer": {"ack": _clip(tmp_path)}},
                                texts={3: EQUAL_2})
    assert len(placed) == 1
    p = placed[0]
    assert (p.turn_idx, p.listener, p.reaction_id, p.duration_sec, p.gain_db) == (
        3, "interviewer", "ack", 0.5, -4.0)
    assert p.at_sec == pytest.approx(2.25 + pr.DEFAULT_MARGIN_SEC, abs=0.02)
    assert 2.25 + 0.04 <= p.at_sec and p.at_sec + p.duration_sec <= 3.25 - 0.04
    assert pr.count_skipped(planned, placed) == 0
    warnings: list[str] = []
    assert pr.note_skipped(warnings, planned, placed) == 0 and warnings == []


@needs_ffmpeg
def test_too_short_pause_is_skipped_never_squeezed(tmp_path):
    audio = tmp_path / "turn3.wav"
    _write_wav(audio, [("sil", 0.25), ("tone", 2.0), ("sil", 0.55), ("tone", 2.0), ("sil", 0.15)])
    planned = [_planned(pause_ms=600)]
    clips = {"interviewer": {"ack": _clip(tmp_path, duration=0.5)}}
    assert pr.place_reactions(planned, {3: audio}, clips, texts={3: EQUAL_2}) == []
    # Smaller margins make it fit: the rule is pause >= pre + clip + post.
    placed = pr.place_reactions(planned, {3: audio}, clips, texts={3: EQUAL_2},
                                pre_margin=0.02, post_margin=0.02)
    assert len(placed) == 1
    warnings: list[str] = []
    assert pr.note_skipped(warnings, planned, []) == 1
    assert warnings == [pm.WARNING_REACTIONS_SKIPPED]


@needs_ffmpeg
def test_nearest_qualifying_pause_to_the_sentence_boundary_wins(tmp_path):
    audio = tmp_path / "turn5.wav"
    layout = [("sil", 0.25), ("tone", 2.0), ("sil", 1.0), ("tone", 2.0), ("sil", 1.0), ("tone", 2.0),
              ("sil", 0.15)]
    _write_wav(audio, layout)
    clips = {"expert": {"isee": _clip(tmp_path, "isee", 0.6)}}
    for after, start in ((1, 2.25), (2, 5.25)):
        placed = pr.place_reactions([_planned(5, after, 760, "isee", "expert")], {5: audio}, clips,
                                    texts={5: EQUAL_3})
        assert len(placed) == 1
        assert placed[0].at_sec == pytest.approx(start + 0.06, abs=0.02)


@needs_ffmpeg
def test_short_natural_pauses_are_not_mistaken_for_the_break(tmp_path):
    audio = tmp_path / "turn1.wav"
    # A 0.3 s natural pause right at the expected boundary, the real 1.1 s break later.
    _write_wav(audio, [("sil", 0.25), ("tone", 2.0), ("sil", 0.3), ("tone", 1.0), ("sil", 1.1),
                       ("tone", 2.0), ("sil", 0.15)])
    placed = pr.place_reactions([_planned(1, 1, 600)], {1: audio},
                                {"interviewer": {"ack": _clip(tmp_path)}}, texts={1: EQUAL_2})
    assert len(placed) == 1 and placed[0].at_sec == pytest.approx(3.55 + 0.06, abs=0.02)


@needs_ffmpeg
def test_without_text_the_longest_qualifying_pause_is_used(tmp_path):
    audio = tmp_path / "turn1.wav"
    _write_wav(audio, [("sil", 0.25), ("tone", 1.5), ("sil", 0.8), ("tone", 1.5), ("sil", 1.2),
                       ("tone", 1.5), ("sil", 0.15)])
    placed = pr.place_reactions([_planned(1, 1, 600)], {1: audio}, {"interviewer": {"ack": _clip(tmp_path)}})
    assert len(placed) == 1 and placed[0].at_sec == pytest.approx(4.05 + 0.06, abs=0.02)


@needs_ffmpeg
def test_missing_clip_audio_or_pause_skips_without_raising(tmp_path):
    good = tmp_path / "turn3.wav"
    _write_wav(good, [("sil", 0.25), ("tone", 2.0), ("sil", 1.0), ("tone", 2.0), ("sil", 0.15)])
    no_pause = tmp_path / "turn5.wav"
    _write_wav(no_pause, [("sil", 0.25), ("tone", 4.0), ("sil", 0.15)])
    corrupt = tmp_path / "turn7.wav"
    corrupt.write_bytes(b"not audio at all")
    clips = {"interviewer": {"ack": _clip(tmp_path)}}
    planned = [
        _planned(3, rid="right"),                    # no clip for this id
        _planned(4),                                  # no audio for this turn
        _planned(5),                                  # no qualifying pause
        _planned(7),                                  # undecodable audio
        _planned(9),                                  # path does not exist
        _planned(3, listener="expert"),               # no clips for that listener
    ]
    audio = {3: good, 5: no_pause, 7: corrupt, 9: tmp_path / "missing.wav"}
    assert pr.place_reactions(planned, audio, clips) == []
    assert pr.count_skipped(planned, []) == len(planned)
    assert pr.place_reactions([], audio, clips) == []


def test_place_reactions_survives_a_missing_ffmpeg(tmp_path, monkeypatch):
    audio = tmp_path / "turn3.wav"
    _write_wav(audio, [("sil", 0.25), ("tone", 1.0), ("sil", 1.0), ("tone", 1.0)])

    def no_ffmpeg(*args, **kwargs):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(pr.subprocess, "run", no_ffmpeg)
    assert pr.detect_silences(audio) is None
    assert pr.place_reactions([_planned()], {3: audio}, {"interviewer": {"ack": _clip(tmp_path)}}) == []


@needs_ffmpeg
def test_placement_works_on_the_audio_track_of_an_mp4(tmp_path):
    wav = tmp_path / "turn3.wav"
    _write_wav(wav, [("sil", 0.25), ("tone", 2.0), ("sil", 1.0), ("tone", 2.0), ("sil", 0.25)])
    mp4 = tmp_path / "turn3.mp4"
    subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "color=c=green:s=64x64:r=25", "-i", str(wav), "-shortest",
                    "-c:v", "mpeg4", "-c:a", "aac", "-b:a", "64k", str(mp4)], check=True, timeout=120)
    planned = [_planned()]
    clips = {"interviewer": {"ack": _clip(tmp_path)}}
    from_mp4 = pr.place_reactions(planned, {3: mp4}, clips, texts={3: EQUAL_2})
    from_wav = pr.place_reactions(planned, {3: wav}, clips, texts={3: EQUAL_2})
    assert len(from_mp4) == len(from_wav) == 1
    assert from_mp4[0].at_sec == pytest.approx(from_wav[0].at_sec, abs=0.04)
    assert 2.25 <= from_mp4[0].at_sec and from_mp4[0].at_sec + 0.5 <= 3.25


@needs_ffmpeg
def test_placements_never_overlap_speech(tmp_path):
    rng = random.Random(7)
    planned, audio, truth = [], {}, {}
    clips = {"interviewer": {rid: _clip(tmp_path, rid, d) for rid, d in
                             (("ack", 0.35), ("right", 0.45), ("yeah", 0.6), ("isee", 0.75))}}
    for turn_idx in range(8):
        layout = [("sil", 0.25)]
        for _ in range(rng.randint(2, 4)):
            layout += [("tone", rng.uniform(0.8, 2.5)), ("sil", rng.choice((0.25, 0.4, 0.6, 0.8, 1.0, 1.3)))]
        layout[-1] = ("sil", 0.15)
        path = tmp_path / f"turn{turn_idx}.wav"
        truth[turn_idx] = _write_wav(path, layout)
        audio[turn_idx] = path
        rid = rng.choice(list(clips["interviewer"]))
        planned.append(_planned(turn_idx, 1, rng.choice((480, 600, 760)), rid))
    placed = pr.place_reactions(planned, audio, clips)
    assert len(placed) + pr.count_skipped(planned, placed) == len(planned)
    assert placed and pr.count_skipped(planned, placed) > 0
    assert placed == sorted(placed, key=lambda p: (p.turn_idx, p.at_sec))
    for p in placed:
        inside = [(s, e) for s, e in truth[p.turn_idx]
                  if s + 0.04 <= p.at_sec and p.at_sec + p.duration_sec <= e - 0.04]
        assert inside, p
