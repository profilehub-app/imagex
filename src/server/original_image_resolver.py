"""Unified Async Original Image Resolver & Shared Media Rule Classifiers.

Consolidates and repairs extraction rules across the Timeline Lightbox resolver
(`profile_hub_resolution.py`) and offline scout/investigator robots (`surgical_scout.py`,
`investigator.py`):
- Shared placeholder/tracker URL filtering (catching 1px.png, data:image/*, avatars)
- Generic & configured HTML viewer-page vs direct-CDN classification
- Deterministic CDN upgrades configured per image host and catalog descriptor
- Targeted interstitial gateway POST solver that ignores unrelated forms
- Dual-tier physical binary dimension & MIME verification with per-host concurrency semaphores
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from contextlib import asynccontextmanager
import io
import os
import re
import struct
import time
from typing import Any, Callable, Optional
from urllib.parse import urljoin, urlsplit
import weakref

import httpx
from PIL import Image
from pydantic import BaseModel
from selectolax.lexbor import LexborHTMLParser

from ..core.network_profiles import resolve_anti_hotlink_headers
from .proxy_image_guard import is_valid_image_response, sniff_image_mime

# Dual-tier image geometry guards
MIN_MEDIA_CANDIDATE_BYTES = 512
MIN_MEDIA_CANDIDATE_DIM = 50
MIN_RESOLVED_PHOTO_DIM = 120
MIN_RESOLVED_PHOTO_BYTES = 3000
MIN_RESOLVED_GIF_DIM = 64
MIN_RESOLVED_GIF_BYTES = 2048

DEFAULT_RESOLVER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7",
}

RE_PLACEHOLDER_ASSET = re.compile(
    r"(?:^data:image/|1px\.|1x1|spacer|transparent\.(?:gif|png)|site_loading|loading\.(?:gif|png|webp)"
    r"|/avatars?/|avatar[_-]|favicon|blank\.(?:gif|png|jpg)|\.svg(?:\?|$)"
    r"|(?:^|[/_-])(?:logo|icon|banner|advert|sprite|flag|flags|badge|catimg|rating|pixel|arrow|spinner|widget|track)(?:[._/-]|$)"
    r"|ENG\.PNG)",
    re.IGNORECASE,
)

_IMAGE_EXT_RE = re.compile(r"\.(?:jpe?g|png|webp|avif|gif|bmp)(?:\?.*)?$", re.IGNORECASE)



class PhotoResolveRequest(BaseModel):
    photo_id: Optional[str] = None
    page_url: Optional[str] = None
    thumbnail_url: str
    source_page: Optional[str] = None


class PhotoResolveResult(BaseModel):
    success: bool
    photo_id: Optional[str] = None
    original_url: str
    width: int = 0
    height: int = 0
    file_size: int = 0
    format: str = "jpg"
    is_resolved: bool = False
    requires_proxy: bool = False
    elapsed_seconds: float = 0.0


def _hostname(url_or_host: str) -> str:
    val = (url_or_host or "").strip()
    if not val:
        return ""
    if "://" in val or val.startswith("//"):
        if val.startswith("//"):
            val = "https:" + val
        host = (urlsplit(val).hostname or "").lower()
    else:
        host = val.split("/")[0].split(":")[0].lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def is_catalog_host(url_or_host: str) -> bool:
    from .connector_registry import CatalogDescriptor, find_connector_for_url
    return isinstance(find_connector_for_url(url_or_host), CatalogDescriptor)


def is_forum_host(url_or_host: str) -> bool:
    from .connector_registry import ForumDescriptor, find_connector_for_url
    return isinstance(find_connector_for_url(url_or_host), ForumDescriptor)


def _matching_image_host_rule(url_or_host: str):
    from .connector_registry import list_image_host_rules
    host = _hostname(url_or_host)
    if not host:
        return None
    for rule in list_image_host_rules():
        if rule.matches_host(host):
            return rule
    return None


def is_placeholder_media_url(url: Optional[str]) -> bool:
    """True when URL points to a tracking pixel, inline base64 placeholder, UI chrome, or avatar."""
    raw = (url or "").strip()
    if not raw:
        return True
    lowered = raw.lower()
    if lowered.startswith(("javascript:", "mailto:", "#", "about:", "blob:")):
        return True
    if lowered.startswith("data:image/") or lowered.startswith("data:"):
        return True
    return bool(RE_PLACEHOLDER_ASSET.search(raw))


def is_image_viewer_url(url: Optional[str]) -> bool:
    """Classify HTML image-host viewer pages (including viewer URLs ending in image extensions)."""
    raw = (url or "").strip()
    if not raw:
        return False
    if "://" not in raw and not raw.startswith("//"):
        return False
    parsed = urlsplit("https:" + raw if raw.startswith("//") else raw)
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path or "/"
    path_lower = path.lower()

    rule = _matching_image_host_rule(host)
    if rule is not None:
        if rule.direct_host_regex and re.search(rule.direct_host_regex, host, re.IGNORECASE):
            # Subdomains matched as direct CDN (e.g. imgN.* / iN.*) must not classify as viewers
            if _IMAGE_EXT_RE.search(path_lower) or any(m in path_lower for m in rule.direct_path_markers) or any(path_lower.startswith(p.lower()) for p in rule.direct_path_prefixes):
                return False
        if any(m in path_lower for m in rule.direct_path_markers):
            return False
        if any(path_lower.startswith(p.lower()) for p in rule.viewer_path_prefixes):
            return True
        if rule.viewer_path_regex and re.search(rule.viewer_path_regex, path_lower, re.IGNORECASE):
            return True

    # Generic HTML viewer subpage extensions or explicit /show/ /view/ paths
    if path_lower.startswith(("/show/", "/view/")) and not any(seg in path_lower for seg in ("/images/", "/thumbs/", "/original/")):
        return True
    if path_lower.endswith((".html", ".htm", ".php")):
        return True
    return False


def generate_deterministic_original_candidates(url: str) -> list[str]:
    """Generate safe, ordered deterministic full-res URL hypotheses without blind broken mutations."""
    from .connector_registry import CatalogDescriptor, find_connector_for_url, list_image_host_rules

    src = (url or "").strip()
    if not src or is_placeholder_media_url(src):
        return []
    candidates: list[str] = []

    def _add(cand: str) -> None:
        c = (cand or "").strip()
        if c and c != src and c not in candidates and not is_placeholder_media_url(c):
            candidates.append(c)

    parsed = urlsplit("https:" + src if src.startswith("//") else src)
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]

    # 1. Configured image host transforms
    matched_rule = _matching_image_host_rule(host)
    for rule in list_image_host_rules():
        if rule.thumb_to_full_replace and rule.matches_host(host):
            pat, repl = rule.thumb_to_full_replace
            try:
                _add(re.sub(pat, repl, src, flags=re.IGNORECASE))
            except re.error:
                pass

    # 2. Configured visual catalog resolution path upgrades (e.g. /460/ -> /1280/)
    conn = find_connector_for_url(host)
    if isinstance(conn, CatalogDescriptor):
        upgrade = conn.browse.get("thumbUpgrade")
        if isinstance(upgrade, (list, tuple)) and len(upgrade) == 2:
            _add(src.replace(str(upgrade[0]), str(upgrade[1]), 1))
        _add(re.sub(r"/(?:460|300)/", "/1280/", src, count=1))

    # 3. Generic CDN resolution suffix strip (_880x660.jpg -> .jpg)
    _add(re.sub(r"_\d+x\d+\.(jpe?g|png|webp|gif)(\?.*)?$", r".\1\2", src, flags=re.IGNORECASE))

    # 4. Generic thumb filename suffixes (-thumb, _thumb, _small, _preview)
    _add(re.sub(r"[-_](?:thumb|small|preview|thumb_b)\.(jpe?g|png|webp|gif)(\?.*)?$", r".\1\2", src, flags=re.IGNORECASE))
    _add(re.sub(r"/thumb_([^/]+)$", r"/\1", src, flags=re.IGNORECASE))

    # 5. Generic path-segment upgrades ONLY on hosts without sharded gateway rules
    if matched_rule is None:
        for seg in ("/original/", "/1280/", "/1920/", "/full/", "/large/"):
            _add(re.sub(r"/(?:460|thumbs?|thumbnails?|small|medium|preview)/", seg, src, flags=re.IGNORECASE))

    return candidates


def extract_targeted_gateway_form(html: str, base_url: str) -> Optional[tuple[str, dict[str, str]]]:
    """Identify ONLY explicit interstitial/image-continue gateway forms.

    Deliberately ignores search, login, or navigation <form> tags.
    """
    if not html:
        return None
    tree = LexborHTMLParser(html)
    gateway_btn_re = re.compile(r"\b(?:continue|show\s+(?:the\s+)?image|proceed\s+to\s+image|view\s+image)\b", re.IGNORECASE)

    for form in tree.css("form"):
        action = (form.attributes.get("action") or "").strip()
        if any(tok in action.lower() for tok in ("search", "login", "register", "logout")):
            continue

        inputs = form.css("input, button")
        has_search_field = any(
            (node.attributes.get("type") or "").lower() == "search"
            or (node.attributes.get("name") or "").lower() in ("q", "query", "search", "s", "username", "password")
            for node in inputs
        )
        if has_search_field:
            continue

        is_gateway = False
        payload: dict[str, str] = {}
        submit_candidate: tuple[str, str] | None = None

        for node in inputs:
            name = (node.attributes.get("name") or "").strip()
            val = node.attributes.get("value") or ""
            nid = (node.attributes.get("id") or "").lower()
            ntype = (node.attributes.get("type") or "").lower()
            text = (node.text(strip=True) or "").strip()

            if name == "imgContinue" or nid in ("continuebutton", "continue"):
                is_gateway = True
            if ntype == "submit" and (gateway_btn_re.search(val) or gateway_btn_re.search(text) or name == "imgContinue"):
                is_gateway = True
            if ntype in ("submit", "button") or node.tag == "button":
                if name and submit_candidate is None:
                    submit_candidate = (name, val or text or "Continue")
                continue
            if name and ntype != "checkbox":
                payload[name] = val

        if is_gateway:
            if "imgContinue" not in payload and submit_candidate:
                payload[submit_candidate[0]] = submit_candidate[1]
            elif "imgContinue" not in payload:
                payload["imgContinue"] = "Continue to image"
            action_url = urljoin(base_url, action) if action else base_url
            return action_url, payload

    return None


def parse_binary_dimensions(data: bytes) -> tuple[int, int, str]:
    """Fast binary header parsing for PNG, GIF, WEBP, JPEG without full decode overhead."""
    if len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
        w, h = struct.unpack(">II", data[16:24])
        return w, h, "png"
    if len(data) >= 10 and (data.startswith(b"GIF87a") or data.startswith(b"GIF89a")):
        w, h = struct.unpack("<HH", data[6:10])
        return w, h, "gif"
    if len(data) >= 30 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        if data[12:16] == b"VP8 ":
            w = struct.unpack("<H", data[26:28])[0] & 0x3FFF
            h = struct.unpack("<H", data[28:30])[0] & 0x3FFF
            return w, h, "webp"
        if data[12:16] == b"VP8L" and len(data) >= 25:
            b0, b1, b2, b3 = data[21:25]
            w = 1 + (((b1 & 0x3F) << 8) | b0)
            h = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
            return w, h, "webp"
    try:
        im = Image.open(io.BytesIO(data))
        return im.size[0], im.size[1], (im.format or "jpg").lower()
    except Exception:
        pass
    return 0, 0, "jpg"


def _is_animated_gif_or_webp(data: bytes, fmt: str) -> bool:
    if fmt == "gif" and (data.startswith(b"GIF87a") or data.startswith(b"GIF89a")):
        if data.count(b"\x21\xf9\x04") > 1:
            return True
        try:
            im = Image.open(io.BytesIO(data))
            return bool(getattr(im, "is_animated", False) and getattr(im, "n_frames", 1) > 1)
        except Exception:
            return False
    if fmt == "webp" and b"ANIM" in data[:128]:
        return True
    return False


def _meets_resolved_floor(width: int, height: int, file_size: int, fmt: str, data: bytes) -> bool:
    is_anim = _is_animated_gif_or_webp(data, fmt)
    min_dim = MIN_RESOLVED_GIF_DIM if is_anim else MIN_RESOLVED_PHOTO_DIM
    min_bytes = MIN_RESOLVED_GIF_BYTES if is_anim else MIN_RESOLVED_PHOTO_BYTES
    if width > 0 and width < min_dim:
        return False
    if height > 0 and height < min_dim:
        return False
    if file_size > 0 and file_size < min_bytes:
        return False
    if width == 0 and height == 0 and file_size == 0:
        return False
    return True


def _requires_proxy_hint(url: str) -> bool:
    return bool(_matching_image_host_rule(url) is not None or is_catalog_host(url) or is_forum_host(url))


class OriginalImageResolver:
    """Thread/loop-safe async original image resolver with per-host rate limiting and TTL LRU cache."""

    _HOST_CONCURRENCY: dict[str, int] = {}

    def __init__(
        self,
        *,
        cache_max_size: int = 5000,
        cache_ttl_seconds: float = 3600.0,
        client_factory: Optional[Callable[[dict[str, str]], httpx.AsyncClient]] = None,
    ) -> None:
        self._cache_max_size = cache_max_size
        self._cache_ttl = cache_ttl_seconds
        self._cache: OrderedDict[str, tuple[float, PhotoResolveResult]] = OrderedDict()
        self._client_factory = client_factory
        self._loop_semaphores: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, asyncio.Semaphore]] = (
            weakref.WeakKeyDictionary()
        )

    @staticmethod
    def _cache_key(page_url: Optional[str], thumb_url: str) -> str:
        return f"{(page_url or '').strip()}::{(thumb_url or '').strip()}"

    def _get_host_semaphore(self, host: str) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        host_map = self._loop_semaphores.setdefault(loop, {})
        norm_host = _hostname(host) or "default"
        for base, limit in self._HOST_CONCURRENCY.items():
            if norm_host == base or norm_host.endswith("." + base):
                bucket = base
                cap = limit
                break
        else:
            bucket = norm_host
            cap = 4
        if bucket not in host_map:
            host_map[bucket] = asyncio.Semaphore(cap)
        return host_map[bucket]

    @asynccontextmanager
    async def _make_client(self, headers: dict[str, str]):
        if self._client_factory is not None:
            async with self._client_factory(headers) as client:
                yield client
        else:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True, headers=headers) as client:
                yield client

    def _get_cached(self, key: str, photo_id: Optional[str]) -> Optional[PhotoResolveResult]:
        entry = self._cache.get(key)
        if not entry:
            return None
        ts, result = entry
        if time.monotonic() - ts > self._cache_ttl:
            self._cache.pop(key, None)
            return None
        self._cache.move_to_end(key)
        return result.model_copy(update={"photo_id": photo_id or result.photo_id})

    def _put_cached(self, key: str, result: PhotoResolveResult) -> None:
        self._cache[key] = (time.monotonic(), result)
        self._cache.move_to_end(key)
        while len(self._cache) > self._cache_max_size:
            self._cache.popitem(last=False)

    async def _extract_viewer_candidates(self, page_url: str, referer: str) -> list[str]:
        candidates: list[str] = []
        if not page_url or not page_url.startswith("http"):
            return candidates

        # Fast-path: page_url is already a verified direct CDN image (not a viewer page)
        parsed_page = urlsplit(page_url)
        page_rule = _matching_image_host_rule(page_url)
        is_configured_direct = bool(
            page_rule
            and any((parsed_page.path or "/").lower().startswith(p.lower()) for p in page_rule.direct_path_prefixes)
        )
        if (not is_image_viewer_url(page_url)) and (
            _IMAGE_EXT_RE.search(page_url) or is_configured_direct
        ):
            candidates.append(page_url)
            return candidates

        headers = dict(DEFAULT_RESOLVER_HEADERS)
        if referer:
            headers["Referer"] = referer
        sem = self._get_host_semaphore(page_url)

        try:
            async with sem:
                async with self._make_client(headers) as client:
                    resp = await client.get(page_url)
                    if resp.status_code == 200 and "leastFactor" in resp.text:
                        apex_host = (urlsplit(page_url).hostname or "").lower().removeprefix("www.")
                        cookie_domains = (f".{apex_host}", apex_host, f"www.{apex_host}") if apex_host else ()
                        for _ in range(3):
                            if "leastFactor" not in resp.text:
                                break
                            from .profile_directory_transport import solve_js_challenge

                            solved = await asyncio.to_thread(solve_js_challenge, resp.text)
                            if solved:
                                for k, v in solved.items():
                                    for domain in cookie_domains:
                                        try:
                                            client.cookies.set(k.strip(), v.strip(), domain=domain)
                                        except Exception:
                                            pass
                            else:
                                m_ck = re.search(r"document\.cookie\s*=\s*[\"']([^\"']+)[\"']", resp.text)
                                if m_ck and "=" in m_ck.group(1):
                                    k, v = m_ck.group(1).split(";", 1)[0].split("=", 1)
                                    for domain in cookie_domains:
                                        try:
                                            client.cookies.set(k.strip(), v.strip(), domain=domain)
                                        except Exception:
                                            pass
                            await asyncio.sleep(0.2)
                            resp = await client.get(page_url)

                    if resp.status_code != 200:
                        return candidates

                    ct = resp.headers.get("content-type", "").lower()
                    if ct.startswith("image/"):
                        candidates.append(str(resp.url))
                        return candidates

                    html = resp.text
                    tree = LexborHTMLParser(html)

                    # Stage 2A: Targeted gateway POST bypass (only explicit interstitial forms)
                    form_spec = extract_targeted_gateway_form(html, str(resp.url))
                    if form_spec:
                        action_url, payload = form_spec
                        parsed_v = urlsplit(str(resp.url))
                        post_headers = dict(headers)
                        post_headers["Referer"] = str(resp.url)
                        post_headers["Origin"] = f"{parsed_v.scheme}://{parsed_v.netloc}"
                        post_resp = await client.post(action_url, data=payload, headers=post_headers)
                        if post_resp.status_code == 200:
                            post_tree = LexborHTMLParser(post_resp.text)
                            for sel in (
                                "img.centred",
                                "img.centred_element",
                                "img#show_image",
                                "img#image",
                                "img.img-responsive",
                                'img[src*="/i/"]',
                            ):
                                for node in post_tree.css(sel):
                                    s = (
                                        node.attributes.get("src")
                                        or node.attributes.get("data-src")
                                        or node.attributes.get("data-original")
                                    )
                                    if s and not is_placeholder_media_url(s):
                                        candidates.append(urljoin(str(post_resp.url), s.strip()))

                    # Stage 2B: Generic photo wrapper container
                    wrapper_cands = []
                    for img in tree.css("#photoWrapper img, div.photoWrapper img, #photoImageSection img, .centerImage img"):
                        src = img.attributes.get("src") or img.attributes.get("data-src") or ""
                        if src and not is_placeholder_media_url(src) and "users/" not in src:
                            if "original_" in src and ("rs:fit:" in src or "plain/" in src):
                                wrapper_cands.append(urljoin(page_url, src))
                    if wrapper_cands:
                        wrapper_cands.sort(key=lambda u: 0 if ("rs:fit:200:250" in u or "rs:fit:150:188" in u) else 1, reverse=True)
                        candidates.extend(wrapper_cands)

                    # Stage 2C: Generic gallery main-photo container
                    for a in tree.css('a[href*="/gallery/"]'):
                        href = a.attributes.get("href") or ""
                        if _IMAGE_EXT_RE.search(href):
                            candidates.append(urljoin(page_url, href))
                    for sel in ("img.mainphoto", "#mainphoto", "img#mainphoto", ".mainphoto"):
                        mp = tree.css_first(sel)
                        if mp:
                            src = mp.attributes.get("src") or mp.attributes.get("data-src") or ""
                            if src and not is_placeholder_media_url(src):
                                orig = re.sub(r"_\d+x\d+\.(jpe?g|png|webp|gif)(\?.*)?$", r".\1\2", src, flags=re.I)
                                candidates.append(urljoin(page_url, orig))

                    # Stage 2D: Generic image-viewer container extractors (links to direct image CDN shards + primary full-res image)
                    for sel in ('a[href*="/i/"]', 'img[src*="/i/"]', 'a[href*="/images/"]'):
                        node = tree.css_first(sel)
                        if node:
                            s = node.attributes.get("href") or node.attributes.get("src") or node.attributes.get("data-src")
                            if s and not is_placeholder_media_url(s) and _IMAGE_EXT_RE.search(urlsplit(s).path):
                                candidates.append(urljoin(str(resp.url), s.strip()))

                    # Stage 2E: Generic high-res DOM selectors
                    for sel in (
                        "a[href*='download'][href*='.']",
                        "img#show_image",
                        "img.main-image",
                        "img.mainphoto",
                        "img#mainphoto",
                        ".mainphoto",
                        "img.centred",
                        "img.centred_element",
                        "img#photo_img",
                        "div.photo-box img",
                        "div#image-container img",
                        "div.image-container img",
                        "img#image",
                        "div#photo img",
                        "div.photo img",
                        "#photo img",
                        "#thepic",
                    ):
                        node = tree.css_first(sel)
                        if node:
                            s = node.attributes.get("src") or node.attributes.get("data-src") or node.attributes.get("data-original") or node.attributes.get("href")
                            if s and not is_placeholder_media_url(s):
                                candidates.append(urljoin(str(resp.url), s.strip()))

                    # Stage 2F: OpenGraph / Twitter image fallback
                    for meta_sel in ('meta[property="og:image"]', 'meta[name="twitter:image"]'):
                        og = tree.css_first(meta_sel)
                        if og:
                            s = og.attributes.get("content") or ""
                            if s and not is_placeholder_media_url(s):
                                candidates.append(urljoin(str(resp.url), s.strip()))
        except Exception:
            pass

        return list(dict.fromkeys(c for c in candidates if not is_placeholder_media_url(c)))

    async def _probe_binary_candidate(
        self, candidate_url: str, *, referer: str, source_page: str
    ) -> Optional[tuple[str, int, int, int, str]]:
        if not candidate_url or not candidate_url.startswith("http") or is_image_viewer_url(candidate_url):
            return None
        probe_headers = resolve_anti_hotlink_headers(candidate_url, referer=referer or None, source_page=source_page or None)
        sem = self._get_host_semaphore(candidate_url)

        try:
            async with sem:
                async with self._make_client(probe_headers) as client:
                    file_size = 0
                    width = 0
                    height = 0
                    fmt = "jpg"
                    final_url = candidate_url
                    chunk = b""

                    try:
                        head = await client.head(candidate_url)
                        if head.status_code == 200:
                            cl = head.headers.get("content-length")
                            if cl and cl.isdigit():
                                file_size = int(cl)
                            final_url = str(head.url)
                    except Exception:
                        pass

                    range_headers = dict(probe_headers)
                    range_headers["Range"] = "bytes=0-65535"
                    range_res = await client.get(candidate_url, headers=range_headers)
                    if range_res.status_code not in (200, 206):
                        return None
                    chunk = range_res.content or b""
                    if len(chunk) < MIN_MEDIA_CANDIDATE_BYTES and file_size < MIN_MEDIA_CANDIDATE_BYTES:
                        return None
                    final_url = str(range_res.url)
                    ok, detected_mime = is_valid_image_response(
                        200, range_res.headers.get("content-type", ""), chunk
                    )
                    if not ok:
                        return None
                    if detected_mime and "/" in detected_mime:
                        fmt = detected_mime.split("/", 1)[1].split("+", 1)[0]
                    w, h, parsed_fmt = parse_binary_dimensions(chunk)
                    if w and h:
                        width, height = w, h
                        fmt = parsed_fmt or fmt
                    if not file_size:
                        file_size = len(chunk)

                    if not _meets_resolved_floor(width, height, file_size, fmt, chunk):
                        return None
                    return final_url, width, height, file_size, fmt
        except Exception:
            return None

    async def resolve_original(self, req: PhotoResolveRequest) -> PhotoResolveResult:
        """Resolve true high-resolution original image with geometry/MIME validation and caching."""
        key = self._cache_key(req.page_url, req.thumbnail_url)
        cached = self._get_cached(key, req.photo_id)
        if cached is not None:
            return cached

        t0 = time.time()
        page_url = (req.page_url or "").strip()
        thumb_url = (req.thumbnail_url or "").strip()
        source_page = (req.source_page or "").strip()
        referer = page_url or source_page

        candidates: list[str] = []
        if page_url and page_url.startswith("http"):
            candidates.extend(await self._extract_viewer_candidates(page_url, referer))
        if thumb_url and thumb_url.startswith("http"):
            candidates.extend(generate_deterministic_original_candidates(thumb_url))

        deduped = [c for c in dict.fromkeys(candidates) if not is_placeholder_media_url(c)]

        resolved_url = thumb_url
        is_resolved = False
        width = 0
        height = 0
        file_size = 0
        fmt = "jpg"

        for cand in deduped:
            probed = await self._probe_binary_candidate(cand, referer=referer, source_page=source_page)
            if probed is not None:
                resolved_url, width, height, file_size, fmt = probed
                is_resolved = True
                break

        result = PhotoResolveResult(
            success=True,
            photo_id=req.photo_id,
            original_url=resolved_url,
            width=width,
            height=height,
            file_size=file_size,
            format=fmt,
            is_resolved=is_resolved,
            requires_proxy=_requires_proxy_hint(resolved_url),
            elapsed_seconds=round(time.time() - t0, 3),
        )
        self._put_cached(key, result)
        return result


_DEFAULT_RESOLVER: Optional[OriginalImageResolver] = None


def get_default_resolver() -> OriginalImageResolver:
    global _DEFAULT_RESOLVER
    if _DEFAULT_RESOLVER is None:
        _DEFAULT_RESOLVER = OriginalImageResolver()
    return _DEFAULT_RESOLVER
