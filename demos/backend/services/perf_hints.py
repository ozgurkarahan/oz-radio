"""Perf helpers for the SPA shell: the Blob media origin hint and the light avatar-disc variants.

Both are pure and never raise. Neither exposes anything sensitive: the origin hint is ``scheme://host`` only (no
path, query, SAS or key), and the disc variant is an image that is already served from ``/static/avatars/``.
"""
from __future__ import annotations

import hashlib
import io
import os
import re
from pathlib import Path
from typing import Iterable, NamedTuple, Optional
from urllib.parse import urlsplit

_ACCOUNT_RE = re.compile(r"^[a-z0-9]{3,24}$")
_SUFFIX_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,60}[A-Za-z0-9])?$")
_HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")


def media_origin(
    account_name: Optional[str] = None,
    connection_string: Optional[str] = None,
    use_managed_identity: Optional[bool] = None,
) -> Optional[str]:
    """``https://<account>.blob.core.windows.net`` for the configured media storage, else ``None``.

    Arguments default to the same environment variables as ``config.load_config``. A connection string only
    contributes its (public) account name, endpoint suffix or ``BlobEndpoint`` host: never the key.
    """
    if account_name is None:
        account_name = os.environ.get("AZURE_BLOB_ACCOUNT_NAME", "")
    if connection_string is None:
        connection_string = os.environ.get("AZURE_BLOB_CONNECTION_STRING", "")
    if use_managed_identity is None:
        use_managed_identity = os.environ.get("AZURE_USE_MANAGED_IDENTITY", "").lower() == "true"
    account_name = (account_name or "").strip()
    if use_managed_identity and account_name:
        return f"https://{account_name}.blob.core.windows.net" if _ACCOUNT_RE.fullmatch(account_name) else None
    parts: dict[str, str] = {}
    for part in (connection_string or "").split(";"):
        key, sep, value = part.partition("=")
        if sep:
            parts[key.strip().lower()] = value.strip()
    if parts.get("usedevelopmentstorage", "").lower() == "true":
        return None
    endpoint = parts.get("blobendpoint", "")
    if endpoint:
        try:
            parsed = urlsplit(endpoint)
            host = parsed.hostname or ""
        except ValueError:
            return None
        return f"https://{host}" if parsed.scheme == "https" and host and _HOST_RE.fullmatch(host) else None
    account = parts.get("accountname", "")
    suffix = parts.get("endpointsuffix", "") or "core.windows.net"
    if _ACCOUNT_RE.fullmatch(account) and _SUFFIX_RE.fullmatch(suffix):
        return f"https://{account}.blob.{suffix}"
    return None


def preconnect_links(origin: Optional[str]) -> str:
    """The ``<link>`` hints for ``origin`` (empty without one). ``origin`` is already validated: only host chars."""
    if not origin:
        return ""
    return f'<link rel="preconnect" href="{origin}" crossorigin><link rel="dns-prefetch" href="{origin}">'


# --- Light avatar-disc variants ------------------------------------------------------------------------------------

DISC_SUFFIX = "-disc"
DISC_MAX_SIDE = 384          # host discs are at most ~260 CSS px: 1.5x at the largest, plenty for the rest
DISC_QUALITY = 82
SOURCE_EXTS = (".png", ".webp", ".jpg", ".jpeg")
_MAX_CACHED = 16


class DiscVariant(NamedTuple):
    body: bytes
    etag: str


_disc_cache: dict[tuple[str, int, int], Optional[DiscVariant]] = {}


def disc_source_stem(name: str) -> Optional[str]:
    """``photo_female`` for ``photo_female-disc.webp``, else ``None``."""
    stem, ext = os.path.splitext(name)
    if ext.lower() != ".webp" or not stem.endswith(DISC_SUFFIX) or len(stem) <= len(DISC_SUFFIX):
        return None
    return stem[: -len(DISC_SUFFIX)]


def _build_disc(path: Path) -> Optional[DiscVariant]:
    """A display-size WebP of an avatar that is *already* keyed (transparent corners). Green-screen photos return
    ``None``: they still need the client-side chroma key, which works on the original."""
    try:
        from PIL import Image  # noqa: PLC0415

        with Image.open(path) as src:
            im = src.convert("RGBA")
        w, h = im.size
        alpha = im.getchannel("A")
        if min(alpha.getpixel(p) for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))) > 8:
            return None
        im.thumbnail((DISC_MAX_SIDE, DISC_MAX_SIDE), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, "WEBP", quality=DISC_QUALITY, method=6)
        body = out.getvalue()
        return DiscVariant(body, '"' + hashlib.sha256(body).hexdigest()[:20] + '"')
    except Exception:  # noqa: BLE001 — a missing variant just means the client uses the original
        return None


def disc_variant(sources: Iterable[Optional[Path]]) -> Optional[DiscVariant]:
    """The light variant of the first existing file among ``sources`` (the caller's already-contained
    ``<stem>.<png|webp|jpg|jpeg>`` candidates), built once per file version (memory only: the avatar directory may be
    read-only)."""
    for path in sources:
        if path is None:
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        key = (str(path), st.st_mtime_ns, st.st_size)
        if key not in _disc_cache:
            while len(_disc_cache) >= _MAX_CACHED:
                _disc_cache.pop(next(iter(_disc_cache)))
            _disc_cache[key] = _build_disc(path)
        return _disc_cache[key]
    return None
