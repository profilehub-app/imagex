#!/usr/bin/env python3
"""Local browser test of the real import panel with fixture-created JSON files."""
import json
import os
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

BASE = os.getenv("IMAGEX_TEST_ORIGIN", "http://127.0.0.1:5174")
ORIGIN = urlsplit(BASE).netloc

CREATOR = {"id":"fixture-author", "name":"Fixture", "handle":"@fixture", "profileUrl":"https://x.com/fixture", "avatar":"https://no-fetch.invalid/avatar"}
def post(url, caption):
    return {"id":url, "creatorId":CREATOR["id"], "originalUrl":url, "caption":caption, "photos":["https://no-fetch.invalid/photo"]}

def file(name, rows):
    return {"name":name, "mimeType":"application/json", "buffer":json.dumps({"creators":[CREATOR], "posts":rows}).encode()}

def main():
    with sync_playwright() as pw:
        for width, height in [(390, 844), (1366, 800)]:
            browser = pw.chromium.launch(
                executable_path=os.getenv("CHROMIUM_EXECUTABLE") or None, headless=True,
                args=["--no-sandbox", "--no-zygote", "--single-process", "--disable-dev-shm-usage"],
            )
            page = browser.new_page(viewport={"width":width, "height":height}, reduced_motion="reduce")
            unwanted = []
            def route(handler):
                url = urlsplit(handler.request.url)
                if url.netloc == ORIGIN and url.path == "/api/profile-hub/avatars/resolve" and (handler.request.post_data_json or {}).get("urls") == ["https://x.com/nativefixture"]:
                    handler.fulfill(status=200, json={"avatars": {}})
                    return
                if url.netloc != ORIGIN or url.path.startswith("/api/"):
                    unwanted.append(handler.request.url)
                    handler.abort()
                else:
                    handler.continue_()
            page.set_default_timeout(6500)
            page.on('pageerror', lambda error: print('PAGE ERROR', error, flush=True))
            page.route("**/*", route)
            # Route above mocks avatar lookup only for the unrelated native author.
            page.goto(f"{BASE}/test-fixtures/timeline-import.html")
            trigger = page.get_by_role("button", name="Importar lote")
            trigger.click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_be_visible()
            expect(dialog).to_contain_text("sem substituir nem sincronizar")
            inputs = dialog.locator("input[type=file]")
            inputs.set_input_files(file("page-1.json", [
                post("https://x.com/fixture/status/101", "Primeiro"),
                post("https://x.com/fixture/status/102", "Segundo"),
            ]))
            expect(dialog.locator("[data-import-post]")).to_have_count(2)
            inputs.set_input_files(file("page-2.json", [
                post("https://twitter.com/fixture/status/101", "Primeiro"),
                post("https://x.com/fixture/status/103", "Terceiro"),
            ]))
            expect(dialog.locator("[data-import-post]")).to_have_count(3)
            expect(dialog.locator("[data-import-result]")).to_contain_text("1 repetidas")
            inputs.set_input_files({"name":"corrupt.json", "mimeType":"application/json", "buffer":b"not JSON"})
            expect(dialog.get_by_role("alert")).to_contain_text("lotes anteriores foram mantidos")
            expect(dialog.locator("[data-import-post]")).to_have_count(3)
            expect(dialog.locator("img, video")).to_have_count(0)
            page.keyboard.press("Escape")
            expect(dialog).not_to_be_visible()
            expect(trigger).to_be_focused()
            expect(page.locator('[data-timeline-post-id="native-101"]')).to_be_visible()
            trigger.click()
            expect(dialog.locator("[data-import-post]")).to_have_count(3)
            imported = page.locator("[data-timeline-imported-post]")
            expect(imported).to_have_count(0)
            dialog.get_by_role("button", name="Adicionar à Timeline").click()
            expect(dialog).not_to_be_visible()
            more = page.get_by_role("button", name="Carregar mais publicações")
            if more.is_visible():
                more.click()
            expect(imported).to_have_count(2)
            expect(imported.filter(has_text="Segundo")).to_be_visible()
            expect(page.locator('[data-timeline-post-id="native-101"]')).to_be_visible()
            expect(imported.locator("img, video")).to_have_count(0)
            if width == 1366 and os.getenv("IMAGEX_TEST_SCREENSHOT"):
                page.screenshot(path=os.environ["IMAGEX_TEST_SCREENSHOT"])
            trigger.click()
            inputs.set_input_files(file("page-3.json", [post("https://x.com/fixture/status/104", "Quarto")]))
            expect(dialog.locator("[data-import-post]")).to_have_count(4)
            expect(imported).to_have_count(2)
            dialog.get_by_role("button", name="Retirar importações da Timeline").click()
            expect(imported).to_have_count(0)
            page.keyboard.press("Escape")
            expect(page.locator('[data-timeline-post-id="native-101"]')).to_be_visible()
            trigger.click()
            inputs.set_input_files(file("page-scroll.json", [
                post(f"https://x.com/fixture/status/{number}", f"Item local {number}") for number in range(200, 224)
            ]))
            expect(dialog.locator("[data-import-post]")).to_have_count(28)
            dialog.get_by_role("button", name="Adicionar à Timeline").click()
            expect(dialog).not_to_be_visible()
            expect(more).to_be_visible()
            before_scroll = imported.count()
            assert 0 < before_scroll < 27, before_scroll
            page.mouse.move(width // 2, height // 2)
            page.mouse.wheel(0, 10_000)
            expect(imported.nth(before_scroll)).to_be_attached()
            assert not unwanted, unwanted
            print(f"PASS {width}x{height}: main Timeline opt-in, native dedup, unpublished updates, removal, real downward scroll for next local batch, no imported network requests")
            browser.close()
if __name__ == "__main__":
    main()
