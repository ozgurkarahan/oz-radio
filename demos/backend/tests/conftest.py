"""Shared pytest setup for the backend tests.

Tests run fully offline: Azure endpoints loaded from a developer `.env` are
blanked so no Cosmos / Blob / Search / OpenAI client can be constructed, and
every test starts in AUTH_MODE=disabled unless it opts into easyauth.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
TESTS_DIR = Path(__file__).resolve().parent
for _p in (BACKEND_DIR, TESTS_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import config  # noqa: E402  (loads .env once; we override below)

_OFFLINE_ENV = {
    "AZURE_USE_MANAGED_IDENTITY": "false",
    "AZURE_COSMOS_ENDPOINT": "",
    "AZURE_COSMOS_KEY": "",
    "AZURE_BLOB_CONNECTION_STRING": "",
    "AZURE_BLOB_ACCOUNT_NAME": "",
    "AZURE_SEARCH_ENDPOINT": "",
    "AZURE_SEARCH_KEY": "",
    "AZURE_OPENAI_ENDPOINT": "",
    "AZURE_OPENAI_KEY": "",
    "AZURE_SPEECH_ENDPOINT": "",
    "AZURE_SPEECH_KEY": "",
    "AUTH_MODE": "disabled",
    # Azure Container Apps sets these on every replica and auth_mode() refuses AUTH_MODE=disabled
    # when either is set: empty = unset, so a developer shell can never flip the tests.
    "CONTAINER_APP_NAME": "",
    "CONTAINER_APP_REVISION": "",
    "AUTH_TENANT_ID": "",
    "ALLOWED_OBJECT_IDS": "",
    "ALLOWED_ORIGINS": "",
    "ENABLE_URL_INGEST": "false",
    "CUSTOM_AVATARS_JSON": "",
    "PUBLIC_DEMO_ENABLED": "false",
    "DEMO_MAX_CONCURRENT": "1",
    "DEMO_SESSION_SECONDS": "180",
    "DEMO_DAILY_SESSIONS": "20",
    "DEMO_DAILY_SESSIONS_PER_IP": "3",
    "DEMO_DAILY_MINUTES": "60",
    "DEMO_MAX_SPEAKS": "",
    "DEMO_QA_ENABLED": "false",
    "DEMO_QA_MAX_QUESTIONS": "2",
    "DEMO_QA_SESSION_SECONDS": "300",
    "DEMO_QA_DAILY_MAX": "40",
    "DEMO_QA_DAILY_PER_IP": "6",
    # A developer .env (loaded with override=True) must not hide stock avatars in tests.
    "HIDE_STOCK_AVATARS": "",
    # Podcast radio + live listener: private audio, no backchannels, no listener
    # synthesis (plain still), small budgets.
    "PODCAST_PUBLIC_AUDIO": "false",
    "PODCAST_REACTIONS": "false",
    "PODCAST_LISTENER_MODE": "still",
    "PODCAST_LISTENER_TIMEOUT_SEC": "60",
    "MAX_CONCURRENT_COMPOSES": "1",
    "MAX_ACTIVE_BATCH_JOBS": "4",
    # Cookieless telemetry ships dark: off and no connection string (a developer .env must not switch it on).
    "TELEMETRY_ENABLED": "false",
    "TELEMETRY_CONNECTION_STRING": "",
}
os.environ.update(_OFFLINE_ENV)

from _helpers import ADMIN_OID, TENANT, principal_headers  # noqa: E402


def pytest_configure(config):  # noqa: D401
    config.addinivalue_line("markers", "slow: slow tests requiring ffmpeg")


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    for k, v in _OFFLINE_ENV.items():
        monkeypatch.setenv(k, v)
    from security import DAILY_QUOTA, DEMO_QUOTA, DEMO_SESSIONS, PENDING_RENDERS, VOICE_SESSIONS
    from services import avatar_registry

    DAILY_QUOTA.reset()
    PENDING_RENDERS.reset()
    VOICE_SESSIONS.reset()
    DEMO_SESSIONS.reset()
    DEMO_QUOTA.reset()
    avatar_registry.reload("")
    yield
    DAILY_QUOTA.reset()
    PENDING_RENDERS.reset()
    VOICE_SESSIONS.reset()
    DEMO_SESSIONS.reset()
    DEMO_QUOTA.reset()
    avatar_registry.reload("")


@pytest.fixture
def easyauth(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "easyauth")
    monkeypatch.setenv("AUTH_TENANT_ID", TENANT)
    monkeypatch.setenv("ALLOWED_OBJECT_IDS", f"{ADMIN_OID}, 12345678-0000-0000-0000-000000000000")
    return principal_headers


@pytest.fixture
def app_module():
    import app as app_mod

    return app_mod


@pytest.fixture
def client(app_module):
    from fastapi.testclient import TestClient

    # No context manager: the lifespan (which builds real Azure clients) is skipped.
    return TestClient(app_module.app)
