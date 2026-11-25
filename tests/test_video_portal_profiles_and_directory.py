"""Tests for generic VideoPortal discover, recent feed, JSON-LD dates, playlists, and directory adapter."""
import json
import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.test_video_portal_engine import _write_synthetic_portal_config


def _add_directory_config(cfg_path: Path) -> None:
    payload = json.loads(cfg_path.read_text(encoding="utf-8"))
    vp = payload["videoPortals"][0]
    vp["browse"]["directories"] = {
        "artists": {
            "pathTemplate": "/models/{page_zero}",
            "cardSelector": ".portal-dir-card",
            "linkSelector": ".profile-name a[href], .thumb-under a[href]",
            "titleSelector": ".profile-name",
            "rankSelector": ".profile-name strong",
            "thumbSelector": "img",
            "scriptImageRegex": r"<img[^>]+src=['\"]([^'\"]+)['\"]",
            "countSelector": ".with-sub",
            "pageBaseZero": True,
        }
    }
    cfg_path.write_text(json.dumps(payload), encoding="utf-8")


@pytest.mark.asyncio
async def test_video_portal_discover_scan_and_playlists(tmp_path, monkeypatch):
    cfg_path = _write_synthetic_portal_config(tmp_path)
    _add_directory_config(cfg_path)
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))
    from src.server.connector_registry import load_connector_bundle
    from src.server.profile_hub_service import (
        PlaylistVideosRequest,
        ProfileScanRequest,
        _scan_profile,
        get_playlist_videos,
    )

    load_connector_bundle(force_reload=True)

    root_html = """
    <html><body>
      <script>portal.conf = {"id_user": 88};</script>
      <div class="portal-title"><span class="name">Alice Studio</span></div>
      <div class="portal-avatar"><img src="https://cdn.portal.example/avatars/alice.jpg" /></div>
      <div class="portal-about">
        <p class="portal-bio">Indie visual reels</p>
        <p>Subscribers: 12,400</p>
        <p>Worked with: <a href="/channels/studio-alpha">Studio Alpha</a></p>
      </div>
    </body></html>
    """
    videos_p0 = {
        "nb_videos": 3,
        "nb_per_page": 2,
        "current_page": 0,
        "videos": [
            {
                "id": 101,
                "eid": "eid101",
                "u": "/video.eid101/clip_one",
                "tf": "Clip One Full",
                "i": "https://cdn.portal.example/t/101.jpg",
                "ipu": "https://cdn.portal.example/p/101.mp4",
                "d": "5 min",
                "n": "40k",
                "h": 1,
                "hm": "1080p",
                "pn": "Alice Studio",
                "pu": "/profiles/alice-studio",
            },
            {
                "id": 102,
                "eid": "eid102",
                "u": "/video.eid102/clip_two",
                "tf": "Clip Two Full",
                "i": "https://cdn.portal.example/t/102.jpg",
                "d": "3 min",
                "n": "15k",
                "h": 1,
                "pn": "Alice Studio",
                "pu": "/profiles/alice-studio",
            },
        ],
    }
    videos_p1 = {
        "nb_videos": 3,
        "nb_per_page": 2,
        "current_page": 1,
        "videos": [
            {
                "id": 103,
                "eid": "eid103",
                "u": "/video.eid103/clip_three",
                "tf": "Clip Three Full",
                "i": "https://cdn.portal.example/t/103.jpg",
                "d": "2 min",
                "n": "9k",
                "h": 0,
                "pn": "Alice Studio",
                "pu": "/profiles/alice-studio",
            }
        ],
    }
    shorts_p0 = {
        "nb_videos": 1,
        "nb_per_page": 20,
        "videos": [
            {
                "id": 201,
                "eid": "sh201",
                "u": "/video.sh201/short_one",
                "tf": "Quick Reel One",
                "i": "https://cdn.portal.example/t/s201.jpg",
                "d": "30 sec",
                "h": 1,
            }
        ],
    }
    albums_html = """
    <div class="portal-card portal-album">
      <a href="/profiles/alice-studio/photos/alb5"><img data-src="https://cdn.portal.example/a5.jpg" src="blank.gif" /></a>
      <p class="title"><a href="/profiles/alice-studio/photos/alb5">Studio Stills</a></p>
      <span class="album-count">8</span>
    </div>
    """
    playlists_html = """
    <div class="playlist-block">
      <a class="playlist-link" href="/favorite/fav77/best-picks"><img data-src="https://cdn.portal.example/f77.jpg" src="blank.gif" /></a>
      <p class="playlist-title"><a href="/favorite/fav77/best-picks">Best Picks</a></p>
      <span class="playlist-count">1</span>
    </div>
    """
    playlist_page_html = """
    <h1>Best Picks <span class="count">1</span></h1>
    <div class="portal-grid">
      <div class="portal-card" data-eid="eid101">
        <a href="/video.eid101/clip_one"><img data-src="https://cdn.portal.example/t/101.jpg" src="blank.gif" /></a>
        <p class="title"><a href="/video.eid101/clip_one" title="Clip One Full">Clip One</a></p>
        <span class="duration">5 min</span>
      </div>
    </div>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/profiles/alice-studio":
            return httpx.Response(200, text=root_html, headers={"content-type": "text/html"})
        if path == "/profiles/alice-studio/videos/best/0":
            return httpx.Response(200, json=videos_p0)
        if path == "/profiles/alice-studio/videos/best/1":
            return httpx.Response(200, json=videos_p1)
        if path == "/profiles/alice-studio/shorts/best/0":
            return httpx.Response(200, json=shorts_p0)
        if path == "/profiles/alice-studio/photos":
            return httpx.Response(200, text=albums_html, headers={"content-type": "text/html"})
        if path == "/profiles/alice-studio/favorites":
            return httpx.Response(200, text=playlists_html, headers={"content-type": "text/html"})
        if path == "/favorite/fav77/best-picks":
            return httpx.Response(200, text=playlist_page_html, headers={"content-type": "text/html"})
        return httpx.Response(404, text="not found")

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_async_client(transport=transport, **{k: v for k, v in kw.items() if k != "transport"}))

    res = await _scan_profile(ProfileScanRequest(url="https://m.portal.example/profiles/alice-studio/videos/best"))
    assert res["success"] is True
    assert res["profile_data"]["name"] == "Alice Studio"
    assert res["profile_data"]["entityKind"] == "creator"
    assert len(res["canonical_videos"]) == 3
    assert res["canonical_videos"][0]["previewVideoUrl"] == "https://cdn.portal.example/p/101.mp4"
    assert len(res["canonical_shorts"]) == 1
    assert len(res["canonical_albums"]) == 1
    assert len(res["canonical_playlists"]) == 1
    assert res["profile_data"]["relatedEntities"][0]["name"] == "Studio Alpha"

    pl_res = await get_playlist_videos(PlaylistVideosRequest(url="https://portal.example/favorite/fav77/best-picks"))
    assert pl_res["success"] is True
    assert pl_res["count"] == 1
    assert pl_res["videos"][0]["title"] == "Clip One Full"


@pytest.mark.asyncio
async def test_video_portal_recent_dates_and_directory_adapter(tmp_path, monkeypatch):
    cfg_path = _write_synthetic_portal_config(tmp_path)
    _add_directory_config(cfg_path)
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))
    from src.server.connector_registry import load_connector_bundle
    from src.server.profile_directory_manifest import recognize_profile_input
    from src.server.profile_hub_publication_dates import enrich_publication_dates
    from src.server.profile_hub_recent import read_recent_profile, recent_source

    load_connector_bundle(force_reload=True)

    assert recent_source("https://portal.example/profiles/alice-studio") == "vid_portal"
    assert recent_source("https://portal.example/studio_root") == "vid_portal"
    assert recent_source("https://portal.example/c/cinema-hd") == "vid_portal"
    assert recent_source("https://portal.example/tags/hdr-clips") == "vid_portal"

    adapter, kind = recognize_profile_input("https://portal.example/channels/studio-alpha")
    assert adapter.adapter_id == "vid_portal"
    assert kind == "profile"

    dir_adapter, dir_kind = recognize_profile_input("https://portal.example/models")
    assert dir_adapter.adapter_id == "vid_portal"
    assert dir_kind == "directory"

    dir_html = """
    <div class="portal-grid">
      <div class="portal-dir-card">
        <div class="thumb"><script>document.write('<img src="https://cdn.portal.example/m1.jpg" />');</script></div>
        <div class="thumb-under"><p class="profile-name"><strong>#1</strong> <a href="/models/model-one">Model One</a></p><span class="with-sub">42 videos</span></div>
      </div>
    </div>
    """
    dir_page = dir_adapter.parse("https://portal.example/models", dir_html)
    assert dir_page.loaded_count == 1
    assert dir_page.items[0].name == "Model One"
    assert dir_page.items[0].image_url == "https://cdn.portal.example/m1.jpg"

    root_cat_html = """
    <html><body>
      <h2 class="page-title">Cinema HD</h2>
      <div class="portal-grid">
        <div class="portal-card" data-eid="cat1">
          <a href="/video.cat1/opening_reel"><img data-src="https://cdn.portal.example/t/cat1.jpg" src="blank.gif" /></a>
          <p class="title"><a href="/video.cat1/opening_reel" title="Opening Reel">Opening Reel</a></p>
          <span class="duration">6 min</span>
        </div>
      </div>
      <div class="pagination"><a href="/c/cinema-hd/1">2</a></div>
    </body></html>
    """
    watch_html = """
    <html><head>
      <script type="application/ld+json">{"@type":"VideoObject","uploadDate":"2026-05-14T12:30:00Z"}</script>
    </head><body></body></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/c/cinema-hd":
            return httpx.Response(200, text=root_cat_html, headers={"content-type": "text/html"})
        if request.url.path == "/video.cat1/opening_reel":
            return httpx.Response(200, text=watch_html, headers={"content-type": "text/html"})
        return httpx.Response(404, text="")

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_async_client(transport=transport, **{k: v for k, v in kw.items() if k != "transport"}))

    recent = await read_recent_profile("https://portal.example/c/cinema-hd", page=1)
    assert recent["source"] == "vid_portal"
    assert recent["profile_data"]["entityKind"] == "category"
    assert recent["hasMore"] is True
    assert recent["nextPage"] == 2
    assert len(recent["canonical_videos"]) == 1

    profile_stub = {
        "source_url": "https://portal.example/c/cinema-hd",
        "canonical_videos": [{"originalUrl": "https://portal.example/video.cat1/opening_reel"}],
    }
    async with httpx.AsyncClient() as client:
        await enrich_publication_dates(profile_stub, client)
    assert profile_stub["canonical_videos"][0]["uploadedAt"] == "2026-05-14T12:30:00Z"


def test_set_favorite_profile_updates_existing_metadata(tmp_path, monkeypatch):
    import src.server.profile_favorites_service as fav_svc

    monkeypatch.setattr(fav_svc, "FAVORITES_FILE", tmp_path / "favorite_profiles.json")
    first = fav_svc.set_favorite_profile(
        {
            "url": "https://portal.example/channels/studio_alpha",
            "name": "Polluted Banner Title",
            "avatar_url": "https://cdn.portal.example/old.jpg",
            "source": "vid_portal",
        },
        favorited=True,
    )
    assert first["favorited"] is True
    assert first["profile"]["name"] == "Polluted Banner Title"

    updated = fav_svc.set_favorite_profile(
        {
            "url": "https://portal.example/channels/studio_alpha",
            "name": "Studio Alpha",
            "avatar_url": "https://cdn.portal.example/clean.jpg",
            "banner_url": "https://cdn.portal.example/banner.jpg",
            "entity_kind": "channel",
            "source": "vid_portal",
            "verified": True,
            "portal_info": {"country": "US", "website": "https://studioalpha.example/"},
        },
        favorited=True,
    )
    assert updated["favorited"] is True
    assert updated["profile"]["name"] == "Studio Alpha"
    assert updated["profile"]["avatar_url"] == "https://cdn.portal.example/clean.jpg"
    assert updated["profile"]["banner_url"] == "https://cdn.portal.example/banner.jpg"
    assert updated["profile"]["entity_kind"] == "channel"
    assert updated["profile"]["verified"] is True
    assert updated["profile"]["portal_info"]["website"] == "https://studioalpha.example/"
    assert len(fav_svc.load_favorite_profiles()) == 1

