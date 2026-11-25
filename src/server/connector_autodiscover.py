"""Universal structural auto-discovery and local connector bundle management.

Allows any clean installation of IMAGEX to integrate unknown media portals,
gallery catalogs, or forum boards directly from a pasted URL by inspecting
generic HTML, JSON-LD, OpenGraph, form, pagination, and runtime yt-dlp
signals — with zero hardcoded site names or external config files required.
"""
from __future__ import annotations

from collections import Counter
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import threading
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
from selectolax.lexbor import LexborHTMLParser

from . import connector_registry

_CONNECTOR_WRITE_LOCK = threading.Lock()
_MAX_FETCH_BYTES = 2 * 1024 * 1024
_MAX_IMPORT_BYTES = 2 * 1024 * 1024
_FETCH_TIMEOUT_S = 10.0

_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_DURATION_TEXT_RE = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")
_HLS_OR_MP4_RE = re.compile(r"""https?://[^\s"'<>]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>]*)?""", re.IGNORECASE)
_ITEM_PATH_RE = re.compile(
    r"/(?:video|videos|watch|view_video|clip|clips|player|embed|album|albums|gallery|galleries|photo|photos|thread|threads|post|posts|status)/[^/]+",
    re.IGNORECASE,
)
_PROFILE_PATH_PREFIXES = frozenset(
    {
        "channel",
        "channels",
        "creator",
        "creators",
        "artist",
        "artists",
        "model",
        "models",
        "profile",
        "profiles",
        "user",
        "users",
        "author",
        "authors",
        "performer",
        "performers",
        "member",
        "members",
    }
)
_NETWORK_ROOT_SEGMENTS = frozenset(
    {
        "",
        "home",
        "index",
        "explore",
        "discover",
        "latest",
        "recent",
        "popular",
        "trending",
        "best",
        "new",
        "top",
        "videos",
        "albums",
        "galleries",
        "boards",
        "forums",
        "categories",
        "tags",
    }
)
_ALLOWED_BUNDLE_KEYS = ("catalogs", "forums", "videoPortals", "imageHosts")


def _allow_insecure_test_origins() -> bool:
    return os.environ.get("IMAGEX_TEST_ALLOW_LOCALHOST", "").strip() == "1"


def _is_public_ip(ip_str: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return bool(
        addr.is_global
        and not addr.is_private
        and not addr.is_loopback
        and not addr.is_link_local
        and not addr.is_multicast
        and not addr.is_reserved
    )


def validate_discovery_url(raw_url: str) -> tuple[str | None, str | None]:
    """Validate and normalize a URL for outbound structural discovery (SSRF-safe)."""
    text = (raw_url or "").strip()
    if not text or any(ch.isspace() for ch in text):
        return None, "invalid_url"
    if "://" not in text:
        text = f"https://{text}"
    try:
        parsed = urlsplit(text)
    except Exception:
        return None, "invalid_url"

    allow_local = _allow_insecure_test_origins()
    if parsed.scheme == "http" and not allow_local:
        return None, "https_required"
    if parsed.scheme not in ("https", "http"):
        return None, "invalid_url"

    host = (parsed.hostname or "").strip().lower()
    if not host or parsed.username is not None or parsed.password is not None:
        return None, "invalid_url"

    if not allow_local:
        if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".local") or host.endswith(".internal"):
            return None, "blocked_private_host"
        try:
            ipaddress.ip_address(host)
            if not _is_public_ip(host):
                return None, "blocked_private_host"
        except ValueError:
            try:
                infos = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
            except OSError:
                return None, "unreachable_origin"
            resolved_ips = {info[4][0] for info in infos if info and info[4]}
            if not resolved_ips or not all(_is_public_ip(ip) for ip in resolved_ips):
                return None, "blocked_private_host"

    clean = parsed._replace(fragment="").geturl()
    return clean, None


def check_ytdlp_runtime_support(url: str) -> bool:
    """Dynamically check whether installed yt-dlp has a dedicated extractor for `url`."""
    try:
        from yt_dlp.extractor import gen_extractors
    except Exception:
        return False
    try:
        for ie in gen_extractors():
            ie_name = getattr(ie, "IE_NAME", "") or ""
            if ie_name.lower() == "generic":
                continue
            try:
                if ie.suitable(url):
                    return True
            except Exception:
                continue
    except Exception:
        return False
    return False


def _slug_from_host(host: str) -> str:
    clean = host.lower().removeprefix("www.").removeprefix("m.")
    slug = re.sub(r"[^a-z0-9]+", "_", clean).strip("_")
    return slug or "custom_source"


def _parse_json_ld_types(tree: LexborHTMLParser) -> list[str]:
    found: list[str] = []
    for script in tree.css('script[type="application/ld+json"]'):
        raw = script.text(strip=True)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        stack = [data]
        while stack:
            cur = stack.pop()
            if isinstance(cur, dict):
                t = cur.get("@type")
                if isinstance(t, str):
                    found.append(t)
                elif isinstance(t, list):
                    found.extend(str(x) for x in t if isinstance(x, str))
                for val in cur.values():
                    if isinstance(val, (dict, list)):
                        stack.append(val)
            elif isinstance(cur, list):
                stack.extend(cur)
    return found


def _infer_display_name(tree: LexborHTMLParser, host: str) -> str:
    og_site = tree.css_first('meta[property="og:site_name"]')
    if og_site is not None:
        val = (og_site.attributes.get("content") or "").strip()
        if 1 <= len(val) <= 48:
            return val
    title_node = tree.css_first("title")
    if title_node is not None:
        raw_title = re.sub(r"\s+", " ", title_node.text(strip=True))
        for sep in (" - ", " | ", " :: ", " — ", " · "):
            if sep in raw_title:
                raw_title = raw_title.split(sep)[-1].strip()
        if 2 <= len(raw_title) <= 40:
            return raw_title
    base = host.removeprefix("www.").removeprefix("m.").split(".")[0]
    return base.replace("-", " ").replace("_", " ").title() or "Custom Source"


def _infer_accent_color(tree: LexborHTMLParser) -> str:
    meta = tree.css_first('meta[name="theme-color"]')
    if meta is not None:
        color = (meta.attributes.get("content") or "").strip()
        if _HEX_COLOR_RE.match(color):
            return color
    return "#3b82f6"


def _infer_search_template(tree: LexborHTMLParser, base_url: str) -> str:
    for form in tree.css("form"):
        action = (form.attributes.get("action") or "").strip()
        text_input = form.css_first('input[type="search"], input[type="text"], input:not([type])')
        if text_input is None:
            continue
        param = (text_input.attributes.get("name") or "").strip()
        if not param:
            continue
        low_action = action.lower()
        low_param = param.lower()
        if (
            "search" in low_action
            or "find" in low_action
            or low_param in {"q", "k", "s", "query", "search", "keyword", "keywords", "term"}
        ):
            target = urljoin(base_url + "/", action or "/search")
            parsed = urlsplit(target)
            path = parsed.path or "/search"
            return f"{path}?{param}={{query}}&page={{page}}"
    return "/search?q={query}&page={page}"


def _infer_card_selector(tree: LexborHTMLParser) -> tuple[str, int, int]:
    """Infer the most frequent repeated media card container selector and count duration cues."""
    class_counter: Counter[str] = Counter()
    total_image_anchors = 0
    duration_cards = 0

    for anchor in tree.css("a[href]"):
        if anchor.css_first("img") is None:
            continue
        total_image_anchors += 1
        parent = anchor.parent
        grand = parent.parent if parent is not None else None
        container = parent
        for candidate in (parent, grand):
            if candidate is None:
                continue
            cls = (candidate.attributes.get("class") or "").strip()
            if cls:
                container = candidate
                break
        if container is not None:
            tag = (container.tag or "div").lower()
            classes = [c for c in (container.attributes.get("class") or "").split() if re.fullmatch(r"[A-Za-z0-9_-]{2,40}", c)]
            if classes:
                class_counter[f"{tag}.{classes[0]}"] += 1
            text_sample = container.text(strip=True)
            if _DURATION_TEXT_RE.search(text_sample):
                duration_cards += 1

    if class_counter:
        best_sel, best_count = class_counter.most_common(1)[0]
        if best_count >= 2:
            return best_sel, total_image_anchors, duration_cards
    return "article, li, div", total_image_anchors, duration_cards


_VIDEO_ITEM_ROUTE_RE = re.compile(
    r"^/(?:videos?|watch|clips?)(?:[/_-])[^/?#]+", re.IGNORECASE
)


def _count_video_card_links(tree: LexborHTMLParser, origin: str) -> int:
    """Count unique same-site thumbnail links with a recognizable video-item route."""
    host = (urlsplit(origin).hostname or "").removeprefix("www.")
    paths = set()
    for anchor in tree.css("a[href]"):
        if anchor.css_first("img") is None:
            continue
        try:
            linked = urlsplit(urljoin(origin + "/", anchor.attributes.get("href") or ""))
        except ValueError:
            continue
        if linked.scheme == "https" and (linked.hostname or "").removeprefix("www.") == host:
            if _VIDEO_ITEM_ROUTE_RE.match(linked.path):
                paths.add(linked.path)
    return len(paths)


def _classify_deep_url_level(
    normalized_url: str,
    target_tree: LexborHTMLParser | None,
    ld_types: list[str],
    archetype: str,
) -> tuple[str, str | None]:
    parsed = urlsplit(normalized_url)
    segments = [seg for seg in parsed.path.split("/") if seg]
    if not segments:
        return "network", None
    first = segments[0].lower()
    if first in _NETWORK_ROOT_SEGMENTS and len(segments) == 1:
        return "network", None

    ld_lower = {t.lower() for t in ld_types}
    if any(t in ld_lower for t in ("videoobject", "imagegallery", "discussionforumposting", "mediaobject")):
        return "item", None
    if _ITEM_PATH_RE.search(parsed.path):
        return "item", None
    if target_tree is not None and (
        target_tree.css_first("video, video source") is not None
        or target_tree.css_first('meta[property="og:video"], meta[property="og:video:url"]') is not None
    ):
        return "item", None

    if any(t in ld_lower for t in ("person", "profilepage")):
        handle = segments[-1].lstrip("@")
        return "profile", f"@{handle}" if handle else None
    if first in _PROFILE_PATH_PREFIXES and len(segments) >= 2:
        handle = segments[1].lstrip("@")
        return "profile", f"@{handle}" if handle else None
    if first.startswith("@"):
        return "profile", first

    if archetype == "forum_board" and ("thread" in first or "topic" in first):
        return "item", None

    return "network", None


def synthesize_descriptor_from_html(
    *,
    normalized_url: str,
    root_html: str,
    target_html: str | None = None,
    ytdlp_supported: bool = False,
) -> tuple[str, dict[str, Any], str, str | None] | None:
    """Analyze fetched HTML + signals and synthesize a local connector descriptor.

    Returns `(bundle_key, descriptor_dict, level, suggested_handle)` or `None`
    when the page has no recognizable media, video, gallery, or forum structure.
    """
    parsed = urlsplit(normalized_url)
    host = (parsed.hostname or "").lower()
    origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    clean_domain = host.removeprefix("www.")
    source_id = _slug_from_host(clean_domain)

    root_tree = LexborHTMLParser(root_html or "")
    target_tree = LexborHTMLParser(target_html) if target_html is not None else root_tree

    ld_types = _parse_json_ld_types(root_tree)
    if target_tree is not root_tree:
        ld_types.extend(_parse_json_ld_types(target_tree))
    ld_lower = {t.lower() for t in ld_types}

    display_name = _infer_display_name(root_tree, clean_domain)
    accent_color = _infer_accent_color(root_tree)
    search_tmpl = _infer_search_template(root_tree, origin)
    card_selector, image_anchors, duration_cards = _infer_card_selector(root_tree)

    combined_html = f"{root_html}\n{target_html or ''}"
    has_video_tag = bool(
        root_tree.css_first("video, video source") is not None
        or target_tree.css_first("video, video source") is not None
        or target_tree.css_first('meta[property="og:video"], meta[property="og:video:url"]') is not None
        or _HLS_OR_MP4_RE.search(combined_html)
    )
    forum_links = len(
        root_tree.css('a[href*="/threads/"], a[href*="/forums/"], a[href*="showthread"], a[href*="forumdisplay"]')
    )

    is_video_portal = (
        ytdlp_supported
        or "videoobject" in ld_lower
        or has_video_tag
        or duration_cards >= 2
        or _count_video_card_links(root_tree, origin) >= 3
    )
    is_forum = (
        not is_video_portal
        and ("discussionforumposting" in ld_lower or forum_links >= 3)
    )
    is_gallery = (
        not is_video_portal
        and not is_forum
        and ("imagegallery" in ld_lower or image_anchors >= 3)
    )

    if not (is_video_portal or is_forum or is_gallery):
        return None

    if is_video_portal:
        level, handle = _classify_deep_url_level(normalized_url, target_tree, ld_types, "video_portal")
        descriptor: dict[str, Any] = {
            "id": source_id,
            "displayName": display_name,
            "domains": [clean_domain],
            "canonicalOrigin": origin,
            "accentColor": accent_color,
            "enabled": True,
            "autoDiscovered": True,
            "iconKind": "video_portal",
            "catalogModes": ["videos", "popular", "recent"],
            "defaultCategory": "recent",
            "searchCategories": ["all", "profiles", "videos"],
            "capabilities": {
                "archetype": "video_portal",
                "layoutMode": "video_wall",
                "supportsComments": False,
                "supportsSourceLikes": False,
                "supportsNativePlayback": True,
                "supportsVideosTab": True,
                "supportsPlaylists": False,
                "supportsArtistProfiles": True,
                "supportsDirectories": False,
                "supportsThreadReader": False,
                "directoryKinds": [],
            },
            "urlHints": {
                "videoPathRegex": r"^/(?:video|videos|watch|view_video|clip|clips|player)/",
                "playlistPathRegex": r"^/(?:playlist|playlists|collection|collections)/",
                "entityPrefixes": ["/creators/", "/channels/", "/artists/", "/profiles/", "/users/"],
            },
            "routing": {
                "videoIdRegex": r"/(?:video|videos|watch|clip|clips)/([A-Za-z0-9_-]+)",
                "videoPathPrefixes": ["/video/", "/videos/", "/watch/", "/clip/", "/clips/"],
                "creatorPrefixes": ["/creators/", "/artists/", "/profiles/", "/users/"],
                "channelPrefixes": ["/channels/"],
            },
            "videoCards": {
                "cardSelector": card_selector,
                "titleLinkSelector": "a[href]",
                "thumbSelector": "img",
                "thumbSrcAttrs": ["data-src", "data-original", "data-lazy-src", "src"],
                "paginationSelector": 'a[rel~="next"], .pagination a, .pager a',
                "pageHrefRegex": r"(?:/([0-9]+)|[?&](?:p|page)=([0-9]+))(?:$|[?#])",
                "pageBaseZero": False,
            },
            "browse": {
                "feeds": {"latest": "/", "popular": "/"},
                "pageBaseZero": False,
                "directories": {},
            },
            "search": {
                "videosPathTemplate": search_tmpl,
                "pageBaseZero": False,
            },
            "watch": {
                "jsonLdSelector": 'script[type="application/ld+json"]',
                "titleSelector": "h1, h2",
            },
            "streamFallback": {
                "hlsRegex": r"""(https?://[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?)""",
                "hdMp4Regex": r"""(https?://[^\s"'<>]+?\.mp4(?:\?[^\s"'<>]*)?)""",
            },
        }
        return "videoPortals", descriptor, level, handle

    if is_forum:
        level, handle = _classify_deep_url_level(normalized_url, target_tree, ld_types, "forum_board")
        descriptor = {
            "id": source_id,
            "displayName": display_name,
            "baseUrl": origin,
            "domains": [clean_domain],
            "autoDiscovered": True,
            "iconKind": "forum_board",
            "catalogModes": ["albums", "videos", "posts", "recent"],
            "defaultCategory": "albums",
            "searchCategories": ["all", "profiles", "albums", "videos", "posts"],
            "capabilities": {
                "archetype": "forum_board",
                "layoutMode": "forum_index",
                "supportsComments": False,
                "supportsSourceLikes": False,
                "supportsVideosTab": False,
                "supportsPlaylists": False,
                "supportsArtistProfiles": True,
                "supportsDirectories": True,
                "supportsThreadReader": True,
                "directoryKinds": ["boards"],
            },
            "forum": {
                "indexPath": "/",
                "searchPath": search_tmpl.split("?", 1)[0] or "/search",
            },
        }
        return "forums", descriptor, level, handle

    level, handle = _classify_deep_url_level(normalized_url, target_tree, ld_types, "gallery_catalog")
    descriptor = {
        "id": source_id,
        "displayName": display_name,
        "baseUrl": origin,
        "domains": [clean_domain],
        "autoDiscovered": True,
        "iconKind": "gallery_catalog",
        "rootMode": "category_first",
        "catalogModes": ["popular", "recent", "albums"],
        "defaultCategory": "popular",
        "searchCategories": ["all", "profiles", "albums"],
        "capabilities": {
            "archetype": "gallery_catalog",
            "layoutMode": "editorial_wall",
            "supportsComments": False,
            "supportsSourceLikes": False,
            "supportsVideosTab": False,
            "supportsPlaylists": False,
            "supportsArtistProfiles": True,
            "supportsDirectories": False,
            "directoryKinds": [],
        },
        "browse": {
            "searchPathTemplate": search_tmpl,
        },
        "selectors": {
            "cardSelector": card_selector,
        },
    }
    return "catalogs", descriptor, level, handle


def _read_raw_connectors_file(path: Path) -> dict[str, list[dict[str, Any]]]:
    empty: dict[str, list[dict[str, Any]]] = {k: [] for k in _ALLOWED_BUNDLE_KEYS}
    if not path.is_file():
        return empty
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return empty
    if not isinstance(raw, dict):
        return empty
    for key in _ALLOWED_BUNDLE_KEYS:
        val = raw.get(key)
        if isinstance(val, list):
            empty[key] = [item for item in val if isinstance(item, dict)]
    return empty


def _write_raw_connectors_file(path: Path, payload: dict[str, list[dict[str, Any]]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def upsert_local_connector(bundle_key: str, descriptor: dict[str, Any]) -> dict[str, Any]:
    if bundle_key not in _ALLOWED_BUNDLE_KEYS:
        raise ValueError("invalid_connector_bundle_key")
    sid = str(descriptor.get("id") or "").strip().lower()
    if not sid:
        raise ValueError("missing_connector_id")
    path = connector_registry.get_writable_connectors_path()
    with _CONNECTOR_WRITE_LOCK:
        data = _read_raw_connectors_file(path)
        existing = [row for row in data[bundle_key] if str(row.get("id") or "").strip().lower() != sid]
        existing.append(descriptor)
        data[bundle_key] = existing
        _write_raw_connectors_file(path, data)
    connector_registry.clear_connector_cache()
    return descriptor


def list_local_connectors_summary() -> list[dict[str, Any]]:
    path = connector_registry.get_writable_connectors_path()
    data = _read_raw_connectors_file(path)
    out: list[dict[str, Any]] = []
    kind_map = {
        "catalogs": "gallery_catalog",
        "forums": "forum_board",
        "videoPortals": "video_portal",
        "imageHosts": "image_host",
    }
    for key in _ALLOWED_BUNDLE_KEYS:
        for row in data[key]:
            sid = str(row.get("id") or "").strip().lower()
            if not sid:
                continue
            out.append(
                {
                    "id": sid,
                    "displayName": str(row.get("displayName") or sid),
                    "archetype": kind_map[key],
                    "bundleKey": key,
                    "domains": list(row.get("domains") or []),
                    "origin": str(row.get("canonicalOrigin") or row.get("baseUrl") or ""),
                    "autoDiscovered": bool(row.get("autoDiscovered", False)),
                }
            )
    return out


def export_connector_bundle() -> dict[str, list[dict[str, Any]]]:
    path = connector_registry.get_writable_connectors_path()
    return _read_raw_connectors_file(path)


def import_connector_bundle(raw_payload: dict[str, Any] | bytes | str) -> dict[str, Any]:
    if isinstance(raw_payload, bytes):
        if len(raw_payload) > _MAX_IMPORT_BYTES:
            raise ValueError("bundle_too_large")
        try:
            parsed = json.loads(raw_payload.decode("utf-8"))
        except Exception as exc:
            raise ValueError("invalid_json") from exc
    elif isinstance(raw_payload, str):
        if len(raw_payload.encode("utf-8")) > _MAX_IMPORT_BYTES:
            raise ValueError("bundle_too_large")
        try:
            parsed = json.loads(raw_payload)
        except Exception as exc:
            raise ValueError("invalid_json") from exc
    elif isinstance(raw_payload, dict):
        encoded = json.dumps(raw_payload, ensure_ascii=False).encode("utf-8")
        if len(encoded) > _MAX_IMPORT_BYTES:
            raise ValueError("bundle_too_large")
        parsed = raw_payload
    else:
        raise ValueError("invalid_json")

    if not isinstance(parsed, dict):
        raise ValueError("invalid_bundle_schema")

    unknown_keys = set(parsed.keys()) - set(_ALLOWED_BUNDLE_KEYS)
    if unknown_keys:
        raise ValueError("invalid_bundle_schema")

    added_ids: list[str] = []
    path = connector_registry.get_writable_connectors_path()
    with _CONNECTOR_WRITE_LOCK:
        current = _read_raw_connectors_file(path)
        for key in _ALLOWED_BUNDLE_KEYS:
            incoming = parsed.get(key)
            if incoming is None:
                continue
            if not isinstance(incoming, list):
                raise ValueError("invalid_bundle_schema")
            by_id = {str(r.get("id") or "").strip().lower(): r for r in current[key] if r.get("id")}
            for item in incoming:
                if not isinstance(item, dict):
                    raise ValueError("invalid_bundle_schema")
                sid = str(item.get("id") or "").strip().lower()
                if not sid or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", sid):
                    raise ValueError("invalid_connector_id")
                by_id[sid] = item
                added_ids.append(sid)
            current[key] = list(by_id.values())
        if not added_ids:
            raise ValueError("empty_bundle")
        _write_raw_connectors_file(path, current)
    connector_registry.clear_connector_cache()
    return {
        "ok": True,
        "importedIds": added_ids,
        "connectors": list_local_connectors_summary(),
    }


def delete_local_connector(source_id: str) -> dict[str, Any]:
    sid = (source_id or "").strip().lower()
    path = connector_registry.get_writable_connectors_path()
    removed = False
    with _CONNECTOR_WRITE_LOCK:
        current = _read_raw_connectors_file(path)
        for key in _ALLOWED_BUNDLE_KEYS:
            before = len(current[key])
            current[key] = [r for r in current[key] if str(r.get("id") or "").strip().lower() != sid]
            if len(current[key]) != before:
                removed = True
        if removed:
            _write_raw_connectors_file(path, current)
    if removed:
        connector_registry.clear_connector_cache()
    return {
        "ok": True,
        "removed": removed,
        "sourceId": sid,
        "connectors": list_local_connectors_summary(),
    }


async def _bounded_get_html(client: httpx.AsyncClient, url: str) -> str:
    initial = urlsplit(url)
    host = (initial.hostname or "").lower().removeprefix("www.")
    for _ in range(4):
        async with client.stream("GET", url, follow_redirects=False) as resp:
            if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                candidate = urljoin(url, resp.headers["location"])
                next_url = urlsplit(candidate)
                next_host = (next_url.hostname or "").lower().removeprefix("www.")
                if (next_host, next_url.scheme, next_url.port) != (host, initial.scheme, initial.port):
                    raise ValueError("blocked_discovery_redirect")
                normalized, error = validate_discovery_url(candidate)
                if error or not normalized:
                    raise ValueError("blocked_discovery_redirect")
                url = normalized
                continue
            resp.raise_for_status()
            chunks: list[bytes] = []
            remaining = _MAX_FETCH_BYTES
            async for chunk in resp.aiter_bytes():
                chunks.append(chunk[:remaining])
                remaining -= min(len(chunk), remaining)
                if not remaining:
                    break
            return b"".join(chunks).decode("utf-8", errors="ignore")
    raise ValueError("too_many_discovery_redirects")


async def autodiscover_connector_for_url(
    raw_url: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Probe an unconfigured URL structurally and register a local connector descriptor."""
    normalized, err = validate_discovery_url(raw_url)
    if err or not normalized:
        return {"ok": False, "reason": err or "invalid_url"}

    parsed = urlsplit(normalized)
    origin_url = f"{parsed.scheme}://{parsed.netloc}/"
    need_target = parsed.path not in ("", "/") or bool(parsed.query)

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8",
    }

    root_html = ""
    target_html: str | None = None
    try:
        if transport is None and not _allow_insecure_test_origins():
            from .profile_hub_execution_runtime import PublicHTTPSHttpxTransport

            transport = PublicHTTPSHttpxTransport()
        async with httpx.AsyncClient(
            transport=transport,
            timeout=_FETCH_TIMEOUT_S,
            headers=headers,
        ) as client:
            try:
                root_html = await _bounded_get_html(client, origin_url)
            except httpx.HTTPStatusError as exc:
                # A site need not expose a home page. A pasted, public deep link
                # can still provide evidence. Do not retry access-control errors.
                if not need_target or exc.response.status_code not in (404, 405, 410):
                    raise
            if need_target:
                try:
                    target_html = await _bounded_get_html(client, normalized)
                except Exception:
                    if not root_html:
                        raise
            if not root_html and target_html:
                root_html = target_html
    except Exception:
        return {"ok": False, "reason": "unreachable_origin", "targetUrl": normalized}

    if not root_html.strip() and not (target_html or "").strip():
        return {"ok": False, "reason": "unsupported_domain", "targetUrl": normalized}
    ytdlp_ok = check_ytdlp_runtime_support(normalized)
    synthesized = synthesize_descriptor_from_html(
        normalized_url=normalized,
        root_html=root_html,
        target_html=target_html,
        ytdlp_supported=ytdlp_ok,
    )
    if synthesized is None:
        return {"ok": False, "reason": "unsupported_domain", "targetUrl": normalized}

    bundle_key, descriptor, level, suggested_handle = synthesized
    upsert_local_connector(bundle_key, descriptor)
    return {
        "ok": True,
        "autoDiscovered": True,
        "bundleKey": bundle_key,
        "descriptor": descriptor,
        "sourceId": descriptor["id"],
        "displayName": descriptor["displayName"],
        "originUrl": descriptor.get("canonicalOrigin") or descriptor.get("baseUrl") or origin_url.rstrip("/"),
        "domains": list(descriptor.get("domains") or []),
        "level": level,
        "targetUrl": normalized,
        "suggestedHandle": suggested_handle,
        "iconKind": descriptor.get("iconKind", "connector"),
    }
