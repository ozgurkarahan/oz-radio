"""GPT-4.1 script generation for podcasts.

Generates a two-host conversation (interviewer + expert) from an ingested
Document, streaming each DialogueTurn as soon as GPT produces it. Lines are
kept radio-safe (no visual references: every episode also ships as audio
only), and the model may suggest one listener backchannel per turn
(``DialogueTurn.reaction``, stable ids only; see ``podcast_reactions``).

Content quality, at every audience level:

* the model receives the whole source, up to ``SOURCE_MAX_CHARS``; a bigger
  deck is shortened slide by slide with a fair budget (``fair_share_cap``), so no
  slide is dropped and a short slide is never cut;
* the target turn count grows with the slide count for the deep levels
  (``effective_num_turns``) and the prompt states a coverage target per level;
* the prompt grounds every claim in the source and keeps its hedges, never lets
  the (pre-recorded) episode pass as live, keeps one language, and ends the
  dialogue with a wrap-up turn; sampling is conservative (``TEMPERATURE``).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import AsyncIterator, Optional, Sequence

from pydantic import ValidationError

from config import AzureConfig
from services.podcast_models import DialogueTurn, Document, ReactionHint, ScriptRequest
from services.translation import get_openai_client

log = logging.getLogger(__name__)


LANGUAGE_NAMES = {
    "en-US": "English", "fr-FR": "French", "es-ES": "Spanish",
    "de-DE": "German", "it-IT": "Italian", "pt-BR": "Brazilian Portuguese",
    "zh-CN": "Mandarin Chinese (Simplified)", "ja-JP": "Japanese",
}

STYLE_DIRECTIVES = {
    "casual":   "Friendly, conversational tone. Use contractions. Feel natural, like two colleagues.",
    "formal":   "Polished, measured tone. Precise vocabulary. Suitable for executive audience.",
    "debate":   "Respectful disagreement. Each speaker challenges the other's points with evidence from the "
                "source, probing the limits and trade-offs the source itself states.",
    "explainer": "Clear pedagogical framing. Interviewer asks naive questions; Expert explains with analogies.",
}

LENGTH_TURNS = {"short": 6, "medium": 10, "long": 16}

# Share (numerator, denominator) of the slides each deep level has to cover. Every covered
# slide gets one exchange (a question and an answer: two turns) and the episode ends on a
# wrap-up turn, which sets the target turn count; the caller's num_turns stays a floor.
# Beginner and unleveled episodes are not scaled: they stay short and simple.
COVERAGE_SHARE = {"expert": (4, 5), "practitioner": (2, 3)}
# Upper bound of the target: /render refuses scripts above security.MAX_TURNS_PER_SCRIPT
# (40) and the model overshoots a target by about a quarter.
MAX_TARGET_TURNS = 30

# The model gets the whole source: 48,000 characters (about 12k tokens) is far below its
# context window. A bigger source is shortened slide by slide, never cut off at the end.
SOURCE_MAX_CHARS = 48_000
# Low temperature: the script has to stay close to the source.
TEMPERATURE = 0.4
MAX_COMPLETION_TOKENS = 8192

# Appended only when ScriptRequest.audience_level is set; None keeps the generic prompt.
# Depth, vocabulary and coverage only (see COVERAGE_DIRECTIVES) — never the grounding rules.
AUDIENCE_DIRECTIVES = {
    "beginner": (
        "Beginner listeners with no prior AI or technical knowledge. Define every term in plain words "
        "the first time it appears, use everyday analogies, avoid jargon and acronyms (expand any "
        "acronym that is unavoidable), and introduce one idea at a time."
    ),
    "practitioner": (
        "Practitioners who build or operate solutions. Favor concrete how-to guidance, trade-offs, "
        "practical tips and common pitfalls; standard industry terminology is fine without definitions."
    ),
    "expert": (
        "Deep technical experts. Discuss architecture, internals, limits, failure modes and evaluation "
        "with precise vocabulary. Stay strictly within the source material — do NOT invent numbers, "
        "benchmarks or details that are not in the source."
    ),
}
AUDIENCE_SCOPE_NOTE = (
    " This adjusts depth, vocabulary and coverage only; the grounding, language and output-format "
    "rules below still apply."
)

# What the episode has to cover, per level; {k} of the {n} slides, or the sections of a
# source without slides. Beginner episodes pick a few ideas instead: no bloat.
COVERAGE_BEGINNER = (
    "Coverage: keep the episode short and simple. Pick the 3 to 5 most important ideas for a "
    "newcomer, explain each one once, and do not try to cover everything in the source."
)
COVERAGE_DIRECTIVES = {
    "expert": (
        "Coverage: this is a full deep dive. Cover at least {k} of the {n} slides, in slide order, "
        "giving each one its own exchange (one precise question, one precise answer); do not spend "
        "the episode on the first few slides and run out of turns.",
        "Coverage: this is a full deep dive. Cover every main section of the source, in order, "
        "giving each one its own exchange (one precise question, one precise answer).",
    ),
    "practitioner": (
        "Coverage: cover at least {k} of the {n} slides, in slide order, giving each one its own "
        "exchange (a question and an answer) and putting the weight on concrete how-to guidance, "
        "trade-offs and pitfalls.",
        "Coverage: cover the main sections of the source in order, putting the weight on concrete "
        "how-to guidance, trade-offs and pitfalls.",
    ),
    None: (
        "Coverage: cover the main points of the slides in order, giving more room to the most "
        "important ones.",
        "Coverage: cover the main points of the source in order, giving more room to the most "
        "important ones.",
    ),
}

WRAP_UP_DIRECTIVE = (
    "WRAP-UP: The final turn must be a short wrap-up that recaps the key points the episode actually "
    "covered and closes it: only points already made, no new facts, no new questions and no invitation "
    "to interact. Never stop on a plain answer."
)

# Applies to every level (the expert audience directive above repeats it for experts).
GROUNDING_DIRECTIVE = (
    "GROUNDING: Use ONLY what the source below states. Every claim by either host, the Interviewer's "
    "questions included, must be supported by the source (its slides and notes). Do NOT invent "
    "statistics, numbers, products, studies, causes, mitigations, comparisons, examples or anecdotes, "
    "and do not fill gaps from your own knowledge: if the source is silent on something, leave it out. "
    "Keep the source's degree and hedges: \"at some cost to accuracy\" must never become \"almost no "
    "loss\", \"often\" must not become \"always\", \"recommended\" must not become \"required\", and a "
    "limit must not turn into a guarantee. Give figures, names and dates exactly as written. Analogies "
    "are fine when they add no new facts. The notes are a presenter's script for a live talk: take their "
    "facts, not their first-person promises or their references to what the audience sees or can do. "
    "A passage ending in \"…\" was shortened: never guess what was cut. The conversation angle and the "
    "audience level choose what to stress and how to explain it; they never permit claims beyond the "
    "source."
)

# The episode is rendered once and published as a recording; slide notes may be written for
# a live demo ("what you hear right now was written moments ago").
RECORDED_DIRECTIVE = (
    "RECORDED EPISODE: This episode is pre-recorded from a script written in advance. Never say or imply "
    "that it is live, spontaneous, improvised, unscripted or generated on the fly, and never claim that "
    "\"nothing is recorded in advance\". If the source describes a live demo or a live presenter, explain "
    "in the third person how such a demo works instead of claiming that this episode does it. Do not "
    "invite listeners to ask the hosts questions or to join in: nobody can answer them from a recording."
)

# Every episode is also published as an audio-only radio mix.
RADIO_SAFE_DIRECTIVE = (
    "RADIO-SAFE: The episode is also published as audio only, so the dialogue must work without any "
    "visuals. Never reference what the audience sees (no \"as you can see\", \"on this slide\", "
    "\"look at\", \"here on the screen\"); describe charts, images and figures in words instead."
)

# Optional listener backchannel per turn: stable ids only, the spoken words are
# chosen server-side per language (podcast_media.reaction_text).
REACTION_HINT_RULES = (
    "Optionally add `reaction`: {\"after_sentence\": n, \"reaction_id\": id} when the OTHER host "
    "would naturally react out loud right after sentence n of this turn (n counts from 1), before "
    "the speaker goes on. "
    "`reaction_id` is one of: ack (neutral acknowledgement), right (agreement), yeah (casual "
    "agreement), exactly (strong agreement), isee (understanding), interesting (curiosity). "
    "Use at most one reaction per turn, on about one turn in three, never on the first or last turn, "
    "only on turns with at least 2 sentences, and n must be smaller than the number of sentences in "
    "that turn. Never write the reaction itself into `text`; omit `reaction` on other turns. "
)


def _audience_line(level: str | None) -> str:
    directive = AUDIENCE_DIRECTIVES.get(level or "")
    return f"Audience: {directive}{AUDIENCE_SCOPE_NOTE}\n" if directive else ""


# ---------------------------------------------------------------------------
# Source excerpt: the whole source, with a fair budget per slide
# ---------------------------------------------------------------------------
_SENTENCE_END = re.compile(r"(?:[.!?…][\"'»”’)\]]*(?=\s)|[。！？])")
_SLIDES_PREAMBLE = (
    "## Slides (numbered from 0). \"on slide\" is the text shown on the slide, "
    "\"notes\" is the presenter's speaker notes."
)
_SHORTENED_NOTE = (
    "(Long passages were shortened to fit: a passage ending in … is cut off. "
    "Never guess what was left out.)"
)


def fair_share_cap(sizes: Sequence[int], budget: int) -> int:
    """Per-item limit that spends ``budget`` fairly (water-filling).

    Items up to the limit stay whole and the room they leave unused goes to the
    longer ones: a source within the budget is never shortened (the limit is its
    longest item), a bigger one cuts every long item to the same cap.
    """
    left = len(sizes)
    if left == 0:
        return 0
    if sum(sizes) <= budget:
        return max(sizes)
    remaining = max(0, budget)
    for size in sorted(sizes):
        share = remaining // left
        if size > share:
            return share
        remaining -= size
        left -= 1
    return max(sizes)


def clip_text(text: str, limit: int) -> str:
    """``text`` cut to at most ``limit`` characters at a sentence (else word) boundary, ending in an ellipsis."""
    if len(text) <= limit:
        return text
    if limit <= 1:
        return "…"[: max(limit, 0)]
    window = text[:limit]
    floor = limit // 2
    ends = [m.end() for m in _SENTENCE_END.finditer(window) if floor <= m.end() < limit]
    if ends:
        cut = ends[-1]
    else:
        cut = max(window.rfind(" ", floor, limit), window.rfind("\n", floor, limit))
        if cut < 0:
            cut = limit - 1
    return text[:cut].rstrip() + "…"


@dataclass(frozen=True)
class SourcePart:
    """One slide (or one section of a source without slides) of the excerpt."""

    head: str
    body: str = ""
    notes: str = ""
    slide: bool = False


def _flat(text: str) -> str:
    return " ".join((text or "").split())


def _flat_lines(text: str) -> str:
    return " | ".join(line for line in (_flat(raw) for raw in (text or "").splitlines()) if line)


def _tidy(text: str) -> str:
    return "\n".join(line for line in (_flat(raw) for raw in (text or "").splitlines()) if line)


def _source_parts(doc: Document) -> list[SourcePart]:
    parts: list[SourcePart] = []
    for i, title in enumerate(doc.slide_titles):
        text = (doc.sections[i].text if i < len(doc.sections) else "").strip()
        notes = ((doc.slide_notes[i] if i < len(doc.slide_notes) else "") or "").strip()
        if notes and text.endswith(notes):
            text = text[: -len(notes)]  # ingest_pptx stores "body\nnotes" as the section text
        parts.append(SourcePart(f"[slide {i}] {_flat(title)}".rstrip(), _flat_lines(text), _flat(notes), True))
    for section in doc.sections[len(doc.slide_titles):]:
        heading = _flat(section.heading)
        parts.append(SourcePart(f"## {heading}" if heading else "", _tidy(section.text)))
    return parts


def _render_part(part: SourcePart, body: str, notes: str) -> list[str]:
    lines = [part.head] if part.head else []
    if part.slide:
        if body:
            lines.append(f"    on slide: {body}")
        if notes:
            lines.append(f"    notes: {notes}")
    elif body:
        lines.append(body)
    return lines


def _plan_source(parts: Sequence[SourcePart], max_chars: int) -> list[tuple[str, str]]:
    """(on-slide text, notes) kept for every part so that the excerpt fits ``max_chars``.

    The longest parts share the budget evenly while a short part stays whole; the
    same rule then splits a long part's allowance between its text and its notes.
    """
    overhead = len(_SLIDES_PREAMBLE) + len(_SHORTENED_NOTE) + 2
    for p in parts:
        lines = _render_part(p, p.body, p.notes)
        overhead += sum(len(line) for line in lines) + len(lines) - len(p.body) - len(p.notes)
    cap = fair_share_cap([len(p.body) + len(p.notes) for p in parts], max_chars - overhead)
    plan: list[tuple[str, str]] = []
    for p in parts:
        if len(p.body) + len(p.notes) <= cap:
            plan.append((p.body, p.notes))
            continue
        inner = fair_share_cap([len(p.body), len(p.notes)], cap)
        plan.append((clip_text(p.body, inner), clip_text(p.notes, inner)))
    return plan


def _build_source_excerpt(doc: Document, max_chars: int = SOURCE_MAX_CHARS) -> str:
    parts = _source_parts(doc)
    plan = _plan_source(parts, max_chars)
    shortened = any(kept != (p.body, p.notes) for p, kept in zip(parts, plan))
    lines: list[str] = []
    if doc.slide_titles:
        lines.append(_SLIDES_PREAMBLE)
    if shortened:
        lines.append(_SHORTENED_NOTE)
    for part, (body, notes) in zip(parts, plan):
        lines.extend(_render_part(part, body, notes))
    return "\n".join(lines)[:max_chars]


def source_budget(doc: Document, max_chars: int = SOURCE_MAX_CHARS) -> list[tuple[str, int, int]]:
    """(slide or section, source characters, characters kept) as budgeted for the model."""
    parts = _source_parts(doc)
    return [
        (p.head, len(p.body) + len(p.notes), len(body) + len(notes))
        for p, (body, notes) in zip(parts, _plan_source(parts, max_chars))
    ]


# ---------------------------------------------------------------------------
# Length and coverage
# ---------------------------------------------------------------------------
def _slides_to_cover(level: str | None, n_slides: int) -> int:
    share = COVERAGE_SHARE.get(level or "")
    if share is None or n_slides <= 0:
        return 0
    return min(-(-n_slides * share[0] // share[1]), n_slides)


def effective_num_turns(req: ScriptRequest, doc: Document) -> int:
    """Target turn count: the caller's ``num_turns``, raised for the deep levels so every covered slide
    gets an exchange (two turns) and the episode a wrap-up turn."""
    requested = req.num_turns or LENGTH_TURNS.get(req.length, 10)
    wanted = _slides_to_cover(req.audience_level, len(doc.slide_titles))
    return max(requested, min(2 * wanted + 1, MAX_TARGET_TURNS)) if wanted else requested


def coverage_target(level: str | None, n_slides: int, n_turns: int) -> int:
    """Slides the episode has to cover for ``level`` (0 = no target), as many as its turns can hold."""
    wanted = _slides_to_cover(level, n_slides)
    return max(1, min(wanted, (n_turns - 1) // 2)) if wanted else 0


def _coverage_line(level: str | None, n_slides: int, n_turns: int) -> str:
    if level == "beginner":
        return COVERAGE_BEGINNER
    with_slides, without_slides = COVERAGE_DIRECTIVES.get(level) or COVERAGE_DIRECTIVES[None]
    if not n_slides:
        return without_slides
    return with_slides.format(k=coverage_target(level, n_slides, n_turns), n=n_slides)


def _build_system_prompt(req: ScriptRequest, doc: Document) -> str:
    language = LANGUAGE_NAMES.get(req.language, req.language)
    style = STYLE_DIRECTIVES.get(req.style, STYLE_DIRECTIVES["casual"])
    n_turns = effective_num_turns(req, doc)
    n_slides = len(doc.slide_titles)
    slide_hint = (
        f" There are {n_slides} slides (0-indexed). Assign each turn a `slide_idx` "
        f"pointing to the slide most relevant to that turn's content. Progress naturally through "
        f"the slides — turn 0 uses slide 0, then advance as topics shift."
        if n_slides else " There are no slides; leave `slide_idx` as null."
    )
    focus = f"\n\nConversation angle: {req.focus}" if req.focus else ""
    return (
        f"You are producing a podcast-style dialogue in {language} between two hosts:\n"
        f"  - Interviewer: curious, asks open questions, reframes the Expert's points for the audience.\n"
        f"  - Expert: subject-matter authority; gives specific, substantive answers.\n\n"
        f"LANGUAGE: Write the ENTIRE dialogue in natural, idiomatic {language} as a native "
        f"speaker would — use native turns of phrase, local cultural references where appropriate, "
        f"and contractions/elisions that sound spoken rather than literally translated. "
        f"Do NOT translate English idioms word-for-word. Do NOT mix in English words unless they are "
        f"true borrowings in the target language. Speaker display names and proper nouns may stay as-is. "
        f"Every line, greetings, transitions and sign-offs included, must be entirely in {language}: "
        f"never slip into another language (for example, no English phrase in a French episode).\n\n"
        f"Style: {style}\n"
        f"{_audience_line(req.audience_level)}"
        f"Target length: about {n_turns} turns total, alternating speakers starting with the Interviewer."
        f"{slide_hint}"
        f"{focus}\n\n"
        f"{_coverage_line(req.audience_level, n_slides, n_turns)}\n"
        f"{WRAP_UP_DIRECTIVE}\n\n"
        f"{GROUNDING_DIRECTIVE}\n\n"
        f"{RECORDED_DIRECTIVE}\n\n"
        f"{RADIO_SAFE_DIRECTIVE}\n\n"
        "Output format: a JSON object with key `turns`, which is an array of objects. "
        "Each object has: `idx` (0-based int), `speaker` (\"interviewer\"|\"expert\"), "
        "`text` (the spoken line, 1–3 sentences, natural prose — no stage directions), "
        "and `slide_idx` (int or null). "
        f"{REACTION_HINT_RULES}"
        "Return ONLY the JSON object, no prose before or after."
    )


def _note_slide(covered: set[int], turn: DialogueTurn, n_slides: int) -> None:
    if turn.slide_idx is not None and 0 <= turn.slide_idx < n_slides:
        covered.add(turn.slide_idx)


async def generate_script_stream(
    cfg: AzureConfig,
    doc: Document,
    req: ScriptRequest,
) -> AsyncIterator[DialogueTurn]:
    """Generate a script and yield DialogueTurns as GPT produces them.

    Uses Azure OpenAI chat completions with streaming enabled. We incrementally
    parse the JSON output and emit each complete turn object as soon as we
    recognize it, giving the UI a "typing" effect.
    """
    client = get_openai_client(cfg)
    deployment = cfg.openai_chat_deployment or "gpt-4.1"

    system_prompt = _build_system_prompt(req, doc)
    excerpt = _build_source_excerpt(doc)
    n_slides = len(doc.slide_titles)
    n_turns = effective_num_turns(req, doc)
    log.info("podcast script: %d source chars, %d slides, about %d turns (%s level)",
             len(excerpt), n_slides, n_turns, req.audience_level or "no")
    user_prompt = (
        "Here is the source material. Generate the podcast dialogue now.\n\n"
        f"Document title: {doc.title}\n\n"
        f"{excerpt}"
    )

    stream = client.chat.completions.create(
        model=deployment,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=TEMPERATURE,
        max_completion_tokens=MAX_COMPLETION_TOKENS,
        response_format={"type": "json_object"},
        stream=True,
    )

    buf = ""
    emitted: set[int] = set()
    covered: set[int] = set()
    for chunk in stream:
        try:
            delta = chunk.choices[0].delta.content or ""
        except (IndexError, AttributeError):
            delta = ""
        if not delta:
            continue
        buf += delta
        # Greedily try to extract any complete {...} turn objects from buf.
        for turn in _extract_turns(buf, emitted):
            _note_slide(covered, turn, n_slides)
            yield turn

    # Final pass — emit any leftover turns from the completed JSON.
    try:
        obj = json.loads(buf)
        turns = obj.get("turns", []) if isinstance(obj, dict) else []
        for i, t in enumerate(turns):
            idx = int(t.get("idx", i))
            if idx in emitted:
                continue
            turn = _coerce_turn(t, idx)
            _note_slide(covered, turn, n_slides)
            yield turn
            emitted.add(idx)
    except json.JSONDecodeError:
        log.warning("final JSON parse failed; %d turns already emitted", len(emitted))

    target = coverage_target(req.audience_level, n_slides, n_turns)
    if target and len(covered) < target:
        log.warning("podcast script: %d of %d slides covered, target %d (%s level)",
                    len(covered), n_slides, target, req.audience_level)


def _coerce_reaction(raw: object) -> Optional[ReactionHint]:
    """Validate an LLM backchannel hint; anything malformed is dropped (stable ids only).

    Whether ``after_sentence`` fits the turn is checked later, against the real
    sentence count, by ``podcast_reactions.plan_reactions``.
    """
    if not isinstance(raw, dict):
        return None
    reaction_id = raw.get("reaction_id")
    after = raw.get("after_sentence")
    if not isinstance(reaction_id, str) or isinstance(after, bool):
        return None
    if isinstance(after, float) and after.is_integer():
        after = int(after)
    elif isinstance(after, str):
        after = after.strip()
        after = int(after) if after.isascii() and after.isdigit() else None
    if not isinstance(after, int):
        return None
    try:
        return ReactionHint(after_sentence=after, reaction_id=reaction_id.strip().lower())
    except ValidationError:
        return None


def _coerce_turn(t: dict, fallback_idx: int) -> DialogueTurn:
    speaker = t.get("speaker", "expert")
    if speaker not in ("interviewer", "expert"):
        speaker = "expert"
    slide_idx = t.get("slide_idx", None)
    if slide_idx is not None:
        try:
            slide_idx = int(slide_idx)
        except (TypeError, ValueError):
            slide_idx = None
    return DialogueTurn(
        idx=int(t.get("idx", fallback_idx)),
        speaker=speaker,
        text=str(t.get("text", "")).strip(),
        slide_idx=slide_idx,
        reaction=_coerce_reaction(t.get("reaction")),
    )


def _extract_turns(buf: str, emitted: set[int]):
    """Yield completed turn-dicts from an in-progress JSON buffer.

    We scan for top-level balanced `{...}` objects inside the `turns` array
    and try to json-parse each. Skips any idx we've already emitted.
    """
    start = buf.find('"turns"')
    if start == -1:
        return
    # Find the opening [ after "turns":
    arr_start = buf.find("[", start)
    if arr_start == -1:
        return
    i = arr_start + 1
    while i < len(buf):
        # Skip whitespace and commas
        while i < len(buf) and buf[i] in " \n\r\t,":
            i += 1
        if i >= len(buf) or buf[i] == "]":
            return
        if buf[i] != "{":
            i += 1
            continue
        # Find matching brace (accounting for strings/escapes).
        depth = 0
        j = i
        in_str = False
        esc = False
        while j < len(buf):
            c = buf[j]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        break
            j += 1
        if j >= len(buf) or depth != 0:
            return  # unbalanced — more tokens coming
        obj_str = buf[i : j + 1]
        try:
            t = json.loads(obj_str)
        except json.JSONDecodeError:
            return
        idx = int(t.get("idx", len(emitted)))
        if idx not in emitted:
            emitted.add(idx)
            yield _coerce_turn(t, idx)
        i = j + 1
