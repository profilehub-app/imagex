"""Exercise the compiled Timeline and unpacked X connector with isolated browser data."""

import base64
import hashlib
import json
import os
import re
import ssl
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from playwright.sync_api import expect, sync_playwright

ORIGIN = "http://127.0.0.1:8100"
CONNECTOR = Path(__file__).resolve().parents[1] / "chrome-x-connector"


def tweet(number, text):
    return f"""
    <article data-testid="tweet" style="height: 480px">
      <div data-testid="User-Name">Fixture X Author<br>@fixture</div>
      <a href="/fixture/status/{number}"><time datetime="2026-11-19T00:00:00Z">Nov 19</time></a>
      <div data-testid="tweetText">{text}</div>
    </article>
    """


def x_fixture(path):
    nav = '<nav><a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a></nav>'
    if path == "/owner/following":
        body = '<div data-testid="UserCell"><a href="/fixture">Fixture account</a></div>'
    elif path == "/fixture":
        body = tweet(30, "X profile publication")
    else:
        body = f"""
        <div role="tablist">
          <button role="tab" aria-selected="true">For you</button>
          <button role="tab" aria-selected="false" onclick="
            this.previousElementSibling.setAttribute('aria-selected', false);
            this.setAttribute('aria-selected', true);
            document.querySelector('#feed').replaceChildren(document.querySelector('#following').content.cloneNode(true));
          ">Following</button>
        </div>
        <div id="feed">{tweet(1, "X recommended publication")}</div>
        <template id="following">{tweet(20, "X following publication")}</template>
        <template id="more">{tweet(1, "X recommended publication")}{tweet(2, "X next publication")}</template>
        <script>
          addEventListener('scroll', () => {{
            document.querySelector('#feed').append(document.querySelector('#more').content.cloneNode(true));
          }}, {{once: true}});
        </script>
        """
    return (
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">'
        f'{nav}<main data-testid="primaryColumn" style="min-height:1600px">{body}</main>'
    ).encode()


@contextmanager
def fixture_origin(directory):
    """Route x.com to an isolated HTTPS fixture, including extension-created tabs."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "x.com")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(minutes=10))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("x.com")]), critical=False)
        .sign(key, hashes.SHA256())
    )
    pem = Path(directory) / "fixture.pem"
    pem.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                     serialization.NoEncryption()) + cert.public_bytes(serialization.Encoding.PEM))
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(pem)
    digest = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    pin = base64.b64encode(hashlib.sha256(digest).digest()).decode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = x_fixture(self.path)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_port, pin
        finally:
            server.shutdown()
            thread.join()


def import_sources(page):
    rows = [
        ("instagram", "https://www.instagram.com/fixture/", "https://www.instagram.com/p/Fixture/", "Instagram publication"),
        ("youtube", "https://www.youtube.com/@fixture", "https://youtu.be/jNQXAC9IVRw", "YouTube publication"),
        ("x", "https://twitter.com/fixture", "https://twitter.com/fixture/status/1", "Archived X duplicate"),
    ]
    creators = [{"id": site, "name": site, "profileUrl": profile, "site": site} for site, profile, _, _ in rows]
    posts = [
        {"id": url, "creatorId": site, "originalUrl": url, "text": text, "date": "2026-11-19"}
        for site, _, url, text in rows
    ]
    page.get_by_role("button", name=re.compile("Import batch|Importar lote")).click()
    dialog = page.get_by_role("dialog")
    dialog.locator("input[type=file]").set_input_files({
        "name": "timeline.json", "mimeType": "application/json",
        "buffer": json.dumps({"creators": creators, "posts": posts}).encode(),
    })
    expect(dialog.locator("[data-import-post]")).to_have_count(len(rows))
    dialog.get_by_role("button", name=re.compile("Add to Timeline|Adicionar à Timeline")).click()


def use_source(page, source):
    names = {"all": "All|Tudo", "x": "X", "youtube": "YouTube", "instagram": "Instagram"}
    page.get_by_role("navigation", name=re.compile("^Sources$|^Fontes$")).get_by_role(
        "button", name=re.compile(f"^({names[source]})$"),
    ).click()


def test_view(playwright, width, touch):
    with TemporaryDirectory(prefix="imagex-unified-test-") as profile, fixture_origin(profile) as (port, pin):
        context = playwright.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True,
            viewport={"width": width, "height": 800}, is_mobile=touch, has_touch=touch,
            args=[
                f"--disable-extensions-except={CONNECTOR}", f"--load-extension={CONNECTOR}",
                f"--host-resolver-rules=MAP x.com 127.0.0.1:{port}",
                f"--ignore-certificate-errors-spki-list={pin}", "--no-proxy-server",
            ],
        )
        try:
            # Dedicated-browser access would hide connector failures in this test.
            context.route("**/api/social-timeline/x/**", lambda route: route.abort())
            page = context.pages[0]
            feed_cards = page.locator("main [data-timeline-post-id]")
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"{ORIGIN}/#/timeline-preview", wait_until="domcontentloaded")
            expect(feed_cards.get_by_text("X recommended publication", exact=True)).to_be_visible(timeout=15000)
            import_sources(page)
            for caption in ("Instagram publication", "YouTube publication", "X recommended publication"):
                expect(feed_cards.get_by_text(caption, exact=True)).to_be_visible()
            expect(feed_cards.get_by_text("Archived X duplicate", exact=True)).to_have_count(0)
            for source, caption in (("instagram", "Instagram publication"), ("youtube", "YouTube publication")):
                use_source(page, source)
                expect(feed_cards.get_by_text(caption, exact=True)).to_be_visible()
                expect(feed_cards.get_by_text("X recommended publication", exact=True)).to_have_count(0)
                views = page.get_by_role("navigation", name=re.compile("Feed views|Visualizações do feed"))
                if source == "instagram":
                    expect(views.get_by_role("button", name="Reels", exact=True)).to_be_visible()
                    expect(views.get_by_role("button", name="Shorts", exact=True)).to_have_count(0)
                    views.get_by_role("button", name="Reels", exact=True).click()
                else:
                    expect(views.get_by_role("button", name="Shorts", exact=True)).to_be_visible()
                    expect(page.get_by_role("link", name=re.compile("Subscriptions on YouTube|Inscrições no YouTube"))).to_have_attribute(
                        "href", "https://www.youtube.com/feed/subscriptions",
                    )
                    views.get_by_role("button", name="Shorts", exact=True).click()
                expect(feed_cards.get_by_text(caption, exact=True)).to_have_count(0)
            use_source(page, "all")
            main = page.locator("main")
            main.evaluate("(main) => {main.scrollTop = main.scrollHeight}")
            expect(feed_cards.get_by_text("X next publication", exact=True)).to_have_count(0)
            if touch:
                session = context.new_cdp_session(page)
                last_card = feed_cards.last.bounding_box()
                x, y = round(last_card["x"] + last_card["width"] / 2), round(last_card["y"] + last_card["height"] / 2)
                session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
                for delta in (30, 66, 108, 150):
                    session.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - delta}]})
                session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            else:
                page.mouse.move(width // 2, 550)
                page.mouse.wheel(0, 650)
            expect(feed_cards.get_by_text("X next publication", exact=True)).to_be_visible(timeout=12000)
            expect(feed_cards.get_by_text("X recommended publication", exact=True)).to_have_count(1)
            screenshot_dir = os.getenv("IMAGEX_TEST_SCREENSHOT_DIR")
            if screenshot_dir:
                main.evaluate("(main) => {main.scrollTop = 0}")
                page.screenshot(path=Path(screenshot_dir) / f"timeline-unified-{width}.png")
            use_source(page, "x")
            if screenshot_dir:
                main.evaluate("(main) => {main.scrollTop = 0}")
                page.screenshot(path=Path(screenshot_dir) / f"timeline-x-redesign-{width}.png")
            page.get_by_role("button", name=re.compile("^Following$|^Seguindo$")).click()
            expect(feed_cards.get_by_text("X following publication", exact=True)).to_be_visible(timeout=12000)
            page.get_by_role("button", name=re.compile("Followed accounts|Perfis seguidos")).click()
            account = page.get_by_role("button", name=re.compile(r"Fixture account.*@fixture"))
            expect(account).to_be_visible(timeout=12000)
            account.click()
            expect(feed_cards.get_by_text("X profile publication", exact=True)).to_be_visible(timeout=12000)
            page.get_by_role("button", name=re.compile("^Media$|^Mídia$")).click()
            expect(feed_cards.get_by_text("X profile publication", exact=True)).to_have_count(0)
            page.get_by_role("button", name=re.compile("^Back$|^Voltar$")).click()
            expect(account).to_be_focused()
            assert main.evaluate("(main) => main.scrollWidth <= main.clientWidth + 1")
            assert not errors, errors
            print(f"{width}px: mixed feed, source filters, X connector navigation, scroll and deduplication")
        finally:
            context.close()


if __name__ == "__main__":
    with sync_playwright() as playwright:
        test_view(playwright, width=1280, touch=False)
        test_view(playwright, width=320, touch=True)
