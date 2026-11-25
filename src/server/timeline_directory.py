"""Shared directory discovery for remote Timeline connectors."""
from __future__ import annotations

import asyncio
import re
import unicodedata
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote, quote_plus, unquote, urljoin, urlsplit

import httpx

from .original_image_resolver import is_placeholder_media_url

_IMAGE_ATTRIBUTES = (
    "data-src", "data-original", "data-lazy-src", "data-lazy", "data-thumbnail",
    "data-image", "data-bg", "data-background-image", "data-srcset", "srcset", "src",
)
_BACKGROUND_IMAGE = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)
_PAGE_SELECTOR = "nav a[href], .pagination a[href], .pager a[href], .nav-links a[href]"
_PAGES_PER_SEARCH = 6
_SEARCH_BUDGET = 9.0


def directory_thumbnail(
    card: Any,
    base_url: str,
    *,
    selector: str = "",
    attributes: tuple[str, ...] = (),
    is_placeholder: Callable[[str], bool] = is_placeholder_media_url,
) -> str:
    if selector:
        nodes = card.css(selector)
    else:
        nodes = []
    nodes = [*nodes, *card.css("img, picture source, [data-image], [data-thumbnail], [data-bg], [data-background-image], [style]"), card]
    attrs = tuple(dict.fromkeys((*attributes, *_IMAGE_ATTRIBUTES)))
    for node in nodes:
        for attr in (*attrs, "style"):
            raw = (node.attributes.get(attr) or "").strip()
            if not raw or raw.startswith(("data:", "#")):
                continue
            if attr.endswith("srcset"):
                candidate, *_ = raw.split(",", 1)[0].split(maxsplit=1) or [""]
                raw = candidate
            if attr == "style" or raw.lower().startswith("url("):
                match = _BACKGROUND_IMAGE.search(raw)
                raw = match.group(2) if match else ""
            if not raw or is_placeholder(raw):
                continue
            href = urljoin(base_url, raw)
            if urlsplit(href).scheme in ("https", "http") and not is_placeholder(href):
                return href
    return ""


def valid_directory_url(base_url: str, raw: str) -> str:
    url = urljoin(base_url, raw)
    parsed = urlsplit(url)
    if parsed.scheme in ("http", "https") and parsed.netloc == urlsplit(base_url).netloc:
        return parsed._replace(fragment="").geturl()
    return ""


def directory_next_url(tree: Any, base_url: str, page: int, rule: dict[str, Any]) -> str:
    next_selector = str(rule.get("hasNextSelector") or "")
    selector = "a[rel~=next][href], link[rel~=next][href]"
    if next_selector:
        selector = f"{selector}, {next_selector}"
    for node in tree.css(selector):
        link = node if node.attributes.get("href") else node.css_first("a[href]")
        if link is not None and (raw := link.attributes.get("href")):
            if (url := valid_directory_url(base_url, raw)) and url != base_url:
                return url

    page_selector = str(rule.get("paginationSelector") or _PAGE_SELECTOR)
    for node in tree.css(page_selector):
        if node.text(strip=True) == str(page + 1) and (raw := node.attributes.get("href")):
            if (url := valid_directory_url(base_url, raw)) and url != base_url:
                return url

    path = re.sub(r"/\d+$", "", urlsplit(base_url).path.rstrip("/"))
    for node in tree.css("a[href]"):
        if node.text(strip=True) != str(page + 1):
            continue
        url = valid_directory_url(base_url, node.attributes.get("href") or "")
        if url and url != base_url and re.sub(r"/\d+$", "", urlsplit(url).path.rstrip("/")) == path:
            return url
    return ""


def directory_path(template: str, page: int, *, zero_based: bool = False, query: str = "", subfilter: str = "") -> str:
    return template.format(
        page=page,
        page_zero=page - 1 if zero_based else page,
        query=quote(query, safe=""),
        query_plus=quote_plus(query),
        slug="-".join(_name_key(query).split()),
        subfilter=subfilter,
    )


def _name_key(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value.casefold())
    return " ".join(re.findall(r"[^\W_]+", "".join(c for c in folded if not unicodedata.combining(c))))


async def search_directory_profiles(
    source_id: str,
    query: str,
    directories: dict[str, Any],
    fetch_page: Callable[..., Awaitable[dict[str, Any]]],
    *,
    cursor: str | None = None,
    suggestions: list[dict[str, Any]] | None = None,
):
    from .timeline_search_providers import SearchPageResult, decode_search_cursor, encode_search_cursor, make_profile_entry

    raw_state = decode_search_cursor(cursor).get("directories") if cursor else None
    kinds = [kind for kind in ("artists", "channels", "categories") if kind in directories]
    state = raw_state if isinstance(raw_state, dict) else {kind: {"page": 1} for kind in kinds}
    name_key = _name_key(query)
    deadline = asyncio.get_running_loop().time() + _SEARCH_BUDGET

    async def scan(kind: str, position: dict[str, Any]):
        page = max(1, int(position.get("page") or 1))
        next_url = str(position.get("url") or "")
        rule = directories[kind]
        native_search = isinstance(rule, dict) and bool(rule.get("searchPathTemplate"))
        matches: list[dict[str, Any]] = []
        seen_pages: set[tuple[str, ...]] = set()
        error = None
        for _ in range(_PAGES_PER_SEARCH):
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            try:
                result = await asyncio.wait_for(
                    fetch_page(kind, page=page, page_url=next_url, query=query if native_search else ""),
                    timeout=remaining,
                )
            except httpx.HTTPStatusError as exc:
                if page > 1 and exc.response.status_code in (404, 410):
                    return matches, None, None
                error = "directory_unavailable"
                break
            except (TimeoutError, httpx.HTTPError):
                error = "directory_unavailable"
                break

            items = result.get("items") or []
            signature = tuple(item["url"] for item in items)
            if signature and signature in seen_pages:
                return matches, None, None
            seen_pages.add(signature)
            for item in items:
                path = unquote(urlsplit(item["url"]).path).rstrip("/").rsplit("/", 1)[-1]
                if native_search or (name_key and (name_key in _name_key(item["name"]) or name_key in _name_key(path))):
                    matches.append(make_profile_entry(
                        source_id=source_id,
                        entry_id=f"{source_id}:{kind}:{item['id']}",
                        name=item["name"],
                        profile_url=item["url"],
                        avatar=item.get("avatar") or item.get("thumbnailUrl") or "",
                        verified=item.get("verified", False),
                        subscribers_text=item.get("subscribersText") or "",
                        entity_kind=item.get("kind") or "",
                    ))
            if not result.get("hasMore"):
                return matches, None, None
            page += 1
            next_url = result.get("nextPageUrl") or ""
            if matches:
                break
        return matches, {"page": page, "url": next_url}, error

    active_kinds = [kind for kind in kinds if isinstance(state.get(kind), dict)]
    results = await asyncio.gather(*(scan(kind, state[kind]) for kind in active_kinds))
    profiles = {p["profileUrl"].rstrip("/"): p for p in suggestions or []}
    next_state = {}
    for kind, (matches, continuation, _) in zip(active_kinds, results):
        for match in matches:
            profiles.setdefault(match["profileUrl"].rstrip("/"), match)
        if continuation:
            next_state[kind] = continuation
    error = "directory_unavailable" if not profiles and results and all(result[2] for result in results) else None
    return SearchPageResult(
        source_id, "profiles", profiles=list(profiles.values()), error=error,
        next_cursor=encode_search_cursor({"directories": next_state}) if next_state else None,
        has_more=bool(next_state),
    )


async def search_adapted_directory_profiles(client: httpx.AsyncClient, source_id: str, origin_url: str, query: str, cursor: str | None):
    from ..core.network_profiles import resolve_anti_hotlink_headers
    from .profile_directory_manifest import ADAPTERS, DirectoryInputError

    adapter = next((item for item in ADAPTERS if item.adapter_id == source_id), None)
    if not adapter:
        return None
    try:
        directory_url = adapter.normalize_url(urljoin(origin_url, "/"), kind="directory")
    except DirectoryInputError:
        return None

    async def fetch_page(_kind: str, *, page: int, page_url: str, query: str) -> dict[str, Any]:
        target = (valid_directory_url(directory_url, page_url) if page_url else "") or directory_url
        target = adapter.normalize_url(target, kind="directory")
        response = await client.get(target, headers=resolve_anti_hotlink_headers(target, referer=directory_url))
        response.raise_for_status()
        parsed = adapter.parse(str(response.url), response.text)
        next_url = parsed.pagination.next_url
        return {
            "items": [
                {"id": item.key, "name": item.name, "url": item.source_url, "avatar": item.image_url}
                for item in parsed.items if item.name
            ],
            "hasMore": bool(next_url),
            "nextPageUrl": next_url,
        }

    return await search_directory_profiles(source_id, query, {"artists": {}}, fetch_page, cursor=cursor)
