"""Authentication / authorization for the Oz Radio backend.

Hybrid exposure model:
- ``AUTH_MODE=easyauth`` (default): trust the Azure Container Apps Easy Auth
  headers (``X-MS-CLIENT-PRINCIPAL`` + ``X-MS-CLIENT-PRINCIPAL-IDP``). ACA strips
  client-supplied copies of these headers, so they are only trusted in this mode.
  A caller is *admin* when the principal's tenant equals ``AUTH_TENANT_ID`` and
  its object id is listed in ``ALLOWED_OBJECT_IDS``.
- ``AUTH_MODE=disabled``: local development only — every caller is admin. It is never
  honoured on Azure Container Apps (``CONTAINER_APP_NAME`` or ``CONTAINER_APP_REVISION``
  set, which the platform does on every replica): ``easyauth`` is enforced there and a
  CRITICAL line is logged once per process. There is no override.

Settings are read from the environment on every call so that tests (and a
config reload) never see stale values.
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import threading
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from fastapi import APIRouter, HTTPException, Request
from starlette.requests import HTTPConnection

log = logging.getLogger(__name__)

PRINCIPAL_HEADER = "x-ms-client-principal"
IDP_HEADER = "x-ms-client-principal-idp"

_OID_CLAIMS = ("http://schemas.microsoft.com/identity/claims/objectidentifier", "oid")
_TID_CLAIMS = ("http://schemas.microsoft.com/identity/claims/tenantid", "tid")
_NAME_CLAIMS = (
    "name",
    "preferred_username",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
)

LOCAL_DEV_USER = "local-dev"


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
# Azure Container Apps sets both on every replica; either one means "running on Azure".
_CONTAINER_APPS_MARKERS = ("CONTAINER_APP_NAME", "CONTAINER_APP_REVISION")

_refusal_lock = threading.Lock()
_refusal_logged = False


def _on_container_apps() -> bool:
    return any(os.environ.get(name) for name in _CONTAINER_APPS_MARKERS)


def _log_disabled_refused_once() -> None:
    global _refusal_logged
    if _refusal_logged:
        return
    with _refusal_lock:
        if _refusal_logged:
            return
        _refusal_logged = True
    log.critical(
        "AUTH_MODE=disabled was refused: this process runs on Azure Container Apps "
        "(CONTAINER_APP_NAME / CONTAINER_APP_REVISION is set), where it would make every "
        "caller an admin. The backend keeps trusting only Easy Auth principals. Remove "
        "AUTH_MODE=disabled from the app's environment; to test production as an admin use "
        "Entra bearer tokens (AUTH_EXTRA_CLIENT_APPS)."
    )


def auth_mode() -> str:
    """Effective auth mode: ``easyauth`` or ``disabled``.

    ``disabled`` (every caller is admin) is for local development only. On Azure
    Container Apps it is refused: ``easyauth`` is returned whatever ``AUTH_MODE`` says
    and a CRITICAL line is logged once. There is deliberately no flag to override this.
    """
    requested = (os.environ.get("AUTH_MODE") or "easyauth").strip().lower()
    if requested != "disabled":
        return "easyauth"
    if _on_container_apps():
        _log_disabled_refused_once()
        return "easyauth"
    return "disabled"


def tenant_id() -> str:
    return (os.environ.get("AUTH_TENANT_ID") or "").strip().lower()


def allowed_object_ids() -> frozenset[str]:
    raw = os.environ.get("ALLOWED_OBJECT_IDS") or ""
    return frozenset(p.strip().lower() for p in raw.split(",") if p.strip())


def log_startup_warnings() -> None:
    """Emit loud warnings for insecure / incomplete auth configuration."""
    if auth_mode() == "disabled":
        # Never reached on Azure Container Apps: auth_mode() refuses "disabled" there.
        log.warning(
            "AUTH_MODE=disabled — every caller is treated as admin. "
            "Use this for local development only."
        )
        return
    if not tenant_id():
        log.error("Easy Auth is enforced but AUTH_TENANT_ID is not set — nobody can be admin.")
    if not allowed_object_ids():
        log.warning("ALLOWED_OBJECT_IDS is empty — nobody is admin; only anonymous routes work.")


# ---------------------------------------------------------------------------
# Principal
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Principal:
    authenticated: bool
    is_admin: bool
    oid: Optional[str] = None
    tid: Optional[str] = None
    name: Optional[str] = None

    @property
    def user_id(self) -> str:
        """Stable server-derived identifier (never taken from request input)."""
        if auth_mode() == "disabled":
            return LOCAL_DEV_USER
        return self.oid or "anonymous"


ANONYMOUS = Principal(authenticated=False, is_admin=False)


def _claim(claims: list[Any], types: tuple[str, ...]) -> Optional[str]:
    for wanted in types:
        for c in claims:
            if isinstance(c, dict) and c.get("typ") == wanted:
                val = c.get("val")
                if isinstance(val, str) and val.strip():
                    return val.strip()
    return None


def _decode_principal(raw: str) -> Optional[dict]:
    try:
        padded = raw.strip() + "=" * (-len(raw.strip()) % 4)
        data = base64.b64decode(padded, validate=False)
        obj = json.loads(data.decode("utf-8"))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    return obj if isinstance(obj, dict) else None


def principal_from_headers(headers: Mapping[str, str]) -> Principal:
    """Build a Principal from request/websocket headers."""
    if auth_mode() == "disabled":
        return Principal(authenticated=True, is_admin=True, oid=LOCAL_DEV_USER, name=LOCAL_DEV_USER)

    raw = headers.get(PRINCIPAL_HEADER)
    idp = (headers.get(IDP_HEADER) or "").strip().lower()
    if not raw or idp != "aad":
        return ANONYMOUS
    obj = _decode_principal(raw)
    if not obj:
        return ANONYMOUS
    claims = obj.get("claims") or []
    if not isinstance(claims, list):
        return ANONYMOUS
    oid = _claim(claims, _OID_CLAIMS)
    if not oid:
        return ANONYMOUS
    tid = _claim(claims, _TID_CLAIMS)
    name = _claim(claims, _NAME_CLAIMS)

    expected_tid = tenant_id()
    is_admin = bool(
        expected_tid
        and tid
        and tid.lower() == expected_tid
        and oid.lower() in allowed_object_ids()
    )
    return Principal(
        authenticated=True,
        is_admin=is_admin,
        oid=oid.lower(),
        tid=tid.lower() if tid else None,
        name=name,
    )


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------
def get_principal(conn: HTTPConnection) -> Principal:
    """Dependency: the caller's principal (anonymous allowed)."""
    return principal_from_headers(conn.headers)


def require_admin(conn: HTTPConnection) -> Principal:
    """Dependency: 401 when anonymous, 403 when signed-in but not allowlisted."""
    principal = principal_from_headers(conn.headers)
    if not principal.authenticated:
        raise HTTPException(status_code=401, detail="Sign-in required")
    if not principal.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized")
    return principal


# ---------------------------------------------------------------------------
# /api/me
# ---------------------------------------------------------------------------
router = APIRouter(tags=["auth"])


@router.get("/api/me")
def me(request: Request) -> dict:
    p = get_principal(request)
    return {
        "authenticated": p.authenticated,
        "is_admin": p.is_admin,
        "name": p.name if p.authenticated else None,
        "auth_mode": auth_mode(),
    }
