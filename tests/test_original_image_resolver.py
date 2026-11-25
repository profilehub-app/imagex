import io
import json
from pathlib import Path
from unittest.mock import MagicMock

import httpx
from PIL import Image
import pytest


def _make_png_bytes(width: int, height: int, min_bytes: int = 4096) -> bytes:
    buf = io.BytesIO()
    img = Image.new("RGB", (width, height), color=(180, 120, 90))
    img.save(buf, format="PNG")
    data = buf.getvalue()
    if len(data) < min_bytes:
        data = data + b"\x00" * (min_bytes - len(data))
    return data


def _setup_test_connectors(tmp_path: Path, monkeypatch) -> None:
    from src.server.connector_registry import clear_connector_cache

    cfg = {
        "catalogs": [
            {
                "id": "cat_alpha",
                "displayName": "Catalog Alpha",
                "baseUrl": "https://alpha.example",
                "domains": ["alpha.example", "cdn.alpha.example"],
                "browse": {"thumbUpgrade": ["/460/", "/1280/"]},
            },
            {
                "id": "cat_beta",
                "displayName": "Catalog Beta",
                "baseUrl": "https://beta.example",
                "domains": ["beta.example", "cdn.beta.example"],
                "browse": {"thumbUpgrade": ["/460/", "/1280/"]},
            },
        ],
        "forums": [],
        "imageHosts": [
            {
                "id": "viewer_one",
                "domains": ["viewer-one.example"],
                "viewerPathPrefixes": ["/show/"],
                "directHostRegex": "^img\\d*\\.viewer-one\\.example$",
                "directPathPrefixes": ["/images/", "/thumbs/"],
                "thumbToFullReplace": ["^https?://t(\\d+)\\.viewer-one\\.example/thumbs/(.+)$", "https://img\\1.viewer-one.example/images/\\2"],
            },
            {
                "id": "viewer_two",
                "domains": ["viewer-two.example"],
                "viewerPathPrefixes": ["/i/"],
                "directHostRegex": "^i\\d+\\.viewer-two\\.example$",
                "directPathPrefixes": ["/u/i/", "/i0"],
            },
            {
                "id": "viewer_three",
                "domains": ["viewer-three.example"],
                "viewerPathPrefixes": ["/v/", "/show/"],
                "viewerPathRegex": "^/[a-z0-9]{6,}/?$",
                "directHostRegex": "^i\\d*\\.viewer-three\\.example$",
                "directPathPrefixes": ["/i/"],
            },
        ],
    }
    p = tmp_path / "connectors.resolver.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(p))
    clear_connector_cache()


def test_placeholder_and_viewer_classifiers_and_candidates(tmp_path: Path, monkeypatch):
    from src.server.original_image_resolver import (
        generate_deterministic_original_candidates,
        is_image_viewer_url,
        is_placeholder_media_url,
    )

    _setup_test_connectors(tmp_path, monkeypatch)

    assert is_placeholder_media_url("https://static.alpha.example/style/img/1px.png") is True
    assert is_placeholder_media_url("data:image/png;base64,iVBORw0KGgo=") is True
    assert is_placeholder_media_url("https://cdn.example/assets/spacer.gif") is True
    assert is_placeholder_media_url("https://cdn.alpha.example/avatars/u1.jpg") is True
    assert is_placeholder_media_url("https://cdn.alpha.example/1280/1/2/photo.jpg") is False

    assert is_image_viewer_url("https://viewer-one.example/show/45/350279944_004.jpg") is True
    assert is_image_viewer_url("https://viewer-two.example/i/3sz6fp") is True
    assert is_image_viewer_url("https://viewer-three.example/m9lp6vlls9gs") is True
    assert is_image_viewer_url("https://i01.viewer-two.example/i/2025/01/file.jpg") is False
    assert is_image_viewer_url("https://img86.viewer-one.example/images/45/350279944_004.jpg") is False
    assert is_image_viewer_url("https://cdn.alpha.example/1280/foo.jpg") is False

    cands_pp = generate_deterministic_original_candidates("https://cdn.alpha.example/460/1/2/abc.jpg")
    assert "https://cdn.alpha.example/1280/1/2/abc.jpg" in cands_pp

    cands_hq = generate_deterministic_original_candidates("https://cdn.beta.example/460/3/4/xyz.jpg")
    assert "https://cdn.beta.example/1280/3/4/xyz.jpg" in cands_hq

    cands_pix = generate_deterministic_original_candidates("https://t86.viewer-one.example/thumbs/45/350279944_004.jpg")
    assert "https://img86.viewer-one.example/images/45/350279944_004.jpg" in cands_pix

    cands_viewer = generate_deterministic_original_candidates("https://viewer-two.example/u/t/2025/01/01/3sz6fp.jpg")
    assert not any("/u/i/" in c for c in cands_viewer)


def test_targeted_gateway_form_ignores_unrelated_forms():
    from src.server.original_image_resolver import extract_targeted_gateway_form

    search_only_html = """
    <html><body>
      <form action="/search" method="POST">
        <input type="text" name="query" value="" />
        <button type="submit">Search</button>
      </form>
      <img src="https://i8.viewer-three.example/i/abc/full.jpg" />
    </body></html>
    """
    assert extract_targeted_gateway_form(search_only_html, "https://viewer-three.example/m9lp6vlls9gs") is None

    gw_html = """
    <html><body>
      <form action="" method="POST">
        <input type="hidden" name="imgContinue" value="Continue to your image" />
        <button type="submit" name="imgContinue" value="Continue to your image">Continue to your image</button>
      </form>
    </body></html>
    """
    parsed = extract_targeted_gateway_form(gw_html, "https://viewer-two.example/i/3sz6fp")
    assert parsed is not None
    action, payload = parsed
    assert action == "https://viewer-two.example/i/3sz6fp"
    assert payload.get("imgContinue") == "Continue to your image"


@pytest.mark.asyncio
async def test_original_image_resolver_hosts_and_dual_tier_thresholds(tmp_path: Path, monkeypatch):
    from src.server.original_image_resolver import OriginalImageResolver, PhotoResolveRequest

    _setup_test_connectors(tmp_path, monkeypatch)
    hd_png = _make_png_bytes(800, 1000, min_bytes=5000)
    small_png = _make_png_bytes(80, 80, min_bytes=4000)
    post_calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if request.method == "POST":
            post_calls.append(u)
            if "viewer-two.example/i/3sz6fp" in u:
                return httpx.Response(
                    200,
                    html='<html><body><img class="centred" src="https://i01.viewer-two.example/u/i/2025/01/3sz6fp.jpg" /></body></html>',
                )
            return httpx.Response(500, text="Unexpected POST on non-gateway form")

        if u == "https://viewer-one.example/show/45/350279944_004.jpg":
            return httpx.Response(
                200,
                html='<html><body><img id="image" src="https://img86.viewer-one.example/images/45/350279944_004.jpg" /></body></html>',
            )
        if u == "https://img86.viewer-one.example/images/45/350279944_004.jpg":
            return httpx.Response(200, content=hd_png, headers={"Content-Type": "image/png", "Content-Length": str(len(hd_png))})

        if u == "https://viewer-three.example/m9lp6vlls9gs":
            return httpx.Response(
                200,
                html="""
                <html><body>
                  <form action="/search" method="POST"><input type="text" name="q" /><button type="submit">Go</button></form>
                  <a href="https://i8.viewer-three.example/i/full_img.png"><img src="https://i8.viewer-three.example/i/full_img.png" /></a>
                </body></html>
                """,
            )
        if u == "https://i8.viewer-three.example/i/full_img.png":
            return httpx.Response(200, content=hd_png, headers={"Content-Type": "image/png", "Content-Length": str(len(hd_png))})

        if u == "https://viewer-two.example/i/3sz6fp":
            return httpx.Response(
                200,
                html='<form method="POST"><input type="submit" name="imgContinue" value="Continue to image" /></form>',
            )
        if u == "https://i01.viewer-two.example/u/i/2025/01/3sz6fp.jpg":
            return httpx.Response(200, content=hd_png, headers={"Content-Type": "image/png", "Content-Length": str(len(hd_png))})

        if u == "https://cdn.example/tiny_80.png":
            return httpx.Response(200, content=small_png, headers={"Content-Type": "image/png", "Content-Length": str(len(small_png))})

        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    resolver = OriginalImageResolver(client_factory=lambda hdrs: httpx.AsyncClient(transport=transport, headers=hdrs))

    r1 = await resolver.resolve_original(
        PhotoResolveRequest(
            photo_id="p1",
            page_url="https://viewer-one.example/show/45/350279944_004.jpg",
            thumbnail_url="https://t86.viewer-one.example/thumbs/45/350279944_004.jpg",
        )
    )
    assert r1.is_resolved is True
    assert r1.original_url == "https://img86.viewer-one.example/images/45/350279944_004.jpg"
    assert r1.width == 800

    r2 = await resolver.resolve_original(
        PhotoResolveRequest(
            photo_id="p2",
            page_url="https://viewer-three.example/m9lp6vlls9gs",
            thumbnail_url="https://t8.viewer-three.example/th/m9lp6vlls9gs.jpg",
        )
    )
    assert r2.is_resolved is True
    assert r2.original_url == "https://i8.viewer-three.example/i/full_img.png"
    assert not any("viewer-three.example" in p for p in post_calls)

    r3 = await resolver.resolve_original(
        PhotoResolveRequest(
            photo_id="p3",
            page_url="https://viewer-two.example/i/3sz6fp",
            thumbnail_url="https://viewer-two.example/u/t/2025/01/3sz6fp.jpg",
        )
    )
    assert r3.is_resolved is True
    assert r3.original_url == "https://i01.viewer-two.example/u/i/2025/01/3sz6fp.jpg"
    assert any("viewer-two.example/i/3sz6fp" in p for p in post_calls)

    r4 = await resolver.resolve_original(
        PhotoResolveRequest(photo_id="p4", thumbnail_url="https://cdn.example/tiny_80.png")
    )
    assert r4.is_resolved is False


def test_surgical_scout_and_investigator_bug_fixes(tmp_path: Path, monkeypatch):
    from src.core.network_profiles import resolve_anti_hotlink_headers
    from src.investigator.investigator import OriginalImageInvestigator
    from src.scout.surgical_scout import GeminiSurgicalScout, get_true_image_url
    from src.server.original_image_resolver import is_image_viewer_url

    _setup_test_connectors(tmp_path, monkeypatch)

    html = """
    <div class="gallery-content">
      <a href="https://cdn.alpha.example/1280/1/2/real.jpg">
        <img src="https://static.alpha.example/style/img/1px.png" data-src="https://cdn.alpha.example/460/1/2/real.jpg" alt="Real Photo" />
      </a>
      <a href="https://beta.example/pics/set-1/">
        <img src="data:image/png;base64,AAAA" data-src="https://cdn.beta.example/460/3/4/hq.jpg" alt="HQ" />
      </a>
      <img src="https://static.alpha.example/style/img/1px.png" />
    </div>
    """
    links = GeminiSurgicalScout.find_media_links("https://alpha.example/galleries/test/", html)
    assert len(links) == 2
    assert links[0]["thumbnail_url"] == "https://cdn.alpha.example/460/1/2/real.jpg"
    assert links[1]["thumbnail_url"] == "https://cdn.beta.example/460/3/4/hq.jpg"

    tiny_1px = _make_png_bytes(1, 1, min_bytes=0)
    mock_res = MagicMock()
    mock_res.status_code = 200
    mock_res.headers = {"Content-Type": "image/png", "Content-Length": str(len(tiny_1px))}
    mock_res.url = "https://static.alpha.example/style/img/1px.png"
    mock_res.raw.read.return_value = tiny_1px
    mock_res.__enter__.return_value = mock_res
    mock_res.__exit__.return_value = False
    mock_session = MagicMock()
    mock_session.get.return_value = mock_res

    assert get_true_image_url("https://static.alpha.example/style/img/1px.png", mock_session, "https://alpha.example/") is None

    inv = OriginalImageInvestigator(tools=MagicMock(), validator=MagicMock())
    viewer_cands = inv._generate_cdn_candidates("https://viewer-two.example/u/t/2025/01/01/3sz6fp.jpg")
    assert not any("/u/i/" in c for c in viewer_cands)
    pix_cands = inv._generate_cdn_candidates("https://t86.viewer-one.example/thumbs/45/350279944_004.jpg")
    assert "https://img86.viewer-one.example/images/45/350279944_004.jpg" in pix_cands

    hdrs = resolve_anti_hotlink_headers("https://img86.viewer-one.example/images/45/350.jpg", referer="https://viewer-one.example/show/45/350.jpg")
    assert hdrs["Referer"] == "https://viewer-one.example/show/45/350.jpg"

    assert is_image_viewer_url("https://i01.viewer-two.example/i/2025/01/file.jpg") is False
    assert is_image_viewer_url("https://viewer-two.example/i/3sz6fp") is True


@pytest.mark.asyncio
async def test_extract_viewer_candidates_non_extension_url(tmp_path, monkeypatch):
    """Verify non-extension viewer extraction works cleanly without NameError."""
    _setup_test_connectors(tmp_path, monkeypatch)
    from src.server.original_image_resolver import OriginalImageResolver

    resolver = OriginalImageResolver()
    sample_png = _make_png_bytes(800, 600, min_bytes=5120)

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if u == "https://unknown-viewer.example/view?id=99":
            return httpx.Response(
                200,
                html='<html><body><img id="image" src="https://cdn.unknown-viewer.example/full/99.png" /></body></html>',
            )
        if u == "https://cdn.unknown-viewer.example/full/99.png":
            return httpx.Response(200, content=sample_png, headers={"Content-Type": "image/png"})
        return httpx.Response(404)

    resolver = OriginalImageResolver(client_factory=lambda hdrs: httpx.AsyncClient(transport=httpx.MockTransport(handler), headers=hdrs))
    cands = await resolver._extract_viewer_candidates("https://unknown-viewer.example/view?id=99", "https://board.example/threads/1")
    assert "https://cdn.unknown-viewer.example/full/99.png" in cands
