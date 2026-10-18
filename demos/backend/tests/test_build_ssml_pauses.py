"""``avatar.build_ssml(..., pause_after_sentence=...)``: additive and byte-identical.

``GOLDEN_DIGEST`` was computed from the *unmodified* ``build_ssml`` (before the
``pause_after_sentence`` option existed) over ``_corpus()``. ``_legacy_build_ssml``
is a verbatim copy of that original function: the digest proves the copy is
faithful, and every corpus input is then compared string-for-string so a
regression shows a readable diff. Pauses are counted with the CJK-aware
``split_sentences_for_pauses`` (identical to ``_split_sentences`` without CJK).
"""
from __future__ import annotations

import hashlib
import itertools
import xml.etree.ElementTree as ET
from typing import Optional

import pytest

from services import avatar
from services.avatar import (
    AVATAR_INTRO_GESTURES,
    AVATAR_STYLES,
    VOICE_MAP,
    _LANG_RE,
    _attr,
    _is_safe_gesture_name,
    _split_sentences,
    _xml_escape,
    build_ssml,
    split_sentences_for_pauses,
)

GOLDEN_COUNT = 5824
GOLDEN_DIGEST = "d5eec35c1370ff6705246ff58c616741a41b3e5a497dbb4f03f8a3ed97429ea5"


def _legacy_build_ssml(
    text: str,
    language: str,
    voice: Optional[str] = None,
    *,
    intro_gesture_for: Optional[str] = None,
    gesture_name: Optional[str] = None,
    gesture_names: Optional[list[str]] = None,
) -> str:
    """Verbatim copy of ``build_ssml`` before ``pause_after_sentence`` was added."""
    voice_name = _attr(voice or VOICE_MAP.get(language, VOICE_MAP["en-US"]))
    language = _attr(language if _LANG_RE.fullmatch(language or "") else "en-US")

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
    gesture = ""
    resolved_gesture = gesture_name
    if not resolved_gesture and intro_gesture_for:
        style = AVATAR_STYLES.get(intro_gesture_for, "")
        resolved_gesture = AVATAR_INTRO_GESTURES.get((intro_gesture_for, style))
    if resolved_gesture and _is_safe_gesture_name(resolved_gesture):
        gesture = f"<bookmark mark='gesture.{resolved_gesture}'/>"
    return (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        f'xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="{language}">'
        f'<voice name="{voice_name}">'
        f'<break time="250ms"/>{gesture}{safe_text}'
        f"</voice></speak>"
    )


TEXTS = [
    "",
    "   ",
    "Hello.",
    "Hello world",
    "First sentence. Second sentence.",
    "Why? Because! Yes.",
    "One. Two. Three. Four. Five.",
    "Latency & tokens < 5 > 3 \"quoted\" 'single'. Next & last.",
    "Multi\nline text. With   extra   spaces.\tAnd a tab.",
    "Élan vital. Über alles. Ça va.",
    "e.g. this is tricky. Mr. Smith arrived. dr. who? Yes.",
    "欢迎回到节目。今天我们聊聊人工智能。",
    "Trailing space. ",
    "  Leading space. Next one.  ",
    "One. two lowercase. Three.",
    "Ends with question? And another! Then a period.",
]
LANGUAGES = ["en-US", "fr-FR", "zh-CN", "xx", "", 'en-US"><x', "es-ES"]
VOICES = [None, "en-US-Ava:DragonHDLatestNeural", 'v"/><audio src="x', "fr-FR-Remy:DragonHDLatestNeural"]
OPTIONS: list[dict] = [
    {},
    {"intro_gesture_for": "lisa"},
    {"intro_gesture_for": "harry"},
    {"intro_gesture_for": "unknown"},
    {"gesture_name": "thumbsup-left-1"},
    {"gesture_name": "bad name'/><x"},
    {"gesture_name": "thumbsup-left-1", "intro_gesture_for": "harry"},
    {"gesture_names": []},
    {"gesture_names": ["show-front-1"]},
    {"gesture_names": ["show-front-1", "", "numeric2-left-1"]},
    {"gesture_names": ["bad name'/><x", "think-twice-1"]},
    {"gesture_names": ["a", "b", "c", "d", "e", "f", "g"]},
    {"gesture_names": ["show-front-1"], "gesture_name": "hello", "intro_gesture_for": "lisa"},
]


def _corpus():
    for text, language, voice, opts in itertools.product(TEXTS, LANGUAGES, VOICES, OPTIONS):
        yield text, language, voice, opts


def _digest(outputs: list[str]) -> str:
    return hashlib.sha256("\x1e".join(outputs).encode("utf-8")).hexdigest()


def test_legacy_copy_matches_the_pre_change_golden_digest():
    outputs = [_legacy_build_ssml(t, lang, v, **o) for t, lang, v, o in _corpus()]
    assert len(outputs) == GOLDEN_COUNT
    assert _digest(outputs) == GOLDEN_DIGEST


@pytest.mark.parametrize("pauses", [None, {}, {0: 500, -1: 400, 99: 700}, {"1": 500, None: 300}])
def test_no_applicable_pause_is_byte_identical_to_the_original(pauses):
    for text, language, voice, opts in _corpus():
        expected = _legacy_build_ssml(text, language, voice, **opts)
        if pauses is None:
            assert build_ssml(text, language, voice, **opts) == expected
        assert build_ssml(text, language, voice, pause_after_sentence=pauses, **opts) == expected


def test_pause_after_the_last_sentence_or_a_single_sentence_is_ignored():
    for text, language, voice, opts in _corpus():
        n = len(split_sentences_for_pauses(text or ""))
        expected = _legacy_build_ssml(text, language, voice, **opts)
        assert build_ssml(text, language, voice, pause_after_sentence={max(n, 1): 700}, **opts) == expected


NON_CJK_EXTRA = [
    "Version 2.0 is out. Next steps follow!",
    "Is it? Yes. no. Maybe... Later.",
    "Quote \"done.\" Then more. (Aside.) Final.",
    "Mixed: 3.5 million. Wow! OK? Fine.",
    "Ça marche. À demain! Été? Oui.",
]


@pytest.mark.parametrize("text", TEXTS[:11] + TEXTS[12:] + NON_CJK_EXTRA)
def test_pause_splitter_equals_the_gesture_splitter_without_cjk(text):
    assert split_sentences_for_pauses(text) == _split_sentences(text)


@pytest.mark.parametrize("text, expected", [
    ("欢迎回到节目。今天我们聊聊人工智能。", ["欢迎回到节目。", "今天我们聊聊人工智能。"]),
    ("番組へようこそ。今日は仕事でのAI活用についてお話しします。",
     ["番組へようこそ。", "今日は仕事でのAI活用についてお話しします。"]),
    ("真的吗？我觉得是！太好了。", ["真的吗？", "我觉得是！", "太好了。"]),
    ("真的吗？！当然。", ["真的吗？！", "当然。"]),
    ("他说：“你好。”然后离开了。", ["他说：“你好。”", "然后离开了。"]),
    ("「そうですね。」次に進みます。", ["「そうですね。」", "次に進みます。"]),
    ("真的吗?我觉得是.", ["真的吗?", "我觉得是."]),
    ("你好。 今天见。", ["你好。", "今天见。"]),
    ("版本2.0很好。价格是3.5元。", ["版本2.0很好。", "价格是3.5元。"]),
    ("We use Azure. 我们用它。Then it works.", ["We use Azure.", "我们用它。", "Then it works."]),
    ("只有一句", ["只有一句"]),
])
def test_pause_splitter_finds_cjk_sentence_ends(text, expected):
    assert split_sentences_for_pauses(text) == expected


def test_cjk_pauses_are_inserted_without_spaces():
    ssml = build_ssml("欢迎回到节目。今天我们聊聊人工智能。最后一句。", "zh-CN",
                      voice="zh-CN-Xiaochen:DragonHDLatestNeural", pause_after_sentence={1: 700})
    assert _body(ssml) == '欢迎回到节目。<break time="700ms"/>今天我们聊聊人工智能。最后一句。'
    ssml = build_ssml("你好。 今天见。再见。", "zh-CN", pause_after_sentence={2: 500})
    assert _body(ssml) == '你好。 今天见。<break time="500ms"/>再见。'
    ET.fromstring(ssml)


def test_cjk_pauses_keep_gestures_on_the_gesture_splitter_sentences():
    text = "番組へようこそ。今日はAIの話です. Next part here."
    assert _split_sentences(text) == ["番組へようこそ。今日はAIの話です.", "Next part here."]
    ssml = build_ssml(text, "ja-JP", gesture_names=["hello", "thanks"], pause_after_sentence={1: 600})
    assert _body(ssml) == (
        "<bookmark mark='gesture.hello'/>番組へようこそ。"
        '<break time="600ms"/>今日はAIの話です. '
        "<bookmark mark='gesture.thanks'/>Next part here."
    )
    no_pause = build_ssml(text, "ja-JP", gesture_names=["hello", "thanks"])
    assert no_pause == _legacy_build_ssml(text, "ja-JP", gesture_names=["hello", "thanks"])


def test_cjk_text_without_pauses_is_unchanged():
    for text in ("欢迎回到节目。今天我们聊聊人工智能。", "番組へようこそ。今日は。"):
        for opts in ({}, {"gesture_names": ["show-front-1"]}, {"intro_gesture_for": "lisa"}):
            assert build_ssml(text, "zh-CN", **opts) == _legacy_build_ssml(text, "zh-CN", **opts)
            assert build_ssml(text, "zh-CN", pause_after_sentence={}, **opts) == \
                _legacy_build_ssml(text, "zh-CN", **opts)


def _body(ssml: str) -> str:
    head = '<break time="250ms"/>'
    return ssml.split(head, 1)[1].rsplit("</voice></speak>", 1)[0]


def test_pause_is_inserted_right_after_the_requested_sentence():
    ssml = build_ssml("First point. Second point. Third point.", "en-US",
                      voice="en-US-Ava:DragonHDLatestNeural", pause_after_sentence={1: 700})
    assert _body(ssml) == 'First point.<break time="700ms"/>Second point. Third point.'
    ssml = build_ssml("First point. Second point. Third point.", "en-US",
                      voice="en-US-Ava:DragonHDLatestNeural", pause_after_sentence={2: 650})
    assert _body(ssml) == 'First point. Second point.<break time="650ms"/>Third point.'


def test_several_pauses_and_sentence_count_from_the_shared_splitter():
    text = "Why? Because! Yes. And then."
    assert len(split_sentences_for_pauses(text)) == 4
    ssml = build_ssml(text, "en-US", pause_after_sentence={1: 500, 3: 900})
    assert _body(ssml) == 'Why?<break time="500ms"/>Because! Yes.<break time="900ms"/>And then.'


@pytest.mark.parametrize("raw, expected", [(50, 100), (100, 100), (2000, 2000), (5000, 2000),
                                           (650.4, 650), (712.6, 713)])
def test_pause_values_are_clamped_and_rounded(raw, expected):
    ssml = build_ssml("One. Two.", "en-US", pause_after_sentence={1: raw})
    assert f'<break time="{expected}ms"/>' in ssml


@pytest.mark.parametrize("bad", [None, "700", float("nan"), float("inf"), True])
def test_invalid_pause_values_are_ignored(bad):
    expected = _legacy_build_ssml("One. Two.", "en-US")
    assert build_ssml("One. Two.", "en-US", pause_after_sentence={1: bad}) == expected


def test_text_is_still_escaped_when_pauses_split_it():
    ssml = build_ssml('A & B are "fine". C < D > E.', "en-US", pause_after_sentence={1: 600})
    assert _body(ssml) == 'A &amp; B are "fine".<break time="600ms"/>C &lt; D &gt; E.'
    ET.fromstring(ssml)  # well-formed


def test_pauses_compose_with_sentence_gestures():
    ssml = build_ssml(
        "Welcome here. The second step is context engineering. Third.",
        "en-US",
        voice="en-US-Ava:DragonHDLatestNeural",
        gesture_names=["show-front-1", "numeric2-left-1"],
        pause_after_sentence={1: 700},
    )
    assert _body(ssml) == (
        "<bookmark mark='gesture.show-front-1'/>Welcome here."
        '<break time="700ms"/>'
        "<bookmark mark='gesture.numeric2-left-1'/>The second step is context engineering. Third."
    )
    ET.fromstring(ssml)


@pytest.mark.parametrize("opts, bookmark", [
    ({"gesture_name": "hello"}, "<bookmark mark='gesture.hello'/>"),
    ({"intro_gesture_for": "harry"}, "<bookmark mark='gesture.hello'/>"),
    ({"intro_gesture_for": "unknown"}, ""),
])
def test_pauses_compose_with_the_single_leading_gesture(opts, bookmark):
    ssml = build_ssml("Hi there. Next one.", "en-US", voice="en-US-Andrew:DragonHDLatestNeural",
                      pause_after_sentence={1: 800}, **opts)
    assert _body(ssml) == f'{bookmark}Hi there.<break time="800ms"/>Next one.'
    assert ssml.startswith(_legacy_build_ssml("Hi there. Next one.", "en-US",
                                              "en-US-Andrew:DragonHDLatestNeural", **opts).split("<break")[0])


def test_inter_sentence_whitespace_is_normalised_only_when_a_pause_applies():
    text = "Multi\nline text. With   extra   spaces.\tAnd a tab."
    ssml = build_ssml(text, "en-US", pause_after_sentence={2: 500})
    assert _body(ssml) == 'Multi\nline text. With   extra   spaces.<break time="500ms"/>And a tab.'


def test_the_option_is_keyword_only_and_documented():
    import inspect

    param = inspect.signature(avatar.build_ssml).parameters["pause_after_sentence"]
    assert param.kind is inspect.Parameter.KEYWORD_ONLY
    assert param.default is None
    assert "pause_after_sentence" in (avatar.build_ssml.__doc__ or "")
