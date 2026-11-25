import httpx
import pytest

from src.server.connector_registry import CatalogDescriptor, VideoPortalDescriptor
from src.server.gallery_catalog_engine import parse_catalog_categories, search_catalog
from src.server.video_portal_engine import parse_portal_directory_items, search_video_portal


def test_category_covers_survive_text_links_and_anchor_cards():
    catalog = CatalogDescriptor("catalog", "Catalog", "https://catalog.example")
    categories = parse_catalog_categories("""
        <a href="/portraits/">Portraits</a>
        <a href="/portraits/"><picture>
          <source data-srcset="/covers/portraits.webp 1x, /covers/portraits-large.webp 2x">
          <img src="data:image/gif;base64,AA==" alt="Portraits">
        </picture></a>
        <a href="/travel/">Travel</a>
    """, catalog)
    assert [(item["id"], item["avatar"]) for item in categories] == [
        ("portraits", "https://catalog.example/covers/portraits.webp"), ("travel", None),
    ]

    portal = VideoPortalDescriptor("portal", "Portal", "https://portal.example", browse={
        "directories": {"categories": {"cardSelector": "a.directory-item"}},
    })
    result = parse_portal_directory_items("""
        <a class="directory-item" href="/highlights" style="background-image:url('/covers/highlights.jpg')">
          Highlights
        </a>
    """, "https://portal.example/", portal, "categories")
    assert result["items"][0]["thumbnailUrl"] == "https://portal.example/covers/highlights.jpg"


@pytest.mark.asyncio
async def test_catalog_profile_search_queries_native_directory_endpoint():
    catalog = CatalogDescriptor("catalog", "Catalog", "https://catalog.example", browse={
        "directories": {"artists": {
            "pathTemplate": "/artists/",
            "searchPathTemplate": "/find?name={query_plus}&page={page}",
        }},
    })

    def upstream(request: httpx.Request):
        assert request.url.path == "/find"
        assert request.url.params["name"] == "Mara São"
        html = '<a href="/artists/mara-sao/">Mara São</a>'
        return httpx.Response(200, text=html)

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        result = await search_catalog(client, catalog, "Mara São", "profiles")

    assert [profile["name"] for profile in result.profiles] == ["Mara São"]
    assert not result.has_more


@pytest.mark.asyncio
async def test_profile_search_resumes_remote_pages_after_empty_batch():
    portal = VideoPortalDescriptor("portal", "Portal", "https://portal.example", browse={
        "directories": {"artists": {
            "pathTemplate": "/people/{page}", "cardSelector": ".directory-item", "pageBaseZero": False,
        }},
    }, search={"suggestPathTemplate": "/suggest?name={query_plus}"})
    visited = []

    def upstream(request: httpx.Request):
        if request.url.path == "/suggest":
            return httpx.Response(200, json={"data": {}})
        page = int(request.url.path.rsplit("/", 1)[-1])
        visited.append(page)
        if page == 8:
            return httpx.Response(200, text='<a class="directory-item" href="/people/mara-sao">Mara São</a>')
        return httpx.Response(200, text=f"""
            <a class="directory-item" href="/people/artist-{page}">Artist {page}</a>
            <a rel="next" href="/people/{page + 1}">Next</a>
        """)

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        first = await search_video_portal(client, portal, "mara sao", "profiles")
        assert not first.profiles
        assert first.has_more and first.next_cursor
        second = await search_video_portal(client, portal, "mara sao", "profiles", cursor=first.next_cursor)

    assert visited == list(range(1, 9))
    assert [profile["name"] for profile in second.profiles] == ["Mara São"]
    assert not second.has_more and second.next_cursor is None
