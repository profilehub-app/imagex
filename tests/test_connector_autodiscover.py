from __future__ import annotations

import json
from pathlib import Path
import httpx
import pytest

from src.server import connector_autodiscover, connector_registry, integrated_sources_service


VIDEO_PORTAL_ROOT_HTML = """
<!doctype html>
<html>
<head>
  <title>Stream Hub - Portal</title>
  <meta property="og:site_name" content="StreamHub" />
  <meta name="theme-color" content="#e11d48" />
</head>
<body>
  <form action="/search" method="get"><input type="search" name="q" /></form>
  <div class="video-card"><a href="/video/abc1"><img data-src="https://portal.example/t1.jpg" /><span>Clip One</span><span>12:34</span></a></div>
  <div class="video-card"><a href="/video/abc2"><img data-src="https://portal.example/t2.jpg" /><span>Clip Two</span><span>05:10</span></a></div>
  <div class="video-card"><a href="/video/abc3"><img data-src="https://portal.example/t3.jpg" /><span>Clip Three</span><span>08:22</span></a></div>
  <nav class="pagination"><a rel="next" href="/?page=2">Next</a></nav>
</body>
</html>
"""

VIDEO_WATCH_HTML = """
<!doctype html>
<html>
<head>
  <title>Clip One - StreamHub</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"Clip One"}</script>
</head>
<body>
  <h1>Clip One</h1>
  <video src="https://portal.example/media/abc1.mp4"></video>
</body>
</html>
"""

GALLERY_ROOT_HTML = """
<!doctype html>
<html>
<head>
  <title>Photo Wall</title>
  <meta property="og:site_name" content="PhotoWall" />
</head>
<body>
  <div class="album-item"><a href="/album/1"><img data-src="https://gallery.example/1.jpg" /></a></div>
  <div class="album-item"><a href="/album/2"><img data-src="https://gallery.example/2.jpg" /></a></div>
  <div class="album-item"><a href="/album/3"><img data-src="https://gallery.example/3.jpg" /></a></div>
  <div class="album-item"><a href="/album/4"><img data-src="https://gallery.example/4.jpg" /></a></div>
</body>
</html>
"""

FORUM_ROOT_HTML = """
<!doctype html>
<html>
<head>
  <title>Media Board</title>
  <meta property="og:site_name" content="MediaBoard" />
</head>
<body>
  <a href="/forums/10-photos/">Photos</a>
  <a href="/threads/101-set-one/">Set One</a>
  <a href="/threads/102-set-two/">Set Two</a>
  <a href="/threads/103-set-three/">Set Three</a>
</body>
</html>
"""


def test_validate_discovery_url_blocks_ssrf_and_http_in_prod(monkeypatch):
    monkeypatch.delenv("IMAGEX_TEST_ALLOW_LOCALHOST", raising=False)
    url, err = connector_autodiscover.validate_discovery_url("http://portal.example/")
    assert url is None and err == "https_required"

    url2, err2 = connector_autodiscover.validate_discovery_url("https://127.0.0.1/test")
    assert url2 is None and err2 == "blocked_private_host"

    url3, err3 = connector_autodiscover.validate_discovery_url("https://192.168.1.5/test")
    assert url3 is None and err3 == "blocked_private_host"


@pytest.mark.asyncio
async def test_autodiscover_video_portal_deep_item_url_and_persist(tmp_path: Path, monkeypatch):
    cfg = tmp_path / "connectors.local.json"
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg))
    monkeypatch.setenv("IMAGEX_TEST_ALLOW_LOCALHOST", "1")
    connector_registry.clear_connector_cache()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/video/abc1":
            return httpx.Response(200, text=VIDEO_WATCH_HTML)
        return httpx.Response(200, text=VIDEO_PORTAL_ROOT_HTML)

    transport = httpx.MockTransport(handler)
    res = await connector_autodiscover.autodiscover_connector_for_url(
        "https://portal.example/video/abc1",
        transport=transport,
    )
    assert res["ok"] is True
    assert res["autoDiscovered"] is True
    assert res["bundleKey"] == "videoPortals"
    assert res["level"] == "item"
    assert cfg.is_file()

    found = connector_registry.find_connector_for_url("https://portal.example/video/abc1")
    assert found is not None
    assert found.display_name == "StreamHub"
    assert found.search["videosPathTemplate"] == "/search?q={query}&page={page}"


@pytest.mark.asyncio
async def test_autodiscover_gallery_and_forum_archetypes(tmp_path: Path, monkeypatch):
    cfg = tmp_path / "connectors.local.json"
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg))
    monkeypatch.setenv("IMAGEX_TEST_ALLOW_LOCALHOST", "1")
    connector_registry.clear_connector_cache()

    gal_transport = httpx.MockTransport(lambda req: httpx.Response(200, text=GALLERY_ROOT_HTML))
    gal = await connector_autodiscover.autodiscover_connector_for_url(
        "https://gallery.example/",
        transport=gal_transport,
    )
    assert gal["ok"] is True
    assert gal["bundleKey"] == "catalogs"
    assert gal["level"] == "network"

    forum_transport = httpx.MockTransport(lambda req: httpx.Response(200, text=FORUM_ROOT_HTML))
    forum = await connector_autodiscover.autodiscover_connector_for_url(
        "https://board.example/",
        transport=forum_transport,
    )
    assert forum["ok"] is True
    assert forum["bundleKey"] == "forums"
    assert forum["level"] == "network"


def test_connector_bundle_import_export_delete_and_validation(tmp_path: Path, monkeypatch):
    cfg = tmp_path / "connectors.local.json"
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg))
    connector_registry.clear_connector_cache()

    sample_bundle = {
        "videoPortals": [
            {
                "id": "demo_portal",
                "displayName": "Demo Portal",
                "domains": ["demo.example"],
                "canonicalOrigin": "https://demo.example",
            }
        ]
    }
    imported = connector_autodiscover.import_connector_bundle(sample_bundle)
    assert imported["ok"] is True
    assert imported["importedIds"] == ["demo_portal"]

    exported = connector_autodiscover.export_connector_bundle()
    assert len(exported["videoPortals"]) == 1

    with pytest.raises(ValueError, match="invalid_bundle_schema"):
        connector_autodiscover.import_connector_bundle({"unexpectedKey": []})

    deleted = connector_autodiscover.delete_local_connector("demo_portal")
    assert deleted["removed"] is True
    assert connector_autodiscover.list_local_connectors_summary() == []


def test_builtin_platforms_exclude_slack_and_instagram():
    ids = {item["id"] for item in integrated_sources_service._BUILTIN_PLATFORMS}
    assert ids == {"youtube", "x", "pinterest", "imgur"}
