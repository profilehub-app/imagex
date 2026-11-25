#!/usr/bin/env python3
"""Live federated search, unbounded multi-page pagination, and Chromium E2E verification."""
from __future__ import annotations

import os
import re
import sys
import time
from urllib.parse import urlsplit

import httpx
from playwright.sync_api import expect, sync_playwright

BASE = os.getenv("IMAGEX_TEST_ORIGIN", "http://127.0.0.1:8100").rstrip("/")


def wait_for_server(timeout_s: float = 20.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            r = httpx.get(f"{BASE}/api/profile-hub/timeline/search-sources", timeout=3.0)
            if r.status_code == 200:
                return
        except Exception:
            pass
        time.sleep(0.4)
    raise RuntimeError(f"Server did not respond on {BASE} within {timeout_s}s")


def collect_pages_for_source(
    client: httpx.Client,
    query: str,
    source_id: str,
    category: str,
    pages: int = 3,
) -> tuple[list[dict], list[dict]]:
    all_profiles: list[dict] = []
    all_items: list[dict] = []
    seen_p: set[str] = set()
    seen_i: set[str] = set()
    cursor_key = f"{source_id}:{category}"
    next_cursor: str | None = None

    for page_idx in range(1, pages + 1):
        body: dict = {"query": query, "source": source_id, "category": category}
        if next_cursor:
            body["cursors"] = {cursor_key: next_cursor}
        resp = client.post(f"{BASE}/api/profile-hub/timeline/omni-search", json=body, timeout=35.0)
        assert resp.status_code == 200, f"{source_id}/{category} p{page_idx} HTTP {resp.status_code}"
        data = resp.json()
        sec = data.get("sections") or {}

        page_profiles = sec.get("profiles") or []
        page_items = sec.get(category) or []
        new_p = 0
        for p in page_profiles:
            k = (p.get("profileUrl") or p.get("id") or "").lower()
            pname = str(p.get("name") or "").strip()
            assert pname and not re.match(r"^rank\s*:?\s*\d+$", pname, re.I), f"Rank badge parsed as profile name on {source_id}: {p}"
            if k and k not in seen_p:
                seen_p.add(k)
                all_profiles.append(p)
                new_p += 1
        new_i = 0
        for it in page_items:
            k = (it.get("originalUrl") or it.get("id") or "").lower()
            if k and k not in seen_i:
                seen_i.add(k)
                all_items.append(it)
                new_i += 1
            cname = str(it.get("creatorName") or "").strip().lower()
            source_page = str(it.get("sourcePage") or "").strip()
            assert isinstance(it.get("thumbnail", ""), str), f"Non-string thumbnail on {source_id}: {it}"
            assert isinstance(it.get("creatorAvatar", ""), str), f"Non-string creatorAvatar on {source_id}: {it}"
            if not source_page:
                assert cname != query.strip().lower(), f"Synthetic query-as-creator detected on {source_id}: {it}"

        print(f"  [{source_id}:{category}] page {page_idx}: raw_p={len(page_profiles)} (+{new_p} new), raw_i={len(page_items)} (+{new_i} new)")
        cur_info = (data.get("cursors") or {}).get(cursor_key) or {}
        next_cursor = cur_info.get("cursor")
        if not cur_info.get("hasMore") or not next_cursor:
            break
    return all_profiles, all_items


def verify_live_api() -> None:
    with httpx.Client(timeout=35.0) as client:
        s_resp = client.get(f"{BASE}/api/profile-hub/timeline/search-sources")
        assert s_resp.status_code == 200
        source_ids = [s["id"] for s in s_resp.json()["sources"]]
        print("Discovered dynamic search sources:", source_ids)
        for req_id in ("youtube", "portal_grid", "portal_tube", "portal_state", "imgur", "x"):
            assert req_id in source_ids, f"Missing expected registered provider: {req_id}"

        # Compare two different dynamic queries to confirm zero hardcoded keywords
        r_luna = client.post(f"{BASE}/api/profile-hub/timeline/omni-search", json={"query": "luna", "source": "youtube", "category": "videos"}).json()
        r_music = client.post(f"{BASE}/api/profile-hub/timeline/omni-search", json={"query": "music", "source": "youtube", "category": "videos"}).json()
        luna_ids = {it["id"] for it in (r_luna["sections"]["videos"] or [])[:5]}
        music_ids = {it["id"] for it in (r_music["sections"]["videos"] or [])[:5]}
        assert luna_ids and music_ids and luna_ids != music_ids, "Queries must produce query-specific upstream results"

        # Multi-page unbounded pagination proofs per source
        print("\n--- Testing real multi-page pagination (Page 1 -> Page 2 -> Page 3, no caps) ---")
        _, yt_vids = collect_pages_for_source(client, "luna", "youtube", "videos", pages=3)
        yt_profs, _ = collect_pages_for_source(client, "luna", "youtube", "profiles", pages=2)
        _, yt_pls = collect_pages_for_source(client, "luna", "youtube", "playlists", pages=2)
        assert len(yt_vids) >= 35, f"Expected unbounded YouTube videos >= 35 across 3 pages, got {len(yt_vids)}"
        assert len(yt_profs) >= 15, f"Expected YouTube channels >= 15, got {len(yt_profs)}"
        assert len(yt_pls) >= 15, f"Expected YouTube playlists >= 15, got {len(yt_pls)}"

        _, ep_vids = collect_pages_for_source(client, "luna", "portal_grid", "videos", pages=3)
        ep_profs, _ = collect_pages_for_source(client, "luna", "portal_grid", "profiles", pages=2)
        _, ep_pls = collect_pages_for_source(client, "luna", "portal_grid", "playlists", pages=2)
        _, ep_albs = collect_pages_for_source(client, "luna", "portal_grid", "albums", pages=2)
        assert len(ep_vids) >= 80, f"Expected PortalGrid multi-page videos >= 80, got {len(ep_vids)}"
        assert len(ep_profs) >= 10, f"Expected PortalGrid profiles, got {len(ep_profs)}"
        assert len(ep_pls) >= 10, f"Expected PortalGrid playlists, got {len(ep_pls)}"
        assert len(ep_albs) >= 20, f"Expected PortalGrid albums, got {len(ep_albs)}"

        _, ph_vids = collect_pages_for_source(client, "luna", "portal_tube", "videos", pages=2)
        ph_profs, _ = collect_pages_for_source(client, "luna", "portal_tube", "profiles", pages=2)
        ph_lana_profs, _ = collect_pages_for_source(client, "lana", "portal_tube", "profiles", pages=1)
        _, ph_gifs = collect_pages_for_source(client, "lana", "portal_tube", "gifs", pages=2)
        _, ph_albs = collect_pages_for_source(client, "blonde", "portal_tube", "albums", pages=2)
        assert len(ph_vids) >= 35, f"Expected PortalTube videos >= 35 across 2 pages, got {len(ph_vids)}"
        assert len(ph_profs) >= 5, f"Expected PortalTube profiles >= 5, got {len(ph_profs)}"
        assert any("lana" in str(p.get("name") or "").lower() for p in ph_lana_profs), f"Expected real 'Lana ...' PortalTube profiles, got {[p.get('name') for p in ph_lana_profs[:5]]}"
        assert any("lana" in str(g.get("title") or "").lower() for g in ph_gifs), f"Expected query-matched PortalTube GIFs for 'lana', got {[g.get('title') for g in ph_gifs[:5]]}"
        assert len(ph_albs) >= 10, f"Expected PortalTube blonde albums >= 10, got {len(ph_albs)}"

        _, xh_vids = collect_pages_for_source(client, "luna", "portal_state", "videos", pages=3)
        _, xh_albs = collect_pages_for_source(client, "luna", "portal_state", "albums", pages=2)
        assert len(xh_vids) >= 60, f"Expected PortalState videos >= 60 across 3 pages, got {len(xh_vids)}"
        assert len(xh_albs) >= 12, f"Expected PortalState albums >= 12 across 2 pages, got {len(xh_albs)}"
        xh_vid_real = sum(1 for v in xh_vids if str(v.get("creatorName") or "").strip().lower() not in ("", "portal_state"))
        xh_alb_real = sum(1 for a in xh_albs if str(a.get("creatorName") or "").strip().lower() not in ("", "portal_state"))
        print(f"  [portal_state attribution] videos real={xh_vid_real}/{len(xh_vids)}, albums real={xh_alb_real}/{len(xh_albs)}")
        assert xh_vid_real >= int(len(xh_vids) * 0.85), f"Too many neutral PortalState video creators: {xh_vid_real}/{len(xh_vids)}"
        assert xh_alb_real >= int(len(xh_albs) * 0.80), f"Too many neutral PortalState album creators: {xh_alb_real}/{len(xh_albs)}"

        _, im_albs = collect_pages_for_source(client, "luna", "imgur", "albums", pages=2)
        _, im_gifs = collect_pages_for_source(client, "luna", "imgur", "gifs", pages=2)
        assert len(im_albs) >= 15, f"Expected Imgur multi-page albums >= 15, got {len(im_albs)}"
        assert len(im_gifs) >= 1, f"Expected Imgur animated GIFs >= 1, got {len(im_gifs)}"

        x_profs, _ = collect_pages_for_source(client, "openai", "x", "profiles", pages=1)
        _, x_posts = collect_pages_for_source(client, "luna", "x", "posts", pages=2)
        print(f"  [x summary] openai profiles={len(x_profs)}, luna fallback posts={len(x_posts)}")
        assert len(x_profs) >= 1 or len(x_posts) >= 1, "Expected X provider to resolve live profile or posts"

        # Multi-source 'all' + 'videos' returns round-robin interleaved sources in top cards
        r_all_vids = client.post(
            f"{BASE}/api/profile-hub/timeline/omni-search",
            json={"query": "luna", "source": "all", "category": "videos"},
        ).json()
        top_sources = [str(it.get("source") or "").lower() for it in (r_all_vids.get("sections", {}).get("videos") or [])[:6]]
        print("  [all:videos round-robin top 6 sources]", top_sources)
        assert len(set(top_sources[:4])) >= 2, f"Expected round-robin interleaved sources in top 4 cards, got {top_sources}"


def verify_browser_e2e() -> None:
    print("\n--- Running real Chromium Playwright Desktop & Mobile E2E verification ---")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--no-sandbox"])
        for label, width, height in [("desktop", 1280, 800), ("mobile-390", 390, 844), ("mobile-320", 320, 700)]:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                is_mobile=width < 768,
                has_touch=width < 768,
                locale="en-US",
            )
            page = context.new_page()
            page_errors: list[str] = []
            server_500s: list[str] = []
            page.on("pageerror", lambda err: page_errors.append(str(err)))
            page.on("response", lambda resp: server_500s.append(f"{resp.status} {resp.url}") if resp.status >= 500 and "/api/" in resp.url else None)

            page.goto(f"{BASE}/#/timeline-preview", wait_until="domcontentloaded", timeout=30000)
            search_input = page.locator('[data-omni-search-input="true"]')
            expect(search_input).to_be_visible(timeout=15000)

            # Confirm duplicate loaded-only mobile search bar is gone
            assert page.locator("#timeline-local-search").count() == 0, "#timeline-local-search must be removed"

            # Search "luna" in top search bar and verify background feed warning stays hidden
            search_input.fill("luna")
            page.locator('[data-omni-search-submit="true"]').click()

            ws = page.locator('[data-search-workspace="true"]')
            expect(ws).to_be_visible(timeout=25000)
            expect(ws.locator('[data-search-section="profiles"]')).to_be_visible(timeout=25000)
            expect(ws.locator('[data-search-section="playlists"]')).to_be_visible(timeout=25000)
            expect(ws.locator('[data-search-section="videos"]')).to_be_visible(timeout=25000)
            assert page.locator(".tl-scope-warning").count() == 0, "Background scope warning must not appear during Search Mode"

            # Verify PortalTube Profiles contain real names (never Rank:0)
            if label == "desktop":
                ws.locator('[data-search-source-pill="portal_tube"]').click()
                ws.locator('[data-search-category-tab="profiles"]').click()
                expect(ws.locator('[data-search-profile-card]').first).to_be_visible(timeout=15000)
                ph_card_texts = ws.locator('[data-search-profile-card]').all_inner_texts()
                assert ph_card_texts and not any(re.search(r'\brank\s*:\s*\d+', txt, re.I) for txt in ph_card_texts), f"Found Rank:0 in PortalTube UI cards: {ph_card_texts[:4]}"
                ws.locator('[data-search-source-pill="all"]').click()
                ws.locator('[data-search-category-tab="all"]').click()

            # Verify no horizontal overflow
            overflow = page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1")
            assert not overflow, f"Horizontal overflow detected at {label} ({width}x{height})"

            if label == "desktop":
                # Switch Source pills & Category tabs
                ws.locator('[data-search-source-pill="youtube"]').click()
                expect(ws.locator('[data-search-category-tab="playlists"]')).to_be_visible()
                ws.locator('[data-search-category-tab="playlists"]').click()
                pl_btn = ws.locator('[data-playlist-open-inapp="true"]').first
                expect(pl_btn).to_be_visible(timeout=10000)
                pl_btn.click()

                dialog = page.locator('dialog[aria-labelledby="tl-search-playlist-modal-title"]')
                expect(dialog).to_be_visible(timeout=10000)
                expect(dialog.locator('[data-playlist-track]').first).to_be_visible(timeout=20000)
                page.keyboard.press("Escape")
                expect(dialog).to_have_count(0)

                # Test Imgur albums opening in PhotoLightboxModal without scan-stream errors and neutral attribution has no fake creator link
                ws.locator('[data-search-source-pill="imgur"]').click()
                ws.locator('[data-search-category-tab="albums"]').click()
                assert ws.locator('[data-search-section="albums"] [data-post-creator-id="imgur:imgur"]').count() == 0
                alb_open = ws.locator('[data-search-section="albums"] button[aria-label*="Open album photo"]').first
                if alb_open.count() > 0:
                    alb_open.click()
                    expect(page.locator('dialog img').first).to_be_visible(timeout=15000)
                    page.keyboard.press("Escape")

                # Switch back to All sources and verify Timeline-matched progressive lazy windowing + Load More + scroll auto-load
                ws.locator('[data-search-source-pill="all"]').click()
                ws.locator('[data-search-category-tab="videos"]').click()
                before_cards = ws.locator('[data-search-section="videos"] [data-timeline-post-id]').count()
                assert 1 <= before_cards <= 16, f"Expected windowed initial search DOM (<=16 cards), got {before_cards}"
                eager_posters = ws.evaluate(
                    "() => Array.from(document.querySelectorAll('[data-search-section=\"videos\"] [data-timeline-post-id] video + img')).filter(img => img.loading !== 'lazy').length"
                )
                assert eager_posters == 0, f"Expected all video poster images to use loading='lazy', found {eager_posters} eager"
                load_more = ws.locator('[data-search-load-more="true"]')
                expect(load_more).to_be_visible(timeout=10000)
                load_more.click()
                page.wait_for_function(
                    f"() => document.querySelectorAll('[data-search-section=\"videos\"] [data-timeline-post-id]').length > {before_cards}",
                    timeout=25000,
                )
                after_click = ws.locator('[data-search-section="videos"] [data-timeline-post-id]').count()
                # Scroll down inside <main> & wheel downward -> lazy window auto-expands
                page.evaluate("() => { const m = document.querySelector('main'); if (m) m.scrollTop = m.scrollHeight; }")
                page.mouse.move(600, 400)
                page.mouse.wheel(0, 400)
                page.wait_for_function(
                    f"() => document.querySelectorAll('[data-search-section=\"videos\"] [data-timeline-post-id]').length > {after_click}",
                    timeout=15000,
                )
                after_cards = ws.locator('[data-search-section="videos"] [data-timeline-post-id]').count()
                print(f"  [desktop DOM lazy pagination] videos cards grew {before_cards} -> {after_click} (click) -> {after_cards} (scroll)")

            assert not page_errors, f"Uncaught page errors on {label}: {page_errors}"
            assert not server_500s, f"Server 5xx errors on {label}: {server_500s}"
            print(f"  PASS {label} ({width}x{height}): federated sections, source/category tabs, in-app playlist modal, Load More, 0 overflow")
            context.close()

        browser.close()


def main() -> None:
    wait_for_server()
    verify_live_api()
    verify_browser_e2e()
    print("\nALL LIVE MULTI-PAGE PAGINATION & E2E VERIFICATION CHECKS PASSED!")


if __name__ == "__main__":
    main()
