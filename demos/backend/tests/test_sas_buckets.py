"""Public thumbnail and cover SAS URLs are bucketed (contracts v1.2 §2.5, criterion C2.2).

Every library response used to re-sign its URLs, so the browser could never reuse a thumbnail (176 downloads of 4
files in 16 hours). Public ``thumbnail_url`` and ``cover_url`` now share one window per 10-minute bucket:

    start  = floor(now, 10 min) - 5 min
    expiry = floor(now, 10 min) + 20 min        # more than 10 minutes left at any instant

while media URLs keep their per-request 15-minute SAS and the admin SAS (24 h) is unchanged. The user delegation
key must cover the window it signs. Nothing here talks to Azure: the libraries run on a fake blob service with an
injected clock and the real ``generate_blob_sas``.
"""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest
from azure.storage.blob import UserDelegationKey

from services import demo_protocol as dp
from services.podcast_models import SasWindow, sas_bucket_window

UTC = timezone.utc
T0 = datetime(2026, 10, 19, 12, 0, 0, tzinfo=UTC)  # a bucket boundary
MIN = timedelta(minutes=1)
ACCOUNT_KEY = base64.b64encode(b"k" * 32).decode()
CONNECTION_STRING = (
    f"DefaultEndpointsProtocol=https;AccountName=acct;AccountKey={ACCOUNT_KEY};EndpointSuffix=core.windows.net"
)
CFG = SimpleNamespace(blob_container="media", blob_connection_string=CONNECTION_STRING, blob_account_name="acct",
                      use_managed_identity=False)


class Clock:
    def __init__(self, now: datetime = T0) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def at(self, now: datetime) -> "Clock":
        self.now = now
        return self


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def sas_params(url: str) -> dict[str, datetime]:
    """The validity of a signed URL: ``st``/``se`` (SAS) and, for a user delegation SAS, ``skt``/``ske`` (key)."""
    query = parse_qs(urlsplit(url).query)
    return {k: _parse(query[k][0]) for k in ("st", "se", "skt", "ske") if k in query}


class _Container:
    def __init__(self, names):
        self.names = names

    def list_blobs(self, name_starts_with=""):
        return [SimpleNamespace(name=n) for n in self.names if n.startswith(name_starts_with)]


class FakeBlob:
    """Just enough of ``BlobServiceClient`` to sign URLs: blob URLs and user delegation keys (every request is
    recorded; each key has its own value, so tokens of two keys differ)."""

    def __init__(self, names=()):
        self.key_requests: list[tuple[datetime, datetime]] = []
        self.names = list(names)

    def get_blob_client(self, container, blob):
        return SimpleNamespace(url=f"https://acct.blob.core.windows.net/{container}/{blob}")

    def get_container_client(self, _container):
        return _Container(self.names)

    def get_user_delegation_key(self, key_start_time, key_expiry_time):
        self.key_requests.append((key_start_time, key_expiry_time))
        key = UserDelegationKey()
        key.signed_oid, key.signed_tid = "oid", "tid"
        key.signed_start, key.signed_expiry = _iso(key_start_time), _iso(key_expiry_time)
        key.signed_service, key.signed_version = "b", "2023-11-03"
        key.value = base64.b64encode(f"key-{len(self.key_requests)}".encode().ljust(32, b"-")).decode()
        return key


class Env:
    """A library of ``kind`` holding one published item, signed with the real ``_sas``."""

    def __init__(self, kind: str, clock: Clock, *, credential: bool):
        from services.podcast_library import PodcastLibrary
        from services.video_library import VideoLibrary

        self.kind, self.clock = kind, clock
        if kind == "podcast":
            self.job, prefix = "job-0123abcd", "podcast-library/job-0123abcd"
            self.lib = PodcastLibrary(CFG, utcnow=clock)
            self.manifest = {
                "schema_version": 2, "job_id": self.job, "title": "t", "format": "video", "published": True,
                "video_blob": f"{prefix}/video.mp4", "audio_blob": f"{prefix}/audio.mp3",
                "thumbnail_blob": f"{prefix}/thumb.jpg", "cover_blob": f"{prefix}/cover.jpg",
                "subtitle_blob": f"{prefix}/subtitles.srt", "audio_kind": "radio_mix",
            }
            self.media_key = "mp4_url"
        else:
            self.job, prefix = "sv-0123abcd", "videos/sv-0123abcd"
            self.lib = VideoLibrary(CFG, utcnow=clock)
            self.manifest = {
                "schema_version": 1, "job_id": self.job, "title": "t", "published": True,
                "video_blob": f"{prefix}/video.mp4", "audio_blob": f"{prefix}/audio.mp3",
                "thumbnail_blob": f"{prefix}/thumb.jpg", "subtitle_blob": f"{prefix}/subtitles.srt",
            }
            self.media_key = "video_url"
        self.manifest_blob = f"{prefix}/manifest.json"
        self.blob = FakeBlob([self.manifest_blob])
        lib = self.lib
        lib._initialised = True
        lib._blob = self.blob
        lib._account_name = "acct"
        lib._credential = object() if credential else None
        lib._read_json_blob = lambda name: dict(self.manifest) if name == self.manifest_blob else None  # type: ignore

    def list(self, now: datetime):
        self.clock.at(now)
        return self.lib.list(published_only=True)[0]

    def public_get(self, now: datetime):
        self.clock.at(now)
        return self.lib.get(self.job, public=True)

    def admin_get(self, now: datetime):
        self.clock.at(now)
        return self.lib.get(self.job)


@pytest.fixture(params=["podcast", "video"])
def kind(request) -> str:
    return request.param


@pytest.fixture(params=[True, False], ids=["delegation-key", "account-key"])
def credential(request) -> bool:
    return request.param


@pytest.fixture
def env(kind, credential, monkeypatch) -> Env:
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")  # public podcasts also carry the cover
    return Env(kind, Clock(), credential=credential)


# ---------------------------------------------------------------------------
# The window (pure)
# ---------------------------------------------------------------------------
def test_the_window_constants_are_the_contracts():
    from services import podcast_library, video_library

    assert (dp.SAS_BUCKET_MINUTES, dp.SAS_WINDOW_MINUTES, dp.SAS_SKEW_MINUTES) == (10, 20, 5)
    # Media URLs keep their own per-request lifetime.
    assert podcast_library.PUBLIC_SAS_MINUTES == video_library.PUBLIC_SAS_MINUTES == 15
    assert podcast_library.DEFAULT_SAS_MINUTES == video_library.DEFAULT_SAS_MINUTES == 24 * 60


@pytest.mark.parametrize("now,start,expiry", [
    (T0, T0 - 5 * MIN, T0 + 20 * MIN),
    (T0 + timedelta(minutes=7, seconds=31), T0 - 5 * MIN, T0 + 20 * MIN),
    (T0 + timedelta(minutes=9, seconds=59, microseconds=999_999), T0 - 5 * MIN, T0 + 20 * MIN),
    (T0 + 10 * MIN, T0 + 5 * MIN, T0 + 30 * MIN),
    (datetime(2026, 10, 19, 23, 59, 59, tzinfo=UTC), datetime(2026, 10, 19, 23, 45, tzinfo=UTC),
     datetime(2026, 10, 20, 0, 10, tzinfo=UTC)),
])
def test_window_of_an_instant(now, start, expiry):
    assert sas_bucket_window(now) == SasWindow(start=start, expiry=expiry)


def test_a_naive_instant_is_read_as_utc_and_other_zones_are_converted():
    assert sas_bucket_window(T0.replace(tzinfo=None) + 3 * MIN) == sas_bucket_window(T0 + 3 * MIN)
    paris = timezone(timedelta(hours=2))
    assert sas_bucket_window((T0 + 3 * MIN).astimezone(paris)) == sas_bucket_window(T0 + 3 * MIN)


def test_the_window_is_one_value_per_bucket_and_always_leaves_over_10_minutes():
    for seconds in range(0, 3 * 3600, 7):
        now = T0 + timedelta(seconds=seconds)
        window = sas_bucket_window(now)
        assert window.start <= now - 5 * MIN                      # valid at once, clock skew included
        assert 10 * MIN < window.expiry - now <= 20 * MIN        # >= 10 minutes of validity at any instant
        # One value per bucket: every instant of a bucket maps to the window of the bucket's first instant.
        assert window == sas_bucket_window(T0 + timedelta(seconds=seconds - seconds % 600))
    assert sas_bucket_window(T0 + 10 * MIN - timedelta(microseconds=1)) != sas_bucket_window(T0 + 10 * MIN)


# ---------------------------------------------------------------------------
# Libraries: identical URL within a bucket, different across buckets
# ---------------------------------------------------------------------------
def test_thumbnail_url_is_identical_within_a_bucket_for_lists_and_details(env):
    first = env.list(T0 + timedelta(seconds=1))["thumbnail_url"]
    assert first
    for seconds in (2, 59, 61, 300, 599):
        now = T0 + timedelta(seconds=seconds)
        assert env.list(now)["thumbnail_url"] == first
        assert env.public_get(now)["thumbnail_url"] == first
    assert env.blob.key_requests == [] or len(env.blob.key_requests) == 1  # one key serves the whole bucket


def test_thumbnail_url_differs_between_buckets(env):
    urls = [env.list(T0 + 10 * MIN * n + 3 * MIN)["thumbnail_url"] for n in range(4)]
    assert len(set(urls)) == 4
    assert len({u.split("?")[0] for u in urls}) == 1  # same blob, different window
    assert env.public_get(T0 + 10 * MIN * 3 + 9 * MIN)["thumbnail_url"] == urls[3]


def test_cover_url_shares_the_window_of_the_thumbnail(credential, monkeypatch):
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    env = Env("podcast", Clock(), credential=credential)
    first = env.public_get(T0 + timedelta(seconds=5))
    again = env.public_get(T0 + 9 * MIN)
    assert first["cover_url"] and first["cover_url"] == again["cover_url"]
    assert sas_params(first["cover_url"])["st"] == sas_params(first["thumbnail_url"])["st"]
    assert sas_params(first["cover_url"])["se"] == sas_params(first["thumbnail_url"])["se"]
    assert env.public_get(T0 + 10 * MIN)["cover_url"] != first["cover_url"]


def test_every_public_url_has_at_least_10_minutes_left_at_any_instant(env):
    for seconds in range(0, 50 * 60, 17):
        now = T0 + timedelta(seconds=seconds)
        urls = [env.list(now)["thumbnail_url"], env.public_get(now)["thumbnail_url"]]
        if env.kind == "podcast":
            urls.append(env.public_get(now)["cover_url"])
        for url in urls:
            params = sas_params(url)
            assert params["st"] <= now, (seconds, "not valid yet")
            assert params["se"] - now > 10 * MIN, (seconds, "less than 10 minutes left")
            assert params["se"] - now <= 20 * MIN


def test_the_url_signs_exactly_the_bucket_window(env):
    now = T0 + timedelta(minutes=13, seconds=41)
    params = sas_params(env.list(now)["thumbnail_url"])
    assert (params["st"], params["se"]) == (T0 + 5 * MIN, T0 + 30 * MIN)


# ---------------------------------------------------------------------------
# Media and admin URLs are unchanged
# ---------------------------------------------------------------------------
def test_media_urls_keep_their_per_request_15_minute_sas(env):
    first = env.public_get(T0 + timedelta(minutes=1))[env.media_key]
    later = env.public_get(T0 + timedelta(minutes=2))[env.media_key]
    for now, url in ((T0 + MIN, first), (T0 + 2 * MIN, later)):
        params = sas_params(url)
        assert params["se"] - now == 15 * MIN and now - params["st"] == 5 * MIN
    assert first != later  # per-request: the player's refresh gets a fresh URL


def test_admin_sas_is_unchanged(env):
    first = env.admin_get(T0 + timedelta(minutes=1))
    later = env.admin_get(T0 + timedelta(minutes=2))
    for now, item in ((T0 + MIN, first), (T0 + 2 * MIN, later)):
        for key in ("thumbnail_url",) + (("mp4_url", "mp3_url", "cover_url") if env.kind == "podcast"
                                          else ("video_url", "audio_url")):
            url = item[key]
            if url is None:
                continue
            params = sas_params(url)
            assert params["se"] - now == timedelta(hours=24) and now - params["st"] == 5 * MIN, key
    assert first["thumbnail_url"] != later["thumbnail_url"]
    summary = env.lib.list()[0]
    params = sas_params(summary["thumbnail_url"])
    assert params["se"] - env.clock.now == timedelta(hours=24)


# ---------------------------------------------------------------------------
# The user delegation key covers the window it signs
# ---------------------------------------------------------------------------
def test_the_delegation_key_covers_every_url_signed_with_it(kind, monkeypatch):
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    env = Env(kind, Clock(), credential=True)
    checked = 0
    for seconds in range(0, 30 * 3600, 211):
        now = T0 + timedelta(seconds=seconds)
        for item, admin in ((env.list(now), False), (env.public_get(now), False), (env.admin_get(now), True)):
            for key, url in item.items():
                if key.endswith("_url") and isinstance(url, str) and url.startswith("https://acct."):
                    params = sas_params(url)
                    assert params["skt"] <= params["st"], (seconds, key, "the key starts after the SAS")
                    if not admin:  # a 24-hour admin SAS can outlive the key it was signed with (unchanged)
                        assert params["se"] <= params["ske"], (seconds, key, "the key expires before the SAS")
                    checked += 1
    assert checked > 1000
    # One key per ~23 hours (it is refreshed when less than an hour is left), not one per request.
    assert 1 <= len(env.blob.key_requests) <= 3
    for start, expiry in env.blob.key_requests:
        assert expiry - start >= timedelta(hours=24)


def test_one_key_starting_before_the_bucket_serves_admin_then_public_urls(kind, monkeypatch):
    monkeypatch.setenv("PODCAST_PUBLIC_AUDIO", "true")
    env = Env(kind, Clock(), credential=True)
    now = T0 + timedelta(minutes=7, seconds=30)
    env.admin_get(now)                       # signs first, with start = now - 5 min (T0 + 2:30)
    public = env.public_get(now)             # the window starts at T0 - 5 min, before the admin SAS start
    assert len(env.blob.key_requests) == 1   # the first key already starts at the bucket's window start
    key_start, key_expiry = env.blob.key_requests[0]
    window = sas_bucket_window(now)
    assert key_start <= window.start and key_expiry >= window.expiry
    params = sas_params(public["thumbnail_url"])
    assert (params["skt"], params["st"], params["se"]) == (window.start, window.start, window.expiry)


def test_a_cached_key_that_starts_after_the_window_is_replaced(kind):
    env = Env(kind, Clock(), credential=True)
    now = T0 + timedelta(minutes=7)
    env.public_get(now)
    assert len(env.blob.key_requests) == 1
    # Pretend the cached key began later than the bucket's window (e.g. it was minted for a shorter SAS).
    env.lib._udk_start = sas_bucket_window(now).start + 3 * MIN
    url = env.public_get(now + MIN)["thumbnail_url"]
    assert len(env.blob.key_requests) == 2
    params = sas_params(url)
    assert params["skt"] <= params["st"]


def test_the_key_is_refreshed_before_it_expires_and_covers_the_new_window(kind):
    env = Env(kind, Clock(), credential=True)
    env.public_get(T0 + 2 * MIN)
    key_expiry = env.blob.key_requests[0][1]
    env.public_get(key_expiry - timedelta(hours=1, minutes=5))   # still more than an hour left: reused
    assert len(env.blob.key_requests) == 1
    near = key_expiry - timedelta(minutes=50)                    # under an hour left: refreshed
    url = env.public_get(near)["thumbnail_url"]
    assert len(env.blob.key_requests) == 2
    params = sas_params(url)
    window = sas_bucket_window(near)
    assert params["skt"] <= window.start and params["ske"] >= window.expiry


def test_a_failing_key_request_yields_no_url_rather_than_an_unsigned_one(kind):
    env = Env(kind, Clock(), credential=True)

    def boom(key_start_time, key_expiry_time):
        raise RuntimeError("no rights")

    env.blob.get_user_delegation_key = boom
    item = env.public_get(T0 + MIN)
    assert item["thumbnail_url"] is None
