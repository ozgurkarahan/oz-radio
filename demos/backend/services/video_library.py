"""Video Library — publish rendered videos to Azure Blob Storage.

Blob layout (same container as the podcast library, prefix `videos/`):

    videos/{job_id}/thumb.jpg
    videos/{job_id}/video.mp4
    videos/{job_id}/audio.mp3
    videos/{job_id}/subtitles.srt
    videos/{job_id}/scorm.zip
    videos/{job_id}/manifest.json   <-- written LAST (publish flag)

Manifest holds blob names only — SAS tokens are minted at read time from
either a user delegation key (AAD) or account key (connection string).

Public reads (contracts v1.2 §2) work as in the podcast library: thumbnails are
signed with one window per 10-minute bucket (stable URLs for the browser
cache), the video keeps a per-request 15-minute SAS, ``strict`` reads raise
``LibraryUnavailable`` when storage is failing, and the connection is retried
(at most every 30 s) instead of staying dead after one failed start-up.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

from azure.core.exceptions import ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import (
    BlobSasPermissions,
    BlobServiceClient,
    ContentSettings,
    generate_blob_sas,
)

from config import AzureConfig
from services.demo_protocol import CAPTIONS_VTT_MAX_SOURCE_BYTES
from services.podcast_models import (
    CaptionsSource,
    LibraryUnavailable,
    SasWindow,
    audience_level_or_none,
    sas_bucket_window,
    source_deck_id_or_none,
)
from services.storage import INIT_RETRY_SECONDS

log = logging.getLogger(__name__)

LIBRARY_PREFIX = "videos"
MANIFEST_NAME = "manifest.json"
SUBTITLE_NAME = "subtitles.srt"
SCHEMA_VERSION = 1
JOB_ID_RE = re.compile(r"^sv-[0-9a-f]{8}$")
DEFAULT_SAS_MINUTES = 24 * 60
PUBLIC_SAS_MINUTES = 15


def valid_job_id(job_id: object) -> bool:
    return isinstance(job_id, str) and JOB_ID_RE.fullmatch(job_id) is not None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _has_captions(manifest: dict) -> bool:
    """True when the manifest names a subtitle blob (served as ``captions.vtt``)."""
    blob = manifest.get("subtitle_blob")
    return isinstance(blob, str) and bool(blob)


@dataclass
class VideoLibraryFiles:
    mp4: Path
    mp3: Path
    srt: Path
    thumb: Optional[Path] = None
    scorm: Optional[Path] = None


class VideoLibrary:
    """Publishes and lists rendered narrated slide videos in blob storage.

    ``list``/``get`` swallow storage failures (``[]``/``None``) unless ``strict=True``, which raises
    ``LibraryUnavailable`` instead — the public routes use it so that "storage is down" never reads as "nothing
    published"."""

    def __init__(
        self,
        config: AzureConfig,
        *,
        clock: Callable[[], float] = time.monotonic,
        utcnow: Callable[[], datetime] = _utcnow,
    ) -> None:
        self._config = config
        self._blob: Optional[BlobServiceClient] = None
        self._account_name: Optional[str] = None
        self._credential: Optional[DefaultAzureCredential] = None
        self._udk = None
        self._udk_start: Optional[datetime] = None
        self._udk_expiry: Optional[datetime] = None
        self._initialised = False
        self._clock = clock
        self._utcnow = utcnow
        self._init_lock = threading.Lock()
        self._init_attempted_at: Optional[float] = None

    # ------------------------------------------------------------------
    @property
    def configured(self) -> bool:
        """True when a blob account or connection string is set: a library that cannot connect is then failing,
        not empty."""
        cfg = self._config
        return bool(cfg.blob_account_name) or bool(cfg.blob_connection_string)

    def _retry_due(self) -> bool:
        attempted = self._init_attempted_at
        return (attempted is not None and self._blob is None and self.configured
                and self._clock() - attempted >= INIT_RETRY_SECONDS)

    def _ensure_init(self) -> bool:
        if self._initialised and not self._retry_due():
            return self._blob is not None
        # The very first init blocks concurrent callers (they need its answer); a retry is attempted by one thread
        # only, the others answer from the current state instead of queueing behind a slow connect.
        first = not self._initialised
        if not self._init_lock.acquire(blocking=first):
            return self._blob is not None
        try:
            if self._initialised and not self._retry_due():
                return self._blob is not None
            self._attempt_init()
            return self._blob is not None
        finally:
            self._init_lock.release()

    def _attempt_init(self) -> None:
        self._init_attempted_at = self._clock()
        try:
            if self._config.use_managed_identity and self._config.blob_account_name:
                cred = DefaultAzureCredential()
                url = f"https://{self._config.blob_account_name}.blob.core.windows.net"
                self._blob = BlobServiceClient(url, credential=cred)
                self._account_name = self._config.blob_account_name
                self._credential = cred
            elif self._config.blob_connection_string:
                self._blob = BlobServiceClient.from_connection_string(
                    self._config.blob_connection_string
                )
                for part in self._config.blob_connection_string.split(";"):
                    if part.strip().lower().startswith("accountname="):
                        self._account_name = part.strip().split("=", 1)[1]
                        break
            if self._blob:
                cc = self._blob.get_container_client(self._config.blob_container)
                if not cc.exists():
                    cc.create_container()
                log.info("VideoLibrary ready (container=%s)", self._config.blob_container)
        except Exception as exc:  # noqa: BLE001
            log.warning("VideoLibrary init failed: %s", exc)
            self._blob = None
        finally:
            self._initialised = True

    @property
    def available(self) -> bool:
        return self._ensure_init()

    # ------------------------------------------------------------------
    def publish(
        self,
        job_id: str,
        files: VideoLibraryFiles,
        *,
        title: str,
        document_title: str,
        language: str,
        voice: str,
        slide_count: int,
        duration_sec: Optional[float],
        created_at: str,
        audience_level: Optional[str] = None,
    ) -> Optional[dict]:
        if not valid_job_id(job_id):
            log.warning("Library publish skipped: invalid job id")
            return None
        if not self._ensure_init():
            log.warning("Library publish skipped: blob not configured")
            return None

        prefix = f"{LIBRARY_PREFIX}/{job_id}"
        try:
            thumb_blob: Optional[str] = None
            if files.thumb and files.thumb.exists():
                self._upload(f"{prefix}/thumb.jpg", files.thumb.read_bytes(),
                             content_type="image/jpeg")
                thumb_blob = f"{prefix}/thumb.jpg"

            self._upload(f"{prefix}/video.mp4", files.mp4.read_bytes(),
                         content_type="video/mp4")
            self._upload(f"{prefix}/audio.mp3", files.mp3.read_bytes(),
                         content_type="audio/mpeg")
            self._upload(f"{prefix}/{SUBTITLE_NAME}", files.srt.read_bytes(),
                         content_type="application/x-subrip")
            scorm_blob: Optional[str] = None
            if files.scorm and files.scorm.exists():
                self._upload(f"{prefix}/scorm.zip", files.scorm.read_bytes(),
                             content_type="application/zip")
                scorm_blob = f"{prefix}/scorm.zip"

            manifest = {
                "schema_version": SCHEMA_VERSION,
                "job_id": job_id,
                "title": title,
                "document_title": document_title,
                "created_at": created_at,
                "duration_sec": duration_sec,
                "language": language,
                "voice": voice,
                "audience_level": audience_level_or_none(audience_level),
                "slide_count": slide_count,
                "video_blob": f"{prefix}/video.mp4",
                "audio_blob": f"{prefix}/audio.mp3",
                "subtitle_blob": f"{prefix}/{SUBTITLE_NAME}",
                "thumbnail_blob": thumb_blob,
                "scorm_blob": scorm_blob,
                # Visibility to anonymous viewers; generation never auto-publishes.
                "published": False,
            }
            # Manifest LAST — its presence marks the archive as complete.
            self._upload(
                f"{prefix}/{MANIFEST_NAME}",
                json.dumps(manifest, indent=2).encode("utf-8"),
                content_type="application/json",
            )
            log.info("Video library published job %s", job_id)
            return manifest
        except Exception as exc:  # noqa: BLE001
            log.exception("Video library publish failed for %s: %s", job_id, exc)
            return None

    def _upload(self, blob_name: str, data: bytes, *, content_type: str) -> None:
        assert self._blob is not None
        client = self._blob.get_blob_client(
            container=self._config.blob_container, blob=blob_name
        )
        client.upload_blob(
            data, overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
        )

    # ------------------------------------------------------------------
    def list(self, *, published_only: bool = False, strict: bool = False) -> list[dict]:
        """Summaries of the archived videos, newest first, with a thumbnail SAS only.

        ``published_only`` is the anonymous view: published items only, with a thumbnail URL shared by every caller
        of the current 10-minute bucket (so the browser cache hits). ``strict=True`` raises ``LibraryUnavailable``
        when storage is configured but failing (it did not connect, the listing or a manifest read failed); ``[]``
        is then only ever "nothing published" (or "storage not configured"). The lenient default answers ``[]``.
        """
        if not self._ensure_init():
            if strict and self.configured:
                raise LibraryUnavailable("Video library storage is not available")
            return []
        assert self._blob is not None
        container = self._blob.get_container_client(self._config.blob_container)
        lifetime: int | SasWindow = (
            sas_bucket_window(self._utcnow()) if published_only else DEFAULT_SAS_MINUTES
        )
        items: list[dict] = []
        try:
            for blob in container.list_blobs(name_starts_with=f"{LIBRARY_PREFIX}/"):
                if not blob.name.endswith(f"/{MANIFEST_NAME}"):
                    continue
                try:
                    m = self._read_json_blob(blob.name)
                except LibraryUnavailable:
                    if strict:
                        raise
                    continue
                if not isinstance(m, dict) or not valid_job_id(m.get("job_id")):
                    continue
                published = m.get("published") is True
                if published_only and not published:
                    continue
                items.append({
                    "job_id": m.get("job_id"),
                    "title": m.get("title"),
                    "document_title": m.get("document_title", ""),
                    "created_at": m.get("created_at"),
                    "duration_sec": m.get("duration_sec"),
                    "language": m.get("language", "en-US"),
                    "voice": m.get("voice", ""),
                    "audience_level": audience_level_or_none(m.get("audience_level")),
                    "source_deck_id": source_deck_id_or_none(m.get("source_deck_id")),
                    "slide_count": m.get("slide_count", 0),
                    "thumbnail_url": self._sas(m.get("thumbnail_blob"), lifetime),
                    "published": published,
                    "has_captions": _has_captions(m),
                })
        except LibraryUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("Video library list failed: %s", exc)
            if strict:
                raise LibraryUnavailable("Video library listing failed") from exc
            return []
        items.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        return items

    def _manifest(self, job_id: str, *, strict: bool = False) -> Optional[dict]:
        """The stored manifest of an item (``published`` and ``audience_level`` normalized); None when absent.

        With ``strict`` a storage failure raises ``LibraryUnavailable`` instead (it reads as None otherwise)."""
        if not valid_job_id(job_id):
            return None
        if not self._ensure_init():
            if strict and self.configured:
                raise LibraryUnavailable("Video library storage is not available")
            return None
        try:
            m = self._read_json_blob(f"{LIBRARY_PREFIX}/{job_id}/{MANIFEST_NAME}")
        except LibraryUnavailable:
            if strict:
                raise
            return None
        if not isinstance(m, dict) or m.get("job_id") != job_id:
            return None
        m["published"] = m.get("published") is True
        m["audience_level"] = audience_level_or_none(m.get("audience_level"))
        return m

    def get(self, job_id: str, *, public: bool = False, strict: bool = False) -> Optional[dict]:
        """Full item with fresh SAS URLs.

        ``public=True`` returns only published items: the video gets a per-request 15-minute SAS, the thumbnail the
        current 10-minute bucket's shared URL, and nothing else is signed. ``strict=True``: a storage failure raises
        ``LibraryUnavailable`` instead of reading as "no such item" (``None``).
        """
        m = self._manifest(job_id, strict=strict)
        if not m:
            return None
        m["has_captions"] = _has_captions(m)
        if public:
            if not m["published"]:
                return None
            m["video_url"] = self._sas(m.get("video_blob"), PUBLIC_SAS_MINUTES)
            m["thumbnail_url"] = self._sas(m.get("thumbnail_blob"), sas_bucket_window(self._utcnow()))
            m["audio_url"] = m["srt_url"] = m["scorm_url"] = None
            return m
        m["video_url"] = self._sas(m.get("video_blob"))
        m["audio_url"] = self._sas(m.get("audio_blob"))
        m["srt_url"] = self._sas(m.get("subtitle_blob"))
        m["thumbnail_url"] = self._sas(m.get("thumbnail_blob"))
        m["scorm_url"] = self._sas(m.get("scorm_blob"))
        return m

    def captions_source(self, job_id: str, *, public: bool = False) -> Optional[CaptionsSource]:
        """The SRT of an item's captions, for the ``captions.vtt`` route.

        ``None`` when the item does not exist or the caller may not see it (``public=True``: unpublished). Otherwise
        a ``CaptionsSource`` whose ``text`` is None when the item has no usable captions: no subtitle blob, a blob
        that is missing or larger than ``CAPTIONS_VTT_MAX_SOURCE_BYTES``. Only the item's own ``subtitles.srt`` is
        ever read, whatever the manifest says. Raises ``LibraryUnavailable`` when storage fails.
        """
        m = self._manifest(job_id, strict=True)
        if not m or (public and not m["published"]):
            return None
        text = None
        if m.get("subtitle_blob") == f"{LIBRARY_PREFIX}/{job_id}/{SUBTITLE_NAME}":
            text = self._read_text_blob(m["subtitle_blob"], max_bytes=CAPTIONS_VTT_MAX_SOURCE_BYTES)
        return CaptionsSource(text=text, published=m["published"])

    def set_published(self, job_id: str, published: bool) -> Optional[dict]:
        """Flip the anonymous-visibility flag; returns the updated full item."""
        m = self._manifest(job_id)
        if not m:
            return None
        for k in ("video_url", "audio_url", "srt_url", "thumbnail_url", "scorm_url"):
            m.pop(k, None)
        m["published"] = bool(published)
        try:
            self._upload(
                f"{LIBRARY_PREFIX}/{job_id}/{MANIFEST_NAME}",
                json.dumps(m, indent=2).encode("utf-8"),
                content_type="application/json",
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("Video library publish flag update failed for %s: %s", job_id, exc)
            return None
        return self.get(job_id)

    def set_title(self, job_id: str, title: str, *, document_title: Optional[str] = None) -> Optional[dict]:
        """Rename a library item (and optionally its source document title)."""
        title = (title or "").strip()
        if not title:
            return None
        m = self._manifest(job_id)
        if not m:
            return None
        for k in ("video_url", "audio_url", "srt_url", "thumbnail_url", "scorm_url"):
            m.pop(k, None)
        m["title"] = title
        if document_title is not None and document_title.strip():
            m["document_title"] = document_title.strip()
        try:
            self._upload(
                f"{LIBRARY_PREFIX}/{job_id}/{MANIFEST_NAME}",
                json.dumps(m, indent=2).encode("utf-8"),
                content_type="application/json",
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("Video library title update failed for %s: %s", job_id, exc)
            return None
        return self.get(job_id)

    def delete(self, job_id: str) -> bool:
        if not valid_job_id(job_id):
            return False
        if not self._ensure_init():
            return False
        assert self._blob is not None
        container = self._blob.get_container_client(self._config.blob_container)
        prefix = f"{LIBRARY_PREFIX}/{job_id}/"
        if prefix == f"{LIBRARY_PREFIX}/" or not prefix.startswith(f"{LIBRARY_PREFIX}/sv-"):
            return False
        try:
            for blob in container.list_blobs(name_starts_with=prefix):
                container.delete_blob(blob.name)
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("Video library delete %s failed: %s", job_id, exc)
            return False

    # ------------------------------------------------------------------
    def _read_json_blob(self, blob_name: str) -> Optional[dict]:
        """The JSON document stored in a blob; None when it is absent or not valid JSON.

        A storage failure raises ``LibraryUnavailable``: callers decide whether it reads as "absent" (lenient) or
        propagates (``strict``)."""
        assert self._blob is not None
        try:
            c = self._blob.get_blob_client(
                container=self._config.blob_container, blob=blob_name
            )
            raw = c.download_blob().readall()
        except ResourceNotFoundError:
            return None
        except Exception as exc:  # noqa: BLE001
            raise LibraryUnavailable(f"Reading {blob_name} failed ({type(exc).__name__})") from exc
        try:
            return json.loads(raw)
        except (ValueError, RecursionError):
            return None

    def _read_text_blob(self, blob_name: str, *, max_bytes: Optional[int] = None) -> Optional[str]:
        """UTF-8 text of a blob; None when it is absent or larger than ``max_bytes``.

        A storage failure raises ``LibraryUnavailable``."""
        try:
            c = self._blob.get_blob_client(  # type: ignore[union-attr]
                container=self._config.blob_container, blob=blob_name
            )
            stream = c.download_blob()
            size = getattr(stream, "size", None)
            if max_bytes is not None and isinstance(size, int) and size > max_bytes:
                return None
            raw = stream.readall()
        except ResourceNotFoundError:
            return None
        except Exception as exc:  # noqa: BLE001
            raise LibraryUnavailable(f"Reading {blob_name} failed ({type(exc).__name__})") from exc
        if isinstance(raw, str):
            return raw if max_bytes is None or len(raw.encode("utf-8")) <= max_bytes else None
        data = bytes(raw)
        if max_bytes is not None and len(data) > max_bytes:
            return None
        return data.decode("utf-8-sig", errors="replace")

    def _sas(self, blob_name: Optional[str], lifetime: int | SasWindow = DEFAULT_SAS_MINUTES) -> Optional[str]:
        """Blob-scoped, read-only SAS URL, or None.

        ``lifetime`` is a number of minutes from now (a per-request URL) or a ``SasWindow`` (the fixed window shared
        by the public thumbnails)."""
        if not blob_name or not self._blob or not self._account_name:
            return None
        try:
            client = self._blob.get_blob_client(
                container=self._config.blob_container, blob=blob_name
            )
            now = self._utcnow()
            if isinstance(lifetime, SasWindow):
                start, expiry = lifetime.start, lifetime.expiry
            else:
                start = now - timedelta(minutes=5)
                expiry = now + timedelta(minutes=lifetime)

            if self._credential:
                # One key serves every window: it starts before the earliest start signed with it (the current
                # bucket's), so a window never needs a key that begins after it.
                udk = self._get_udk(min(start, sas_bucket_window(now).start), now + timedelta(hours=24))
                if not udk:
                    return None
                token = generate_blob_sas(
                    account_name=self._account_name,
                    container_name=self._config.blob_container,
                    blob_name=blob_name,
                    user_delegation_key=udk,
                    permission=BlobSasPermissions(read=True),
                    expiry=expiry, start=start,
                )
            else:
                token = generate_blob_sas(
                    account_name=self._account_name,
                    container_name=self._config.blob_container,
                    blob_name=blob_name,
                    account_key=_account_key_from_conn(self._config.blob_connection_string),
                    permission=BlobSasPermissions(read=True),
                    expiry=expiry, start=start,
                )
            return f"{client.url}?{token}"
        except Exception as exc:  # noqa: BLE001
            log.warning("SAS failed for %s: %s", blob_name, exc)
            return None

    def _get_udk(self, start: datetime, expiry: datetime):
        """A user delegation key valid from ``start`` until ``expiry`` (cached).

        The cached key is reused while it starts no later than ``start`` and has more than an hour left; a request
        that starts before it gets a new key, so the key always covers the SAS signed with it."""
        now = self._utcnow()
        if (self._udk and self._udk_start and self._udk_expiry
                and self._udk_start <= start and now < self._udk_expiry - timedelta(hours=1)):
            return self._udk
        try:
            self._udk = self._blob.get_user_delegation_key(  # type: ignore[union-attr]
                key_start_time=start, key_expiry_time=expiry,
            )
            self._udk_start, self._udk_expiry = start, expiry
            return self._udk
        except Exception as exc:  # noqa: BLE001
            log.warning("User delegation key failed: %s", exc)
            return None


def _account_key_from_conn(conn: str) -> str:
    for part in (conn or "").split(";"):
        if part.strip().lower().startswith("accountkey="):
            return part.strip().split("=", 1)[1]
    return ""
