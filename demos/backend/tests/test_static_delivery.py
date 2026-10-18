"""SPA static delivery: gzip + long-lived caching for ``/assets/*`` only."""
from __future__ import annotations

import gzip
import random

import pytest
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

IMMUTABLE = "public, max-age=31536000, immutable"
ONE_HOUR = "public, max-age=3600"
SPA_NO_STORE = "no-cache, no-store, must-revalidate"

HASHED_JS = "index-abc123de.js"
# > 64 KB so FileResponse streams several chunks, like the real 665 KB bundle.
JS = "".join(
    f"export function track{i}(n){{return `Oz Radio episode {i}`.repeat(n % {i % 7 + 1});}}\n"
    for i in range(2500)
).encode()
SVG = ("<svg xmlns='http://www.w3.org/2000/svg'>"
       + "".join(f"<circle cx='{i}' cy='{i}' r='4' fill='#0a64d6'/>" for i in range(60))
       + "</svg>").encode()
TINY_CSS = b".oz{color:#0a64d6}"
BINARY = random.Random(7).randbytes(4096)
INDEX_HTML = ("<!doctype html><html><head>"
              + "<link rel='modulepreload' href='/assets/index-abc123de.js'>" * 30
              + "</head><body>SPA</body></html>")
WORKLET_JS = b"class PcmCapture extends AudioWorkletProcessor { process() { return true; } }\n" * 30


def _write_build(tmp_path):
    static = tmp_path / "static"
    assets = static / "assets"
    assets.mkdir(parents=True)
    (static / "index.html").write_text(INDEX_HTML, encoding="utf-8")
    (static / "pcm-capture-worklet.js").write_bytes(WORKLET_JS)
    files = {
        HASHED_JS: JS,
        "logo.svg": SVG,
        "tiny-Ab12Cd34.css": TINY_CSS,
        "cover-Ab12Cd34.png": BINARY,
        "newsreader-latin-opsz-normal-s-izfB6B.woff2": BINARY,
        "jingle-Ab12Cd34.mp3": BINARY,
    }
    for name, body in files.items():
        (assets / name).write_bytes(body)
    return static


def _big_json(request):
    return JSONResponse({"items": [f"episode-{i}" for i in range(500)]})


def _install_routes(monkeypatch, app, *, assets_dir, extra=()):
    """Serve ``/assets`` from *assets_dir* like production.

    app.py mounts ``/assets`` at import time only when the SPA is already built,
    so the mount is replaced (or added, or dropped when *assets_dir* is None)
    right before the SPA catch-all.
    """
    routes = [r for r in app.router.routes if not (isinstance(r, Mount) and r.path == "/assets")]
    catch_all = next(i for i, r in enumerate(routes) if getattr(r, "path", None) == "/{full_path:path}")
    added = list(extra)
    if assets_dir is not None:
        added.append(Mount("/assets", app=StaticFiles(directory=str(assets_dir)), name="assets"))
    routes[catch_all:catch_all] = added
    monkeypatch.setattr(app.router, "routes", routes)


@pytest.fixture
def spa_build(tmp_path, monkeypatch, app_module):
    static = _write_build(tmp_path)
    monkeypatch.setattr(app_module, "STATIC_DIR", str(static))
    _install_routes(monkeypatch, app_module.app, assets_dir=static / "assets",
                    extra=[Route("/api/_test/big", _big_json)])
    return static


@pytest.fixture
def spa_build_unmounted(tmp_path, monkeypatch, app_module):
    """Same build without the ``/assets`` mount: the SPA catch-all serves the files."""
    static = _write_build(tmp_path)
    monkeypatch.setattr(app_module, "STATIC_DIR", str(static))
    _install_routes(monkeypatch, app_module.app, assets_dir=None)
    return static


def _fetch(client, path, headers):
    """Return ``(response, wire bytes)`` — httpx would transparently gunzip ``.content``."""
    with client.stream("GET", path, headers=headers) as r:
        raw = b"".join(r.iter_raw())
    return r, raw


def _vary(r):
    return [token.strip().lower() for token in r.headers.get("vary", "").split(",") if token.strip()]


def _assert_security_headers(r):
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert r.headers["content-security-policy"].startswith("frame-ancestors ")


# ---------------------------------------------------------------------------
# /assets: gzip negotiation
# ---------------------------------------------------------------------------
def test_hashed_js_is_gzipped_and_immutable(client, spa_build):
    r, raw = _fetch(client, f"/assets/{HASHED_JS}", {"Accept-Encoding": "gzip, deflate, br"})
    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"
    assert gzip.decompress(raw) == JS
    assert len(raw) < len(JS) // 3
    assert _vary(r).count("accept-encoding") == 1
    assert r.headers["cache-control"] == IMMUTABLE
    assert r.headers["etag"].startswith('W/"')  # gzip bytes: weak validator
    assert "last-modified" in r.headers
    _assert_security_headers(r)


def test_identity_when_gzip_not_accepted(client, spa_build):
    r, raw = _fetch(client, f"/assets/{HASHED_JS}", {"Accept-Encoding": "identity"})
    assert r.status_code == 200
    assert "content-encoding" not in r.headers
    assert raw == JS and r.headers["content-length"] == str(len(JS))
    assert _vary(r) == ["accept-encoding"]
    assert r.headers["cache-control"] == IMMUTABLE
    assert r.headers["etag"].startswith('"')  # identity bytes: strong validator
    _assert_security_headers(r)


def test_single_chunk_unhashed_asset_is_gzipped_with_short_cache(client, spa_build):
    r, raw = _fetch(client, "/assets/logo.svg", {"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"
    assert gzip.decompress(raw) == SVG and r.headers["content-length"] == str(len(raw))
    assert r.headers["cache-control"] == ONE_HOUR
    assert "accept-encoding" in _vary(r)


def test_small_asset_is_not_compressed(client, spa_build):
    r, raw = _fetch(client, "/assets/tiny-Ab12Cd34.css", {"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert "content-encoding" not in r.headers and raw == TINY_CSS
    assert r.headers["cache-control"] == IMMUTABLE
    assert "accept-encoding" in _vary(r)


@pytest.mark.parametrize("name", ["cover-Ab12Cd34.png", "newsreader-latin-opsz-normal-s-izfB6B.woff2",
                                  "jingle-Ab12Cd34.mp3"])
def test_already_compressed_formats_are_not_gzipped(client, spa_build, name):
    r, raw = _fetch(client, f"/assets/{name}", {"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert "content-encoding" not in r.headers and raw == BINARY
    assert r.headers["cache-control"] == IMMUTABLE
    assert "accept-encoding" not in _vary(r)
    assert r.headers["etag"].startswith('"')


def test_range_request_is_never_compressed(client, spa_build):
    r, raw = _fetch(client, f"/assets/{HASHED_JS}", {"Accept-Encoding": "gzip", "Range": "bytes=0-4095"})
    assert r.status_code == 206
    assert "content-encoding" not in r.headers
    assert raw == JS[:4096]
    assert r.headers["content-range"] == f"bytes 0-4095/{len(JS)}"
    assert r.headers["etag"].startswith('"')
    assert r.headers["cache-control"] == IMMUTABLE


def test_head_request_carries_cache_policy(client, spa_build):
    r = client.head(f"/assets/{HASHED_JS}", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.content == b""
    assert r.headers["cache-control"] == IMMUTABLE
    assert "accept-encoding" in _vary(r)
    _assert_security_headers(r)


# ---------------------------------------------------------------------------
# /assets: conditional requests and errors
# ---------------------------------------------------------------------------
def test_conditional_requests_still_return_304(client, spa_build):
    url = f"/assets/{HASHED_JS}"
    gz, _ = _fetch(client, url, {"Accept-Encoding": "gzip"})
    plain, _ = _fetch(client, url, {"Accept-Encoding": "identity"})
    assert gz.headers["etag"] == "W/" + plain.headers["etag"]
    assert gz.headers["last-modified"] == plain.headers["last-modified"]

    r = client.get(url, headers={"Accept-Encoding": "gzip", "If-None-Match": gz.headers["etag"]})
    assert r.status_code == 304 and r.content == b""
    assert r.headers["etag"] == gz.headers["etag"]
    assert r.headers["cache-control"] == IMMUTABLE
    assert "accept-encoding" in _vary(r)
    _assert_security_headers(r)

    r = client.get(url, headers={"Accept-Encoding": "identity", "If-None-Match": plain.headers["etag"]})
    assert r.status_code == 304 and r.headers["etag"] == plain.headers["etag"]

    r = client.get(url, headers={"Accept-Encoding": "gzip", "If-Modified-Since": gz.headers["last-modified"]})
    assert r.status_code == 304 and r.headers["cache-control"] == IMMUTABLE

    r, raw = _fetch(client, url, {"Accept-Encoding": "gzip", "If-None-Match": 'W/"stale"'})
    assert r.status_code == 200 and gzip.decompress(raw) == JS


def test_missing_asset_is_404_without_cache_policy(client, spa_build):
    r = client.get("/assets/missing-Ab12Cd34.js", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 404
    assert "cache-control" not in r.headers
    assert "content-encoding" not in r.headers


# ---------------------------------------------------------------------------
# Everything else is untouched
# ---------------------------------------------------------------------------
def test_api_responses_are_not_compressed(client, spa_build):
    r = client.get("/api/health", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert "content-encoding" not in r.headers
    assert "accept-encoding" not in _vary(r)
    assert "cache-control" not in r.headers
    _assert_security_headers(r)

    r, raw = _fetch(client, "/api/_test/big", {"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and len(raw) > 4096
    assert "content-encoding" not in r.headers
    assert "accept-encoding" not in _vary(r)


@pytest.mark.parametrize("path", ["/", "/library/podcasts"])
def test_spa_shell_stays_no_store_and_uncompressed(client, spa_build, path):
    r, raw = _fetch(client, path, {"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and raw == INDEX_HTML.encode()
    assert r.headers["cache-control"] == SPA_NO_STORE
    assert "content-encoding" not in r.headers
    _assert_security_headers(r)


def test_root_static_files_are_untouched(client, spa_build):
    r, raw = _fetch(client, "/pcm-capture-worklet.js", {"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and raw == WORKLET_JS
    assert "content-encoding" not in r.headers
    assert "cache-control" not in r.headers


def test_policy_applies_when_catch_all_serves_assets(client, spa_build_unmounted):
    r, raw = _fetch(client, f"/assets/{HASHED_JS}", {"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip" and gzip.decompress(raw) == JS
    assert r.headers["cache-control"] == IMMUTABLE
    _assert_security_headers(r)


# ---------------------------------------------------------------------------
# Hashed-name detection
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("name, hashed", [
    ("index-QO2cPfnY.js", True),
    ("index-CrJ3z3l8.css", True),
    ("index-abc123de.js", True),
    ("hanken-grotesk-latin-ext-wght-normal-Dg-wlmqe.woff2", True),
    ("hanken-grotesk-vietnamese-wght-normal-CHiFlh_0.woff2", True),
    ("newsreader-latin-opsz-normal-s-izfB6B.woff2", True),
    ("index-QO2cPfnY.js.map", True),
    ("logo.svg", False),
    ("index.js", False),
    ("pcm-capture-worklet.js", False),
    ("brand-standard.css", False),
    ("index-abc123.js", False),
    ("index-abc123def.js", False),
])
def test_asset_cache_control(app_module, name, hashed):
    assert app_module.asset_cache_control(name) == (IMMUTABLE if hashed else ONE_HOUR)
