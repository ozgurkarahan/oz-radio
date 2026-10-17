"""Avatar TTS orchestration service using Azure AI Speech."""

from __future__ import annotations

import math
import re
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Optional
from xml.sax.saxutils import escape as _xml_escape

import requests
from azure.identity import DefaultAzureCredential

from config import AzureConfig

# Voice mapping per language
VOICE_MAP = {
    "en-US": "en-US-AvaMultilingualNeural",
    "fr-FR": "fr-FR-DeniseNeural",
    "es-ES": "es-ES-ElviraNeural",
}

AVATAR_MAP = {
    "lisa": "lisa",
    "harry": "harry",
    "jeff": "jeff",
    "lori": "lori",
    "max": "max",
    "meg": "meg",
}

# Azure Batch Avatar Synthesis: each character supports a specific set of styles.
# Mismatched style -> 400 "style X is not supported for avatar character Y".
# Ref: https://learn.microsoft.com/azure/ai-services/speech-service/text-to-speech-avatar/standard-avatars
AVATAR_STYLES = {
    "lisa": "casual-sitting",
    "harry": "business",
    "jeff": "business",
    "lori": "casual",
    "max": "business",
    "meg": "business",
}

# Docs-verified intro gestures per (character, style). Used when the caller
# asks for an opening gesture on slide 1. Entries are pulled directly from
# the Azure standard-avatar docs, so any value here is known to render.
# Missing keys -> no gesture injected (safe fallback).
AVATAR_INTRO_GESTURES: dict[tuple[str, str], str] = {
    ("lisa", "casual-sitting"): "show-front-1",
    ("lisa", "graceful-sitting"): "wave-left-1",
    ("lisa", "technical-sitting"): "wave-left-1",
    ("harry", "business"): "hello",
    ("harry", "casual"): "hello",
    ("harry", "youthful"): "hello",
    ("jeff", "business"): "here",
    ("lori", "casual"): "hello",
    ("lori", "graceful"): "welcome",
    ("lori", "formal"): "hi",
    ("max", "business"): "welcome",
    ("max", "casual"): "hello",
    ("meg", "business"): "say-hi",
    ("meg", "casual"): "say-hi",
    ("meg", "formal"): "say-hi",
}

AVATAR_GESTURES: dict[tuple[str, str], set[str]] = {
    ("lisa", "casual-sitting"): {
        "numeric1-left-1",
        "numeric2-left-1",
        "numeric3-left-1",
        "thumbsup-left-1",
        "show-front-1",
        "show-front-2",
        "show-front-3",
        "show-front-4",
        "show-front-5",
        "think-twice-1",
        "show-front-6",
        "show-front-7",
        "show-front-8",
        "show-front-9",
    },
    # technical-sitting: pointing-rich variant (great for "this", "here",
    # "look at"). Confirmed against Azure standard-avatars docs.
    ("lisa", "technical-sitting"): {
        "wave-left-1",
        "wave-left-2",
        "show-left-1",
        "show-left-2",
        "point-left-1",
        "point-left-2",
        "point-left-3",
        "point-left-4",
        "point-left-5",
        "point-left-6",
        "show-right-1",
        "show-right-2",
        "show-right-3",
        "point-right-1",
        "point-right-2",
        "point-right-3",
        "point-right-4",
        "point-right-5",
        "point-right-6",
    },
    ("lisa", "graceful-sitting"): {
        "wave-left-1",
        "wave-left-2",
        "thumbsup-left",
        "show-left-1",
        "show-left-2",
        "show-left-3",
        "show-left-4",
        "show-left-5",
        "show-right-1",
        "show-right-2",
        "show-right-3",
        "show-right-4",
        "show-right-5",
    },
    ("harry", "business"): {
        "calm-down",
        "come-on",
        "five-star-reviews",
        "good",
        "hello",
        "introduce",
        "invite",
        "thanks",
        "welcome",
    },
    # Max business: standing male avatar with the largest gesture catalog
    # (~30 entries) — most visible motion in Azure's standard avatar set.
    ("max", "business"): {
        "a-little-bit", "click-the-link", "display-number",
        "encourage-1", "encourage-2", "five-star-praise",
        "front-right", "good-01", "good-02",
        "introduction-to-products-1", "introduction-to-products-2",
        "introduction-to-products-3",
        "left", "lower-left", "number-one",
        "press-both-hands-down-1", "press-both-hands-down-2",
        "push-forward", "raise-ones-hand", "right", "say-hi",
        "shrug-ones-shoulders", "slide-from-left-to-right",
        "slide-to-the-left", "thanks", "the-front",
        "top-middle-and-bottom-left", "top-middle-and-bottom-right",
        "upper-left", "upper-right", "welcome",
    },
    # Meg casual: standing female with rich, varied catalog (~32 entries).
    ("meg", "casual"): {
        "a-little-bit", "click-the-link", "cross-hand",
        "display-number", "encourage-1", "encourage-2",
        "five-star-praise", "front-left", "front-right",
        "good-1", "good-2", "handclap",
        "introduction-to-products-1", "introduction-to-products-2",
        "introduction-to-products-3",
        "left", "length", "lower-left", "lower-right", "number-one",
        "press-both-hands-down", "right", "say-hi",
        "shrug-ones-shoulders", "slide-from-right-to-left",
        "slide-to-the-left", "spread-hands", "the-front",
        "top-middle-and-bottom-left", "top-middle-and-bottom-right",
        "upper-left", "upper-right",
    },
    # Lori formal: standing female with expressive hand poses.
    ("lori", "formal"): {
        "123", "come-on", "come-on-left", "down", "five-star",
        "good", "hands-triangle", "hands-up", "hi",
        "hopeful", "thanks",
    },
}

_LISA_SHOW_FRONT_SEQUENCE = [
    "show-front-2",
    "show-front-3",
    "show-front-4",
    "show-front-5",
    "show-front-6",
    "show-front-7",
    "show-front-8",
    "show-front-9",
]

_LISA_TECH_LEFT_SEQUENCE = [
    "show-left-1",
    "point-left-1",
    "point-left-2",
    "point-left-3",
    "show-left-2",
    "point-left-4",
    "point-left-5",
    "point-left-6",
]
_LISA_TECH_RIGHT_SEQUENCE = [
    "show-right-1",
    "point-right-1",
    "point-right-2",
    "show-right-2",
    "point-right-3",
    "show-right-3",
    "point-right-4",
    "point-right-5",
    "point-right-6",
]

_QUESTION_WORDS = {
    "why", "challenge", "problem", "risk", "issue", "question", "unclear",
    "pourquoi", "defi", "défi", "probleme", "problème", "risque", "enjeu",
}
_BENEFIT_WORDS = {
    "benefit", "success", "improve", "reduce", "reduction", "save", "impact",
    "result", "conclusion", "sustainable",
    "benefice", "succes", "ameliorer", "reduire", "reduction", "impact",
    "resultat", "conclusion", "durable",
}
_FIRST_WORDS = {"first", "one", "step one", "premier", "premiere", "etape 1"}
_SECOND_WORDS = {"second", "two", "step two", "deuxieme", "second", "etape 2"}
_THIRD_WORDS = {"third", "three", "step three", "troisieme", "etape 3"}
_POINT_WORDS = {
    "this", "here", "look", "see", "notice", "consider", "observe",
    "ici", "voici", "regardez", "remarquez", "voyez",
}
_LEFT_WORDS = {"left", "previous", "before", "first", "gauche", "avant"}
_RIGHT_WORDS = {"right", "next", "after", "then", "droite", "ensuite", "apres", "après"}
_WELCOME_WORDS = {"welcome", "hello", "hi", "today", "bonjour", "bienvenue", "aujourd"}
_THANK_WORDS = {"thank", "merci"}


def semantic_gesture_for(
    avatar: str,
    narration: str,
    *,
    slide_index: int,
    intro: bool = False,
) -> Optional[str]:
    """Pick ONE safe gesture for a slide narration (back-compat)."""
    plan = plan_gestures(avatar, narration, slide_index=slide_index, intro=intro, max_gestures=1)
    return plan[0] if plan else None


def plan_gestures(
    avatar: str,
    narration: str,
    *,
    slide_index: int,
    intro: bool = False,
    max_gestures: int = 3,
) -> list[str]:
    """Return up to ``max_gestures`` docs-verified gestures aligned to the
    narration's sentences.

    The first slot (sentence 0) is reserved for the intro gesture when
    ``intro=True``. Subsequent slots use semantic mapping per (avatar, style)
    with style-specific fallbacks. Empty string entries mean "no gesture
    here"; the SSML builder will skip them.
    """
    if max_gestures <= 0:
        return []
    style = style_for(avatar)
    supported = AVATAR_GESTURES.get((avatar, style), set())

    sentences = _split_sentences(narration)
    n = max(1, min(len(sentences), max_gestures))
    plan: list[str] = []
    for i in range(n):
        sentence = sentences[i] if i < len(sentences) else ""
        if i == 0 and intro:
            intro_g = AVATAR_INTRO_GESTURES.get((avatar, style))
            if intro_g and (not supported or intro_g in supported):
                plan.append(intro_g)
                continue
        plan.append(_pick_gesture_for_sentence(
            avatar, style, supported, sentence, slide_index=slide_index, slot=i,
        ))
    # Avoid two identical gestures in a row.
    for i in range(1, len(plan)):
        if plan[i] and plan[i] == plan[i - 1]:
            plan[i] = _next_alt(avatar, style, supported, slide_index, i, plan[i])
    return plan


def _pick_gesture_for_sentence(
    avatar: str,
    style: str,
    supported: set[str],
    sentence: str,
    *,
    slide_index: int,
    slot: int,
) -> str:
    if not supported:
        return ""
    text = (sentence or "").casefold()
    pair = (avatar, style)

    if pair == ("lisa", "casual-sitting"):
        if _contains_any(text, _FIRST_WORDS):
            return "numeric1-left-1"
        if _contains_any(text, _SECOND_WORDS):
            return "numeric2-left-1"
        if _contains_any(text, _THIRD_WORDS):
            return "numeric3-left-1"
        if _contains_any(text, _QUESTION_WORDS):
            return "think-twice-1"
        if _contains_any(text, _BENEFIT_WORDS):
            return "thumbsup-left-1"
        return _LISA_SHOW_FRONT_SEQUENCE[(slide_index + slot) % len(_LISA_SHOW_FRONT_SEQUENCE)]

    if pair == ("lisa", "technical-sitting"):
        if _contains_any(text, _LEFT_WORDS):
            return _LISA_TECH_LEFT_SEQUENCE[slot % len(_LISA_TECH_LEFT_SEQUENCE)]
        if _contains_any(text, _RIGHT_WORDS):
            return _LISA_TECH_RIGHT_SEQUENCE[slot % len(_LISA_TECH_RIGHT_SEQUENCE)]
        if _contains_any(text, _POINT_WORDS):
            seq = _LISA_TECH_RIGHT_SEQUENCE if slot % 2 else _LISA_TECH_LEFT_SEQUENCE
            return seq[(slide_index + slot) % len(seq)]
        if _contains_any(text, _WELCOME_WORDS):
            return "wave-left-1"
        seq = _LISA_TECH_LEFT_SEQUENCE if slot % 2 == 0 else _LISA_TECH_RIGHT_SEQUENCE
        return seq[(slide_index + slot) % len(seq)]

    if pair == ("lisa", "graceful-sitting"):
        if _contains_any(text, _WELCOME_WORDS):
            return "wave-left-1"
        if _contains_any(text, _BENEFIT_WORDS):
            return "thumbsup-left"
        seq_l = ["show-left-1", "show-left-2", "show-left-3", "show-left-4", "show-left-5"]
        seq_r = ["show-right-1", "show-right-2", "show-right-3", "show-right-4", "show-right-5"]
        seq = seq_l if slot % 2 == 0 else seq_r
        return seq[(slide_index + slot) % len(seq)]

    if pair == ("harry", "business"):
        if _contains_any(text, _WELCOME_WORDS):
            return "welcome"
        if _contains_any(text, _THANK_WORDS):
            return "thanks"
        if _contains_any(text, _BENEFIT_WORDS):
            return "good"
        if _contains_any(text, _QUESTION_WORDS):
            return "calm-down"
        return "introduce"

    if pair == ("max", "business"):
        if _contains_any(text, _WELCOME_WORDS) and slot == 0:
            return "welcome"
        if _contains_any(text, _THANK_WORDS):
            return "thanks"
        if _contains_any(text, _FIRST_WORDS):
            return "number-one"
        if _contains_any(text, _SECOND_WORDS):
            return "display-number"
        if _contains_any(text, _THIRD_WORDS):
            return "introduction-to-products-3"
        if _contains_any(text, _BENEFIT_WORDS):
            return "five-star-praise"
        if _contains_any(text, _QUESTION_WORDS):
            return "shrug-ones-shoulders"
        if _contains_any(text, _LEFT_WORDS):
            return "slide-to-the-left"
        if _contains_any(text, _RIGHT_WORDS):
            return "slide-from-left-to-right"
        if _contains_any(text, _POINT_WORDS):
            return "the-front"
        rotation = [
            "encourage-1", "introduction-to-products-1", "push-forward",
            "raise-ones-hand", "encourage-2", "introduction-to-products-2",
        ]
        return rotation[(slide_index + slot) % len(rotation)]

    if pair == ("meg", "casual"):
        if _contains_any(text, _WELCOME_WORDS) and slot == 0:
            return "say-hi"
        if _contains_any(text, _FIRST_WORDS):
            return "number-one"
        if _contains_any(text, _SECOND_WORDS):
            return "display-number"
        if _contains_any(text, _THIRD_WORDS):
            return "introduction-to-products-3"
        if _contains_any(text, _BENEFIT_WORDS):
            return "five-star-praise"
        if _contains_any(text, _QUESTION_WORDS):
            return "shrug-ones-shoulders"
        if _contains_any(text, _LEFT_WORDS):
            return "slide-to-the-left"
        if _contains_any(text, _RIGHT_WORDS):
            return "slide-from-right-to-left"
        if _contains_any(text, _POINT_WORDS):
            return "the-front"
        rotation = [
            "spread-hands", "introduction-to-products-1", "encourage-1",
            "handclap", "introduction-to-products-2", "encourage-2",
        ]
        return rotation[(slide_index + slot) % len(rotation)]

    if pair == ("lori", "formal"):
        if _contains_any(text, _WELCOME_WORDS) and slot == 0:
            return "hi"
        if _contains_any(text, _THANK_WORDS):
            return "thanks"
        if _contains_any(text, _BENEFIT_WORDS):
            return "five-star"
        if _contains_any(text, _QUESTION_WORDS):
            return "hopeful"
        rotation = ["hands-up", "hands-triangle", "good", "come-on", "123", "down"]
        return rotation[(slide_index + slot) % len(rotation)]

    return ""


def _next_alt(
    avatar: str,
    style: str,
    supported: set[str],
    slide_index: int,
    slot: int,
    blocked: str,
) -> str:
    if (avatar, style) == ("lisa", "casual-sitting"):
        for offset in range(1, len(_LISA_SHOW_FRONT_SEQUENCE)):
            cand = _LISA_SHOW_FRONT_SEQUENCE[(slide_index + slot + offset) % len(_LISA_SHOW_FRONT_SEQUENCE)]
            if cand != blocked:
                return cand
    if (avatar, style) == ("lisa", "technical-sitting"):
        seq = _LISA_TECH_LEFT_SEQUENCE if slot % 2 == 0 else _LISA_TECH_RIGHT_SEQUENCE
        for offset in range(1, len(seq)):
            cand = seq[(slide_index + slot + offset) % len(seq)]
            if cand != blocked:
                return cand
    return ""


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[\.!?])\s+(?=[A-Z\u00C0-\u017F])")


def _split_sentences(text: str) -> list[str]:
    if not text:
        return []
    chunks = _SENTENCE_SPLIT_RE.split(text.strip())
    return [c.strip() for c in chunks if c.strip()]


def _contains_any(text: str, words: set[str]) -> bool:
    return any(
        re.search(rf"(?<!\w){re.escape(word.casefold())}(?!\w)", text)
        for word in words
    )

# H1.5 2026-04-24: Lisa casual-sitting is the most photo-realistic standard
# avatar in Azure's catalog (per docs + public demos) and ships with
# presenter-friendly gestures (show-front-1..9, think-twice, thumbsup).
# Harry/business is the male counterpart with welcome/hello/thanks gestures.
# We previously defaulted to Max (more gestures, but noticeably 3D-stylized)
# — client feedback 2026-04-23 called this out as "not natural enough".
DEFAULT_AVATAR = "lisa"
DEFAULT_AVATAR_STYLE = "casual-sitting"


def style_for(avatar: str) -> str:
    """Pick a valid talkingAvatarStyle for the given character."""
    return AVATAR_STYLES.get(avatar, DEFAULT_AVATAR_STYLE)


@dataclass
class AvatarJobStatus:
    job_id: str
    status: str
    video_url: Optional[str] = None
    error: Optional[str] = None


def _get_speech_auth_header(config: AzureConfig) -> dict:
    """Get authorization header for Speech REST APIs."""
    if config.use_managed_identity:
        credential = DefaultAzureCredential()
        token = credential.get_token("https://cognitiveservices.azure.com/.default")
        return {"Authorization": f"Bearer {token.token}"}
    return {"Ocp-Apim-Subscription-Key": config.speech_key}


def _get_speech_base_url(config: AzureConfig) -> str:
    """Get the base URL for Speech REST APIs."""
    if config.use_managed_identity and config.speech_endpoint:
        return config.speech_endpoint.rstrip("/")
    return f"https://{config.speech_region}.api.cognitive.microsoft.com"


PAUSE_MIN_MS = 100
PAUSE_MAX_MS = 2000

# Sentence ends that need no following whitespace (zh/ja). ASCII ends also count
# when CJK text follows them.
_CJK_SENTENCE_ENDS = frozenset("。！？｡")
_ASCII_SENTENCE_ENDS = frozenset(".!?")
_SENTENCE_CLOSERS = frozenset("”’」』）〕】》〉\"')]")
_CJK_START_RE = re.compile(
    "[\u3005-\u3008\u300a\u300c\u300e\u3010\u3014\u3040-\u30ff\u3400-\u4dbf"
    "\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff08\uff66-\uff9f]"
)


def _split_cjk(chunk: str) -> list[tuple[str, str]]:
    """Split one ``_split_sentences`` chunk after CJK sentence ends.

    Returns ``(sentence, joiner)`` pairs, ``joiner`` being " " or "" (how the
    sentence was attached to the next one). A chunk without CJK sentence ends,
    and without CJK text right after . ! ?, comes back whole.
    """
    pieces: list[tuple[str, str]] = []
    start = i = 0
    n = len(chunk)
    while i < n:
        if chunk[i] not in _CJK_SENTENCE_ENDS and chunk[i] not in _ASCII_SENTENCE_ENDS:
            i += 1
            continue
        j = i
        while j < n and (chunk[j] in _CJK_SENTENCE_ENDS or chunk[j] in _ASCII_SENTENCE_ENDS):
            j += 1
        while j < n and chunk[j] in _SENTENCE_CLOSERS:
            j += 1
        k = j
        while k < n and chunk[k].isspace():
            k += 1
        cjk_end = any(c in _CJK_SENTENCE_ENDS for c in chunk[i:j])
        if k < n and (cjk_end or _CJK_START_RE.match(chunk[k])):
            sentence = chunk[start:j].strip()
            if sentence:
                pieces.append((sentence, " " if k > j else ""))
            start = k
        i = j
    tail = chunk[start:].strip()
    if tail:
        pieces.append((tail, " "))
    return pieces


def _pause_segments(text: str) -> list[tuple[int, str, str]]:
    """``(chunk index, sentence, joiner)`` per pause sentence; the chunk index
    refers to ``_split_sentences`` (the unit gestures are aligned to)."""
    segments: list[tuple[int, str, str]] = []
    for chunk_idx, chunk in enumerate(_split_sentences(text or "")):
        for sentence, joiner in _split_cjk(chunk):
            segments.append((chunk_idx, sentence, joiner))
    return segments


def split_sentences_for_pauses(text: str) -> list[str]:
    """Sentences counted by ``build_ssml(pause_after_sentence=...)`` (1-based).

    Identical to ``_split_sentences`` for text without CJK. In addition it splits
    after the CJK sentence ends 。！？ (and ｡), which need no following space,
    and after . ! ? when CJK text follows, so zh-CN/ja-JP turns get sentence
    boundaries too. Count and plan reaction pauses with this function.
    """
    return [sentence for _chunk_idx, sentence, _joiner in _pause_segments(text)]


def _sentence_pauses(pause_after_sentence: object, n_sentences: int) -> dict[int, int]:
    """Valid ``{after_sentence: ms}`` entries: 1 <= after_sentence < n_sentences
    (a pause *between* sentences; trailing breaks are truncated by batch avatar
    synthesis), ms rounded and clamped to [PAUSE_MIN_MS, PAUSE_MAX_MS]."""
    if not pause_after_sentence or not isinstance(pause_after_sentence, Mapping) or n_sentences < 2:
        return {}
    pauses: dict[int, int] = {}
    for key, value in pause_after_sentence.items():
        if isinstance(key, bool) or not isinstance(key, int) or not 1 <= key < n_sentences:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            continue
        pauses[key] = min(PAUSE_MAX_MS, max(PAUSE_MIN_MS, int(round(value))))
    return pauses


def _paused_body(text: str, pause_after_sentence: object, gesture_names: Optional[list[str]]) -> Optional[str]:
    """SSML body with the planned breaks, or None when no pause applies."""
    segments = _pause_segments(text)
    pauses = _sentence_pauses(pause_after_sentence, len(segments))
    if not pauses:
        return None
    parts: list[str] = []
    for k, (chunk_idx, sentence, joiner) in enumerate(segments):
        if gesture_names and (k == 0 or segments[k - 1][0] != chunk_idx):
            g = gesture_names[chunk_idx] if chunk_idx < len(gesture_names) else ""
            if g and _is_safe_gesture_name(g):
                parts.append(f"<bookmark mark='gesture.{g}'/>")
        parts.append(_xml_escape(sentence))
        if k < len(segments) - 1:
            ms = pauses.get(k + 1)
            parts.append(f'<break time="{ms}ms"/>' if ms else joiner)
    return "".join(parts)


def _single_gesture_bookmark(intro_gesture_for: Optional[str], gesture_name: Optional[str]) -> str:
    resolved_gesture = gesture_name
    if not resolved_gesture and intro_gesture_for:
        style = AVATAR_STYLES.get(intro_gesture_for, "")
        resolved_gesture = AVATAR_INTRO_GESTURES.get((intro_gesture_for, style))
    if resolved_gesture and _is_safe_gesture_name(resolved_gesture):
        return f"<bookmark mark='gesture.{resolved_gesture}'/>"
    return ""


def build_ssml(
    text: str,
    language: str,
    voice: Optional[str] = None,
    *,
    intro_gesture_for: Optional[str] = None,
    gesture_name: Optional[str] = None,
    gesture_names: Optional[list[str]] = None,
    pause_after_sentence: Optional[dict[int, int]] = None,
) -> str:
    """Build SSML for avatar synthesis.

    Includes a 250 ms leading <break> because Azure batch avatar synthesis
    consistently clips the first ~100 ms of spoken audio; the explicit pause
    preserves the first word (e.g. "Today", "Hello").

    Args:
        text: Narration plain text. Special XML chars are escaped.
        language: BCP-47 locale (e.g. "en-US").
        voice: Explicit voice name (overrides VOICE_MAP).
        intro_gesture_for: Character name (e.g. "lisa", "harry", "max").
            If set AND the (character, style) pair has a docs-verified
            gesture in AVATAR_INTRO_GESTURES, inject the bookmark right
            after the leading pause. Unknown pairs -> no gesture (safe).
            Callers should pass this ONLY on the first slide of a deck.
        gesture_name: Single explicit gesture (back-compat). Inserted
            right after the leading break, before any text.
        gesture_names: Ordered list of gestures aligned to sentences.
            Index 0 lands before sentence 0, index 1 before sentence 1,
            etc. Empty / falsy entries skip a slot. Unsafe entries are
            silently dropped.
        pause_after_sentence: ``{after_sentence: ms}`` planned speaker
            pauses (e.g. room for a listener backchannel). ``after_sentence``
            is 1-based, counted with ``split_sentences_for_pauses`` (CJK
            aware); a ``<break time="{ms}ms"/>`` replaces the space after that
            sentence, gestures still land before their sentence. Only pauses
            between sentences apply (1 <= after_sentence < sentence count) and
            ms is clamped to 100-2000. When nothing applies, the SSML is
            byte-identical to a call without this option.
    """
    voice_name = _attr(voice or VOICE_MAP.get(language, VOICE_MAP["en-US"]))
    language = _attr(language if _LANG_RE.fullmatch(language or "") else "en-US")

    if pause_after_sentence:
        paused = _paused_body(text, pause_after_sentence, gesture_names)
        if paused is not None:
            lead = "" if gesture_names else _single_gesture_bookmark(intro_gesture_for, gesture_name)
            return (
                f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
                f'xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="{language}">'
                f'<voice name="{voice_name}">'
                f'<break time="250ms"/>{lead}{paused}'
                f"</voice></speak>"
            )

    if gesture_names:
        sentences = _split_sentences(text or "")
        if not sentences:
            sentences = [text or ""]
        body_parts: list[str] = []
        for idx, sentence in enumerate(sentences):
            g = gesture_names[idx] if idx < len(gesture_names) else ""
            if g and _is_safe_gesture_name(g):
                body_parts.append(f"<bookmark mark='gesture.{g}'/>")
            body_parts.append(_xml_escape(sentence))
            if idx < len(sentences) - 1:
                body_parts.append(" ")
        body = "".join(body_parts)
        return (
            f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f'xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="{language}">'
            f'<voice name="{voice_name}">'
            f'<break time="250ms"/>{body}'
            f"</voice></speak>"
        )

    safe_text = _xml_escape(text or "")
    gesture = _single_gesture_bookmark(intro_gesture_for, gesture_name)
    return (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        f'xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="{language}">'
        f'<voice name="{voice_name}">'
        f'<break time="250ms"/>{gesture}{safe_text}'
        f"</voice></speak>"
    )


_LANG_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$")


def _attr(value: str) -> str:
    """Escape a value for use inside a double-quoted XML attribute."""
    return _xml_escape(value or "", {'"': "&quot;", "'": "&apos;"})


def _is_safe_gesture_name(value: str) -> bool:
    return value.replace("-", "").isalnum()


def submit_batch_synthesis(
    config: AzureConfig,
    texts: list[str],
    language: str,
    avatar: str | None = None,
) -> str:
    """Submit a batch avatar synthesis job (legacy /api/avatar/synthesis path)."""
    from services import avatar_registry  # local import to avoid cycle

    job_id = str(uuid.uuid4())
    entry = avatar_registry.get(avatar) if avatar else avatar_registry.for_voice("")
    base_url = _get_speech_base_url(config)

    url = f"{base_url}/avatar/batchsyntheses/{job_id}?api-version=2024-08-01"

    combined_text = " ".join(texts)
    ssml = build_ssml(combined_text, language)

    payload = {
        "inputKind": "SSML",
        "inputs": [{"content": ssml}],
        "avatarConfig": avatar_registry.avatar_config_payload(entry),
    }

    headers = {**_get_speech_auth_header(config), "Content-Type": "application/json"}
    response = requests.put(url, headers=headers, json=payload, timeout=30)
    response.raise_for_status()
    return job_id


def get_batch_synthesis_status(config: AzureConfig, job_id: str) -> AvatarJobStatus:
    """Check the status of a batch synthesis job."""
    base_url = _get_speech_base_url(config)
    url = f"{base_url}/avatar/batchsyntheses/{job_id}?api-version=2024-08-01"

    headers = _get_speech_auth_header(config)
    response = requests.get(url, headers=headers, timeout=10)
    response.raise_for_status()

    data = response.json()
    status = data.get("status", "unknown")
    video_url = None
    error = None

    if status == "Succeeded":
        outputs = data.get("outputs", {})
        video_url = outputs.get("result")
        status = "succeeded"
    elif status == "Failed":
        error = data.get("properties", {}).get("error", {}).get("message", "Unknown error")
        status = "failed"
    elif status in ("NotStarted", "Running"):
        status = "running"

    return AvatarJobStatus(
        job_id=job_id, status=status, video_url=video_url, error=error
    )


def wait_for_batch_synthesis(
    config: AzureConfig, job_id: str, timeout: int = 600, poll_interval: int = 5
) -> AvatarJobStatus:
    """Poll until a batch synthesis job completes or times out."""
    start = time.time()
    while time.time() - start < timeout:
        status = get_batch_synthesis_status(config, job_id)
        if status.status in ("succeeded", "failed"):
            return status
        time.sleep(poll_interval)
    return AvatarJobStatus(job_id=job_id, status="timeout", error="Job timed out")
