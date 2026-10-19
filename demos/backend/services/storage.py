"""Persistence layer: Azure Blob Storage for slide images, Cosmos DB for metadata."""

from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from azure.cosmos import CosmosClient, PartitionKey, exceptions as cosmos_exceptions
from azure.identity import DefaultAzureCredential
from azure.storage.blob import (
    BlobServiceClient,
    BlobSasPermissions,
    ContentSettings,
    generate_blob_sas,
)

from config import AzureConfig

logger = logging.getLogger(__name__)

COSMOS_CONTAINER = "presentations"
COSMOS_PROGRESS_CONTAINER = "playlist_progress"

# Presentation / deck ids are uuid4 strings; blob prefixes derived from them
# must never collapse to a library root (e.g. "videos/").
_PRESENTATION_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DEFAULT_SAS_MINUTES = 24 * 60
PUBLIC_SAS_MINUTES = 15
# A configured Cosmos DB / Blob Storage that failed to initialise is retried at most this often
# (seconds), so one transient start-up failure does not disable the store until the next restart.
INIT_RETRY_SECONDS = 30


class StorageUnavailable(Exception):
    """Cosmos DB is configured but cannot be reached.

    Raised by the ``strict=True`` readers (``list_decks``, ``get_presentation``) instead of answering
    ``[]`` / ``None``, so a caller can tell "nothing there" from "storage is down" (contracts v1.2 §2.4).
    """


def deck_title(doc: dict) -> str:
    """Display title of a catalog deck: the stored ``title`` (set by the operator
    CLI or at upload) or, for older decks, the filename without extension."""
    title = doc.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()
    filename = doc.get("filename") or doc.get("id") or ""
    return filename.rsplit(".", 1)[0] if filename else "Untitled"


class PresentationStore:
    """Manages presentation persistence in Cosmos DB + Blob Storage."""

    def __init__(self, config: AzureConfig, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._config = config
        self._blob_client: BlobServiceClient | None = None
        self._cosmos_db: Any = None
        self._cosmos_container: Any = None
        self._progress_container: Any = None
        self._initialised = False
        self._credential: DefaultAzureCredential | None = None
        self._account_name: str | None = None
        self._user_delegation_key = None
        self._delegation_key_expiry: datetime | None = None
        self._clock = clock
        self._init_lock = threading.Lock()
        self._init_attempted_at: float | None = None

    # ------------------------------------------------------------------
    # Lazy init — only connects when first needed
    # ------------------------------------------------------------------

    def _blob_configured(self) -> bool:
        cfg = self._config
        return bool(cfg.blob_connection_string) or bool(cfg.use_managed_identity and cfg.blob_account_name)

    def _init_pending(self) -> bool:
        """True while a configured Cosmos DB container or Blob client is still missing."""
        cosmos_missing = bool(self._config.cosmos_endpoint) and self._cosmos_container is None
        blob_missing = self._blob_configured() and self._blob_client is None
        return cosmos_missing or blob_missing

    def _retry_due(self) -> bool:
        attempted = self._init_attempted_at
        return attempted is not None and self._init_pending() and self._clock() - attempted >= INIT_RETRY_SECONDS

    def _ensure_init(self) -> bool:
        if self._initialised and not self._retry_due():
            return self._cosmos_container is not None
        # The very first init blocks concurrent callers (they need its answer); a retry is attempted by one
        # thread only, the others answer from the current state instead of queueing behind a slow connect.
        first = not self._initialised
        if not self._init_lock.acquire(blocking=first):
            return self._cosmos_container is not None
        try:
            if self._initialised and not self._retry_due():
                return self._cosmos_container is not None
            self._attempt_init()
        finally:
            self._init_lock.release()
        return self._cosmos_container is not None

    def _attempt_init(self) -> None:
        """One init attempt. The parts that already work are kept: only a missing Blob client or Cosmos
        container is (re)built."""
        try:
            self._init_attempted_at = self._clock()
            credential = DefaultAzureCredential() if self._config.use_managed_identity else None
            if self._blob_client is None:
                self._init_blob(credential)
            if self._cosmos_container is None:
                self._init_cosmos(credential)
        finally:
            self._initialised = True

    def _init_blob(self, credential: DefaultAzureCredential | None) -> None:
        try:
            if self._config.use_managed_identity and self._config.blob_account_name:
                # Managed identity: construct client from account name
                account_url = f"https://{self._config.blob_account_name}.blob.core.windows.net"
                self._blob_client = BlobServiceClient(account_url, credential=credential)
                self._account_name = self._config.blob_account_name
                self._credential = credential
            elif self._config.blob_connection_string and not self._config.use_managed_identity:
                self._blob_client = BlobServiceClient.from_connection_string(
                    self._config.blob_connection_string
                )
            elif self._config.blob_connection_string and credential:
                # Extract account URL from connection string, auth via credential
                account_name = _extract_account_name(self._config.blob_connection_string)
                if account_name:
                    account_url = f"https://{account_name}.blob.core.windows.net"
                    self._blob_client = BlobServiceClient(account_url, credential=credential)
                    self._account_name = account_name
                    self._credential = credential

            if self._blob_client:
                container_client = self._blob_client.get_container_client(
                    self._config.blob_container
                )
                if not container_client.exists():
                    container_client.create_container()
                logger.info("Blob Storage initialised (container=%s)", self._config.blob_container)
        except Exception as e:
            logger.warning("Blob Storage init failed (non-blocking): %s", e)
            self._blob_client = None

    def _init_cosmos(self, credential: DefaultAzureCredential | None) -> None:
        if not self._config.cosmos_endpoint:
            return
        try:
            if self._config.cosmos_key:
                client = CosmosClient(self._config.cosmos_endpoint, self._config.cosmos_key)
            elif credential:
                client = CosmosClient(self._config.cosmos_endpoint, credential=credential)
            else:
                client = None

            if client and self._config.cosmos_key:
                # Key auth (local dev) may create resources on demand.
                self._cosmos_db = client.create_database_if_not_exists(self._config.cosmos_database)
                self._cosmos_container = self._cosmos_db.create_container_if_not_exists(
                    id=COSMOS_CONTAINER,
                    partition_key=PartitionKey(path="/id"),
                )
                self._progress_container = self._cosmos_db.create_container_if_not_exists(
                    id=COSMOS_PROGRESS_CONTAINER,
                    partition_key=PartitionKey(path="/user_id"),
                )
            elif client:
                # Entra ID data-plane roles cannot create databases/containers;
                # they are provisioned by infra (infra/modules/cosmos.bicep).
                self._cosmos_db = client.get_database_client(self._config.cosmos_database)
                self._cosmos_container = self._cosmos_db.get_container_client(COSMOS_CONTAINER)
                self._cosmos_container.read()
                try:
                    self._progress_container = self._cosmos_db.get_container_client(COSMOS_PROGRESS_CONTAINER)
                    self._progress_container.read()
                except Exception as pe:
                    logger.warning("Cosmos progress container unavailable: %s", pe)
                    self._progress_container = None
            if client:
                logger.info("Cosmos DB initialised (db=%s)", self._config.cosmos_database)
        except Exception as e:
            logger.warning("Cosmos DB init failed (non-blocking): %s", e)
            self._cosmos_container = None

    @property
    def available(self) -> bool:
        """True only when both Cosmos DB and Blob Storage are reachable (needed for uploads)."""
        return self._ensure_init() and self._blob_client is not None

    @property
    def cosmos_available(self) -> bool:
        """True when Cosmos DB is reachable (sufficient for read operations)."""
        self._ensure_init()
        return self._cosmos_container is not None

    # ------------------------------------------------------------------
    # Blob Storage — slide images
    # ------------------------------------------------------------------

    def upload_slide_image(self, presentation_id: str, slide_index: int, png_bytes: bytes) -> str | None:
        """Upload a slide PNG to blob storage. Returns the blob URL."""
        self._ensure_init()
        if not self._blob_client:
            return None
        blob_name = f"{presentation_id}/{slide_index}.png"
        try:
            blob_client = self._blob_client.get_blob_client(
                container=self._config.blob_container, blob=blob_name
            )
            blob_client.upload_blob(
                png_bytes,
                overwrite=True,
                content_settings=ContentSettings(content_type="image/png"),
            )
            return blob_client.url
        except Exception as e:
            logger.error("Failed to upload slide image %s: %s", blob_name, e)
            return None

    def upload_pptx(self, presentation_id: str, filename: str, pptx_bytes: bytes) -> str | None:
        """Upload the original PPTX file to blob storage. Returns the blob URL."""
        self._ensure_init()
        if not self._blob_client:
            return None
        blob_name = f"{presentation_id}/{filename}"
        try:
            blob_client = self._blob_client.get_blob_client(
                container=self._config.blob_container, blob=blob_name
            )
            blob_client.upload_blob(
                pptx_bytes,
                overwrite=True,
                content_settings=ContentSettings(
                    content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation"
                ),
            )
            return blob_client.url
        except Exception as e:
            logger.error("Failed to upload PPTX %s: %s", blob_name, e)
            return None

    def get_pptx_url(self, presentation_id: str, filename: str) -> str | None:
        """Get a SAS-signed blob URL for the original PPTX file (read-only, 24h expiry, admin only)."""
        self._ensure_init()
        if not self._blob_client:
            return None
        blob_name = f"{presentation_id}/{filename}"
        blob_client = self._blob_client.get_blob_client(
            container=self._config.blob_container, blob=blob_name
        )
        sas_token = self._generate_sas_token(blob_name)
        if sas_token:
            return f"{blob_client.url}?{sas_token}"
        return blob_client.url

    def get_slide_image_url(
        self, presentation_id: str, slide_index: int, expiry_minutes: int = DEFAULT_SAS_MINUTES,
    ) -> str | None:
        """Get a blob-scoped, read-only SAS URL for a slide image."""
        self._ensure_init()
        if not self._blob_client:
            return None
        blob_name = f"{presentation_id}/{int(slide_index)}.png"
        blob_client = self._blob_client.get_blob_client(
            container=self._config.blob_container, blob=blob_name
        )
        sas_token = self._generate_sas_token(blob_name, expiry_minutes)
        if sas_token:
            return f"{blob_client.url}?{sas_token}"
        return blob_client.url

    def _generate_sas_token(self, blob_name: str, expiry_minutes: int = DEFAULT_SAS_MINUTES) -> str | None:
        """Generate a blob-scoped read-only SAS token via User Delegation Key (managed identity)."""
        if not self._blob_client or not self._account_name or not self._credential:
            return None
        try:
            now = datetime.now(timezone.utc)
            start = now - timedelta(minutes=5)
            expiry = now + timedelta(minutes=expiry_minutes)
            udk = self._get_user_delegation_key(start, now + timedelta(hours=24))
            if not udk:
                return None
            return generate_blob_sas(
                account_name=self._account_name,
                container_name=self._config.blob_container,
                blob_name=blob_name,
                user_delegation_key=udk,
                permission=BlobSasPermissions(read=True),
                expiry=expiry,
                start=start,
            )
        except Exception as e:
            logger.warning("Failed to generate SAS token for %s: %s", blob_name, e)
            return None

    def _get_user_delegation_key(self, start: datetime, expiry: datetime):
        """Get or reuse a cached User Delegation Key."""
        now = datetime.now(timezone.utc)
        if (
            self._user_delegation_key
            and self._delegation_key_expiry
            and now < self._delegation_key_expiry - timedelta(hours=1)
        ):
            return self._user_delegation_key
        try:
            self._user_delegation_key = self._blob_client.get_user_delegation_key(
                key_start_time=start, key_expiry_time=expiry,
            )
            self._delegation_key_expiry = expiry
            return self._user_delegation_key
        except Exception as e:
            logger.warning("Failed to get user delegation key: %s", e)
            return None

    def download_slide_image(self, presentation_id: str, slide_index: int) -> bytes | None:
        """Download a slide PNG from blob storage."""
        self._ensure_init()
        if not self._blob_client:
            return None
        blob_name = f"{presentation_id}/{slide_index}.png"
        try:
            blob_client = self._blob_client.get_blob_client(
                container=self._config.blob_container, blob=blob_name
            )
            return blob_client.download_blob().readall()
        except Exception as e:
            logger.warning("Failed to download slide image %s: %s", blob_name, e)
            return None

    # ------------------------------------------------------------------
    # Cosmos DB — presentation metadata
    # ------------------------------------------------------------------

    def save_presentation(self, data: dict) -> bool:
        """Save presentation metadata to Cosmos DB. Uses filename as id."""
        self._ensure_init()
        if not self._cosmos_container:
            return False
        try:
            self._cosmos_container.upsert_item(data)
            logger.info("Saved presentation '%s' to Cosmos DB", data.get("id"))
            return True
        except Exception as e:
            logger.error("Failed to save presentation: %s", e)
            return False

    # --- Generic optimistic-concurrency doc access (used for durable demo quotas) ---

    def read_doc(self, doc_id: str) -> tuple[dict | None, str | None]:
        """Return ``(doc, etag)``; ``(None, None)`` when absent. Raises if Cosmos is unavailable."""
        self._ensure_init()
        if not self._cosmos_container:
            raise RuntimeError("Cosmos DB unavailable")
        try:
            doc = self._cosmos_container.read_item(item=doc_id, partition_key=doc_id)
            return doc, doc.get("_etag")
        except cosmos_exceptions.CosmosResourceNotFoundError:
            return None, None

    def write_doc(self, doc: dict, etag: str | None) -> bool:
        """Create (``etag=None``) or replace-if-unchanged. ``False`` on a concurrency conflict."""
        from azure.core import MatchConditions

        if not self._cosmos_container:
            raise RuntimeError("Cosmos DB unavailable")
        try:
            if etag is None:
                self._cosmos_container.create_item(body=doc)
            else:
                self._cosmos_container.replace_item(
                    item=doc["id"], body=doc, etag=etag, match_condition=MatchConditions.IfNotModified
                )
            return True
        except (cosmos_exceptions.CosmosResourceExistsError, cosmos_exceptions.CosmosAccessConditionFailedError):
            return False

    def get_presentation(self, presentation_id: str, strict: bool = False) -> dict | None:
        """Get presentation metadata by id (``None`` when it does not exist).

        ``strict=True`` raises :class:`StorageUnavailable` when Cosmos DB is configured but unreachable
        (container unavailable, or the read fails for any reason other than "not found") instead of
        answering ``None``. "Not found" and "Cosmos not configured" stay ``None`` in both modes.
        """
        self._ensure_init()
        if not self._cosmos_container:
            if strict and self._config.cosmos_endpoint:
                raise StorageUnavailable("Cosmos DB is configured but not available")
            return None
        try:
            return self._cosmos_container.read_item(
                item=presentation_id, partition_key=presentation_id
            )
        except cosmos_exceptions.CosmosResourceNotFoundError:
            return None
        except Exception as e:
            logger.error("Failed to get presentation %s: %s", presentation_id, e)
            if strict:
                raise StorageUnavailable("Cosmos DB read failed") from e
            return None

    def list_presentations(self) -> list[dict]:
        """List all presentations (id, filename, slide_count)."""
        self._ensure_init()
        if not self._cosmos_container:
            return []
        try:
            query = "SELECT c.id, c.filename, c.slide_count FROM c"
            return list(self._cosmos_container.query_items(
                query=query, enable_cross_partition_query=True
            ))
        except Exception as e:
            logger.error("Failed to list presentations: %s", e)
            return []

    def list_decks(self, strict: bool = False) -> list[dict]:
        """List catalog decks (source='deck') with metadata.

        ``strict=True`` raises :class:`StorageUnavailable` when Cosmos DB is configured but the container is
        unavailable or the query fails, instead of answering ``[]``; ``[]`` is then only ever "no decks" (or
        "Cosmos DB not configured"). ``strict=False`` keeps the lenient behaviour: every failure reads ``[]``.
        """
        self._ensure_init()
        if not self._cosmos_container:
            if strict and self._config.cosmos_endpoint:
                raise StorageUnavailable("Cosmos DB is configured but not available")
            return []
        try:
            query = (
                "SELECT c.id, c.filename, c.title, c.slide_count, c.language, "
                "c.uploaded_at, c.tags, c.source, c.published, c.live_demo, c.audience_level "
                "FROM c WHERE c.source = 'deck'"
            )
            return list(self._cosmos_container.query_items(
                query=query, enable_cross_partition_query=True
            ))
        except Exception as e:
            logger.error("Failed to list decks: %s", e)
            if strict:
                raise StorageUnavailable("Cosmos DB query failed") from e
            return []

    def delete_presentation(self, presentation_id: str) -> bool:
        """Delete a presentation from Cosmos DB."""
        self._ensure_init()
        if not self._cosmos_container:
            return False
        try:
            self._cosmos_container.delete_item(
                item=presentation_id, partition_key=presentation_id
            )
            return True
        except cosmos_exceptions.CosmosResourceNotFoundError:
            return False
        except Exception as e:
            logger.error("Failed to delete presentation %s: %s", presentation_id, e)
            return False

    def set_deck_published(self, deck_id: str, published: bool) -> dict | None:
        """Set the ``published`` flag on a catalog deck. Returns the updated doc.

        Unpublishing also clears ``live_demo`` (a demo deck must be public).
        """
        doc = self.get_presentation(deck_id)
        if not doc or doc.get("source") != "deck":
            return None
        doc["published"] = bool(published)
        if not published:
            doc["live_demo"] = False
        if not self.save_presentation(doc):
            return None
        return doc

    def set_deck_live_demo(self, deck_id: str, enabled: bool) -> dict | None:
        """Set the ``live_demo`` flag on a catalog deck. Returns the updated doc.

        Raises ``ValueError`` when enabling it on an unpublished deck.
        """
        doc = self.get_presentation(deck_id)
        if not doc or doc.get("source") != "deck":
            return None
        if enabled and doc.get("published") is not True:
            raise ValueError("Deck must be published before enabling the live demo")
        doc["live_demo"] = bool(enabled)
        if not self.save_presentation(doc):
            return None
        return doc

    def set_deck_title(self, deck_id: str, title: str) -> dict | None:
        """Set the display ``title`` of a catalog deck. Returns the updated doc."""
        title = (title or "").strip()
        if not title:
            raise ValueError("Deck title must not be empty")
        doc = self.get_presentation(deck_id)
        if not doc or doc.get("source") != "deck":
            return None
        doc["title"] = title
        if not self.save_presentation(doc):
            return None
        return doc

    def delete_slide_images(self, presentation_id: str) -> bool:
        """Delete all slide image blobs for a presentation (validated ``{uuid}/`` prefix)."""
        if not isinstance(presentation_id, str) or not _PRESENTATION_ID_RE.fullmatch(presentation_id):
            logger.warning("Refusing blob delete for invalid presentation id")
            return False
        self._ensure_init()
        if not self._blob_client:
            return False
        try:
            container_client = self._blob_client.get_container_client(
                self._config.blob_container
            )
            prefix = f"{presentation_id}/"
            blobs = container_client.list_blobs(name_starts_with=prefix)
            for blob in blobs:
                container_client.delete_blob(blob.name)
            logger.info("Deleted blob images for presentation %s", presentation_id)
            return True
        except Exception as e:
            logger.error("Failed to delete slide images for %s: %s", presentation_id, e)
            return False

    # ------------------------------------------------------------------
    # Playlists (stored in `presentations` container, /id partition)
    # ------------------------------------------------------------------

    def list_playlists(self) -> list[dict]:
        self._ensure_init()
        if not self._cosmos_container:
            return []
        try:
            q = (
                "SELECT c.id, c.title, c.description, c.status, c.steps, "
                "c.created_at, c.updated_at FROM c WHERE c.source = 'playlist'"
            )
            return list(self._cosmos_container.query_items(query=q, enable_cross_partition_query=True))
        except Exception as e:
            logger.error("Failed to list playlists: %s", e)
            return []

    def get_playlist(self, playlist_id: str) -> dict | None:
        self._ensure_init()
        if not self._cosmos_container:
            return None
        try:
            doc = self._cosmos_container.read_item(item=playlist_id, partition_key=playlist_id)
            if doc.get("source") != "playlist":
                return None
            return doc
        except cosmos_exceptions.CosmosResourceNotFoundError:
            return None
        except Exception as e:
            logger.error("Failed to read playlist %s: %s", playlist_id, e)
            return None

    def save_playlist(self, doc: dict) -> bool:
        self._ensure_init()
        if not self._cosmos_container:
            return False
        try:
            self._cosmos_container.upsert_item(doc)
            return True
        except Exception as e:
            logger.error("Failed to save playlist: %s", e)
            return False

    def delete_playlist(self, playlist_id: str) -> bool:
        self._ensure_init()
        if not self._cosmos_container:
            return False
        try:
            self._cosmos_container.delete_item(item=playlist_id, partition_key=playlist_id)
            return True
        except cosmos_exceptions.CosmosResourceNotFoundError:
            return False
        except Exception as e:
            logger.error("Failed to delete playlist %s: %s", playlist_id, e)
            return False

    def playlists_referencing_deck(self, deck_id: str) -> list[dict]:
        """Return all playlists whose steps include the given deck_id."""
        self._ensure_init()
        if not self._cosmos_container:
            return []
        try:
            q = (
                "SELECT * FROM c "
                "WHERE c.source = 'playlist' AND "
                "EXISTS(SELECT VALUE s FROM s IN c.steps WHERE s.deck_id = @deck_id)"
            )
            params = [{"name": "@deck_id", "value": deck_id}]
            return list(self._cosmos_container.query_items(
                query=q, parameters=params, enable_cross_partition_query=True,
            ))
        except Exception as e:
            logger.error("Failed to find playlists for deck %s: %s", deck_id, e)
            return []

    # ------------------------------------------------------------------
    # Playlist progress per user (`playlist_progress` container, /user_id partition)
    # ------------------------------------------------------------------

    def get_progress(self, user_id: str, playlist_id: str) -> dict | None:
        self._ensure_init()
        if not self._progress_container:
            return None
        doc_id = f"{user_id}:{playlist_id}"
        try:
            return self._progress_container.read_item(item=doc_id, partition_key=user_id)
        except cosmos_exceptions.CosmosResourceNotFoundError:
            return None
        except Exception as e:
            logger.error("Failed to read progress %s: %s", doc_id, e)
            return None

    def upsert_progress(self, doc: dict) -> dict | None:
        self._ensure_init()
        if not self._progress_container:
            return None
        try:
            return self._progress_container.upsert_item(doc)
        except Exception as e:
            logger.error("Failed to upsert progress: %s", e)
            return None


def _extract_account_name(connection_string: str) -> str | None:
    """Extract AccountName from an Azure Storage connection string."""
    for part in connection_string.split(";"):
        if part.strip().lower().startswith("accountname="):
            return part.strip().split("=", 1)[1]
    return None
