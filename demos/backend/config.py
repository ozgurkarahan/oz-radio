import logging
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

from services import demo_protocol as dp

logger = logging.getLogger(__name__)

# Load .env from backend directory, then project root
_backend_dir = Path(__file__).resolve().parent
load_dotenv(_backend_dir / ".env", override=True)
load_dotenv(_backend_dir.parent.parent / ".env")


@dataclass
class AzureConfig:
    speech_endpoint: str
    speech_key: str
    speech_region: str
    speech_resource_id: str
    openai_endpoint: str
    openai_key: str
    openai_chat_deployment: str
    openai_embedding_deployment: str
    libreoffice_path: str = "soffice"
    use_managed_identity: bool = False
    use_local_search: bool = True
    cosmos_endpoint: str = ""
    cosmos_key: str = ""
    cosmos_database: str = "ai-presenter"
    blob_connection_string: str = ""
    blob_account_name: str = ""
    blob_container: str = "slide-images"
    search_endpoint: str = ""
    # Optional; when empty the AI Search client uses DefaultAzureCredential.
    search_key: str = ""
    search_index: str = "decks"


def load_config() -> AzureConfig:
    """Load configuration from environment variables (.env supported)."""
    return AzureConfig(
        speech_endpoint=os.environ.get("AZURE_SPEECH_ENDPOINT", ""),
        speech_key=os.environ.get("AZURE_SPEECH_KEY", ""),
        speech_region=os.environ.get("AZURE_SPEECH_REGION", "swedencentral"),
        speech_resource_id=os.environ.get("AZURE_SPEECH_RESOURCE_ID", ""),
        openai_endpoint=os.environ.get("AZURE_OPENAI_ENDPOINT", ""),
        openai_key=os.environ.get("AZURE_OPENAI_KEY", ""),
        openai_chat_deployment=os.environ.get("AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-4.1"),
        openai_embedding_deployment=os.environ.get(
            "AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-3-small"
        ),
        libreoffice_path=os.environ.get("LIBREOFFICE_PATH", "soffice"),
        use_managed_identity=os.environ.get("AZURE_USE_MANAGED_IDENTITY", "").lower() == "true",
        use_local_search=os.environ.get("USE_LOCAL_SEARCH", "true").lower() == "true",
        cosmos_endpoint=os.environ.get("AZURE_COSMOS_ENDPOINT", ""),
        cosmos_key=os.environ.get("AZURE_COSMOS_KEY", ""),
        cosmos_database=os.environ.get("AZURE_COSMOS_DATABASE", "ai-presenter"),
        blob_connection_string=os.environ.get("AZURE_BLOB_CONNECTION_STRING", ""),
        blob_account_name=os.environ.get("AZURE_BLOB_ACCOUNT_NAME", ""),
        blob_container=os.environ.get("AZURE_BLOB_CONTAINER", "slide-images"),
        search_endpoint=os.environ.get("AZURE_SEARCH_ENDPOINT", ""),
        search_key=os.environ.get("AZURE_SEARCH_KEY", ""),
        search_index=os.environ.get("AZURE_SEARCH_INDEX", "decks"),
    )


# ---------------------------------------------------------------------------
# Cookieless telemetry (ships dark)
# ---------------------------------------------------------------------------
# Two settings, read on every page request so the kill switch is immediate:
#   TELEMETRY_ENABLED            1 / true / yes / on turns it on; unset or anything else = off (the default)
#   TELEMETRY_CONNECTION_STRING  an Application Insights connection string; unset = empty (the default). It is public by
#                                design: the instrumentation key only says where events go, it grants nothing.
# Telemetry is on only when the flag is true AND the connection string gives an https ingestion endpoint and a GUID key.
# The result goes into the boot block of index.html (`telemetry_boot`); the browser still sends nothing to visitors who
# signal Global Privacy Control, Do Not Track or the opt-out key. The infra default of both settings equals the code default.
TELEMETRY_TRUTHY = frozenset({"1", "true", "yes", "on"})
# Application Insights allows up to 4,096 characters in a connection string.
TELEMETRY_CONNECTION_STRING_MAX_CHARS = 4096
_TELEMETRY_IKEY_RE = re.compile(dp.BOOT_TELEMETRY_IKEY_PATTERN, re.IGNORECASE)
_TELEMETRY_INGESTION_RE = re.compile(dp.BOOT_TELEMETRY_INGESTION_PATTERN)
_TELEMETRY_ENDPOINT_RE = re.compile(r"(https://[^/?#\s]+)/?", re.IGNORECASE)

# When this process started (the module is imported at startup): `server_cold` says a page was served in the first minute.
PROCESS_STARTED = time.monotonic()
_telemetry_misconfig_logged = False


def telemetry_enabled() -> bool:
    """The TELEMETRY_ENABLED flag (default off)."""
    return (os.environ.get("TELEMETRY_ENABLED") or "").strip().lower() in TELEMETRY_TRUTHY


def parse_telemetry_connection_string(raw: Optional[str]) -> Optional[tuple[str, str]]:
    """``(ingestion origin, instrumentation key)`` of an Application Insights connection string, or ``None`` when it is
    not usable (fail closed).

    Only ``InstrumentationKey`` (a GUID) and ``IngestionEndpoint`` (``https://`` and a DNS name, an optional trailing
    ``/`` and nothing else: no credentials, port, path, query or fragment) are read; other settings (``LiveEndpoint``,
    ``ApplicationId`` ...) are ignored. Names are case-insensitive. A malformed or repeated setting makes the whole string
    unusable. The origin is returned lower-case without the trailing slash, the key lower-case. Never raises.
    """
    try:
        text = (raw or "").strip()
        if not text or len(text) > TELEMETRY_CONNECTION_STRING_MAX_CHARS:
            return None
        settings: dict[str, str] = {}
        for part in text.split(";"):
            part = part.strip()
            if not part:
                continue
            name, separator, value = part.partition("=")
            name = name.strip().lower()
            if not separator or not name or name in settings:
                return None
            settings[name] = value.strip()
        ikey = settings.get("instrumentationkey", "")
        endpoint = _TELEMETRY_ENDPOINT_RE.fullmatch(settings.get("ingestionendpoint", ""))
        if not endpoint or not _TELEMETRY_IKEY_RE.fullmatch(ikey):
            return None
        origin = endpoint.group(1).lower()
        if not _TELEMETRY_INGESTION_RE.fullmatch(origin):
            return None
        return origin, ikey.lower()
    except Exception:
        return None


def telemetry_boot() -> dict:
    """The ``telemetry`` section of the boot block.

    Off (the default, and any doubt) is exactly ``{"enabled": False}``. On it is ``{"enabled": True, "ingestion": …,
    "ikey": …, "server_cold": …}`` with the values validated by :func:`parse_telemetry_connection_string`. Never raises:
    a telemetry problem must not turn the whole boot block into the fail-closed one.
    """
    global _telemetry_misconfig_logged
    try:
        if not telemetry_enabled():
            return {"enabled": False}
        parsed = parse_telemetry_connection_string(os.environ.get("TELEMETRY_CONNECTION_STRING"))
        if parsed is None:
            if not _telemetry_misconfig_logged:
                _telemetry_misconfig_logged = True
                logger.warning("TELEMETRY_ENABLED is true but TELEMETRY_CONNECTION_STRING is missing or invalid: telemetry stays off")
            return {"enabled": False}
        ingestion, ikey = parsed
        cold = time.monotonic() - PROCESS_STARTED < dp.BOOT_TELEMETRY_SERVER_COLD_SECONDS
        return {"enabled": True, "ingestion": ingestion, "ikey": ikey, "server_cold": cold}
    except Exception:
        return {"enabled": False}
