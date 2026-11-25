"""Tests for VideoPortalBrowseProvider, VideoPortalSearchProvider, /directory, /browse-sources, /search-sources."""
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.test_video_portal_engine import _write_synthetic_portal_config


def _configure_full_browse_and_search(cfg_path: Path) -> None:
    payload = json.loads(cfg_path.read_text(encoding="utf-8"))
    vp = payload["videoPortals"][0]
    vp["browse"] = {
        "feeds": {
            "recent": "/new/{page_zero}",
            "latest": "/new/{page_zero}",
            "popular": "/best/{page_zero}",
            "verified": "/verified/{page_zero}",
        },
        "dynamicSubfilters": {
            "selector": "#dyn-cat-strip a[href^='/c/']",
            "maxItems": 10,
        },
        "pageBaseZero": True,
        "directories": {
            "artists": {
                "pathTemplate": "/models/{page_zero}",
                "cardSelector": ".portal-dir-card",
                "linkSelector": ".thumb-under a[href]",
                "titleSelector": ".profile-name",
                "scriptImageRegex": r"<img[^>]+src=['\"]([^'\"]+)['\"]",
                "countSelector": ".with-sub",
                "verifiedSelector": ".verified-badge",
                "rankSelector": ".rank-badge",
                "pageBaseZero": True,
            },
            "tags": {
                "pathTemplate": "/tags",
                "cardSelector": "#tags li a[href^='/tags/']",
                "titleSelector": "a",
                "countSelector": ".navbadge",
                "excludeHrefRegex": r"^/tags/(?:[a-z0-9]{1,2}|09)$",
                "minSlugLength": 3,
                "pageBaseZero": False,
            },
        },
    }
    vp["search"] = {
        "videosPathTemplate": "/?k={query}&p={page_zero}",
        "playlistsPathTemplate": "/playlists?k={query}&p={page_zero}",
        "suggestPathTemplate": "/search-suggest/{query}",
        "suggestEntityRoutes": {
            "channel": "/channels/{slug}",
            "pornstar": "/models/{slug}",
            "model": "/models/{slug}",
        },
        "sortParams": {
            "recent": "&sort=uploaddate",
            "popular": "&sort=rating",
        },
        "pageBaseZero": True,
    }
    cfg_path.write_text(json.dumps(payload), encoding="utf-8")


def test_browse_directory_and_omni_search_endpoints(tmp_path, monkeypatch):
    cfg_path = _write_synthetic_portal_config(tmp_path)
    _configure_full_browse_and_search(cfg_path)
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))
    from src.server import server
    from src.server.connector_registry import load_connector_bundle

    load_connector_bundle(force_reload=True)

    browse_html = """
    <html><body>
      <div id="dyn-cat-strip"><a href="/c/cinema-hd">Cinema HD</a></div>
      <div class="portal-grid">
        <div class="portal-card" data-eid="br101">
          <a href="/video.br101/mountain_dawn"><img data-src="https://cdn.portal.example/t/br101.jpg" data-pvv="https://cdn.portal.example/p/br101.mp4" src="blank.gif" /></a>
          <p class="title"><a href="/video.br101/mountain_dawn" title="Mountain Dawn 4K">Mountain Dawn...</a></p>
          <p class="metadata"><span class="duration">11 min</span><a href="/channels/alpine-films"><span class="name">Alpine Films</span></a><span class="views">310k Views</span></p>
        </div>
      </div>
      <div class="pagination"><a href="/new/1">2</a></div>
    </body></html>
    """
    artists_dir_html = """
    <html><body>
      <div class="portal-grid">
        <div class="portal-dir-card">
          <div class="thumb"><script>document.write('<img src="https://cdn.portal.example/profiles/p1.jpg" />');</script></div>
          <span class="rank-badge">#4</span>
          <span class="verified-badge">V</span>
          <div class="thumb-under"><a href="/models/elena-nova"><span class="profile-name">Elena Nova</span></a><span class="with-sub">85 videos</span></div>
        </div>
      </div>
      <div class="pagination"><a href="/models/1">2</a></div>
    </body></html>
    """
    tags_dir_html = """
    <html><body>
      <ul id="tags">
        <li><a href="/tags/a">A</a></li>
        <li><a href="/tags/09">0-9</a></li>
        <li><a href="/tags/cinematic-4k">Cinematic 4K <span class="navbadge">12,500</span></a></li>
      </ul>
    </body></html>
    """
    search_videos_html = """
    <html><body>
      <div class="portal-grid">
        <div class="portal-card" data-eid="sr201">
          <a href="/video.sr201/sunset_search"><img data-src="https://cdn.portal.example/t/sr201.jpg" src="blank.gif" /></a>
          <p class="title"><a href="/video.sr201/sunset_search" title="Sunset Search Match">Sunset Search Match</a></p>
          <p class="metadata"><span class="duration">4 min</span><a href="/studio_root"><span class="name">Studio Root</span></a></p>
        </div>
      </div>
      <div class="pagination"><a href="/?k=sunset&p=1">2</a></div>
    </body></html>
    """
    suggest_json = {
        "result": True,
        "data": {
            "keywords": [{"N": "sunset glow", "R": 120}],
            "pornstar": [
                {"N": "Sunset Studio", "F": "sunset-studio", "T": "channel", "MV": 90, "P": "https://cdn.portal.example/ch/s.jpg"},
                {"N": "Sunny Star", "F": "sunny-star", "T": "pornstar", "MV": 45, "P": "https://cdn.portal.example/pr/s.jpg"},
            ],
        },
    }
    playlists_search_html = """
    <html><body>
      <div class="playlist-block">
        <a class="playlist-link" href="/favorite/pl55/sunset-mix"><img data-src="https://cdn.portal.example/pl/55.jpg" src="blank.gif" /></a>
        <p class="playlist-title"><a href="/favorite/pl55/sunset-mix">Sunset Mix</a></p>
        <span class="playlist-count">18 videos</span>
      </div>
    </body></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        qs = str(request.url.query)
        if path in ("/new/0", "/new"):
            return httpx.Response(200, text=browse_html, headers={"content-type": "text/html"})
        if path in ("/models/0", "/models"):
            return httpx.Response(200, text=artists_dir_html, headers={"content-type": "text/html"})
        if path == "/tags":
            return httpx.Response(200, text=tags_dir_html, headers={"content-type": "text/html"})
        if path == "/" and "k=sunset" in qs:
            return httpx.Response(200, text=search_videos_html, headers={"content-type": "text/html"})
        if path == "/search-suggest/sunset":
            return httpx.Response(200, json=suggest_json)
        if path == "/playlists" and "k=sunset" in qs:
            return httpx.Response(200, text=playlists_search_html, headers={"content-type": "text/html"})
        return httpx.Response(404, text="not found")

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_async_client(transport=transport, **{k: v for k, v in kw.items() if k != "transport"}))

    client = TestClient(server.app)

    bs = client.get("/api/profile-hub/timeline/browse-sources").json()
    vp_src = next((s for s in bs["sources"] if s["source_id"] == "vid_portal"), None)
    assert vp_src is not None
    assert vp_src["icon_kind"] == "video_portal"
    assert vp_src["accentColor"] == "#e11d48"
    assert vp_src["urlHints"]["videoPathRegex"]
    assert vp_src["capabilities"]["archetype"] == "video_portal"

    ss = client.get("/api/profile-hub/timeline/search-sources").json()
    vp_search_src = next((s for s in ss["sources"] if s["id"] == "vid_portal"), None)
    assert vp_search_src is not None
    assert vp_search_src["urlHints"]["playlistPathRegex"]

    br = client.post(
        "/api/profile-hub/timeline/browse",
        json={"source": "vid_portal", "category": "recent"},
    ).json()
    assert len(br["items"]) == 1
    assert br["items"][0]["title"] == "Mountain Dawn 4K"
    assert br["items"][0]["previewVideoUrl"] == "https://cdn.portal.example/p/br101.mp4"
    assert br["has_more"] is True

    art_dir = client.get("/api/profile-hub/timeline/directory", params={"source": "vid_portal", "kind": "artists", "page": 1}).json()
    assert len(art_dir["items"]) == 1
    assert art_dir["items"][0]["name"] == "Elena Nova"
    assert art_dir["items"][0]["thumbnailUrl"] == "https://cdn.portal.example/profiles/p1.jpg"
    assert art_dir["items"][0]["verified"] is True
    assert art_dir["items"][0]["rank"] == 4
    assert art_dir["hasMore"] is True

    tag_dir = client.get("/api/profile-hub/timeline/directory", params={"source": "vid_portal", "kind": "tags", "page": 1}).json()
    assert len(tag_dir["items"]) == 1
    assert tag_dir["items"][0]["name"] == "Cinematic 4K"
    assert tag_dir["items"][0]["count"] == 12500

    search_res = client.post(
        "/api/profile-hub/timeline/omni-search",
        json={"query": "sunset", "source": "vid_portal", "category": "all"},
    ).json()
    profiles = search_res["creators"]
    items = search_res["posts"]
    assert len(profiles) == 2
    assert any(p["entityKind"] == "channel" and "/channels/sunset-studio" in p["profileUrl"] for p in profiles)
    assert any(p["entityKind"] == "creator" and "/models/sunny-star" in p["profileUrl"] for p in profiles)
    assert any(i["title"] == "Sunset Search Match" for i in items)
    assert any(i.get("type") == "playlist" and i["title"] == "Sunset Mix" for i in items)
