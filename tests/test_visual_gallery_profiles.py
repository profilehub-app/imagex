import json
from pathlib import Path

import httpx
import pytest


def _setup_profile_connectors(tmp_path: Path, monkeypatch) -> None:
    from src.server.connector_registry import clear_connector_cache

    cfg = {
        "catalogs": [
            {
                "id": "cat_alpha",
                "displayName": "Alpha Gallery",
                "baseUrl": "https://alpha.example",
                "domains": ["alpha.example", "cdn.alpha.example"],
                "browse": {
                    "searchApiPath": "/search/srch.php",
                    "albumPathSegment": "/galleries/",
                    "artistPathSegment": "/artists/",
                    "channelPathSegment": "/channels/",
                    "thumbUpgrade": ["/460/", "/1280/"],
                },
                "selectors": {
                    "tile": "ul#tiles li.thumbwook",
                    "avatar": ".model-info img, img.avatar",
                    "artistPrefixes": ["/artists/", "/models/"],
                    "channelPrefixes": ["/channels/"],
                    "tagIgnorePaths": ["/", "/rating/"],
                },
            },
            {
                "id": "cat_beta",
                "displayName": "Beta Categories",
                "baseUrl": "https://beta.example",
                "baseUrlEnv": "BETA_CATALOG_BASE_URL",
                "domains": ["beta.example", "cdn.beta.example"],
                "domainPatterns": ["mirror-beta."],
                "rootMode": "category_first",
                "browse": {
                    "albumPathSegment": "/pics/",
                    "artistPathSegment": "/artists/",
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
                "forum": {"indexPath": "/forum.php"},
            }
        ],
        "imageHosts": [],
    }
    p = tmp_path / "connectors.profiles.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(p))
    monkeypatch.setenv("BETA_CATALOG_BASE_URL", "https://mirror-beta.example")
    clear_connector_cache()


def test_profile_providers_and_recent_source_recognition(tmp_path: Path, monkeypatch):
    from src.server.profile_hub_providers import normalize_source_author_url, resolve_provider
    from src.server.profile_hub_recent import recent_source

    _setup_profile_connectors(tmp_path, monkeypatch)

    assert resolve_provider("https://alpha.example/artists/claire-vance/").provider_id == "cat_alpha"
    assert resolve_provider("https://beta.example/artists/aria-sky/").provider_id == "cat_beta"
    assert resolve_provider("https://board.example/threads/12345-Model").provider_id == "board_one"
    assert resolve_provider("https://mirror-beta.example/artists/aria-sky/").provider_id == "cat_beta"

    assert recent_source("https://mirror-beta.example/artists/aria-sky/") == "cat_beta"
    assert recent_source("https://alpha.example/artists/claire-vance/") == "cat_alpha"
    assert recent_source("https://alpha.example/channels/velvet/") == "cat_alpha"
    assert recent_source("https://alpha.example/lingerie/") == "cat_alpha"
    assert recent_source("https://board.example/threads/12345-Model") == "board_one"
    assert recent_source("https://board.example/forums/10-Sets") == "board_one"
    assert recent_source("https://board.example/members/999-Uploader") == "board_one"

    assert normalize_source_author_url(
        {"author_url": "/artists/claire-vance/"},
        "https://alpha.example/galleries/claire-1/",
    ) == "https://alpha.example/artists/claire-vance/"


@pytest.mark.asyncio
async def test_read_recent_profile_paginated_catalog_and_forum(tmp_path: Path, monkeypatch):
    from src.server import profile_hub_recent

    _setup_profile_connectors(tmp_path, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if u == "https://alpha.example/artists/claire-vance/":
            return httpx.Response(
                200,
                html="""
                <html><body>
                  <h1>Claire Vance Galleries</h1>
                  <div class="model-info">
                    <img src="https://cdn.alpha.example/avatar/claire.jpg" />
                    <a href="https://alpha.example/channels/sunset-house/">Sunset House</a>
                  </div>
                  <script>var QUERY='artist_claire';</script>
                  <ul id="tiles">
                    <li class="thumbwook">
                      <a href="https://alpha.example/galleries/claire-set-1/">
                        <img src="https://static.alpha.example/style/img/1px.png"
                             data-src="https://cdn.alpha.example/460/1/2/claire1.jpg" alt="Claire Set 1" />
                      </a>
                    </li>
                  </ul>
                  <div class="pagination"><a href="https://alpha.example/artists/claire-vance/2/">2</a></div>
                </body></html>
                """,
            )
        if u == "https://alpha.example/artists/claire-vance/2/":
            return httpx.Response(
                200,
                html="""
                <html><body>
                  <h1>Claire Vance Galleries</h1>
                  <ul id="tiles">
                    <li class="thumbwook">
                      <a href="https://alpha.example/galleries/claire-set-3/">
                        <img data-src="https://cdn.alpha.example/460/1/2/claire3.jpg" alt="Claire Set 3" />
                      </a>
                    </li>
                  </ul>
                </body></html>
                """,
            )
        if u.startswith("https://alpha.example/search/srch.php"):
            return httpx.Response(
                200,
                json=[
                    {
                        "gid": 9002,
                        "desc": "Claire Set 2",
                        "g_url": "https://alpha.example/galleries/claire-set-2/",
                        "t_url_460": "https://cdn.alpha.example/460/1/2/claire2.jpg",
                    }
                ],
            )
        if u == "https://mirror-beta.example/studio-glam/":
            return httpx.Response(
                200,
                html="""
                <html><body>
                  <h1>Studio Glam Galleries</h1>
                  <a href="https://mirror-beta.example/pics/glam-set-1/">
                    <img data-src="https://cdn.beta.example/460/5/6/glam1.jpg" alt="Glam Set 1" />
                  </a>
                </body></html>
                """,
            )
        if u == "https://board.example/members/777-GuestBlocked":
            return httpx.Response(200, html="<html><head><title>GuestBlocked</title></head><body><h1>GuestBlocked</h1></body></html>")
        if u.startswith("https://board.example/search.php?do=finduser"):
            return httpx.Response(200, html="<html><body>You must login to search member posts</body></html>")
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    def fake_async_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(profile_hub_recent.httpx, "AsyncClient", fake_async_client)

    pp = await profile_hub_recent.read_recent_profile("https://alpha.example/artists/claire-vance/")
    assert pp["source"] == "cat_alpha"
    assert pp["hasMore"] is True
    assert pp["nextPage"] == 2
    assert len(pp["canonical_albums"]) == 2
    assert pp["profile_data"]["stats"]["albums"] == 2
    assert pp["relatedEntities"][0]["name"] == "Sunset House"

    pp_p2 = await profile_hub_recent.read_recent_profile("https://alpha.example/artists/claire-vance/", page=2)
    assert pp_p2["page"] == 2
    assert pp_p2["canonical_albums"][0]["title"] == "Claire Set 3"

    hq = await profile_hub_recent.read_recent_profile("https://mirror-beta.example/studio-glam/")
    assert hq["source"] == "cat_beta"
    assert len(hq["canonical_albums"]) == 1

    vp = await profile_hub_recent.read_recent_profile("https://board.example/members/777-GuestBlocked")
    assert vp["source"] == "board_one"
    assert vp["partial_reason"] == "guest_profile_restricted"
