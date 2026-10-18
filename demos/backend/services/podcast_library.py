"""Podcast Library — persists rendered podcasts to Azure Blob Storage.

Blob layout (all inside the existing blob container, prefix `podcast-library/`):

    podcast-library/{job_id}/audio.mp3        radio MP3 (or the video soundtrack, see audio_kind)
    podcast-library/{job_id}/audio.srt        captions timed on audio.mp3
    podcast-library/{job_id}/transcript.json  radio transcript (podcast_models.Transcript)
    podcast-library/{job_id}/cover.jpg        cover art
    podcast-library/{job_id}/video.mp4        video rendition (format="video" only)
    podcast-library/{job_id}/subtitles.srt    captions timed on video.mp4 (format="video" only)
    podcast-library/{job_id}/scorm.zip        optional SCORM package
    podcast-library/{job_id}/thumb.jpg        480w JPEG: a video frame, else the cover
    podcast-library/{job_id}/manifest.json    <-- written LAST; presence = archived

The manifest is the source of truth. To keep SAS tokens fresh, the manifest
stores only blob names; signed URLs are generated at read time. It never holds
Speech character names, voices or URLs.

Manifest v2 (``SCHEMA_VERSION``) adds the radio rendition; v1 manifests (video,
soundtrack MP3, video SRT) are still read. Writers (``set_published``,
``set_title``) edit the stored JSON (``_raw_manifest``) one key at a time;
readers get ``normalize_manifest``, which fills the fields v1 lacks without
ever persisting them. Only ``podcast-library/job-*/`` is listed or deleted
(the listener cache lives under another prefix).
"""
from __future__ import annotations

import copy
import json
import logging
import math
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, get_args

from azure.identity import DefaultAzureCredential
from azure.storage.blob import (
    BlobSasPermissions,
    BlobServiceClient,
    ContentSettings,
    generate_blob_sas,
)

from config import AzureConfig
from services.podcast_media import LISTENER_MODES, public_audio_enabled
from services.podcast_media import LibraryFiles as MediaLibraryFiles
from services.podcast_models import (
    AudioKind,
    PodcastFormat,
    PodcastHost,
    Transcript,
    audience_level_or_none,
    podcast_format_or_default,
)

logger = logging.getLogger(__name__)

LIBRARY_PREFIX = "podcast-library"
MANIFEST_NAME = "manifest.json"
SCHEMA_VERSION = 2
JOB_ID_RE = re.compile(r"^job-[0-9a-f]{8}$")
DEFAULT_SAS_MINUTES = 24 * 60
PUBLIC_SAS_MINUTES = 15
THUMB_WIDTH = 480

# Asset names inside podcast-library/{job_id}/.
VIDEO_NAME = "video.mp4"
SUBTITLE_NAME = "subtitles.srt"
AUDIO_NAME = "audio.mp3"
AUDIO_SUBTITLE_NAME = "audio.srt"
TRANSCRIPT_NAME = "transcript.json"
COVER_NAME = "cover.jpg"
THUMB_NAME = "thumb.jpg"
SCORM_NAME = "scorm.zip"

# Manifest keys holding blob names (null when the asset is absent).
BLOB_KEYS: tuple[str, ...] = (
    "video_blob", "subtitle_blob", "audio_blob", "audio_subtitle_blob",
    "transcript_blob", "cover_blob", "thumbnail_blob", "scorm_blob",
)
AUDIO_KINDS: tuple[str, ...] = get_args(AudioKind)
HOST_ROLES: tuple[str, ...] = ("interviewer", "expert")
# RoleConfig.display_name is at most 80 characters: longer "x:" prefixes are not speaker labels.
_MAX_LABEL_LEN = 80


def valid_job_id(job_id: object) -> bool:
    return isinstance(job_id, str) and JOB_ID_RE.fullmatch(job_id) is not None


def _manifest_blob(job_id: str) -> str:
    return f"{LIBRARY_PREFIX}/{job_id}/{MANIFEST_NAME}"


@dataclass
class LibraryFiles:
    """Legacy (v1) deliverables of a render: the MP4, its soundtrack MP3 and the video-timed SRT.

    Kept for backward compatibility; renders pass ``podcast_media.LibraryFiles``
    (v2) and ``PodcastLibrary.publish`` duck-types both. Without radio-timed
    assets (``audio_srt``/``transcript``) the MP3 is the video soundtrack: the
    item is published with ``audio_kind="soundtrack"``.
    """
    mp4: Path
    mp3: Path
    srt: Path
    scorm: Optional[Path] = None
    audio_srt: Optional[Path] = None
    transcript: Optional[Path] = None
    cover: Optional[Path] = None

    @property
    def has_video(self) -> bool:
        return self.mp4 is not None

    @property
    def format(self) -> PodcastFormat:
        return "video" if self.mp4 is not None else "audio"


class PodcastLibrary:
    """Publishes and lists rendered podcasts in blob storage."""

    def __init__(self, config: AzureConfig) -> None:
        self._config = config
        self._blob: Optional[BlobServiceClient] = None
        self._account_name: Optional[str] = None
        self._credential: Optional[DefaultAzureCredential] = None
        self._udk = None
        self._udk_expiry: Optional[datetime] = None
        self._initialised = False

    # ------------------------------------------------------------------
    # Init
    # ------------------------------------------------------------------
    def _ensure_init(self) -> bool:
        if self._initialised:
            return self._blob is not None
        self._initialised = True
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
                # Account name is required for SAS minting; extract from connection string
                for part in self._config.blob_connection_string.split(";"):
                    if part.strip().lower().startswith("accountname="):
                        self._account_name = part.strip().split("=", 1)[1]
                        break
            if self._blob:
                cc = self._blob.get_container_client(self._config.blob_container)
                if not cc.exists():
                    cc.create_container()
                logger.info("PodcastLibrary ready (container=%s)", self._config.blob_container)
        except Exception as exc:  # noqa: BLE001
            logger.warning("PodcastLibrary init failed: %s", exc)
            self._blob = None
        return self._blob is not None

    @property
    def available(self) -> bool:
        return self._ensure_init()

    # ------------------------------------------------------------------
    # Publish
    # ------------------------------------------------------------------
    def publish(
        self,
        job_id: str,
        files: LibraryFiles | MediaLibraryFiles,
        *,
        title: str,
        document_title: str,
        language: str,
        style: str,
        speaker_names: list[str],
        turn_count: int,
        created_at: str,
        audience_level: Optional[str] = None,
        hosts: Optional[list[PodcastHost]] = None,
        audio_kind: AudioKind = "radio_mix",
        listener_mode: Optional[str] = None,
    ) -> Optional[dict]:
        """Upload a render's assets, then its v2 manifest (returned).

        ``files`` is a ``podcast_media.LibraryFiles`` or the legacy
        ``LibraryFiles`` (duck-typed). Absent assets are skipped: video assets
        only exist for ``format="video"``; without radio-timed assets
        (``audio_srt``/``transcript``) the MP3 is the video soundtrack and the
        item is stored as ``audio_kind="soundtrack"``. ``duration_sec`` is the
        primary rendition's (the video when present). The thumbnail is a video
        frame, else derived from the cover, and never fails the publish.
        ``hosts`` defaults to the transcript's, else to ``speaker_names``.

        The manifest is written LAST. If any earlier upload fails, nothing is
        considered published and the caller may retry.
        """
        if not valid_job_id(job_id):
            logger.warning("Library publish skipped: invalid job id")
            return None
        if not self._ensure_init():
            logger.warning("Library publish skipped: blob not configured")
            return None

        prefix = f"{LIBRARY_PREFIX}/{job_id}"
        thumb_path: Optional[Path] = None
        try:
            mp4, srt = _asset(files, "mp4"), _asset(files, "srt")
            mp3, audio_srt = _asset(files, "mp3"), _asset(files, "audio_srt")
            transcript_path, cover = _asset(files, "transcript"), _asset(files, "cover")
            scorm = _asset(files, "scorm")
            renditions = [p for p in (mp4, mp3) if p is not None]
            if not renditions or not all(p.is_file() for p in renditions):
                logger.warning("Library publish skipped for %s: media rendition missing", job_id)
                return None
            fmt: PodcastFormat = "video" if mp4 is not None else "audio"
            kind = _effective_audio_kind(audio_kind, audio_srt is not None or transcript_path is not None)
            transcript = _read_transcript_file(transcript_path) if _is_file(transcript_path) else None
            if transcript_path is not None and transcript is None:
                logger.warning("Library publish %s: transcript missing or invalid, skipped", job_id)
            if not _is_file(cover):
                cover = None

            # 1. Probe each rendition; duration_sec is the primary one's.
            video_duration = _num(_ffprobe_duration(mp4)) if mp4 is not None else None
            audio_duration = _num(_ffprobe_duration(mp3)) if mp3 is not None else None
            if audio_duration is None and mp3 is not None and transcript is not None:
                audio_duration = _num(transcript.duration_sec) or None
            duration_sec = video_duration if mp4 is not None else audio_duration

            blobs: dict[str, Optional[str]] = dict.fromkeys(BLOB_KEYS)

            # 2. Thumbnail (best effort, 480w JPEG)
            thumb_path = renditions[0].parent / f"{job_id}-thumb.jpg"
            blobs["thumbnail_blob"] = self._publish_thumbnail(
                f"{prefix}/{THUMB_NAME}", thumb_path, mp4=mp4, video_duration=video_duration, cover=cover,
            )

            # 3. Radio assets
            if cover is not None:
                blobs["cover_blob"] = self._upload_file(f"{prefix}/{COVER_NAME}", cover, "image/jpeg")
            if transcript is not None:
                # Re-serialized from the model: only contract fields are published.
                blobs["transcript_blob"] = f"{prefix}/{TRANSCRIPT_NAME}"
                self._upload(blobs["transcript_blob"], transcript.model_dump_json().encode("utf-8"),
                             content_type="application/json")
            if _is_file(audio_srt):
                blobs["audio_subtitle_blob"] = self._upload_file(
                    f"{prefix}/{AUDIO_SUBTITLE_NAME}", audio_srt, "application/x-subrip")
            if mp3 is not None:
                blobs["audio_blob"] = self._upload_file(f"{prefix}/{AUDIO_NAME}", mp3, "audio/mpeg")

            # 4. Video assets
            if mp4 is not None:
                blobs["video_blob"] = self._upload_file(f"{prefix}/{VIDEO_NAME}", mp4, "video/mp4")
                if _is_file(srt):
                    blobs["subtitle_blob"] = self._upload_file(
                        f"{prefix}/{SUBTITLE_NAME}", srt, "application/x-subrip")
            if _is_file(scorm):
                blobs["scorm_blob"] = self._upload_file(f"{prefix}/{SCORM_NAME}", scorm, "application/zip")

            # 5. Finally, write the manifest (presence => archived)
            names = list(speaker_names or [])
            manifest = {
                "schema_version": SCHEMA_VERSION,
                "job_id": job_id,
                "title": title,
                "document_title": document_title,
                "created_at": created_at,
                "format": fmt,
                "has_video": blobs["video_blob"] is not None,
                "has_audio": blobs["audio_blob"] is not None,
                "duration_sec": duration_sec,
                "audio_duration_sec": audio_duration,
                "video_duration_sec": video_duration,
                "language": language,
                "style": style,
                "audience_level": audience_level_or_none(audience_level),
                "speaker_names": names,
                "hosts": _normalize_hosts(hosts or (transcript.hosts if transcript else None), names),
                "turn_count": turn_count,
                "audio_kind": kind,
                "listener_mode": listener_mode if fmt == "video" and listener_mode in LISTENER_MODES else None,
                **blobs,
                # Visibility to anonymous viewers; generation never auto-publishes.
                "published": False,
            }
            self._upload(
                _manifest_blob(job_id),
                json.dumps(manifest, indent=2).encode("utf-8"),
                content_type="application/json",
            )
            logger.info("Library published job %s (format=%s, audio=%s)", job_id, fmt, kind)
            return manifest
        except Exception as exc:  # noqa: BLE001
            logger.exception("Library publish failed for %s: %s", job_id, exc)
            return None
        finally:
            if thumb_path is not None:
                try:
                    thumb_path.unlink(missing_ok=True)
                except OSError:
                    pass

    def _publish_thumbnail(
        self,
        blob_name: str,
        tmp: Path,
        *,
        mp4: Optional[Path],
        video_duration: Optional[float],
        cover: Optional[Path],
    ) -> Optional[str]:
        """Upload a 480w JPEG (a video frame, else the cover); None on any failure."""
        try:
            tmp.unlink(missing_ok=True)
            ok = False
            if mp4 is not None:
                ok = _extract_thumbnail(mp4, tmp, ts=max(0.5, min(3.0, (video_duration or 0) * 0.25)))
            if not ok and cover is not None:
                ok = _thumbnail_from_image(cover, tmp)
            if not ok:
                return None
            self._upload(blob_name, tmp.read_bytes(), content_type="image/jpeg")
            return blob_name
        except Exception as exc:  # noqa: BLE001
            logger.warning("Library thumbnail skipped: %s", type(exc).__name__)
            return None

    def _upload_file(self, blob_name: str, path: Path, content_type: str) -> str:
        self._upload(blob_name, path.read_bytes(), content_type=content_type)
        return blob_name

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
    # List / get
    # ------------------------------------------------------------------
    def list(self, *, published_only: bool = False) -> list[dict]:
        """Return normalized summaries of archived items, with a thumbnail SAS only.

        The full-media SAS URLs are generated by `get()` when a user opens
        a specific item — that keeps listing cheap and limits token exposure.
        ``published_only`` is the anonymous view: published items only,
        15-minute thumbnails, and — unless ``PODCAST_PUBLIC_AUDIO`` is on — no
        audio-only items and no audio facts or host names.
        """
        if not self._ensure_init():
            return []
        assert self._blob is not None
        container = self._blob.get_container_client(self._config.blob_container)
        minutes = PUBLIC_SAS_MINUTES if published_only else DEFAULT_SAS_MINUTES
        audio_public = public_audio_enabled()
        items: list[dict] = []
        try:
            for blob in container.list_blobs(name_starts_with=f"{LIBRARY_PREFIX}/job-"):
                if not blob.name.endswith(f"/{MANIFEST_NAME}"):
                    continue
                raw = self._read_json_blob(blob.name)
                if not isinstance(raw, dict) or not valid_job_id(raw.get("job_id")) \
                        or blob.name != _manifest_blob(raw["job_id"]):
                    continue
                m = normalize_manifest(raw)
                if published_only:
                    if not _publicly_visible(m, audio_public):
                        continue
                    _apply_public_audio_policy(m, audio_public)
                items.append({
                    "job_id": m["job_id"],
                    "title": m.get("title"),
                    "document_title": m.get("document_title"),
                    "created_at": m.get("created_at"),
                    "duration_sec": m["duration_sec"],
                    "language": m.get("language"),
                    "style": m.get("style"),
                    "audience_level": m["audience_level"],
                    "speaker_names": m["speaker_names"],
                    "turn_count": m["turn_count"],
                    "thumbnail_url": self._sign(m["thumbnail_blob"], minutes),
                    "published": m["published"],
                    "format": m["format"],
                    "has_video": m["has_video"],
                    "has_audio": m["has_audio"],
                    "audio_duration_sec": m["audio_duration_sec"],
                    "hosts": m["hosts"],
                })
        except Exception as exc:  # noqa: BLE001
            logger.warning("Library list failed: %s", exc)
            return []
        # newest first
        items.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
        return items

    def _raw_manifest(self, job_id: str) -> Optional[dict]:
        """The stored manifest exactly as written — for writers only (readers normalize)."""
        if not valid_job_id(job_id) or not self._ensure_init():
            return None
        m = self._read_json_blob(_manifest_blob(job_id))
        if not isinstance(m, dict) or m.get("job_id") != job_id:
            return None
        return m

    def _manifest(self, job_id: str) -> Optional[dict]:
        """Normalized (reader) copy of the stored manifest."""
        raw = self._raw_manifest(job_id)
        return normalize_manifest(raw) if raw is not None else None

    def get(self, job_id: str, *, public: bool = False) -> Optional[dict]:
        """Return a normalized item with fresh SAS URLs and the inline transcript.

        Admin (default): 24-hour SAS for every rendition present (``mp4_url``,
        ``mp3_url`` = ``audio_url``, ``srt_url``, ``audio_srt_url``,
        ``thumbnail_url``, ``cover_url``, ``scorm_url``) and ``transcript``
        (``transcript.json``, else derived from an audio-aligned SRT; None when
        unavailable).

        ``public=True`` returns published items only, with 15-minute SAS URLs
        for the video and thumbnail. The audio (``mp3_url``/``audio_url``),
        cover, hosts, speaker names and transcript are included only when
        ``PODCAST_PUBLIC_AUDIO`` is on; otherwise audio-only items return None
        and ``has_audio`` reads False. ``srt_url``, ``audio_srt_url`` and
        ``scorm_url`` are never minted publicly.
        """
        m = self._manifest(job_id)
        if not m:
            return None
        if public:
            if not m["published"]:
                return None
            audio_public = public_audio_enabled()
            if not _publicly_visible(m, audio_public):
                return None
            _apply_public_audio_policy(m, audio_public)
            m["mp4_url"] = self._sign(m["video_blob"], PUBLIC_SAS_MINUTES)
            m["thumbnail_url"] = self._sign(m["thumbnail_blob"], PUBLIC_SAS_MINUTES)
            m["srt_url"] = m["audio_srt_url"] = m["scorm_url"] = None
            if audio_public:
                m["mp3_url"] = self._sign(m["audio_blob"], PUBLIC_SAS_MINUTES)
                m["cover_url"] = self._sign(m["cover_blob"], PUBLIC_SAS_MINUTES)
                m["transcript"] = self._inline_transcript(m)
            else:
                m["mp3_url"] = m["cover_url"] = m["transcript"] = None
            m["audio_url"] = m["mp3_url"]
            return m
        m["mp4_url"] = self._sign(m["video_blob"], DEFAULT_SAS_MINUTES)
        m["mp3_url"] = self._sign(m["audio_blob"], DEFAULT_SAS_MINUTES)
        m["audio_url"] = m["mp3_url"]
        m["srt_url"] = self._sign(m["subtitle_blob"], DEFAULT_SAS_MINUTES)
        m["audio_srt_url"] = self._sign(m["audio_subtitle_blob"], DEFAULT_SAS_MINUTES)
        m["thumbnail_url"] = self._sign(m["thumbnail_blob"], DEFAULT_SAS_MINUTES)
        m["cover_url"] = self._sign(m["cover_blob"], DEFAULT_SAS_MINUTES)
        m["scorm_url"] = self._sign(m["scorm_blob"], DEFAULT_SAS_MINUTES)
        m["transcript"] = self._inline_transcript(m)
        return m

    def _inline_transcript(self, m: dict) -> Optional[dict]:
        """``transcript.json`` as a plain ``Transcript`` dict (None if missing or corrupt).

        Items without one (v1) get a transcript derived from the SRT aligned
        with their MP3: ``audio.srt``, else — for a soundtrack MP3 — the video
        ``subtitles.srt``.
        """
        try:
            if m.get("transcript_blob"):
                return _transcript_dict(self._read_json_blob(m["transcript_blob"]))
            if not m.get("has_audio"):
                return None
            soundtrack = m.get("audio_kind") == "soundtrack"
            srt_blob = m.get("audio_subtitle_blob") or (m.get("subtitle_blob") if soundtrack else None)
            if not srt_blob:
                return None
            text = self._read_text_blob(srt_blob)
            if not text:
                return None
            return transcript_from_srt(
                text, m.get("hosts") or [], duration_sec=m.get("audio_duration_sec"),
                video_aligned=soundtrack and bool(m.get("has_video")),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Library transcript unavailable for %s: %s", m.get("job_id"), type(exc).__name__)
            return None

    def set_published(self, job_id: str, published: bool) -> Optional[dict]:
        """Flip the anonymous-visibility flag; returns the updated full item.

        Only ``published`` changes in the stored manifest.
        """
        raw = self._raw_manifest(job_id)
        if raw is None:
            return None
        raw["published"] = bool(published)
        if not self._write_manifest(job_id, raw, what="publish flag"):
            return None
        return self.get(job_id)

    def set_title(self, job_id: str, title: str, *, document_title: Optional[str] = None) -> Optional[dict]:
        """Rename a library item (and optionally its source document title).

        Only ``title`` (and ``document_title``) change in the stored manifest.
        """
        title = (title or "").strip()
        if not title:
            return None
        raw = self._raw_manifest(job_id)
        if raw is None:
            return None
        raw["title"] = title
        if document_title is not None and document_title.strip():
            raw["document_title"] = document_title.strip()
        if not self._write_manifest(job_id, raw, what="title"):
            return None
        return self.get(job_id)

    def _write_manifest(self, job_id: str, raw: dict, *, what: str) -> bool:
        try:
            self._upload(
                _manifest_blob(job_id),
                json.dumps(raw, indent=2).encode("utf-8"),
                content_type="application/json",
            )
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Library %s update failed for %s: %s", what, job_id, exc)
            return False

    def delete(self, job_id: str) -> bool:
        """Delete all blobs for a library item (validated ``{job_id}/`` prefix)."""
        if not valid_job_id(job_id):
            return False
        if not self._ensure_init():
            return False
        assert self._blob is not None
        container = self._blob.get_container_client(self._config.blob_container)
        prefix = f"{LIBRARY_PREFIX}/{job_id}/"
        if prefix == f"{LIBRARY_PREFIX}/" or not prefix.startswith(f"{LIBRARY_PREFIX}/job-"):
            return False
        try:
            for blob in container.list_blobs(name_starts_with=prefix):
                container.delete_blob(blob.name)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Library delete %s failed: %s", job_id, exc)
            return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _read_json_blob(self, blob_name: str) -> Optional[dict]:
        assert self._blob is not None
        try:
            c = self._blob.get_blob_client(
                container=self._config.blob_container, blob=blob_name
            )
            raw = c.download_blob().readall()
            return json.loads(raw)
        except Exception:
            return None

    def _read_text_blob(self, blob_name: str) -> Optional[str]:
        """UTF-8 text of a blob, or None on any failure."""
        try:
            c = self._blob.get_blob_client(  # type: ignore[union-attr]
                container=self._config.blob_container, blob=blob_name
            )
            raw = c.download_blob().readall()
            return raw if isinstance(raw, str) else bytes(raw).decode("utf-8-sig", errors="replace")
        except Exception:
            return None

    def _sign(self, blob_name: object, minutes: int) -> Optional[str]:
        """SAS URL for a manifest blob name; absent blobs are never signed."""
        if not isinstance(blob_name, str) or not blob_name:
            return None
        return self._sas(blob_name, minutes)

    def _sas(self, blob_name: Optional[str], minutes: int = DEFAULT_SAS_MINUTES) -> Optional[str]:
        """Generate a blob-scoped read-only SAS URL valid for ``minutes``, or None."""
        if not blob_name or not self._blob or not self._account_name:
            return None
        try:
            client = self._blob.get_blob_client(
                container=self._config.blob_container, blob=blob_name
            )
            now = datetime.now(timezone.utc)
            start = now - timedelta(minutes=5)
            expiry = now + timedelta(minutes=minutes)

            if self._credential:
                udk = self._get_udk(start, now + timedelta(hours=24))
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
                # Account-key path (connection string with key)
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
            logger.warning("SAS failed for %s: %s", blob_name, exc)
            return None

    def _get_udk(self, start: datetime, expiry: datetime):
        from datetime import timedelta
        now = datetime.now(timezone.utc)
        if (self._udk and self._udk_expiry
                and now < self._udk_expiry - timedelta(hours=1)):
            return self._udk
        try:
            self._udk = self._blob.get_user_delegation_key(  # type: ignore[union-attr]
                key_start_time=start, key_expiry_time=expiry,
            )
            self._udk_expiry = expiry
            return self._udk
        except Exception as exc:  # noqa: BLE001
            logger.warning("User delegation key failed: %s", exc)
            return None


# ----------------------------------------------------------------------
# Manifest normalization (pure; readers only — never persisted)
# ----------------------------------------------------------------------
def normalize_manifest(raw: dict) -> dict:
    """Reader view of a stored v1/v2 manifest; ``raw`` itself is left untouched.

    v1 (video-only) manifests read as ``format="video"`` with ``has_video`` /
    ``has_audio`` from their blob names, ``audio_kind="soundtrack"`` (the MP3
    was ripped from the MP4), ``hosts`` derived from ``speaker_names``
    (interviewer first, no avatar) and both durations from ``duration_sec``.
    Every blob key is present (None when absent); unknown values fall back to
    safe defaults.
    """
    m = copy.deepcopy(raw)
    m["published"] = raw.get("published") is True
    m["audience_level"] = audience_level_or_none(raw.get("audience_level"))
    for key in BLOB_KEYS:
        value = raw.get(key)
        m[key] = value if isinstance(value, str) and value else None
    m["format"] = podcast_format_or_default(raw.get("format"))
    m["has_video"] = m["video_blob"] is not None
    m["has_audio"] = m["audio_blob"] is not None
    kind = raw.get("audio_kind")
    m["audio_kind"] = kind if isinstance(kind, str) and kind in AUDIO_KINDS else "soundtrack"
    names = raw.get("speaker_names")
    m["speaker_names"] = [n for n in names if isinstance(n, str)] if isinstance(names, list) else []
    m["hosts"] = _normalize_hosts(raw.get("hosts"), m["speaker_names"])
    turn_count = raw.get("turn_count")
    m["turn_count"] = turn_count if isinstance(turn_count, int) and not isinstance(turn_count, bool) \
        and turn_count >= 0 else 0
    duration = _num(raw.get("duration_sec"))
    audio_duration = _num(raw.get("audio_duration_sec"))
    if audio_duration is None and m["has_audio"] and (m["format"] == "audio" or m["audio_kind"] == "soundtrack"):
        audio_duration = duration
    video_duration = _num(raw.get("video_duration_sec"))
    if video_duration is None and m["has_video"] and m["format"] == "video":
        video_duration = duration
    m["duration_sec"] = duration
    m["audio_duration_sec"] = audio_duration
    m["video_duration_sec"] = video_duration
    mode = raw.get("listener_mode")
    m["listener_mode"] = mode if isinstance(mode, str) and mode in LISTENER_MODES else None
    return m


def _publicly_visible(m: dict, audio_public: bool) -> bool:
    """Anonymous visibility: published and watchable (or listenable with public audio on)."""
    return m["published"] and (m["has_video"] or (audio_public and m["has_audio"]))


def _apply_public_audio_policy(m: dict, audio_public: bool) -> None:
    """Without ``PODCAST_PUBLIC_AUDIO``, visitors get no audio facts or host names."""
    if audio_public:
        return
    m["has_audio"] = False
    m["audio_duration_sec"] = None
    m["hosts"] = []
    m["speaker_names"] = []


def _normalize_hosts(value: object, speaker_names: list[str]) -> list[dict]:
    """Valid ``PodcastHost`` dicts (first per role), else derived from ``speaker_names``."""
    hosts: list[dict] = []
    if isinstance(value, (list, tuple)):
        seen: set[str] = set()
        for entry in value:
            try:
                host = entry if isinstance(entry, PodcastHost) else PodcastHost.model_validate(entry)
            except Exception:  # noqa: BLE001
                continue
            name = host.display_name.strip()
            if not name or host.role in seen:
                continue
            seen.add(host.role)
            hosts.append({"role": host.role, "display_name": name, "avatar_id": host.avatar_id or None})
    if hosts:
        return hosts
    return [{"role": role, "display_name": name.strip(), "avatar_id": None}
            for role, name in zip(HOST_ROLES, speaker_names)
            if isinstance(name, str) and name.strip()]


def _num(value: object) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and number >= 0 else None


def _asset(files: object, name: str) -> Optional[Path]:
    value = getattr(files, name, None)
    if value is None or value == "":
        return None
    return value if isinstance(value, Path) else Path(value)


def _is_file(path: Optional[Path]) -> bool:
    try:
        return path is not None and path.is_file()
    except OSError:
        return False


def _effective_audio_kind(requested: object, radio_assets: bool) -> str:
    """Without radio-timed assets the MP3 can only be the video soundtrack."""
    if not radio_assets:
        return "soundtrack"
    return requested if isinstance(requested, str) and requested in AUDIO_KINDS else "radio_mix"


# ----------------------------------------------------------------------
# Transcripts
# ----------------------------------------------------------------------
def _read_transcript_file(path: Path) -> Optional[Transcript]:
    try:
        return Transcript.model_validate_json(path.read_bytes())
    except Exception:  # noqa: BLE001
        return None


def _transcript_dict(data: object) -> Optional[dict]:
    """Plain ``Transcript`` dict of stored JSON; None when absent or invalid."""
    if not isinstance(data, dict):
        return None
    try:
        return Transcript.model_validate(data).model_dump()
    except Exception:  # noqa: BLE001
        return None


_SRT_TS = r"(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?"
_SRT_TIMING_RE = re.compile(rf"^\s*{_SRT_TS}\s*-->\s*{_SRT_TS}")


def _srt_seconds(h: str, m: str, s: str, frac: Optional[str]) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + (int(frac.ljust(3, "0")) / 1000 if frac else 0.0)


def _parse_srt(text: str) -> list[tuple[float, float, str]]:
    """``(start, end, text)`` cues of an SRT document; malformed blocks are skipped."""
    cues: list[tuple[float, float, str]] = []
    normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    for block in re.split(r"\n[ \t]*\n", normalized.strip()):
        lines = [line.strip() for line in block.split("\n")]
        for i, line in enumerate(lines):
            match = _SRT_TIMING_RE.match(line)
            if not match:
                continue
            groups = match.groups()
            start, end = _srt_seconds(*groups[:4]), _srt_seconds(*groups[4:])
            body = " ".join(part for part in lines[i + 1:] if part)
            if body:
                cues.append((start, max(start, end), body))
            break
    return cues


def _looks_like_label(label: str) -> bool:
    return 0 < len(label) <= _MAX_LABEL_LEN and len(label.split()) <= 4 \
        and not any(c in label for c in ".!?;")


def _cue_speaker(body: str, hosts: list[dict]) -> tuple[str, str]:
    """``(role, text)`` of a ``"Name: text"`` cue; names matching no host map to the expert."""
    named = [(str(h.get("display_name") or "").strip(), h.get("role")) for h in hosts]
    named = [(name, role) for name, role in named if name and role in HOST_ROLES]
    for name, role in sorted(named, key=lambda nr: len(nr[0]), reverse=True):
        if body.startswith(f"{name}:"):
            return role, body[len(name) + 1:].strip()
    label, sep, rest = body.partition(":")
    label = label.strip()
    if sep and rest.strip() and _looks_like_label(label):
        wanted = label.casefold()
        return next((role for name, role in named if name.casefold() == wanted), "expert"), rest.strip()
    return "expert", body.strip()


def transcript_from_srt(
    srt_text: str,
    hosts: list[dict],
    *,
    duration_sec: Optional[float] = None,
    video_aligned: bool = False,
) -> Optional[dict]:
    """Plain ``Transcript`` dict derived from a ``"Name: text"`` SRT (v1 items).

    Cue timings are kept as-is (the SRT must be aligned with the MP3). A cue's
    speaker is the host whose display name labels it (unknown names map to the
    expert); consecutive cues of one speaker form a turn. ``video_aligned``
    (soundtrack MP3 of a video: same timeline) also fills the turns'
    ``video_start``/``video_end``. No peaks. None when the SRT has no cues.
    """
    turns: list[dict] = []
    cues: list[dict] = []
    for start, end, body in _parse_srt(srt_text):
        speaker, text = _cue_speaker(body, hosts)
        if not text:
            continue
        if not turns or turns[-1]["speaker"] != speaker:
            turns.append({"turn_idx": len(turns), "speaker": speaker, "start": start, "end": end})
        turn = turns[-1]
        turn["end"] = max(turn["end"], end)
        cues.append({"start": start, "end": end, "speaker": speaker, "turn_idx": turn["turn_idx"],
                     "text": text, "kind": "speech"})
    if not cues:
        return None
    if video_aligned:
        for turn in turns:
            turn["video_start"], turn["video_end"] = turn["start"], turn["end"]
    duration = _num(duration_sec) or max(cue["end"] for cue in cues)
    return Transcript(duration_sec=duration, hosts=hosts, turns=turns, cues=cues).model_dump()


# ----------------------------------------------------------------------
# ffmpeg / ffprobe helpers
# ----------------------------------------------------------------------
def _ffprobe_duration(path: Path) -> Optional[float]:
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            stderr=subprocess.STDOUT, timeout=15,
        )
        return float(out.decode().strip())
    except Exception:
        return None


def _extract_thumbnail(mp4: Path, out: Path, *, ts: float) -> bool:
    """Grab a single frame at `ts` seconds, scaled to 480 wide JPEG."""
    if not shutil.which("ffmpeg"):
        return False
    try:
        subprocess.check_call(
            ["ffmpeg", "-y", "-ss", f"{ts:.2f}", "-i", str(mp4),
             "-vframes", "1", "-vf", f"scale={THUMB_WIDTH}:-2",
             "-q:v", "4", str(out)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
        return out.exists() and out.stat().st_size > 0
    except Exception:
        return False


def _thumbnail_from_image(src: Path, out: Path, *, width: int = THUMB_WIDTH) -> bool:
    """Scale a still image (the cover) to a ``width``-wide JPEG: Pillow, else ffmpeg."""
    try:
        from PIL import Image

        with Image.open(src) as img:
            rgb = img.convert("RGB")
        w, h = rgb.size
        if w > 0 and h > 0:
            rgb.resize((width, max(1, round(h * width / w))), Image.Resampling.LANCZOS) \
                .save(out, "JPEG", quality=85, optimize=True)
            if out.exists() and out.stat().st_size > 0:
                return True
    except Exception:  # noqa: BLE001
        pass
    if not shutil.which("ffmpeg"):
        return False
    try:
        subprocess.check_call(
            ["ffmpeg", "-y", "-i", str(src), "-vframes", "1", "-vf", f"scale={width}:-2",
             "-q:v", "4", str(out)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
        return out.exists() and out.stat().st_size > 0
    except Exception:  # noqa: BLE001
        return False


def _account_key_from_conn(conn: str) -> str:
    for part in conn.split(";"):
        if part.strip().lower().startswith("accountkey="):
            return part.strip().split("=", 1)[1]
    return ""
