"""Playwright E2E UI verification for video_portal archetype across desktop (1280px) and mobile (390px, 320px).

Uses synthetic portal.example fixtures only (zero real brands/domains).
"""
from __future__ import annotations

import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
from threading import Thread

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DIST_DIR = ROOT / "frontend-mobile-preview" / "dist"

# 1x1 transparent PNG so browser image checks load cleanly offline
_PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
)


def start_dist_server():
    handler = partial(_DistHandler, directory=str(DIST_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = ThreadingThread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_address[1]


class ThreadingThread(Thread):
    pass


class _DistHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_GET(self):
        if self.path.startswith("/sample-img/"):
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(_PNG_1X1)))
            self.end_headers()
            self.wfile.write(_PNG_1X1)
            return
        super().do_GET()


def attach_api_mocks(page, origin: str) -> None:
    def fulfill_json(route, payload: dict, status: int = 200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(payload))

    def handle_route(route):
        url = route.request.url
        if "/api/profile-hub/timeline/browse-sources" in url:
            fulfill_json(route, {
                "ok": True,
                "sources": [
                    {
                        "source_id": "vid_portal",
                        "display_name": "Video Portal",
                        "default_category": "recent",
                        "categories": ["recent", "popular", "videos"],
                        "subfilters": [
                            {"id": "", "label_key": "latestSets", "fallback_label": "All", "group": "sort"},
                        ],
                        "supports_quick_url_open": True,
                        "icon_kind": "video_portal",
                        "accentColor": "#e11d48",
                        "urlHints": {
                            "videoPathRegex": r"^/(?:video\.[a-z0-9]+|embedframe/[a-z0-9]+)",
                            "playlistPathRegex": r"^/favorite/[a-z0-9]+",
                            "entityPrefixes": ["/profiles/", "/channels/", "/models/", "/c/", "/tags/"],
                        },
                        "origins": ["https://portal.example", "https://m.portal.example"],
                        "capabilities": {
                            "archetype": "video_portal",
                            "layoutMode": "video_wall",
                            "supportsComments": True,
                            "supportsSourceLikes": True,
                            "supportsNativePlayback": True,
                            "supportsVideosTab": True,
                            "supportsPlaylists": True,
                            "supportsArtistProfiles": True,
                            "supportsDirectories": True,
                            "supportsThreadReader": False,
                            "directoryKinds": ["categories", "channels", "artists", "tags"],
                            "searchCategories": ["all", "profiles", "videos", "playlists"],
                        },
                    }
                ],
            })
            return

        if "/api/profile-hub/timeline/search-sources" in url:
            fulfill_json(route, {
                "ok": True,
                "sources": [
                    {
                        "id": "vid_portal",
                        "name": "Video Portal",
                        "categories": ["profiles", "videos", "playlists"],
                        "supportsLiveConnector": True,
                        "iconKind": "video_portal",
                        "accentColor": "#e11d48",
                        "urlHints": {
                            "videoPathRegex": r"^/(?:video\.[a-z0-9]+|embedframe/[a-z0-9]+)",
                            "playlistPathRegex": r"^/favorite/[0-9a-z]+",
                            "entityPrefixes": ["/profiles/", "/channels/", "/models/", "/c/", "/tags/"],
                        },
                        "origins": ["https://portal.example", "https://m.portal.example"],
                        "subfilters": [],
                        "capabilities": {
                            "archetype": "video_portal",
                            "layoutMode": "video_wall",
                            "supportsComments": True,
                            "supportsSourceLikes": True,
                            "supportsNativePlayback": True,
                            "supportsVideosTab": True,
                            "supportsPlaylists": True,
                            "supportsArtistProfiles": True,
                            "supportsDirectories": True,
                            "supportsThreadReader": False,
                            "directoryKinds": ["categories", "channels", "artists", "tags"],
                            "searchCategories": ["all", "profiles", "videos", "playlists"],
                        },
                    }
                ],
            })
            return

        if "/api/profile-hub/timeline/browse" in url:
            fulfill_json(route, {
                "source": "vid_portal",
                "category": "recent",
                "resolved_origin": "https://portal.example",
                "next_cursor": None,
                "has_more": False,
                "profiles": [],
                "dynamicSubfilters": [
                    {
                        "id": "/c/cinema-hd",
                        "label_key": "",
                        "fallback_label": "Cinema Live",
                        "group": "category",
                        "path": "/c/cinema-hd",
                    }
                ],
                "items": [
                    {
                        "id": "vp-card-1",
                        "title": "Mountain Dawn 4K",
                        "originalUrl": "https://portal.example/video.ab12cd/mountain_dawn",
                        "thumbnail": f"{origin}/sample-img/v1.png",
                        "type": "video",
                        "source": "vid_portal",
                        "creatorName": "Alpine Films",
                        "sourcePage": "https://portal.example/channels/alpine-films",
                        "duration": "12:00",
                        "resolution": "1440p",
                        "views": "548k Views",
                        "tags": ["HDR Scenic"],
                        "tagEntities": [{"name": "HDR Scenic", "url": "https://portal.example/tags/hdr-scenic", "kind": "tag"}],
                        "categories": [{"name": "Cinema HD", "url": "https://portal.example/c/cinema-hd", "kind": "category"}],
                    }
                ],
            })
            return

        if "/api/profile-hub/timeline/directory" in url:
            if "page=2" in url:
                fulfill_json(route, {
                    "source": "vid_portal",
                    "kind": "artists",
                    "page": 2,
                    "hasMore": False,
                    "nextPage": None,
                    "items": [
                        {
                            "id": "model-page-2",
                            "name": "Model Page Two",
                            "url": "https://portal.example/models/model-page-two",
                            "kind": "creator",
                            "thumbnailUrl": f"{origin}/sample-img/m2.png",
                            "rank": 12,
                            "subscribersText": "32 videos",
                        }
                    ],
                })
            else:
                fulfill_json(route, {
                    "source": "vid_portal",
                    "kind": "artists",
                    "page": 1,
                    "hasMore": True,
                    "nextPage": 2,
                    "items": [
                        {
                            "id": "elena-nova",
                            "name": "Elena Nova",
                            "url": "https://portal.example/models/elena-nova",
                            "kind": "creator",
                            "thumbnailUrl": f"{origin}/sample-img/m1.png",
                            "verified": True,
                            "rank": 4,
                            "subscribersText": "85 videos",
                        }
                    ],
                })
            return

        if "/api/profile-hub/timeline/omni-search" in url:
            ch_profile = {
                "id": "vid_portal:channel:sunset-studio",
                "name": "Sunset Studio",
                "handle": "@sunset-studio",
                "avatar": f"{origin}/sample-img/ch.png",
                "profileUrl": "https://portal.example/channels/sunset-studio",
                "site": "vid_portal",
                "entityKind": "channel",
                "videosCount": 90,
                "verified": True,
            }
            vid_post = {
                "id": "sr-vid-1",
                "title": "Sunset Horizon Reel",
                "originalUrl": "https://portal.example/video.sr1/sunset_horizon",
                "thumbnail": f"{origin}/sample-img/sr1.png",
                "type": "video",
                "source": "vid_portal",
                "creatorId": "https://portal.example/channels/sunset-studio",
                "creatorName": "Sunset Studio",
                "creatorHandle": "@sunset-studio",
                "creatorAvatar": f"{origin}/sample-img/ch.png",
                "duration": "8:00",
                "views": "95k",
                "comments": [],
                "likes": None,
                "date": "2026-06-01",
            }
            fulfill_json(route, {
                "ok": True,
                "query": "sunset",
                "creators": [ch_profile],
                "posts": [vid_post],
                "sections": {
                    "profiles": [ch_profile],
                    "playlists": [],
                    "videos": [vid_post],
                    "shorts": [],
                    "albums": [],
                    "gifs": [],
                    "posts": [],
                },
                "cursors": {},
                "sourceStatus": {"vid_portal": {"ok": True, "count": 2, "hasMore": False}},
                "hasMore": False,
            })
            return

        if "/api/profile-hub/recent" in url:
            from urllib.parse import unquote
            body_text = route.request.post_data or ""
            target_url = url
            if body_text:
                try:
                    target_url = str(json.loads(body_text).get("url") or url)
                except Exception:
                    target_url = body_text
            decoded_url = unquote(target_url)
            is_cat = "/c/" in decoded_url
            ent_kind = "category" if is_cat else "creator"
            ent_name = "Cinema HD" if is_cat else "Elena Nova"
            ent_url = "https://portal.example/c/cinema-hd" if is_cat else "https://portal.example/models/elena-nova"
            fulfill_json(route, {
                "success": True,
                "source": "vid_portal",
                "source_url": ent_url,
                "entityKind": ent_kind,
                "page": 1,
                "hasMore": True,
                "nextPage": 2,
                "profile_key": f"vid_portal:{'c/cinema-hd' if is_cat else 'models/elena-nova'}",
                "name": ent_name,
                "relatedEntities": [{"name": "Sister Studio", "url": "https://portal.example/channels/sister-studio", "kind": "channel"}],
                "profile_data": {
                    "id": ent_url,
                    "name": ent_name,
                    "handle": "@cinemahd" if is_cat else "@elenanova",
                    "site": "vid_portal",
                    "source": "vid_portal",
                    "entityKind": ent_kind,
                    "avatarUrl": f"{origin}/sample-img/m1.png",
                    "bannerUrl": f"{origin}/sample-img/banner.png",
                    "coverUrl": f"{origin}/sample-img/m1.png",
                    "verified": True,
                    "stats": {
                        "videos": 85,
                        "subscribers": 791523,
                        "views": 4214329803,
                        "rating": "100.0%",
                        "shorts": 1,
                        "playlists": 0,
                        "albums": 0,
                    },
                    "portalInfo": {
                        "country": "Canada",
                        "languages": "English",
                        "website": "https://elena.example/",
                    },
                    "relatedEntities": [{"name": "Sister Studio", "url": "https://portal.example/channels/sister-studio", "kind": "channel"}],
                },
                "supportsSort": ["best", "new"],
                "activeSort": "best",
                "featuredPerformers": [
                    {
                        "name": f"CoStar {idx + 1}",
                        "url": f"https://portal.example/models/costar-{idx + 1}",
                        "kind": "creator",
                        "count": 10 + idx,
                    }
                    for idx in range(10)
                ] if not is_cat else [],
                "affiliatedChannels": [
                    {"name": "Sister Studio", "url": "https://portal.example/channels/sister-studio", "kind": "channel"}
                ],
                "interests": [
                    {"name": "HDR Scenic", "url": "https://portal.example/tags/hdr-scenic", "kind": "tag"}
                ],
                "canonical_videos": [
                    {
                        "id": "p-v1",
                        "title": "Portal Profile Feature Reel",
                        "originalUrl": "https://portal.example/video.ab12cd/mountain_dawn",
                        "thumbnailUrl": f"{origin}/sample-img/v1.png",
                        "duration": "12:00",
                        "resolution": "1440p",
                        "views": "548k",
                        "type": "video",
                    },
                    {
                        "id": "p-s1",
                        "title": "Portal Quick Clip",
                        "originalUrl": "https://portal.example/video.qs99/quick_clip",
                        "thumbnailUrl": f"{origin}/sample-img/s1.png",
                        "duration": "0:30",
                        "type": "video",
                        "isShort": True,
                    },
                ],
                "canonical_shorts": [],
                "canonical_albums": [],
                "canonical_playlists": [],
                "canonical_gifs": [],
            })
            return

        if "/api/profile-hub/video-details" in url:
            fulfill_json(route, {
                "status": "ready",
                "source_url": "https://portal.example/video.ab12cd/mountain_dawn",
                "title": "Mountain Dawn 4K",
                "description": "High dynamic range scenic capture",
                "author_name": "Alpine Films",
                "author_url": "https://portal.example/channels/alpine-films",
                "author_avatar_url": None,
                "audience_count_text": "88k",
                "audience_kind": "subscribers",
                "artists": [{"name": "Elena Nova", "url": "https://portal.example/models/elena-nova", "verified": True}],
                "tags": [
                    {"name": "HDR Scenic", "url": "https://portal.example/tags/hdr-scenic"},
                    *[
                        {"name": f"Extra Tag {i}", "url": f"https://portal.example/tags/extra-{i}"}
                        for i in range(1, 10)
                    ],
                ],
                "categories": [{"name": "Cinema HD", "url": "https://portal.example/c/cinema-hd"}],
                "upload_date": "2026-06-01T08:00:00Z",
                "view_count_text": "9100000",
                "reaction_kind": "like_dislike",
                "like_count": 1420,
                "dislike_count": 32,
                "comment_count": 1,
            })
            return

        if "/api/profile-hub/related" in url:
            fulfill_json(route, {
                "status": "ready",
                "source_url": "https://portal.example/video.ab12cd/mountain_dawn",
                "videos": [],
                "complete": False,
            })
            return

        if "/api/profile-hub/comments-page" in url:
            fulfill_json(route, {
                "status": "ready",
                "source_url": "https://portal.example/video.ab12cd/mountain_dawn",
                "entries": [
                    {
                        "id": "vid_portal:10",
                        "parent": "root",
                        "author": "Reviewer Alpha",
                        "text": "Crisp lighting on the ridge!",
                        "time_text": "2 hours ago",
                        "reaction_kind": "like_dislike",
                        "like_count": 15,
                        "reply_context_available": False,
                    }
                ],
                "reported_total": 1,
                "complete": True,
                "next_cursor": None,
            })
            return

        if "/api/video-stream-qualities" in url:
            fulfill_json(route, {
                "is_hls": False,
                "qualities": [],
                "target_page": "https://portal.example/video.ab12cd/mountain_dawn",
            })
            return

        if "/api/profile-hub/timeline/integrated-sources" in url:
            fulfill_json(
                route,
                {
                    "ok": True,
                    "sources": [
                        {
                            "id": "vid_portal",
                            "displayName": "Video Portal",
                            "originUrl": "https://portal.example",
                            "domains": ["portal.example"],
                            "kind": "connector",
                            "addedVia": "https://portal.example",
                            "integratedAt": "2026-11-24T00:00:00Z",
                        }
                    ],
                },
            )
            return

        if "/api/" in url:
            fulfill_json(route, {"ok": True, "creators": [], "posts": [], "items": [], "favorites": [], "liked": [], "history": [], "playlists": [], "sources": []})
            return

        route.continue_()

    page.route("**/*", handle_route)


def select_source_via_more(page, source_id: str) -> None:
    nav = page.get_by_role("navigation", name=re.compile("^Sources$|^Fontes$"))
    pill = nav.locator(f'[data-source-pill="{source_id}"]')
    option = nav.locator(f'option[value="{source_id}"]')
    expect(pill.or_(option)).to_be_attached(timeout=10000)
    if pill.count() > 0:
        pill.first.click()
        return
    nav.locator("select").select_option(source_id)


def run_viewport_check(playwright, width: int, height: int, is_mobile: bool) -> None:
    server, port = start_dist_server()
    origin = f"http://127.0.0.1:{port}"
    try:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": width, "height": height},
            is_mobile=is_mobile,
            has_touch=is_mobile,
        )
        page = context.new_page()
        page_errors: list[str] = []
        console_errors: list[str] = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        attach_api_mocks(page, origin)
        page.goto(f"{origin}/#/timeline-preview", wait_until="domcontentloaded")

        # 1. Select video_portal -> verify video_wall layout, dynamic subfilter & contextual Quick URL
        select_source_via_more(page, "vid_portal")
        expect(page.locator('[data-layout-mode="video_wall"][data-archetype="video_portal"]')).to_be_visible(timeout=10000)
        expect(page.get_by_text("Mountain Dawn 4K", exact=True)).to_be_visible(timeout=10000)
        expect(page.locator('[data-category-chip="Cinema HD"]').first).to_be_visible()
        expect(page.locator('[data-subfilter-id="/c/cinema-hd"]').first).to_be_visible(timeout=10000)
        if not is_mobile:
            quick_input = page.locator('input[type="url"]').last
            placeholder_text = quick_input.get_attribute("placeholder") or ""
            assert "gallery or thread" not in placeholder_text.lower(), f"Wrong Quick URL placeholder for video_portal: {placeholder_text}"

        # 2. Directory Explorer -> Artists -> paginated load more + click creator opens dedicated VideoPortalProfileView
        page.locator('[data-directory-kind="artists"]').first.click()
        expect(page.locator('[data-directory-item-id="elena-nova"]')).to_be_visible(timeout=10000)
        load_more_dir = page.locator('[data-directory-load-more="true"]').first
        expect(load_more_dir).to_be_visible()
        if is_mobile:
            dbox = load_more_dir.bounding_box()
            assert dbox is not None and dbox["height"] >= 44, f"Directory load more button below 44px on mobile: {dbox}"
        load_more_dir.click()
        expect(page.locator('[data-directory-item-id="model-page-2"]')).to_be_visible(timeout=10000)

        page.locator('[data-directory-item-id="elena-nova"]').first.click()
        expect(page.locator('[data-video-portal-profile="vid_portal"]')).to_be_visible(timeout=10000)
        expect(page.get_by_text("Portal Profile Feature Reel", exact=True)).to_be_visible(timeout=10000)
        expect(page.locator('[data-vp-metrics="true"]').get_by_text("791.5K")).to_be_visible()
        expect(page.locator('[data-vp-metrics="true"]').get_by_text("4.2B")).to_be_visible()
        expect(page.locator('[data-vp-sort="best"]')).to_be_visible()
        expect(page.locator('[data-vp-tab="channels"]')).to_be_visible()
        page.locator('[data-vp-tab="channels"]').click()
        expect(page.get_by_text("Sister Studio", exact=True)).to_be_visible()
        page.locator('[data-vp-tab="about"]').click()
        expect(page.get_by_text("Canada", exact=True).last).to_be_visible()
        expect(page.get_by_role("button", name=re.compile("Shorts", re.I)).first).to_be_visible()
        page.get_by_role("button", name=re.compile("^Back|^Voltar")).first.click()

        # 3. Federated omni-search with entityKind badge
        search_input = page.locator('[data-omni-search-input="true"]').first
        if is_mobile and not search_input.is_visible():
            page.locator('[data-mobile-search-toggle="true"]').first.click()
        search_input.fill("sunset")
        page.locator('[data-omni-search-submit="true"]').first.click()
        expect(page.locator('[data-entity-kind="channel"]').first).to_be_visible(timeout=10000)
        expect(page.get_by_text("Sunset Studio", exact=True).first).to_be_visible()

        # 4. Direct URL routing in Search Box -> Watch View stats bar, compact likes, collapsible tags & category click
        search_input.fill("https://portal.example/video.ab12cd/mountain_dawn")
        page.locator('[data-omni-search-submit="true"]').first.click()
        expect(page.locator('[data-watch-stats-bar]')).to_be_visible(timeout=10000)
        expect(page.locator('[data-watch-views]')).to_contain_text("9.1M")
        expect(page.locator('[data-watch-reaction-box] [data-source-like-count]')).to_contain_text("1.4K")
        expect(page.locator('[data-watch-category="Cinema HD"]')).to_be_visible()
        expect(page.locator('[data-watch-tag="HDR Scenic"]')).to_be_visible()
        expect(page.locator('[data-watch-tag="Extra Tag 9"]')).not_to_be_visible()
        page.locator('[data-watch-tags-toggle]').click()
        expect(page.locator('[data-watch-tag="Extra Tag 9"]')).to_be_visible()
        comments_tab = page.locator('[data-watch-section="comments"]')
        if comments_tab.is_visible():
            comments_tab.click()
        expect(page.get_by_text("Crisp lighting on the ridge!", exact=True)).to_be_visible(timeout=10000)

        # Clicking category chip in Watch View opens Category page
        page.locator('[data-watch-category="Cinema HD"]').click()
        expect(page.get_by_role("heading", name="Cinema HD")).to_be_visible(timeout=10000)

        # Zero horizontal overflow & zero errors check
        has_no_overflow = page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
        assert has_no_overflow, f"Horizontal overflow detected at {width}x{height}"
        assert not page_errors, f"Page errors at {width}px: {page_errors}"
        assert not console_errors, f"Console errors at {width}px: {console_errors}"
        print(f"{width}x{height} (mobile={is_mobile}): VideoPortal E2E UI PASSED")
        context.close()
        browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    assert DIST_DIR.is_dir(), f"Built frontend missing at {DIST_DIR}"
    with sync_playwright() as p:
        run_viewport_check(p, 1280, 800, is_mobile=False)
        run_viewport_check(p, 390, 844, is_mobile=True)
        run_viewport_check(p, 320, 568, is_mobile=True)
