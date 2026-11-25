"""Tests for Watch details (JSON-LD, performers, tags, categories, related) and paginated JSON comments."""
import json
import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.test_video_portal_engine import _write_synthetic_portal_config


@pytest.mark.asyncio
async def test_watch_details_related_and_paginated_comments(tmp_path, monkeypatch):
    cfg_path = _write_synthetic_portal_config(tmp_path)
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))
    from src.server.connector_registry import load_connector_bundle
    from src.server.profile_hub_comment_sources import html_comment_source
    from src.server.profile_hub_watch import (
        get_comments_page,
        get_related_videos,
        get_video_details,
    )

    load_connector_bundle(force_reload=True)

    watch_html = """
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@type": "VideoObject",
            "name": "Sunset Horizon &period; Part One &excl;",
            "description": "High bitrate reel &amp; sunset framing",
            "uploadDate": "2026-06-01T08:00:00Z",
            "thumbnailUrl": ["https://cdn.portal.example/posters/w1.jpg"],
            "duration": "PT12M30S"
          }
        </script>
      </head>
      <body>
        <header><a href="/c/HeaderOnly">Header Only</a></header>
        <h2 class="page-title">Fallback Title</h2>
        <div class="portal-metadata">
          <ul>
            <li class="portal-uploader">
              <a href="/studio_root"><span class="name">Studio Root</span><span class="portal-subs"><span class="count">88k</span></span></a>
            </li>
            <li class="portal-performer">
              <a href="/models/lena-star"><span class="name">Lena Star</span><span class="portal-subs"><span class="count">45k</span></span></a>
            </li>
            <li><a class="is-keyword" href="/tags/hdr-scenic">HDR Scenic</a></li>
            <li><a class="is-keyword" href="/tags/sunset-4k">Sunset 4K</a></li>
            <li><a href="/c/cinema-hd">Cinema HD</a></li>
          </ul>
          <span class="portal-likes">1,420</span>
          <span class="portal-dislikes">32</span>
          <button class="comments"><span class="badge">3</span></button>
        </div>
        <script>
          var conf_data = {"id_video": 92413};
          var portal_related = [
            {
              "id": 92414,
              "eid": "rel92414",
              "u": "/video.rel92414/next_clip",
              "tf": "Next Related Clip",
              "t": "Next...",
              "i": "https://cdn.portal.example/t/rel1.jpg",
              "ipu": "https://cdn.portal.example/p/rel1.mp4",
              "d": "7 min",
              "n": "95k",
              "h": 1,
              "hm": "1080p",
              "pn": "Studio Root",
              "pu": "/studio_root"
            }
          ];
        </script>
      </body>
    </html>
    """

    comments_p0 = {
        "posts": {
            "nb_posts_total": 3,
            "nb_after": 1,
            "ids": ["10"],
            "children": {"10": ["12"]},
            "posts": {
                "10": {
                    "id": 10,
                    "name": "Reviewer Alpha",
                    "url": "/profiles/reviewer-alpha",
                    "pic": "https://cdn.portal.example/u/a.jpg",
                    "message": "Amazing color grading!",
                    "time_diff": "2 hours ago",
                    "votes": {"nb": 15, "nbb": 1},
                },
                "12": {
                    "id": 12,
                    "name": "Studio Root",
                    "url": "/studio_root",
                    "pic": "https://cdn.portal.example/u/s.jpg",
                    "message": "Thank you!",
                    "time_diff": "1 hour ago",
                    "votes": {"nb": 5, "nbb": 0},
                },
            },
        }
    }
    comments_p1 = {
        "posts": {
            "nb_posts_total": 3,
            "nb_after": 0,
            "ids": ["13"],
            "children": {},
            "posts": {
                "13": {
                    "id": 13,
                    "name": "Viewer Beta",
                    "url": "/profiles/viewer-beta",
                    "message": "Second page comment",
                    "time_diff": "3 hours ago",
                    "votes": {"nb": 2, "nbb": 0},
                }
            },
        }
    }

    class _MockStream(httpx.AsyncByteStream):
        def __init__(self, data: bytes):
            self._data = data

        async def __aiter__(self):
            yield self._data

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/video.ab12cd/sunset_horizon":
            return httpx.Response(
                200,
                stream=_MockStream(watch_html.encode("utf-8")),
                headers={"content-type": "text/html; charset=utf-8"},
            )
        if path == "/api/portal-comments/top/92413/0/0":
            return httpx.Response(200, json=comments_p0)
        if path == "/api/portal-comments/top/92413/1/0":
            return httpx.Response(200, json=comments_p1)
        return httpx.Response(404, text="not found")

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_async_client(transport=transport, **{k: v for k, v in kw.items() if k != "transport"}))

    src = html_comment_source("https://portal.example/video.ab12cd/sunset_horizon")
    assert src is not None
    assert src.id == "vid_portal"

    details = await get_video_details("https://portal.example/video.ab12cd/sunset_horizon")
    assert details["title"] == "Sunset Horizon . Part One !"
    assert details["description"] == "High bitrate reel & sunset framing"
    assert details["upload_date"] == "2026-06-01T08:00:00Z"
    assert details["author_name"] == "Studio Root"
    assert details["author_url"] == "https://portal.example/studio_root"
    assert details["like_count"] == 1420
    assert details["dislike_count"] == 32
    assert details["comment_count"] == 3
    assert [a["name"] for a in details["artists"]] == ["Lena Star"]
    assert details["artists"][0]["url"] == "https://portal.example/models/lena-star"
    assert [t["name"] for t in details["tags"]] == ["HDR Scenic", "Sunset 4K"]
    assert details["tags"][0]["url"] == "https://portal.example/tags/hdr-scenic"
    assert [c["name"] for c in details["categories"]] == ["Cinema HD"]
    assert details["categories"][0]["url"] == "https://portal.example/c/cinema-hd"

    related_res = await get_related_videos("https://portal.example/video.ab12cd/sunset_horizon")
    rel_items = related_res.get("videos") or []
    assert len(rel_items) == 1
    assert rel_items[0]["title"] == "Next Related Clip"
    assert rel_items[0]["preview_video_url"] == "https://cdn.portal.example/p/rel1.mp4"

    p0 = await get_comments_page("https://portal.example/video.ab12cd/sunset_horizon", cursor=None, parent_id=None)
    assert len(p0["entries"]) == 1
    assert p0["entries"][0]["text"] == "Amazing color grading!"
    assert p0["entries"][0]["reply_context_available"] is True
    assert p0["complete"] is False
    assert p0["next_cursor"]

    replies = await get_comments_page(
        "https://portal.example/video.ab12cd/sunset_horizon",
        cursor=None,
        parent_id=p0["entries"][0]["id"],
    )
    assert len(replies["entries"]) == 1
    assert replies["entries"][0]["text"] == "Thank you!"

    p1 = await get_comments_page(
        "https://portal.example/video.ab12cd/sunset_horizon",
        cursor=p0["next_cursor"],
        parent_id=None,
    )
    assert len(p1["entries"]) == 1
    assert p1["entries"][0]["text"] == "Second page comment"
    assert p1["complete"] is True


@pytest.mark.asyncio
async def test_watch_audience_profile_fallback_for_generic_portal(tmp_path, monkeypatch):
    """Any configured or future portal without inline watch audience falls back to its profile page."""
    cfg_path = _write_synthetic_portal_config(tmp_path)
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))
    from src.server.connector_registry import load_connector_bundle
    from src.server.profile_hub_watch import get_video_details

    load_connector_bundle(force_reload=True)

    watch_html_no_inline_subs = """
    <html>
      <head>
        <link rel="canonical" href="https://portal.example/video.zz99yy/coastal_reel" />
        <script type="application/ld+json">
          {"@type": "VideoObject", "name": "Coastal Reel"}
        </script>
      </head>
      <body>
        <div class="portal-metadata">
          <ul>
            <li class="portal-uploader">
              <a href="/studio_coast"><span class="name">Studio Coast</span></a>
            </li>
          </ul>
        </div>
      </body>
    </html>
    """
    profile_html_with_subs = """
    <html>
      <head>
        <link rel="canonical" href="https://portal.example/studio_coast" />
      </head>
      <body>
        <div class="portal-about">
          <p>Subscribers: 42.5K</p>
        </div>
      </body>
    </html>
    """

    async def fake_fetch(adapter, url):
        if "/video.zz99yy/" in url:
            return url, watch_html_no_inline_subs
        if "/studio_coast" in url:
            return "https://portal.example/studio_coast/", profile_html_with_subs
        raise AssertionError(f"Unexpected URL fetched: {url}")

    monkeypatch.setattr("src.server.profile_directory_transport.fetch_source_html_shared", fake_fetch)

    details = await get_video_details("https://portal.example/video.zz99yy/coastal_reel")
    assert details["author_name"] == "Studio Coast"
    assert details["author_url"] == "https://portal.example/studio_coast"
    assert details["audience_count_text"] == "42,500 subscribers"
    assert details["audience_kind"] == "subscribers"


def test_generic_profile_audience_jsonld_and_canonical_guard():
    """Generic profile extractor supports Schema.org JSON-LD and rejects canonical mismatches."""
    from src.server.profile_hub_watch import _WatchAuthorProfileAdapter
    from src.server.profile_hub_watch_sources import extract_generic_profile_audience

    adapter = _WatchAuthorProfileAdapter("https://example.org/creators/alpha")

    html_jsonld = """
    <html>
      <head>
        <link rel="canonical" href="https://example.org/creators/alpha" />
        <script type="application/ld+json">
          {
            "@type": "ProfilePage",
            "mainEntity": {
              "@type": "Person",
              "name": "Alpha",
              "interactionStatistic": {
                "@type": "InteractionCounter",
                "interactionType": "https://schema.org/FollowAction",
                "userInteractionCount": 12840
              }
            }
          }
        </script>
      </head>
      <body><h1>Alpha</h1></body>
    </html>
    """
    label, kind = extract_generic_profile_audience(html_jsonld, "https://example.org/creators/alpha/", adapter)
    assert label == "12,840 followers"
    assert kind == "followers"

    html_wrong_canonical = """
    <html>
      <head>
        <link rel="canonical" href="https://example.org/creators/other" />
      </head>
      <body><div class="profile-stats">999K subscribers</div></body>
    </html>
    """
    assert extract_generic_profile_audience(html_wrong_canonical, "https://example.org/creators/alpha/", adapter) == (None, None)


@pytest.mark.asyncio
async def test_portal_comment_json_retries_transient_502(tmp_path, monkeypatch):
    """Transient upstream 502/503 on a portal comment API succeeds on retry."""
    cfg_path = _write_synthetic_portal_config(tmp_path)
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))
    from src.server.connector_registry import load_connector_bundle
    from src.server.profile_hub_comment_pages import _fetch_portal_comment_json
    from src.server.profile_hub_comment_sources import html_comment_source

    load_connector_bundle(force_reload=True)
    src = html_comment_source("https://portal.example/video.ab12cd/sunset_horizon")
    assert src is not None

    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(502, text="bad gateway")
        return httpx.Response(200, json={"posts": {"nb_posts_total": 1, "ids": [], "posts": {}}})

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_async_client(transport=transport, **{k: v for k, v in kw.items() if k != "transport"}),
    )

    payload = await _fetch_portal_comment_json("https://portal.example/api/portal-comments/top/1/0/0", src)
    assert calls["n"] == 2
    assert payload["posts"]["nb_posts_total"] == 1


def test_comment_text_decodes_html_entities_and_breaks():
    """HTML entities (&nbsp;, &#039;, &amp;, double-encoded) and <br> tags are cleanly decoded."""
    from src.server.profile_hub_comment_sources import sanitize_comment_text

    assert sanitize_comment_text("Less than you&nbsp;") == "Less than you"
    assert sanitize_comment_text("&nbsp;She&#039;s a cutie &amp; sweet!") == "She's a cutie & sweet!"
    assert sanitize_comment_text("Line 1<br/>Line 2&amp;nbsp;") == "Line 1\nLine 2"
    assert sanitize_comment_text("Author&nbsp;Name", preserve_newlines=False) == "Author Name"


@pytest.mark.asyncio
async def test_portal_comment_sort_popular_and_newest(tmp_path, monkeypatch):
    """Portals configured with sortPathTemplates expose popular and newest sorting cleanly."""
    cfg_path = _write_synthetic_portal_config(tmp_path)
    raw_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    raw_cfg["videoPortals"][0]["comments"]["sortPathTemplates"] = {
        "popular": "/api/portal-comments/top/{numeric_id}/{page_zero}/0",
        "newest": "/api/portal-comments/new/{numeric_id}/{page_zero}/0",
    }
    cfg_path.write_text(json.dumps(raw_cfg), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))

    from src.server.connector_registry import load_connector_bundle
    from src.server.profile_hub_watch import get_comments_page

    load_connector_bundle(force_reload=True)

    watch_html = """
    <html>
      <head><link rel="canonical" href="https://portal.example/video.s123/sort_demo" /></head>
      <body><script>var conf = {"id_video": 777};</script></body>
    </html>
    """

    async def fake_fetch(adapter, url):
        return url, watch_html

    monkeypatch.setattr("src.server.profile_directory_transport.fetch_source_html_shared", fake_fetch)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/top/777/0/0" in request.url.path:
            return httpx.Response(200, json={
                "posts": {
                    "nb_posts_total": 2,
                    "nb_after": 0,
                    "ids": ["1"],
                    "posts": {"1": {"id": 1, "name": "TopUser", "message": "Top comment", "votes": {"nb": 500, "nbb": 1}}},
                }
            })
        if "/new/777/0/0" in request.url.path:
            return httpx.Response(200, json={
                "posts": {
                    "nb_posts_total": 2,
                    "nb_after": 0,
                    "ids": ["2"],
                    "posts": {"2": {"id": 2, "name": "NewUser", "message": "Newest comment", "votes": {"nb": 0, "nbb": 0}}},
                }
            })
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_async_client(transport=transport, **{k: v for k, v in kw.items() if k != "transport"}),
    )

    pop_page = await get_comments_page("https://portal.example/video.s123/sort_demo", cursor=None, parent_id=None, sort=None)
    assert pop_page["sort"] == "popular"
    assert pop_page["supported_sorts"] == ["popular", "newest"]
    assert pop_page["entries"][0]["text"] == "Top comment"

    new_page = await get_comments_page("https://portal.example/video.s123/sort_demo", cursor=None, parent_id=None, sort="newest")
    assert new_page["sort"] == "newest"
    assert new_page["supported_sorts"] == ["popular", "newest"]
    assert new_page["entries"][0]["text"] == "Newest comment"
