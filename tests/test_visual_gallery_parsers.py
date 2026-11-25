import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx


def _setup_parser_connectors(tmp_path: Path, monkeypatch) -> None:
    from src.server.connector_registry import clear_connector_cache

    cfg = {
        "catalogs": [
            {
                "id": "cat_alpha",
                "displayName": "Alpha Gallery",
                "baseUrl": "https://alpha.example",
                "domains": ["alpha.example", "cdn.alpha.example"],
                "browse": {"thumbUpgrade": ["/460/", "/1280/"]},
            },
            {
                "id": "cat_beta",
                "displayName": "Beta Categories",
                "baseUrl": "https://beta.example",
                "domains": ["beta.example", "cdn.beta.example"],
                "rootMode": "category_first",
                "browse": {"thumbUpgrade": ["/460/", "/1280/"]},
            },
        ],
        "forums": [
            {
                "id": "board_one",
                "displayName": "Media Board",
                "baseUrl": "https://board.example",
                "domains": ["board.example"],
            }
        ],
        "imageHosts": [
            {
                "id": "viewer_one",
                "domains": ["viewer-one.example"],
                "viewerPathPrefixes": ["/show/"],
                "directHostRegex": "^img\\d*\\.viewer-one\\.example$",
                "directPathPrefixes": ["/images/", "/thumbs/"],
            },
            {
                "id": "viewer_two",
                "domains": ["viewer-two.example"],
                "viewerPathPrefixes": ["/i/"],
                "directHostRegex": "^i\\d+\\.viewer-two\\.example$",
                "directPathPrefixes": ["/u/i/", "/i0"],
            },
        ],
    }
    p = tmp_path / "connectors.parsers.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(p))
    clear_connector_cache()


def test_parse_album_page_catalog_variants(tmp_path: Path, monkeypatch):
    from src.server.profile_hub_workers import parse_album_page_lexbor

    _setup_parser_connectors(tmp_path, monkeypatch)

    pp_html = """
    <html><head><title>Claire Gallery</title></head><body>
      <h1>Studio Velvet 12</h1>
      <div class="gallery-info">
        <a href="/artists/claire-vance/">Claire Vance</a>
        <a href="/channels/velvet-studio/">Velvet Studio</a>
        <a href="/lingerie/">Lingerie</a>
      </div>
      <ul id="tiles">
        <li class="thumbwook">
          <a class="rel-link" href="https://cdn.alpha.example/1280/7/862/8025/8025_001.jpg">
            <img src="https://static.alpha.example/style/img/1px.png"
                 data-src="https://cdn.alpha.example/460/7/862/8025/8025_001.jpg"
                 alt="Velvet Photo 1" />
          </a>
        </li>
      </ul>
    </body></html>
    """
    res_pp = parse_album_page_lexbor(pp_html, "https://alpha.example/galleries/velvet-12/")
    assert res_pp["count"] == 1
    assert res_pp["photos"][0]["originalUrl"] == "https://cdn.alpha.example/1280/7/862/8025/8025_001.jpg"
    assert res_pp["photos"][0]["thumbnailUrl"] == "https://cdn.alpha.example/460/7/862/8025/8025_001.jpg"
    assert "Claire Vance" in res_pp["models"]
    assert "Velvet Studio" in res_pp["channels"]
    assert res_pp["authorUrl"] == "https://alpha.example/artists/claire-vance/"

    hq_html = """
    <html><head><title>HQ Photo Set</title></head><body>
      <h1>HQ Gold Collection</h1>
      <div class="photos">
        <a href="https://cdn.beta.example/1280/1/2/set_01.jpg">
          <img src="data:image/png;base64,AAAA" data-src="https://cdn.beta.example/460/1/2/set_01.jpg" alt="HQ 1" />
        </a>
      </div>
    </body></html>
    """
    res_hq = parse_album_page_lexbor(hq_html, "https://beta.example/pics/hq-gold-1/")
    assert res_hq["count"] == 1
    assert res_hq["photos"][0]["originalUrl"] == "https://cdn.beta.example/1280/1/2/set_01.jpg"


def test_parse_album_page_forum_viewers_and_pagination(tmp_path: Path, monkeypatch):
    from src.server.profile_hub_workers import parse_album_page_lexbor

    _setup_parser_connectors(tmp_path, monkeypatch)

    forum_html = """
    <html><head><title>Claire Thread - Page 1</title></head><body>
      <div class="userinfo"><img class="avatar" src="https://board.example/customavatars/avatar123.jpg" /></div>
      <div class="pagenav">
        <span>Page 1 of 14</span>
        <a href="https://board.example/threads/12345-Model/page2">2</a>
        <a href="https://board.example/threads/12345-Model/page14">14</a>
      </div>
      <div id="post_message_101">
        <blockquote class="postcontent">
          <a href="https://viewer-one.example/show/45/350279944_004.jpg">
            <img src="https://t86.viewer-one.example/thumbs/45/350279944_004.jpg" />
          </a>
          <a href="https://viewer-two.example/i/3sz6fp">
            <img src="https://viewer-two.example/u/t/2025/01/01/3sz6fp.jpg" />
          </a>
        </blockquote>
      </div>
    </body></html>
    """
    res = parse_album_page_lexbor(forum_html, "https://board.example/threads/12345-Model")
    assert res["count"] == 2
    assert res["currentPage"] == 1
    assert res["totalPages"] == 14
    assert res["hasMore"] is True
    assert res["nextPageUrl"] == "https://board.example/threads/12345-Model/page2"
    assert res["photos"][0]["pageUrl"] == "https://viewer-one.example/show/45/350279944_004.jpg"
    assert res["photos"][0]["originalUrl"] == ""
    assert res["photos"][0]["isResolvedOriginal"] is False
    assert res["photos"][1]["pageUrl"] == "https://viewer-two.example/i/3sz6fp"
    assert res["photos"][1]["originalUrl"] == ""
    assert res["photos"][1]["isResolvedOriginal"] is False


def test_album_photos_endpoint_forum_single_page_mode(tmp_path: Path, monkeypatch):
    from src.server import profile_hub_service

    _setup_parser_connectors(tmp_path, monkeypatch)
    requested_urls: list[str] = []

    class FakeResp:
        def __init__(self, url: str, html: str) -> None:
            self.url = url
            self.text = html
            self.content = html.encode()
            self.status_code = 200

        def raise_for_status(self) -> None:
            return None

    async def fake_fetch(client, url: str):
        requested_urls.append(url)
        if url.endswith("/page2"):
            return FakeResp(
                url,
                """
                <html><body>
                  <div class="pagenav"><span>Page 2 of 14</span><a href="https://board.example/threads/12345-Model/page3">3</a></div>
                  <div id="post_message_2"><blockquote class="postcontent">
                    <a href="https://viewer-two.example/i/page2img"><img src="https://viewer-two.example/u/t/p2.jpg" /></a>
                  </blockquote></div>
                </body></html>
                """,
            )
        return FakeResp(
            url,
            """
            <html><body>
              <div class="pagenav"><span>Page 1 of 14</span><a href="https://board.example/threads/12345-Model/page2">2</a></div>
              <div id="post_message_1"><blockquote class="postcontent">
                <a href="https://viewer-one.example/show/45/page1.jpg"><img src="https://t86.viewer-one.example/thumbs/45/page1.jpg" /></a>
              </blockquote></div>
            </body></html>
            """,
        )

    async def fake_pool(task, html_size=0):
        from src.server.profile_hub_workers import parse_album_page_lexbor
        _, html, final_u = task
        return parse_album_page_lexbor(html, final_u)

    monkeypatch.setattr(profile_hub_service, "_fetch_ph_or_default", fake_fetch)
    monkeypatch.setattr(profile_hub_service, "run_in_worker_pool", fake_pool)

    app = FastAPI()
    app.include_router(profile_hub_service.router)
    client = TestClient(app)

    res1 = client.post("/api/profile-hub/album-photos", json={"url": "https://board.example/threads/12345-Model", "page": 1})
    assert res1.status_code == 200
    body1 = res1.json()
    assert body1["page"] == 1
    assert body1["totalPages"] == 14
    assert body1["hasMore"] is True
    assert body1["nextPageUrl"] == "https://board.example/threads/12345-Model/page2"

    res2 = client.post(
        "/api/profile-hub/album-photos",
        json={"url": "https://board.example/threads/12345-Model", "page": 2, "pageUrl": body1["nextPageUrl"]},
    )
    assert res2.status_code == 200
    body2 = res2.json()
    assert body2["page"] == 2
    assert body2["nextPageUrl"] == "https://board.example/threads/12345-Model/page3"
    assert requested_urls == [
        "https://board.example/threads/12345-Model",
        "https://board.example/threads/12345-Model/page2",
    ]


def test_parse_forum_empty_thread_page_preserves_pagination(tmp_path: Path, monkeypatch):
    from src.server.profile_hub_workers import parse_album_page_lexbor

    _setup_parser_connectors(tmp_path, monkeypatch)

    html = """
    <html><head><title>Text Update - Page 1</title></head><body>
      <div class="pagenav">
        <span>Page 1 of 3</span>
        <a href="https://board.example/threads/99-TextOnly/page2">2</a>
        <a href="https://board.example/threads/99-TextOnly/page3">3</a>
      </div>
      <div class="userinfo"><img class="avatar" src="https://board.example/customavatars/avatar123.jpg" /></div>
      <div id="post_message_101"><blockquote class="postcontent">Thanks for the update!</blockquote></div>
    </body></html>
    """
    parsed = parse_album_page_lexbor(html, "https://board.example/threads/99-TextOnly")
    assert parsed["photos"] == []
    assert parsed["totalPages"] == 3
    assert parsed["hasMore"] is True
    assert parsed["nextPageUrl"] == "https://board.example/threads/99-TextOnly/page2"
