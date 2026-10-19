"""Strict readers and the non-sticky init of ``PresentationStore`` (contracts v1.2 §2.4).

No Azure: the Cosmos / Blob SDK classes of ``services.storage`` are replaced by fakes whose behaviour the test
flips between calls, and the store gets a fake clock for the init cool-down.
"""
from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest
from azure.cosmos import exceptions as cosmos_exceptions

from services import storage as st


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class World:
    """What the fake Azure answers; mutate it between calls."""

    def __init__(self) -> None:
        self.cosmos_up = True          # False: the CosmosClient constructor raises
        self.container_read_error: Exception | None = None   # the container probe at init fails
        self.query_error: Exception | None = None
        self.read_item_error: Exception | None = None
        self.blob_up = True
        self.docs: list[dict] = []
        self.queries: list[str] = []
        self.cosmos_clients = 0
        self.blob_clients = 0
        self.construct_delay = 0.0     # widens the window for the concurrency tests
        self._lock = threading.Lock()


@pytest.fixture
def world(monkeypatch) -> World:
    w = World()

    class Container:
        def read(self):
            if w.container_read_error:
                raise w.container_read_error

        def query_items(self, query, enable_cross_partition_query):
            w.queries.append(query)
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
            with w._lock:
                w.cosmos_clients += 1
            if w.construct_delay:
                time.sleep(w.construct_delay)
            if not w.cosmos_up:
                raise RuntimeError("cosmos unreachable")

        def get_database_client(self, _name):
            return Database()

    class BlobContainer:
        def exists(self):
            return True

        def create_container(self):  # pragma: no cover - exists() is always True
            pass

    class BlobServiceClient:
        def __init__(self, account_url, credential=None):
            with w._lock:
                w.blob_clients += 1
            if not w.blob_up:
                raise RuntimeError("blob unreachable")

        def get_container_client(self, _name):
            return BlobContainer()

    monkeypatch.setattr(st, "CosmosClient", CosmosClient)
    monkeypatch.setattr(st, "BlobServiceClient", BlobServiceClient)
    monkeypatch.setattr(st, "DefaultAzureCredential", lambda: object())
    return w


def make_store(clock: Clock | None = None, **overrides) -> st.PresentationStore:
    cfg = dict(
        use_managed_identity=True, cosmos_endpoint="https://cosmos.test", cosmos_key="", cosmos_database="db",
        blob_connection_string="", blob_account_name="", blob_container="slide-images",
    )
    cfg.update(overrides)
    return st.PresentationStore(SimpleNamespace(**cfg), clock=clock or Clock())


DECK = {"id": "11111111-1111-4111-8111-111111111111", "source": "deck", "published": True, "audience_level": "beginner"}


# ---------------------------------------------------------------------------
# Strict vs lenient readers
# ---------------------------------------------------------------------------
def test_constants():
    assert st.INIT_RETRY_SECONDS == 30
    assert issubclass(st.StorageUnavailable, Exception)


def test_cosmos_down_lenient_answers_empty_strict_raises(world):
    world.cosmos_up = False
    store = make_store()
    assert store.list_decks() == []
    assert store.get_presentation(DECK["id"]) is None
    with pytest.raises(st.StorageUnavailable):
        store.list_decks(strict=True)
    with pytest.raises(st.StorageUnavailable):
        store.get_presentation(DECK["id"], strict=True)
    assert world.cosmos_clients == 1  # the cool-down: four calls, one init attempt


def test_container_probe_failure_at_init_is_unavailable(world):
    world.container_read_error = RuntimeError("503 from Cosmos")
    store = make_store()
    assert store.cosmos_available is False
    assert store.list_decks() == []
    with pytest.raises(st.StorageUnavailable):
        store.list_decks(strict=True)


def test_query_and_read_failures_raise_only_when_strict(world):
    world.docs = [DECK]
    store = make_store()
    world.query_error = RuntimeError("query failed")
    world.read_item_error = RuntimeError("read failed")
    assert store.list_decks() == []
    assert store.get_presentation(DECK["id"]) is None
    with pytest.raises(st.StorageUnavailable) as listing:
        store.list_decks(strict=True)
    assert isinstance(listing.value.__cause__, RuntimeError)
    with pytest.raises(st.StorageUnavailable) as reading:
        store.get_presentation(DECK["id"], strict=True)
    assert isinstance(reading.value.__cause__, RuntimeError)


def test_not_found_is_none_in_both_modes_and_empty_is_not_a_failure(world):
    store = make_store()
    assert store.get_presentation("missing") is None
    assert store.get_presentation("missing", strict=True) is None
    assert store.list_decks(strict=True) == []   # nothing published: [] is a real answer
    assert world.cosmos_clients == 1


def test_healthy_store_returns_the_same_documents_in_both_modes(world):
    world.docs = [DECK]
    store = make_store()
    assert store.list_decks() == store.list_decks(strict=True) == [DECK]
    assert store.get_presentation(DECK["id"]) == store.get_presentation(DECK["id"], strict=True) == DECK


def test_cosmos_not_configured_is_empty_never_unavailable(world):
    store = make_store(cosmos_endpoint="")
    assert store.list_decks(strict=True) == []
    assert store.get_presentation(DECK["id"], strict=True) is None
    assert store.list_decks() == [] and store.get_presentation(DECK["id"]) is None
    assert store.cosmos_available is False
    assert world.cosmos_clients == 0


def test_list_decks_projection_includes_audience_level(world):
    world.docs = [DECK]
    store = make_store()
    assert store.list_decks()[0]["audience_level"] == "beginner"
    query = world.queries[-1]
    for column in ("c.audience_level", "c.published", "c.live_demo", "c.language", "c.title", "c.filename"):
        assert column in query
    assert "WHERE c.source = 'deck'" in query


# ---------------------------------------------------------------------------
# Non-sticky init
# ---------------------------------------------------------------------------
def test_failed_init_is_retried_at_most_once_per_cooldown(world):
    clock = Clock()
    world.cosmos_up = False
    store = make_store(clock)
    for _ in range(5):
        assert store.cosmos_available is False
    assert world.cosmos_clients == 1

    clock.advance(st.INIT_RETRY_SECONDS - 0.1)
    assert store.cosmos_available is False
    assert world.cosmos_clients == 1               # not yet

    clock.advance(0.1)
    assert store.cosmos_available is False         # due: one retry, still down
    assert world.cosmos_clients == 2
    clock.advance(st.INIT_RETRY_SECONDS - 1)
    assert store.cosmos_available is False
    assert world.cosmos_clients == 2               # the cool-down restarted at the retry

    world.cosmos_up = True
    clock.advance(1)
    assert store.cosmos_available is True          # healed
    assert world.cosmos_clients == 3
    clock.advance(10 * st.INIT_RETRY_SECONDS)
    assert store.cosmos_available is True
    assert world.cosmos_clients == 3               # healthy: never rebuilt


def test_strict_reader_heals_after_the_cooldown(world):
    clock = Clock()
    world.cosmos_up = False
    world.docs = [DECK]
    store = make_store(clock)
    with pytest.raises(st.StorageUnavailable):
        store.list_decks(strict=True)
    world.cosmos_up = True
    with pytest.raises(st.StorageUnavailable):
        store.list_decks(strict=True)              # still inside the cool-down
    clock.advance(st.INIT_RETRY_SECONDS)
    assert store.list_decks(strict=True) == [DECK]


def test_retry_keeps_the_parts_that_work(world):
    clock = Clock()
    world.cosmos_up = False
    store = make_store(clock, blob_account_name="acct")
    assert store.cosmos_available is False
    first_blob = store._blob_client
    assert first_blob is not None and world.blob_clients == 1

    world.cosmos_up = True
    clock.advance(st.INIT_RETRY_SECONDS)
    assert store.cosmos_available is True
    assert store._blob_client is first_blob        # Blob was not rebuilt
    assert world.blob_clients == 1
    assert world.cosmos_clients == 2
    assert store.available is True


def test_blob_failure_is_retried_without_touching_cosmos(world):
    clock = Clock()
    world.blob_up = False
    store = make_store(clock, blob_account_name="acct")
    assert store.cosmos_available is True
    assert store.available is False                # configured Blob that did not come up
    assert world.cosmos_clients == 1 and world.blob_clients == 1

    clock.advance(st.INIT_RETRY_SECONDS - 1)
    assert store.available is False
    assert world.blob_clients == 1

    world.blob_up = True
    clock.advance(1)
    assert store.available is True
    assert world.blob_clients == 2
    assert world.cosmos_clients == 1               # the working Cosmos container was kept


def test_nothing_configured_is_never_retried(world):
    clock = Clock()
    store = make_store(clock, cosmos_endpoint="", use_managed_identity=False)
    assert store.cosmos_available is False and store.available is False
    clock.advance(100 * st.INIT_RETRY_SECONDS)
    assert store.cosmos_available is False
    assert world.cosmos_clients == 0 and world.blob_clients == 0
    assert store._retry_due() is False


def test_first_init_blocks_concurrent_callers_and_runs_once(world):
    world.construct_delay = 0.15
    store = make_store()
    results: list[bool] = []
    gate = threading.Barrier(8)

    def worker():
        gate.wait()
        results.append(store._ensure_init())

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert results == [True] * 8                   # nobody saw a half-initialised store
    assert world.cosmos_clients == 1


def test_concurrent_retry_is_attempted_by_one_thread(world):
    clock = Clock()
    world.cosmos_up = False
    store = make_store(clock)
    assert store.cosmos_available is False
    assert world.cosmos_clients == 1

    world.cosmos_up = True
    world.construct_delay = 0.15
    clock.advance(st.INIT_RETRY_SECONDS)
    gate = threading.Barrier(8)

    def worker():
        gate.wait()
        store._ensure_init()

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert world.cosmos_clients == 2               # exactly one retry for eight callers
    assert store.cosmos_available is True
