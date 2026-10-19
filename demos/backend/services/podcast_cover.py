"""Square cover art of a podcast episode (``cover.jpg``).

A 1400×1400 JPEG drawn with Pillow: dark brand gradient (#0B1220 → #16213A),
clay accent (#B8461E), the "Oz Radio" wordmark, the wrapped episode title
(≤ 3 lines, auto-sized), two circular host portraits with their names and a
small "AI-generated voices" note. It is published next to the radio MP3 as a
separate file (not embedded: an APIC picture delayed the first audio frame on
slow links) and is the thumbnail of audio-only library items.

Portraits come from ``avatar_images`` (role → image path). Green-screen
(#00FF00) backgrounds — the photo avatars' render background — are keyed out
with a soft numpy chroma mask and despilled; other images are used as they
are. A missing or unreadable image becomes a monogram disc.

``make_cover`` never fails because of the art: any rendering error falls back
to a plain branded cover (plus ``WARNING_COVER_FALLBACK`` when a ``warnings``
list is given). Only errors writing the file propagate.
"""

from __future__ import annotations

import functools
import logging
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Iterable, Optional, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from services.podcast_media import WARNING_COVER_FALLBACK, add_warning
from services.podcast_models import PodcastHost

log = logging.getLogger(__name__)

COVER_SIZE = 1400
JPEG_QUALITY = 88

BG_TOP = (11, 18, 32)        # #0B1220
BG_BOTTOM = (22, 33, 58)     # #16213A
ACCENT = (184, 70, 30)       # #B8461E clay
ACCENT_DARK = (120, 42, 16)
TEXT = (255, 255, 255)
MUTED = (148, 163, 184)
DISC_BG = (30, 42, 71)

BRAND = "Oz Radio"
AI_NOTE = "AI-generated voices"

MARGIN = 110
WORDMARK_Y = 110
WORDMARK_SIZE = 80
ICON_PX = 100                # "on air" dot + two arcs, left of the wordmark
TITLE_TOP = 330
TITLE_BOTTOM = 720
TITLE_MAX_LINES = 3
TITLE_SIZES = tuple(range(116, 55, -6))
TITLE_LINE_SPACING = 1.14
PORTRAIT_D = 360
PORTRAIT_CY = 960
PORTRAIT_DX = 290            # horizontal offset of each portrait from the centre
RING_PX = 9
NAME_SIZE = 46
NAME_GAP = 34
NAME_MAX_W = 520
NOTE_SIZE = 32
NOTE_BOTTOM = 1340

# Chroma key: a pixel whose green exceeds max(red, blue) by KEY_HI is fully
# transparent, by KEY_LO or less fully opaque (soft ramp in between).
KEY_LO = 40.0
KEY_HI = 110.0
SPILL = 15.0                 # green allowed above max(red, blue) after despill
KEY_BORDER = 0.06            # border band sampled to detect a green screen
KEY_BORDER_RATIO = 0.4       # share of strongly green border pixels → green screen

_BOLD_FONTS = (
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
)
_REGULAR_FONTS = (
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
)
_CJK_FONTS = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\YuGothB.ttc",
    r"C:\Windows\Fonts\meiryo.ttc",
)

_CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069]")
# Cached FreeType fonts are shared: one render at a time (≈ 0.3 s each).
_RENDER_LOCK = threading.Lock()


def make_cover(
    title: str,
    hosts: Sequence[PodcastHost],
    out_path: Path,
    *,
    avatar_images: Optional[dict[str, Path]] = None,
    warnings: Optional[list[str]] = None,
) -> Path:
    """Write the episode cover to ``out_path`` (1400×1400 JPEG) and return it."""
    out_path = Path(out_path)
    with _RENDER_LOCK:
        try:
            img = render_cover(title, hosts, avatar_images=avatar_images)
        except Exception:  # noqa: BLE001 — the art must never fail the render
            log.warning("podcast cover: rendering failed — plain fallback cover", exc_info=True)
            if warnings is not None:
                add_warning(warnings, WARNING_COVER_FALLBACK)
            img = render_fallback_cover()
    return _save_jpeg(img, out_path)


def render_cover(
    title: str,
    hosts: Sequence[PodcastHost],
    *,
    avatar_images: Optional[dict[str, Path]] = None,
) -> Image.Image:
    """The cover as an RGB image (raises on unexpected errors)."""
    img = _gradient(COVER_SIZE)
    draw = ImageDraw.Draw(img)
    _draw_wordmark(img, draw)

    shown = _ordered_hosts(hosts)[:2]
    title_bottom = TITLE_BOTTOM if shown else PORTRAIT_CY + PORTRAIT_D // 2
    _draw_title(draw, _clean(title), top=TITLE_TOP, bottom=title_bottom)

    images = avatar_images or {}
    for host, cx in zip(shown, _portrait_centers(len(shown))):
        portrait = _load_portrait(images.get(host.role), PORTRAIT_D)
        if portrait is None:
            portrait = _monogram(host, PORTRAIT_D)
        x, y = cx - PORTRAIT_D // 2, PORTRAIT_CY - PORTRAIT_D // 2
        img.paste(portrait.convert("RGB"), (x, y), _disc_mask(PORTRAIT_D))
        img.paste(ACCENT, (x - RING_PX, y - RING_PX), _disc_mask(PORTRAIT_D + 2 * RING_PX, ring=RING_PX + 1))
        name = _clean(host.display_name)
        if name and _drawable(name):
            font = _font(NAME_SIZE, bold=True, text=name)
            _text_centered(draw, _fit(draw, name, font, NAME_MAX_W), font,
                           cx, y + PORTRAIT_D + RING_PX + NAME_GAP, TEXT)

    _draw_note(draw)
    return img


def render_fallback_cover() -> Image.Image:
    """Plain branded cover: gradient, wordmark, accent bar and the AI note."""
    img = _gradient(COVER_SIZE)
    draw = ImageDraw.Draw(img)
    try:
        _draw_wordmark(img, draw)
        _draw_note(draw)
    except Exception:  # noqa: BLE001 — fonts unusable: keep the bare branded art
        log.warning("podcast cover: fallback text unavailable", exc_info=True)
        draw.rectangle((MARGIN, TITLE_TOP - 50, MARGIN + 150, TITLE_TOP - 40), fill=ACCENT)
    return img


# ---------------------------------------------------------------------------
# Portraits
# ---------------------------------------------------------------------------

def is_green_screen(img: Image.Image) -> bool:
    """True when the image border is mostly chroma green (#00FF00-like)."""
    rgb = np.asarray(img.convert("RGB"), dtype=np.int16)
    h, w = rgb.shape[:2]
    band = max(1, int(round(min(h, w) * KEY_BORDER)))
    border = np.concatenate([
        rgb[:band].reshape(-1, 3), rgb[-band:].reshape(-1, 3),
        rgb[:, :band].reshape(-1, 3), rgb[:, -band:].reshape(-1, 3),
    ])
    r, g, b = border[:, 0], border[:, 1], border[:, 2]
    green = (g > 120) & (g - np.maximum(r, b) > 80)
    return bool(green.mean() >= KEY_BORDER_RATIO)


def key_green(img: Image.Image) -> Image.Image:
    """Key a green-screen background out: soft alpha + green despill (RGBA)."""
    rgba = np.asarray(img.convert("RGBA"), dtype=np.float32)
    r, g, b, a = rgba[..., 0], rgba[..., 1], rgba[..., 2], rgba[..., 3]
    rb = np.maximum(r, b)
    dominance = g - rb
    keyed = np.clip((dominance - KEY_LO) / (KEY_HI - KEY_LO), 0.0, 1.0)
    alpha = a * (1.0 - keyed)
    g = np.where(dominance > SPILL, rb + SPILL, g)
    out = np.stack([r, g, b, alpha], axis=-1).clip(0, 255).astype(np.uint8)
    keyed_img = Image.fromarray(out, "RGBA")
    keyed_img.putalpha(keyed_img.getchannel("A").filter(ImageFilter.GaussianBlur(1.2)))
    return keyed_img


def _load_portrait(path: Optional[Path], diameter: int) -> Optional[Image.Image]:
    """Square RGBA portrait (subject over the disc colour), or None when unusable."""
    if not path:
        return None
    try:
        with Image.open(Path(path)) as src:
            img = ImageOps.exif_transpose(src).convert("RGBA")
    except Exception:  # noqa: BLE001 — missing/corrupt image → monogram
        log.info("podcast cover: portrait image unavailable — monogram")
        return None
    if img.width < 16 or img.height < 16:
        return None
    if is_green_screen(img):
        img = _frame_subject(key_green(img))
    img = _square_crop(img).resize((diameter, diameter), Image.Resampling.LANCZOS)
    tile = Image.new("RGBA", (diameter, diameter), DISC_BG + (255,))
    tile.alpha_composite(img)
    return tile


def _frame_subject(img: Image.Image) -> Image.Image:
    """Square crop around a keyed subject that fills only part of the frame."""
    bbox = img.getchannel("A").point(lambda v: 255 if v > 128 else 0).getbbox()
    if not bbox:
        return img
    x0, y0, x1, y1 = bbox
    if (x1 - x0) >= 0.7 * img.width and (y1 - y0) >= 0.7 * img.height:
        return img
    side = int(max(x1 - x0, y1 - y0) * 1.1)
    left = (x0 + x1) // 2 - side // 2
    top = max(0, y0 - int(side * 0.06))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, (-left, -top))
    return canvas


def _square_crop(img: Image.Image) -> Image.Image:
    """Centre square crop; portrait-shaped images keep their upper part (faces)."""
    w, h = img.size
    if w == h:
        return img
    side = min(w, h)
    left = (w - side) // 2
    top = int((h - side) * 0.25) if h > w else 0
    return img.crop((left, top, left + side, top + side))


def _monogram(host: PodcastHost, diameter: int) -> Image.Image:
    """Clay disc with the host's initials (role letter when no usable name)."""
    shade = Image.linear_gradient("L").resize((diameter, diameter))
    tile = Image.composite(Image.new("RGBA", (diameter, diameter), ACCENT_DARK + (255,)),
                           Image.new("RGBA", (diameter, diameter), ACCENT + (255,)), shade)
    draw = ImageDraw.Draw(tile)
    initials = initials_of(host.display_name, host.role)
    font = _font(int(diameter * 0.40), bold=True, text=initials)
    left, top, right, bottom = draw.textbbox((0, 0), initials, font=font)
    draw.text(((diameter - (right - left)) / 2 - left, (diameter - (bottom - top)) / 2 - top),
              initials, font=font, fill=TEXT)
    return tile


def initials_of(name: str, role: str = "") -> str:
    """Up to two initials ("Sofia Martin" → "SM"); the role letter when unusable."""
    words = [w for w in _clean(name).split() if any(ch.isalnum() for ch in w)]
    picked = words[:1] + words[1:][-1:]
    initials = "".join(next(ch for ch in w if ch.isalnum()) for w in picked).upper()
    if not initials or not _drawable(initials):
        initials = (role[:1] or "?").upper()
    return initials


# ---------------------------------------------------------------------------
# Drawing helpers
# ---------------------------------------------------------------------------

def _gradient(size: int) -> Image.Image:
    mask = Image.linear_gradient("L").resize((size, size))
    return Image.composite(Image.new("RGB", (size, size), BG_BOTTOM),
                           Image.new("RGB", (size, size), BG_TOP), mask)


def _draw_wordmark(img: Image.Image, draw: ImageDraw.ImageDraw) -> None:
    font = _font(WORDMARK_SIZE, bold=True)
    left, top, right, bottom = draw.textbbox((0, 0), BRAND, font=font)
    icon_y = WORDMARK_Y + (top + bottom) // 2 - ICON_PX // 2
    dot_mask, arc_mask = _icon_masks(ICON_PX)
    img.paste(ACCENT, (MARGIN, icon_y), dot_mask)
    img.paste(ACCENT_DARK, (MARGIN, icon_y), arc_mask)
    draw.text((MARGIN + ICON_PX + 16, WORDMARK_Y), BRAND, font=font, fill=TEXT)
    draw.rectangle((MARGIN, TITLE_TOP - 50, MARGIN + 150, TITLE_TOP - 40), fill=ACCENT)


@functools.lru_cache(maxsize=4)
def _icon_masks(px: int, scale: int = 4) -> tuple[Image.Image, Image.Image]:
    """Anti-aliased "on air" icon: (dot + inner arc, outer arc) masks of ``px``²."""
    s = px * scale
    dot = Image.new("L", (s, s), 0)
    arcs = Image.new("L", (s, s), 0)
    cx, cy = int(s * 0.22), s // 2
    r = int(s * 0.13)
    ImageDraw.Draw(dot).ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    width = int(s * 0.06)
    for mask, radius in ((dot, int(s * 0.32)), (arcs, int(s * 0.50))):
        ImageDraw.Draw(mask).arc((cx - radius, cy - radius, cx + radius, cy + radius),
                                 305, 55, fill=255, width=width)
    return (dot.resize((px, px), Image.Resampling.LANCZOS),
            arcs.resize((px, px), Image.Resampling.LANCZOS))


def _draw_title(draw: ImageDraw.ImageDraw, title: str, *, top: int, bottom: int) -> None:
    if not title:
        return
    if not _drawable(title):
        log.info("podcast cover: no font for the title's script — title omitted from the art")
        return
    max_w = COVER_SIZE - 2 * MARGIN
    font = _font(TITLE_SIZES[-1], bold=True, text=title)
    lines: list[str] = []
    for size in TITLE_SIZES:
        font = _font(size, bold=True, text=title)
        lines = wrap_text(draw, title, font, max_w, max_lines=TITLE_MAX_LINES)
        step = int(_line_height(draw, font) * TITLE_LINE_SPACING)
        if len(lines) <= TITLE_MAX_LINES and step * len(lines) <= bottom - top:
            break
    if len(lines) > TITLE_MAX_LINES:
        lines = lines[:TITLE_MAX_LINES]
        lines[-1] = _fit(draw, lines[-1] + "\u2026", font, max_w)
    step = int(_line_height(draw, font) * TITLE_LINE_SPACING)
    for i, line in enumerate(lines):
        draw.text((MARGIN, top + i * step), line, font=font, fill=TEXT)


def _draw_note(draw: ImageDraw.ImageDraw) -> None:
    font = _font(NOTE_SIZE, bold=False)
    _text_centered(draw, AI_NOTE, font, COVER_SIZE // 2, NOTE_BOTTOM - _line_height(draw, font), MUTED)


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: int,
              max_lines: Optional[int] = None) -> list[str]:
    """Greedy wrap by words (by characters for CJK); over-long words are split.

    With ``max_lines``, wrapping stops after ``max_lines + 1`` lines (enough
    for the caller to know the text overflows).
    """
    cjk = bool(_CJK_RE.search(text))
    tokens = list(text) if cjk else text.split()
    joiner = "" if cjk else " "
    limit = None if max_lines is None else max_lines + 1
    lines: list[str] = []
    cur = ""
    for tok in tokens:
        if limit is not None and len(lines) >= limit:
            break
        cand = f"{cur}{joiner}{tok}" if cur else tok
        if draw.textlength(cand, font=font) <= max_width:
            cur = cand
            continue
        if cur.strip():
            lines.append(cur.strip())
        cur = tok.strip()
        while (len(cur) > 1 and (limit is None or len(lines) < limit)
               and draw.textlength(cur, font=font) > max_width):
            cut = _longest_fit(draw, cur, font, max_width)
            lines.append(cur[:cut])
            cur = cur[cut:]
    if cur.strip():
        lines.append(cur.strip())
    return lines if limit is None else lines[:limit]


def _longest_fit(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> int:
    """Length of the longest prefix of ``text`` that fits (at least 1)."""
    lo, hi = 1, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if draw.textlength(text[:mid], font=font) <= max_width:
            lo = mid
        else:
            hi = mid - 1
    return lo


def _fit(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> str:
    """``text`` shortened with an ellipsis until it fits ``max_width``."""
    if draw.textlength(text, font=font) <= max_width:
        return text
    body = text.rstrip("\u2026")
    ellipsis = draw.textlength("\u2026", font=font)
    if ellipsis >= max_width:
        return ""
    body = body[:_longest_fit(draw, body, font, int(max_width - ellipsis))].rstrip()
    while body and draw.textlength(f"{body}\u2026", font=font) > max_width:
        body = body[:-1].rstrip()
    return f"{body}\u2026" if body else ""


def _text_centered(draw: ImageDraw.ImageDraw, text: str, font, cx: int, top: int, fill) -> None:
    width = draw.textlength(text, font=font)
    draw.text((int(cx - width / 2), top), text, font=font, fill=fill)


def _line_height(draw: ImageDraw.ImageDraw, font) -> int:
    return max(1, draw.textbbox((0, 0), "Ag", font=font)[3])


@functools.lru_cache(maxsize=16)
def _disc_mask(diameter: int, ring: int = 0, scale: int = 4) -> Image.Image:
    """Anti-aliased disc (or outer ring ``ring`` px wide) mask of ``diameter`` px."""
    big = Image.new("L", (diameter * scale, diameter * scale), 0)
    box = (0, 0, diameter * scale - 1, diameter * scale - 1)
    if ring:
        ImageDraw.Draw(big).ellipse(box, outline=255, width=ring * scale)
    else:
        ImageDraw.Draw(big).ellipse(box, fill=255)
    return big.resize((diameter, diameter), Image.Resampling.LANCZOS)


def _portrait_centers(count: int) -> list[int]:
    if count <= 0:
        return []
    if count == 1:
        return [COVER_SIZE // 2]
    return [COVER_SIZE // 2 - PORTRAIT_DX, COVER_SIZE // 2 + PORTRAIT_DX]


def _ordered_hosts(hosts: Optional[Iterable[PodcastHost]]) -> list[PodcastHost]:
    order = {"interviewer": 0, "expert": 1}
    return sorted(list(hosts or []), key=lambda h: order.get(h.role, 2))


def _clean(text: object) -> str:
    """Printable single-line text (control and bidi-override characters dropped)."""
    return " ".join(_CONTROL_RE.sub(" ", str(text or "")).split())


def _drawable(text: str) -> bool:
    """False for CJK text when no CJK-capable font is installed (no tofu boxes)."""
    return not _CJK_RE.search(text) or _cjk_font_path() is not None


# ---------------------------------------------------------------------------
# Fonts
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=1)
def _cjk_font_path() -> Optional[str]:
    return next((p for p in _CJK_FONTS if Path(p).is_file()), None)


@functools.lru_cache(maxsize=1)
def _font_paths() -> tuple[Optional[str], Optional[str]]:
    bold = next((p for p in _BOLD_FONTS if Path(p).is_file()), None)
    regular = next((p for p in _REGULAR_FONTS if Path(p).is_file()), None)
    return bold or regular, regular or bold


def _font(size: int, *, bold: bool, text: str = ""):
    """TrueType font of ``size`` px (CJK-capable when ``text`` needs it)."""
    path = _cjk_font_path() if _CJK_RE.search(text or "") else None
    if path is None:
        path = _font_paths()[0 if bold else 1]
    return _load_font(path, size)


@functools.lru_cache(maxsize=64)
def _load_font(path: Optional[str], size: int):
    if path:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            log.info("podcast cover: font unusable — Pillow default font")
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1: fixed-size bitmap font
        return ImageFont.load_default()


def _save_jpeg(img: Image.Image, out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(f".{out_path.stem}.{uuid.uuid4().hex}.tmp.jpg")
    try:
        img.convert("RGB").save(tmp, "JPEG", quality=JPEG_QUALITY, optimize=True)
        os.replace(tmp, out_path)
    finally:
        tmp.unlink(missing_ok=True)
    return out_path


__all__ = [
    "COVER_SIZE",
    "initials_of",
    "is_green_screen",
    "key_green",
    "make_cover",
    "render_cover",
    "render_fallback_cover",
    "wrap_text",
]
