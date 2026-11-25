#!/usr/bin/env python3
"""Offline browser regression. Start the frontend Vite server, then run this file.

Python Playwright, Chromium and FFmpeg are required. No X API, real account,
external media, or backend service is used. The asset handlers are test only.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

BASE = os.getenv("IMAGEX_TEST_ORIGIN", "http://127.0.0.1:5174").rstrip("/")
ORIGIN = urlsplit(BASE).netloc
COLORS = {"first": "#aa3366", "second": "#339966", "third": "#3366aa"}


def run(browser, asset: bytes, width: int, height: int, locale: str):
    english = locale == "en-US"
    context = browser.new_context(
        viewport={"width": width, "height": height}, is_mobile=width < 768,
        has_touch=width < 768, reduced_motion="reduce", locale=locale,
    )
    blocked = []

    def request(route):
        requested = urlsplit(route.request.url)
        if requested.netloc != ORIGIN:
            if requested.scheme in {"http", "https"}:
                blocked.append(requested.netloc)
            return route.abort()
        path = requested.path
        if path.startswith("/api/") and "proxy-video" not in path and not path.startswith("/api/stream"):
            # Stub image-proxy and app data in-browser; the real backend is never called.
            return route.fulfill(status=200, content_type="application/json", body="{}")
        if path.endswith("timeline-asset-video.mp4") or "proxy-video" in path or path.startswith("/api/stream"):
            byte_range = re.fullmatch(r"bytes=(\d+)-(\d*)", route.request.headers.get("range", ""))
            if byte_range:
                start = int(byte_range[1])
                end = min(int(byte_range[2]) if byte_range[2] else len(asset)-1, len(asset)-1)
                if start > end:
                    return route.fulfill(status=416, headers={"content-range": f"bytes */{len(asset)}"})
                return route.fulfill(status=206, content_type="video/mp4", body=asset[start:end+1], headers={
                    "content-range": f"bytes {start}-{end}/{len(asset)}", "accept-ranges": "bytes",
                })
            return route.fulfill(status=200, content_type="video/mp4", body=asset)
        if path.startswith("/test-fixtures/timeline-asset-"):
            label = Path(path).stem.rsplit("-", 1)[-1]
            color = COLORS.get(label, "#667788")
            return route.fulfill(content_type="image/svg+xml", body=f'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="{color}"/></svg>')
        return route.continue_()

    context.route("**/*", request)
    page = context.new_page()
    page.set_default_timeout(6500)
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.goto(f"{BASE}/test-fixtures/timeline-social.html?lang={locale}#/timeline-preview", wait_until="domcontentloaded")
    root = page.locator("html")
    for name in ("valid-fixture", "rejects-malformed-relation", "rejects-unknown-type"):
        expect(root).to_have_attribute(f"data-{name}", "true", timeout=15_000)

    def card(identifier):
        return page.locator(f'[data-timeline-post-id="fixture-{identifier}"]:visible').first

    def ensure_feed_post(identifier):
        target = card(identifier)
        for _ in range(5):
            if target.count():
                return target
            more = page.get_by_role("button", name="Load more posts" if english else "Carregar mais publicações")
            if not more.count():
                break
            more.click()
        expect(target).to_be_visible()
        return target

    text_card = card("text")
    expect(text_card.get_by_text("Distinctive text-only fixture. No fake image.")).to_be_visible()
    expect(text_card.locator("video, iframe, [data-video-container], [data-social-carousel]")).to_have_count(0)
    expect(text_card.locator("[data-social-source-metrics]")).to_contain_text("—")
    expect(text_card.locator("[data-social-source-metrics]")).to_contain_text("0")  # an actual zero is not unknown
    quote = ensure_feed_post("quote").locator("[data-social-relation='quote']")
    expect(quote).to_contain_text("Quoted Fixture")
    expect(quote).to_contain_text("Words from the quoted writer.")
    expect(ensure_feed_post("repost").locator("[data-social-relation='repost']")).to_contain_text("Original Fixture")

    feed_cards = page.locator("[data-timeline-post-id]:visible")
    widths = feed_cards.evaluate_all("(xs) => xs.map(x => { const b=x.getBoundingClientRect(); return [b.left,b.top,b.width] })")
    assert len(widths) >= 3 and widths[-1][1] > widths[0][1]
    assert max(x[0] for x in widths) - min(x[0] for x in widths) <= 1, widths
    assert max(x[2] for x in widths) - min(x[2] for x in widths) <= 1, widths
    assert page.locator("main").evaluate("(x) => x.scrollWidth <= x.clientWidth + 1"), "horizontal overflow"

    carousel = ensure_feed_post("ig-carousel").locator("[data-social-carousel]").first
    expect(carousel.get_by_role("img")).to_have_attribute("src", re.compile(r"first\.svg"))
    carousel.get_by_role("button", name="Next photo" if english else "Próxima foto").click()
    expect(carousel.get_by_role("img")).to_have_attribute("src", re.compile(r"second\.svg"))
    carousel.get_by_role("button", name=re.compile(r"Open Photo 2|Abrir Foto 2")).click()
    expect(page.get_by_role("dialog")).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.get_by_role("dialog")).to_have_count(0)

    screenshot_dir = os.getenv("IMAGEX_TEST_SCREENSHOTS")
    if screenshot_dir:
        destination = Path(screenshot_dir)
        destination.mkdir(parents=True, exist_ok=True)
        main = page.locator("main")
        main.evaluate("(el) => {el.scrollTop = 0}")
        page.screenshot(path=str(destination / f"timeline-{width}-{locale}.png"))

    trigger = card("carousel").locator("[data-post-creator-id]")
    trigger.scroll_into_view_if_needed()
    main = page.locator("main")
    prev = main.evaluate("(x) => x.scrollTop")
    assert prev > 0, "scroll restore check did not exercise a scrolled feed"
    trigger.click()
    posts_tab = page.locator("[data-profile-tab='timeline']:visible")
    expect(posts_tab).to_contain_text("Posts" if english else "Publicações")
    expect(card("text").get_by_text("Distinctive text-only fixture. No fake image.")).to_be_visible()
    # Only supported groups appear; no fake video/GIF/playlist for this creator.
    for missing in ("videos", "playlists", "gifs"):
        expect(page.locator(f"[data-profile-tab='{missing}']:visible")).to_have_count(0)
    if screenshot_dir:
        page.screenshot(path=str(destination / f"creator-{width}-{locale}.png"))
    page.get_by_role("button", name="Back to Timeline" if english else "Voltar para a Linha do Tempo").click()
    expect(page.get_by_role("heading", name="Timeline", exact=True)).to_be_visible()
    page.wait_for_function("(previous) => Math.abs(document.querySelector('main').scrollTop - previous) <= 3", arg=prev)
    expect(trigger).to_be_focused()

    legacy_types = {"video": "video", "photo": "photo_grid", "album": "album", "gif": "gif", "playlist": "playlist"}
    for fixture, kind in legacy_types.items():
        element = ensure_feed_post(fixture)
        expect(element).to_have_attribute("data-media-type", kind)
        expect(element.locator("[data-social-carousel], [data-social-body]")).to_have_count(0)

    for fixture_id in ("video", "ig-video"):
        fixture_card = ensure_feed_post(fixture_id)
        if fixture_id == "ig-video":
            expect(fixture_card.locator("[data-social-body]")).to_contain_text("Instagram text before the player.")
        player = fixture_card.locator("[data-video-container]")
        expect(player).to_be_visible()
        player.click()
        watch = page.locator("[data-watch-active='true']")
        expect(watch).to_be_visible()
        expect(watch.locator("[data-persistent-watch-slot]")).to_be_visible()
        expect(watch.locator("video").first).to_be_visible()
        page.wait_for_function("() => { const x = document.querySelector('[data-watch-active=true] video'); return x && x.readyState >= 2 && x.muted; }")
        watch.get_by_role("button", name="Back" if english else "Voltar", exact=True).click()
        expect(watch).to_have_count(0)
    assert not blocked, f"Unexpected requests to other hosts (blocked): {blocked}"
    assert not errors, errors
    print(f"PASS {width}x{height} {locale}: feed, creator, carousel/lightbox, five native types, muted native and social video in existing Watch player.")
    context.close()


def main():
    chromium = os.getenv("CHROMIUM_EXECUTABLE") or shutil.which("chromium")
    with tempfile.TemporaryDirectory() as tmp:
        asset = Path(tmp) / "fixture.mp4"
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
            "color=c=gray:s=320x180:d=8:r=10", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(asset),
        ], check=True, timeout=30)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chromium, headless=True, args=["--no-sandbox"])
            run(browser, asset.read_bytes(), 1366, 800, "en-US")
            run(browser, asset.read_bytes(), 390, 844, "pt-BR")
            browser.close()


if __name__ == "__main__":
    main()
