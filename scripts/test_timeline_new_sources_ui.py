"""Isolated Playwright E2E verification for generic capability-driven Timeline UI.

Starts an ephemeral local HTTP server over `frontend-mobile-preview/dist`, intercepts
Timeline/Directory/Enrichment/Thread/Profile API endpoints with synthetic `.example`
sources (`cat_alpha`, `cat_beta`, `board_one`) and valid PNG images, and verifies:
- Zero hardcoded site names anywhere in mocked traffic or assertions
- Lazy catalog enrichment hydrating numeric/slug titles with clickable Artist/Channel chips
- Capability matrix hiding comments, fake `—` likes, and playlists on gallery/forum sources
- Directory switcher (`categories`, `artists`, `boards`) and paginated Artist Profiles without `Vídeos (0)`
- `video_release` forum cards rendering screenshots + mirrors without HTML5 `<video>`
- Multi-page `ForumThreadReaderView` + Multi-page Lightbox pagination
- Desktop (1280x800) + Mobile (390x844 & 320x568) responsiveness (zero horizontal overflow, >=44px targets)
- Zero uncaught page errors or console errors
"""
from __future__ import annotations

import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import socket
from threading import Thread

from playwright.sync_api import expect, sync_playwright

DIST_DIR = Path(__file__).resolve().parents[1] / "frontend-mobile-preview" / "dist"
SAMPLE_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAADElEQVR4nGP4z8AAAAMBAQDJ"
    "/pLvAAAAAElFTkSuQmCC"
)
SAMPLE_PNG_BYTES = base64.b64decode(SAMPLE_PNG_B64)


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002
        pass


def start_dist_server() -> tuple[ThreadingHTTPServer, int]:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    handler = partial(QuietStaticHandler, directory=str(DIST_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


def attach_api_mocks(page) -> None:
    def handle_route(route):
        url = route.request.url
        if "/sample-img/" in url or "/api/proxy-image" in url:
            route.fulfill(status=200, content_type="image/png", body=SAMPLE_PNG_BYTES)
            return

        if "/api/profile-hub/timeline/browse-sources" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "ok": True,
                    "sources": [
                        {
                            "source_id": "cat_alpha",
                            "display_name": "Alpha Catalog",
                            "default_category": "popular",
                            "categories": ["popular", "recent", "albums", "gifs"],
                            "icon_kind": "gallery_catalog",
                            "subfilters": [
                                {"id": "amateur", "label_key": "tagAmateur", "fallback_label": "Amateur", "group": "tag"},
                                {"id": "studio", "label_key": "tagStudio", "fallback_label": "Studio", "group": "tag"},
                            ],
                            "capabilities": {
                                "archetype": "gallery_catalog",
                                "supportsComments": False,
                                "supportsSourceLikes": False,
                                "supportsNativePlayback": False,
                                "supportsVideosTab": False,
                                "supportsPlaylists": False,
                                "supportsArtistProfiles": True,
                                "supportsDirectories": True,
                                "supportsThreadReader": False,
                                "directoryKinds": ["categories", "artists", "channels", "tags"],
                                "searchCategories": ["all", "users", "albums", "photos", "gifs"],
                            },
                        },
                        {
                            "source_id": "cat_beta",
                            "display_name": "Beta HD Catalog",
                            "default_category": "recent",
                            "categories": ["recent", "albums", "photos"],
                            "icon_kind": "gallery_hd",
                            "subfilters": [
                                {"id": "latest", "label_key": "latestSets", "fallback_label": "Latest", "group": "feed"},
                            ],
                            "capabilities": {
                                "archetype": "gallery_catalog",
                                "supportsComments": False,
                                "supportsSourceLikes": False,
                                "supportsNativePlayback": False,
                                "supportsVideosTab": False,
                                "supportsPlaylists": False,
                                "supportsArtistProfiles": True,
                                "supportsDirectories": True,
                                "supportsThreadReader": False,
                                "directoryKinds": ["categories"],
                                "searchCategories": ["all", "albums", "photos"],
                            },
                        },
                        {
                            "source_id": "board_one",
                            "display_name": "Board One",
                            "default_category": "recent",
                            "categories": ["recent", "popular", "albums", "gifs", "posts"],
                            "icon_kind": "forum_board",
                            "subfilters": [
                                {"id": "325-Studios", "label_key": "forumStudios", "fallback_label": "Studios", "group": "forum"},
                            ],
                            "capabilities": {
                                "archetype": "forum_board",
                                "supportsComments": False,
                                "supportsSourceLikes": False,
                                "supportsNativePlayback": False,
                                "supportsVideosTab": False,
                                "supportsPlaylists": False,
                                "supportsArtistProfiles": True,
                                "supportsDirectories": True,
                                "supportsThreadReader": True,
                                "directoryKinds": ["boards"],
                                "searchCategories": ["all", "albums", "photos", "posts", "gifs", "videos"],
                            },
                        },
                    ],
                }),
            )
            return

        if "/api/profile-hub/timeline/browse" in url:
            body = json.loads(route.request.post_data or "{}")
            src = body.get("source", "cat_alpha")
            sub = body.get("subfilter")
            origin = page.url.split("#")[0].rstrip("/")
            if src == "cat_alpha":
                resolved_origin = "https://alpha.example"
                items = [
                    {
                        "id": f"alpha_{sub or 'pop'}_1",
                        "title": "Amateur Spotlight" if sub == "amateur" else "447",
                        "originalUrl": "https://alpha.example/galleries/447-editorial-set/",
                        "albumUrl": "https://alpha.example/galleries/447-editorial-set/",
                        "thumbnail": f"{origin}/sample-img/alpha1.png",
                        "type": "album",
                        "source": "cat_alpha",
                        "photoCount": 24,
                        "tags": ["amateur", "portrait"],
                        "needsEnrichment": sub != "amateur",
                    }
                ]
            elif src == "cat_beta":
                resolved_origin = "https://beta.example"
                items = [
                    {
                        "id": "beta_1",
                        "title": "Beta Studio Collection",
                        "originalUrl": "https://beta.example/pics/studio-collection/",
                        "albumUrl": "https://beta.example/pics/studio-collection/",
                        "thumbnail": f"{origin}/sample-img/beta1.png",
                        "type": "album",
                        "source": "cat_beta",
                    }
                ]
            else:
                resolved_origin = "https://board.example"
                items = [
                    {
                        "id": "board_rel_1",
                        "title": "Synthetic Video Release Thread",
                        "originalUrl": "https://board.example/threads/999001-Demo-Release",
                        "albumUrl": "https://board.example/threads/999001-Demo-Release",
                        "thumbnail": f"{origin}/sample-img/board_screen.png",
                        "photos": [f"{origin}/sample-img/board_screen.png"],
                        "type": "video",
                        "source": "board_one",
                        "threadKind": "video_release",
                        "releaseSpecs": ["1080p", "MP4", "2.1 GB"],
                        "releaseLinks": [
                            {"host": "mirror.example", "url": "https://mirror.example/file.mp4", "label": "Mirror Fast"}
                        ],
                        "hosts": ["img-host.example"],
                        "totalPages": 3,
                    }
                ]
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "source": src,
                    "category": body.get("category", "popular"),
                    "subfilter": sub,
                    "resolved_origin": resolved_origin,
                    "items": items,
                    "profiles": [],
                    "next_cursor": None,
                    "has_more": False,
                }),
            )
            return

        if "/api/profile-hub/timeline/gallery-detail" in url:
            body = json.loads(route.request.post_data or "{}")
            gal_url = body.get("url") or "https://alpha.example/galleries/447-editorial-set/"
            origin = page.url.split("#")[0].rstrip("/")
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "success": True,
                    "source": "cat_alpha",
                    "sourceName": "Alpha Catalog",
                    "galleryUrl": gal_url,
                    "title": "Editorial Portrait Session",
                    "author": "Artist Alpha",
                    "authorUrl": "https://alpha.example/artists/artist-alpha",
                    "artists": [{"name": "Artist Alpha", "url": "https://alpha.example/artists/artist-alpha", "kind": "artist"}],
                    "channels": [{"name": "Channel Alpha", "url": "https://alpha.example/channels/channel-alpha", "kind": "channel"}],
                    "tags": ["editorial", "portrait"],
                    "tagEntities": [{"name": "Portrait", "url": "https://alpha.example/portrait/", "kind": "category"}],
                    "photos": [
                        {
                            "id": "gphoto_1",
                            "url": f"{origin}/sample-img/gal_1.png",
                            "thumbnailUrl": f"{origin}/sample-img/gal_1.png",
                            "pageUrl": gal_url,
                            "sourcePage": gal_url,
                            "isResolvedOriginal": True,
                        },
                        {
                            "id": "gphoto_2",
                            "url": f"{origin}/sample-img/gal_2.png",
                            "thumbnailUrl": f"{origin}/sample-img/gal_2.png",
                            "pageUrl": gal_url,
                            "sourcePage": gal_url,
                            "isResolvedOriginal": True,
                        },
                    ],
                    "photoCount": 2,
                    "relatedGalleries": [
                        {
                            "id": "rel_gal_1",
                            "title": "Related Editorial Session",
                            "originalUrl": "https://alpha.example/galleries/448-related-set/",
                            "albumUrl": "https://alpha.example/galleries/448-related-set/",
                            "thumbnail": f"{origin}/sample-img/rel_1.png",
                            "type": "album",
                            "source": "cat_alpha",
                        }
                    ],
                }),
            )
            return

        if "/api/profile-hub/timeline/catalog-enrich" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "ok": True,
                    "metadata": {
                        "https://alpha.example/galleries/447-editorial-set/": {
                            "title": "Editorial Portrait Session",
                            "author": "Artist Alpha",
                            "authorUrl": "https://alpha.example/artists/artist-alpha",
                            "artists": [{"name": "Artist Alpha", "url": "https://alpha.example/artists/artist-alpha", "kind": "artist"}],
                            "channels": [{"name": "Channel Alpha", "url": "https://alpha.example/channels/channel-alpha", "kind": "channel"}],
                            "tags": ["editorial", "portrait"],
                            "photoCount": 28,
                        }
                    },
                }),
            )
            return

        if "/api/profile-hub/timeline/directory" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "source": "cat_alpha",
                    "kind": "artists",
                    "page": 1,
                    "items": [
                        {
                            "id": "artist-alpha",
                            "name": "Artist Alpha",
                            "url": "https://alpha.example/artists/artist-alpha",
                            "kind": "artist",
                            "count": 42,
                        }
                    ],
                }),
            )
            return

        if "/api/profile-hub/timeline/forum-boards" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "ok": True,
                    "source": "board_one",
                    "sections": [
                        {
                            "title": "Curated Releases",
                            "boards": [
                                {"id": "325-Studios", "boardId": "325", "name": "Studio Releases", "url": "https://board.example/forums/325"}
                            ],
                        }
                    ],
                }),
            )
            return

        if "/api/profile-hub/timeline/thread-view" in url:
            body = json.loads(route.request.post_data or "{}")
            page_url_arg = body.get("pageUrl") or ""
            m_pg = re.search(r"/page(\d+)", page_url_arg)
            pg = int(m_pg.group(1)) if m_pg else int(body.get("page", 1))
            origin = page.url.split("#")[0].rstrip("/")
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "success": True,
                    "threadUrl": body.get("url"),
                    "pageUrl": f"{body.get('url')}/page{pg}" if pg > 1 else body.get("url"),
                    "title": "Synthetic Video Release Thread",
                    "author": "UploaderOne",
                    "authorUrl": "https://board.example/members/uploaderone",
                    "breadcrumbs": [{"name": "Studio Releases", "url": "https://board.example/forums/325"}],
                    "threadKind": "video_release",
                    "releaseSpecs": ["1080p", "MP4", "2.1 GB"],
                    "photos": [
                        {
                            "id": f"th_img_{pg}",
                            "url": f"{origin}/sample-img/thread_{pg}.png",
                            "thumbnailUrl": f"{origin}/sample-img/thread_{pg}.png",
                            "pageUrl": f"https://img-host.example/show/th_{pg}.jpg",
                        }
                    ],
                    "count": 1,
                    "posts": [
                        {
                            "id": f"post_{pg}_1",
                            "author": "UploaderOne",
                            "date": "2026-11-23",
                            "text": f"Release description on thread page {pg}.",
                            "photos": [
                                {
                                    "id": f"th_img_{pg}",
                                    "url": f"{origin}/sample-img/thread_{pg}.png",
                                    "thumbnailUrl": f"{origin}/sample-img/thread_{pg}.png",
                                }
                            ],
                            "releaseLinks": [
                                {"host": "mirror.example", "url": "https://mirror.example/file.mp4", "label": "Mirror Fast"}
                            ],
                        }
                    ],
                    "currentPage": pg,
                    "totalPages": 3,
                    "hasMore": pg < 3,
                    "nextPageUrl": f"{body.get('url')}/page{pg + 1}" if pg < 3 else None,
                }),
            )
            return

        if "/api/profile-hub/recent" in url:
            body = json.loads(route.request.post_data or "{}")
            pg = int(body.get("page", 1))
            origin = page.url.split("#")[0].rstrip("/")
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "profile_key": "cat_alpha:artists/artist-alpha",
                    "source_url": "https://alpha.example/artists/artist-alpha",
                    "name": "Artist Alpha",
                    "entityKind": "creator",
                    "page": pg,
                    "hasMore": pg < 2,
                    "nextPage": 2 if pg < 2 else None,
                    "relatedEntities": [
                        {"name": "Channel Alpha", "url": "https://alpha.example/channels/channel-alpha", "kind": "channel", "count": 15}
                    ],
                    "profile_data": {
                        "name": "Artist Alpha",
                        "handle": "@artist-alpha",
                        "site": "cat_alpha",
                        "entityKind": "creator",
                        "avatarUrl": f"{origin}/sample-img/avatar.png",
                        "stats": {"albums": 42},
                    },
                    "canonical_albums": [
                        {
                            "url": f"https://alpha.example/galleries/artist-set-{pg}/",
                            "title": f"Artist Set Page {pg}",
                            "thumbnailUrl": f"{origin}/sample-img/asset_{pg}.png",
                        }
                    ],
                }),
            )
            return

        if "/api/profile-hub/album-photos" in url:
            body = json.loads(route.request.post_data or "{}")
            pg = body.get("page", 1)
            origin = page.url.split("#")[0].rstrip("/")
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "photos": [
                        {
                            "id": f"vphoto_{pg}",
                            "originalUrl": "",
                            "thumbnailUrl": f"{origin}/sample-img/v_{pg}.png",
                            "pageUrl": f"https://img-host.example/show/45/v_{pg}.jpg",
                            "sourcePage": body.get("url"),
                        }
                    ],
                    "page": pg,
                    "totalPages": 3,
                    "hasMore": pg < 3,
                    "nextPageUrl": f"https://board.example/threads/999001-Demo-Release/page{pg + 1}" if pg < 3 else None,
                    "paginationComplete": pg >= 3,
                }),
            )
            return

        if "/api/profile-hub/resolve-photo" in url:
            body = json.loads(route.request.post_data or "{}")
            origin = page.url.split("#")[0].rstrip("/")
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "success": True,
                    "photo_id": body.get("photo_id"),
                    "original_url": f"{origin}/sample-img/hd_{body.get('photo_id', '1')}.png",
                    "width": 1280,
                    "height": 960,
                    "file_size": 120000,
                    "format": "png",
                    "is_resolved": True,
                    "requires_proxy": False,
                }),
            )
            return

        if "/api/profile-hub/timeline/integrated-sources" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "ok": True,
                    "sources": [
                        {
                            "id": "cat_alpha",
                            "displayName": "Cat Alpha",
                            "originUrl": "https://alpha.example",
                            "domains": ["alpha.example"],
                            "kind": "connector",
                            "addedVia": "https://alpha.example",
                            "integratedAt": "2026-11-24T00:00:00Z",
                        },
                        {
                            "id": "cat_beta",
                            "displayName": "Cat Beta",
                            "originUrl": "https://beta.example",
                            "domains": ["beta.example"],
                            "kind": "connector",
                            "addedVia": "https://beta.example",
                            "integratedAt": "2026-11-24T00:00:00Z",
                        },
                        {
                            "id": "board_one",
                            "displayName": "Board One",
                            "originUrl": "https://board.example",
                            "domains": ["board.example"],
                            "kind": "connector",
                            "addedVia": "https://board.example",
                            "integratedAt": "2026-11-24T00:00:00Z",
                        },
                    ],
                }),
            )
            return

        if "/api/" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"ok": True, "creators": [], "posts": [], "items": [], "favorites": [], "liked": [], "history": [], "playlists": [], "sources": []}),
            )
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
    select = nav.locator("select")
    select.select_option(source_id)


def run_viewport_check(playwright, width: int, height: int, is_mobile: bool) -> None:
    server, port = start_dist_server()
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

        attach_api_mocks(page)
        page.goto(f"http://127.0.0.1:{port}/#/timeline-preview", wait_until="domcontentloaded")

        # 1. Gallery Catalog loads + lazy enrichment replaces numeric "447" with title + clickable Artist chip
        select_source_via_more(page, "cat_alpha")
        expect(page.locator('[data-layout-mode="editorial_wall"]')).to_be_visible(timeout=10000)
        expect(page.locator('[data-layout-card="editorial_wall"]').first).to_be_visible(timeout=10000)
        expect(page.get_by_text("Editorial Portrait Session", exact=True)).to_be_visible(timeout=10000)
        artist_chip = page.locator('[data-entity-chip="artist"]').first
        expect(artist_chip).to_be_visible()

        # Capability assertions: NO comment button, NO fake source like count, NO playlist button
        assert page.locator(".tl-action-btn--comment").count() == 0, "Comments button should be hidden on gallery_catalog"
        assert page.locator("[data-source-like-count]").count() == 0, "Fake source likes should be hidden on gallery_catalog"
        assert page.locator("[data-post-playlist]").count() == 0, "Playlist button should be hidden on gallery_catalog"

        # Mobile 44px touch target assertions
        amateur_btn = page.locator('[data-subfilter-id="amateur"]').first
        expect(amateur_btn).to_be_visible()
        if is_mobile:
            box = amateur_btn.bounding_box()
            assert box is not None and box["height"] >= 44, f"Mobile touch target too small at {width}px: {box}"
            abox = artist_chip.bounding_box()
            assert abox is not None and abox["height"] >= 44, f"Mobile entity chip target too small at {width}px: {abox}"

        # 1b. Clicking a gallery card opens full in-app GalleryDetailView (NOT Lightbox directly)
        page.locator('[data-layout-card="editorial_wall"] .tl-editorial-cover').first.click()
        gal_view = page.locator('[data-gallery-detail-view="true"]')
        expect(gal_view).to_be_visible(timeout=10000)
        expect(gal_view.locator('[data-gallery-photo-tile="0"]')).to_be_visible(timeout=10000)
        expect(gal_view.locator('[data-gallery-related-section="true"]')).to_be_visible(timeout=10000)
        assert page.locator("[data-lightbox-counter]").count() == 0, "Clicking gallery card must open GalleryDetailView, not Lightbox"
        # Clicking photo #1 opens Lightbox at 1 / 2
        gal_view.locator('[data-gallery-photo-tile="0"]').click()
        expect(page.locator("[data-lightbox-counter]")).to_have_text("1 / 2", timeout=10000)
        page.get_by_role("button", name=re.compile("^Close$|^Fechar$")).click()
        gal_view.locator('[data-gallery-detail-back="true"]').click()
        expect(page.locator('[data-layout-mode="editorial_wall"]')).to_be_visible(timeout=10000)

        # 2. Directory Switcher -> Artists -> Open Dedicated CatalogEntityView (no recycled creator profile / no Videos tab)
        dir_artists_btn = page.locator('[data-directory-kind="artists"]').first
        expect(dir_artists_btn).to_be_visible()
        dir_artists_btn.click()
        dir_item = page.locator('[data-directory-item-id="artist-alpha"]').first
        expect(dir_item).to_be_visible(timeout=10000)
        dir_item.click()

        expect(page.locator("[data-catalog-entity-view]")).to_be_visible(timeout=10000)
        expect(page.get_by_text("Artist Set Page 1", exact=True)).to_be_visible(timeout=10000)
        expect(page.locator("[data-profile-related-entities]")).to_be_visible()
        assert page.locator('[data-profile-tab="videos"]').count() == 0, "Videos (0) tab must be hidden on gallery_catalog"
        load_more_btn = page.locator("[data-load-more-profile-albums]")
        expect(load_more_btn).to_be_visible()
        load_more_btn.click()
        expect(page.get_by_text("Artist Set Page 2", exact=True)).to_be_visible(timeout=10000)

        page.get_by_role("button", name=re.compile("^Back|^Voltar")).first.click()

        # 3. Second Gallery Catalog loads cleanly with distinct Category-First Showcase layout
        select_source_via_more(page, "cat_beta")
        expect(page.locator('[data-layout-mode="category_showcase"]')).to_be_visible(timeout=10000)
        expect(page.locator('[data-layout-card="category_showcase"]').first).to_be_visible(timeout=10000)
        expect(page.get_by_text("Beta Studio Collection", exact=True)).to_be_visible(timeout=10000)

        # 4. Forum Board: distinct Forum Thread Index row layout; video_release renders mirror chip WITHOUT <video>
        select_source_via_more(page, "board_one")
        expect(page.locator('[data-layout-mode="forum_index"]')).to_be_visible(timeout=10000)
        expect(page.locator('[data-layout-card="forum_index"]').first).to_be_visible(timeout=10000)
        expect(page.get_by_text("Synthetic Video Release Thread", exact=True)).to_be_visible(timeout=10000)
        assert page.locator("article video").count() == 0, "Forum video_release without stream must NOT render <video>"
        expect(page.get_by_text("Mirror Fast", exact=True)).to_be_visible()

        # Open Forum Thread Reader and paginate Page 1 -> Page 2 + Open Gallery Lightbox
        page.locator("[data-open-thread-reader]").first.click()
        reader = page.locator('[data-forum-thread-reader="true"]')
        expect(reader).to_be_visible(timeout=10000)
        expect(reader.get_by_text("Release description on thread page 1.")).to_be_visible()
        reader.get_by_role("button", name=re.compile("^Next$|^Próxima$")).click()
        expect(reader.get_by_text("Release description on thread page 2.")).to_be_visible(timeout=10000)

        reader.get_by_role("button", name=re.compile("Open Gallery|Load Gallery|Carregar Galeria|Abrir Galeria")).click()
        expect(page.locator("[data-lightbox-counter]")).to_have_text("1 / 1", timeout=10000)
        page.get_by_role("button", name=re.compile("^Close$|^Fechar$")).click()
        page.locator("[data-thread-reader-back]").click()

        # Zero horizontal overflow & zero errors check
        has_no_overflow = page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
        assert has_no_overflow, f"Horizontal overflow detected at {width}x{height}"
        assert not page_errors, f"Page errors at {width}px: {page_errors}"
        assert not console_errors, f"Console errors at {width}px: {console_errors}"
        print(f"{width}x{height} (mobile={is_mobile}): Adaptive Catalog + Forum Thread Reader + Capabilities PASSED")
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
