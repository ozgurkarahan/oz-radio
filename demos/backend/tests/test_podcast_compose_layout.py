"""Unit tests for the podcast video layout (geometry contract v1).

Pure tests — no ffmpeg needed. They pin the filtergraph produced by
``podcast_compose._build_segment_filter`` (tiles, live listener sources,
reaction overlays, turn dissolve, input indices), the segment input
arguments, the listener plan/fallback ladder, ``choose_loop_offset``, the ASS
caption placement and wrapping, slide resolution and the avatar-registry crop
rects.
"""
from __future__ import annotations

import inspect
import logging
import re
from pathlib import Path

import numpy as np
import pytest

from services import avatar_registry
from services import podcast_compose as pc
from services.podcast_models import Document, Section
from services.podcast_render import ClipManifest, DialogueTurn, RenderRoles, RoleConfig, Script

NAMES = {"interviewer": "Dr. Harry Chen", "expert": "Dr. Lisa Patel"}


def _chains(fc: str) -> list[str]:
    return [c for c in fc.split(";") if c]


def _chain_for(fc: str, out_label: str) -> str:
    matches = [c for c in _chains(fc) if c.endswith(out_label)]
    assert len(matches) == 1, f"expected exactly one chain ending with {out_label}"
    return matches[0]


def _build(**kw) -> str:
    base = dict(
        active_speaker="interviewer",
        total_dur=3.0,
        active=pc.SpeakerVisual(chroma_key=False, crop=(0.3, 0.0, 0.4, 0.5)),
        idle=pc.SpeakerVisual(chroma_key=False, crop=(0.1, 0.0, 0.8, 0.9)),
        names=NAMES,
    )
    base.update(kw)
    return pc._build_segment_filter(**base)


# ---------------------------------------------------------------------------
# Slide region
# ---------------------------------------------------------------------------

def test_slide_is_contained_never_stretched():
    fc = _build()
    slide = _chain_for(fc, "[slide]")
    assert slide.startswith("[0:v]")
    assert "scale=1280:720:force_original_aspect_ratio=decrease" in slide
    assert "pad=1280:720:(ow-iw)/2:(oh-ih)/2" in slide
    assert "setsar=1" in slide
    assert "crop=" not in slide
    assert "scale=1920:810" not in fc and "1920x810" not in fc and "vstack" not in fc
    assert "overlay=x=320:y=360" in fc


def test_canvas_is_full_hd_with_dark_background():
    fc = _build()
    bg = _chain_for(fc, "[bg]")
    assert f"color=c={pc.BG_COLOR}:s=1920x1080" in bg


# ---------------------------------------------------------------------------
# Avatar tiles
# ---------------------------------------------------------------------------

def test_tiles_are_top_left_and_top_right():
    fc = _build(active_speaker="interviewer")
    assert "[av_a]overlay=x=0:y=0" in fc
    assert "[av_i]overlay=x=1360:y=0" in fc
    fc = _build(active_speaker="expert")
    assert "[av_a]overlay=x=1360:y=0" in fc
    assert "[av_i]overlay=x=0:y=0" in fc


@pytest.mark.parametrize("label", ["[av_a]", "[av_i]"])
def test_tile_chain_order_chroma_crop_scale_pad_format(label):
    fc = _build(
        active=pc.SpeakerVisual(chroma_key=True, crop=(0.3, 0.0, 0.4, 0.5)),
        idle=pc.SpeakerVisual(chroma_key=True, crop=(0.1, 0.0, 0.8, 0.9)),
    )
    chain = _chain_for(fc, label)
    i_key = chain.index("chromakey=0x00ff00")
    i_spill = chain.index("despill=")
    i_crop = chain.index("crop=")
    i_scale = chain.index("scale=560:360:force_original_aspect_ratio=decrease")
    i_pad = chain.index("pad=560:360")
    i_fmt = chain.rindex("format=yuva420p")
    assert i_key < i_spill < i_crop < i_scale < i_pad < i_fmt


def test_chroma_key_is_per_speaker():
    # Active = transparent WebM (no key), idle = green-screen photo (key).
    fc = _build(
        active=pc.SpeakerVisual(chroma_key=False),
        idle=pc.SpeakerVisual(chroma_key=True),
    )
    assert "chromakey" not in _chain_for(fc, "[av_a]")
    assert "chromakey" in _chain_for(fc, "[av_i]")
    # ...and the other way round.
    fc = _build(
        active=pc.SpeakerVisual(chroma_key=True),
        idle=pc.SpeakerVisual(chroma_key=False),
    )
    assert "chromakey" in _chain_for(fc, "[av_a]")
    assert "chromakey" not in _chain_for(fc, "[av_i]")


def test_input_indices_with_slides():
    fc = _build()
    assert _chain_for(fc, "[av_a]").startswith("[1:v]")
    assert _chain_for(fc, "[av_i]").startswith("[2:v]")
    assert _chain_for(fc, "[aout]").startswith("[1:a]")


LISTENERS = {
    "still": pc.ListenerSource("still", Path("idle.png")),
    "procedural": pc.ListenerSource("procedural", Path("idle.png"), offset=1.25),
    "idle_loop": pc.ListenerSource("idle_loop", Path("loop.mp4"), offset=1.24, loop_duration=4.0),
    "idle_loop_alpha": pc.ListenerSource("idle_loop", Path("loop.webm"), offset=0.4, has_alpha=True,
                                         loop_duration=4.0),
}


@pytest.mark.parametrize("mode", sorted(LISTENERS))
def test_listener_is_full_colour_never_dimmed(mode):
    fc = _build(listener=LISTENERS[mode],
                reactions=[pc.SegmentReaction(at=1.0, duration=0.6)], dissolve=True)
    assert "colorchannelmixer" not in fc
    assert "IDLE_DIM" not in dir(pc)
    assert "colorchannelmixer" not in _chain_for(fc, "[av_i]")


def test_active_tile_gets_clay_frame():
    fc = _build(active_speaker="expert")
    assert f"drawbox=x=1360:y=0:w=560:h=360:color={pc.ACCENT_COLOR}:t=4" in fc
    assert pc.ACCENT_COLOR.upper() == "#B8461E"
    fc = _build(active_speaker="interviewer")
    assert f"drawbox=x=0:y=0:w=560:h=360:color={pc.ACCENT_COLOR}:t=4" in fc
    # Soft inner glow just inside the clay frame.
    assert f"drawbox=x=4:y=4:w=552:h=352:color={pc.ACCENT_COLOR}@{pc.GLOW_ALPHA}:t=4" in fc


@pytest.mark.parametrize("active,listener_tile", [("interviewer", (1360, 0)), ("expert", (0, 0))])
def test_listener_tile_gets_subtle_neutral_border(active, listener_tile):
    fc = _build(active_speaker=active)
    x, y = listener_tile
    border = f"drawbox=x={x}:y={y}:w=560:h=360:color={pc.LISTENER_BORDER_COLOR}:t=2"
    assert border in fc
    assert pc.LISTENER_BORDER_PX == 2
    # Neutral (grey-blue), not the clay accent, and drawn after the overlays.
    assert pc.LISTENER_BORDER_COLOR.upper() != pc.ACCENT_COLOR.upper()
    assert fc.index(border) > fc.index("[av_i]overlay=")
    # Only the active tile carries the clay frame.
    assert f"drawbox=x={x}:y={y}:w=560:h=360:color={pc.ACCENT_COLOR}" not in fc


def _label_sizes(fc: str) -> list[tuple[str, int]]:
    return [(text, int(size)) for text, size in
            re.findall(r"drawtext=text='([^']*)':x=[^:]+:y=\d+:fontsize=(\d+)", fc)]


@pytest.mark.parametrize("layout", ["split_screen_with_slides", "split_screen_only"])
def test_label_font_sizes_identical_for_both_speakers(layout):
    a = dict(_label_sizes(_build(layout=layout, active_speaker="interviewer")))
    b = dict(_label_sizes(_build(layout=layout, active_speaker="expert")))
    labels = [t for t in a if t != "2 / 7"]
    assert labels and a == b
    if layout == "split_screen_with_slides":
        assert a["Dr. Harry Chen"] == a["Dr. Lisa Patel"] == pc.LABEL_NAME_SIZE
        assert a["Interviewer"] == a["Expert"] == pc.LABEL_ROLE_SIZE
    else:
        assert {a[t] for t in labels} == {pc.LABEL_LINE_SIZE}


def test_active_label_marked_by_colour_and_accent_bar():
    fc = _build(active_speaker="interviewer")
    assert "drawtext=text='Dr. Harry Chen':x=588:y=14:fontsize=28:fontcolor=white" in fc
    assert "drawtext=text='Dr. Lisa Patel':x=1332-text_w:y=14:fontsize=28:fontcolor=#94A3B8" in fc
    assert f"drawbox=x=570:y=14:w=6:h=68:color={pc.ACCENT_COLOR}:t=fill" in fc
    assert f"drawbox=x=1344:y=14:w=6:h=68:color={pc.ACCENT_COLOR}:t=fill" not in fc


def test_crop_is_normalized_even_and_clamped():
    f = pc._crop_filter((0.25, 0.1, 0.5, 0.4))
    assert f == (
        "crop=w=trunc(iw*0.5000/2)*2:h=trunc(ih*0.4000/2)*2:"
        "x=trunc(iw*0.2500/2)*2:y=trunc(ih*0.1000/2)*2"
    )
    x, y, w, h = pc._clamp_crop((0.9, -1.0, 0.8, 5.0))
    assert x == 0.9 and y == 0.0
    assert x + w <= 1.0 + 1e-9 and y + h <= 1.0 + 1e-9
    assert pc._clamp_crop("garbage") == avatar_registry.PODCAST_CROP_PREBUILT


def test_no_idle_frame_skips_idle_overlay():
    fc = _build(has_idle=False)
    assert "[av_i]" not in fc
    assert "[2:v]" not in fc


def test_lead_in_pads_video_and_delays_audio():
    fc = _build(lead_in=0.5)
    assert "tpad=start_duration=0.500:start_mode=clone" in _chain_for(fc, "[av_a]")
    assert "adelay=500|500" in fc


def test_labels_in_centre_zone_and_counter_in_gutter():
    fc = _build(slide_counter="2 / 7")
    assert "Dr. Harry Chen" in fc and "Dr. Lisa Patel" in fc
    assert "Interviewer" in fc and "Expert" in fc
    # Label text never drops below the 96 px label zone.
    for y in re.findall(r"drawtext=text='[^']*':x=[^:]+:y=(\d+)", fc):
        assert int(y) < 96 or int(y) >= 1000  # labels, or the gutter counter
    assert "text='2 / 7'" in fc


def test_split_screen_only_layout():
    fc = _build(layout="split_screen_only")
    assert "[slide]" not in fc
    assert _chain_for(fc, "[av_a]").startswith("[0:v]")
    assert _chain_for(fc, "[av_i]").startswith("[1:v]")
    assert _chain_for(fc, "[aout]").startswith("[0:a]")
    assert "scale=960:900:force_original_aspect_ratio=decrease" in fc
    assert "[av_a]overlay=x=0:y=0" in fc and "[av_i]overlay=x=960:y=0" in fc
    for y in re.findall(r"drawtext=text='[^']*':x=[^:]+:y=(\d+)", fc):
        assert 900 <= int(y) < 960


def test_unknown_layout_falls_back_to_default():
    assert pc.get_layout("nope").name == "split_screen_with_slides"
    assert pc.get_layout(None).name == "split_screen_with_slides"


def test_compose_podcast_layout_parameter_default():
    sig = inspect.signature(pc.compose_podcast)
    assert sig.parameters["layout"].default == "split_screen_with_slides"


def test_compose_podcast_signature_is_backward_compatible():
    params = list(inspect.signature(pc.compose_podcast).parameters.values())
    assert [p.name for p in params[:9]] == [
        "clips", "document", "script", "roles", "out_dir", "music", "intro", "music_path", "layout",
    ]
    kw = {p.name: p for p in params[9:]}
    assert set(kw) == {"listener_kits", "reactions", "reaction_clips", "seed"}
    assert all(p.kind is inspect.Parameter.KEYWORD_ONLY for p in kw.values())
    assert kw["listener_kits"].default is None and kw["reactions"].default is None
    assert kw["reaction_clips"].default is None and kw["seed"].default == ""
    res = pc.ComposeResult(mp4=Path("a.mp4"), mp3=Path("a.mp3"), srt=Path("a.srt"))
    assert res.timeline is None and res.warnings == []


# ---------------------------------------------------------------------------
# Live listener sources
# ---------------------------------------------------------------------------

def _sublist(haystack: list[str], needle: list[str]) -> bool:
    n = len(needle)
    return any(haystack[i:i + n] == needle for i in range(len(haystack) - n + 1))


def _inputs(listener, reactions=(), prev_frame=None, layout="split_screen_with_slides"):
    return pc._segment_inputs(
        layout=layout, total_dur=3.0, slide_path=Path("slide.png"), clip_path=Path("clip.mp4"),
        listener=listener, reactions=reactions, prev_frame=prev_frame,
    )


def test_idle_loop_input_is_stream_looped_and_trimmed_from_offset():
    loop = LISTENERS["idle_loop"]
    args = _inputs(loop)
    # Finite loop count covering offset + segment (1.24 + 3.0 s of a 4 s loop → 2).
    assert _sublist(args, ["-stream_loop", "2", "-i", "loop.mp4"])
    assert args.count("-stream_loop") == 1          # only the loop is looped
    fc = _build(listener=loop, idle=pc.SpeakerVisual(chroma_key=True))
    chain = _chain_for(fc, "[av_i]")
    assert chain.startswith("[2:v]trim=start=1.240:duration=3.000,setpts=PTS-STARTPTS,")
    # Green mp4 loop: keyed first, then the usual crop/scale/pad.
    assert chain.index("trim=") < chain.index("chromakey=") < chain.index("crop=") < chain.index("pad=")
    # Idle-loop audio is never used.
    assert "[2:a]" not in fc


def test_loop_count_is_finite_and_covers_the_window():
    def count(offset, total, loop):
        return pc._loop_count(pc.ListenerSource("idle_loop", Path("l.webm"), offset=offset,
                                                loop_duration=loop), total)
    assert count(0.4, 3.0, 4.0) == 1                 # 2 passes (8 s) ≥ 3.4 s
    assert count(3.96, 30.0, 4.0) == 9               # 10 passes (40 s) ≥ 33.96 s
    assert count(0.0, 4.0, 4.0) == 1
    for offset, total, loop in ((0.4, 3.0, 4.0), (3.96, 30.0, 4.0), (2.5, 61.3, 7.2)):
        n = count(offset, total, loop)
        assert (n + 1) * loop >= offset + total + loop - 1e-9   # one spare pass
    assert count(0.0, 3.0, 0.0) == -1                # unknown length: endless (render is time-bounded)


def test_alpha_idle_loop_skips_chroma_key():
    fc = _build(listener=LISTENERS["idle_loop_alpha"], idle=pc.SpeakerVisual(chroma_key=True))
    chain = _chain_for(fc, "[av_i]")
    assert chain.startswith("[2:v]trim=start=0.400:duration=3.000,")
    assert "chromakey" not in chain and "despill" not in chain
    assert "format=yuva420p" in chain


def test_procedural_listener_is_a_supersampled_subtle_sway():
    src = LISTENERS["procedural"]
    args = _inputs(src)
    # One still frame (no -loop): it is looped inside the graph after the ×4 upscale.
    assert args[args.index("clip.mp4") + 1:] == ["-i", "idle.png"]
    chain = _chain_for(_build(listener=src), "[av_i]")
    i_pad = chain.index("pad=560:360")
    i_ss = chain.index("scale=2240:1440")
    i_444 = chain.index("format=yuva444p")          # zoompan rounds 4:2:0 crops to even pixels
    i_loop = chain.index("loop=loop=-1:size=1")
    i_zoom = chain.index("zoompan=")
    assert i_pad < i_ss < i_444 < i_loop < i_zoom
    # zoompan's input and output share one format: 4:4:4 is pinned on both sides.
    assert re.search(r"zoompan=[^,]*(,[^,]*)*?fps=25,format=yuva444p,trim=", chain)
    assert ":d=1:s=560x360:fps=25" in chain and "trim=duration=3.000" in chain
    amp = float(re.search(r"z='1\+([0-9.]+)\*", chain).group(1))
    period = float(re.search(r"\)/([0-9.]+)\)\)'", chain).group(1))
    assert 0 < amp <= 0.01 and amp * 360 <= 2.0 + 1e-6      # ≤ 1 % zoom, ≤ 2 px drift
    assert 5.0 <= period <= 6.0
    assert "+1.250)" in chain                                # phase continues from the cursor
    assert "y='ih'" in chain                                  # clipped to ih-h: bottom-anchored


def test_procedural_sway_amplitude_respects_drift_on_large_tiles():
    chain = _chain_for(_build(listener=LISTENERS["procedural"], layout="split_screen_only"), "[av_i]")
    amp = float(re.search(r"z='1\+([0-9.]+)\*", chain).group(1))
    assert amp * 900 <= 2.0 + 1e-3
    assert "scale=3840:3600" in chain and "s=960x900" in chain


def test_still_listener_input_is_a_looped_still():
    args = _inputs(LISTENERS["still"])
    assert _sublist(args, ["-loop", "1", "-t", "3.000", "-i", "idle.png"])
    chain = _chain_for(_build(listener=LISTENERS["still"]), "[av_i]")
    assert "zoompan" not in chain and "trim" not in chain


def test_default_listener_is_the_plain_still():
    assert _build() == _build(listener=LISTENERS["still"])


# ---------------------------------------------------------------------------
# Reactions
# ---------------------------------------------------------------------------

def test_reaction_overlay_fades_over_the_listener_tile_and_mixes_audio():
    rx = pc.SegmentReaction(at=1.2, duration=0.6, gain_db=-4.0, has_alpha=True)
    fc = _build(active_speaker="interviewer", listener=LISTENERS["idle_loop"], reactions=[rx],
                idle=pc.SpeakerVisual(chroma_key=True))
    video = _chain_for(fc, "[rx0]")
    assert video.startswith("[rxb0][rxk0]overlay=")
    assert "fade=t=in:st=0:d=0.100:alpha=1" in video
    assert "fade=t=out:st=0.500:d=0.100:alpha=1" in video
    assert video.endswith("setpts=PTS+1.200/TB[rx0]")
    keyed = _chain_for(fc, "[rxk0]")
    assert keyed.startswith("[3:v]trim=duration=0.600,setpts=PTS-STARTPTS,")
    assert "chromakey" not in keyed                       # pre-keyed VP9+alpha clip
    assert "scale=560:360:force_original_aspect_ratio=decrease" in keyed
    assert f"color=c={pc.TILE_BG_COLOR}:s=560x360:r=25:d=0.600" in _chain_for(fc, "[rxb0]")
    # On the listener tile (expert, right), only while the reaction plays.
    overlay = _chain_for(fc, "[c_r0]")
    assert overlay == (
        "[c_i][rx0]overlay=x=1360:y=0:eof_action=pass:enable='between(t,1.200,1.800)'[c_r0]"
    )
    # Audio under the speaker: delayed, attenuated, summed without normalisation.
    ra = _chain_for(fc, "[ra0]")
    assert ra.startswith("[4:a]atrim=duration=0.600,asetpts=PTS-STARTPTS,")
    assert "volume=-4.00dB" in ra and ra.endswith("adelay=delays=1200:all=1[ra0]")
    assert _chain_for(fc, "[spk]") == "[1:a]anull[spk]"
    assert _chain_for(fc, "[aout]") == (
        "[spk][ra0]amix=inputs=2:normalize=0:duration=first:dropout_transition=0[aout]"
    )


def test_green_reaction_clip_is_keyed_first():
    rx = pc.SegmentReaction(at=0.5, duration=0.5, has_alpha=False)
    fc = _build(reactions=[rx], idle=pc.SpeakerVisual(chroma_key=True))
    keyed = _chain_for(fc, "[rxk0]")
    assert keyed.index("trim=") < keyed.index("chromakey=") < keyed.index("crop=")


def test_short_reaction_fades_never_overlap():
    rx = pc.SegmentReaction(at=0.5, duration=0.14)
    video = _chain_for(_build(reactions=[rx]), "[rx0]")
    assert "fade=t=in:st=0:d=0.070:alpha=1" in video
    assert "fade=t=out:st=0.070:d=0.070:alpha=1" in video


def test_no_reactions_keeps_plain_speech():
    fc = _build()
    assert _chain_for(fc, "[aout]") == "[1:a]anull[aout]"
    assert "amix" not in fc and "[rx" not in fc


def _placement(**kw):
    from services.podcast_media import ReactionPlacement

    base = dict(turn_idx=3, listener="expert", reaction_id="ack", at_sec=1.0, duration_sec=0.6)
    base.update(kw)
    return ReactionPlacement(**base)


def test_segment_reactions_skip_missing_wrong_or_unfit(tmp_path):
    from services.podcast_media import ReactionClip

    video, audio = tmp_path / "ack.webm", tmp_path / "ack.wav"
    video.write_bytes(b"v")
    audio.write_bytes(b"a")
    clips = {
        "ack": ReactionClip("ack", "Mm-hmm.", audio, video, 0.5, has_alpha=True),
        "yeah": ReactionClip("yeah", "Yeah.", audio, None, 0.4),
        "right": ReactionClip("right", "Right.", tmp_path / "gone.wav", video, 0.4),
    }
    lookup = lambda listener, rid: clips.get(rid) if listener == "expert" else None  # noqa: E731
    placements = [
        _placement(at_sec=1.0, duration_sec=0.6),                 # clamped to the clip (0.5 s)
        _placement(listener="interviewer"),                      # the speaker cannot react
        _placement(reaction_id="yeah"),                          # audio-only clip: no video
        _placement(reaction_id="right"),                         # audio file missing
        _placement(reaction_id="isee"),                          # unknown clip
        _placement(at_sec=2.95, duration_sec=0.5),               # does not fit the segment
        _placement(at_sec=2.6, duration_sec=0.5),                # clamped to the segment end
    ]
    out, skipped = pc._segment_reactions(placements, "expert", 3.0, 0.0, lookup)
    assert skipped == 5
    assert [(r.at, r.duration) for r in out] == [(1.0, 0.5), (2.6, 0.4)]
    assert all(r.has_alpha and r.video == video and r.audio == audio for r in out)
    assert out[0].gain_db == -4.0
    # Lead-in shifts reactions with the speech.
    out, _ = pc._segment_reactions(placements[:1], "expert", 3.5, 0.5, lookup)
    assert out[0].at == 1.5


def test_reaction_lookup_prefers_explicit_clips_then_kit():
    from services.podcast_media import ListenerKit, ReactionClip

    mine = ReactionClip("ack", "Mm-hmm.", Path("a.wav"), Path("a.webm"), 0.5)
    kit_clip = ReactionClip("ack", "Mm-hmm.", Path("k.wav"), Path("k.webm"), 0.5)
    kit = ListenerKit(avatar_id="x", voice="v", mode="still", idle=None, reactions={"ack": kit_clip})
    lookup = pc._reaction_lookup({"interviewer": {"ack": mine}}, {"expert": kit})
    assert lookup("interviewer", "ack") is mine
    assert lookup("expert", "ack") is kit_clip
    assert lookup("expert", "yeah") is None
    assert pc._reaction_lookup(None, {})("expert", "ack") is None


# ---------------------------------------------------------------------------
# Turn dissolve
# ---------------------------------------------------------------------------

def test_dissolve_only_with_a_previous_frame():
    fc = _build()
    assert "xfade" not in fc and "[vprev]" not in fc
    fc = _build(dissolve=True)
    prev = _chain_for(fc, "[vprev]")
    assert prev.startswith("[3:v]scale=1920:1080,setsar=1,format=yuv420p,")
    # setpts resets the frame rate on ffmpeg ≥ 6.1; xfade needs it: fps closes the chain.
    assert prev.endswith("trim=duration=0.16,setpts=PTS-STARTPTS,fps=25[vprev]")
    assert _chain_for(fc, "[vmain]").endswith(",format=yuv420p,setsar=1,fps=25[vmain]")
    assert _chain_for(fc, "[vout]") == (
        "[vprev][vmain]xfade=transition=fade:duration=0.16:offset=0[vout]"
    )
    assert pc.DISSOLVE_SEC == 0.16
    args = _inputs(LISTENERS["still"], prev_frame=Path("last.png"))
    assert args[-8:] == ["-loop", "1", "-framerate", "25", "-t", "0.24", "-i", "last.png"]


# ---------------------------------------------------------------------------
# Input indices — pinned for every combination
# ---------------------------------------------------------------------------

def _input_files(args: list[str]) -> list[str]:
    return [args[i + 1] for i, a in enumerate(args) if a == "-i"]


@pytest.mark.parametrize("layout", ["split_screen_with_slides", "split_screen_only"])
@pytest.mark.parametrize("mode", [None, "still", "procedural", "idle_loop"])
@pytest.mark.parametrize("n_rx", [0, 2])
@pytest.mark.parametrize("dissolve", [False, True])
def test_input_indices_pinned_for_every_combination(layout, mode, n_rx, dissolve):
    listener = LISTENERS[mode] if mode else None
    rx = [pc.SegmentReaction(at=0.5 + j, duration=0.5, video=Path(f"rx{j}.mp4"),
                             audio=Path(f"rx{j}.wav")) for j in range(n_rx)]
    slides = layout == "split_screen_with_slides"
    fc = _build(layout=layout, listener=listener, has_idle=listener is not None,
                reactions=rx, dissolve=dissolve)
    files = _input_files(_inputs(listener, rx, Path("last.png") if dissolve else None, layout))
    expected = (["slide.png"] if slides else []) + ["clip.mp4"]
    expected += [str(listener.path)] if listener else []
    for j in range(n_rx):
        expected += [f"rx{j}.mp4", f"rx{j}.wav"]
    expected += ["last.png"] if dissolve else []
    assert files == expected

    idx = pc._segment_input_indices(layout=layout, has_listener=listener is not None,
                                    n_reactions=n_rx, dissolve=dissolve)
    at = {name: i for i, name in enumerate(files)}
    assert idx.active == at["clip.mp4"]
    assert _chain_for(fc, "[av_a]").startswith(f"[{at['clip.mp4']}:v]")
    speech = "[spk]" if n_rx else "[aout]"
    assert _chain_for(fc, speech).startswith(f"[{at['clip.mp4']}:a]")
    if slides:
        assert idx.slide == 0 and _chain_for(fc, "[slide]").startswith("[0:v]")
    else:
        assert idx.slide is None and "[slide]" not in fc
    if listener:
        assert _chain_for(fc, "[av_i]").startswith(f"[{at[str(listener.path)]}:v]")
    else:
        assert idx.listener is None and "[av_i]" not in fc
    for j in range(n_rx):
        assert idx.reactions[j] == (at[f"rx{j}.mp4"], at[f"rx{j}.wav"])
        assert _chain_for(fc, f"[rxk{j}]").startswith(f"[{at[f'rx{j}.mp4']}:v]")
        assert _chain_for(fc, f"[ra{j}]").startswith(f"[{at[f'rx{j}.wav']}:a]")
    if dissolve:
        assert idx.prev == at["last.png"]
        assert _chain_for(fc, "[vprev]").startswith(f"[{at['last.png']}:v]")
    else:
        assert idx.prev is None
    # Every input is consumed exactly once.
    used = sorted(int(m) for m in re.findall(r"\[(\d+):[va]\]", fc))
    assert sorted(set(used)) == list(range(len(files)))


# ---------------------------------------------------------------------------
# Listener planning, fallback ladder, loop offsets
# ---------------------------------------------------------------------------

def _kit(tmp_path, mode="idle_loop", with_file=True):
    from services.podcast_media import IdleLoop, ListenerKit

    loop = tmp_path / "loop.webm"
    if with_file:
        loop.write_bytes(b"x")
    idle = IdleLoop(path=loop, duration_sec=4.0, has_alpha=True, signature_path=None,
                    motion_score=1.0, static=False)
    return ListenerKit(avatar_id="a", voice="v", mode=mode,
                       idle=idle if mode == "idle_loop" else None, reactions={})


def test_resolve_listener_mode_matrix(tmp_path):
    kit = _kit(tmp_path)
    r = pc._resolve_listener_mode
    assert r("auto", kit, True) == "idle_loop"
    assert r("idle_loop", kit, False) == "idle_loop"        # the loop needs no still
    assert r("still", kit, True) == "still"
    assert r("still", kit, False) == "none"
    assert r("procedural", kit, True) == "procedural"
    assert r("procedural", None, False) == "none"
    assert r("auto", None, True) == "procedural"            # no kit: alive by default
    assert r("auto", _kit(tmp_path, "procedural"), True) == "procedural"
    assert r("auto", _kit(tmp_path, "still"), True) == "still"
    missing = _kit(tmp_path / "nope", with_file=False)
    assert r("auto", missing, True) == "procedural"         # kit loop gone → next in chain


def test_attempt_ladder_falls_back_to_the_plain_still():
    loop, still = LISTENERS["idle_loop"], LISTENERS["still"]
    rx = (pc.SegmentReaction(at=1.0, duration=0.5),)
    prev = Path("last.png")
    assert pc._attempt_ladder(loop, still, rx, prev) == [
        (loop, rx, prev), (still, rx, prev), (still, (), None),
    ]
    assert pc._attempt_ladder(still, still, (), None) == [(still, (), None)]
    assert pc._attempt_ladder(loop, None, (), None) == [(loop, (), None), (None, (), None)]
    assert pc._attempt_ladder(None, None, rx, None) == [(None, rx, None), (None, (), None)]


def test_lowest_mode_reports_the_lowest_fidelity():
    assert pc._lowest_mode(["idle_loop", "idle_loop"]) == "idle_loop"
    assert pc._lowest_mode(["idle_loop", "procedural"]) == "procedural"
    assert pc._lowest_mode(["procedural", "still", "idle_loop"]) == "still"
    assert pc._lowest_mode(["idle_loop", "none"]) == "still"
    assert pc._lowest_mode([]) == "still"


def test_seeded_offsets_are_deterministic_per_job_and_role():
    a = pc._seeded_unit("job-1", "expert")
    assert a == pc._seeded_unit("job-1", "expert") and 0.0 <= a < 1.0
    assert a != pc._seeded_unit("job-1", "interviewer")
    assert a != pc._seeded_unit("job-2", "expert")


def _signatures(n=100, size=8, seed=7):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(n, size, size), dtype=np.uint8)


def test_choose_loop_offset_without_signatures_follows_the_cursor():
    assert pc.choose_loop_offset(4.0, 3.0, 1.23) == 1.24          # snapped to 25 fps
    assert pc.choose_loop_offset(4.0, 3.0, 9.5) == 1.52           # wrapped (9.5 mod 4)
    assert pc.choose_loop_offset(4.0, 3.0, 3.99) == 0.0           # never == loop length
    assert pc.choose_loop_offset(0.0, 3.0, 1.0) == 0.0
    sig = _signatures()
    # Signatures without targets (or of another shape) → the cursor.
    assert pc.choose_loop_offset(4.0, 3.0, 1.0, signatures=sig) == 1.0
    assert pc.choose_loop_offset(4.0, 3.0, 1.0, signatures=sig,
                                 entry_frame=np.zeros((4, 4), np.uint8)) == 1.0


def test_choose_loop_offset_matches_the_entry_pose():
    sig = _signatures()
    noisy = np.clip(sig[37].astype(int) + 3, 0, 255).astype(np.uint8)
    assert pc.choose_loop_offset(4.0, 2.0, 0.0, signatures=sig, entry_frame=noisy) == 1.48


def test_choose_loop_offset_matches_the_exit_pose_with_wraparound():
    sig = _signatures()
    shown = 50                                   # 2.0 s at 25 fps
    # Exit target = frame 10 → the stretch must start at (10 - 49) mod 100 = 61.
    assert pc.choose_loop_offset(4.0, 2.0, 0.0, signatures=sig, exit_frame=sig[10]) == 2.44
    assert (61 + shown - 1) % 100 == 10


def test_choose_loop_offset_balances_entry_and_exit():
    n, size = 100, 8
    base = np.full((n, size, size), 128, np.uint8)
    entry = np.full((size, size), 10, np.uint8)
    exit_ = np.full((size, size), 240, np.uint8)
    sig = base.copy()
    sig[20] = 12                 # good entry, poor exit (frame 69 is neutral)
    sig[30] = 15                 # good entry ...
    sig[79] = 238                # ... and its exit (30 + 50 - 1) matches too
    assert pc.choose_loop_offset(4.0, 2.0, 0.0, signatures=sig,
                                 entry_frame=entry, exit_frame=exit_) == 1.2


def test_choose_loop_offset_ties_go_to_the_cursor():
    sig = np.zeros((100, 4, 4), np.uint8)        # every frame matches equally
    target = np.zeros((4, 4), np.uint8)
    assert pc.choose_loop_offset(4.0, 1.0, 2.2, signatures=sig, entry_frame=target) == 2.2
    sig[[10, 90]] = 5
    sig[50] = 5
    target[:] = 5
    # Frames 10, 50 and 90 tie; the cursor (3.9 s → frame 98) is closest to 90 (wrapping).
    assert pc.choose_loop_offset(4.0, 1.0, 3.9, signatures=sig, entry_frame=target) == 3.6


def test_choose_loop_offset_uses_the_signature_rate():
    sig = _signatures(n=50)                      # 12.5 signatures/s over a 4 s loop
    assert pc.choose_loop_offset(4.0, 2.0, 0.0, signatures=sig, fps=12.5,
                                 entry_frame=sig[5]) == 0.4


def test_load_signatures_contract(tmp_path):
    good = tmp_path / "sig.npz"
    np.savez(good, frames=_signatures(n=20), fps=np.float32(25.0))
    frames, fps = pc._load_signatures(good)
    assert frames.shape == (20, 8, 8) and frames.dtype == np.uint8 and fps == 25.0
    bad = tmp_path / "bad.npz"
    bad.write_bytes(b"not an npz")
    assert pc._load_signatures(bad) is None
    flat = tmp_path / "flat.npz"
    np.savez(flat, frames=np.zeros((20, 64), np.uint8), fps=25.0)
    assert pc._load_signatures(flat) is None
    assert pc._load_signatures(None) is None
    assert pc._load_signatures(tmp_path / "missing.npz") is None


def test_signature_filter_matches_the_listener_kit():
    assert pc.SIGNATURE_VF == "crop=iw*0.6:ih*0.6:iw*0.2:ih*0.2,scale=64:64:flags=area,format=gray"
    try:
        from services.podcast_listener import SIGNATURE_VF
    except Exception:  # noqa: BLE001 — the listener-kit unit is optional here
        return
    assert SIGNATURE_VF == pc.SIGNATURE_VF


# ---------------------------------------------------------------------------
# Per-speaker visuals from clips + registry
# ---------------------------------------------------------------------------

def _roles(int_avatar="harry", exp_avatar="lisa") -> RenderRoles:
    return RenderRoles(
        interviewer=RoleConfig(display_name="A", avatar=int_avatar, voice="x"),
        expert=RoleConfig(display_name="B", avatar=exp_avatar, voice="y"),
    )


def test_speaker_visual_uses_each_speakers_own_chroma_flag():
    avatar_registry.reload(
        '[{"id":"photo_female","character":"c","gender":"female","kind":"photo"}]'
    )
    clips = [
        ClipManifest(turn_idx=0, speaker="interviewer", blob_url="a.mp4",
                     chroma_key=True, avatar_id="photo_female"),
        ClipManifest(turn_idx=1, speaker="expert", blob_url="b.webm",
                     chroma_key=False, avatar_id="lisa"),
    ]
    roles = _roles("photo_female", "lisa")
    iv = pc._speaker_visual(roles, "interviewer", clips)
    ex = pc._speaker_visual(roles, "expert", clips)
    assert iv.chroma_key is True and ex.chroma_key is False
    assert iv.crop == avatar_registry.PODCAST_CROP_PHOTO
    assert ex.crop == avatar_registry.podcast_crop_for(avatar_registry.get("lisa"))


def test_speaker_visual_unknown_avatar_uses_kind_from_clip():
    clips = [ClipManifest(turn_idx=0, speaker="interviewer", blob_url="a.mp4",
                          chroma_key=True, avatar_id="not_registered")]
    v = pc._speaker_visual(_roles("not_registered"), "interviewer", clips)
    assert v.chroma_key is True and v.crop == avatar_registry.PODCAST_CROP_PHOTO


# ---------------------------------------------------------------------------
# Avatar registry crop rects
# ---------------------------------------------------------------------------

def test_registry_podcast_crop_fallbacks_and_overrides():
    avatar_registry.reload(
        '[{"id":"p1","character":"c","kind":"photo"},'
        '{"id":"p2","character":"c","kind":"photo","podcast_crop":[0.1,0.2,0.5,0.6]},'
        '{"id":"v1","character":"c","kind":"video"},'
        '{"id":"bad","character":"c","kind":"video","podcast_crop":[2,2,2,"x"]}]'
    )
    assert avatar_registry.podcast_crop_for(avatar_registry.get("p1")) == avatar_registry.PODCAST_CROP_PHOTO
    assert avatar_registry.podcast_crop_for(avatar_registry.get("p2")) == (0.1, 0.2, 0.5, 0.6)
    assert avatar_registry.podcast_crop_for(avatar_registry.get("v1")) == avatar_registry.PODCAST_CROP_PREBUILT
    assert avatar_registry.get("bad").podcast_crop is None
    assert avatar_registry.podcast_crop_for(avatar_registry.get("harry")) == avatar_registry.PODCAST_CROP_PREBUILT
    lisa = avatar_registry.podcast_crop_for(avatar_registry.get("lisa"))
    assert lisa != avatar_registry.PODCAST_CROP_PREBUILT
    for x, y, w, h in (lisa, avatar_registry.PODCAST_CROP_PREBUILT, avatar_registry.PODCAST_CROP_PHOTO):
        assert 0 <= x and 0 <= y and x + w <= 1.0 and y + h <= 1.0


def test_registry_normalize_crop_clamps():
    assert avatar_registry._normalize_crop([0.9, 0.9, 0.5, 0.5]) == (0.9, 0.9, 0.1, 0.1)
    assert avatar_registry._normalize_crop([1, 2, 3]) is None
    assert avatar_registry._normalize_crop(None) is None


def test_public_catalog_does_not_expose_crop():
    for item in avatar_registry.public_catalog():
        assert "podcast_crop" not in item


# ---------------------------------------------------------------------------
# Captions (ASS) and SRT
# ---------------------------------------------------------------------------

LONG = (
    "Context engineering keeps every model request grounded for as long as "
    "possible, which means designing every agent for retrieval, citation and "
    "review rather than guesswork. Supercalifragilisticexpialidocious-retrieval-provenance-identifiers "
    "make that traceable."
)


def _ass_for(text: str, layout: str, tmp_path: Path) -> str:
    turns = [DialogueTurn(idx=0, speaker="expert", text=text, slide_idx=0)]
    clips = [ClipManifest(turn_idx=0, speaker="expert", blob_url="x.webm")]
    out = tmp_path / "subs.ass"
    pc._write_ass(out, clips, [12.0], {t.idx: t for t in turns}, _roles(),
                  offset=2.0, layout=layout)
    return out.read_text(encoding="utf-8")


def _dialogue_lines(ass: str) -> list[str]:
    return [ln for ln in ass.splitlines() if ln.startswith("Dialogue:")]


def _plain_lines(dialogue: str) -> list[str]:
    text = dialogue.split(",", 9)[9]
    text = re.sub(r"\{[^}]*\}", "", text)
    return text.split("\\N")


def test_ass_captions_confined_to_centre_zone(tmp_path):
    ass = _ass_for(LONG, "split_screen_with_slides", tmp_path)
    assert "PlayResX: 1920" in ass and "PlayResY: 1080" in ass
    style = next(ln for ln in ass.splitlines() if ln.startswith("Style: Karaoke"))
    fields = style.split(",")
    # Alignment 5 (middle-centre), MarginL = MarginR = 580 → 760 px wide.
    assert fields[18] == "5" and fields[19] == "580" and fields[20] == "580"
    dialogues = _dialogue_lines(ass)
    assert len(dialogues) >= 3
    for d in dialogues:
        assert "{\\an5\\pos(960,228)}" in d
        lines = _plain_lines(d)
        assert 1 <= len(lines) <= 3
        for line in lines:
            assert len(line) <= 40, line
    # All words survive (minus ASS-unsafe characters) and karaoke tags remain.
    words = " ".join(" ".join(_plain_lines(d)) for d in dialogues).split()
    assert "Context" in words and "traceable." in words
    assert "\\k" in dialogues[0]


def test_ass_captions_keep_offset(tmp_path):
    ass = _ass_for("Hello there.", "split_screen_with_slides", tmp_path)
    d = _dialogue_lines(ass)
    assert d[0].startswith("Dialogue: 0,0:00:02.00,0:00:14.00,Karaoke")


def test_ass_split_screen_only_zone(tmp_path):
    ass = _ass_for(LONG, "split_screen_only", tmp_path)
    for d in _dialogue_lines(ass):
        assert "{\\an5\\pos(960,1020)}" in d
        assert len(_plain_lines(d)) <= 2


def test_wrap_is_balanced_and_bounded():
    words = "The agent loop is basically read the goal, call a tool, and then check the result".split()
    lines = pc._wrap_words(words, 40)
    assert len(lines) == 2 or all(len(ln) > 1 for ln in lines)
    assert all(len(" ".join(ln)) <= 40 for ln in lines)
    long_word = ["x" * 95]
    assert all(len(" ".join(ln)) <= 40 for ln in pc._wrap_words(long_word, 40))


def test_srt_output_unchanged_format(tmp_path):
    turns = [
        DialogueTurn(idx=0, speaker="interviewer", text="Hello and welcome.", slide_idx=0),
        DialogueTurn(idx=1, speaker="expert", text="Glad to be here.", slide_idx=0),
    ]
    clips = [ClipManifest(turn_idx=t.idx, speaker=t.speaker, blob_url="x") for t in turns]
    roles = RenderRoles(
        interviewer=RoleConfig(display_name="Ann", avatar="lisa", voice="x"),
        expert=RoleConfig(display_name="Bob", avatar="harry", voice="y"),
    )
    out = tmp_path / "f.srt"
    pc._write_srt(out, clips, [1.5, 2.0], {t.idx: t for t in turns}, roles, offset=2.0)
    assert out.read_text(encoding="utf-8") == (
        "1\n00:00:02,000 --> 00:00:03,500\nAnn: Hello and welcome.\n\n"
        "2\n00:00:03,500 --> 00:00:05,500\nBob: Glad to be here.\n"
    )


# ---------------------------------------------------------------------------
# Slide resolution
# ---------------------------------------------------------------------------

def test_resolve_slides_counters_and_missing_fallback(tmp_path, caplog):
    s0 = tmp_path / "s0.png"
    s0.write_bytes(b"png")
    doc = Document(id="d", title="T", sections=[Section(heading="h", text="t")],
                   slide_images=[str(s0), str(tmp_path / "missing.png"), ""],
                   source_kind="pptx")
    script = Script(id="s", document_id="d", turns=[
        DialogueTurn(idx=0, speaker="interviewer", text="a", slide_idx=0),
        DialogueTurn(idx=1, speaker="expert", text="b", slide_idx=1),
        DialogueTurn(idx=2, speaker="expert", text="c", slide_idx=2),
        DialogueTurn(idx=3, speaker="expert", text="d", slide_idx=99),
    ])
    with caplog.at_level(logging.WARNING, logger="services.podcast_compose"):
        res = pc._resolve_slides(doc, script, tmp_path)
    assert res[0] == (s0, "1 / 3")
    assert res[1] == (None, None)
    assert res[2] == (None, None)
    assert res[3] == (None, None)  # clamped to the last (empty) slide
    assert "slide 2 image missing" in caplog.text


def test_resolve_slides_without_document():
    script = Script(id="s", document_id="d", turns=[
        DialogueTurn(idx=0, speaker="interviewer", text="a", slide_idx=0),
    ])
    assert pc._resolve_slides(None, script, Path(".")) == {0: (None, None)}


# ---------------------------------------------------------------------------
# Ingest rendering parity (LibreOffice path + index-aligned slide images)
# ---------------------------------------------------------------------------

def test_ingest_pptx_forwards_libreoffice_path_and_aligns_images(tmp_path, monkeypatch, caplog):
    from services import podcast_ingest, pptx_parser

    seen = {}

    def fake_parse(file_bytes, filename, libreoffice_path="soffice"):
        seen["lo"] = libreoffice_path
        slides = [pptx_parser.SlideData(index=i, title=f"T{i}", body="b", notes="") for i in range(3)]
        # Renderer skipped slide 2 (index 1).
        return pptx_parser.PresentationData(
            id="abcdef0123", filename=filename, slide_count=3, slides=slides,
            slide_images=[(0, b"png0"), (2, b"png2")],
        )

    monkeypatch.setattr(pptx_parser, "parse_pptx", fake_parse)
    src = tmp_path / "deck.pptx"
    src.write_bytes(b"pptx")
    with caplog.at_level(logging.WARNING, logger="services.podcast_ingest"):
        doc = podcast_ingest.ingest_file(src, libreoffice_path=r"C:\LO\soffice.exe")
    assert seen["lo"] == r"C:\LO\soffice.exe"
    assert len(doc.slide_images) == 3
    assert doc.slide_images[1] == ""
    assert Path(doc.slide_images[0]).read_bytes() == b"png0"
    assert Path(doc.slide_images[2]).read_bytes() == b"png2"
    assert "slide(s) [2]" in caplog.text

    podcast_ingest.ingest_pptx(src)
    assert seen["lo"] == "soffice"
