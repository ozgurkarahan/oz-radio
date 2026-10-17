"""Smoke tests for podcast_compose (real ffmpeg renders).

* ``test_compose_smoke`` synthesizes 3 dummy clips and runs the full pipeline.
* ``test_segment_*`` render single 1.5 s segments with synthetic 16:9, 4:3 and
  portrait slides plus a green-screen "photo" avatar and a transparent VP9
  "prebuilt" avatar, then sample pixels to check the geometry contract
  (slide contained with pillar-boxing, per-speaker chroma key, tiles on top).
* ``test_listener_*`` / ``test_reaction_*`` / ``test_dissolve_*`` render
  segments with a synthetic idle loop (green-screen moving box, green mp4 and
  VP9+alpha WebM), the procedural sway and a backchannel clip, then measure
  listener-tile motion and colour, reaction pixels and audio energy, and the
  turn dissolve; ``test_compose_live_listener_*`` run the full pipeline with
  listener kits (timeline, sonic-logo cards, corrupt-loop fallback).

Marked slow — skipped unless ffmpeg is on PATH.
Run with: pytest -m slow demos/backend/tests/test_podcast_compose_smoke.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

# Make `services.*` importable when pytest is run from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

pytestmark = pytest.mark.slow

FFMPEG = shutil.which("ffmpeg")


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_compose_smoke(tmp_path: Path) -> None:
    from services.podcast_compose import compose_podcast
    from services.podcast_ingest import Document, Section
    from services.podcast_render import (
        ClipManifest, DialogueTurn, RenderRoles, RoleConfig, Script,
    )

    # 1) Three tiny dummy avatar clips via lavfi (1 s each, with audio).
    clips_dir = tmp_path / "clips"
    clips_dir.mkdir()
    clip_paths = []
    for i in range(3):
        out = clips_dir / f"turn_{i:03d}.webm"
        subprocess.run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=red@0.0:s=480x270:r=25:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "300k",
            "-c:a", "libopus",
            str(out),
        ], check=True, capture_output=True)
        clip_paths.append(out)

    # 2) Two dummy slide images.
    slides_dir = tmp_path / "slides"
    slides_dir.mkdir()
    slide_paths = []
    for i in range(2):
        out = slides_dir / f"slide_{i:03d}.png"
        subprocess.run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=#1F2937:s=1920x810:d=0.04",
            "-frames:v", "1", str(out),
        ], check=True, capture_output=True)
        slide_paths.append(str(out))

    document = Document(
        id="doc-smoke",
        title="Smoke Test",
        sections=[Section(heading=f"S{i}", text=f"body {i}") for i in range(2)],
        slide_images=slide_paths,
        slide_titles=["Intro", "Detail"],
        slide_notes=["", ""],
        source_kind="pptx",
    )
    script = Script(
        id="scr-smoke", document_id="doc-smoke",
        turns=[
            DialogueTurn(idx=0, speaker="interviewer", text="Hello and welcome.", slide_idx=0),
            DialogueTurn(idx=1, speaker="expert", text="Glad to be here today.", slide_idx=0),
            DialogueTurn(idx=2, speaker="interviewer", text="Tell us more.", slide_idx=1),
        ],
    )
    roles = RenderRoles(
        interviewer=RoleConfig(avatar="harry", voice="x", display_name="Dr. Harry Chen"),
        expert=RoleConfig(avatar="lisa", voice="y", display_name="Dr. Lisa Patel"),
    )
    clips = [
        ClipManifest(turn_idx=i, speaker=t.speaker, blob_url=str(clip_paths[i]),
                     duration_sec=1.0, word_timings=[])
        for i, t in enumerate(script.turns)
    ]

    result = compose_podcast(
        clips=clips,
        document=document,
        script=script,
        roles=roles,
        out_dir=tmp_path / "out",
        music=False,        # no music file in test env
        intro=False,        # keep it short
    )

    assert result.mp4.exists() and result.mp4.stat().st_size > 1000
    assert result.mp3.exists() and result.mp3.stat().st_size > 100
    assert result.srt.exists()
    srt = result.srt.read_text(encoding="utf-8")
    assert "Dr. Harry Chen" in srt and "Dr. Lisa Patel" in srt
    assert _probe_size(result.mp4) == (1920, 1080)
    # No title card: the first turn starts at 0, turns are contiguous.
    tl = result.timeline
    assert tl is not None and sorted(tl.turn_video_offsets) == [0, 1, 2]
    assert tl.turn_video_offsets[0][0] == 0.0
    assert tl.turn_video_offsets[1][0] == tl.turn_video_offsets[0][1]
    assert tl.listener_mode == "still"          # PODCAST_LISTENER_MODE=still in tests
    assert abs(tl.duration_sec - tl.turn_video_offsets[2][1]) < 0.1


# ---------------------------------------------------------------------------
# Geometry smoke: real ffmpeg render of single segments, pixel-sampled.
# ---------------------------------------------------------------------------

BG = (11, 18, 32)        # podcast_compose.BG_COLOR #0B1220
TILE_BG = (22, 33, 58)   # podcast_compose.TILE_BG_COLOR #16213A


def _ff(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args],
                   check=True, capture_output=True)


def _probe_size(path: Path) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    w, h = out.split(",")[:2]
    return int(w), int(h)


def _frame(video: Path, at: float, out_png: Path):
    from PIL import Image

    _ff("-ss", f"{at:.2f}", "-i", str(video), "-frames:v", "1", str(out_png))
    return Image.open(out_png).convert("RGB")


def _close(px, ref, tol=24) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(px, ref))


def _is_white(px) -> bool:
    return all(c > 225 for c in px)


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("podcast_geometry")
    # Slides: 16:9 red, 4:3 white, portrait white.
    slides = {
        "wide": (d / "wide.png", "1920x1080", "red"),
        "four_three": (d / "four_three.png", "1024x768", "white"),
        "portrait": (d / "portrait.png", "720x1280", "white"),
    }
    for path, size, color in slides.values():
        _ff("-f", "lavfi", "-i", f"color=c={color}:s={size}:d=0.04", "-frames:v", "1", str(path))
    # Photo avatar: 512x512 green screen with a skin-toned "head" + speech.
    photo = d / "photo.mp4"
    _ff("-f", "lavfi", "-i", "color=c=0x00FF00:s=512x512:r=25:d=1.5",
        "-f", "lavfi", "-i", "sine=frequency=330:duration=1.5",
        "-vf", "drawbox=x=156:y=60:w=200:h=380:color=0xC08060:t=fill",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(photo))
    # Prebuilt avatar: 16:9 transparent stage with an opaque testsrc "person".
    webm = d / "prebuilt.webm"
    _ff("-f", "lavfi", "-i", "testsrc=s=200x320:r=25:d=1.5",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
        "-vf", "format=yuva420p,pad=960:540:380:10:color=black@0.0",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-deadline", "realtime",
        "-cpu-used", "8", "-b:v", "500k", "-c:a", "libopus", "-shortest", str(webm))
    return {"dir": d, "slides": {k: v[0] for k, v in slides.items()}, "photo": photo, "webm": webm}


def _roles():
    from services.podcast_render import RenderRoles, RoleConfig

    return RenderRoles(
        interviewer=RoleConfig(avatar="photo_x", voice="x", display_name="Ann Interviewer"),
        expert=RoleConfig(avatar="lisa", voice="y", display_name="Bob Expert"),
    )


def _render(media, slide_key: str, *, active: str, layout: str = "split_screen_with_slides"):
    from services import avatar_registry
    from services import podcast_compose as pc

    d = media["dir"]
    idle_png = d / f"idle_{active}.png"
    # Idle speaker still: extracted from that speaker's own clip.
    if active == "interviewer":
        clip, idle_src = media["photo"], media["webm"]
        clip_chroma, idle_chroma = True, False
    else:
        clip, idle_src = media["webm"], media["photo"]
        clip_chroma, idle_chroma = False, True
    pc._extract_frame(idle_src, idle_png, at_sec=0.1)
    crop_of = {
        "interviewer": avatar_registry.PODCAST_CROP_PHOTO,
        "expert": avatar_registry.PODCAST_CROP_PREBUILT,
    }
    idle_speaker = "expert" if active == "interviewer" else "interviewer"
    out = d / f"seg_{slide_key}_{active}_{layout}.mp4"
    pc._render_segment(
        clip_path=clip,
        idle_frame=idle_png,
        slide_path=media["slides"][slide_key] if slide_key else None,
        duration=1.5,
        active_speaker=active,
        roles=_roles(),
        out=out,
        chroma_key=clip_chroma,
        idle_chroma_key=idle_chroma,
        active_crop=crop_of[active],
        idle_crop=crop_of[idle_speaker],
        layout=layout,
        slide_counter="1 / 3",
    )
    return out


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_segment_wide_slide_fills_slide_region(media):
    seg = _render(media, "wide", active="interviewer")
    assert _probe_size(seg) == (1920, 1080)
    img = _frame(seg, 0.7, media["dir"] / "wide.png.frame.png")
    red = lambda px: px[0] > 200 and px[1] < 60 and px[2] < 60  # noqa: E731
    # 16:9 slide exactly fills 1280x720 at (320,360).
    for x, y in ((330, 370), (960, 720), (1590, 1070)):
        assert red(img.getpixel((x, y))), (x, y, img.getpixel((x, y)))
    # Gutters stay background.
    for x, y in ((100, 700), (1820, 700)):
        assert _close(img.getpixel((x, y)), BG), (x, y, img.getpixel((x, y)))


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_segment_four_three_slide_is_pillarboxed(media):
    seg = _render(media, "four_three", active="expert")
    img = _frame(seg, 0.7, media["dir"] / "43.frame.png")
    # 1024x768 → 960x720 centred: x 480..1440 white, 320..480 / 1440..1600 bars.
    assert _is_white(img.getpixel((960, 720)))
    assert _is_white(img.getpixel((500, 380)))
    assert _is_white(img.getpixel((1420, 1060)))
    for x in (340, 460, 1460, 1580):
        assert _close(img.getpixel((x, 720)), BG), (x, img.getpixel((x, 720)))


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_segment_portrait_slide_is_contained(media):
    seg = _render(media, "portrait", active="interviewer")
    img = _frame(seg, 0.7, media["dir"] / "portrait.frame.png")
    # 720x1280 → 405x720 centred: x ≈ 757..1162.
    assert _is_white(img.getpixel((960, 720)))
    assert _is_white(img.getpixel((960, 365)))
    assert _is_white(img.getpixel((960, 1075)))
    for x in (700, 1220):
        assert _close(img.getpixel((x, 720)), BG), (x, img.getpixel((x, 720)))


def _green_ratio(img, box) -> float:
    x0, y0, x1, y1 = box
    n = g = 0
    for y in range(y0, y1, 6):
        for x in range(x0, x1, 6):
            r, gg, b = img.getpixel((x, y))
            n += 1
            if gg > 150 and r < 100 and b < 100:
                g += 1
    return g / max(1, n)


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
@pytest.mark.parametrize("active", ["interviewer", "expert"])
def test_segment_avatar_tiles_keyed_per_speaker(media, active):
    from services import podcast_compose as pc

    seg = _render(media, "wide", active=active)
    img = _frame(seg, 0.7, media["dir"] / f"tiles_{active}.frame.png")
    # The photo speaker (interviewer, left tile) is keyed whether active or
    # idle: no green screen survives in its tile.
    assert _green_ratio(img, (8, 8, 552, 352)) < 0.01
    # Its "head" is visible, large, and centred in the tile.
    head = img.getpixel((280, 200))
    assert head[0] > 60 and head[0] > head[2], head
    # Prebuilt (expert, right tile): transparent stage → tile background in
    # the corners (alpha honoured), opaque content in the centre.
    corner = img.getpixel((1380, 40))
    if pc._has_decoder("libvpx-vp9"):
        assert _close(corner, TILE_BG, tol=12), corner
    centre = img.getpixel((1640, 200))
    assert not _close(centre, TILE_BG, tol=10), centre
    # Active tile frame is clay.
    fx = 1 if active == "interviewer" else 1361
    frame_px = img.getpixel((fx, 180))
    assert frame_px[0] > 140 and frame_px[2] < 80, frame_px
    # Nothing is drawn over the slide region by the avatars.
    assert img.getpixel((960, 720))[0] > 200


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_segment_split_screen_only(media):
    seg = _render(media, None, active="interviewer", layout="split_screen_only")
    assert _probe_size(seg) == (1920, 1080)
    img = _frame(seg, 0.7, media["dir"] / "only.frame.png")
    assert _green_ratio(img, (8, 8, 952, 892)) < 0.01
    head = img.getpixel((480, 450))
    assert head[0] > 60 and head[0] > head[2], head
    # Caption/label strip at the bottom stays background.
    assert _close(img.getpixel((40, 1040)), BG)


# ---------------------------------------------------------------------------
# Live listener: idle loop / procedural sway / still, reactions, dissolve.
# ---------------------------------------------------------------------------

SKIN = (192, 128, 96)          # 0xC08060 — the synthetic avatar "head"
REACTION_BLUE = (48, 96, 192)  # 0x3060C0 — the synthetic reaction clip
LISTENER_TILE = (1360, 0, 560, 360)   # expert tile while the interviewer speaks
SEG_SEC = 2.4
SPEECH_HZ, LOOP_HZ, REACTION_HZ = 330, 100, 880


def _key_to_alpha_webm(src: Path, out: Path) -> None:
    _ff("-i", str(src), "-vf", "chromakey=0x00ff00:0.22:0.12,format=yuva420p",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-deadline", "realtime",
        "-cpu-used", "8", "-b:v", "800k", "-an", str(out))


@pytest.fixture(scope="module")
def live(tmp_path_factory):
    from services import podcast_compose as pc

    d = tmp_path_factory.mktemp("podcast_live_listener")
    talk = {}
    for speaker, freq in (("interviewer", SPEECH_HZ), ("expert", 220)):
        p = d / f"talk_{speaker}.mp4"
        _ff("-f", "lavfi", "-i", f"color=c=0x00FF00:s=512x512:r=25:d={SEG_SEC}",
            "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={SEG_SEC}:sample_rate=16000",
            "-vf", "drawbox=x=156:y=60:w=200:h=380:color=0xC08060:t=fill",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1",
            "-shortest", str(p))
        talk[speaker] = p
    # Idle loop: the "head" sways ±30 px on green; its loud 100 Hz audio must never be heard.
    idle_green = d / "idle_green.mp4"
    _ff("-f", "lavfi", "-i", "color=c=0x00FF00:s=512x512:r=25:d=4",
        "-f", "lavfi", "-i", "color=c=0xC08060:s=200x380:r=25:d=4",
        "-f", "lavfi", "-i", f"sine=frequency={LOOP_HZ}:duration=4",
        "-filter_complex", "[0:v][1:v]overlay=x='156+30*sin(2*PI*t/4)':y=60:shortest=1[v]",
        "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(idle_green))
    idle_alpha = d / "idle_alpha.webm"
    _key_to_alpha_webm(idle_green, idle_alpha)
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(idle_green),
         "-vf", pc.SIGNATURE_VF, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        check=True, capture_output=True,
    ).stdout
    signatures = d / "idle_sig.npz"
    np.savez(signatures, frames=np.frombuffer(raw, np.uint8).reshape(-1, 64, 64),
             fps=np.float32(25.0))
    # Reaction: a blue "head" (pre-keyed VP9+alpha) + an 880 Hz voice, same 0.6 s window.
    rx_green = d / "rx_green.mp4"
    _ff("-f", "lavfi", "-i", "color=c=0x00FF00:s=512x512:r=25:d=0.6",
        "-vf", "drawbox=x=156:y=60:w=200:h=380:color=0x3060C0:t=fill",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(rx_green))
    rx_video = d / "rx_ack.webm"
    _key_to_alpha_webm(rx_green, rx_video)
    rx_audio = d / "rx_ack.wav"
    _ff("-f", "lavfi", "-i", f"sine=frequency={REACTION_HZ}:duration=0.6:sample_rate=24000",
        "-ac", "2", str(rx_audio))
    slide = d / "slide.png"
    _ff("-f", "lavfi", "-i", "color=c=#334155:s=1280x720:d=0.04", "-frames:v", "1", str(slide))
    still = d / "still_expert.png"
    pc._extract_frame(talk["expert"], still, at_sec=0.1)
    return {
        "dir": d, "talk": talk, "idle_green": idle_green, "idle_alpha": idle_alpha,
        "signatures": signatures, "rx_video": rx_video, "rx_audio": rx_audio,
        "rx_green": rx_green, "slide": slide, "still": still,
    }


def _live_roles():
    from services.podcast_render import RenderRoles, RoleConfig

    return RenderRoles(
        interviewer=RoleConfig(avatar="photo_int", voice="x", display_name="Ann Interviewer"),
        expert=RoleConfig(avatar="photo_exp", voice="y", display_name="Bob Expert"),
    )


def _live_segment(live, name, listener, reactions=(), prev_frame=None):
    from services import avatar_registry
    from services import podcast_compose as pc

    out = live["dir"] / f"seg_{name}.mp4"
    pc._render_segment(
        clip_path=live["talk"]["interviewer"], idle_frame=None, slide_path=live["slide"],
        duration=SEG_SEC, active_speaker="interviewer", roles=_live_roles(), out=out,
        chroma_key=True, idle_chroma_key=True,
        active_crop=avatar_registry.PODCAST_CROP_PHOTO, idle_crop=avatar_registry.PODCAST_CROP_PHOTO,
        listener=listener, reactions=reactions, prev_frame=prev_frame,
    )
    return out


def _tile_frames(video: Path, rect=LISTENER_TILE, frames=None) -> np.ndarray:
    """uint8 RGB frames [N, h, w, 3] of a screen region (all, or the given indices)."""
    x, y, w, h = rect
    vf = f"crop={w}:{h}:{x}:{y}"
    if frames is not None:
        vf = "select='" + "+".join(f"eq(n,{i})" for i in frames) + "'," + vf
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
         "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def _mad(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean())


def _motion(frames: np.ndarray) -> float:
    """Median mean-abs-difference between consecutive frames."""
    return float(np.median([_mad(frames[i], frames[i + 1]) for i in range(len(frames) - 1)]))


def _colour_frac(frame: np.ndarray, rgb, tol=24) -> float:
    diff = np.abs(frame.astype(np.int16) - np.array(rgb, np.int16))
    return float((diff <= tol).all(axis=-1).mean())


def _skin_centroid(frame: np.ndarray) -> tuple[float, float]:
    f = frame.astype(np.float32)
    w = np.clip(1.0 - np.abs(f - np.array(SKIN, np.float32)).max(axis=-1) / 60.0, 0, 1)
    ys, xs = np.indices(w.shape)
    return float((w * ys).sum() / w.sum()), float((w * xs).sum() / w.sum())


def _pcm(video: Path, sr: int = 16000) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video), "-vn",
         "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


def _tone(x: np.ndarray, freq: float, t0: float, t1: float, sr: int = 16000) -> float:
    seg = x[int(t0 * sr):int(t1 * sr)]
    if len(seg) < 64:
        return 0.0
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) / len(seg)
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    return float(spec[(freqs > freq - 20) & (freqs < freq + 20)].max())


def _rms(x: np.ndarray, t0: float, t1: float, sr: int = 16000) -> float:
    seg = x[int(t0 * sr):int(t1 * sr)]
    return float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
@pytest.mark.parametrize("variant", ["alpha_webm", "green_mp4"])
def test_listener_idle_loop_moves_in_full_colour(live, variant):
    from services import podcast_compose as pc

    loop = (pc.ListenerSource("idle_loop", live["idle_alpha"], offset=1.2, has_alpha=True)
            if variant == "alpha_webm" else
            pc.ListenerSource("idle_loop", live["idle_green"], offset=1.2))
    seg = _live_segment(live, f"loop_{variant}", loop)
    frames = _tile_frames(seg)
    assert len(frames) == round(SEG_SEC * 25)
    assert _motion(frames) > 0.2                       # visibly alive (a still is ~0)
    # Keyed cleanly, never dimmed: the head keeps its source colour.
    assert _colour_frac(frames[10], SKIN) > 0.05
    assert _colour_frac(frames[10], (0, 255, 0), tol=80) < 0.001
    # The loop's own audio is never mapped: speech only.
    pcm = _pcm(seg)
    assert _tone(pcm, SPEECH_HZ, 0.2, 2.2) > 0.01
    assert _tone(pcm, LOOP_HZ, 0.2, 2.2) < 0.001


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_listener_plain_still_is_static_and_full_colour(live):
    from services import podcast_compose as pc

    seg = _live_segment(live, "still", pc.ListenerSource("still", live["still"]))
    frames = _tile_frames(seg)
    assert _motion(frames) < 0.05
    assert _colour_frac(frames[10], SKIN) > 0.05        # not the old 55 % dim
    dimmed = tuple(round(c * 0.55) for c in SKIN)
    assert _colour_frac(frames[10], dimmed, tol=12) < 0.001


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_listener_procedural_sway_is_subtle_and_smooth(live):
    from services import podcast_compose as pc

    seg = _live_segment(live, "procedural", pc.ListenerSource("procedural", live["still"], offset=0.0))
    frames = _tile_frames(seg)
    assert _colour_frac(frames[10], SKIN) > 0.05
    ys = np.array([_skin_centroid(f)[0] for f in frames])
    xs = np.array([_skin_centroid(f)[1] for f in frames])
    rise = ys[0] - ys.min()
    assert 0.3 < rise <= 2.0                            # alive, ≤ 2 px drift
    assert np.abs(xs - xs[0]).max() <= 1.0              # zoom anchored at the bottom centre
    assert np.abs(np.diff(ys)).max() < 0.4              # supersampled: no whole-pixel jumps


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_reaction_overlays_listener_tile_and_adds_audio(live):
    from services import podcast_compose as pc

    loop = pc.ListenerSource("idle_loop", live["idle_alpha"], offset=0.4, has_alpha=True)
    rx = pc.SegmentReaction(at=1.0, duration=0.6, gain_db=-4.0, has_alpha=True,
                            video=live["rx_video"], audio=live["rx_audio"])
    seg = _live_segment(live, "reaction", loop, reactions=[rx])
    frames = _tile_frames(seg)
    assert _colour_frac(frames[12], SKIN) > 0.05 and _colour_frac(frames[12], REACTION_BLUE) < 0.001
    mid = frames[33]                                    # 1.32 s: reaction fully faded in
    assert _colour_frac(mid, REACTION_BLUE) > 0.05 and _colour_frac(mid, SKIN) < 0.01
    assert _colour_frac(frames[45], SKIN) > 0.05        # 1.8 s: back to the idle loop
    assert _colour_frac(frames[45], REACTION_BLUE) < 0.001
    # 100 ms alpha fades: half-way through the fade-in both layers blend.
    fade = frames[26]                                   # 1.04 s
    assert _colour_frac(fade, REACTION_BLUE) < 0.01 and _colour_frac(fade, SKIN) < 0.01
    # The backchannel is heard under the speaker only while it plays.
    pcm = _pcm(seg)
    during = _tone(pcm, REACTION_HZ, 1.05, 1.55)
    assert during > 0.008
    assert during > 20 * _tone(pcm, REACTION_HZ, 0.1, 0.9)
    assert during > 20 * _tone(pcm, REACTION_HZ, 1.7, 2.3)
    assert _tone(pcm, SPEECH_HZ, 1.05, 1.55) > 0.01     # speech keeps playing
    assert pc._probe_duration(seg) == pytest.approx(SEG_SEC, abs=0.05)


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_last_frame_grab_returns_the_final_frame(live):
    from services import podcast_compose as pc

    seg = _live_segment(live, "loop_for_grab",
                        pc.ListenerSource("idle_loop", live["idle_green"], offset=0.0))
    png = pc._extract_last_frame(seg, live["dir"] / "_last_grab.png")
    assert png is not None and png.is_file()
    from PIL import Image

    grabbed = np.asarray(Image.open(png).convert("RGB"))[0:360, 1360:1920]
    frames = _tile_frames(seg, frames=[0, round(SEG_SEC * 25) - 1])
    assert _mad(grabbed, frames[1]) < 1.0               # the very last frame ...
    assert _mad(grabbed, frames[0]) > 3.0               # ... not the first (the head swayed)
    assert pc._extract_last_frame(live["dir"] / "missing.mp4", live["dir"] / "_x.png") is None


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_dissolve_blends_from_previous_frame_without_changing_length(live):
    from services import podcast_compose as pc

    white = live["dir"] / "_white_prev.png"
    _ff("-f", "lavfi", "-i", "color=c=white:s=1920x1080:d=0.04", "-frames:v", "1", str(white))
    still = pc.ListenerSource("still", live["still"])
    plain = _live_segment(live, "no_dissolve", still)
    faded = _live_segment(live, "dissolve", still, prev_frame=white)
    assert pc._probe_duration(faded) == pytest.approx(pc._probe_duration(plain), abs=0.02)
    n = round(SEG_SEC * 25)
    full = (0, 0, 1920, 1080)
    a = _tile_frames(faded, full, frames=[0, 1, 2, 3, 5, n - 1])
    b = _tile_frames(plain, full, frames=[0, 1, 2, 3, 5, n - 1])
    assert len(a) == len(b) == 6
    means = [float(f.mean()) for f in a]
    base = float(b[2].mean())
    assert means[0] > 240                               # opens on the previous frame
    assert means[0] > means[1] > means[2] > means[3] > float(b[3].mean())   # 160 ms fade
    assert means[2] == pytest.approx((255 + base) / 2, abs=12)              # half-way at 80 ms
    assert _mad(a[4], b[4]) < 1.5 and _mad(a[5], b[5]) < 1.5               # then the plain segment
    # A missing previous frame never fails the segment: no dissolve.
    out = live["dir"] / "seg_missing_prev.mp4"
    pc._render_segment(
        clip_path=live["talk"]["interviewer"], idle_frame=live["still"], slide_path=live["slide"],
        duration=SEG_SEC, active_speaker="interviewer", roles=_live_roles(), out=out,
        chroma_key=True, prev_frame=live["dir"] / "nope.png",
    )
    assert pc._probe_duration(out) == pytest.approx(SEG_SEC, abs=0.05)


def _live_script(n: int = 3):
    from services.podcast_render import ClipManifest, DialogueTurn, Script

    speakers = ["interviewer", "expert"]
    turns = [DialogueTurn(idx=i, speaker=speakers[i % 2], text=f"Turn number {i} is here.", slide_idx=0)
             for i in range(n)]
    return turns, Script(id="scr-live", document_id="doc-live", turns=turns), ClipManifest


def _live_compose(live, out: Path, *, kits, intro: bool, reactions=None):
    from services.podcast_compose import compose_podcast
    from services.podcast_ingest import Document, Section

    turns, script, ClipManifest = _live_script()
    clips = [ClipManifest(turn_idx=t.idx, speaker=t.speaker, blob_url=str(live["talk"][t.speaker]),
                          duration_sec=SEG_SEC, chroma_key=True, avatar_id=f"photo_{t.speaker[:3]}")
             for t in turns]
    doc = Document(id="doc-live", title="Live", sections=[Section(heading="h", text="t")],
                   slide_images=[str(live["slide"])], source_kind="pptx")
    return compose_podcast(clips, doc, script, _live_roles(), out, music=False, intro=intro,
                           listener_kits=kits, reactions=reactions, seed="job-live")


def _kits(live, idle_path: Path, *, signature=True, duration=4.0):
    from services.podcast_media import IdleLoop, ListenerKit, ReactionClip

    idle = IdleLoop(path=idle_path, duration_sec=duration, has_alpha=True,
                    signature_path=live["signatures"] if signature else None,
                    motion_score=2.0, static=False)
    ack = ReactionClip("ack", "Mm-hmm.", live["rx_audio"], live["rx_video"], 0.6, has_alpha=True)
    return {spk: ListenerKit(avatar_id=f"photo_{spk[:3]}", voice="v", mode="idle_loop",
                             idle=idle, reactions={"ack": ack})
            for spk in ("interviewer", "expert")}


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_compose_live_listener_timeline_jingle_and_reactions(live, tmp_path, monkeypatch):
    from services import podcast_compose as pc
    from services.podcast_media import ReactionPlacement

    monkeypatch.setenv("PODCAST_LISTENER_MODE", "auto")
    placements = [
        ReactionPlacement(turn_idx=1, listener="interviewer", reaction_id="ack",
                          at_sec=1.2, duration_sec=0.6),
        ReactionPlacement(turn_idx=2, listener="interviewer", reaction_id="ack",   # the speaker
                          at_sec=1.0, duration_sec=0.6),
    ]
    res = _live_compose(live, tmp_path / "out", kits=_kits(live, live["idle_alpha"]), intro=True,
                        reactions=placements)
    assert res.mp4.is_file() and res.mp3.is_file() and res.srt.is_file()
    tl = res.timeline
    assert tl.listener_mode == "idle_loop"
    assert res.warnings == ["reactions_skipped"]      # the speaker's own "reaction" is dropped
    # Offsets in final.mp4: after the 2 s intro card, contiguous, one segment each.
    offsets = [tl.turn_video_offsets[i] for i in range(3)]
    assert offsets[0][0] == pytest.approx(pc.INTRO_SEC)
    for i, (start, end) in enumerate(offsets):
        seg_dur = pc._probe_video_duration(tmp_path / "out" / f"seg_{i:03d}.mp4")
        assert end - start == pytest.approx(seg_dur, abs=0.002)
        assert seg_dur == pytest.approx(SEG_SEC, abs=0.05)
        if i:
            assert start == pytest.approx(offsets[i - 1][1], abs=0.002)
    # Each part's audio is pinned to its video: no AAC-padding drift.
    assert tl.duration_sec == pytest.approx(offsets[-1][1] + pc.OUTRO_SEC, abs=0.03)
    assert tl.duration_sec == pytest.approx(pc._probe_duration(res.mp4), abs=0.01)
    assert res.srt.read_text(encoding="utf-8").startswith("1\n00:00:02,000 --> ")
    # Title cards carry the sonic logo; the reaction is heard at its placement.
    pcm = _pcm(res.mp4)
    assert _rms(pcm, 0.1, 1.8) > 0.01                   # intro jingle
    assert _rms(pcm, tl.duration_sec - 1.9, tl.duration_sec - 0.6) > 0.003   # outro jingle
    at = offsets[1][0] + 1.2
    assert _tone(pcm, REACTION_HZ, at + 0.05, at + 0.55) > 10 * _tone(pcm, REACTION_HZ, at - 0.9, at - 0.1)
    # The listener tile shows the reaction (interviewer tile while the expert speaks).
    frame = _tile_frames(res.mp4, (0, 0, 560, 360), frames=[round((at + 0.3) * 25)])[0]
    assert _colour_frac(frame, REACTION_BLUE) > 0.05


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
@pytest.mark.parametrize("caught", ["before_render", "by_render_retry"])
def test_compose_live_listener_corrupt_loop_falls_back_to_still(live, tmp_path, monkeypatch, caught):
    from services import podcast_compose as pc

    monkeypatch.setenv("PODCAST_LISTENER_MODE", "auto")
    if caught == "by_render_retry":
        # Skip the up-front decode check: the segment render fails and is
        # retried with the plain still.
        monkeypatch.setattr(pc, "_decodes_video", lambda path: True)
    corrupt = tmp_path / "corrupt_loop.webm"
    corrupt.write_bytes(b"\x1aE\xdf\xa3" + bytes(range(256)) * 64)
    res = _live_compose(live, tmp_path / "out", kits=_kits(live, corrupt, signature=False),
                        intro=False)
    assert res.mp4.is_file() and res.mp4.stat().st_size > 1000
    assert res.timeline.listener_mode == "still"
    assert res.warnings == ["listener_fallback"]
    frame = _tile_frames(res.mp4, frames=[10])[0]      # expert listens during turn 0
    assert _colour_frac(frame, SKIN) > 0.05
