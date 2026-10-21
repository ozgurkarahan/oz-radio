"""Load-performance hints: the media-origin preconnect injected into index.html and the light avatar-disc variant."""
from __future__ import annotations

import io
import re

import pytest
from PIL import Image

from services import perf_hints

KEY = "c2VjcmV0LWFjY291bnQta2V5LW5ldmVyLWxlYWs="
SAS = "sv=2024-11-04&sig=SECRETSIG"
INDEX = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Oz Radio</title>'
    "<!--OZ_BOOT-->"
    '<script type="module" src="/assets/index-abc123de.js"></script></head>'
    '<body><div id="root"></div></body></html>'
)
LINK = re.compile(r"<link rel=\"(preconnect|dns-prefetch)\" href=\"([^\"]*)\"([^>]*)>")


# ---------------------------------------------------------------------------
# media_origin
# ---------------------------------------------------------------------------
def test_origin_from_managed_identity_account():
    assert perf_hints.media_origin("ozstore", "", True) == "https://ozstore.blob.core.windows.net"


def test_origin_from_connection_string_never_carries_the_key():
    conn = f"DefaultEndpointsProtocol=https;AccountName=ozstore;AccountKey={KEY};EndpointSuffix=core.windows.net"
    origin = perf_hints.media_origin("", conn, False)
    assert origin == "https://ozstore.blob.core.windows.net" and KEY not in origin


def test_origin_prefers_the_blob_endpoint_host_only():
    conn = f"BlobEndpoint=https://media.example.net:443/some/path?{SAS};AccountName=ozstore;AccountKey={KEY}"
    assert perf_hints.media_origin("", conn, False) == "https://media.example.net"


@pytest.mark.parametrize("account,conn,mi", [
    ("", "", False),                                                    # not configured
    ("ozstore", "", False),                                             # account without managed identity or key
    ("Bad Name!", "", True),                                            # not a storage account name
    ("", "UseDevelopmentStorage=true", False),                          # local emulator: no public origin
    ("", f"AccountName=ozstore;AccountKey={KEY};EndpointSuffix=evil.com/x", False),
    ("", "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;AccountName=devstoreaccount1", False),
])
def test_origin_is_absent_when_not_a_safe_https_origin(account, conn, mi):
    assert perf_hints.media_origin(account, conn, mi) is None


def test_origin_reads_the_environment_by_default(monkeypatch):
    monkeypatch.setenv("AZURE_BLOB_ACCOUNT_NAME", "ozstore")
    monkeypatch.setenv("AZURE_BLOB_CONNECTION_STRING", "")
    monkeypatch.setenv("AZURE_USE_MANAGED_IDENTITY", "true")
    assert perf_hints.media_origin() == "https://ozstore.blob.core.windows.net"


def test_preconnect_links_empty_without_an_origin():
    assert perf_hints.preconnect_links(None) == ""


# ---------------------------------------------------------------------------
# Injection into index.html
# ---------------------------------------------------------------------------
@pytest.fixture
def index_dir(tmp_path, monkeypatch, app_module):
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text(INDEX, encoding="utf-8")
    monkeypatch.setattr(app_module, "STATIC_DIR", str(static))
    return static


def test_index_carries_origin_only_preconnect(client, index_dir, monkeypatch):
    conn = f"DefaultEndpointsProtocol=https;AccountName=ozstore;AccountKey={KEY};EndpointSuffix=core.windows.net"
    monkeypatch.setenv("AZURE_BLOB_CONNECTION_STRING", conn)
    monkeypatch.setenv("AZURE_BLOB_ACCOUNT_NAME", "")
    monkeypatch.setenv("AZURE_USE_MANAGED_IDENTITY", "false")
    r = client.get("/")
    assert r.status_code == 200
    links = LINK.findall(r.text)
    assert [(rel, href) for rel, href, _ in links] == [
        ("preconnect", "https://ozstore.blob.core.windows.net"),
        ("dns-prefetch", "https://ozstore.blob.core.windows.net"),
    ]
    assert "crossorigin" in links[0][2]
    assert KEY not in r.text and "sig=" not in r.text and "AccountKey" not in r.text
    assert r.text.index('rel="preconnect"') < r.text.index('<script type="module"')


def test_index_has_no_preconnect_without_storage(client, index_dir):
    r = client.get("/")
    assert r.status_code == 200 and "preconnect" not in r.text and "dns-prefetch" not in r.text


# ---------------------------------------------------------------------------
# Avatar disc variant
# ---------------------------------------------------------------------------
def _png(path, *, keyed: bool, size=512):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0) if keyed else (0, 255, 0, 255))
    for x in range(size // 4, size * 3 // 4):
        for y in range(size // 4, size * 3 // 4):
            im.putpixel((x, y), (200, 120, 90, 255))
    im.save(path, "PNG")


@pytest.fixture
def avatars(tmp_path, monkeypatch, app_module):
    monkeypatch.setattr(app_module, "AVATAR_THUMBS_DIR", tmp_path)
    perf_hints._disc_cache.clear()
    return tmp_path


def test_disc_variant_is_a_small_keyed_webp(client, avatars):
    _png(avatars / "photo_female.png", keyed=True)
    r = client.get("/static/avatars/photo_female-disc.webp")
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    assert r.headers["etag"] and "max-age" in r.headers["cache-control"]
    im = Image.open(io.BytesIO(r.content))
    assert im.format == "WEBP" and max(im.size) == perf_hints.DISC_MAX_SIDE
    assert im.convert("RGBA").getpixel((0, 0))[3] == 0                      # transparency is kept
    assert len(r.content) < (avatars / "photo_female.png").stat().st_size

    again = client.get("/static/avatars/photo_female-disc.webp", headers={"If-None-Match": r.headers["etag"]})
    assert again.status_code == 304


def test_disc_variant_is_refused_for_green_screen_photos(client, avatars):
    _png(avatars / "photo_male.png", keyed=False)
    assert client.get("/static/avatars/photo_male-disc.webp").status_code == 404   # the client keys the original


def test_disc_variant_missing_source_and_bad_names(client, avatars):
    assert client.get("/static/avatars/nobody-disc.webp").status_code == 404
    assert client.get("/static/avatars/-disc.webp").status_code == 404
    assert client.get("/static/avatars/..%2Fphoto-disc.webp").status_code == 404


def test_original_avatar_route_is_unchanged(client, avatars):
    _png(avatars / "photo_female.png", keyed=True)
    r = client.get("/static/avatars/photo_female.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.headers["cache-control"] == "no-cache"
