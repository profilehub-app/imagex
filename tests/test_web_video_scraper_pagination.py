# -*- coding: utf-8 -*-
"""
Tests for Web Video Scraper Multi-Page Pagination Crawler.
Validates multi-page link seeking, limits enforcement, pagination deduplication, and endpoint contracts.
"""

import json

import pytest
from fastapi.testclient import TestClient
from playwright.async_api import Browser

from src.server import connector_registry
from src.server.server import app, normalize_incoming_scraper_url, ScanPageVideosRequest


@pytest.fixture
def serve_scraper_page(monkeypatch):
    new_context = Browser.new_context

    def register(url, handler):
        async def fixture_context(browser, **kwargs):
            context = await new_context(browser, **kwargs)
            await context.route("**/*", lambda route: route.abort())
            await context.route(url, handler)
            return context

        monkeypatch.setattr(Browser, "new_context", fixture_context)

    return register


@pytest.fixture
def portal_scraper(tmp_path, monkeypatch):
    config = tmp_path / "connectors.json"
    config.write_text(json.dumps({
        "videoPortals": [{
            "id": "fixture_portal",
            "canonicalOrigin": "https://portal.example",
            "domains": ["portal.example"],
            "scraper": {
                "profileRootPathRegex": r"^/creators/[a-z0-9_-]+/?$",
                "initialHash": "#clips",
                "idPathRegexes": [r"^/out/([a-z0-9]+)/", r"^/clips/([a-z0-9]+)/"],
                "canonicalLink": {
                    "pathRegex": r"^/out/([a-z0-9]+)/([a-z0-9-]+)$",
                    "pathTemplate": "/clips/$1/$2",
                },
                "pagination": {
                    "hashPrefix": "#clips",
                    "existingHashPrefix": "#clips",
                    "pageSuffix": ",page-",
                    "pageOffset": 1,
                },
            },
        }],
    }), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(config))
    connector_registry.clear_connector_cache()
    yield "https://portal.example"
    connector_registry.clear_connector_cache()


def test_normalize_incoming_scraper_url_uses_portal_profile_rules(portal_scraper):
    profile = f"{portal_scraper}/creators/sample"
    assert normalize_incoming_scraper_url(f" {profile}/ ") == f"{profile}#clips"
    assert normalize_incoming_scraper_url(f"{profile}#about") == f"{profile}#about"
    assert normalize_incoming_scraper_url(f"{profile}?tab=about") == f"{profile}?tab=about"
    assert normalize_incoming_scraper_url(f"{portal_scraper}/clips/abc/title") == f"{portal_scraper}/clips/abc/title"
    unrelated = "https://catalog.example/creators/sample"
    assert normalize_incoming_scraper_url(unrelated) == unrelated


@pytest.mark.parametrize("stream", [False, True])
def test_scan_endpoints_canonicalize_links_and_follow_fragment_pages(client, serve_scraper_page, portal_scraper, stream):
    async def serve_profile(route):
        await route.fulfill(
            content_type="text/html",
            body="""
                <title>Creator fixture</title>
                <main></main>
                <script>
                  function render() {
                    document.querySelector('main').innerHTML =
                      location.hash === '#clips,page-5'
                        ? '<a href="/clips/beta/second-clip">Second clip</a>'
                        : '<a href="/out/alpha/first-clip">First clip</a>'
                          + '<a href="/clips/alpha/first-clip">First clip duplicate</a>'
                          + '<nav class="pagination"><span class="next">'
                          + '<a href="#" data-page="4">Next</a></span></nav>';
                  }
                  render();
                  addEventListener('hashchange', render);
                </script>
            """,
        )

    serve_scraper_page(f"{portal_scraper}/creators/sample", serve_profile)
    payload = {"url": f"{portal_scraper}/creators/sample", "max_items": 2, "max_pages": 2}
    endpoint = "/api/video-scraper/scan-page"
    response = client.post(endpoint + ("-stream" if stream else ""), json=payload)
    assert response.status_code == 200
    if stream:
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert [event["type"] for event in events] == ["page", "page", "complete"]
        result = events[-1]
    else:
        result = response.json()

    assert result["success"] is True
    assert result["pages_scanned"] == 2
    assert [(video["id"], video["url"], video["page_found"]) for video in result["videos"]] == [
        ("alpha", f"{portal_scraper}/clips/alpha/first-clip", 1),
        ("beta", f"{portal_scraper}/clips/beta/second-clip", 2),
    ]


@pytest.fixture
def client():
    return TestClient(app)


def test_scan_page_videos_request_model_defaults():
    """Validates that ScanPageVideosRequest has generous multi-page defaults."""
    req = ScanPageVideosRequest(url="https://example.com/videos")
    assert req.url == "https://example.com/videos"
    assert req.max_items == 5000
    assert req.max_pages == 50

    custom_req = ScanPageVideosRequest(url="https://example.com/tag/test", max_items=120, max_pages=3)
    assert custom_req.max_items == 120
    assert custom_req.max_pages == 3


def test_scan_page_invalid_url(client):
    """Validates that scanning an invalid URL returns a 400 bad request."""
    response = client.post("/api/video-scraper/scan-page", json={"url": "ftp://invalid-url"})
    assert response.status_code == 400

    empty_response = client.post("/api/video-scraper/scan-page", json={"url": ""})
    assert empty_response.status_code == 400


@pytest.fixture
def paginated_catalog(serve_scraper_page):
    origin = "https://catalog.example"

    async def serve_catalog(route):
        first = route.request.url == f"{origin}/collection/"
        ids = range(64) if first else range(60, 124)
        cards = "".join(f'<a href="/watch/clip{i:03d}">Clip {i}</a>' for i in ids)
        next_link = '<link rel="next" href="/collection/2/">' if first else ""
        await route.fulfill(
            content_type="text/html",
            body=f"<title>Collection fixture</title>{next_link}<main>{cards}</main>",
        )

    serve_scraper_page(f"{origin}/collection/**", serve_catalog)
    return f"{origin}/collection/"


def test_scan_page_multi_page_seeker(client, paginated_catalog):
    payload = {"url": paginated_catalog, "max_items": 100, "max_pages": 2}
    response = client.post("/api/video-scraper/scan-page", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert data["success"] is True
    assert "videos" in data
    assert "pages_scanned" in data
    assert data["pages_scanned"] == 2
    assert len(data["videos"]) == 100
    assert data["total_found"] >= 100

    # Ensure videos from page 2 are tagged with page_found == 2
    p2_items = [v for v in data["videos"] if v.get("page_found") == 2]
    assert len(p2_items) > 0

    # Ensure no duplicate video IDs exist in the result
    video_ids = [v["id"] for v in data["videos"]]
    assert len(video_ids) == len(set(video_ids))


def test_scan_page_stream_realtime_events(client, paginated_catalog):
    """
    Validates that /api/video-scraper/scan-page-stream yields real-time SSE events
    as each page is crawled, allowing dynamic UI loading.
    """
    payload = {"url": paginated_catalog, "max_items": 75, "max_pages": 2}
    events = []
    with client.stream("POST", "/api/video-scraper/scan-page-stream", json=payload) as response:
        assert response.status_code == 200
        for line in response.iter_lines():
            if line and line.startswith("data:"):
                raw_json = line[5:].strip()
                if raw_json:
                    events.append(json.loads(raw_json))

    # Must contain page events and a complete event
    page_events = [ev for ev in events if ev.get("type") == "page"]
    complete_events = [ev for ev in events if ev.get("type") == "complete"]

    assert [ev["page_number"] for ev in page_events] == [1, 2]
    assert len(complete_events) == 1
    assert [len(ev["new_videos"]) for ev in page_events] == [64, 11]
    assert complete_events[0]["success"] is True
