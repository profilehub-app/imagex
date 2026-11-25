"""Generic visual gallery catalog engine driven by declarative CatalogDescriptor rules.

Handles:
- Descriptive title extraction (never treating pixel dimension keys like ``h`` as titles)
- Both JSON-feed and category-first HTML catalog roots
- Scoped artist/channel/tag metadata extraction and TTL-cached batch enrichment
- Standardized directory browsing (categories, artists, channels, tags)
- Paginated in-app visual entity profile resolution with related entities
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
import hashlib
import re
import time
from typing import Any, Literal
from urllib.parse import quote_plus, urlencode, urljoin, urlsplit, urlunsplit
import weakref

import httpx
from selectolax.lexbor import LexborHTMLParser

from ..core.network_profiles import resolve_anti_hotlink_headers
from .connector_registry import CatalogDescriptor, find_connector_for_url
from .original_image_resolver import is_placeholder_media_url
from .timeline_directory import directory_next_url, directory_path, directory_thumbnail, search_directory_profiles, valid_directory_url

_ENRICH_CACHE: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_ENRICH_CACHE_TTL_S = 1800.0
_ENRICH_CACHE_MAX = 512
_GALLERY_DETAIL_CACHE: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_GALLERY_DETAIL_CACHE_TTL_S = 600.0
_GALLERY_DETAIL_CACHE_MAX = 128
_ENRICH_SEMAPHORES: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()

_IMAGE_URL_RE = re.compile(r"\.(?:jpe?g|png|webp|avif|gif)(?:\?|$)", re.IGNORECASE)
_LOCALE_PATH_RE = re.compile(
    r"^/(?:es|de|fr|it|pt|ru|ja|jp|nl|pl|sv|zh|ko|tr|cs|hu|ro|el|da|fi|no|ar|he|th|vi)/",
    re.IGNORECASE,
)
_UTILITY_SLUG_SET = frozenset({
    "cookie", "cookies", "cookie-policy", "dmca", "terms", "tos", "terms-of-service",
    "privacy", "privacy-policy", "contact", "contact-us", "2257", "login", "logout",
    "register", "signup", "sign-up", "forgot-password", "password", "reset-password",
    "verify-email", "email-verification", "content-removal", "removal", "guidelines",
    "faq", "about", "about-us", "help", "support", "advertise", "advertising",
    "webmasters", "sitemap", "feedback", "legal", "disclaimer", "report", "abuse",
    "rss", "feed", "parents", "parental-controls", "rta", "billing", "account",
    "settings", "favorites", "likes", "bookmarks", "history", "comments", "popular",
    "recent", "rating", "views", "trending", "latest", "top", "new",
    "videos", "app", "live", "cams", "dating", "games", "ai", "chat", "sex-chat", "list",
})
_LEGAL_LABEL_RE = re.compile(
    r"\b(?:cookie\s+policy|privacy\s+policy|terms\s+of|terms\b|dmca|2257|verify\s+email|"
    r"forgot\s+password|content\s+removal|contact\s+us|contact\b|sign\s*in|log\s*in|"
    r"sign\s*up|register|webmasters|parental|record-keeping|compliance\s+statement)\b",
    re.IGNORECASE,
)
_STATIC_DOC_EXT_RE = re.compile(r"\.(?:shtml|html?|php|asp|aspx|xml|txt|pdf|svg)$", re.IGNORECASE)


def _is_inside_chrome_container(node: Any) -> bool:
    curr = getattr(node, "parent", None)
    depth = 0
    while curr is not None and depth < 12:
        tag = (getattr(curr, "tag", "") or "").lower()
        if tag in ("footer", "header"):
            return True
        attrs = getattr(curr, "attributes", None) or {}
        cls_id = f"{attrs.get('class', '')} {attrs.get('id', '')}".lower()
        if any(tok in cls_id for tok in ("footer", "cookie", "legal", "lang-switch", "language", "modal-login", "auth-modal")):
            return True
        curr = getattr(curr, "parent", None)
        depth += 1
    return False


def _is_utility_or_legal_link(path_low: str, label: str) -> bool:
    if not path_low or path_low == "/":
        return True
    if _LOCALE_PATH_RE.match(path_low):
        return True
    if _STATIC_DOC_EXT_RE.search(path_low):
        return True
    segs = [s for s in path_low.strip("/").split("/") if s]
    if not segs:
        return True
    if any(seg in _UTILITY_SLUG_SET for seg in segs):
        return True
    if label and _LEGAL_LABEL_RE.search(label):
        return True
    return False


def clear_enrichment_cache() -> None:
    _ENRICH_CACHE.clear()
    _GALLERY_DETAIL_CACHE.clear()


def _get_enrich_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _ENRICH_SEMAPHORES.get(loop)
    if sem is None:
        sem = asyncio.Semaphore(4)
        _ENRICH_SEMAPHORES[loop] = sem
    return sem


def _abs_http_url(base: str, raw: str | None) -> str:
    val = (raw or "").strip()
    if not val or val.startswith(("#", "javascript:", "mailto:", "data:")):
        return ""
    if val.startswith("//"):
        return "https:" + val
    joined = urljoin(base, val)
    return joined if urlsplit(joined).scheme in ("http", "https") else ""


def _pick_img_thumb(base: str, attrs: dict[str, Any]) -> str:
    for attr in ("data-src", "data-original", "data-lazy-src", "data-lazy", "src"):
        candidate = (attrs.get(attr) or "").strip()
        if not candidate or is_placeholder_media_url(candidate):
            continue
        url = _abs_http_url(base, candidate)
        if url:
            return url
    return ""


def _upgrade_thumb(thumb: str, upgrade_pair: Any) -> str:
    if not thumb:
        return ""
    if isinstance(upgrade_pair, (list, tuple)) and len(upgrade_pair) == 2:
        src_seg, dst_seg = str(upgrade_pair[0]), str(upgrade_pair[1])
        if src_seg and src_seg in thumb:
            return thumb.replace(src_seg, dst_seg, 1)
        if dst_seg == "/1280/" and "/300/" in thumb:
            return thumb.replace("/300/", "/1280/", 1)
    return thumb


def humanize_slug_title(url: str, fallback: str = "") -> str:
    path = urlsplit(url or "").path.strip("/")
    if not path:
        return fallback
    parts = [p for p in path.split("/") if p]
    if not parts:
        return fallback
    slug = parts[-1]
    if slug.isdigit() and len(parts) >= 2:
        slug = parts[-2]
    slug = re.sub(r"\.[a-z0-9]{2,5}$", "", slug, flags=re.IGNORECASE)
    slug = re.sub(r"[-_]\d{4,}$", "", slug)
    slug = re.sub(r"[-_]+", " ", slug).strip()
    if not slug or slug.isdigit():
        return fallback
    words = []
    for w in slug.split():
        words.append(w.upper() if len(w) <= 4 and w.isupper() else w.capitalize())
    return " ".join(words) or fallback


def _clean_catalog_title(raw_title: Any, item_url: str, fallback: str) -> str:
    text = str(raw_title or "").strip() if raw_title is not None else ""
    if not text or text.isdigit():
        return humanize_slug_title(item_url, fallback=fallback)
    return text


def detect_catalog_entity_kind(url: str, descriptor: CatalogDescriptor) -> str:
    path = urlsplit(url or "").path.lower()
    artist_prefixes = tuple(descriptor.selectors.get("artistPrefixes") or ("/pornstars/", "/models/", "/artists/"))
    channel_prefixes = tuple(descriptor.selectors.get("channelPrefixes") or ("/channels/", "/creators/"))
    tag_seg = str(descriptor.browse.get("tagPathSegment") or "/tags/").lower()
    if any(pref in path for pref in artist_prefixes):
        return "artist"
    if any(pref in path for pref in channel_prefixes):
        return "channel"
    if tag_seg and tag_seg in path:
        return "tag"
    return "category"


def parse_catalog_api_rows(
    rows: list[Any],
    descriptor: CatalogDescriptor,
    *,
    item_type: Literal["album", "gif", "photo_grid"] = "album",
    extra_tags: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    from .timeline_search_providers import make_item_entry

    base_url = descriptor.effective_base_url()
    upgrade = descriptor.browse.get("thumbUpgrade")
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        raw_g = str(row.get("g_url") or row.get("url") or row.get("albumUrl") or "").strip()
        g_url = _abs_http_url(base_url, raw_g)
        thumb = _abs_http_url(base_url, str(row.get("t_url") or row.get("t_url_460") or row.get("thumb") or ""))
        if not g_url or g_url in seen or is_placeholder_media_url(thumb):
            continue
        seen.add(g_url)

        # Reject numeric pixel dimensions (e.g. `h`: 447) — only accept genuine text titles.
        raw_desc = row.get("desc") or row.get("title") or row.get("name") or ""
        title = _clean_catalog_title(raw_desc, g_url, descriptor.display_name)
        hd_thumb = _upgrade_thumb(thumb, upgrade)
        gid = str(row.get("gid") or row.get("id") or hashlib.sha1(g_url.encode()).hexdigest()[:12])

        author_name = str(row.get("author") or row.get("model") or descriptor.display_name).strip()
        author_url = _abs_http_url(base_url, str(row.get("author_url") or row.get("model_url") or ""))
        entry = make_item_entry(
            source_id=descriptor.id,
            item_id=f"{descriptor.id}_{gid}",
            item_type="gif" if item_type == "gif" else "album",
            title=title,
            original_url=g_url,
            thumbnail=thumb,
            creator_name=author_name,
            creator_handle=author_name.lower().replace(" ", "") if author_url else descriptor.id,
            source_page=author_url or "",
            album_url=g_url,
            neutral_label=descriptor.display_name,
        )
        entry["previewHdUrl"] = hd_thumb
        entry["mediaType"] = "gif" if item_type == "gif" else ("photo" if item_type == "photo_grid" else "album")
        entry["needsEnrichment"] = not bool(author_url)
        if extra_tags:
            entry["tags"] = list(extra_tags)
        if isinstance(row.get("artists"), list):
            entry["artists"] = row["artists"]
        if isinstance(row.get("channels"), list):
            entry["channels"] = row["channels"]
        items.append(entry)
    return items


def parse_catalog_html_items(
    html: str,
    descriptor: CatalogDescriptor,
    *,
    base_url: str | None = None,
    current_page: int = 1,
    item_type: Literal["album", "gif", "photo_grid"] = "album",
    media_type_override: str | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    from .timeline_search_providers import make_item_entry

    root_url = (base_url or descriptor.effective_base_url()).rstrip("/")
    tree = LexborHTMLParser(html or "")
    upgrade = descriptor.browse.get("thumbUpgrade")
    album_seg = str(descriptor.browse.get("albumPathSegment") or "").lower()
    tile_sel = str(descriptor.selectors.get("tile") or "")
    ignore_paths = set(str(p).lower() for p in (descriptor.selectors.get("tagIgnorePaths") or ()))

    nodes = tree.css(tile_sel) if tile_sel else []
    if not nodes:
        if album_seg:
            nodes = tree.css(f'a[href*="{album_seg}"]')
        else:
            nodes = tree.css("a[href]")

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for node in nodes:
        a = node if node.tag == "a" else node.css_first("a[href]")
        if a is None:
            continue
        item_url = _abs_http_url(root_url, a.attributes.get("href"))
        if not item_url or item_url in seen:
            continue
        path_low = urlsplit(item_url).path.lower()
        if album_seg and album_seg not in path_low:
            continue
        if path_low in ignore_paths or "/search/" in path_low:
            continue
        img = a.css_first("img") or node.css_first("img")
        thumb = _pick_img_thumb(root_url, img.attributes) if img is not None else ""
        if not thumb:
            continue
        seen.add(item_url)
        raw_alt = (img.attributes.get("alt") if img is not None else "") or a.attributes.get("title") or a.text(strip=True)
        title = _clean_catalog_title(raw_alt, item_url, descriptor.display_name)
        hd_thumb = _upgrade_thumb(thumb, upgrade)
        entry = make_item_entry(
            source_id=descriptor.id,
            item_id=f"{descriptor.id}_{hashlib.sha1(item_url.encode()).hexdigest()[:12]}",
            item_type="gif" if item_type == "gif" else "album",
            title=title,
            original_url=item_url,
            thumbnail=thumb,
            creator_name=descriptor.display_name,
            creator_handle=descriptor.id,
            source_page="",
            album_url=item_url,
            neutral_label=descriptor.display_name,
        )
        entry["previewHdUrl"] = hd_thumb
        entry["mediaType"] = media_type_override or ("gif" if item_type == "gif" else ("photo" if item_type == "photo_grid" else "album"))
        entry["needsEnrichment"] = True
        items.append(entry)

    has_next = False
    for pg_a in tree.css(".pagination a[href], .pager a[href], .nav-links a[href]"):
        txt = pg_a.text(strip=True).lower()
        href_p = pg_a.attributes.get("href") or ""
        if "next" in txt or pg_a.attributes.get("rel") == "next":
            has_next = True
            break
        if txt.isdigit() and int(txt) > current_page:
            has_next = True
            break
        m_page = re.search(r"/(\d+)/?$", urlsplit(href_p).path)
        if m_page and int(m_page.group(1)) > current_page:
            has_next = True
            break
    return items, has_next


def parse_catalog_categories(html: str, descriptor: CatalogDescriptor, *, page_url: str = "") -> list[dict[str, Any]]:
    base_url = page_url or descriptor.effective_base_url() + "/"
    tree = LexborHTMLParser(html or "")
    album_seg = str(descriptor.browse.get("albumPathSegment") or "/galleries/").lower()
    ignore_paths = set(str(p).lower() for p in (descriptor.selectors.get("tagIgnorePaths") or ("/",)))
    artist_prefixes = tuple(descriptor.selectors.get("artistPrefixes") or ("/pornstars/", "/models/", "/artists/"))
    channel_prefixes = tuple(descriptor.selectors.get("channelPrefixes") or ("/channels/", "/creators/"))

    entries: dict[str, dict[str, Any]] = {}
    for a in tree.css("a[href]"):
        if _is_inside_chrome_container(a):
            continue
        href = _abs_http_url(base_url, a.attributes.get("href"))
        if not href:
            continue
        parsed = urlsplit(href)
        base_host = (urlsplit(base_url).hostname or "").lower().removeprefix("www.")
        cand_host = (parsed.hostname or "").lower().removeprefix("www.")
        if cand_host and base_host and cand_host != base_host and not cand_host.endswith("." + base_host):
            continue
        path_low = parsed.path.lower()
        if (
            path_low in ignore_paths
            or path_low == "/"
            or album_seg in path_low
            or any(pref in path_low for pref in artist_prefixes + channel_prefixes)
            or any(bad in path_low for bad in ("/login", "/signup", "/search", "/member", "/upload", "/to/"))
        ):
            continue
        segs = [s for s in path_low.strip("/").split("/") if s]
        if len(segs) != 1:
            continue
        slug = segs[0]
        if slug.isdigit():
            continue
        img = a.css_first("img")
        thumb = directory_thumbnail(a, base_url)
        label = (a.attributes.get("title") or (img.attributes.get("alt") if img is not None else "") or a.text(strip=True) or "").strip()
        if _is_utility_or_legal_link(path_low, label):
            continue
        if not label and not thumb:
            continue
        label = re.sub(r"\s+(?:Porn\s*Pics|Pics|Galleries)$", "", label, flags=re.IGNORECASE).strip() or slug.replace("-", " ").title()
        if not label or label.isdigit():
            continue
        entry = entries.setdefault(slug, {
            "id": slug,
            "name": label,
            "url": href,
            "kind": "category",
            "avatar": thumb or None,
        })
        if thumb and not entry.get("avatar"):
            entry.update(name=label, avatar=thumb)
    return list(entries.values())


def _extract_directory_anchor_item(a_node: Any, base_url: str) -> tuple[str, int | None]:
    count_val: int | None = None
    # 1. Extract numeric count strictly from dedicated count badges / numeric-only spans
    count_texts: list[str] = []
    for cand in a_node.css(".g-count, .count, .num, small, em, span"):
        raw_txt = (cand.text(strip=True) or "").strip()
        if raw_txt and re.match(r"^\(?[\d,.\s]+\)?$", raw_txt):
            digits = re.sub(r"[^\d]", "", raw_txt)
            if digits.isdigit():
                count_val = int(digits)
                count_texts.append(raw_txt)
                break

    # 2. Prefer explicit name elements or title/alt attributes over concatenated text
    name = ""
    for sel in (".m-name", ".name", ".title", "h2", "h3", "h4", "strong"):
        n = a_node.css_first(sel)
        if n is not None:
            t = (n.text(strip=True) or "").strip()
            if t and not t.isdigit():
                name = t
                break
    if not name:
        title_attr = (a_node.attributes.get("title") or "").strip()
        img = a_node.css_first("img")
        alt_attr = (img.attributes.get("alt") or "").strip() if img is not None else ""
        if title_attr and not title_attr.isdigit():
            name = title_attr
        elif alt_attr and not alt_attr.isdigit():
            name = alt_attr

    if not name:
        full = (a_node.text(separator=" ", strip=True) or "").strip()
        for ct in count_texts:
            if ct in full:
                full = full.replace(ct, "").strip()
        m_cnt = re.match(r"^(.+?)\s*\(?(\d{1,3}(?:,\d{3})+|\d+)\)?\s*$", full)
        if m_cnt and not m_cnt.group(1).strip().isdigit():
            name = m_cnt.group(1).strip()
            if count_val is None:
                count_val = int(m_cnt.group(2).replace(",", ""))
        else:
            name = full

    name = re.sub(r"\s+", " ", name).strip()
    if name.isdigit():
        name = ""
    return name, count_val


def parse_catalog_directory(html: str, descriptor: CatalogDescriptor, kind: str, *, page_url: str = "") -> list[dict[str, Any]]:
    k = (kind or "categories").strip().lower()
    if k == "categories":
        return parse_catalog_categories(html, descriptor, page_url=page_url)

    base_url = page_url or descriptor.effective_base_url() + "/"
    tree = LexborHTMLParser(html or "")
    prefixes = (
        tuple(descriptor.selectors.get("artistPrefixes") or ("/pornstars/", "/models/", "/artists/"))
        if k == "artists"
        else tuple(descriptor.selectors.get("channelPrefixes") or ("/channels/", "/creators/"))
        if k == "channels"
        else (str(descriptor.browse.get("tagPathSegment") or "/tags/"),)
    )
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for a in tree.css("a[href]"):
        if _is_inside_chrome_container(a):
            continue
        href = _abs_http_url(base_url, a.attributes.get("href"))
        if not href or href in seen or not descriptor.matches_host(urlsplit(href).hostname or ""):
            continue
        parsed = urlsplit(href)
        path_low = parsed.path.lower()
        if _LOCALE_PATH_RE.match(path_low) or _STATIC_DOC_EXT_RE.search(path_low):
            continue
        if not any(pref in path_low for pref in prefixes):
            continue
        if path_low.rstrip("/") in {p.rstrip("/") for p in prefixes}:
            continue
        segs = [s for s in path_low.strip("/").split("/") if s]
        # Skip numeric pagination links like /pornstars/6/ or /tags/2/ and utility index pages like /list/
        if not segs or segs[-1].isdigit() or segs[-1] in _UTILITY_SLUG_SET:
            continue
        avatar = directory_thumbnail(a, base_url)
        name, count = _extract_directory_anchor_item(a, base_url)
        if not name:
            name = humanize_slug_title(href)
        if not name or name.isdigit() or name.lower() in ("pornstars", "artists", "channels", "creators", "tags", "models", "next", "prev", "previous"):
            continue
        if _LEGAL_LABEL_RE.search(name):
            continue
        seen.add(href)
        items.append({
            "id": segs[-1] or hashlib.sha1(href.encode()).hexdigest()[:10],
            "name": name,
            "url": href,
            "kind": k.rstrip("s") if k in ("artists", "channels", "tags") else k,
            "count": count,
            "avatar": avatar or None,
        })
    return items


def extract_gallery_entity_metadata(
    html: str,
    page_url: str,
    descriptor: CatalogDescriptor,
    *,
    extra_meta_selectors: str = "",
) -> dict[str, Any]:
    tree = LexborHTMLParser(html or "")
    base_url = descriptor.effective_base_url() or page_url
    meta_sel = str(descriptor.selectors.get("galleryMeta") or ".gallery-info a[href], #gallery-info a[href], .info a[href], .details a[href]")
    if extra_meta_selectors:
        meta_sel = f"{meta_sel}, {extra_meta_selectors}"
    img_sel = str(descriptor.selectors.get("galleryImages") or "a[href]")
    artist_prefixes = tuple(descriptor.selectors.get("artistPrefixes") or ("/pornstars/", "/models/", "/artists/"))
    channel_prefixes = tuple(descriptor.selectors.get("channelPrefixes") or ("/channels/", "/creators/"))
    ignore_paths = set(str(p).lower() for p in (descriptor.selectors.get("tagIgnorePaths") or ("/",)))
    album_seg = str(descriptor.browse.get("albumPathSegment") or "").lower()

    artists: list[dict[str, str]] = []
    channels: list[dict[str, str]] = []
    tag_entities: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    for node in tree.css(meta_sel):
        if _is_inside_chrome_container(node):
            continue
        href = _abs_http_url(base_url, node.attributes.get("href"))
        label = (node.text(strip=True) or "").strip()
        if not href or not label or href in seen_urls:
            continue
        path_low = urlsplit(href).path.lower()
        if path_low in ignore_paths or (album_seg and album_seg in path_low) or _is_utility_or_legal_link(path_low, label):
            continue
        seen_urls.add(href)
        if any(pref in path_low for pref in artist_prefixes):
            if path_low.rstrip("/") not in {p.rstrip("/") for p in artist_prefixes}:
                artists.append({"name": label, "url": href, "kind": "artist"})
        elif any(pref in path_low for pref in channel_prefixes):
            if path_low.rstrip("/") not in {p.rstrip("/") for p in channel_prefixes}:
                channels.append({"name": label, "url": href, "kind": "channel"})
        else:
            tag_entities.append({"name": label, "url": href, "kind": "tag"})

    # Extract full-size gallery images + thumbnails in DOM order (skip avatars/svg/chrome)
    upgrade = descriptor.browse.get("thumbUpgrade")
    photos: list[str] = []
    photo_items: list[dict[str, Any]] = []
    seen_img_urls: set[str] = set()
    for a in tree.css(img_sel):
        if _is_inside_chrome_container(a):
            continue
        href_u = _abs_http_url(page_url, a.attributes.get("href"))
        href_path = urlsplit(href_u).path.lower() if href_u else ""
        if href_u and (
            is_placeholder_media_url(href_u)
            or "/models/" in href_path
            or href_path.endswith(".svg")
            or not _IMAGE_URL_RE.search(href_path)
        ):
            href_u = ""
        img = a.css_first("img")
        thumb_u = _pick_img_thumb(page_url, img.attributes) if img is not None else ""
        thumb_path = urlsplit(thumb_u).path.lower() if thumb_u else ""
        if thumb_u and ("/models/" in thumb_path or thumb_path.endswith(".svg")):
            thumb_u = ""
        full_u = href_u or (_upgrade_thumb(thumb_u, upgrade) if thumb_u and _IMAGE_URL_RE.search(thumb_path) else "")
        if not full_u or full_u in seen_img_urls:
            continue
        seen_img_urls.add(full_u)
        photos.append(full_u)
        photo_items.append({
            "id": f"photo-{hashlib.sha256(full_u.encode()).hexdigest()[:16]}",
            "url": full_u,
            "thumbnailUrl": thumb_u or full_u,
            "pageUrl": page_url,
            "sourcePage": page_url,
            "isResolvedOriginal": True,
        })

    h1 = tree.css_first("h1")
    title = (h1.text(strip=True) if h1 is not None else "") or humanize_slug_title(page_url, descriptor.display_name)
    primary = artists[0] if artists else (channels[0] if channels else None)
    return {
        "title": title,
        "author": primary["name"] if primary else descriptor.display_name,
        "authorUrl": primary["url"] if primary else "",
        "artists": artists,
        "channels": channels,
        "tags": [t["name"] for t in tag_entities],
        "tagEntities": tag_entities,
        "photoCount": len(photos) or None,
        "photos": photos,
        "photoItems": photo_items,
    }


async def enrich_catalog_items(client: httpx.AsyncClient, items: list[dict[str, str]]) -> dict[str, dict[str, Any]]:
    now = time.monotonic()
    out: dict[str, dict[str, Any]] = {}
    pending: list[tuple[str, CatalogDescriptor]] = []

    for raw in items[:8]:
        url = str(raw.get("url") or "").strip()
        if not url:
            continue
        cached = _ENRICH_CACHE.get(url)
        if cached and cached[0] > now:
            _ENRICH_CACHE.move_to_end(url)
            out[url] = cached[1]
            continue
        conn = find_connector_for_url(url)
        if isinstance(conn, CatalogDescriptor):
            pending.append((url, conn))

    if not pending:
        return out

    sem = _get_enrich_semaphore()

    async def _fetch_one(target_url: str, desc: CatalogDescriptor) -> tuple[str, dict[str, Any] | None]:
        async with sem:
            try:
                headers = resolve_anti_hotlink_headers(target_url, referer=desc.effective_base_url())
                resp = await client.get(target_url, headers=headers)
                resp.raise_for_status()
                meta = extract_gallery_entity_metadata(resp.text or "", str(resp.url or target_url), desc)
                return target_url, meta
            except Exception:
                return target_url, None

    results = await asyncio.gather(*(_fetch_one(u, d) for u, d in pending))
    for target_url, meta in results:
        if meta is None:
            continue
        _ENRICH_CACHE[target_url] = (now + _ENRICH_CACHE_TTL_S, meta)
        _ENRICH_CACHE.move_to_end(target_url)
        while len(_ENRICH_CACHE) > _ENRICH_CACHE_MAX:
            _ENRICH_CACHE.popitem(last=False)
        out[target_url] = meta
    return out


async def list_catalog_directory(
    client: httpx.AsyncClient,
    descriptor: CatalogDescriptor,
    kind: str = "categories",
    *,
    page: int = 1,
    page_url: str = "",
    query: str = "",
) -> dict[str, Any]:
    base_url = descriptor.effective_base_url()
    dirs = descriptor.browse.get("directories") or {}
    config = dirs.get(kind)
    rule = config if isinstance(config, dict) else {}
    fallback = config if isinstance(config, str) else "/"
    template = str((rule.get("searchPathTemplate") if query else None) or rule.get("pathTemplate") or fallback)
    if page > 1 and not rule.get("pathTemplate") and not query:
        template = f"{template.rstrip('/')}/{{page}}/"
    origin = base_url + "/"
    target = (valid_directory_url(origin, page_url) if page_url else "") or valid_directory_url(
        origin, directory_path(template, page, zero_based=bool(rule.get("pageBaseZero")), query=query),
    )
    if not target:
        raise ValueError("Invalid directory address")
    headers = resolve_anti_hotlink_headers(target, referer=base_url)
    resp = await client.get(target, headers=headers)
    resp.raise_for_status()
    final_url = str(resp.url)
    entries = parse_catalog_directory(resp.text or "", descriptor, kind, page_url=final_url)
    next_url = directory_next_url(LexborHTMLParser(resp.text or ""), final_url, page, rule)
    return {
        "source": descriptor.id,
        "kind": kind,
        "page": page,
        "items": entries,
        "hasMore": bool(next_url),
        "nextPage": page + 1 if next_url else None,
        "nextPageUrl": next_url or None,
    }


async def browse_catalog(
    client: httpx.AsyncClient,
    descriptor: CatalogDescriptor,
    category: str,
    *,
    subfilter: str | None = None,
    cursor: str | None = None,
    limit: int = 24,
):
    from .timeline_browse_providers import BrowsePageResult
    from .timeline_search_providers import decode_search_cursor, encode_search_cursor

    base_url = descriptor.effective_base_url()
    cur = decode_search_cursor(cursor)
    offset = int(cur.get("offset") or 0)
    page_num = max(1, int(cur.get("page") or ((offset // 20) + 1)))
    cat = (category or descriptor.default_category).strip().lower()
    sub = (subfilter or "").strip().lower()
    headers = resolve_anti_hotlink_headers(base_url, referer=base_url)

    ranking_paths = tuple(str(x).lower() for x in (descriptor.browse.get("rankingSubpaths") or ()))
    api_list_path = str(descriptor.browse.get("apiListPath") or "")
    search_api_path = str(descriptor.browse.get("searchApiPath") or "")

    try:
        items: list[dict[str, Any]] = []
        has_more = False
        next_cursor: str | None = None

        if descriptor.root_mode == "category_first":
            slug = sub or str(descriptor.browse.get("defaultSubfilterFallback") or "")
            if sub == "latest":
                slug = str(descriptor.browse.get("defaultSubfilterFallback") or "")
            if not slug:
                # Fetch root page and pick the first valid category slug
                r_root = await client.get(f"{base_url}/", headers=headers)
                if r_root.status_code == 200:
                    cats = parse_catalog_categories(r_root.text or "", descriptor)
                    if cats:
                        slug = cats[0]["id"]
            if slug:
                target_url = f"{base_url}/{slug}/" if page_num == 1 else f"{base_url}/{slug}/{page_num}/"
                resp = await client.get(target_url, headers=headers)
                if resp.status_code == 404 and page_num > 1:
                    items, has_more = [], False
                else:
                    resp.raise_for_status()
                    item_type: Literal["album", "gif", "photo_grid"] = "photo_grid" if cat == "photos" else "album"
                    media_override = "photo" if cat == "photos" else "album"
                    items, has_next = parse_catalog_html_items(
                        resp.text or "",
                        descriptor,
                        current_page=page_num,
                        item_type=item_type,
                        media_type_override=media_override,
                    )
                    next_cursor = encode_search_cursor({"page": page_num + 1}) if (has_next and items) else None
                    has_more = bool(next_cursor)

        elif cat == "gifs" and search_api_path:
            q = f"gif {sub}".strip() if sub and sub not in ranking_paths else "gif"
            qs = urlencode({"q": q, "lang": "en", "offset": offset, "limit": min(max(limit, 10), 40)})
            resp = await client.get(f"{base_url}{search_api_path}?{qs}", headers=headers)
            resp.raise_for_status()
            data = resp.json()
            items = parse_catalog_api_rows(
                data if isinstance(data, list) else [],
                descriptor,
                item_type="gif",
                extra_tags=("gif",),
            )
            next_cursor = encode_search_cursor({"offset": offset + len(items)}) if items else None
            has_more = bool(next_cursor)

        elif sub and sub in ranking_paths:
            rank_url = f"{base_url}/{sub}/" if page_num == 1 else f"{base_url}/{sub}/{page_num}/"
            resp = await client.get(rank_url, headers=headers)
            has_next = False
            if resp.status_code == 404 and page_num > 1:
                items = []
            else:
                resp.raise_for_status()
                items, has_next = parse_catalog_html_items(resp.text or "", descriptor, current_page=page_num)
            next_cursor = encode_search_cursor({"page": page_num + 1}) if (items and has_next) else None
            has_more = bool(next_cursor)

        elif sub and search_api_path:
            qs = urlencode({"q": sub, "lang": "en", "offset": offset, "limit": min(max(limit, 10), 40)})
            resp = await client.get(f"{base_url}{search_api_path}?{qs}", headers=headers)
            resp.raise_for_status()
            data = resp.json()
            items = parse_catalog_api_rows(data if isinstance(data, list) else [], descriptor, extra_tags=(sub,))
            next_cursor = encode_search_cursor({"offset": offset + len(items)}) if items else None
            has_more = bool(next_cursor)

        elif api_list_path:
            cat_id = (
                int(descriptor.browse.get("recentCatId") or 2587)
                if cat == "recent"
                else int(descriptor.browse.get("popularCatId") or 2586)
            )
            period = 0 if cat == "recent" else 3
            qs = urlencode({
                "category_id": cat_id,
                "lang": "en",
                "period": period,
                "orientation": "straight",
                "offset": offset,
                "limit": min(max(limit, 10), 40),
            })
            resp = await client.get(f"{base_url}{api_list_path}?{qs}", headers=headers)
            resp.raise_for_status()
            data = resp.json()
            items = parse_catalog_api_rows(data if isinstance(data, list) else [], descriptor)
            next_cursor = encode_search_cursor({"offset": offset + len(items)}) if items else None
            has_more = bool(next_cursor)

        return BrowsePageResult(
            source_id=descriptor.id,
            category=cat,
            subfilter=sub or None,
            items=items[:limit],
            next_cursor=next_cursor,
            has_more=has_more,
            resolved_origin=base_url,
        )
    except Exception as exc:
        return BrowsePageResult(
            source_id=descriptor.id,
            category=cat,
            subfilter=sub or None,
            resolved_origin=base_url,
            error=str(exc),
        )


async def search_catalog(
    client: httpx.AsyncClient,
    descriptor: CatalogDescriptor,
    query: str,
    category: str,
    *,
    cursor: str | None = None,
    options: dict[str, Any] | None = None,
):
    from .timeline_search_providers import SearchPageResult, decode_search_cursor, encode_search_cursor

    q = (query or "").strip()
    if not q:
        return SearchPageResult(descriptor.id, category)
    base_url = descriptor.effective_base_url()
    cur = decode_search_cursor(cursor)
    headers = resolve_anti_hotlink_headers(base_url, referer=base_url)
    opts = options or {}
    subfilter = str(opts.get("subfilter") or "").strip()
    ranking_subpaths = set(str(x).lower() for x in (descriptor.browse.get("rankingSubpaths") or ()))
    is_sort_subfilter = subfilter.lower() in ranking_subpaths
    tag_refinement = "" if is_sort_subfilter else subfilter
    effective_q = f"{q} {tag_refinement}".strip() if (tag_refinement and tag_refinement.lower() not in q.lower()) else q

    try:
        if category == "profiles":
            async def fetch_directory(kind: str, **params: Any) -> dict[str, Any]:
                return await list_catalog_directory(client, descriptor, kind, **params)

            return await search_directory_profiles(
                descriptor.id, q, descriptor.browse.get("directories") or {}, fetch_directory, cursor=cursor,
            )

        search_api_path = str(descriptor.browse.get("searchApiPath") or "")
        if search_api_path:
            offset = int(cur.get("offset") or 0)
            search_q = f"gif {effective_q}" if category == "gifs" else effective_q
            qs_params: dict[str, Any] = {"q": search_q, "lang": "en", "offset": offset, "limit": 24}
            qs = urlencode(qs_params)
            resp = await client.get(f"{base_url}{search_api_path}?{qs}", headers=headers)
            resp.raise_for_status()
            rows = resp.json()
            item_type: Literal["album", "gif"] = "gif" if category == "gifs" else "album"
            items = parse_catalog_api_rows(rows if isinstance(rows, list) else [], descriptor, item_type=item_type)
            next_cur = encode_search_cursor({"offset": offset + len(items)}) if items else None
            return SearchPageResult(descriptor.id, category, items=items, next_cursor=next_cur, has_more=bool(next_cur))

        page = int(cur.get("page") or 1)
        slug = re.sub(r"[^a-z0-9]+", "-", effective_q.lower()).strip("-") or quote_plus(effective_q)
        tpl = str(descriptor.browse.get("searchPathTemplate") or "/search/{slug}/")
        paged_tpl = str(descriptor.browse.get("searchPagedTemplate") or "/search/{slug}/{page}/")
        rel = tpl.format(slug=slug, page=page) if page == 1 else paged_tpl.format(slug=slug, page=page)
        resp = await client.get(f"{base_url}{rel}", headers=headers)
        resp.raise_for_status()
        items, has_next = parse_catalog_html_items(resp.text or "", descriptor, current_page=page)
        next_cur = encode_search_cursor({"page": page + 1}) if (has_next and items) else None
        return SearchPageResult(descriptor.id, category, items=items, next_cursor=next_cur, has_more=bool(next_cur))
    except Exception as exc:
        return SearchPageResult(descriptor.id, category, error=str(exc))


async def read_catalog_entity_profile(
    client: httpx.AsyncClient,
    descriptor: CatalogDescriptor,
    url: str,
    *,
    page: int = 1,
    name_hint: str = "",
) -> dict[str, Any]:
    parsed_in = urlsplit(url.strip())
    clean_path = parsed_in.path.rstrip("/") + "/"
    if page > 1 and not re.search(rf"/{page}/?$", clean_path):
        clean_path = f"{clean_path}{page}/"
    target_url = urlunsplit((parsed_in.scheme, parsed_in.netloc, clean_path, parsed_in.query, ""))
    base_url = descriptor.effective_base_url()
    headers = resolve_anti_hotlink_headers(target_url, referer=base_url)
    resp = await client.get(target_url, headers=headers)
    resp.raise_for_status()
    final_url = str(resp.url or target_url)
    html = resp.text or ""
    tree = LexborHTMLParser(html)

    h1 = tree.css_first("h1") or tree.css_first("title")
    name = (name_hint or (h1.text(separator=" ", strip=True) if h1 is not None else "") or humanize_slug_title(final_url, descriptor.display_name)).strip()
    avatar_sel = str(descriptor.selectors.get("avatar") or ".model-info img, .channel-info img, .pornstar-info img, img.avatar")
    av_node = tree.css_first(avatar_sel)
    avatar_url = _pick_img_thumb(final_url, av_node.attributes) if av_node is not None else ""

    items, has_next = parse_catalog_html_items(html, descriptor, base_url=final_url, current_page=page)
    # Optional script-driven search API supplement on page 1
    search_api_path = str(descriptor.browse.get("searchApiPath") or "")
    if page == 1 and search_api_path:
        m_q = re.search(r"QUERY\s*=\s*['\"]([^'\"]+)['\"]", html)
        if m_q and m_q.group(1).strip():
            try:
                qs = urlencode({"q": m_q.group(1).strip(), "lang": "en", "offset": "0", "limit": "24"})
                srch_res = await client.get(f"{base_url}{search_api_path}?{qs}", headers=headers)
                if srch_res.status_code == 200:
                    rows = srch_res.json()
                    extra = parse_catalog_api_rows(rows if isinstance(rows, list) else [], descriptor)
                    seen_u = {it["albumUrl"] for it in items}
                    for it in extra:
                        if it["albumUrl"] not in seen_u:
                            seen_u.add(it["albumUrl"])
                            items.append(it)
            except Exception:
                pass

    albums: list[dict[str, Any]] = []
    gifs: list[dict[str, Any]] = []
    for it in items:
        if page == 1 and not avatar_url and it.get("thumbnail"):
            avatar_url = it["thumbnail"]
        rec = {
            "url": it["albumUrl"],
            "title": it["title"],
            "thumbnailUrl": it["thumbnail"],
            "previewHdUrl": it.get("previewHdUrl") or it["thumbnail"],
            "type": it["type"],
            "mediaType": it["mediaType"],
            "sourceSite": descriptor.id,
            "authorName": name,
            "authorUrl": final_url,
            "needsEnrichment": bool(it.get("needsEnrichment", True)),
        }
        if isinstance(it.get("photoCount"), int) and it["photoCount"] > 0:
            rec["photoCount"] = it["photoCount"]
        if isinstance(it.get("photos"), list) and it["photos"]:
            rec["photos"] = it["photos"]
        if it["type"] == "gif":
            gifs.append(rec)
        else:
            albums.append(rec)

    meta = extract_gallery_entity_metadata(
        html,
        final_url,
        descriptor,
        extra_meta_selectors=".model-info a[href], .channel-info a[href], .pornstar-info a[href], .artist-info a[href], .tags a[href], .related-tags a[href]",
    )
    related_entities = [
        ent for ent in (meta.get("artists", []) + meta.get("channels", []) + meta.get("tagEntities", []))
        if isinstance(ent, dict) and ent.get("url") and ent["url"].rstrip("/") != final_url.rstrip("/")
    ]
    entity_kind = detect_catalog_entity_kind(final_url, descriptor)

    next_page_url: str | None = None
    for pg_a in tree.css(".pagination a[href], .pager a[href], .nav-links a[href], a[rel='next']"):
        txt = (pg_a.text(strip=True) or "").lower()
        cand_href = _abs_http_url(final_url, pg_a.attributes.get("href"))
        if not cand_href:
            continue
        if "next" in txt or pg_a.attributes.get("rel") == "next":
            next_page_url = cand_href
            has_next = True
            break
        if txt.isdigit() and int(txt) == page + 1 and not next_page_url:
            next_page_url = cand_href
            has_next = True

    return {
        "source": descriptor.id,
        "source_url": final_url,
        "name": name,
        "avatarUrl": avatar_url,
        "entityKind": entity_kind,
        "albums": albums,
        "gifs": gifs,
        "relatedEntities": related_entities[:24],
        "page": page,
        "hasMore": has_next,
        "nextPage": page + 1 if has_next else None,
        "nextPageUrl": next_page_url,
    }


def clear_gallery_detail_cache() -> None:
    _GALLERY_DETAIL_CACHE.clear()


async def read_catalog_gallery_detail(
    client: httpx.AsyncClient,
    descriptor: CatalogDescriptor,
    gallery_url: str,
) -> dict[str, Any]:
    """Fetch a complete in-app gallery page: full-res photos, artists, channels, tags, and related galleries."""
    from .profile_hub_workers import parse_album_page_lexbor

    target = (gallery_url or "").strip()
    now = time.monotonic()
    cached = _GALLERY_DETAIL_CACHE.get(target)
    if cached and cached[0] > now:
        _GALLERY_DETAIL_CACHE.move_to_end(target)
        return cached[1]

    base_url = descriptor.effective_base_url()
    headers = resolve_anti_hotlink_headers(target, referer=base_url)
    resp = await client.get(target, headers=headers)
    resp.raise_for_status()
    final_url = str(resp.url or target)
    html = resp.text or ""

    album_parsed = parse_album_page_lexbor(html, final_url)
    photos = album_parsed.get("photos") or []
    meta = extract_gallery_entity_metadata(html, final_url, descriptor)

    # Fetch related galleries via searchApiPath or primary artist/category page (generic, zero site literals)
    related_galleries: list[dict[str, Any]] = []
    norm_self = final_url.rstrip("/").lower()
    try:
        search_api_path = str(descriptor.browse.get("searchApiPath") or "")
        artists_list = meta.get("artists") or []
        tag_entities = meta.get("tagEntities") or []
        if search_api_path:
            seed_q = (artists_list[0]["name"] if artists_list else (tag_entities[0]["name"] if tag_entities else ""))
            if seed_q:
                qs = urlencode({"q": seed_q, "lang": "en", "offset": 0, "limit": 16})
                r_rel = await client.get(f"{base_url}{search_api_path}?{qs}", headers=headers)
                if r_rel.status_code == 200:
                    rows = r_rel.json()
                    for item in parse_catalog_api_rows(rows if isinstance(rows, list) else [], descriptor):
                        if (item.get("albumUrl") or "").rstrip("/").lower() == norm_self:
                            continue
                        related_galleries.append(item)
                        if len(related_galleries) >= 12:
                            break
        else:
            seed_url = (artists_list[0]["url"] if artists_list else (tag_entities[0]["url"] if tag_entities else ""))
            if seed_url:
                r_rel = await client.get(seed_url, headers=headers)
                if r_rel.status_code == 200:
                    rel_items, _ = parse_catalog_html_items(r_rel.text or "", descriptor, base_url=str(r_rel.url or seed_url))
                    for item in rel_items:
                        if (item.get("albumUrl") or "").rstrip("/").lower() == norm_self:
                            continue
                        related_galleries.append(item)
                        if len(related_galleries) >= 12:
                            break
    except Exception:
        related_galleries = []

    payload = {
        "ok": True,
        "source": descriptor.id,
        "sourceName": descriptor.display_name,
        "galleryUrl": final_url,
        "title": meta.get("title") or humanize_slug_title(final_url, descriptor.display_name),
        "author": meta.get("author") or descriptor.display_name,
        "authorUrl": meta.get("authorUrl") or "",
        "artists": meta.get("artists") or [],
        "channels": meta.get("channels") or [],
        "tags": meta.get("tags") or [],
        "tagEntities": meta.get("tagEntities") or [],
        "photos": photos,
        "count": len(photos),
        "relatedGalleries": related_galleries,
    }
    if photos:
        _GALLERY_DETAIL_CACHE[target] = (now + _GALLERY_DETAIL_CACHE_TTL_S, payload)
        _GALLERY_DETAIL_CACHE.move_to_end(target)
        while len(_GALLERY_DETAIL_CACHE) > _GALLERY_DETAIL_CACHE_MAX:
            _GALLERY_DETAIL_CACHE.popitem(last=False)
    return payload
