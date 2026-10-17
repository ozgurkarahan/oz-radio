"""GPT-4.1 script generation for podcasts.

Generates a two-host conversation (interviewer + expert) from an ingested
Document, streaming each DialogueTurn as soon as GPT produces it. Lines are
kept radio-safe (no visual references: every episode also ships as audio
only), and the model may suggest one listener backchannel per turn
(``DialogueTurn.reaction``, stable ids only; see ``podcast_reactions``).
"""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator, Optional

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
    "debate":   "Respectful disagreement. Each speaker challenges the other's points with evidence.",
    "explainer": "Clear pedagogical framing. Interviewer asks naive questions; Expert explains with analogies.",
}

LENGTH_TURNS = {"short": 6, "medium": 10, "long": 16}

# Appended only when ScriptRequest.audience_level is set; None keeps the
# original prompt byte-for-byte. Depth/vocabulary only — never slide rules.
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
    " This adjusts depth and vocabulary only; it does not change the turn, slide or output-format rules."
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


def _build_source_excerpt(doc: Document, max_chars: int = 8000) -> str:
    parts: list[str] = []
    if doc.slide_titles:
        parts.append("## Slide outline")
        for i, (title, notes) in enumerate(zip(doc.slide_titles, doc.slide_notes)):
            parts.append(f"[slide {i}] {title}")
            if notes and notes.strip():
                parts.append(f"    notes: {notes.strip()[:400]}")
    for s in doc.sections:
        if s.heading:
            parts.append(f"\n## {s.heading}")
        parts.append(s.text)
    text = "\n".join(parts)
    return text[:max_chars]


def _build_system_prompt(req: ScriptRequest, doc: Document) -> str:
    language = LANGUAGE_NAMES.get(req.language, req.language)
    style = STYLE_DIRECTIVES.get(req.style, STYLE_DIRECTIVES["casual"])
    n_turns = req.num_turns or LENGTH_TURNS.get(req.length, 10)
    has_slides = bool(doc.slide_titles)
    slide_hint = (
        f" There are {len(doc.slide_titles)} slides (0-indexed). Assign each turn a `slide_idx` "
        f"pointing to the slide most relevant to that turn's content. Progress naturally through "
        f"the slides — turn 0 uses slide 0, then advance as topics shift."
        if has_slides else " There are no slides; leave `slide_idx` as null."
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
        f"true borrowings in the target language. Speaker display names and proper nouns may stay as-is.\n\n"
        f"Style: {style}\n"
        f"{_audience_line(req.audience_level)}"
        f"Target length: about {n_turns} turns total, alternating speakers starting with the Interviewer."
        f"{slide_hint}"
        f"{focus}\n\n"
        f"{RADIO_SAFE_DIRECTIVE}\n\n"
        "Output format: a JSON object with key `turns`, which is an array of objects. "
        "Each object has: `idx` (0-based int), `speaker` (\"interviewer\"|\"expert\"), "
        "`text` (the spoken line, 1–3 sentences, natural prose — no stage directions), "
        "and `slide_idx` (int or null). "
        f"{REACTION_HINT_RULES}"
        "Return ONLY the JSON object, no prose before or after."
    )


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
    user_prompt = (
        "Here is the source material. Generate the podcast dialogue now.\n\n"
        f"Document title: {doc.title}\n\n"
        f"{_build_source_excerpt(doc)}"
    )

    stream = client.chat.completions.create(
        model=deployment,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.8,
        max_completion_tokens=4096,
        response_format={"type": "json_object"},
        stream=True,
    )

    buf = ""
    emitted: set[int] = set()
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
            yield turn

    # Final pass — emit any leftover turns from the completed JSON.
    try:
        obj = json.loads(buf)
        turns = obj.get("turns", []) if isinstance(obj, dict) else []
        for i, t in enumerate(turns):
            idx = int(t.get("idx", i))
            if idx in emitted:
                continue
            yield _coerce_turn(t, idx)
            emitted.add(idx)
    except json.JSONDecodeError:
        log.warning("final JSON parse failed; %d turns already emitted", len(emitted))


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
