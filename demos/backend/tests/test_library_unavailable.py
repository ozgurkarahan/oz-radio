"""Empty versus failed (contracts v1.2 §2.4): a list that cannot be read is a 503, never an empty list.

Before this change the public lists answered ``[]`` whenever storage failed (``decks.py`` and ``podcast.py`` swallowed
the exception), so Home read like an empty site and the library pages printed raw transport errors above "No
published … yet". Now:

* nothing published -> ``200 []``; storage not configured at all (local dev, ``_OFFLINE_ENV``) -> ``200 []``;
* storage configured but failing (init failure, listing or read error, Cosmos error) -> ``503
  {"detail": "Library temporarily unavailable"}`` + ``Cache-Control: no-store``;
* a missing or unpublished item -> ``404``; a storage error on a detail is a 503, never a 404;
* a start-up failure is not sticky: the connection is retried at most every 30 s.

Failure-matrix rows proven here: T1-04, T1-05, T1-06, T1-07a, T1-07b, T2-01, T2-09, T2-10, T2-11, T2-13 (the
test name carries the row id). No Azure: the SDK clients are replaced by fakes whose behaviour a test flips.
"""
from __future__ import annotations

import json
import threading
import time
from types import SimpleNamespace

import pytest
from azure.core.exceptions import HttpResponseError, ResourceNotFoundError, ServiceRequestError
from azure.cosmos import exceptions as cosmos_exceptions

from services import demo_protocol as dp
from services import podcast_library as pl
from services import storage as st
from services import video_library as vl
from services.podcast_models import LibraryUnavailable

UNAVAILABLE = {"detail": dp.LIBRARY_UNAVAILABLE_DETAIL}
POD_JOB, VID_JOB = "job-0000aaaa", "sv-0000aaaa"
DECK_ID = "2d7f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"
HIDDEN_DECK_ID = "3e8f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


# ---------------------------------------------------------------------------
# A fake Blob Storage the libraries really connect to (so init, retries and reads are the real code)
# ---------------------------------------------------------------------------
class BlobWorld:
    """What the fake Azure answers; mutate it between calls."""

    def __init__(self) -> None:
        self.up = True                     # False: the container probe at init raises
        self.construct_fails = False       # True: the client constructor raises
        self.store: dict[str, bytes] = {}
        self.list_error: Exception | None = None
        self.read_error: Exception | None = None
        self.clients = 0
        self.list_calls = 0
        self.construct_delay = 0.0
        self._lock = threading.Lock()

    def put(self, name: str, manifest: dict) -> None:
        self.store[name] = json.dumps(manifest).encode("utf-8")


@pytest.fixture
def azure(monkeypatch) -> BlobWorld:
    w = BlobWorld()

    class Stream:
        def __init__(self, data: bytes):
            self.size = len(data)
            self._data = data

        def readall(self) -> bytes:
            return self._data

    class BlobClient:
        def __init__(self, name: str):
            self.name = name
            self.url = f"https://acct.blob.core.windows.net/media/{name}"

        def download_blob(self):
            if w.read_error is not None:
                raise w.read_error
            if self.name not in w.store:
                raise ResourceNotFoundError("The specified blob does not exist.")
            return Stream(w.store[self.name])

    class Container:
        def exists(self) -> bool:
            if not w.up:
                raise ServiceRequestError("storage unreachable")
            return True

        def create_container(self) -> None:  # pragma: no cover - exists() is always True
            pass

        def list_blobs(self, name_starts_with: str = ""):
            w.list_calls += 1
            if w.list_error is not None:
                raise w.list_error
            return [SimpleNamespace(name=n) for n in sorted(w.store) if n.startswith(name_starts_with)]

    class Client:
        def __init__(self, url, credential=None, **_kwargs):
            with w._lock:
                w.clients += 1
            if w.construct_delay:
                time.sleep(w.construct_delay)
            if w.construct_fails:
                raise RuntimeError("cannot build a blob client")

        @classmethod
        def from_connection_string(cls, conn_str, **_kwargs):
            return cls(conn_str)

        def get_container_client(self, _name):
            return Container()

        def get_blob_client(self, container, blob):
            return BlobClient(blob)

    for module in (pl, vl):
        monkeypatch.setattr(module, "BlobServiceClient", Client)
        monkeypatch.setattr(module, "DefaultAzureCredential", lambda: object())
    return w


def blob_cfg(**overrides):
    cfg = dict(use_managed_identity=True, blob_account_name="acct", blob_connection_string="", blob_container="media")
    cfg.update(overrides)
    return SimpleNamespace(**cfg)


def podcast_manifest(job: str = POD_JOB, **overrides) -> dict:
    prefix = f"podcast-library/{job}"
    manifest = {"schema_version": 2, "job_id": job, "title": "Episode", "created_at": "2026-10-17T10:00:00+00:00",
                "format": "video", "language": "en-US", "video_blob": f"{prefix}/video.mp4", "published": True}
    manifest.update(overrides)
    return manifest


def video_manifest(job: str = VID_JOB, **overrides) -> dict:
    prefix = f"videos/{job}"
    manifest = {"schema_version": 1, "job_id": job, "title": "Clip", "created_at": "2026-10-17T10:00:00+00:00",
                "language": "en-US", "video_blob": f"{prefix}/video.mp4", "published": True}
    manifest.update(overrides)
    return manifest


class Kind:
    """One library flavour: how to build it, seed it and reach its routes."""

    def __init__(self, name: str):
        self.name = name
        self.job = POD_JOB if name == "podcast" else VID_JOB
        self.prefix = "podcast-library" if name == "podcast" else "videos"
        self.manifest = podcast_manifest if name == "podcast" else video_manifest
        self.module = pl if name == "podcast" else vl
        self.cls = pl.PodcastLibrary if name == "podcast" else vl.VideoLibrary

    def library(self, clock: Clock | None = None, cfg=None):
        lib = self.cls(cfg or blob_cfg(), clock=clock or Clock())
        lib._sas = lambda blob, lifetime=0: f"https://sas.example/{blob}" if blob else None  # type: ignore
        return lib

    def seed(self, world: BlobWorld, job: str | None = None, **overrides) -> str:
        job = job or self.job
        world.put(f"{self.prefix}/{job}/manifest.json", self.manifest(job, **overrides))
        return job

    def route(self, job: str | None = None) -> str:
        return f"/api/{self.name}/library" + (f"/{job}" if job else "")

    def patch_router(self, monkeypatch, lib) -> None:
        import routers.podcast as pc
        import routers.video as rv

        monkeypatch.setattr(pc if self.name == "podcast" else rv, "_get_library", lambda cfg: lib)


@pytest.fixture(params=["podcast", "video"])
def kind(request) -> Kind:
    return Kind(request.param)


# ---------------------------------------------------------------------------
# Library: init is not sticky
# ---------------------------------------------------------------------------
def test_retry_interval_is_the_stores_thirty_seconds():
    assert pl.INIT_RETRY_SECONDS == vl.INIT_RETRY_SECONDS == st.INIT_RETRY_SECONDS == 30


def test_a_failed_init_is_retried_at_most_once_per_cooldown_and_heals(kind, azure):
    clock = Clock()
    lib = kind.library(clock)
    azure.up = False
    for _ in range(5):
        assert lib.available is False
    assert azure.clients == 1                        # five reads, one connection attempt

    clock.advance(st.INIT_RETRY_SECONDS - 0.1)
    assert lib.available is False and azure.clients == 1   # not yet

    clock.advance(0.1)
    assert lib.available is False and azure.clients == 2   # due: one retry, still down
    clock.advance(st.INIT_RETRY_SECONDS - 1)
    assert lib.available is False and azure.clients == 2   # the cool-down restarted at the retry

    azure.up = True
    clock.advance(1)
    assert lib.available is True and azure.clients == 3    # healed
    clock.advance(100 * st.INIT_RETRY_SECONDS)
    assert lib.available is True and azure.clients == 3    # healthy: never rebuilt


def test_a_client_that_cannot_even_be_built_is_retried_too(kind, azure):
    clock = Clock()
    lib = kind.library(clock)
    azure.construct_fails = True
    assert lib.available is False and lib.available is False and azure.clients == 1
    azure.construct_fails = False
    clock.advance(st.INIT_RETRY_SECONDS)
    assert lib.available is True and azure.clients == 2


def test_storage_that_is_not_configured_is_never_retried_and_is_not_failing(kind, azure):
    clock = Clock()
    lib = kind.library(clock, blob_cfg(use_managed_identity=False, blob_account_name="", blob_connection_string=""))
    assert lib.configured is False and lib.available is False
    clock.advance(100 * st.INIT_RETRY_SECONDS)
    assert lib.available is False and azure.clients == 0
    assert lib.list(strict=True) == [] and lib.list(published_only=True, strict=True) == []
    assert lib.get(kind.job, strict=True) is None


@pytest.mark.parametrize("account,connection,configured", [
    ("", "", False), ("acct", "", True), ("", "AccountName=a;AccountKey=k", True), ("acct", "AccountName=a", True),
])
def test_configured_means_a_blob_account_or_a_connection_string(kind, azure, account, connection, configured):
    cfg = blob_cfg(blob_account_name=account, blob_connection_string=connection)
    assert kind.library(cfg=cfg).configured is configured


def test_a_library_wired_by_hand_never_consults_the_clock(kind, azure):
    """Tests (and callers) that set ``_initialised`` and ``_blob`` directly keep working: no retry, no connection."""
    clock = Clock()
    lib = kind.library(clock)
    lib._initialised, lib._blob = True, object()
    clock.advance(10_000)
    assert lib.available is True and azure.clients == 0
    lib._blob = None
    assert lib.available is False and azure.clients == 0  # no attempt was ever recorded: nothing to retry


def test_the_first_init_blocks_concurrent_callers_and_runs_once(kind, azure):
    azure.construct_delay = 0.15
    lib = kind.library()
    results: list[bool] = []
    gate = threading.Barrier(8)

    def worker() -> None:
        gate.wait()
        results.append(lib.available)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert results == [True] * 8                       # nobody saw a half-initialised library
    assert azure.clients == 1


def test_a_concurrent_retry_is_attempted_by_one_thread(kind, azure):
    clock = Clock()
    lib = kind.library(clock)
    azure.up = False
    assert lib.available is False and azure.clients == 1
    azure.up = True
    azure.construct_delay = 0.15
    clock.advance(st.INIT_RETRY_SECONDS)
    gate = threading.Barrier(8)

    def worker() -> None:
        gate.wait()
        lib.available

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert azure.clients == 2                          # exactly one retry for eight callers
    assert lib.available is True


# ---------------------------------------------------------------------------
# Library: strict reads tell failed from empty (lenient reads keep answering [] / None)
# ---------------------------------------------------------------------------
def test_strict_list_raises_when_a_configured_storage_did_not_connect_and_lenient_stays_empty(kind, azure):
    azure.up = False
    lib = kind.library()
    assert lib.list() == [] and lib.list(published_only=True) == []
    with pytest.raises(LibraryUnavailable):
        lib.list(strict=True)
    with pytest.raises(LibraryUnavailable):
        lib.list(published_only=True, strict=True)
    with pytest.raises(LibraryUnavailable):
        lib.get(kind.job, strict=True)
    with pytest.raises(LibraryUnavailable):
        lib.get(kind.job, public=True, strict=True)
    assert lib.get(kind.job) is None and lib.get(kind.job, public=True) is None


def test_strict_list_raises_when_the_listing_fails(kind, azure):
    kind.seed(azure)
    lib = kind.library()
    azure.list_error = HttpResponseError("503 Server Busy")
    assert lib.list() == [] and lib.list(published_only=True) == []
    with pytest.raises(LibraryUnavailable) as raised:
        lib.list(published_only=True, strict=True)
    assert isinstance(raised.value.__cause__, HttpResponseError)
    azure.list_error = None
    assert [i["job_id"] for i in lib.list(published_only=True, strict=True)] == [kind.job]  # nothing is sticky


def test_strict_list_raises_when_a_manifest_read_fails_and_lenient_skips_that_item(kind, azure):
    other = "job-0000bbbb" if kind.name == "podcast" else "sv-0000bbbb"
    kind.seed(azure)
    kind.seed(azure, other)
    lib = kind.library()
    azure.read_error = ServiceRequestError("connection reset")
    assert lib.list(published_only=True) == []                     # lenient: unreadable items are skipped
    with pytest.raises(LibraryUnavailable):
        lib.list(published_only=True, strict=True)
    with pytest.raises(LibraryUnavailable):
        lib.get(kind.job, public=True, strict=True)
    with pytest.raises(LibraryUnavailable):
        lib.get(kind.job, strict=True)
    assert lib.get(kind.job, public=True) is None                  # lenient: reads as "no such item"
    azure.read_error = None
    assert sorted(i["job_id"] for i in lib.list(published_only=True, strict=True)) == sorted([kind.job, other])


def test_empty_is_not_a_failure_even_in_strict_mode(kind, azure):
    lib = kind.library()
    assert lib.list(strict=True) == [] and lib.list(published_only=True, strict=True) == []
    kind.seed(azure, published=False)
    assert lib.list(published_only=True, strict=True) == []        # nothing published
    assert [i["job_id"] for i in lib.list(strict=True)] == [kind.job]  # the admin view still sees it


def test_a_missing_or_corrupt_manifest_is_not_a_storage_failure(kind, azure):
    other = "job-0000bbbb" if kind.name == "podcast" else "sv-0000bbbb"
    third = "job-0000cccc" if kind.name == "podcast" else "sv-0000cccc"
    kind.seed(azure)
    azure.store[f"{kind.prefix}/{other}/manifest.json"] = b"{not json"
    azure.store[f"{kind.prefix}/{third}/manifest.json"] = b'["a", "list"]'
    lib = kind.library()
    assert [i["job_id"] for i in lib.list(published_only=True, strict=True)] == [kind.job]
    assert lib.get(other, strict=True) is None and lib.get(third, strict=True) is None
    assert lib.get("job-0000dddd" if kind.name == "podcast" else "sv-0000dddd", strict=True) is None  # not found
    assert lib.get(kind.job, public=True, strict=True)["job_id"] == kind.job


def test_a_manifest_that_disappears_between_the_listing_and_the_read_is_skipped(kind, azure):
    kind.seed(azure)
    lib = kind.library()
    real_read = lib._read_json_blob

    def vanishing(name):
        azure.store.pop(name, None)       # deleted right after it was listed
        return real_read(name)

    lib._read_json_blob = vanishing  # type: ignore[assignment]
    assert lib.list(published_only=True, strict=True) == []


def test_unpublished_items_are_none_in_strict_mode_too(kind, azure):
    kind.seed(azure, published=False)
    lib = kind.library()
    assert lib.get(kind.job, public=True, strict=True) is None
    assert lib.get(kind.job, strict=True)["job_id"] == kind.job


# ---------------------------------------------------------------------------
# Routes: libraries
# ---------------------------------------------------------------------------
def _assert_unavailable(response) -> None:
    assert response.status_code == 503, response.text
    assert response.json() == UNAVAILABLE
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["cache-control"] == "no-store"


def test_t1_04_lists_503_when_storage_fails(client, easyauth, azure, kind, monkeypatch):
    kind.seed(azure)
    lib = kind.library()
    kind.patch_router(monkeypatch, lib)
    azure.list_error = HttpResponseError("503 Server Busy")
    _assert_unavailable(client.get(kind.route()))
    _assert_unavailable(client.get(kind.route(), headers=easyauth()))   # the admin view must not read as empty either

    azure.list_error = None
    azure.read_error = ServiceRequestError("connection reset")
    _assert_unavailable(client.get(kind.route()))

    azure.read_error = None
    assert [i["job_id"] for i in client.get(kind.route()).json()] == [kind.job]


def test_t1_04_a_configured_storage_that_never_connected_is_503_not_an_empty_site(client, easyauth, azure, kind,
                                                                                    monkeypatch):
    azure.up = False
    kind.patch_router(monkeypatch, kind.library())
    _assert_unavailable(client.get(kind.route()))
    _assert_unavailable(client.get(kind.route(), headers=easyauth()))


def test_t1_04_decks_list_503_when_a_deck_store_cannot_be_read(client, easyauth, monkeypatch):
    import routers.decks as decks

    class Failing:
        cosmos_available = True
        available = False

        def __init__(self, error: Exception):
            self.error = error

        def list_decks(self, strict=False):
            raise self.error

    for error in (st.StorageUnavailable("Cosmos DB query failed"), RuntimeError("unexpected")):
        monkeypatch.setattr(decks, "_store", lambda cfg, error=error: Failing(error))
        _assert_unavailable(client.get("/api/decks"))
        _assert_unavailable(client.get("/api/decks", headers=easyauth()))


def test_t1_06_a_failing_podcast_list_is_json_with_the_friendly_constant_never_a_bare_proxy_body(
        client, easyauth, azure, monkeypatch):
    kind = Kind("podcast")
    azure.read_error = ServiceRequestError("upstream connect error or disconnect/reset before headers")
    kind.seed(azure)
    kind.patch_router(monkeypatch, kind.library())
    r = client.get("/api/podcast/library")
    _assert_unavailable(r)
    assert "upstream" not in r.text and "reset" not in r.text  # the transport error never reaches the visitor


def test_t1_07a_empty_libraries_are_200_empty_only_when_nothing_is_published_or_storage_is_not_configured(
        client, easyauth, azure, kind, monkeypatch):
    lib = kind.library()
    kind.patch_router(monkeypatch, lib)
    for headers in ({}, easyauth()):
        r = client.get(kind.route(), headers=headers)
        assert r.status_code == 200 and r.json() == []                 # reachable and empty

    kind.seed(azure, published=False)
    assert client.get(kind.route()).json() == []                       # nothing published yet
    assert [i["job_id"] for i in client.get(kind.route(), headers=easyauth()).json()] == [kind.job]

    # Storage that is not configured at all (local dev, the offline test environment) is empty, not failing.
    unconfigured = kind.library(cfg=blob_cfg(use_managed_identity=False, blob_account_name=""))
    kind.patch_router(monkeypatch, unconfigured)
    for headers in ({}, easyauth()):
        r = client.get(kind.route(), headers=headers)
        assert r.status_code == 200 and r.json() == []
    assert azure.clients == 1 and azure.list_calls >= 1  # only the configured library ever touched storage


def test_the_offline_default_environment_still_answers_200_empty(client, easyauth, monkeypatch):
    """No library double: the real singletons over ``_OFFLINE_ENV`` (``test_auth.test_anonymous_routes_stay_open``)."""
    import routers.podcast as pc
    import routers.video as rv

    monkeypatch.setattr(pc, "_LIBRARY", None)
    monkeypatch.setattr(rv, "_LIBRARY", None)
    for path in ("/api/video/library", "/api/podcast/library", "/api/decks"):
        r = client.get(path)
        assert r.status_code == 200 and r.json() == [], path


def test_t2_01_a_stale_episode_link_is_404_but_a_storage_error_is_503(client, easyauth, azure, monkeypatch):
    kind = Kind("podcast")
    kind.seed(azure)
    kind.seed(azure, "job-0000bbbb", published=False)
    lib = kind.library()
    kind.patch_router(monkeypatch, lib)

    assert client.get(kind.route(kind.job)).status_code == 200
    for job in ("job-0000bbbb", "job-0000ffff"):                       # unpublished, never existed (or deleted)
        r = client.get(kind.route(job))
        assert r.status_code == 404 and r.json() == {"detail": "Library item not found"}, job

    azure.read_error = ServiceRequestError("connection reset")
    for job in (kind.job, "job-0000bbbb", "job-0000ffff"):
        _assert_unavailable(client.get(kind.route(job)))                # a storage error never reads as 404
    _assert_unavailable(client.get(kind.route(kind.job), headers=easyauth()))


def test_t2_01_the_episode_detail_503s_when_the_library_never_connected(client, azure, monkeypatch):
    kind = Kind("podcast")
    azure.up = False
    kind.patch_router(monkeypatch, kind.library())
    _assert_unavailable(client.get(kind.route(kind.job)))


def test_t2_09_a_video_that_cannot_be_opened_says_why(client, easyauth, azure, monkeypatch):
    kind = Kind("video")
    kind.seed(azure)
    kind.seed(azure, "sv-0000bbbb", published=False)
    kind.patch_router(monkeypatch, kind.library())

    assert client.get(kind.route(kind.job)).status_code == 200
    for job in ("sv-0000bbbb", "sv-0000ffff"):
        r = client.get(kind.route(job))
        assert r.status_code == 404 and r.json() == {"detail": "Library item not found"}, job

    azure.read_error = HttpResponseError("503 Server Busy")
    for job in (kind.job, "sv-0000bbbb", "sv-0000ffff"):
        _assert_unavailable(client.get(kind.route(job)))
    _assert_unavailable(client.get(kind.route(kind.job), headers=easyauth()))


def test_t2_10_podcast_library_empty_is_200_and_failed_is_503(client, easyauth, azure, monkeypatch):
    kind = Kind("podcast")
    kind.patch_router(monkeypatch, kind.library())
    assert client.get("/api/podcast/library").json() == []             # a true empty library
    azure.list_error = ServiceRequestError("down")
    _assert_unavailable(client.get("/api/podcast/library"))             # a failure is never "No episodes yet"


def test_t2_11_video_library_empty_is_200_and_failed_is_503(client, easyauth, azure, monkeypatch):
    kind = Kind("video")
    kind.patch_router(monkeypatch, kind.library())
    assert client.get("/api/video/library").json() == []
    azure.list_error = ServiceRequestError("down")
    _assert_unavailable(client.get("/api/video/library"))


def test_a_library_that_failed_at_startup_heals_without_a_restart(client, easyauth, azure, kind, monkeypatch):
    clock = Clock()
    lib = kind.library(clock)
    kind.patch_router(monkeypatch, lib)
    kind.seed(azure)
    azure.up = False
    _assert_unavailable(client.get(kind.route()))
    _assert_unavailable(client.get(kind.route()))
    assert azure.clients == 1                                           # cool-down: no connection storm

    azure.up = True
    _assert_unavailable(client.get(kind.route()))                       # still inside the cool-down
    clock.advance(st.INIT_RETRY_SECONDS)
    r = client.get(kind.route())
    assert r.status_code == 200 and [i["job_id"] for i in r.json()] == [kind.job]
    assert client.get(kind.route(kind.job)).status_code == 200


# ---------------------------------------------------------------------------
# Routes: decks over the real PresentationStore (Cosmos replaced by a fake)
# ---------------------------------------------------------------------------
class CosmosWorld:
    def __init__(self) -> None:
        self.up = True
        self.docs: list[dict] = []
        self.query_error: Exception | None = None
        self.read_item_error: Exception | None = None
        self.clients = 0


@pytest.fixture
def cosmos(monkeypatch) -> CosmosWorld:
    w = CosmosWorld()

    class Container:
        def read(self):
            return None

        def query_items(self, query, enable_cross_partition_query):
            if w.query_error:
                raise w.query_error
            return iter(list(w.docs))

        def read_item(self, item, partition_key):
            if w.read_item_error:
                raise w.read_item_error
            for doc in w.docs:
                if doc["id"] == item:
                    return doc
            raise cosmos_exceptions.CosmosResourceNotFoundError(message="Entity with the specified id does not exist")

    class Database:
        def get_container_client(self, _name):
            return Container()

    class CosmosClient:
        def __init__(self, endpoint, *args, **kwargs):
            w.clients += 1
            if not w.up:
                raise RuntimeError("cosmos unreachable")

        def get_database_client(self, _name):
            return Database()

    monkeypatch.setattr(st, "CosmosClient", CosmosClient)
    monkeypatch.setattr(st, "DefaultAzureCredential", lambda: object())
    return w


def deck_doc(deck_id: str = DECK_ID, **overrides) -> dict:
    doc = {"id": deck_id, "source": "deck", "filename": "Deck.pptx", "title": "Deck", "slide_count": 1,
           "language": "en-US", "published": True, "live_demo": False,
           "slides": [{"index": 0, "title": "Intro", "body": "Hello", "notes": "n"}]}
    doc.update(overrides)
    return doc


def deck_store(clock: Clock | None = None, **overrides) -> st.PresentationStore:
    cfg = dict(use_managed_identity=True, cosmos_endpoint="https://cosmos.test", cosmos_key="", cosmos_database="db",
               blob_connection_string="", blob_account_name="", blob_container="slide-images")
    cfg.update(overrides)
    return st.PresentationStore(SimpleNamespace(**cfg), clock=clock or Clock())


def test_t1_05_the_decks_list_503s_when_cosmos_is_down_and_heals_after_the_cooldown(client, easyauth, cosmos,
                                                                                    monkeypatch):
    import routers.decks as decks

    clock = Clock()
    store = deck_store(clock)
    monkeypatch.setattr(decks, "_store", lambda cfg: store)
    monkeypatch.setenv("AZURE_COSMOS_ENDPOINT", "https://cosmos.test")
    cosmos.docs = [deck_doc()]

    cosmos.up = False
    _assert_unavailable(client.get("/api/decks"))
    _assert_unavailable(client.get("/api/decks", headers=easyauth()))
    assert cosmos.clients == 1

    cosmos.up = True
    _assert_unavailable(client.get("/api/decks"))                       # still inside the cool-down
    clock.advance(st.INIT_RETRY_SECONDS)
    r = client.get("/api/decks")
    assert r.status_code == 200 and [d["deck_id"] for d in r.json()] == [DECK_ID]

    cosmos.query_error = RuntimeError("query failed")                    # a failing query is a failure too
    _assert_unavailable(client.get("/api/decks"))
    cosmos.query_error = None
    assert len(client.get("/api/decks").json()) == 1


def test_t1_07b_decks_library_empty_is_200_only_when_nothing_is_published_or_cosmos_is_not_configured(
        client, easyauth, cosmos, monkeypatch):
    import routers.decks as decks

    store = deck_store()
    monkeypatch.setattr(decks, "_store", lambda cfg: store)
    assert client.get("/api/decks").json() == []                         # reachable, no deck at all

    cosmos.docs = [deck_doc(published=False)]
    assert client.get("/api/decks").json() == []                         # nothing published
    assert [d["deck_id"] for d in client.get("/api/decks", headers=easyauth()).json()] == [DECK_ID]

    unconfigured = deck_store(cosmos_endpoint="", use_managed_identity=False)
    monkeypatch.setattr(decks, "_store", lambda cfg: unconfigured)
    for headers in ({}, easyauth()):
        r = client.get("/api/decks", headers=headers)
        assert r.status_code == 200 and r.json() == []
    assert cosmos.clients == 1                                            # only the configured store connected


def test_a_deck_store_that_cannot_be_built_is_503_only_when_cosmos_is_configured(client, monkeypatch):
    import routers.decks as decks

    monkeypatch.setattr(decks, "_store", lambda cfg: None)
    r = client.get("/api/decks")
    assert r.status_code == 200 and r.json() == []                        # offline default: not configured
    monkeypatch.setenv("AZURE_COSMOS_ENDPOINT", "https://cosmos.test")
    _assert_unavailable(client.get("/api/decks"))


def test_t2_13_a_deck_link_that_no_longer_resolves_is_404_and_a_cosmos_failure_is_503(client, easyauth, cosmos,
                                                                                       monkeypatch):
    import routers.decks as decks

    clock = Clock()
    store = deck_store(clock)
    monkeypatch.setattr(decks, "_store", lambda cfg: store)
    cosmos.docs = [deck_doc(), deck_doc(HIDDEN_DECK_ID, published=False),
                   {"id": "4f9f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "source": "playlist", "title": "A playlist"}]

    assert client.get(f"/api/decks/{DECK_ID}").status_code == 200
    for deck in (HIDDEN_DECK_ID, "5a0f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "4f9f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"):
        r = client.get(f"/api/decks/{deck}")                              # unpublished, deleted, not a deck
        assert r.status_code == 404 and r.json() == {"detail": "Deck not found"}, deck
    assert client.get("/api/decks/not-a-uuid").status_code == 404
    assert client.get(f"/api/decks/{HIDDEN_DECK_ID}", headers=easyauth()).status_code == 200

    cosmos.read_item_error = RuntimeError("read failed")
    for deck in (DECK_ID, HIDDEN_DECK_ID, "5a0f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"):
        _assert_unavailable(client.get(f"/api/decks/{deck}"))              # never "Deck not found"
    _assert_unavailable(client.get(f"/api/decks/{DECK_ID}", headers=easyauth()))
    cosmos.read_item_error = None
    assert client.get(f"/api/decks/{DECK_ID}").status_code == 200

    cosmos.up = False                                                      # Cosmos unreachable from a fresh store
    down = deck_store(clock)
    monkeypatch.setattr(decks, "_store", lambda cfg: down)
    _assert_unavailable(client.get(f"/api/decks/{DECK_ID}"))
    _assert_unavailable(client.get(f"/api/decks/{HIDDEN_DECK_ID}"))
    assert client.get("/api/decks/not-a-uuid").status_code == 404          # a bad id is still just a bad id


def test_t2_13_a_deck_detail_that_raises_unexpectedly_is_503_not_a_404(client, monkeypatch):
    import routers.decks as decks

    class Boom:
        cosmos_available = True
        available = False

        def get_presentation(self, deck_id, strict=False):
            raise RuntimeError("driver bug")

    monkeypatch.setattr(decks, "_store", lambda cfg: Boom())
    _assert_unavailable(client.get(f"/api/decks/{DECK_ID}"))
