"""Video script generation — GPT-4.1 streaming, one SlideNarration per slide.

Output shape is slide-first (NOT turn-based). We prompt the model to return
a JSON object { narrations: [{slide_index, narration, speaking_style?,
duration_hint_s?}, ...] } and stream each narration object to the client
as it is produced (NDJSON), so the UI can show a per-slide "typing" effect.

Like the podcast script (services.podcast_script), the prompt grounds every
narration in the slides at every audience level, never lets the recording pass
as live, keeps one language, and shares the source budget fairly between slides.
"""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator, Optional

from config import AzureConfig
from services.podcast_script import SOURCE_MAX_CHARS, clip_text, fair_share_cap
from services.video_models import (
    ScriptRequest,
    SlideNarration,
    VideoDocument,
)
from services.translation import get_openai_client

log = logging.getLogger(__name__)

# Low temperature: the narration has to stay close to the slides.
TEMPERATURE = 0.4
MAX_COMPLETION_TOKENS = 8192

LANGUAGE_NAMES = {
    "en-US": "English",
    "fr-FR": "French",
    "es-ES": "Spanish",
    "de-DE": "German",
    "it-IT": "Italian",
    "pt-BR": "Brazilian Portuguese",
    "zh-CN": "Mandarin Chinese (Simplified)",
    "ja-JP": "Japanese",
}

STYLE_DIRECTIVES = {
    "casual":    "Warm, conversational tone. Use contractions. Sound like a knowledgeable colleague presenting.",
    "formal":    "Polished, measured tone. Precise vocabulary. Suitable for executive or investor audiences.",
    "explainer": "Clear pedagogical framing. Short sentences. Name the key idea then elaborate with one "
                 "concrete example taken from the slide or its notes.",
    "marketing": "Energetic, benefit-forward. Lead with the outcome the viewer gets. End with a subtle call-to-action.",
}

# Appended only when ScriptRequest.audience_level is set; None keeps the generic prompt.
# Depth/vocabulary only — never slide or grounding rules.
AUDIENCE_DIRECTIVES = {
    "beginner": (
        "Beginner viewers with no prior AI or technical knowledge. Define every term in plain words "
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
    " This adjusts depth and vocabulary only; still write exactly one narration per slide, in slide order."
)

# Applies to every level (the expert audience directive above repeats it for experts).
GROUNDING_DIRECTIVE = (
    "GROUNDING: Use ONLY what the slides and their notes state. Do NOT invent statistics, numbers, products, "
    "studies, causes, mitigations, comparisons, examples, anecdotes or advice, and do not fill gaps from your "
    "own knowledge: if a slide is silent on something, leave it out. Keep the source's degree and hedges: "
    "\"at some cost to accuracy\" must never become \"almost no loss\", \"recommended\" must not become "
    "\"required\", \"after deployment\" must not become \"before deployment\". Give figures, names and dates "
    "exactly as written, and keep the terms and the order of steps as the slides define them. The notes are a "
    "presenter's script for a live talk: take their facts, not their first-person promises or their "
    "invitations to ask or try something. A passage ending in \"…\" was shortened: never guess what was cut. "
    "The angle and the audience level choose what to stress and how to explain it; they never permit claims "
    "beyond the slides."
)

# The video is rendered once and published as a recording; slide notes may be written for a
# live demo ("what you hear right now was written moments ago").
RECORDED_DIRECTIVE = (
    "RECORDED VIDEO: This video is pre-recorded from a script written in advance. Never say or imply that "
    "the narration is live, written moments ago or generated on the fly. If a slide describes a live demo or "
    "a live presenter, explain in the third person how such a demo works instead of claiming that this video "
    "does it. Do not invite viewers to ask questions or to join in: nobody can answer them from a recording."
)


def _audience_line(level: Optional[str]) -> str:
    directive = AUDIENCE_DIRECTIVES.get(level or "")
    return f"Audience: {directive}{AUDIENCE_SCOPE_NOTE}\n" if directive else ""


def _build_slide_outline(doc: VideoDocument, max_chars: int = SOURCE_MAX_CHARS) -> str:
    """Every slide's title and text; a deck above ``max_chars`` shortens its longest slides to a common cap."""
    heads = [f"[slide {sl.index}] {sl.title or ''}" for sl in doc.slides]
    contents = [(sl.preview_text or "").strip() for sl in doc.slides]
    label = "    content: "
    overhead = sum(len(h) + 1 + (len(label) + 1 if c else 0) for h, c in zip(heads, contents))
    cap = fair_share_cap([len(c) for c in contents], max_chars - overhead)
    parts: list[str] = []
    for head, content in zip(heads, contents):
        parts.append(head)
        if content:
            parts.append(f"{label}{clip_text(content, cap)}")
    return "\n".join(parts)[:max_chars]


def _build_system_prompt(req: ScriptRequest, doc: VideoDocument) -> str:
    language = LANGUAGE_NAMES.get(req.language, req.language)
    style = STYLE_DIRECTIVES.get(req.style or "explainer", STYLE_DIRECTIVES["explainer"])
    focus = f"\n\nAngle / focus to emphasize: {req.focus}" if req.focus else ""
    n = len(doc.slides)
    return (
        f"You are scripting a single-narrator voiceover for a {n}-slide presentation in {language}.\n"
        f"Produce EXACTLY ONE narration paragraph per slide, 2–5 sentences each, that the viewer hears "
        f"while that slide is on screen.\n\n"
        f"LANGUAGE: Write natural, idiomatic {language} as a native speaker would — native turns of phrase, "
        f"contractions and elisions that sound spoken rather than literally translated. Do NOT mix in English "
        f"words unless they are true borrowings. Proper nouns may stay as-is. Every sentence, greetings, "
        f"transitions and sign-offs included, must be entirely in {language}: never slip into another "
        f"language (for example, no English phrase in a French video).\n\n"
        f"Style: {style}\n"
        f"{_audience_line(req.audience_level)}"
        f"Flow: each narration should feel like it continues naturally from the previous slide — use occasional "
        f"bridge phrases (\"Building on that...\", \"So what does this mean in practice?\"). The first slide "
        f"opens the talk; the last slide closes it.\n"
        f"Avoid reading bullet points verbatim: paraphrase them and explain the why only as far as the slide "
        f"and its notes explain it.{focus}\n\n"
        f"{GROUNDING_DIRECTIVE}\n\n"
        f"{RECORDED_DIRECTIVE}\n\n"
        f"Output format: a JSON object with key `narrations`, which is an array of EXACTLY {n} objects, one "
        f"per slide, in slide order. Each object has:\n"
        f"  - `slide_index` (0-based int, must match the input slide),\n"
        f"  - `narration` (the spoken paragraph, prose only, no stage directions, no markdown),\n"
        f"  - `speaking_style` (optional short hint like \"enthusiastic\", \"calm\", \"authoritative\"),\n"
        f"  - `duration_hint_s` (optional estimated seconds to read aloud at normal pace).\n"
        f"Return ONLY the JSON object, no prose before or after."
    )


async def generate_script_stream(
    cfg: AzureConfig,
    doc: VideoDocument,
    req: ScriptRequest,
) -> AsyncIterator[SlideNarration]:
    """Yield one SlideNarration per slide, in order, as GPT emits them."""
    client = get_openai_client(cfg)
    deployment = cfg.openai_chat_deployment or "gpt-4.1"

    system_prompt = _build_system_prompt(req, doc)
    user_prompt = (
        f"Document title: {doc.title}\n"
        f"Slide count: {len(doc.slides)}\n\n"
        f"Slides:\n{_build_slide_outline(doc)}\n\n"
        f"Generate the narrations now."
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

    # Build slide_index -> SlideRef map for filling blanks on patch.
    ref_by_idx = {s.index: s for s in doc.slides}
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
        for obj in _extract_narrations(buf, emitted):
            yield _coerce_narration(obj, ref_by_idx, req)

    # Final pass for any leftover not caught mid-stream.
    try:
        final = json.loads(buf)
        items = final.get("narrations", []) if isinstance(final, dict) else []
        for i, t in enumerate(items):
            idx = int(t.get("slide_index", i))
            if idx in emitted:
                continue
            emitted.add(idx)
            yield _coerce_narration(t, ref_by_idx, req)
    except json.JSONDecodeError:
        log.warning("final video-script JSON parse failed; %d narrations already emitted", len(emitted))


def _coerce_narration(obj: dict, ref_by_idx: dict, req: ScriptRequest) -> SlideNarration:
    idx = int(obj.get("slide_index", 0))
    ref = ref_by_idx.get(idx)
    dur = obj.get("duration_hint_s")
    try:
        dur = float(dur) if dur is not None else None
    except (TypeError, ValueError):
        dur = None
    return SlideNarration(
        slide_index=idx,
        slide_image_ref=(ref.image_ref if ref else ""),
        title=(ref.title if ref else None),
        narration=str(obj.get("narration", "")).strip(),
        voice=req.voice,
        speaking_style=(str(obj.get("speaking_style")) if obj.get("speaking_style") else None),
        duration_hint_s=dur,
    )


def _extract_narrations(buf: str, emitted: set[int]):
    """Yield completed narration dicts from an in-progress JSON buffer.

    Same greedy brace-walker the podcast streamer uses, adapted for the
    `narrations` array.
    """
    start = buf.find('"narrations"')
    if start == -1:
        return
    arr_start = buf.find("[", start)
    if arr_start == -1:
        return
    i = arr_start + 1
    while i < len(buf):
        while i < len(buf) and buf[i] in " \n\r\t,":
            i += 1
        if i >= len(buf) or buf[i] == "]":
            return
        if buf[i] != "{":
            i += 1
            continue
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
            return
        obj_str = buf[i : j + 1]
        try:
            obj = json.loads(obj_str)
        except json.JSONDecodeError:
            return
        idx = int(obj.get("slide_index", len(emitted)))
        if idx not in emitted:
            emitted.add(idx)
            yield obj
        i = j + 1
