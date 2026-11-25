"""Generic configuration-driven Video Portal parser & URL engine.

Zero site-specific identifiers live in this module: all hosts, routes,
CSS selectors, JSON field mappings, regexes, and fallback stream rules are
supplied by ``VideoPortalDescriptor`` loaded from connectors config.
"""
from __future__ import annotations

import html as html_lib
import json
import re
from typing import Any, Optional
from urllib.parse import urljoin, urlsplit, urlunsplit

from selectolax.lexbor import LexborHTMLParser

from .connector_registry import VideoPortalDescriptor
from .original_image_resolver import is_placeholder_media_url


_SCRIPT_ARTIFACT_RE = re.compile(
    r"(?:document\.write|<img\b|<script\b|<picture\b)",
    re.IGNORECASE,
)


def _clean_text(raw: Any) -> str:
    if raw is None:
        return ""
    text = html_lib.unescape(str(raw))
    return re.sub(r"\s+", " ", text).strip()


def _dot_get(obj: Any, path: str | None, default: Any = None) -> Any:
    """Safely navigate a dot-separated key path (e.g. 'data.user') on nested dicts."""
    if not isinstance(obj, dict) or not path:
        return default
    cur: Any = obj
    for seg in str(path).split("."):
        if isinstance(cur, dict) and seg in cur:
            cur = cur[seg]
        else:
            return default
    return cur


def _has_script_artifact(text: str) -> bool:
    if not text:
        return False
    if _SCRIPT_ARTIFACT_RE.search(text):
        return True
    if not re.search(r"[A-Za-z0-9\u00C0-\u024F]", text):
        return True
    return False


def _clean_dom_text(node, *, exclude_selectors: tuple[str, ...] = ()) -> str:
    """Extract clean text recursively from a DOM node, omitting <script>/<style>/<noscript> text."""
    if node is None:
        return ""
    excluded_tags = {"script", "style", "noscript", "template"}
    parts: list[str] = []

    def _walk(cur):
        for child in cur.iter(include_text=True):
            tag = (child.tag or "").lower()
            if tag == "-text":
                t = _clean_text(child.text())
                if t and not _has_script_artifact(t):
                    parts.append(t)
                continue
            if tag in excluded_tags:
                continue
            if exclude_selectors:
                cls = (child.attributes.get("class") or "").lower()
                if any(tok in cls for tok in exclude_selectors):
                    continue
            _walk(child)

    _walk(node)
    res = _clean_text(" ".join(parts))
    return "" if _has_script_artifact(res) else res


def _is_inside_nav_chrome(node, extra_tokens: tuple[str, ...] = ()) -> bool:
    """True when node resides in global header/nav/footer chrome rather than main page content."""
    anc = node
    tok_list = tuple(str(t).lower() for t in extra_tokens if t)
    while anc is not None:
        tag = (anc.tag or "").lower()
        if tag in ("header", "nav", "footer"):
            return True
        if tok_list:
            el_id = (anc.attributes.get("id") or "").lower()
            el_cls = (anc.attributes.get("class") or "").lower()
            if any(tok in el_id or tok in el_cls for tok in tok_list):
                return True
        anc = anc.parent
    return False


def _abs_url(raw: Any, base_url: str) -> str:
    val = str(raw or "").strip()
    if not val:
        return ""
    if val.startswith("//"):
        return "https:" + val
    return urljoin(base_url, val)


def _is_placeholder(url: str, desc: VideoPortalDescriptor) -> bool:
    if is_placeholder_media_url(url):
        return True
    extra = (desc.video_cards or {}).get("placeholderRegex")
    if isinstance(extra, str) and extra:
        try:
            if re.search(extra, url, re.IGNORECASE):
                return True
        except re.error:
            pass
    return False


_PROFILE_IMG_PLACEHOLDER_RE = re.compile(
    r"(?:^data:|1px\.|1x1|spacer|transparent\.(?:gif|png)|site_loading|loading\.(?:gif|png|webp)"
    r"|blank\.(?:gif|png|jpg)|\.svg(?:\?|$)|spinner|placeholder)",
    re.IGNORECASE,
)


def _is_profile_image_placeholder(url: str, desc: VideoPortalDescriptor) -> bool:
    raw = (url or "").strip().lower()
    if not raw or raw.startswith(("javascript:", "mailto:", "#", "about:", "blob:", "data:")):
        return True
    if _PROFILE_IMG_PLACEHOLDER_RE.search(raw):
        return True
    extra = (desc.profile or {}).get("placeholderRegex")
    if isinstance(extra, str) and extra:
        try:
            if re.search(extra, url, re.IGNORECASE):
                return True
        except re.error:
            pass
    return False


def parse_compact_count(raw: Any) -> Optional[int]:
    """Parse counts such as ``314,811``, ``3.504.018``, ``4 123 456``, ``548.3k``, or ``1,2M`` into an int."""
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return max(0, int(raw))
    text = _clean_text(raw)
    if not text:
        return None
    # Multi-group thousands integer (e.g. "25.406.458.344", "3,504,018", "3 504 018")
    th_match = re.search(r"\b(\d{1,3}(?:[.,\s\u00a0\u202f]\d{3})+)\b(?!\s*[KkMmBb]\b)", text)
    if th_match:
        digits = re.sub(r"\D", "", th_match.group(1))
        if digits:
            return max(0, int(digits))
    norm = re.sub(r"(?<=\d)[\s\u00a0\u202f]+(?=\d)", "", text)
    m = re.search(r"([0-9]+(?:[.,][0-9]+)?)\s*([KkMmBb])?", norm)
    if not m:
        return None
    num_str = m.group(1)
    suffix = (m.group(2) or "").lower()
    if "," in num_str and "." not in num_str:
        if suffix or len(num_str.split(",")[-1]) != 3:
            num_str = num_str.replace(",", ".")
        else:
            num_str = num_str.replace(",", "")
    else:
        num_str = num_str.replace(",", "")
    val = float(num_str)
    if suffix == "k":
        val *= 1_000
    elif suffix == "m":
        val *= 1_000_000
    elif suffix == "b":
        val *= 1_000_000_000
    return max(0, int(round(val)))


def normalize_portal_duration(raw: Any) -> str:
    """Normalize human or clock durations (e.g. '14 min', '1 h 05 min', '05:12') to clock format."""
    if raw is None or isinstance(raw, bool):
        return ""
    if isinstance(raw, (int, float)):
        total = max(0, int(raw))
        hrs, rem = divmod(total, 3600)
        mins, secs = divmod(rem, 60)
        return f"{hrs}:{mins:02d}:{secs:02d}" if hrs else f"{mins}:{secs:02d}"

    text = _clean_text(raw)
    if not text:
        return ""

    # Colon format (HH:MM:SS or MM:SS)
    clock_match = re.fullmatch(r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})", text)
    if clock_match:
        h = int(clock_match.group(1) or 0)
        m = int(clock_match.group(2))
        s = int(clock_match.group(3))
        if h > 0:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"

    # ISO-8601 duration PT1H05M10S
    iso_match = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", text, re.IGNORECASE)
    if iso_match and any(iso_match.groups()):
        h = int(iso_match.group(1) or 0)
        m = int(iso_match.group(2) or 0)
        s = int(iso_match.group(3) or 0)
        return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"

    # Worded durations: "1 h 05 min", "14 min", "45 sec"
    h_match = re.search(r"(\d+)\s*(?:h|hr|hrs|hour|hours)\b", text, re.IGNORECASE)
    m_match = re.search(r"(\d+)\s*(?:m|min|mins|minute|minutes)\b", text, re.IGNORECASE)
    s_match = re.search(r"(\d+)\s*(?:s|sec|secs|second|seconds)\b", text, re.IGNORECASE)
    if h_match or m_match or s_match:
        h = int(h_match.group(1)) if h_match else 0
        m = int(m_match.group(1)) if m_match else 0
        s = int(s_match.group(1)) if s_match else 0
        if h > 0:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"

    return text


def canonicalize_portal_url(url: str, desc: VideoPortalDescriptor) -> str:
    """Normalize mobile/AMP/redirect paths and resolve relative portal URLs to canonicalOrigin."""
    raw = str(url or "").strip()
    if not raw:
        return ""
    canonical_origin = (desc.canonical_origin or f"https://{desc.domains[0]}").rstrip("/")
    canonical_parsed = urlsplit(canonical_origin)
    joined = _abs_url(raw, canonical_origin + "/")
    parsed = urlsplit(joined)
    scheme = canonical_parsed.scheme or "https"
    host = (parsed.hostname or "").lower()

    # Strip configured mobile subdomains (e.g., m., mobile.) to canonical origin host
    mobile_subs = [str(s).strip().lower() for s in (desc.routing or {}).get("mobileSubdomains", []) if s]
    for sub in mobile_subs:
        prefix = f"{sub}."
        if host.startswith(prefix):
            host = host[len(prefix):]
            break
    if desc.matches_host(host) and canonical_parsed.netloc:
        netloc = canonical_parsed.netloc
    else:
        netloc = parsed.netloc or canonical_parsed.netloc

    path = parsed.path or "/"
    for strip_prefix in (desc.routing or {}).get("stripPrefixes", []) or []:
        sp = str(strip_prefix)
        if sp and path.startswith(sp):
            rest = path[len(sp):]
            path = rest if rest.startswith("/") else "/" + rest

    for rule in (desc.routing or {}).get("redirectRules", []) or []:
        if not isinstance(rule, dict):
            continue
        pat = rule.get("pattern")
        tmpl = rule.get("template")
        if isinstance(pat, str) and isinstance(tmpl, str):
            try:
                rewritten, count = re.subn(pat, tmpl, path, count=1)
                if count > 0:
                    path = rewritten if rewritten.startswith("/") else "/" + rewritten
                    break
            except re.error:
                continue

    if path != "/":
        path = re.sub(r"/{2,}", "/", path).rstrip("/") or "/"
    return urlunsplit((scheme, netloc, path, parsed.query, ""))


def extract_portal_video_id(url_or_html: str, desc: VideoPortalDescriptor) -> Optional[str]:
    """Extract canonical video ID from URL or HTML using descriptor videoIdRegex."""
    text = str(url_or_html or "")
    if not text:
        return None
    pattern = (desc.routing or {}).get("videoIdRegex")
    if isinstance(pattern, str) and pattern:
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            for grp in m.groups():
                if grp:
                    return str(grp)
            return m.group(0)
    return None


def _matches_prefix(path_lower: str, prefixes: Any) -> bool:
    for p in prefixes or []:
        ps = str(p).lower()
        if not ps:
            continue
        if path_lower.startswith(ps):
            return True
        if ps.endswith("/") and path_lower == ps.rstrip("/"):
            return True
    return False


def _is_reserved_root(path_lower: str, desc: VideoPortalDescriptor) -> bool:
    if path_lower in ("", "/"):
        return True
    for raw_pref in (desc.routing or {}).get("reservedRootPrefixes", []) or []:
        pref = str(raw_pref).lower()
        if not pref:
            continue
        if path_lower == pref or path_lower.startswith(pref + "/") or (pref.endswith(".") and path_lower.startswith(pref)):
            return True
    return False


def detect_portal_entity_kind(url: str, desc: VideoPortalDescriptor) -> str:
    """Classify a portal URL into video, playlist, category, tag, channel, creator, directory, or unknown."""
    canon = canonicalize_portal_url(url, desc)
    if not canon:
        return "unknown"
    parsed = urlsplit(canon)
    path = parsed.path or "/"
    path_lower = path.lower()
    routing = desc.routing or {}

    if _matches_prefix(path_lower, routing.get("videoPathPrefixes")):
        return "video"
    if _matches_prefix(path_lower, routing.get("playlistPrefixes")):
        return "playlist"
    if _matches_prefix(path_lower, routing.get("categoryPrefixes")):
        return "category"
    if _matches_prefix(path_lower, routing.get("tagPrefixes")):
        return "tag"
    if _matches_prefix(path_lower, routing.get("channelPrefixes")):
        return "channel"
    if _matches_prefix(path_lower, routing.get("creatorPrefixes")):
        return "creator"

    for dp in routing.get("directoryPrefixes", []) or []:
        dpl = str(dp).lower().rstrip("/")
        if dpl and (path_lower == dpl or path_lower.startswith(dpl + "/")):
            return "directory"

    vid_regex = routing.get("videoIdRegex")
    if isinstance(vid_regex, str) and vid_regex and re.search(vid_regex, path, re.IGNORECASE):
        return "video"

    if parsed.query:
        return "unknown"

    root_regex = routing.get("rootSlugRegex")
    if isinstance(root_regex, str) and root_regex and not _is_reserved_root(path_lower, desc):
        if re.match(root_regex, path):
            return str(routing.get("rootSlugEntityKind") or "channel")
    return "unknown"


def allows_portal_profile_path(path: str, desc: VideoPortalDescriptor) -> bool:
    """True if path represents a browsable entity (creator, channel, category, or tag)."""
    if not path or "?" in path:
        return False
    base = (desc.canonical_origin or f"https://{desc.domains[0]}").rstrip("/")
    kind = detect_portal_entity_kind(base + (path if path.startswith("/") else "/" + path), desc)
    return kind in ("creator", "channel", "category", "tag")


def normalize_portal_entity_base_url(url: str, desc: VideoPortalDescriptor) -> str:
    """Strip tab/sort/pagination suffixes from creator, channel, category, or tag URLs."""
    canon = canonicalize_portal_url(url, desc)
    if not canon:
        return ""
    parsed = urlsplit(canon)
    path = parsed.path or "/"
    kind = detect_portal_entity_kind(canon, desc)
    routing = desc.routing or {}
    tabs = [re.escape(str(t).strip("/")) for t in (routing.get("stripTrailingTabs") or []) if t]

    if kind in ("creator", "channel") and tabs:
        tab_alt = "|".join(tabs)
        path = re.sub(rf"/(?:{tab_alt})(?:/.*)?$", "", path, flags=re.IGNORECASE)
    elif kind in ("category", "tag"):
        # Strip trailing numeric pagination (/1) or sort segments if trailing digits
        path = re.sub(r"/\d+$", "", path)

    path = re.sub(r"/\d+$", "", path) or "/"
    return urlunsplit((parsed.scheme, parsed.netloc, path.rstrip("/") or "/", "", ""))


def _first_node_attr(node, attrs: list[str] | tuple[str, ...]) -> Optional[str]:
    if node is None:
        return None
    for attr in attrs:
        val = node.attributes.get(attr)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _pick_image_url(root_node, selector: str, attrs: list[str], base_url: str, desc: VideoPortalDescriptor) -> str:
    if root_node is None:
        return ""
    img = root_node.css_first(selector) if selector else root_node
    if img is None:
        return ""
    for attr in attrs:
        raw = img.attributes.get(attr)
        if isinstance(raw, str) and raw.strip():
            resolved = _abs_url(raw.strip(), base_url)
            if resolved and not _is_placeholder(resolved, desc):
                return resolved
    return ""


def _pick_preview_video_url(card, attrs: list[str], base_url: str) -> str:
    if card is None or not attrs:
        return ""
    candidates = [card]
    img = card.css_first("img")
    if img is not None:
        candidates.append(img)
    thumb_wrap = card.css_first(".thumb, .thumb-inside")
    if thumb_wrap is not None:
        candidates.append(thumb_wrap)
    for node in candidates:
        val = _first_node_attr(node, attrs)
        if val:
            return _abs_url(val, base_url)
    return ""


def extract_portal_max_page(html: str, desc: VideoPortalDescriptor) -> int:
    """Return highest 1-based page number discovered in pagination links."""
    if not html:
        return 1
    vc = desc.video_cards or {}
    sel = vc.get("paginationSelector") or ".pagination a"
    href_re = vc.get("pageHrefRegex") or r"(?:/([0-9]+)|[?&]p=([0-9]+))(?:$|[?#])"
    zero_based = bool(vc.get("pageBaseZero", True))

    parser = LexborHTMLParser(html)
    max_page = 1
    for a in parser.css(sel):
        href = a.attributes.get("href") or ""
        m = re.search(href_re, href)
        if m:
            raw_num = next((g for g in m.groups() if g), None)
            if raw_num is not None:
                num = int(raw_num) + (1 if zero_based else 0)
                if num > max_page:
                    max_page = num
        else:
            txt = _clean_text(a.text())
            if txt.isdigit():
                max_page = max(max_page, int(txt))
    return max_page


def parse_portal_video_cards(html: str, base_url: str, desc: VideoPortalDescriptor) -> list[dict[str, Any]]:
    """Extract normalized video card dictionaries from an HTML video grid."""
    if not html:
        return []
    vc = desc.video_cards or {}
    card_sel = vc.get("cardSelector") or "div.portal-card"
    id_attr = vc.get("videoIdAttr") or "data-id"
    eid_attr = vc.get("videoEidAttr") or "data-eid"
    title_sel = vc.get("titleLinkSelector") or "p.title a"
    thumb_sel = vc.get("thumbSelector") or "img"
    thumb_attrs = list(vc.get("thumbSrcAttrs") or ["data-src", "src"])
    preview_attrs = list(vc.get("previewVideoAttrs") or ["data-pvv", "data-mediabook"])
    dur_sel = vc.get("durationSelector") or "span.duration"
    qual_sel = vc.get("qualitySelector") or "span.video-hd-mark"
    author_link_sel = vc.get("authorLinkSelector") or "p.metadata a"
    author_name_sel = vc.get("authorNameSelector") or "span.name"
    views_sel = vc.get("viewsSelector") or "p.metadata"
    views_re = vc.get("viewsRegex") or r"([0-9]+(?:\.[0-9]+)?\s*[KkMm]?\s*Views?)"

    parser = LexborHTMLParser(html)
    results: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    for card in parser.css(card_sel):
        title_node = card.css_first(title_sel) or card.css_first("a[href]")
        href = (title_node.attributes.get("href") if title_node else None) or ""
        if not href:
            thumb_link = card.css_first("a[href]")
            href = (thumb_link.attributes.get("href") if thumb_link else None) or ""
        if not href:
            continue

        canon_url = canonicalize_portal_url(href, desc)
        if not canon_url or canon_url in seen_urls:
            continue
        seen_urls.add(canon_url)

        vid_eid = (card.attributes.get(eid_attr) or "").strip() if eid_attr else ""
        vid_num = (card.attributes.get(id_attr) or "").strip() if id_attr else ""
        vid_id = vid_eid or extract_portal_video_id(canon_url, desc) or vid_num

        title = ""
        if title_node is not None:
            title = _clean_text(title_node.attributes.get("title") or title_node.text())

        thumb_url = _pick_image_url(card, thumb_sel, thumb_attrs, base_url, desc)
        preview_url = _pick_preview_video_url(card, preview_attrs, base_url)

        dur_node = card.css_first(dur_sel) if dur_sel else None
        duration = normalize_portal_duration(dur_node.text() if dur_node else "")

        qual_node = card.css_first(qual_sel) if qual_sel else None
        resolution = _clean_text(qual_node.text()) if qual_node else ""

        author_node = card.css_first(author_link_sel) if author_link_sel else None
        author_name = ""
        author_url = ""
        if author_node is not None:
            name_child = author_node.css_first(author_name_sel) if author_name_sel else None
            author_name = _clean_text(name_child.text() if name_child else author_node.text())
            raw_ahref = author_node.attributes.get("href") or ""
            if raw_ahref:
                author_url = canonicalize_portal_url(raw_ahref, desc)

        views_node = card.css_first(views_sel) if views_sel else None
        views = ""
        if views_node is not None:
            vtext = _clean_text(views_node.text(separator=" "))
            vm = re.search(views_re, vtext, re.IGNORECASE) if views_re else None
            if vm:
                views = _clean_text(vm.group(1) if vm.groups() else vm.group(0))

        results.append({
            "id": str(vid_id or canon_url),
            "numericId": vid_num,
            "title": title,
            "thumbnailUrl": thumb_url,
            "previewVideoUrl": preview_url,
            "duration": duration,
            "resolution": resolution,
            "views": views,
            "timeAgo": "",
            "authorName": author_name,
            "authorUrl": author_url,
            "type": "video",
            "originalUrl": canon_url,
            "streamUrl": f"/api/proxy-video-stream?url={canon_url}",
        })

    return results


def parse_portal_video_json_items(
    payload: Any,
    base_url: str,
    desc: VideoPortalDescriptor,
    *,
    creator_name: str = "",
    creator_url: str = "",
    creator_avatar: str = "",
) -> list[dict[str, Any]]:
    """Parse profile AJAX JSON arrays or related-video JS arrays into normalized video items."""
    prof = desc.profile or {}
    videos_key = prof.get("videosJsonKey") or "videos"
    if isinstance(payload, dict):
        raw_list = payload.get(videos_key)
    elif isinstance(payload, list):
        raw_list = payload
    else:
        raw_list = None
    if not isinstance(raw_list, list):
        return []

    fields = prof.get("jsonFields") or {}
    f_id = fields.get("id", "id")
    f_eid = fields.get("eid", "eid")
    f_url = fields.get("url", "u")
    f_title = fields.get("title", "tf")
    f_fallback_title = fields.get("fallbackTitle", "t")
    f_thumb = fields.get("thumb", "i")
    f_fallback_thumb = fields.get("fallbackThumb", "il")
    f_preview = fields.get("previewVideo", "ipu")
    f_duration = fields.get("duration", "d")
    f_views = fields.get("views", "n")
    f_hd = fields.get("hdFlag", "h")
    f_res = fields.get("resolutionTag", "hm")
    f_author_name = fields.get("authorName", "pn")
    f_author_url = fields.get("authorUrl", "pu")
    f_is_channel = fields.get("isChannel", "ch")

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in raw_list:
        if not isinstance(row, dict):
            continue
        raw_u = row.get(f_url) or ""
        canon_url = canonicalize_portal_url(str(raw_u), desc)
        if not canon_url or canon_url in seen:
            continue
        seen.add(canon_url)

        eid = str(row.get(f_eid) or "").strip()
        num_id = str(row.get(f_id) or "").strip()
        vid_id = eid or extract_portal_video_id(canon_url, desc) or num_id

        title = _clean_text(row.get(f_title) or row.get(f_fallback_title) or "")
        thumb = ""
        for tkey in (f_thumb, f_fallback_thumb):
            raw_t = row.get(tkey)
            if isinstance(raw_t, str) and raw_t.strip():
                candidate = _abs_url(raw_t.strip(), base_url)
                if candidate and not _is_placeholder(candidate, desc):
                    thumb = candidate
                    break

        raw_prev = row.get(f_preview)
        preview = _abs_url(raw_prev, base_url) if isinstance(raw_prev, str) and raw_prev.strip() else ""
        duration = normalize_portal_duration(row.get(f_duration))

        raw_res = row.get(f_res)
        resolution = _clean_text(raw_res) if isinstance(raw_res, str) and raw_res.strip() else ""
        if not resolution:
            hp_flag = row.get("hp")
            hd_flag = row.get(f_hd)
            if hp_flag == 1 and raw_res == 1:
                resolution = "1080p"
            elif hd_flag or raw_res == 1:
                resolution = "HD"

        raw_views = row.get(f_views)
        views = _clean_text(raw_views) if raw_views not in (None, "") else ""

        f_time = fields.get("uploadTime", "ut")
        f_rating = fields.get("rating", "r")
        time_ago = _clean_text(row.get(f_time)) if isinstance(row.get(f_time), str) else ""
        rating_pct = _clean_text(row.get(f_rating)) if isinstance(row.get(f_rating), str) else ""

        a_name = _clean_text(row.get(f_author_name) or creator_name)
        raw_au = row.get(f_author_url)
        a_url = canonicalize_portal_url(str(raw_au), desc) if raw_au else creator_url

        entry: dict[str, Any] = {
            "id": str(vid_id or canon_url),
            "numericId": num_id,
            "title": title,
            "thumbnailUrl": thumb,
            "previewVideoUrl": preview,
            "duration": duration,
            "resolution": resolution,
            "views": views,
            "timeAgo": time_ago,
            "rating": rating_pct,
            "authorName": a_name,
            "authorUrl": a_url,
            "isChannel": bool(row.get(f_is_channel)),
            "type": "video",
            "originalUrl": canon_url,
            "streamUrl": f"/api/proxy-video-stream?url={canon_url}",
        }
        if creator_avatar:
            entry["authorAvatarUrl"] = creator_avatar
        items.append(entry)
    return items


def _first_selector_text(parser: LexborHTMLParser, selectors: list[str] | tuple[str, ...]) -> str:
    for sel in selectors:
        node = parser.css_first(sel)
        if node is not None:
            txt = _clean_dom_text(node)
            if txt:
                return txt
    return ""


def _first_selector_image(
    parser: LexborHTMLParser,
    selectors: list[str] | tuple[str, ...],
    base_url: str,
    desc: VideoPortalDescriptor,
) -> str:
    for sel in selectors:
        node = parser.css_first(sel)
        if node is None:
            continue
        if node.tag == "meta":
            raw = node.attributes.get("content") or ""
        else:
            raw = _first_node_attr(node, ["data-src", "src"]) or ""
        if raw:
            resolved = _abs_url(raw, base_url)
            if resolved and not _is_profile_image_placeholder(resolved, desc):
                return resolved
    return ""


def _extract_scoped_field_text(parser: LexborHTMLParser, selector: str) -> str:
    if not selector:
        return ""
    node = parser.css_first(selector)
    if node is None:
        return ""
    txt = _clean_dom_text(node)
    if ":" in txt:
        head, after = txt.split(":", 1)
        if len(head) <= 28:
            return _clean_text(after)
    return txt


def parse_portal_profile_root(html: str, final_url: str, desc: VideoPortalDescriptor) -> dict[str, Any]:
    """Extract clean profile/channel/category/tag identity, structured portalInfo, stats, and relations purely from config."""
    prof = desc.profile or {}
    parser = LexborHTMLParser(html or "")
    canon_entity = normalize_portal_entity_base_url(final_url, desc)
    entity_kind = detect_portal_entity_kind(canon_entity, desc)
    exclude_chrome = tuple(prof.get("excludeChromeTokens") or ())

    conf_data: dict[str, Any] = {}
    conf_re = prof.get("confRegex")
    if isinstance(conf_re, str) and conf_re and html:
        cm = re.search(conf_re, html, re.DOTALL)
        if cm:
            try:
                conf_data = json.loads(cm.group(1))
            except Exception:
                conf_data = {}

    cpaths = prof.get("confPaths") if isinstance(prof.get("confPaths"), dict) else {}
    conf_user = _dot_get(conf_data, cpaths.get("userObject"), {})
    if not isinstance(conf_user, dict):
        conf_user = {}

    if cpaths.get("isChannel") and _dot_get(conf_user, cpaths["isChannel"]) is True:
        entity_kind = "channel"
    elif cpaths.get("isCreator") and _dot_get(conf_user, cpaths["isCreator"]) is True and entity_kind not in ("category", "tag"):
        entity_kind = "creator"

    raw_ajax_url = str(_dot_get(conf_user, cpaths.get("profileUrl"), "") or "").strip()
    ajax_base_url = normalize_portal_entity_base_url(canonicalize_portal_url(raw_ajax_url, desc), desc) if raw_ajax_url else ""

    name = _clean_text(_dot_get(conf_user, cpaths.get("displayName"), ""))
    topic_total_results: Optional[int] = None
    if not name and entity_kind in ("category", "tag"):
        heading_sels = list(prof.get("topicHeadingSelectors") or prof.get("nameSelectors") or ["h2", "h1"])
        for hsel in heading_sels:
            h_node = parser.css_first(hsel)
            if h_node is not None and not _is_inside_nav_chrome(h_node, exclude_chrome):
                raw_h = _clean_dom_text(h_node)
                res_match = re.search(r"\(([0-9][0-9,.]*)\s+results?\)", raw_h, re.IGNORECASE)
                if res_match:
                    topic_total_results = parse_compact_count(res_match.group(1))
                quoted = re.search(r"[«\"]([^»\"]+)[»\"]", raw_h)
                if quoted:
                    name = _clean_text(quoted.group(1))
                elif raw_h:
                    name = re.sub(r"\s*\([0-9,.]+\s+results?\)\s*(?:Report)?\s*$", "", raw_h, flags=re.IGNORECASE).strip()
                if name:
                    break

    name_excludes = tuple(prof.get("nameExcludeClasses") or ())
    if not name:
        name_sels = list(prof.get("nameSelectors") or [".portal-title .name", ".portal-title", "h1", "h2"])
        for sel in name_sels:
            node = parser.css_first(sel)
            if node is not None and not _is_inside_nav_chrome(node, exclude_chrome):
                cand = _clean_dom_text(node, exclude_selectors=name_excludes)
                if cand:
                    name = cand
                    break

    if not name:
        title_node = parser.css_first("title")
        if title_node:
            name = _clean_text(title_node.text()).split(" - ")[0].strip()

    avatar_url = ""
    raw_conf_pic = str(
        _dot_get(conf_user, cpaths.get("avatarUrl"), "")
        or _dot_get(conf_user, cpaths.get("avatarThumbUrl"), "")
        or ""
    ).strip()
    if raw_conf_pic:
        cand_av = _abs_url(raw_conf_pic, final_url)
        if cand_av and not _is_profile_image_placeholder(cand_av, desc):
            avatar_url = cand_av
    if not avatar_url:
        avatar_url = _first_selector_image(
            parser,
            prof.get("avatarSelectors") or [".portal-avatar img", "meta[property='og:image']"],
            final_url,
            desc,
        )

    banner_url = _first_selector_image(
        parser,
        prof.get("bannerSelectors") or [".portal-banner img"],
        final_url,
        desc,
    )

    website_url = ""
    for wsel in (prof.get("websiteSelectors") or []):
        wn = parser.css_first(wsel)
        if wn is None:
            continue
        whref = (wn.attributes.get("href") or "").strip()
        if whref.startswith(("http://", "https://")):
            whost = (urlsplit(whref).hostname or "").lower()
            if whost and not desc.matches_host(whost):
                website_url = whref
                break

    bio = _first_selector_text(
        parser,
        prof.get("bioSelectors") or [".portal-bio", ".portal-about p"],
    )

    stats_sel = prof.get("statsContainerSelector") or ".portal-about"
    stats_node = parser.css_first(stats_sel)
    stats_text = _clean_dom_text(stats_node) if stats_node else ""

    field_sels = prof.get("fieldSelectors") if isinstance(prof.get("fieldSelectors"), dict) else {}
    subs_count = parse_compact_count(_extract_scoped_field_text(parser, str(field_sels.get("subscribers") or "")))
    if subs_count is None:
        subs_re = prof.get("subscribersRegex")
        if isinstance(subs_re, str) and subs_re and stats_text:
            sm = re.search(subs_re, stats_text, re.IGNORECASE)
            if sm:
                subs_count = parse_compact_count(sm.group(1))
    if subs_count is None and prof.get("headerSubsSelector"):
        hdr_sub = parser.css_first(str(prof["headerSubsSelector"]))
        if hdr_sub is not None:
            subs_count = parse_compact_count(hdr_sub.text())

    views_count = parse_compact_count(_extract_scoped_field_text(parser, str(field_sels.get("views") or "")))
    if views_count is None:
        views_re = prof.get("totalViewsRegex")
        if isinstance(views_re, str) and views_re and stats_text:
            vm = re.search(views_re, stats_text, re.IGNORECASE)
            if vm:
                views_count = parse_compact_count(vm.group(1))

    # Structured portal info dictionary resolved via confPaths & fieldSelectors
    stats_obj = _dot_get(conf_data, cpaths.get("statsObject"), {})
    free_map = _dot_get(stats_obj, cpaths.get("freeStatsMap"), {}) if isinstance(stats_obj, dict) else {}
    prem_map = _dot_get(stats_obj, cpaths.get("premiumStatsMap"), {}) if isinstance(stats_obj, dict) else {}
    total_free_videos = sum(int(v) for v in free_map.values() if isinstance(v, (int, float)) and v > 0) if isinstance(free_map, dict) else None
    total_prem_videos = sum(int(v) for v in prem_map.values() if isinstance(v, (int, float)) and v > 0) if isinstance(prem_map, dict) else None

    has_shorts = bool(_dot_get(conf_user, cpaths.get("hasShorts"), True)) if cpaths.get("hasShorts") else True
    total_shorts = None
    shorts_val = _dot_get(conf_user, cpaths.get("shortsCount"))
    if isinstance(shorts_val, (int, float)) and shorts_val > 0:
        total_shorts = int(shorts_val)

    vote_obj = _dot_get(conf_data, cpaths.get("voteObject"), {})
    rating_pct = ""
    rating_votes = None
    if isinstance(vote_obj, dict):
        rating_pct = _clean_text(_dot_get(vote_obj, cpaths.get("ratingPercent"), ""))
        if not rating_pct and cpaths.get("ratingFallback"):
            rv = _dot_get(vote_obj, cpaths["ratingFallback"])
            if rv is not None:
                rating_pct = f"{rv}%"
        rating_votes = parse_compact_count(_dot_get(vote_obj, cpaths.get("ratingVotes")))

    portal_info: dict[str, Any] = {}
    for pkey in ("country", "languages", "gender", "age", "aliases", "joinedAt", "lastActive", "profileHits"):
        val = _extract_scoped_field_text(parser, str(field_sels.get(pkey) or ""))
        if val:
            portal_info[pkey] = val
    if website_url:
        portal_info["website"] = website_url
    if rating_pct:
        portal_info["ratingPercent"] = rating_pct
    if rating_votes is not None:
        portal_info["ratingVotes"] = rating_votes
    if total_free_videos:
        portal_info["totalPublicVideos"] = total_free_videos
    if total_prem_videos:
        portal_info["totalPremiumVideos"] = total_prem_videos
    if total_shorts is not None:
        portal_info["totalShorts"] = total_shorts
    if has_shorts:
        portal_info["hasShorts"] = True
    if ajax_base_url:
        portal_info["ajaxBaseUrl"] = ajax_base_url

    verif_sel = str(prof.get("verifiedSelector") or ".verified, .icon-verified")
    verified = bool(
        (cpaths.get("isVerified") and _dot_get(conf_user, cpaths["isVerified"]))
        or (prof.get("verifiedScopeSelector") and parser.css_first(f"{prof['verifiedScopeSelector']} {verif_sel}") is not None)
        or (not prof.get("verifiedScopeSelector") and parser.css_first(verif_sel) is not None and entity_kind in ("creator", "channel"))
    )

    colls = prof.get("collections") if isinstance(prof.get("collections"), dict) else {}

    # Performers / Collaborators
    worked_json_by_name: dict[str, dict[str, Any]] = {}
    for wp_key in (cpaths.get("performersFree"), cpaths.get("performersPaid")):
        raw_list = _dot_get(conf_data, wp_key, []) if wp_key else []
        if not isinstance(raw_list, list):
            continue
        name_k = cpaths.get("performerNameKey") or "displayName"
        cnt_k = cpaths.get("performerCountKey") or "nbVideos"
        gen_k = cpaths.get("performerGenderKey") or "gender"
        for wrow in raw_list:
            if not isinstance(wrow, dict):
                continue
            wname = _clean_text(wrow.get(name_k))
            if not wname:
                continue
            k = wname.lower()
            cnt = parse_compact_count(wrow.get(cnt_k)) or 0
            prev = worked_json_by_name.get(k)
            if prev is None or cnt > (prev.get("count") or 0):
                worked_json_by_name[k] = {
                    "name": wname,
                    "kind": "creator",
                    "gender": _clean_text(wrow.get(gen_k)),
                    "count": cnt,
                }

    featured_performers: list[dict[str, Any]] = []
    seen_perf_urls: set[str] = set()
    perf_sel = str(colls.get("performersSelector") or "")
    if perf_sel:
        for a in parser.css(perf_sel):
            href = a.attributes.get("href") or ""
            pname = _clean_dom_text(a)
            if not href or not pname:
                continue
            purl = normalize_portal_entity_base_url(canonicalize_portal_url(href, desc), desc)
            if not purl or purl == canon_entity or purl in seen_perf_urls:
                continue
            seen_perf_urls.add(purl)
            jmeta = worked_json_by_name.get(pname.lower()) or {}
            detected_k = detect_portal_entity_kind(purl, desc)
            entry_p: dict[str, Any] = {
                "name": pname,
                "url": purl,
                "kind": detected_k if detected_k != "unknown" else "creator",
            }
            if jmeta.get("count"):
                entry_p["count"] = jmeta["count"]
            if jmeta.get("gender"):
                entry_p["gender"] = jmeta["gender"]
            featured_performers.append(entry_p)

    # Affiliated Channels
    affiliated_channels: list[dict[str, Any]] = []
    seen_aff: set[str] = set()
    aff_sel = str(colls.get("affiliatedCardSelector") or "")
    if aff_sel:
        aff_title_sel = str(colls.get("affiliatedTitleSelector") or ".profile-name, p.title, span.name")
        dir_rules = (desc.browse or {}).get("directories") or {}
        chan_rule = dict(dir_rules.get("channels")) if isinstance(dir_rules.get("channels"), dict) else {}
        if colls.get("affiliatedScriptImageRegex"):
            chan_rule["scriptImageRegex"] = colls["affiliatedScriptImageRegex"]
        for card in parser.css(aff_sel):
            links = card.css("a[href]")
            ch_url = ""
            ch_name = ""
            for lnk in links:
                href = (lnk.attributes.get("href") or "").strip()
                if not ch_url and href:
                    ch_url = normalize_portal_entity_base_url(canonicalize_portal_url(href, desc), desc)
                t = _clean_dom_text(lnk)
                if t and not ch_name:
                    ch_name = t
            if not ch_name:
                t_node = card.css_first(aff_title_sel)
                ch_name = _clean_dom_text(t_node)
            if not ch_url or not ch_name or ch_url == canon_entity or ch_url in seen_aff:
                continue
            seen_aff.add(ch_url)
            ch_thumb = _extract_image_from_directory_card(card, chan_rule, final_url, desc)
            aff_entry: dict[str, Any] = {"name": ch_name, "url": ch_url, "kind": "channel"}
            if ch_thumb:
                aff_entry["thumbnailUrl"] = ch_thumb
            affiliated_channels.append(aff_entry)

    # Interests / Frequent Tags (links OR comma-separated tag text elements)
    interests: list[dict[str, Any]] = []
    seen_int: set[str] = set()
    int_sel = str(colls.get("interestsSelector") or "")
    if int_sel:
        for node in parser.css(int_sel):
            href = (node.attributes.get("href") or "").strip() if node.tag == "a" else ""
            raw_t = _clean_dom_text(node)
            if not raw_t:
                continue
            if node.tag != "a" and not href:
                for piece in raw_t.split(","):
                    pname = _clean_text(piece)
                    if not pname or pname.lower() in seen_int:
                        continue
                    seen_int.add(pname.lower())
                    interests.append({"name": pname, "kind": "tag"})
                continue
            turl = normalize_portal_entity_base_url(canonicalize_portal_url(href, desc), desc)
            if not turl or turl in seen_int:
                continue
            seen_int.add(turl)
            cnt_m = re.search(r"^(.*?)\s*\((\d+)\)\s*$", raw_t)
            item_i: dict[str, Any] = {"name": cnt_m.group(1).strip() if cnt_m else raw_t, "url": turl, "kind": "tag"}
            if cnt_m:
                item_i["count"] = int(cnt_m.group(2))
            interests.append(item_i)

    # Curated clean relatedEntities
    related_entities: list[dict[str, Any]] = []
    seen_rel: set[str] = set()
    for item_list, max_take in ((affiliated_channels, 12), (featured_performers, 16)):
        for it in item_list[:max_take]:
            u = it.get("url") or ""
            if u and u not in seen_rel:
                seen_rel.add(u)
                related_entities.append({k: v for k, v in it.items() if k in ("name", "url", "kind", "count", "thumbnailUrl")})

    if not related_entities:
        rel_sel = prof.get("relatedLinksSelector") or ".portal-about a[href]"
        for a in parser.css(rel_sel):
            href = a.attributes.get("href") or ""
            if not href:
                continue
            rel_url = normalize_portal_entity_base_url(href, desc)
            rel_kind = detect_portal_entity_kind(rel_url, desc)
            if not rel_url or rel_url == canon_entity or rel_url in seen_rel:
                continue
            if rel_kind not in ("creator", "channel", "category", "tag"):
                continue
            rel_name = _clean_dom_text(a)
            if not rel_name:
                continue
            seen_rel.add(rel_url)
            related_entities.append({"name": rel_name, "url": rel_url, "kind": rel_kind})
            if len(related_entities) >= 20:
                break

    return {
        "name": name,
        "avatarUrl": avatar_url,
        "bannerUrl": banner_url,
        "bio": bio,
        "entityKind": entity_kind,
        "verified": verified,
        "canonicalUrl": canon_entity,
        "ajaxBaseUrl": ajax_base_url or canon_entity,
        "subscribersCount": subs_count,
        "totalViewsCount": views_count,
        "topicTotalResults": topic_total_results,
        "portalInfo": portal_info,
        "featuredPerformers": featured_performers,
        "affiliatedChannels": affiliated_channels,
        "interests": interests,
        "relatedEntities": related_entities,
        "conf": conf_data,
    }


def extract_portal_profile_audience(
    html: str,
    final_url: str,
    desc: VideoPortalDescriptor,
) -> tuple[str | None, str | None]:
    """Extract normalized audience label from a configured video portal profile page."""
    from .profile_hub_watch_sources import format_audience_label

    parsed = parse_portal_profile_root(html, final_url, desc)
    subs_count = parsed.get("subscribersCount")
    if subs_count is not None:
        return format_audience_label(subs_count, "subscribers")
    return None, None


def parse_portal_albums(html: str, base_url: str, desc: VideoPortalDescriptor) -> list[dict[str, Any]]:
    """Extract normalized album cards from a portal entity's photos/albums tab."""
    if not html:
        return []
    prof = desc.profile or {}
    card_sel = prof.get("albumCardSelector") or "div.portal-card.portal-album"
    link_sel = prof.get("albumLinkSelector") or "a[href]"
    title_sel = prof.get("albumTitleSelector") or "p.title a"
    thumb_sel = prof.get("albumThumbSelector") or "img"
    count_sel = prof.get("albumCountSelector") or ".album-count"

    parser = LexborHTMLParser(html)
    albums: list[dict[str, Any]] = []
    seen: set[str] = set()

    for card in parser.css(card_sel):
        link_node = card.css_first(title_sel) or card.css_first(link_sel)
        href = (link_node.attributes.get("href") if link_node else None) or ""
        if not href:
            continue
        canon_url = canonicalize_portal_url(href, desc)
        if not canon_url or canon_url in seen:
            continue
        seen.add(canon_url)

        title = _clean_text(link_node.attributes.get("title") or link_node.text()) if link_node else ""
        thumb = _pick_image_url(card, thumb_sel, ["data-src", "src"], base_url, desc)
        cnt_node = card.css_first(count_sel) if count_sel else None
        photo_count = parse_compact_count(cnt_node.text()) if cnt_node else None
        alb_id = canon_url.rstrip("/").rsplit("/", 1)[-1]

        albums.append({
            "id": alb_id,
            "title": title or alb_id,
            "thumbnailUrl": thumb,
            "photoCount": photo_count or 0,
            "type": "album",
            "originalUrl": canon_url,
        })
    return albums


def parse_portal_album_photos(html: str, final_url: str, desc: VideoPortalDescriptor) -> dict[str, Any]:
    """Extract full-resolution image URLs from an album page."""
    if not html:
        return {"success": True, "album_url": final_url, "count": 0, "photos": []}
    prof = desc.profile or {}
    photo_sel = prof.get("albumPhotoSelector") or "img"

    parser = LexborHTMLParser(html)
    photos: list[str] = []
    seen: set[str] = set()
    for node in parser.css(photo_sel):
        raw = (
            node.attributes.get("href")
            or node.attributes.get("data-src")
            or node.attributes.get("data-original")
            or node.attributes.get("src")
            or ""
        )
        resolved = _abs_url(raw.strip(), final_url)
        if resolved and not _is_placeholder(resolved, desc) and resolved not in seen:
            seen.add(resolved)
            photos.append(resolved)

    return {
        "success": True,
        "album_url": canonicalize_portal_url(final_url, desc) or final_url,
        "count": len(photos),
        "photos": photos,
    }


def parse_portal_playlists(
    html: str,
    base_url: str,
    desc: VideoPortalDescriptor,
    fallback_avatar: str = "",
) -> list[dict[str, Any]]:
    """Extract normalized playlists from an entity's playlists/favorites tab."""
    if not html:
        return []
    prof = desc.profile or {}
    card_sel = prof.get("playlistCardSelector") or "div.playlist-block"
    link_sel = prof.get("playlistLinkSelector") or "a.playlist-link, a[href]"
    title_sel = prof.get("playlistTitleSelector") or "p.playlist-title a, p.title a"
    thumb_sel = prof.get("playlistThumbSelector") or "img"
    count_sel = prof.get("playlistCountSelector") or "span.playlist-count"

    parser = LexborHTMLParser(html)
    playlists: list[dict[str, Any]] = []
    seen: set[str] = set()

    for card in parser.css(card_sel):
        title_node = card.css_first(title_sel)
        link_node = card.css_first(link_sel) or title_node
        href = (
            (title_node.attributes.get("href") if title_node else None)
            or (link_node.attributes.get("href") if link_node else None)
            or ""
        )
        if not href:
            continue
        canon_url = canonicalize_portal_url(href, desc)
        if not canon_url or canon_url in seen:
            continue
        seen.add(canon_url)

        title = _clean_text((title_node or link_node).text()) if (title_node or link_node) else ""
        thumb = _pick_image_url(card, thumb_sel, ["data-src", "src"], base_url, desc) or fallback_avatar
        cnt_node = card.css_first(count_sel) if count_sel else None
        video_count = parse_compact_count(cnt_node.text()) if cnt_node else 0

        # Extract playlist ID after prefix e.g. /favorite/<id>/...
        pl_id = ""
        path_parts = [p for p in urlsplit(canon_url).path.split("/") if p]
        if len(path_parts) >= 2 and path_parts[0] in ("favorite", "favorites", "playlist", "playlists"):
            pl_id = path_parts[1]
        elif path_parts:
            pl_id = path_parts[-1]

        playlists.append({
            "id": pl_id or canon_url,
            "title": title or pl_id,
            "thumbnailUrl": thumb,
            "videoCount": video_count or 0,
            "type": "playlist",
            "originalUrl": canon_url,
        })
    return playlists


def parse_portal_playlist_videos(html: str, final_url: str, desc: VideoPortalDescriptor) -> dict[str, Any]:
    """Extract normalized videos and reportedCount from a portal playlist page."""
    canon_url = canonicalize_portal_url(final_url, desc) or final_url
    videos = parse_portal_video_cards(html, canon_url, desc)
    prof = desc.profile or {}
    rep_sel = prof.get("playlistReportedCountSelector")
    reported_count: Optional[int] = None
    if isinstance(rep_sel, str) and rep_sel and html:
        parser = LexborHTMLParser(html)
        node = parser.css_first(rep_sel)
        if node is not None:
            reported_count = parse_compact_count(node.text())

    return {
        "success": True,
        "playlist_url": canon_url,
        "count": len(videos),
        "videos": videos,
        "reportedCount": reported_count,
        "paginationComplete": reported_count is not None and len(videos) >= reported_count,
        "maxPage": extract_portal_max_page(html, desc),
    }


def extract_portal_stream_fallback(html: str, page_url: str, desc: VideoPortalDescriptor) -> dict[str, Any]:
    """Extract HLS/MP4 stream URLs directly from watch-page HTML via descriptor regexes."""
    sf = desc.stream_fallback or {}
    hls_url = ""
    qualities: list[dict[str, Any]] = []

    def _match(key: str) -> str:
        pat = sf.get(key)
        if not isinstance(pat, str) or not pat or not html:
            return ""
        m = re.search(pat, html)
        if not m:
            return ""
        val = (m.group(1) if m.groups() else m.group(0)).strip()
        return html_lib.unescape(val)

    raw_hls = _match("hlsRegex")
    if raw_hls:
        hls_url = _abs_url(raw_hls, page_url)
        qualities.append({"quality": "Auto", "height": 9999, "url": hls_url})

    raw_hd = _match("hdMp4Regex")
    if raw_hd:
        qualities.append({"quality": "HD", "height": 720, "url": _abs_url(raw_hd, page_url)})

    raw_sd = _match("sdMp4Regex")
    if raw_sd:
        qualities.append({"quality": "SD", "height": 360, "url": _abs_url(raw_sd, page_url)})

    raw_thumb = _match("thumbRegex")
    raw_title = _match("titleRegex")

    return {
        "master_hls_url": hls_url,
        "qualities": qualities,
        "thumb_url": _abs_url(raw_thumb, page_url) if raw_thumb else "",
        "title": _clean_text(raw_title),
    }


def build_portal_entity_page_url(
    entity_base_url: str,
    desc: VideoPortalDescriptor,
    *,
    sort: str = "best",
    page: int = 1,
    section: str = "videos",
) -> str:
    """Build declarative URL for creator/channel AJAX endpoints or category/tag HTML pagination."""
    base = entity_base_url.rstrip("/")
    page_num = max(1, int(page))
    page_zero = max(0, page_num - 1)
    prof = desc.profile or {}

    if section == "videos":
        tmpl = prof.get("videosJsonPathTemplate")
        if isinstance(tmpl, str) and tmpl:
            p_zero = page_zero if prof.get("pageBaseZero", True) else page_num
            return tmpl.format(entity_base=base, sort=sort, page=page_num, page_zero=p_zero)
    elif section == "shorts":
        tmpl = prof.get("shortsJsonPathTemplate")
        if isinstance(tmpl, str) and tmpl:
            p_zero = page_zero if prof.get("pageBaseZero", True) else page_num
            return tmpl.format(entity_base=base, sort=sort, page=page_num, page_zero=p_zero)
    elif section == "html_grid":
        if page_num <= 1:
            return base
        zero_based = bool((desc.video_cards or {}).get("pageBaseZero", True))
        suffix = page_zero if zero_based else page_num
        return f"{base}/{suffix}"
    return base


def _extract_image_from_directory_card(card, rule: dict[str, Any], base_url: str, desc: VideoPortalDescriptor) -> str:
    from .timeline_directory import directory_thumbnail

    direct = directory_thumbnail(
        card, base_url,
        selector=str(rule.get("thumbSelector") or ""),
        attributes=tuple(rule.get("thumbAttrs") or ()),
        is_placeholder=lambda url: _is_profile_image_placeholder(url, desc) or _is_placeholder(url, desc),
    )
    if direct:
        return direct

    script_re = rule.get("scriptImageRegex")
    if isinstance(script_re, str) and script_re:
        chunks = [node.text() for node in card.css("script") if node.text()]
        chunks.append(card.html or "")
        for chunk in chunks:
            m = re.search(script_re, chunk, re.IGNORECASE | re.DOTALL)
            if m:
                raw = html_lib.unescape((m.group(1) if m.groups() else m.group(0)).strip())
                resolved = _abs_url(raw, base_url)
                if resolved and not _is_profile_image_placeholder(resolved, desc):
                    return resolved
    return ""


def parse_portal_directory_items(
    html: str,
    base_url: str,
    desc: VideoPortalDescriptor,
    kind: str,
    *,
    current_page: int = 1,
) -> dict[str, Any]:
    """Parse categories, channels, artists, or tags directory listings (with <script> thumb extraction)."""
    dirs = (desc.browse or {}).get("directories") or {}
    rule = dirs.get(kind) if isinstance(dirs, dict) else None
    if not isinstance(rule, dict):
        rule = {}

    if not html:
        return {"items": [], "hasMore": False, "maxPage": 1}

    card_sel = rule.get("cardSelector") or ".portal-dir-card, .directory-item"
    link_sel = rule.get("linkSelector") or "a[href]"
    title_sel = rule.get("titleSelector") or ".profile-name, .name, a[href]"
    count_sel = rule.get("countSelector") or ".navbadge, .with-sub, .count"
    verified_sel = rule.get("verifiedSelector") or ""
    rank_sel = rule.get("rankSelector") or ""
    exclude_re = rule.get("excludeHrefRegex") or ""
    min_seg_len = int(rule.get("minSlugLength") or 0)

    parser = LexborHTMLParser(html)
    items: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    for card in parser.css(card_sel):
        if card.tag == "a":
            link_node = card
        else:
            link_node = card.css_first(link_sel) or card.css_first("a[href]")
        if link_node is None:
            continue
        href = (link_node.attributes.get("href") or "").strip()
        if not href:
            continue
        if isinstance(exclude_re, str) and exclude_re:
            try:
                if re.search(exclude_re, href, re.IGNORECASE):
                    continue
            except re.error:
                pass
        if min_seg_len > 0:
            last_seg = urlsplit(href).path.rstrip("/").rsplit("/", 1)[-1]
            if len(last_seg) < min_seg_len:
                continue

        canon_url = normalize_portal_entity_base_url(canonicalize_portal_url(urljoin(base_url, href), desc), desc)
        if not canon_url or canon_url in seen_urls:
            continue

        rank_node = card.css_first(rank_sel) if rank_sel else None
        rank_val = parse_compact_count(rank_node.text()) if rank_node else None
        rank_txt = _clean_dom_text(rank_node) if rank_node is not None else ""

        title_node = card.css_first(title_sel) or link_node
        title = _clean_dom_text(title_node) if title_node else ""
        if rank_txt and title.startswith(rank_txt):
            title = title[len(rank_txt):].strip(" -:\u00a0")
        elif rank_val is not None:
            title = re.sub(rf"^#\s*{rank_val}\b\s*", "", title).strip()
        cnt_node = card.css_first(count_sel) if (count_sel and card.tag != "a") else (card.css_first(count_sel) if count_sel else None)
        cnt_text = _clean_dom_text(cnt_node) if cnt_node else ""
        if cnt_node is not None and cnt_text and title.endswith(cnt_text):
            title = title[: -len(cnt_text)].strip()
        if not title:
            title = urlsplit(canon_url).path.strip("/").rsplit("/", 1)[-1]

        count_val = parse_compact_count(cnt_text) if cnt_text else None
        thumb_url = _extract_image_from_directory_card(card, rule, base_url, desc)
        verified = bool(verified_sel and card.css_first(verified_sel) is not None)

        seen_urls.add(canon_url)
        entity_kind = detect_portal_entity_kind(canon_url, desc)
        if entity_kind == "unknown":
            entity_kind = {"artists": "creator", "channels": "channel", "categories": "category", "tags": "tag"}.get(kind, "directory")

        entry: dict[str, Any] = {
            "id": urlsplit(canon_url).path.strip("/") or canon_url,
            "name": title,
            "url": canon_url,
            "thumbnailUrl": thumb_url,
            "count": count_val,
            "kind": entity_kind,
            "verified": verified,
        }
        if cnt_text:
            entry["subscribersText"] = cnt_text
        if rank_val is not None:
            entry["rank"] = rank_val
        items.append(entry)

    # Check pagination on directory HTML
    pag_sel = rule.get("paginationSelector") or (desc.video_cards or {}).get("paginationSelector") or ".pagination a"
    href_re = rule.get("pageHrefRegex") or (desc.video_cards or {}).get("pageHrefRegex") or r"(?:/([0-9]+)|[?&]p=([0-9]+))(?:$|[?#])"
    zero_based = bool(rule.get("pageBaseZero", (desc.browse or {}).get("pageBaseZero", True)))
    max_page = 1
    for a in parser.css(pag_sel):
        ahref = a.attributes.get("href") or ""
        m = re.search(href_re, ahref)
        if m:
            raw_num = next((g for g in m.groups() if g), None)
            if raw_num is not None:
                max_page = max(max_page, int(raw_num) + (1 if zero_based else 0))

    from .timeline_directory import directory_next_url

    next_url = directory_next_url(parser, base_url, current_page, rule)
    has_more = bool(next_url or current_page < max_page)
    return {"items": items, "hasMore": has_more, "maxPage": max_page, "nextPageUrl": next_url or None}


def _find_jsonld_video_object(node: Any) -> Optional[dict[str, Any]]:
    if isinstance(node, list):
        for item in node:
            found = _find_jsonld_video_object(item)
            if found is not None:
                return found
        return None
    if not isinstance(node, dict):
        return None
    typ = node.get("@type")
    if typ == "VideoObject" or (isinstance(typ, list) and "VideoObject" in typ):
        return node
    graph = node.get("@graph")
    if graph is not None:
        return _find_jsonld_video_object(graph)
    return None


def _extract_isolated_link_name(anchor_node, name_selector: str | None) -> str:
    if anchor_node is None:
        return ""
    if name_selector:
        name_node = anchor_node.css_first(name_selector)
        if name_node is not None:
            txt = _clean_text(name_node.text(separator=" "))
            if txt:
                return txt
    # Fallback without badge/subscribe counts
    parts: list[str] = []
    for child in anchor_node.iter(include_text=True):
        if child.tag == "-text":
            parent_cls = (child.parent.attributes.get("class") or "") if child.parent else ""
            if any(tok in parent_cls for tok in ("count", "subscribe", "badge")):
                continue
            txt = _clean_text(child.text())
            if txt:
                parts.append(txt)
    return _clean_text(" ".join(parts)) if parts else _clean_text(anchor_node.text(separator=" "))


def extract_portal_watch_data(
    html: str,
    final_url: str,
    desc: VideoPortalDescriptor,
) -> dict[str, Any]:
    """Extract JSON-LD metadata, uploader, performers, tags, categories, engagement, and related videos."""
    watch_cfg = desc.watch or {}
    parser = LexborHTMLParser(html or "")
    canon_url = canonicalize_portal_url(final_url, desc) or final_url
    current_vid = extract_portal_video_id(canon_url, desc)

    # 1. JSON-LD VideoObject
    ld_obj: dict[str, Any] = {}
    ld_sel = watch_cfg.get("jsonLdSelector") or 'script[type="application/ld+json"]'
    for script in parser.css(ld_sel):
        body = (script.text() or "").strip()
        if not body:
            continue
        try:
            parsed_ld = json.loads(body)
        except Exception:
            continue
        found = _find_jsonld_video_object(parsed_ld)
        if found is not None:
            ld_obj = found
            break

    title = _clean_text(ld_obj.get("name"))
    if not title:
        title_sel = watch_cfg.get("titleSelector") or "h1, h2.page-title"
        t_node = parser.css_first(title_sel)
        title = _clean_text(t_node.text(separator=" ")) if t_node else ""
    if not title:
        og_t = parser.css_first('meta[property="og:title"]')
        title = _clean_text(og_t.attributes.get("content")) if og_t else ""

    description = _clean_text(ld_obj.get("description"))
    if not description:
        og_d = parser.css_first('meta[property="og:description"], meta[name="description"]')
        description = _clean_text(og_d.attributes.get("content")) if og_d else ""

    upload_date = _clean_text(ld_obj.get("uploadDate") or ld_obj.get("datePublished")) or None

    view_count_text = None
    stat = ld_obj.get("interactionStatistic")
    if isinstance(stat, list):
        stat = stat[0] if stat else None
    if isinstance(stat, dict) and stat.get("userInteractionCount") is not None:
        view_count_text = str(stat["userInteractionCount"])
    if not view_count_text:
        views_sel = watch_cfg.get("viewsSelector")
        if isinstance(views_sel, str) and views_sel:
            vn = parser.css_first(views_sel)
            view_count_text = _clean_text(vn.text()) if vn else None

    # 2. Uploader / author
    from .profile_hub_watch_sources import _jsonld_audience_from_node, format_audience_label

    exclude_chrome = tuple(watch_cfg.get("excludeChromeTokens") or ())
    author_name = None
    author_url = None
    audience_count_text = None
    audience_kind = None
    up_sel = watch_cfg.get("uploaderLinkSelector") or ".portal-uploader a"
    up_node = parser.css_first(up_sel)
    custom_subs_sel = watch_cfg.get("uploaderSubsSelector")
    subs_sel = custom_subs_sel or ".portal-subs .count"
    if up_node is not None:
        raw_name = _extract_isolated_link_name(up_node, watch_cfg.get("uploaderNameSelector") or ".name")
        author_name = raw_name or None
        raw_href = up_node.attributes.get("href") or ""
        if raw_href:
            author_url = normalize_portal_entity_base_url(canonicalize_portal_url(raw_href, desc), desc) or None
        subs_node = up_node.css_first(subs_sel)
        if subs_node is None and up_node.parent is not None:
            subs_node = up_node.parent.css_first(subs_sel)
        if subs_node is None and isinstance(custom_subs_sel, str) and custom_subs_sel:
            subs_node = parser.css_first(custom_subs_sel)
        if subs_node is not None:
            subs_txt = _clean_text(subs_node.text())
            if subs_txt:
                audience_count_text, audience_kind = format_audience_label(subs_txt, "subscribers")
    if not audience_count_text and isinstance(ld_obj, dict):
        audience_count_text, audience_kind = _jsonld_audience_from_node(ld_obj.get("author"))

    # 3. Performers / artists
    artists: list[dict[str, Any]] = []
    seen_artists: set[str] = set()
    perf_sel = watch_cfg.get("performerLinkSelector") or ".portal-performer a"
    perf_name_sel = watch_cfg.get("performerNameSelector") or ".name"
    verif_sel = watch_cfg.get("verifiedSelector") or ".verified, .icon-verified"
    for node in parser.css(perf_sel):
        if _is_inside_nav_chrome(node, exclude_chrome):
            continue
        p_name = _extract_isolated_link_name(node, perf_name_sel)
        raw_phref = node.attributes.get("href") or ""
        p_url = normalize_portal_entity_base_url(canonicalize_portal_url(raw_phref, desc), desc) if raw_phref else ""
        if not p_name or not p_url or p_url in seen_artists:
            continue
        seen_artists.add(p_url)
        artists.append({
            "name": p_name,
            "url": p_url,
            "verified": bool(node.css_first(verif_sel)) or "verified" in (node.attributes.get("class") or "").lower(),
        })

    # 4. Tags & Categories (strictly excluding global nav/header chrome!)
    tags: list[dict[str, str]] = []
    seen_tags: set[str] = set()
    for a in parser.css(watch_cfg.get("tagSelector") or ".portal-tags a"):
        if _is_inside_nav_chrome(a, exclude_chrome):
            continue
        thref = a.attributes.get("href") or ""
        tname = _clean_dom_text(a)
        if not thref or not tname:
            continue
        turl = normalize_portal_entity_base_url(canonicalize_portal_url(thref, desc), desc)
        if turl and turl not in seen_tags:
            seen_tags.add(turl)
            tags.append({"name": tname, "url": turl})

    categories: list[dict[str, str]] = []
    seen_cats: set[str] = set()
    cat_sel = watch_cfg.get("categorySelector") or ".portal-categories a"
    for a in parser.css(cat_sel):
        if _is_inside_nav_chrome(a, exclude_chrome):
            continue
        chref = a.attributes.get("href") or ""
        cname = _clean_dom_text(a)
        if not chref or not cname:
            continue
        curl = normalize_portal_entity_base_url(canonicalize_portal_url(chref, desc), desc)
        if curl and curl not in seen_cats and detect_portal_entity_kind(curl, desc) == "category":
            seen_cats.add(curl)
            categories.append({"name": cname, "url": curl})

    # 5. Engagement counts & numeric ID
    likes_node = parser.css_first(watch_cfg.get("likesSelector") or ".portal-likes")
    dislikes_node = parser.css_first(watch_cfg.get("dislikesSelector") or ".portal-dislikes")
    comm_node = parser.css_first(watch_cfg.get("commentsCountSelector") or ".portal-comments-count")

    like_count = parse_compact_count(likes_node.text()) if likes_node else None
    dislike_count = parse_compact_count(dislikes_node.text()) if dislikes_node else None
    comment_count = parse_compact_count(comm_node.text()) if comm_node else None

    numeric_id = None
    num_re = watch_cfg.get("numericIdRegex") or r'"id_video"\s*:\s*(\d+)'
    if isinstance(num_re, str) and num_re and html:
        nm = re.search(num_re, html)
        if nm:
            numeric_id = next((g for g in nm.groups() if g), nm.group(0))

    # 6. Related videos (JS var first, DOM fallback)
    rel_raw_items: list[dict[str, Any]] = []
    rel_re = watch_cfg.get("relatedVarRegex")
    if isinstance(rel_re, str) and rel_re and html:
        rm = re.search(rel_re, html, re.DOTALL)
        if rm:
            try:
                rel_json = json.loads(rm.group(1))
                rel_raw_items = parse_portal_video_json_items(rel_json, canon_url, desc)
            except Exception:
                rel_raw_items = []
    if not rel_raw_items:
        rel_raw_items = parse_portal_video_cards(html, canon_url, desc)

    related_videos: list[dict[str, Any]] = []
    seen_rel: set[str] = set()
    if current_vid:
        seen_rel.add(current_vid)
    for item in rel_raw_items:
        vid_key = item.get("id") or item.get("originalUrl") or ""
        if not vid_key or vid_key in seen_rel:
            continue
        seen_rel.add(vid_key)
        related_videos.append({
            "id": f"{desc.id}:{item.get('id')}",
            "source_url": item.get("originalUrl") or "",
            "title": item.get("title") or "",
            "thumbnail_url": item.get("thumbnailUrl") or "",
            "preview_video_url": item.get("previewVideoUrl") or "",
            "duration": item.get("duration") or "",
            "resolution": item.get("resolution") or "",
            "author_name": item.get("authorName") or None,
            "author_url": item.get("authorUrl") or None,
            "views": item.get("views") or "",
        })
        if len(related_videos) >= 48:
            break

    details = {
        "title": title or None,
        "description": description or None,
        "author_name": author_name,
        "author_url": author_url,
        "author_avatar_url": None,
        "audience_count_text": audience_count_text,
        "audience_kind": audience_kind,
        "reaction_kind": "like_dislike",
        "like_count": like_count,
        "dislike_count": dislike_count,
        "comment_count": comment_count,
        "artists": artists,
        "tags": tags,
        "categories": categories,
        "upload_date": upload_date,
        "view_count_text": view_count_text,
    }
    return {
        "details": details,
        "videos": related_videos,
        "related_present": True,
        "numeric_id": numeric_id,
    }


def _video_card_to_timeline_item(desc: VideoPortalDescriptor, card: dict[str, Any]) -> dict[str, Any]:
    from .timeline_search_providers import make_item_entry

    return make_item_entry(
        source_id=desc.id,
        item_id=f"{desc.id}:{card.get('id') or card.get('originalUrl')}",
        item_type="video",
        title=card.get("title") or "",
        original_url=card.get("originalUrl") or "",
        thumbnail=card.get("thumbnailUrl") or "",
        creator_name=card.get("authorName") or "",
        source_page=card.get("authorUrl") or "",
        video_url=card.get("streamUrl") or "",
        duration=card.get("duration") or "",
        views=card.get("views") or "",
        resolution=card.get("resolution") or "",
        preview_video_url=card.get("previewVideoUrl") or "",
        neutral_label=desc.display_name,
    )


def _find_portal_next_page_url(html: str, final_url: str, page: int, desc: VideoPortalDescriptor) -> Optional[str]:
    """Find the concrete next-page pagination href from HTML when present."""
    if not html:
        return None
    vc = desc.video_cards or {}
    sel = vc.get("paginationSelector") or ".pagination a"
    href_re = vc.get("pageHrefRegex") or r"(?:/([0-9]+)|[?&]p=([0-9]+))(?:$|[?#])"
    zero_based = bool(vc.get("pageBaseZero", True))
    target_page = page + 1
    target_token = (target_page - 1) if zero_based else target_page

    parser = LexborHTMLParser(html)
    # 1. Explicit next-page link
    for next_a in parser.css(".pagination a.next-page[href], .pagination li.next a[href]"):
        nhref = (next_a.attributes.get("href") or "").strip()
        if nhref:
            return urljoin(final_url, nhref)
    # 2. Exact numeric target match
    for a in parser.css(sel):
        href = (a.attributes.get("href") or "").strip()
        if not href:
            continue
        m = re.search(href_re, href)
        if m:
            raw_num = next((g for g in m.groups() if g), None)
            if raw_num is not None and int(raw_num) == target_token:
                return urljoin(final_url, href)
    return None


def extract_portal_dynamic_subfilters(
    html: str,
    base_url: str,
    desc: VideoPortalDescriptor,
) -> list[dict[str, str]]:
    """Dynamically discover live category/topic subfilters from a portal browse HTML page."""
    dyn_cfg = (desc.browse or {}).get("dynamicSubfilters")
    if not isinstance(dyn_cfg, dict) or not dyn_cfg.get("selector") or not html:
        return []
    sel = str(dyn_cfg["selector"])
    ex_re = str(dyn_cfg.get("excludeHrefRegex") or "")
    max_items = int(dyn_cfg.get("maxItems") or 14)

    parser = LexborHTMLParser(html)
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for node in parser.css(sel):
        href = (node.attributes.get("href") or "").strip()
        if not href:
            continue
        if ex_re:
            try:
                if re.search(ex_re, href, re.IGNORECASE):
                    continue
            except re.error:
                pass
        canon = normalize_portal_entity_base_url(canonicalize_portal_url(href, desc), desc)
        if not canon:
            continue
        label = _clean_dom_text(node)
        if not label:
            continue
        path = urlsplit(canon).path
        slug = path.strip("/").rsplit("/", 1)[-1].lower()
        if not slug or slug in seen:
            continue
        seen.add(slug)
        out.append({
            "id": path,
            "label_key": "",
            "fallback_label": label,
            "group": "category",
            "path": path,
        })
        if len(out) >= max_items:
            break
    return out


async def browse_video_portal(
    client,
    desc: VideoPortalDescriptor,
    category: str,
    *,
    subfilter: str | None = None,
    cursor: str | None = None,
    limit: int = 24,
):
    """Fetch a paginated browse feed page for any VideoPortalDescriptor."""
    from .timeline_browse_providers import BrowsePageResult
    from .timeline_search_providers import decode_search_cursor, encode_search_cursor

    feeds = (desc.browse or {}).get("feeds") or {}
    cat_key = str(category or desc.default_category or "recent").strip().lower()
    if cat_key not in feeds:
        for alias in (cat_key, "recent" if cat_key == "videos" else "latest", "latest", "popular"):
            if alias in feeds:
                cat_key = alias
                break

    cur_data = decode_search_cursor(cursor) if cursor else {}
    page = max(1, int((cur_data or {}).get("page") or 1))
    page_zero = max(0, page - 1)
    zero_based = bool((desc.browse or {}).get("pageBaseZero", True))

    cursor_next_url = str((cur_data or {}).get("nextUrl") or "").strip()
    sub = str(subfilter or "").strip()

    if cursor_next_url:
        target_url = cursor_next_url
    else:
        sub_obj = next((sf for sf in desc.subfilters if str(sf.get("id") or "") == sub), None) if sub else None
        sub_path = str(sub_obj.get("path") or "").strip() if isinstance(sub_obj, dict) else ""
        if not sub_path and sub.startswith("/"):
            sub_path = sub
        if sub_path:
            if page == 1:
                formatted = sub_path
            else:
                suffix = page_zero if zero_based else page
                formatted = f"{sub_path.rstrip('/')}/{suffix}"
        else:
            raw_feed = feeds.get(cat_key) or "/{page_zero}"
            if isinstance(raw_feed, dict):
                tmpl = str(
                    raw_feed.get("pageOnePath") if page == 1 else (raw_feed.get("pagedPathTemplate") or raw_feed.get("pageOnePath") or "/")
                )
            else:
                tmpl = str(raw_feed)
            formatted = tmpl.format(
                page=page,
                page_zero=page_zero if zero_based else page,
                subfilter=sub,
            )
        target_url = urljoin(desc.effective_base_url() + "/", formatted)
        sub_param = (desc.browse or {}).get("subfilterQueryParam")
        if sub and not sub_path and sub_param and f"{sub_param}=" not in target_url:
            sep = "&" if "?" in target_url else "?"
            target_url = f"{target_url}{sep}{sub_param}={sub}"

    resp = await client.get(target_url, headers=desc.default_headers(target_url))
    resp.raise_for_status()
    final_url = str(resp.url or target_url)
    html = resp.text or ""
    cards = parse_portal_video_cards(html, final_url, desc)
    dyn_subfilters = extract_portal_dynamic_subfilters(html, final_url, desc) if page == 1 else []
    max_page = extract_portal_max_page(html, desc)
    concrete_next = _find_portal_next_page_url(html, final_url, page, desc)
    has_more = bool(concrete_next) or page < max_page or (bool(cards) and max_page > page)
    next_cursor_payload: dict[str, Any] = {"page": page + 1}
    if concrete_next:
        next_cursor_payload["nextUrl"] = concrete_next
    next_cursor = encode_search_cursor(next_cursor_payload) if has_more else None
    items = [_video_card_to_timeline_item(desc, card) for card in cards[:limit]]

    return BrowsePageResult(
        source_id=desc.id,
        category=cat_key,
        subfilter=subfilter,
        items=items,
        dynamic_subfilters=dyn_subfilters,
        next_cursor=next_cursor,
        has_more=has_more,
        resolved_origin=desc.effective_base_url(),
    )


async def list_video_portal_directory(
    client,
    desc: VideoPortalDescriptor,
    kind: str,
    *,
    page: int = 1,
    subfilter: str | None = None,
    page_url: str = "",
    query: str = "",
) -> dict[str, Any]:
    """Fetch paginated categories, channels, artists, or tags directories for a VideoPortal."""
    from .timeline_directory import directory_path, valid_directory_url

    dirs = (desc.browse or {}).get("directories") or {}
    clean_kind = str(kind or "categories").strip().lower()
    rule = dirs.get(clean_kind) if isinstance(dirs, dict) else None
    if not isinstance(rule, dict):
        return {"source": desc.id, "kind": clean_kind, "page": page, "items": [], "hasMore": False, "nextPage": None}

    tmpl = str((rule.get("searchPathTemplate") if query else None) or rule.get("pathTemplate") or f"/{clean_kind}")
    page_num = max(1, int(page))
    zero_based = bool(rule.get("pageBaseZero", (desc.browse or {}).get("pageBaseZero", True)))
    origin = desc.effective_base_url() + "/"
    target_url = (valid_directory_url(origin, page_url) if page_url else "") or valid_directory_url(
        origin, directory_path(tmpl, page_num, zero_based=zero_based, query=query, subfilter=str(subfilter or "").strip()),
    )
    if not target_url:
        raise ValueError("Invalid directory address")
    resp = await client.get(target_url, headers=desc.default_headers(target_url))
    resp.raise_for_status()
    parsed = parse_portal_directory_items(resp.text or "", str(resp.url or target_url), desc, clean_kind, current_page=page_num)
    max_page = int(parsed.get("maxPage") or 1)
    has_more = bool(rule.get("paginated", True) and parsed.get("hasMore"))
    items = parsed.get("items") or []
    if clean_kind == "categories" and rule.get("coverFromEntryPage"):
        for item in items:
            if not item.get("thumbnailUrl"):
                item["hasCoverPreview"] = True
    return {
        "source": desc.id,
        "kind": clean_kind,
        "page": page_num,
        "items": items,
        "hasMore": has_more,
        "nextPage": (page_num + 1) if has_more else None,
        "nextPageUrl": parsed.get("nextPageUrl") if has_more else None,
        "maxPage": max_page if has_more else page_num,
    }


async def read_portal_category_cover(client, desc: VideoPortalDescriptor, url: str) -> str:
    rule = ((desc.browse or {}).get("directories") or {}).get("categories") or {}
    if not rule.get("coverFromEntryPage") or not desc.matches_host(urlsplit(url).hostname or ""):
        return ""
    category_url = canonicalize_portal_url(url, desc)
    if not category_url or detect_portal_entity_kind(category_url, desc) != "category":
        return ""
    resp = await client.get(category_url, headers=desc.default_headers(category_url))
    resp.raise_for_status()
    final_url = str(resp.url)
    if not desc.matches_host(urlsplit(final_url).hostname or "") or detect_portal_entity_kind(final_url, desc) != "category":
        return ""
    cards = parse_portal_video_cards(resp.text, final_url, desc)
    return next((card["thumbnailUrl"] for card in cards if card.get("thumbnailUrl")), "")


async def search_video_portal(
    client,
    desc: VideoPortalDescriptor,
    query: str,
    category: str,
    *,
    cursor: str | None = None,
    options: dict[str, Any] | None = None,
):
    """Execute federated search for videos, profiles, and playlists."""
    from urllib.parse import quote, quote_plus
    from .timeline_search_providers import (
        SearchPageResult,
        decode_search_cursor,
        encode_search_cursor,
        make_item_entry,
        make_profile_entry,
    )

    search_cfg = desc.search or {}
    opts = options if isinstance(options, dict) else {}
    cur_data = decode_search_cursor(cursor) if cursor else {}
    page = max(1, int((cur_data or {}).get("page") or 1))
    page_zero = max(0, page - 1)
    zero_based = bool(search_cfg.get("pageBaseZero", True))
    p_token = page_zero if zero_based else page

    clean_q = (query or "").strip()
    enc_q_plus = quote_plus(clean_q)
    enc_q_path = quote(clean_q, safe="")
    headers = desc.default_headers(desc.effective_base_url())

    if category == "profiles":
        profiles: list[dict[str, Any]] = []
        seen_urls: set[str] = set()
        suggest_tmpl = search_cfg.get("suggestPathTemplate")
        if page == 1 and isinstance(suggest_tmpl, str) and suggest_tmpl:
            s_url = urljoin(desc.effective_base_url() + "/", suggest_tmpl.format(query=enc_q_path, query_plus=enc_q_plus))
            try:
                sr = await client.get(s_url, headers=headers, timeout=2.5)
                if sr.status_code == 200:
                    payload = sr.json()
                    data = payload.get("data") if isinstance(payload, dict) else {}
                    routes = search_cfg.get("suggestEntityRoutes") or {}
                    suggest_key = search_cfg.get("suggestProfilesKey") or "pornstar"
                    for row in (data.get(suggest_key) or []) if isinstance(data, dict) else []:
                        if not isinstance(row, dict):
                            continue
                        slug = str(row.get("F") or "").strip().strip("/")
                        r_name = _clean_text(row.get("N") or slug)
                        if not slug or not r_name:
                            continue
                        raw_type = str(row.get("T") or "creator").strip().lower()
                        e_kind = "channel" if raw_type == "channel" else "creator"
                        route_tmpl = str(routes.get(raw_type) or routes.get(e_kind) or f"/{slug}")
                        p_url = normalize_portal_entity_base_url(
                            canonicalize_portal_url(route_tmpl.format(slug=slug), desc),
                            desc,
                        )
                        if not p_url or p_url in seen_urls:
                            continue
                        seen_urls.add(p_url)
                        raw_avatar = row.get("P")
                        avatar = _abs_url(raw_avatar, desc.effective_base_url() + "/") if isinstance(raw_avatar, str) else ""
                        if avatar and _is_profile_image_placeholder(avatar, desc):
                            avatar = ""
                        profiles.append(
                            make_profile_entry(
                                source_id=desc.id,
                                entry_id=f"{desc.id}:{e_kind}:{slug}",
                                name=r_name,
                                profile_url=p_url,
                                handle=slug,
                                avatar=avatar,
                                videos_count=parse_compact_count(row.get("MV")),
                                entity_kind=e_kind,
                            )
                        )
            except Exception:
                pass
        from .timeline_directory import search_directory_profiles

        async def fetch_directory(kind: str, **params: Any) -> dict[str, Any]:
            return await list_video_portal_directory(client, desc, kind, **params)

        return await search_directory_profiles(
            desc.id, clean_q, desc.browse.get("directories") or {}, fetch_directory,
            cursor=cursor, suggestions=profiles,
        )

    if category == "playlists":
        pl_tmpl = search_cfg.get("playlistsPathTemplate")
        if not isinstance(pl_tmpl, str) or not pl_tmpl:
            return SearchPageResult(source_id=desc.id, category=category)
        pl_url = urljoin(
            desc.effective_base_url() + "/",
            pl_tmpl.format(query=enc_q_plus, query_path=enc_q_path, page=page, page_zero=p_token),
        )
        pr = await client.get(pl_url, headers=headers)
        if pr.status_code != 200:
            return SearchPageResult(source_id=desc.id, category=category)
        parsed_pls = parse_portal_playlists(pr.text or "", str(pr.url or pl_url), desc)
        pl_items = [
            make_item_entry(
                source_id=desc.id,
                item_id=f"{desc.id}:pl:{pl.get('id')}",
                item_type="playlist",
                title=pl.get("title") or "Playlist",
                original_url=pl.get("originalUrl") or "",
                thumbnail=pl.get("thumbnailUrl") or "",
                video_count=pl.get("videoCount") or 0,
                neutral_label=desc.display_name,
            )
            for pl in parsed_pls
        ]
        max_page = extract_portal_max_page(pr.text or "", desc)
        return SearchPageResult(
            source_id=desc.id,
            category=category,
            items=pl_items,
            next_cursor=encode_search_cursor({"page": page + 1}) if page < max_page and pl_items else None,
        )

    # Default videos search
    vid_tmpl = str(search_cfg.get("videosPathTemplate") or "/?k={query}&p={page_zero}")
    vid_url = urljoin(
        desc.effective_base_url() + "/",
        vid_tmpl.format(query=enc_q_plus, query_path=enc_q_path, page=page, page_zero=p_token),
    )
    sort_key = str(opts.get("sort") or "").strip().lower()
    sort_params = search_cfg.get("sortParams") or {}
    if sort_key and isinstance(sort_params, dict) and sort_key in sort_params:
        vid_url += str(sort_params[sort_key])

    vr = await client.get(vid_url, headers=headers)
    if vr.status_code != 200:
        return SearchPageResult(source_id=desc.id, category=category)
    cards = parse_portal_video_cards(vr.text or "", str(vr.url or vid_url), desc)
    max_page = extract_portal_max_page(vr.text or "", desc)
    items = [_video_card_to_timeline_item(desc, card) for card in cards]
    return SearchPageResult(
        source_id=desc.id,
        category=category,
        items=items,
        next_cursor=encode_search_cursor({"page": page + 1}) if page < max_page and items else None,
    )
