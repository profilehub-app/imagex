"""Generic structured forum / image-board engine driven by ForumDescriptor config.

Supports:
- Dynamic board hierarchy discovery with exclusion rules and role classification
- Intent classification across `inline_album`, `video_release`, `download_pack`, `artist_collection`
- Extraction of BOTH wrapped `<a href><img></a>` galleries AND standalone unwrapped `<img>` posters
- Separation of external filehost download mirrors (`releaseLinks`) and resolution specs
- Native descriptor-driven search flags (`imgsearch`, `vidsearch`, `showposts`, `forumchoice[]`)
- Paginated in-app multi-post thread reader
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
import hashlib
import re
import time
from typing import Any, Literal
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit
import weakref

import httpx
from selectolax.lexbor import LexborHTMLParser

from ..core.network_profiles import resolve_anti_hotlink_headers
from .connector_registry import ForumDescriptor, list_image_host_rules
from .original_image_resolver import is_image_viewer_url, is_placeholder_media_url

_RELEASE_SPEC_RE = re.compile(
    r"\b(?:2160p|1440p|1080p|720p|480p|4k|uhd|hevc|x264|x265|h264|mp4|mkv|wmv|avi|mov)\b|"
    r"\b\d+(?:\.\d+)?\s*(?:gb|mb)\b",
    re.IGNORECASE,
)
_ALBUM_COUNT_RE = re.compile(
    r"(?:\bx\d{2,4}\b|\b\d{2,4}x\b|\b\d{2,4}\s*(?:images?|pics?|photos?)\b|\[\d{2,4}\s*(?:images?|pics?|photos?)\])",
    re.IGNORECASE,
)
_IMAGE_EXT_RE = re.compile(r"\.(?:jpe?g|png|webp|avif|gif)(?:\?|$)", re.IGNORECASE)
_ARCHIVE_EXT_RE = re.compile(r"\.(?:zip|rar|7z|mp4|mkv|wmv|avi|mov)(?:\?|$)", re.IGNORECASE)

_FORUM_SEARCH_CACHE: OrderedDict[str, tuple[float, tuple[list[dict[str, Any]], str | None, str | None]]] = OrderedDict()
_FORUM_SEARCH_CACHE_TTL_S = 90.0
_FORUM_SEARCH_CACHE_MAX = 128
_FORUM_SEARCH_LOCKS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, asyncio.Lock]]" = weakref.WeakKeyDictionary()


def clear_forum_search_cache() -> None:
    _FORUM_SEARCH_CACHE.clear()


def _get_search_lock(key: str) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    bucket = _FORUM_SEARCH_LOCKS.get(loop)
    if bucket is None:
        bucket = {}
        _FORUM_SEARCH_LOCKS[loop] = bucket
    lock = bucket.get(key)
    if lock is None:
        lock = asyncio.Lock()
        bucket[key] = lock
    return lock


def _abs_board_url(base: str, raw: str | None) -> str:
    val = (raw or "").strip()
    if not val or val.startswith(("#", "javascript:", "mailto:", "data:")):
        return ""
    if val.startswith("//"):
        return "https:" + val
    if val.startswith(("threads/", "forums/", "members/", "search.php", "activity.php", "forum.php")):
        parsed = urlsplit(base)
        return f"{parsed.scheme}://{parsed.netloc}/{val}"
    joined = urljoin(base, val)
    return joined if urlsplit(joined).scheme in ("http", "https") else ""


def normalize_thread_url(url: str) -> str:
    parsed = urlsplit((url or "").strip())
    if not parsed.scheme or not parsed.netloc:
        return url or ""
    clean_path = re.sub(r"/page\d+/?$", "", parsed.path.rstrip("/")) or "/"
    return urlunsplit((parsed.scheme, parsed.netloc, clean_path, "", ""))


def _extract_board_numeric_id(board_slug: str) -> str:
    m = re.match(r"^(\d+)", (board_slug or "").strip())
    return m.group(1) if m else ""


def _extract_img_url(base: str, attrs: dict[str, Any]) -> str:
    for attr in ("data-src", "data-original", "data-lazy-src", "data-lazy", "src"):
        cand = (attrs.get(attr) or "").strip()
        if not cand or is_placeholder_media_url(cand):
            continue
        url = _abs_board_url(base, cand)
        if url:
            return url
    return ""


def _board_role_for_id(board_id: str, descriptor: ForumDescriptor, board_name: str = "") -> str:
    bid = _extract_board_numeric_id(board_id) or board_id
    roles = descriptor.forum.get("boardRoles") or {}
    for role, ids in roles.items():
        if str(bid) in {str(x) for x in (ids or [])}:
            return str(role)
    low = f"{board_id or ''} {board_name or ''}".lower()
    if any(k in low for k in ("performer", "celebrity", "pornstar", "model", "social media")):
        return "artist_collections"
    if any(k in low for k in ("video", "movie", "clip")):
        return "video_releases"
    if "animated" in low or "gif" in low:
        return "gif_boards"
    if any(k in low for k in ("photo", "set", "gallery", "pic")):
        return "album_sets"
    return "discussions"


def _safe_re_search(pattern: str, text: str) -> bool:
    if not pattern:
        return False
    try:
        return bool(re.search(pattern, text, re.IGNORECASE))
    except re.error:
        return False


def _is_excluded_board(board_slug: str, board_title: str, descriptor: ForumDescriptor) -> bool:
    bid = _extract_board_numeric_id(board_slug)
    excluded_ids = {str(x) for x in (descriptor.forum.get("excludedBoardIds") or ())}
    if bid and bid in excluded_ids:
        return True
    excl_re = str(descriptor.forum.get("excludedTitleRegex") or "").strip()
    if _safe_re_search(excl_re, f"{board_slug} {board_title}"):
        return True
    return False


def _is_dynamic_viewer_url(url: str) -> bool:
    if is_image_viewer_url(url):
        return True
    host = (urlsplit(url or "").hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path_low = (urlsplit(url or "").path or "/").lower()
    for rule in list_image_host_rules():
        if not rule.matches_host(host):
            continue
        if rule.direct_host_regex and _safe_re_search(rule.direct_host_regex, host):
            return False
        if any(path_low.startswith(p.lower()) for p in rule.viewer_path_prefixes):
            return True
        if rule.viewer_path_regex and _safe_re_search(rule.viewer_path_regex, path_low):
            return True
    return False


def _is_release_mirror_url(url: str, descriptor: ForumDescriptor) -> bool:
    host = (urlsplit(url or "").hostname or "").lower()
    if not host:
        return False
    mirror_hosts = tuple(str(h).lower() for h in (descriptor.forum.get("mirrorHosts") or ()))
    if any(m in host for m in mirror_hosts):
        return True
    if _ARCHIVE_EXT_RE.search(urlsplit(url).path):
        return True
    return False


def extract_release_specs(text: str) -> list[str]:
    found: list[str] = []
    for m in _RELEASE_SPEC_RE.findall(text or ""):
        raw = m.strip()
        low = raw.lower()
        token = low if low.endswith("p") else raw.upper()
        if token and token not in found:
            found.append(token)
    return found[:6]


def classify_thread_kind(
    title: str,
    *,
    board_role: str = "",
    host_hints: list[str] | None = None,
    inline_image_count: int = 0,
    release_link_count: int = 0,
    text_blob: str = "",
) -> str:
    if board_role == "artist_collections":
        return "artist_collection"
    combined = f"{title} {text_blob}".strip()
    has_video_specs = bool(_RELEASE_SPEC_RE.search(combined))
    has_album_count = bool(_ALBUM_COUNT_RE.search(combined))

    if board_role == "video_releases":
        return "video_release"
    if has_video_specs and inline_image_count < 5 and not has_album_count:
        return "video_release"
    if board_role == "link_drops" and inline_image_count < 4:
        return "download_pack"
    if release_link_count > 0 and inline_image_count <= 3 and not has_album_count:
        return "download_pack"
    if inline_image_count >= 4 or board_role == "album_sets" or has_album_count:
        return "inline_album"
    if release_link_count > 0:
        return "download_pack"
    return "inline_album" if (host_hints and not has_video_specs) else "discussion"


async def fetch_board_hierarchy(
    client: httpx.AsyncClient,
    descriptor: ForumDescriptor,
) -> list[dict[str, Any]]:
    base_url = descriptor.effective_base_url()
    idx_path = str(descriptor.forum.get("indexPath") or "/forum.php")
    headers = resolve_anti_hotlink_headers(base_url, referer=base_url)
    resp = await client.get(f"{base_url}{idx_path}", headers=headers)
    resp.raise_for_status()

    tree = LexborHTMLParser(resp.text or "")
    sections: list[dict[str, Any]] = []
    seen_boards: set[str] = set()

    cat_nodes = tree.css("ol#forums > li, li.forumbit_nopost")
    if not cat_nodes:
        cat_nodes = [tree.body] if tree.body is not None else []

    for idx, cat_node in enumerate(cat_nodes):
        head = cat_node.css_first(".forumtitle, h2, .categoryhead")
        raw_sec_title = (head.text(separator=" ", strip=True) if head is not None else "") or f"Section {idx + 1}"
        sec_title = re.sub(
            r"\s+(?:Threads\s*/\s*Posts|Last\s*Post|Threads|Posts)(?:\s+(?:Threads\s*/\s*Posts|Last\s*Post))*\s*$",
            "",
            raw_sec_title,
            flags=re.IGNORECASE,
        ).strip() or f"Section {idx + 1}"
        boards: list[dict[str, Any]] = []
        for a in cat_node.css('a[href*="forums/"]'):
            raw_href = a.attributes.get("href") or ""
            abs_href = _abs_board_url(base_url, raw_href)
            if not abs_href:
                continue
            path_slug = urlsplit(abs_href).path.strip("/").split("/")[-1]
            if not path_slug or path_slug in seen_boards:
                continue
            b_title = (a.text(strip=True) or path_slug).strip()
            if _is_excluded_board(path_slug, b_title, descriptor):
                continue
            seen_boards.add(path_slug)
            role = _board_role_for_id(path_slug, descriptor)
            boards.append({
                "id": path_slug,
                "boardId": _extract_board_numeric_id(path_slug),
                "name": b_title,
                "url": _abs_board_url(base_url, f"forums/{path_slug}"),
                "role": role,
            })
        if boards:
            sections.append({"title": sec_title, "boards": boards})
    return sections


def parse_board_threads(
    html: str,
    descriptor: ForumDescriptor,
    *,
    board_role: str = "",
    category_filter: str = "",
    current_page: int = 1,
) -> tuple[list[dict[str, Any]], str | None, str | None]:
    from .timeline_search_providers import make_item_entry

    base_url = descriptor.effective_base_url()
    tree = LexborHTMLParser(html or "")
    base_tag = tree.css_first("base[href]")
    eff_base = _abs_board_url(base_url, base_tag.attributes.get("href")) if base_tag is not None else base_url

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    rows = tree.css("li.threadbit, tr[id^='thread_'], div.activitybit, div.threadbit")
    if not rows:
        rows = tree.css("#threads li, #searchbits li, .blockbody li")

    mirror_hosts = tuple(str(h).lower() for h in (descriptor.forum.get("mirrorHosts") or ()))

    for row in rows:
        a_title = row.css_first('a.title[href*="threads/"]')
        if a_title is None:
            for cand_a in row.css('a[href*="threads/"]'):
                if (cand_a.text(separator=" ", strip=True) or "").strip():
                    a_title = cand_a
                    break
            if a_title is None:
                a_title = row.css_first('a[href*="threads/"]')
        if a_title is None:
            continue
        raw_t_url = _abs_board_url(eff_base, a_title.attributes.get("href"))
        t_url = normalize_thread_url(raw_t_url)
        if not t_url or "/threads/" not in urlsplit(t_url).path.lower() or t_url in seen:
            continue
        seen.add(t_url)

        title = (a_title.text(separator=" ", strip=True) or "").strip()
        if not title or title.lower() == "thread":
            slug_part = urlsplit(t_url).path.strip("/").split("/")[-1]
            slug_part = re.sub(r"^\d+-", "", slug_part)
            title = re.sub(r"[-_]+", " ", slug_part).strip() or "Thread"
        if re.match(
            r"^(?:guidelines\s*(?:&|and)\s*rules|section\s+specific\s+rules|forum\s+rules|posting\s+rules|read\s+before\s+posting|important:?\s+rules?)\b",
            title,
            re.IGNORECASE,
        ):
            continue
        author_el = row.css_first("a.username, .author a, a[href*='members/']")
        author_name = (author_el.text(strip=True) if author_el is not None else "") or descriptor.display_name
        author_url = _abs_board_url(eff_base, author_el.attributes.get("href")) if author_el is not None else ""
        forum_el = row.css_first('a[href*="forums/"]')
        row_board_slug = urlsplit(forum_el.attributes.get("href") or "").path.strip("/").split("/")[-1] if forum_el is not None else ""
        row_board_name = (forum_el.text(strip=True) or "").strip() if forum_el is not None else ""
        row_board_url = _abs_board_url(eff_base, forum_el.attributes.get("href")) if forum_el is not None else ""
        eff_role = board_role or (_board_role_for_id(row_board_slug, descriptor, row_board_name) if row_board_slug else "")

        if row_board_slug and _is_excluded_board(row_board_slug, row_board_name, descriptor):
            continue

        row_text = row.text(separator=" ", strip=True)
        host_tokens = [
            d.lower() for rule in list_image_host_rules() for d in rule.domains
        ] + [str(t).lower() for t in (descriptor.forum.get("extraHostTokens") or ())]
        search_blob = f"{row_text} {title}".lower()
        hosts = [h for h in dict.fromkeys(host_tokens) if h and h in search_blob]
        has_gif_token = bool(re.search(r"\b(?:gif|webm|gfy)\b", search_blob))
        specs = extract_release_specs(f"{title} {row_text}")
        has_mirror_hint = any(m in row_text.lower() for m in mirror_hosts)
        thread_kind = classify_thread_kind(
            title,
            board_role=eff_role,
            host_hints=hosts,
            inline_image_count=10 if _ALBUM_COUNT_RE.search(title) else 0,
            release_link_count=1 if has_mirror_hint else 0,
            text_blob=row_text,
        )

        # Enforce strict category filtering when browsing Albums vs Videos vs Posts
        if category_filter == "albums" and thread_kind == "video_release":
            continue
        if category_filter == "videos" and thread_kind != "video_release":
            continue

        is_gif_row = category_filter == "gifs" or eff_role == "gif_boards" or has_gif_token
        resolved_item_type: Literal["album", "gif", "text"] = (
            "gif" if is_gif_row and category_filter != "posts" else ("text" if category_filter == "posts" else "album")
        )

        entry = make_item_entry(
            source_id=descriptor.id,
            item_id=f"{descriptor.id}_{hashlib.sha1(t_url.encode()).hexdigest()[:12]}",
            item_type=resolved_item_type,
            title=title,
            original_url=t_url,
            thumbnail="",
            creator_name=author_name,
            creator_handle=author_name.lower().replace(" ", "") if author_el is not None else descriptor.id,
            source_page=author_url or t_url,
            album_url=t_url,
            neutral_label=descriptor.display_name,
        )
        entry["mediaType"] = "gif" if is_gif_row else ("video_release" if thread_kind == "video_release" else ("post" if resolved_item_type == "text" else "album"))
        entry["threadKind"] = thread_kind
        if row_board_name:
            entry["boardName"] = row_board_name
        if row_board_url:
            entry["boardUrl"] = row_board_url
        if specs:
            entry["releaseSpecs"] = specs
        if hosts:
            entry["hosts"] = hosts
        m_replies = re.search(r"Replies:\s*([\d,]+)", row_text, re.IGNORECASE)
        if m_replies:
            entry["replyCount"] = int(m_replies.group(1).replace(",", ""))
        max_pg = 1
        for pg_link in row.css('.threaddpagenav a[href*="page"], .pagination a[href*="page"]'):
            m_pg = re.search(r"/page(\d+)\b", pg_link.attributes.get("href") or "", re.IGNORECASE)
            if m_pg:
                max_pg = max(max_pg, int(m_pg.group(1)))
        if max_pg > 1:
            entry["totalPages"] = max_pg
        items.append(entry)

    next_page_url: str | None = None
    search_id: str | None = None
    active_page = max(1, int(current_page or 1))
    curr_nav = tree.css_first(".pagenav span.selected, .pagenav strong, div.pagination .selected")
    if curr_nav is not None:
        m_curr = re.search(r"(\d+)", curr_nav.text(strip=True) or "")
        if m_curr:
            active_page = max(1, int(m_curr.group(1)))
    next_num = active_page + 1
    next_page_re = re.compile(rf"(?:[?&]page={next_num}\b|/page{next_num}\b)", re.IGNORECASE)
    for pnav_a in tree.css(".pagenav a[href], .pagination a[href], a[rel='next']"):
        p_href = _abs_board_url(eff_base, pnav_a.attributes.get("href"))
        if not p_href:
            continue
        if not search_id:
            m_sid = re.search(r"searchid=(\d+)", p_href)
            if m_sid:
                search_id = m_sid.group(1)
        if not next_page_url and (pnav_a.attributes.get("rel") == "next" or next_page_re.search(p_href)):
            next_page_url = p_href

    return items, next_page_url, search_id


def parse_forum_thread_page(
    html: str,
    page_url: str,
    descriptor: ForumDescriptor | None = None,
) -> dict[str, Any]:
    tree = LexborHTMLParser(html or "")
    base_tag = tree.css_first("base[href]")
    eff_base = _abs_board_url(page_url, base_tag.attributes.get("href")) if base_tag is not None else page_url
    h1 = tree.css_first("h1, span.threadtitle, title")
    thread_title = (h1.text(separator=" ", strip=True) if h1 is not None else "") or "Thread"

    breadcrumb_links = [
        {
            "name": (a.text(strip=True) or "").strip(),
            "url": _abs_board_url(eff_base, a.attributes.get("href")),
        }
        for a in tree.css('.breadcrumb a[href*="forums/"], nav.breadcrumb a[href*="forums/"]')
        if (a.text(strip=True) or "").strip()
    ]
    board_slug = urlsplit(breadcrumb_links[-1]["url"]).path.strip("/").split("/")[-1] if breadcrumb_links else ""
    board_role = _board_role_for_id(board_slug, descriptor) if (descriptor and board_slug) else ""

    # Pagination
    current_page = 1
    m_cur = re.search(r"/page(\d+)(?:/|\?|$)", urlsplit(page_url).path, re.IGNORECASE)
    if m_cur:
        current_page = int(m_cur.group(1))
    total_pages = current_page
    next_page_url: str | None = None
    for p_node in tree.css(".pagenav span, .pagenav a[href], .pagination a[href]"):
        txt = (p_node.text(strip=True) or "").strip()
        m_of = re.search(r"Page\s+(\d+)\s+of\s+(\d+)", txt, re.IGNORECASE)
        if m_of:
            current_page = int(m_of.group(1))
            total_pages = max(total_pages, int(m_of.group(2)))
        href_p = _abs_board_url(eff_base, p_node.attributes.get("href")) if p_node.tag == "a" else ""
        if href_p:
            m_pg = re.search(r"/page(\d+)(?:/|\?|$)", urlsplit(href_p).path, re.IGNORECASE)
            if m_pg:
                pg_n = int(m_pg.group(1))
                total_pages = max(total_pages, pg_n)
                if pg_n == current_page + 1 and not next_page_url:
                    next_page_url = href_p
    if total_pages > current_page and not next_page_url:
        base_t = normalize_thread_url(page_url)
        next_page_url = f"{base_t.rstrip('/')}/page{current_page + 1}"

    post_containers = tree.css("li.postbitlegacy, div.postbitlegacy, div[id^='post_']")
    if not post_containers:
        post_containers = tree.css("blockquote.postcontent, div[id^='post_message_']")

    all_photos: list[dict[str, Any]] = []
    seen_photo_keys: set[str] = set()
    seen_thumbs: set[str] = set()
    posts_out: list[dict[str, Any]] = []
    all_specs: list[str] = []
    total_release_links = 0

    for idx, container in enumerate(post_containers):
        body = container.css_first("blockquote.postcontent, div[id^='post_message_']") or container
        author_el = container.css_first("a.username, .userinfo a[href*='members/']")
        author_name = (author_el.text(strip=True) if author_el is not None else "") or ""
        author_url = _abs_board_url(eff_base, author_el.attributes.get("href")) if author_el is not None else ""
        date_el = container.css_first(".postdate .date, .posthead .date, span.date")
        date_str = (date_el.text(separator=" ", strip=True) if date_el is not None else "") or ""

        post_photos: list[dict[str, Any]] = []

        # Single pass over images in DOM order (handles both wrapped <a><img></a> and standalone [IMG])
        for img in body.css("img"):
            thumb = _extract_img_url(eff_base, img.attributes)
            if not thumb or thumb in seen_thumbs:
                continue
            seen_thumbs.add(thumb)

            anchor = None
            curr = img.parent
            while curr is not None and curr != body:
                if curr.tag == "a" and curr.attributes.get("href"):
                    anchor = curr
                    break
                curr = curr.parent

            if anchor is not None:
                href = _abs_board_url(eff_base, anchor.attributes.get("href"))
                href_is_viewer = bool(href and _is_dynamic_viewer_url(href))
                href_is_direct = bool(href and not href_is_viewer and not is_placeholder_media_url(href) and _IMAGE_EXT_RE.search(urlsplit(href).path))
                if href_is_viewer:
                    orig_url, resolved_flag, page_target = "", False, href
                elif href_is_direct:
                    orig_url, resolved_flag, page_target = href, True, href
                else:
                    orig_url, resolved_flag, page_target = "", False, href or page_url
                key = f"{page_target}::{thumb}"
            else:
                is_viewer = _is_dynamic_viewer_url(thumb)
                orig_url = "" if is_viewer else thumb
                resolved_flag = not is_viewer
                page_target = thumb if is_viewer else page_url
                key = f"inline::{thumb}"

            if key in seen_photo_keys:
                continue
            seen_photo_keys.add(key)
            p_item = {
                "id": "photo-" + hashlib.sha256(key.encode()).hexdigest()[:16],
                "title": (img.attributes.get("alt") or thread_title).strip(),
                "thumbnailUrl": thumb,
                "originalUrl": orig_url,
                "pageUrl": page_target,
                "sourcePage": page_url,
                "type": "gif" if ".gif" in thumb.lower() else "photo",
                "isAnimated": ".gif" in thumb.lower(),
                "isResolvedOriginal": resolved_flag,
            }
            all_photos.append(p_item)
            post_photos.append(p_item)

        # 3. External filehost download mirrors & clean post text
        release_links: list[dict[str, str]] = []
        seen_links: set[str] = set()
        for a in body.css("a[href]"):
            if a.css_first("img") is not None:
                continue
            href = _abs_board_url(eff_base, a.attributes.get("href"))
            if not href or href in seen_links:
                continue
            if descriptor and _is_release_mirror_url(href, descriptor):
                seen_links.add(href)
                host = (urlsplit(href).hostname or "").lower()
                if host.startswith("www."):
                    host = host[4:]
                label = (a.text(strip=True) or host or "Download").strip()
                release_links.append({"host": host, "url": href, "label": label})

        total_release_links += len(release_links)
        text_body = body.text(separator=" ", strip=True)
        for sp in extract_release_specs(f"{thread_title} {text_body}"):
            if sp not in all_specs:
                all_specs.append(sp)

        posts_out.append({
            "id": container.attributes.get("id") or f"post-{idx + 1}",
            "author": author_name,
            "authorUrl": author_url,
            "date": date_str,
            "text": text_body[:2000],
            "photos": post_photos,
            "releaseLinks": release_links,
        })

    thread_kind = classify_thread_kind(
        thread_title,
        board_role=board_role,
        inline_image_count=len(all_photos),
        release_link_count=total_release_links,
        text_blob=" ".join(p["text"][:300] for p in posts_out[:3]),
    )
    has_more = bool(next_page_url or total_pages > current_page)
    return {
        "success": True,
        "threadUrl": normalize_thread_url(page_url),
        "pageUrl": page_url,
        "title": thread_title,
        "author": posts_out[0]["author"] if posts_out and posts_out[0]["author"] else "",
        "authorUrl": posts_out[0]["authorUrl"] if posts_out and posts_out[0]["authorUrl"] else "",
        "breadcrumbs": breadcrumb_links,
        "threadKind": thread_kind,
        "releaseSpecs": all_specs,
        "photos": all_photos,
        "count": len(all_photos),
        "posts": posts_out,
        "currentPage": current_page,
        "totalPages": total_pages,
        "hasMore": has_more,
        "nextPageUrl": next_page_url,
        "paginationComplete": not has_more,
    }


def _extract_child_subforum_urls(
    html: str,
    base_url: str,
    parent_slug: str,
    descriptor: ForumDescriptor,
) -> list[tuple[str, str]]:
    tree = LexborHTMLParser(html or "")
    parent_id = _extract_board_numeric_id(parent_slug)
    found: list[tuple[str, str]] = []
    seen_ids: set[str] = set()
    for a in tree.css('h2.forumtitle a[href*="forums/"], .subforum a[href*="forums/"], ol.childforum a[href*="forums/"]'):
        href = _abs_board_url(base_url, a.attributes.get("href"))
        if not href:
            continue
        slug = urlsplit(href).path.strip("/").split("/")[-1]
        bid = _extract_board_numeric_id(slug)
        if not slug or (parent_id and bid == parent_id) or slug == parent_slug:
            continue
        dedup_key = bid or slug
        if dedup_key in seen_ids:
            continue
        title = (a.text(strip=True) or slug).strip()
        if _is_excluded_board(slug, title, descriptor) or "archive" in f"{slug} {title}".lower():
            continue
        seen_ids.add(dedup_key)
        found.append((slug, href))
    return found


def _default_boards_for_category(category: str, descriptor: ForumDescriptor) -> list[str]:
    roles = descriptor.forum.get("boardRoles") or {}
    role_key = {
        "albums": "album_sets",
        "videos": "video_releases",
        "gifs": "gif_boards",
        "posts": "link_drops",
        "profiles": "artist_collections",
        "recent": "album_sets",
    }.get(category, "album_sets")
    ids = roles.get(role_key) or []
    return [str(x) for x in ids if str(x).strip()]


def _default_board_for_category(category: str, descriptor: ForumDescriptor) -> str:
    ids = _default_boards_for_category(category, descriptor)
    return ids[0] if ids else ""


async def browse_forum_board(
    client: httpx.AsyncClient,
    descriptor: ForumDescriptor,
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
    cat = (category or descriptor.default_category).strip().lower()
    sub = (subfilter or "").strip()
    headers = resolve_anti_hotlink_headers(base_url, referer=base_url)

    try:
        next_url = cur.get("url")
        board_role = str(cur.get("board_role") or "")
        current_page = int(cur.get("page") or 1)
        if next_url:
            resp = await client.get(str(next_url), headers=headers)
        elif sub:
            board_slug = sub
            board_role = _board_role_for_id(board_slug, descriptor)
            resp = await client.get(f"{base_url}/forums/{board_slug}", headers=headers)
        elif cat == "gifs":
            board_slug = _default_board_for_category("gifs", descriptor)
            if board_slug:
                board_role = "gif_boards"
                resp = await client.get(f"{base_url}/forums/{board_slug}", headers=headers)
            else:
                search_proc = str(descriptor.forum.get("searchProcessPath") or "/search.php?contenttype=1&do=process")
                post_headers = {**headers, "Origin": base_url, "Referer": f"{base_url}/search.php"}
                resp = await client.post(
                    f"{base_url}{search_proc}",
                    data={"securitytoken": "guest", "query": "gif OR webm OR gfy", "imgsearch": "1"},
                    headers=post_headers,
                )
        else:
            # Prefer role-specific curated board listings over mixed activity feed
            target_bid = _default_board_for_category(cat, descriptor)
            sections = await fetch_board_hierarchy(client, descriptor) if not target_bid else []
            matching_board = None
            for sec in sections:
                for b in sec["boards"]:
                    if b["boardId"] == target_bid or b["id"] == target_bid:
                        matching_board = b
                        break
            if matching_board:
                board_role = matching_board["role"]
                resp = await client.get(matching_board["url"], headers=headers)
            elif target_bid:
                # Look up full slug from hierarchy or request direct forum ID path
                board_role = _board_role_for_id(target_bid, descriptor)
                resp = await client.get(f"{base_url}/forums/{target_bid}", headers=headers)
                if resp.status_code == 404:
                    sections2 = await fetch_board_hierarchy(client, descriptor)
                    found_u = None
                    for sec in sections2:
                        for b in sec["boards"]:
                            if b["boardId"] == target_bid:
                                found_u = b["url"]
                                board_role = b["role"]
                                break
                        if found_u:
                            break
                    if found_u:
                        resp = await client.get(found_u, headers=headers)
            else:
                daily = str(descriptor.forum.get("dailyPath") or "/search.php?do=getdaily")
                resp = await client.get(f"{base_url}{daily}", headers=headers)

        resp.raise_for_status()
        items, found_next_url, _ = parse_board_threads(
            resp.text or "",
            descriptor,
            board_role=board_role,
            category_filter=cat,
            current_page=current_page,
        )
        # Generic parent-container board fallback: if the requested board holds child subforums
        # rather than direct threads (e.g. a top-level photo-sets container), automatically
        # follow the first active child subforum(s) so browsing never returns an empty feed.
        if not items and not next_url:
            child_boards = _extract_child_subforum_urls(
                resp.text or "",
                base_url,
                sub or _default_board_for_category(cat, descriptor),
                descriptor,
            )
            for child_slug, child_url in child_boards[:3]:
                try:
                    c_resp = await client.get(child_url, headers=headers)
                    if c_resp.status_code != 200:
                        continue
                    c_role = _board_role_for_id(child_slug, descriptor) or board_role
                    c_items, c_next, _ = parse_board_threads(
                        c_resp.text or "",
                        descriptor,
                        board_role=c_role,
                        category_filter=cat,
                        current_page=1,
                    )
                    if c_items:
                        items = c_items
                        found_next_url = c_next
                        board_role = c_role
                        break
                except Exception:
                    continue
        if not items and not next_url and not sub:
            for alt_bid in _default_boards_for_category(cat, descriptor)[1:4]:
                try:
                    a_resp = await client.get(f"{base_url}/forums/{alt_bid}", headers=headers)
                    if a_resp.status_code != 200:
                        continue
                    a_role = _board_role_for_id(alt_bid, descriptor) or board_role
                    a_items, a_next, _ = parse_board_threads(
                        a_resp.text or "",
                        descriptor,
                        board_role=a_role,
                        category_filter=cat,
                        current_page=1,
                    )
                    if a_items:
                        items = a_items
                        found_next_url = a_next
                        board_role = a_role
                        break
                except Exception:
                    continue
        next_cursor = encode_search_cursor({
            "url": found_next_url,
            "board_role": board_role,
            "page": current_page + 1,
        }) if (found_next_url and items) else None
        return BrowsePageResult(
            source_id=descriptor.id,
            category=cat,
            subfilter=sub or None,
            items=items[:limit],
            next_cursor=next_cursor,
            has_more=bool(next_cursor),
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


async def _fetch_coalesced_forum_search(
    client: httpx.AsyncClient,
    descriptor: ForumDescriptor,
    query: str,
    headers: dict[str, str],
    options: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], str | None, str | None]:
    opts = options or {}
    board_raw = str(opts.get("boardId") or opts.get("subfilter") or "").strip()
    board_num = _extract_board_numeric_id(board_raw)
    search_scope = str(opts.get("searchScope") or "titles").strip().lower()
    if search_scope not in ("titles", "posts"):
        search_scope = "titles"
    media_filter = str(opts.get("mediaFilter") or "all").strip().lower()
    if media_filter not in ("all", "images", "videos"):
        media_filter = "all"
    sort_by = str(opts.get("sortBy") or "relevance").strip().lower()
    if sort_by not in ("relevance", "recent", "replies"):
        sort_by = "relevance"

    q_norm = re.sub(r"\s+", " ", (query or "").strip()).lower()
    base_url = descriptor.effective_base_url()
    cache_key = f"{descriptor.id}::{base_url}::{q_norm}::b={board_num}::s={search_scope}::m={media_filter}::o={sort_by}"
    now = time.monotonic()
    cached = _FORUM_SEARCH_CACHE.get(cache_key)
    if cached and cached[0] > now:
        _FORUM_SEARCH_CACHE.move_to_end(cache_key)
        return cached[1]

    lock = _get_search_lock(cache_key)
    async with lock:
        now = time.monotonic()
        cached = _FORUM_SEARCH_CACHE.get(cache_key)
        if cached and cached[0] > now:
            _FORUM_SEARCH_CACHE.move_to_end(cache_key)
            return cached[1]

        raw_q = (query or "").strip()
        quoted_q = (
            f'"{raw_q}"'
            if (" " in raw_q and '"' not in raw_q and " OR " not in raw_q)
            else raw_q
        )
        default_flags = dict(descriptor.forum.get("defaultSearchFlags") or {"threadtitleonly": "1"})
        proc_path = str(descriptor.forum.get("searchProcessPath") or "/search.php?contenttype=1&do=process")
        post_headers = {
            **headers,
            "Origin": base_url,
            "Referer": f"{base_url}/search.php?search_type=1",
            "Content-Type": "application/x-www-form-urlencoded",
        }
        has_custom_filters = bool(board_num or search_scope != "titles" or media_filter != "all" or sort_by != "relevance")
        board_role_hint = _board_role_for_id(board_num, descriptor) if board_num else ""

        async def _submit(q_text: str) -> tuple[list[dict[str, Any]], str | None, str | None, str]:
            payload: list[tuple[str, str]] = [
                ("securitytoken", "guest"),
                ("do", "process"),
                ("query", q_text),
            ]
            if has_custom_filters:
                payload.append(("search_type", "1"))
                payload.append(("contenttypeid", "1"))
                payload.append(("titleonly", "0" if search_scope == "posts" else "1"))
                if board_num:
                    payload.append(("forumchoice[]", board_num))
                    payload.append(("childforums", "1"))
                if media_filter == "images":
                    payload.append(("imgsearch", "1"))
                elif media_filter == "videos":
                    payload.append(("vidsearch", "1"))
                if sort_by == "recent":
                    payload.append(("sortby", "lastpost"))
                    payload.append(("order", "descending"))
                elif sort_by == "replies":
                    payload.append(("sortby", "replycount"))
                    payload.append(("order", "descending"))
                for k, v in default_flags.items():
                    if str(k).lower() in ("threadtitleonly", "titleonly", "sortby", "order", "imgsearch", "vidsearch"):
                        continue
                    payload.append((str(k), str(v)))
            else:
                for k, v in default_flags.items():
                    payload.append((str(k), str(v)))

            resp = await client.post(f"{base_url}{proc_path}", content=urlencode(payload), headers=post_headers)
            resp.raise_for_status()
            items, next_url, search_id = parse_board_threads(
                resp.text or "",
                descriptor,
                board_role=board_role_hint,
                category_filter="",
            )
            if not search_id:
                m_sid = re.search(r"searchid=(\d+)", str(resp.url or ""))
                if m_sid:
                    search_id = m_sid.group(1)
            return items, next_url, search_id, resp.text or ""

        items, next_url, search_id, html_body = await _submit(quoted_q)
        # If flood-limited ("try again in N seconds"), pause briefly and retry once
        if not items:
            m_wait = re.search(r"try again in\s+(\d+)\s+second", html_body, re.IGNORECASE)
            if m_wait:
                wait_s = min(max(int(m_wait.group(1)), 1), 4) + 0.3
                await asyncio.sleep(wait_s)
                items, next_url, search_id, html_body = await _submit(quoted_q)
        # If quoted multi-word search yielded 0 rows, retry unquoted once (respecting flood cooldown)
        if not items and quoted_q != raw_q:
            await asyncio.sleep(2.3)
            items, next_url, search_id, _ = await _submit(raw_q)

        if sort_by == "replies" and items:
            items = sorted(items, key=lambda it: int(it.get("replyCount") or 0), reverse=True)

        result = (items, next_url, search_id)
        if items:
            _FORUM_SEARCH_CACHE[cache_key] = (time.monotonic() + _FORUM_SEARCH_CACHE_TTL_S, result)
            _FORUM_SEARCH_CACHE.move_to_end(cache_key)
            while len(_FORUM_SEARCH_CACHE) > _FORUM_SEARCH_CACHE_MAX:
                _FORUM_SEARCH_CACHE.popitem(last=False)
        return result


def _slice_forum_search_items_by_category(items: list[dict[str, Any]], category: str) -> list[dict[str, Any]]:
    cat = (category or "").strip().lower()
    if cat == "albums":
        return [it for it in items if it.get("threadKind") == "inline_album" and it.get("mediaType") != "gif"]
    if cat == "videos":
        return [it for it in items if it.get("threadKind") == "video_release"]
    if cat == "gifs":
        return [it for it in items if it.get("mediaType") == "gif" or it.get("type") == "gif"]
    if cat == "profiles":
        return [it for it in items if it.get("threadKind") == "artist_collection"]
    if cat == "posts":
        non_media = [
            it for it in items
            if it.get("threadKind") in ("download_pack", "discussion")
        ]
        return non_media if non_media else [it for it in items if it.get("threadKind") != "artist_collection"]
    return list(items)


async def search_forum_board(
    client: httpx.AsyncClient,
    descriptor: ForumDescriptor,
    query: str,
    category: str,
    *,
    cursor: str | None = None,
    options: dict[str, Any] | None = None,
):
    from .timeline_search_providers import SearchPageResult, decode_search_cursor, encode_search_cursor, make_profile_entry

    q = (query or "").strip()
    if not q:
        return SearchPageResult(descriptor.id, category)
    base_url = descriptor.effective_base_url()
    cur = decode_search_cursor(cursor)
    headers = resolve_anti_hotlink_headers(base_url, referer=base_url)
    opts = options or {}

    try:
        use_coalesced = bool(descriptor.forum.get("coalesceTitleSearch"))
        board_raw = str(opts.get("boardId") or opts.get("subfilter") or "").strip()
        board_num = _extract_board_numeric_id(board_raw)
        board_role_hint = _board_role_for_id(board_num, descriptor) if board_num else ""
        if cur.get("searchid"):
            page = int(cur.get("page") or 2)
            resp = await client.get(f"{base_url}/search.php?searchid={cur['searchid']}&pp=25&page={page}", headers=headers)
            resp.raise_for_status()
            if use_coalesced:
                all_items, next_url, search_id = parse_board_threads(
                    resp.text or "",
                    descriptor,
                    board_role=board_role_hint,
                    category_filter="",
                    current_page=page,
                )
                items = _slice_forum_search_items_by_category(all_items, category)
            else:
                cat_filter = "" if category in ("profiles", "posts") else category
                items, next_url, search_id = parse_board_threads(
                    resp.text or "",
                    descriptor,
                    board_role=board_role_hint,
                    category_filter=cat_filter,
                    current_page=page,
                )
        elif use_coalesced:
            all_items, next_url, search_id = await _fetch_coalesced_forum_search(client, descriptor, q, headers, options=opts)
            items = _slice_forum_search_items_by_category(all_items, category)
        else:
            flags_map = descriptor.forum.get("searchFlagsByCategory") or {}
            cat_flags = dict(flags_map.get(category) or {})
            q_eff = q
            suffix = cat_flags.pop("querySuffix", "")
            if suffix:
                q_eff = f"{q}{suffix}"
            payload: list[tuple[str, str]] = [
                ("securitytoken", "guest"),
                ("do", "process"),
                ("query", q_eff),
            ]
            if board_num:
                payload.append(("search_type", "1"))
                payload.append(("contenttypeid", "1"))
                payload.append(("forumchoice[]", board_num))
                payload.append(("childforums", "1"))
            for k, v in cat_flags.items():
                if k == "forumchoice" and isinstance(v, list):
                    if not board_num:
                        for fid in v:
                            payload.append(("forumchoice[]", str(fid)))
                else:
                    payload.append((str(k), str(v)))

            proc_path = str(descriptor.forum.get("searchProcessPath") or "/search.php?contenttype=1&do=process")
            post_headers = {
                **headers,
                "Origin": base_url,
                "Referer": f"{base_url}/search.php",
                "Content-Type": "application/x-www-form-urlencoded",
            }
            resp = await client.post(f"{base_url}{proc_path}", content=urlencode(payload), headers=post_headers)
            resp.raise_for_status()
            cat_filter = "" if category in ("profiles", "posts") else category
            items, next_url, search_id = parse_board_threads(resp.text or "", descriptor, category_filter=cat_filter)

        next_page = int(cur.get("page") or 1) + 1
        next_cur = encode_search_cursor({"searchid": search_id, "page": next_page}) if (search_id and next_url) else None
        if category == "profiles":
            profiles: list[dict[str, Any]] = []
            seen_prof: set[str] = set()
            for it in items:
                p_url = it.get("albumUrl") or it.get("sourcePage") or ""
                if not p_url or p_url in seen_prof:
                    continue
                seen_prof.add(p_url)
                profiles.append(
                    make_profile_entry(
                        source_id=descriptor.id,
                        entry_id=it["id"],
                        name=it["title"],
                        profile_url=p_url,
                        handle=f"@{descriptor.id}",
                        avatar=it.get("thumbnail") or "",
                    )
                )
            return SearchPageResult(descriptor.id, "profiles", profiles=profiles, next_cursor=next_cur, has_more=bool(next_cur))

        return SearchPageResult(descriptor.id, category, items=items, next_cursor=next_cur if items else None, has_more=bool(items and next_cur))
    except Exception as exc:
        return SearchPageResult(descriptor.id, category, error=str(exc))
