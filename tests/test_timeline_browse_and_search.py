import json
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest


def _setup_browse_search_connectors(tmp_path: Path, monkeypatch) -> None:
    from src.server.connector_registry import clear_connector_cache

    cfg = {
        "catalogs": [
            {
                "id": "cat_alpha",
                "displayName": "Alpha Gallery",
                "baseUrl": "https://alpha.example",
                "domains": ["alpha.example", "cdn.alpha.example"],
                "iconKind": "gallery_catalog",
                "rootMode": "api_list",
                "catalogModes": ["popular", "recent", "albums", "gifs"],
                "defaultCategory": "popular",
                "searchCategories": ["all", "profiles", "albums", "gifs"],
                "capabilities": {
                    "archetype": "gallery_catalog",
                    "supportsComments": False,
                    "supportsSourceLikes": False,
                    "supportsVideosTab": False,
                    "supportsPlaylists": False,
                    "supportsArtistProfiles": True,
                    "supportsDirectories": True,
                    "directoryKinds": ["categories", "artists", "channels", "tags"],
                },
                "browse": {
                    "apiListPath": "/popular/api/galleries/list/",
                    "searchApiPath": "/search/srch.php",
                    "rankingSubpaths": ["rating", "views", "likes"],
                    "albumPathSegment": "/galleries/",
                    "artistPathSegment": "/artists/",
                    "channelPathSegment": "/channels/",
                    "directories": {
                        "categories": "/",
                        "artists": "/artists/",
                        "channels": "/creators/",
                    },
                    "thumbUpgrade": ["/460/", "/1280/"],
                },
                "selectors": {
                    "tile": "ul#tiles li.thumbwook",
                    "galleryMeta": ".gallery-info a[href], .models a[href]",
                    "artistPrefixes": ["/artists/"],
                    "channelPrefixes": ["/channels/"],
                },
            },
            {
                "id": "cat_beta",
                "displayName": "Beta Categories",
                "baseUrl": "https://beta.example",
                "baseUrlEnv": "BETA_CATALOG_BASE_URL",
                "domains": ["beta.example", "cdn.beta.example"],
                "rootMode": "category_first",
                "catalogModes": ["recent", "albums", "photos"],
                "defaultCategory": "recent",
                "searchCategories": ["all", "profiles", "albums"],
                "browse": {
                    "defaultSubfilterFallback": "studio-glam",
                    "searchPathTemplate": "/search/{slug}/",
                    "searchPagedTemplate": "/search/{slug}/{page}/",
                    "albumPathSegment": "/pics/",
                    "artistPathSegment": "/artists/",
                    "directories": {"categories": "/", "artists": "/artists/"},
                    "thumbUpgrade": ["/460/", "/1280/"],
                },
            },
        ],
        "forums": [
            {
                "id": "board_one",
                "displayName": "Media Board",
                "baseUrl": "https://board.example",
                "domains": ["board.example"],
                "iconKind": "forum_board",
                "catalogModes": ["albums", "videos", "gifs", "posts", "recent"],
                "defaultCategory": "albums",
                "searchCategories": ["all", "profiles", "albums", "videos", "gifs", "posts"],
                "forum": {
                    "indexPath": "/forum.php",
                    "searchPath": "/search.php?search_type=1",
                    "searchProcessPath": "/search.php?contenttype=1&do=process",
                    "boardRoles": {
                        "album_sets": ["10"],
                        "artist_collections": ["20"],
                        "video_releases": ["30"],
                    },
                    "searchFlagsByCategory": {
                        "albums": {"imgsearch": "1", "showposts": "0"},
                        "videos": {"vidsearch": "1", "showposts": "0"},
                        "posts": {"showposts": "1"},
                        "profiles": {"forumchoice": ["20"], "childforums": "1"},
                    },
                    "mirrorHosts": ["rapidgator.net", "k2s.cc"],
                },
            }
        ],
        "imageHosts": [],
    }
    p = tmp_path / "connectors.browse.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(p))
    clear_connector_cache()


def test_browse_sources_endpoint_lists_configured_connectors_with_capabilities(tmp_path: Path, monkeypatch):
    from src.server import timeline_omni_service

    _setup_browse_search_connectors(tmp_path, monkeypatch)
    app = FastAPI()
    app.include_router(timeline_omni_service.router)
    client = TestClient(app)

    res = client.get("/api/profile-hub/timeline/browse-sources")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    by_id = {src["source_id"]: src for src in body["sources"]}
    assert {"cat_alpha", "cat_beta", "board_one"}.issubset(by_id.keys())
    assert by_id["cat_alpha"]["capabilities"]["supportsComments"] is False
    assert by_id["cat_alpha"]["capabilities"]["supportsPlaylists"] is False
    assert by_id["board_one"]["capabilities"]["supportsThreadReader"] is True


def test_browse_directory_enrich_boards_and_thread_view_endpoints(tmp_path: Path, monkeypatch):
    from src.server import timeline_omni_service
    from src.server.gallery_catalog_engine import clear_enrichment_cache

    _setup_browse_search_connectors(tmp_path, monkeypatch)
    clear_enrichment_cache()
    monkeypatch.setenv("BETA_CATALOG_BASE_URL", "https://custom-beta.example")
    timeline_omni_service._BROWSE_CACHE.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "alpha.example/popular/api/galleries/list/" in u:
            return httpx.Response(
                200,
                json=[
                    {
                        "gid": 1001,
                        "h": 447,
                        "g_url": "https://alpha.example/galleries/claire-popular-1001/",
                        "t_url_460": "https://cdn.alpha.example/460/1/2/p1.jpg",
                        "desc": "",
                    }
                ],
            )
        if u == "https://alpha.example/galleries/claire-popular-1001/":
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <h1>Claire Popular 1001</h1>
                  <div class="gallery-info">
                    <a href="https://alpha.example/artists/claire-vance/">Claire Vance</a>
                    <a href="https://alpha.example/channels/velvet-studio/">Velvet Studio</a>
                  </div>
                  <a href="https://cdn.alpha.example/1280/1/2/1.jpg"><img src="x" /></a>
                </body></html>
                """,
            )
        if u == "https://alpha.example/artists/":
            return httpx.Response(
                200,
                text='<a href="https://alpha.example/artists/claire-vance/">Claire Vance</a>',
            )
        if "custom-beta.example/studio-glam/" in u:
            return httpx.Response(
                200,
                text='<html><body><a href="https://custom-beta.example/pics/hq-set-1/"><img data-src="https://cdn.beta.example/460/5/6/hq1.jpg" alt="HQ Set 1" /></a></body></html>',
            )
        if u == "https://board.example/forum.php":
            return httpx.Response(
                200,
                text='<html><body><ol id="forums"><li class="forumbit_nopost"><h2 class="forumtitle"><a>Photo Sets</a></h2><a href="forums/10-Studio-Sets">Studio Sets</a></li></ol></body></html>',
            )
        if "board.example/forums/10-Studio-Sets" in u:
            return httpx.Response(
                200,
                text='<html><body><li class="threadbit"><a class="title" href="threads/5511-Pack-x30">Pack x30</a><span>Replies: 3</span></li></body></html>',
            )
        if u == "https://board.example/threads/5511-Pack-x30":
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <h1>Pack x30</h1>
                  <div id="post_1"><blockquote class="postcontent">
                    Post details <img src="https://img3.viewer.example/poster.jpg" />
                    <a href="https://rapidgator.net/file/abc/pack.zip">Rapidgator</a>
                  </blockquote></div>
                </body></html>
                """,
            )
        if "search.php" in u and request.method == "POST":
            return httpx.Response(200, text="<html><body>No results</body></html>")
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    def fake_async_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(timeline_omni_service.httpx, "AsyncClient", fake_async_client)

    app = FastAPI()
    app.include_router(timeline_omni_service.router)
    client = TestClient(app)

    r_pp = client.post("/api/profile-hub/timeline/browse", json={"source": "cat_alpha", "category": "popular"})
    assert r_pp.status_code == 200
    assert r_pp.json()["items"][0]["title"] == "Claire Popular"

    r_enrich = client.post(
        "/api/profile-hub/timeline/catalog-enrich",
        json={"items": [{"url": "https://alpha.example/galleries/claire-popular-1001/", "source": "cat_alpha"}]},
    )
    assert r_enrich.status_code == 200
    assert r_enrich.json()["metadata"]["https://alpha.example/galleries/claire-popular-1001/"]["author"] == "Claire Vance"

    r_dir = client.get("/api/profile-hub/timeline/directory?source=cat_alpha&kind=artists")
    assert r_dir.status_code == 200
    assert r_dir.json()["items"][0]["name"] == "Claire Vance"

    r_hq = client.post("/api/profile-hub/timeline/browse", json={"source": "cat_beta", "category": "recent"})
    assert r_hq.status_code == 200
    assert r_hq.json()["resolved_origin"] == "https://custom-beta.example"
    assert r_hq.json()["items"][0]["albumUrl"] == "https://custom-beta.example/pics/hq-set-1/"

    r_boards = client.get("/api/profile-hub/timeline/forum-boards?source=board_one")
    assert r_boards.status_code == 200
    assert r_boards.json()["sections"][0]["boards"][0]["id"] == "10-Studio-Sets"

    r_vp = client.post("/api/profile-hub/timeline/browse", json={"source": "board_one", "category": "albums"})
    assert r_vp.status_code == 200
    assert r_vp.json()["items"][0]["albumUrl"] == "https://board.example/threads/5511-Pack-x30"

    r_tv = client.post("/api/profile-hub/timeline/thread-view", json={"url": "https://board.example/threads/5511-Pack-x30"})
    assert r_tv.status_code == 200
    assert r_tv.json()["posts"][0]["releaseLinks"][0]["host"] == "rapidgator.net"


@pytest.mark.asyncio
async def test_omni_search_providers_configured_catalogs_and_forum(tmp_path: Path, monkeypatch):
    from src.server import timeline_omni_service
    from src.server.timeline_search_providers import get_search_provider

    _setup_browse_search_connectors(tmp_path, monkeypatch)
    timeline_omni_service._OMNI_SEARCH_CACHE.clear()

    async def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "alpha.example/search/srch.php" in u:
            return httpx.Response(
                200,
                json=[{"gid": 5001, "desc": "Claire Alpha Match", "g_url": "https://alpha.example/galleries/claire-alpha-5001/", "t_url_460": "https://cdn.alpha.example/460/a.jpg"}],
            )
        if u == "https://alpha.example/artists/":
            return httpx.Response(200, text='<a href="https://alpha.example/artists/claire-vance/">Claire Vance</a>')
        if "beta.example/search/claire/" in u:
            return httpx.Response(200, text='<a href="https://beta.example/pics/claire-hq-1/"><img data-src="https://cdn.beta.example/460/b.jpg" alt="Claire HQ" /></a>')
        if u == "https://beta.example/artists/":
            return httpx.Response(200, text='<a href="https://beta.example/artists/claire-vance/">Claire Vance</a>')
        if request.method == "POST" and "board.example/search.php" in u:
            return httpx.Response(
                200,
                text='<li class="threadbit"><a class="title" href="https://board.example/threads/71001-Claire-Pack">Claire Pack</a></li><div class="pagenav"><a href="https://board.example/search.php?searchid=9911&page=2">2</a></div>',
            )
        if "searchid=9911&pp=25&page=2" in u:
            return httpx.Response(
                200,
                text='<li class="threadbit"><a class="title" href="https://board.example/threads/71002-Claire-Pack-2">Claire Pack 2</a></li>',
            )
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    def fake_async_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(timeline_omni_service.httpx, "AsyncClient", fake_async_client)

    app = FastAPI()
    app.include_router(timeline_omni_service.router)
    client = TestClient(app)

    src_res = client.get("/api/profile-hub/timeline/search-sources")
    assert src_res.status_code == 200
    src_ids = {s["id"] for s in src_res.json()["sources"]}
    assert {"cat_alpha", "cat_beta", "board_one"}.issubset(src_ids)

    v_prov = get_search_provider("board_one")
    assert v_prov is not None
    async with httpx.AsyncClient(transport=transport) as aclient:
        vp1 = await v_prov.search(aclient, "claire", "albums")
        assert vp1.items[0]["albumUrl"] == "https://board.example/threads/71001-Claire-Pack"
        assert vp1.has_more is True and vp1.next_cursor
        vp2 = await v_prov.search(aclient, "claire", "albums", cursor=vp1.next_cursor)
        assert vp2.items[0]["albumUrl"] == "https://board.example/threads/71002-Claire-Pack-2"

    omni_pp = client.post("/api/profile-hub/timeline/omni-search", json={"query": "claire", "source": "cat_alpha"})
    assert omni_pp.status_code == 200
    assert len(omni_pp.json()["sections"]["albums"]) >= 1
    assert len(omni_pp.json()["sections"]["profiles"]) >= 1
