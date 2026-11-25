import json
from pathlib import Path

import httpx
import pytest


def _write_test_connectors(tmp_path: Path, monkeypatch) -> None:
    from src.server.connector_registry import clear_connector_cache

    cfg = {
        "catalogs": [
            {
                "id": "cat_api",
                "displayName": "Alpha Gallery",
                "baseUrl": "https://alpha.example",
                "domains": ["alpha.example", "cdn.alpha.example"],
                "rootMode": "api_list",
                "catalogModes": ["popular", "recent", "albums", "gifs"],
                "defaultCategory": "popular",
                "browse": {
                    "apiListPath": "/popular/api/galleries/list/",
                    "searchApiPath": "/search/srch.php",
                    "rankingSubpaths": ["rating", "views", "likes"],
                    "albumPathSegment": "/galleries/",
                    "artistPathSegment": "/artists/",
                    "channelPathSegment": "/channels/",
                    "tagPathSegment": "/tags/",
                    "directories": {
                        "categories": "/",
                        "artists": "/artists/",
                        "channels": "/creators/",
                        "tags": "/tags/",
                    },
                    "thumbUpgrade": ["/460/", "/1280/"],
                },
                "selectors": {
                    "tile": "ul#tiles li.thumbwook",
                    "galleryMeta": ".gallery-info a[href], .models a[href]",
                    "avatar": ".model-info img, img.avatar",
                    "artistPrefixes": ["/artists/"],
                    "channelPrefixes": ["/channels/", "/creators/"],
                    "tagIgnorePaths": ["/", "/artists/", "/creators/", "/channels/", "/rating/"],
                },
            },
            {
                "id": "cat_first",
                "displayName": "Beta Categories",
                "baseUrl": "https://beta.example",
                "domains": ["beta.example", "cdn.beta.example"],
                "rootMode": "category_first",
                "catalogModes": ["recent", "albums", "photos"],
                "defaultCategory": "recent",
                "browse": {
                    "defaultSubfilterFallback": "studio-glam",
                    "searchPathTemplate": "/search/{slug}/",
                    "searchPagedTemplate": "/search/{slug}/{page}/",
                    "categoryPagedTemplate": "/{slug}/{page}/",
                    "albumPathSegment": "/pics/",
                    "artistPathSegment": "/artists/",
                    "directories": {
                        "categories": "/",
                        "artists": "/artists/",
                    },
                    "thumbUpgrade": ["/460/", "/1280/"],
                },
                "selectors": {
                    "galleryMeta": ".info a[href], .details a[href]",
                    "avatar": ".artist-info img, img.avatar",
                    "artistPrefixes": ["/artists/"],
                    "channelPrefixes": ["/channels/"],
                    "tagIgnorePaths": ["/", "/artists/", "/search/"],
                },
            },
        ],
        "forums": [],
        "imageHosts": [],
    }
    p = tmp_path / "connectors.catalog.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(p))
    clear_connector_cache()


@pytest.mark.asyncio
async def test_catalog_api_rows_reject_numeric_height_and_humanize_slug(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import get_connector_descriptor
    from src.server.gallery_catalog_engine import browse_catalog

    _write_test_connectors(tmp_path, monkeypatch)
    desc = get_connector_descriptor("cat_api")
    assert desc is not None

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                {
                    "gid": 40500037,
                    "h": 447,
                    "g_url": "https://alpha.example/galleries/solo-studio-claire-sunset-session-40500037/",
                    "t_url_460": "https://cdn.alpha.example/460/1/2/claire.jpg",
                    "desc": "",
                },
                {
                    "gid": 99123,
                    "h": 510,
                    "g_url": "https://alpha.example/galleries/beach-portrait-99123/",
                    "t_url_460": "https://cdn.alpha.example/460/3/4/beach.jpg",
                    "desc": "510",
                },
            ],
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        res = await browse_catalog(client, desc, "popular")

    assert len(res.items) == 2
    assert res.items[0]["title"] != "447"
    assert "Claire Sunset Session" in res.items[0]["title"]
    assert res.items[0]["previewHdUrl"] == "https://cdn.alpha.example/1280/1/2/claire.jpg"
    assert res.items[1]["title"] == "Beach Portrait"


@pytest.mark.asyncio
async def test_category_first_root_and_lazy_enrichment_and_entity_pagination(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import get_connector_descriptor
    from src.server.gallery_catalog_engine import (
        browse_catalog,
        clear_enrichment_cache,
        enrich_catalog_items,
        list_catalog_directory,
        read_catalog_entity_profile,
    )

    _write_test_connectors(tmp_path, monkeypatch)
    clear_enrichment_cache()
    hq_desc = get_connector_descriptor("cat_first")
    api_desc = get_connector_descriptor("cat_api")
    assert hq_desc is not None and api_desc is not None

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        calls.append(u)
        if u == "https://beta.example/":
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <a href="https://beta.example/studio-glam/"><img src="https://cdn.beta.example/cat1.jpg" alt="Studio Glam" /></a>
                  <a href="https://beta.example/outdoor-set/"><img src="https://cdn.beta.example/cat2.jpg" alt="Outdoor Set" /></a>
                </body></html>
                """,
            )
        if u == "https://beta.example/studio-glam/":
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <div class="grid">
                    <a href="https://beta.example/pics/claire-vance-golden-hour-101/">
                      <img src="https://cdn.beta.example/460/g1.jpg" alt="Golden Hour" />
                    </a>
                  </div>
                </body></html>
                """,
            )
        if u == "https://beta.example/pics/claire-vance-golden-hour-101/":
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <h1>Claire Vance Golden Hour</h1>
                  <div class="info">
                    <a href="https://beta.example/artists/claire-vance/">Claire Vance</a>
                    <a href="https://beta.example/studio-glam/">Studio Glam</a>
                  </div>
                  <div class="sidebar-directory">
                    <a href="https://beta.example/artists/unrelated-sidebar/">Unrelated Sidebar</a>
                  </div>
                  <a href="https://cdn.beta.example/1280/1.jpg"><img src="https://cdn.beta.example/460/1.jpg" /></a>
                  <a href="https://cdn.beta.example/1280/2.jpg"><img src="https://cdn.beta.example/460/2.jpg" /></a>
                </body></html>
                """,
            )
        if u == "https://alpha.example/artists/":
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <div class="content">
                    <a href="https://alpha.example/artists/claire-vance/">Claire Vance<span class="count">124</span></a>
                  </div>
                </body></html>
                """,
            )
        if u.startswith("https://alpha.example/artists/claire-vance/"):
            page_tag = "2" if "/2/" in u else "1"
            return httpx.Response(
                200,
                text=f"""
                <html><body>
                  <h1>Claire Vance</h1>
                  <div class="model-info">
                    <img src="https://cdn.alpha.example/av/claire.jpg" />
                    <a href="https://alpha.example/channels/sunset-house/">Sunset House</a>
                    <a href="https://alpha.example/portrait/">Portrait</a>
                  </div>
                  <ul id="tiles">
                    <li class="thumbwook">
                      <a href="https://alpha.example/galleries/claire-set-{page_tag}/">
                        <img data-src="https://cdn.alpha.example/460/s{page_tag}.jpg" alt="Claire Set {page_tag}" />
                      </a>
                    </li>
                  </ul>
                  <div class="pagination"><a href="https://alpha.example/artists/claire-vance/2/">2</a></div>
                </body></html>
                """,
            )
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        # 1. Category-first browse resolves fallback category galleries & directories
        hq_feed = await browse_catalog(client, hq_desc, "recent")
        assert len(hq_feed.items) == 1
        assert hq_feed.items[0]["albumUrl"] == "https://beta.example/pics/claire-vance-golden-hour-101/"

        cats_dir = await list_catalog_directory(client, hq_desc, "categories")
        assert [c["id"] for c in cats_dir["items"]] == ["studio-glam", "outdoor-set"]

        artists_dir = await list_catalog_directory(client, api_desc, "artists")
        assert artists_dir["items"][0]["name"] == "Claire Vance"
        assert artists_dir["items"][0]["count"] == 124

        # 2. Enrich gallery excludes sidebar links and caches repeat calls
        before_calls = len(calls)
        enriched1 = await enrich_catalog_items(client, [{"url": "https://beta.example/pics/claire-vance-golden-hour-101/", "source": "cat_first"}])
        meta = enriched1["https://beta.example/pics/claire-vance-golden-hour-101/"]
        assert meta["author"] == "Claire Vance"
        assert meta["authorUrl"] == "https://beta.example/artists/claire-vance/"
        assert [a["name"] for a in meta["artists"]] == ["Claire Vance"]
        assert "Unrelated Sidebar" not in str(meta)
        assert meta["photoCount"] == 2
        assert meta["photos"] == [
            "https://cdn.beta.example/1280/1.jpg",
            "https://cdn.beta.example/1280/2.jpg",
        ]
        assert len(meta["photoItems"]) == 2
        assert meta["photoItems"][0]["thumbnailUrl"] == "https://cdn.beta.example/460/1.jpg"
        assert meta["photoItems"][0]["url"] == "https://cdn.beta.example/1280/1.jpg"

        calls_after_first = len(calls)
        await enrich_catalog_items(client, [{"url": "https://beta.example/pics/claire-vance-golden-hour-101/", "source": "cat_first"}])
        assert len(calls) == calls_after_first  # served strictly from TTL cache

        # 3. Paginated artist profile (page 1 & page 2 + relatedEntities)
        prof1 = await read_catalog_entity_profile(client, api_desc, "https://alpha.example/artists/claire-vance/", page=1)
        assert prof1["name"] == "Claire Vance"
        assert prof1["entityKind"] == "artist"
        assert prof1["avatarUrl"] == "https://cdn.alpha.example/av/claire.jpg"
        assert prof1["hasMore"] is True
        assert prof1["nextPage"] == 2
        assert prof1["albums"][0]["needsEnrichment"] is True
        assert len(prof1["relatedEntities"]) >= 2

        prof2 = await read_catalog_entity_profile(client, api_desc, "https://alpha.example/artists/claire-vance/", page=2)
        assert prof2["albums"][0]["title"] == "Claire Set 2"


def test_directory_parsers_filter_legal_locale_pagination_and_return_string_tags(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import get_connector_descriptor
    from src.server.gallery_catalog_engine import (
        extract_gallery_entity_metadata,
        parse_catalog_api_rows,
        parse_catalog_categories,
        parse_catalog_directory,
    )

    _write_test_connectors(tmp_path, monkeypatch)
    api_desc = get_connector_descriptor("cat_api")
    assert api_desc is not None

    cat_html = """
    <html><body>
      <main>
        <a href="https://alpha.example/studio-portraits/"><img src="https://cdn.alpha.example/460/p.jpg" alt="Studio Portraits" /></a>
        <a href="https://alpha.example/2257.shtml">18 U.S.C. 2257 Record-Keeping Compliance Statement</a>
        <a href="https://alpha.example/cookie-policy/">Cookie Policy</a>
        <a href="https://alpha.example/dmca/">DMCA</a>
        <a href="https://alpha.example/videos/">Videos</a>
      </main>
      <footer>
        <a href="https://alpha.example/terms/">Terms</a>
        <a href="https://alpha.example/privacy/">Privacy Policy</a>
      </footer>
    </body></html>
    """
    cats = parse_catalog_categories(cat_html, api_desc)
    assert [c["id"] for c in cats] == ["studio-portraits"]

    chan_html = """
    <html><body>
      <a href="https://alpha.example/es/channels/studio-one/">Español</a>
      <a href="https://alpha.example/channels/6/">6</a>
      <a href="https://alpha.example/channels/studio-nova/" title="Studio Nova">
        <img src="https://cdn.alpha.example/460/ch.jpg" alt="Studio Nova" />
        <span class="g-count">301</span>
      </a>
    </body></html>
    """
    chans = parse_catalog_directory(chan_html, api_desc, "channels")
    assert len(chans) == 1
    assert chans[0]["name"] == "Studio Nova"
    assert chans[0]["count"] == 301

    meta_html = """
    <html><body>
      <h1>Sunset Editorial</h1>
      <div class="gallery-info">
        <a href="https://alpha.example/artists/claire-vance/">Claire Vance</a>
        <a href="https://alpha.example/sunset/">Sunset</a>
        <a href="https://alpha.example/editorial/">Editorial</a>
      </div>
    </body></html>
    """
    meta = extract_gallery_entity_metadata(meta_html, "https://alpha.example/galleries/sunset-1/", api_desc)
    assert meta["tags"] == ["Sunset", "Editorial"]
    assert all(isinstance(t, str) for t in meta["tags"])
    assert [t["url"] for t in meta["tagEntities"]] == ["https://alpha.example/sunset/", "https://alpha.example/editorial/"]

    rows = parse_catalog_api_rows(
        [{"gid": 1, "g_url": "https://alpha.example/galleries/sample-1/", "t_url": "https://cdn.alpha.example/300/1/sample.jpg"}],
        api_desc,
    )
    assert rows[0]["previewHdUrl"] == "https://cdn.alpha.example/1280/1/sample.jpg"


@pytest.mark.asyncio
async def test_read_catalog_gallery_detail_returns_photos_metadata_and_related(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import get_connector_descriptor
    from src.server.gallery_catalog_engine import (
        clear_gallery_detail_cache,
        read_catalog_entity_profile,
        read_catalog_gallery_detail,
    )

    _write_test_connectors(tmp_path, monkeypatch)
    clear_gallery_detail_cache()
    api_desc = get_connector_descriptor("cat_api")
    hq_desc = get_connector_descriptor("cat_first")
    assert api_desc is not None and hq_desc is not None

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if u == "https://alpha.example/galleries/sunset-1/":
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <h1>Sunset Editorial</h1>
                  <div class="gallery-info">
                    <a href="https://alpha.example/artists/claire-vance/">Claire Vance</a>
                    <a href="https://alpha.example/channels/sunset-house/">Sunset House</a>
                    <a href="https://alpha.example/portrait/">Portrait</a>
                  </div>
                  <div id="tiles">
                    <a href="https://cdn.alpha.example/1280/1/01.jpg"><img src="https://cdn.alpha.example/460/1/01.jpg" /></a>
                    <a href="https://cdn.alpha.example/1280/1/02.jpg"><img src="https://cdn.alpha.example/460/1/02.jpg" /></a>
                  </div>
                </body></html>
                """,
            )
        if "/search/srch.php" in u:
            return httpx.Response(
                200,
                json=[
                    {
                        "gid": 2,
                        "g_url": "https://alpha.example/galleries/claire-related-2/",
                        "t_url_460": "https://cdn.alpha.example/460/2/rel.jpg",
                        "desc": "Claire Related Set",
                    }
                ],
            )
        if u == "https://beta.example/studio-glam/":
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <h1>Studio Glam</h1>
                  <a href="https://beta.example/pics/set-a/"><img src="https://cdn.beta.example/460/a.jpg" alt="Set A" /></a>
                  <div class="pagination"><a href="/search/studio-glam/2/">Next</a></div>
                </body></html>
                """,
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        detail = await read_catalog_gallery_detail(client, api_desc, "https://alpha.example/galleries/sunset-1/")
        assert detail["ok"] is True
        assert detail["title"] == "Sunset Editorial"
        assert len(detail["photos"]) == 2
        assert (detail["photos"][0].get("originalUrl") or detail["photos"][0].get("url")) == "https://cdn.alpha.example/1280/1/01.jpg"
        assert [a["name"] for a in detail["artists"]] == ["Claire Vance"]
        assert [c["name"] for c in detail["channels"]] == ["Sunset House"]
        assert len(detail["relatedGalleries"]) == 1
        assert detail["relatedGalleries"][0]["title"] == "Claire Related Set"

        # Entity profile exposes nextPageUrl for category_first pagination
        prof = await read_catalog_entity_profile(client, hq_desc, "https://beta.example/studio-glam/")
        assert prof["hasMore"] is True
        assert prof["nextPageUrl"] == "https://beta.example/search/studio-glam/2/"


@pytest.mark.asyncio
async def test_search_catalog_applies_generic_subfilter_options(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import get_connector_descriptor
    from src.server.gallery_catalog_engine import search_catalog

    _write_test_connectors(tmp_path, monkeypatch)
    api_desc = get_connector_descriptor("cat_api")
    hq_desc = get_connector_descriptor("cat_first")
    assert api_desc is not None and hq_desc is not None

    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        seen_urls.append(u)
        if "/search/srch.php" in u:
            return httpx.Response(200, json=[{"gid": 10, "g_url": "https://alpha.example/galleries/claire-lingerie-10/", "t_url_460": "https://cdn.alpha.example/460/10.jpg", "desc": "Claire Lingerie"}])
        if "/search/claire-vance-latina/" in u:
            return httpx.Response(200, text='<html><body><a href="https://beta.example/pics/claire-latina-1/"><img src="https://cdn.beta.example/460/c1.jpg" alt="Claire Latina" /></a></body></html>')
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        r1 = await search_catalog(client, api_desc, "claire vance", "albums", options={"subfilter": "lingerie"})
        r2 = await search_catalog(client, hq_desc, "claire vance", "albums", options={"subfilter": "latina"})

    assert len(r1.items) == 1
    assert any("claire+vance+lingerie" in u or "claire%20vance%20lingerie" in u for u in seen_urls)
    assert len(r2.items) == 1
    assert any("/search/claire-vance-latina/" in u for u in seen_urls)
