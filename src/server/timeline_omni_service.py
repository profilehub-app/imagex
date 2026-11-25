"""Unified Timeline Omni-Search, X Profile/Tweet Metadata Enrichment, and YouTube Discovery Service."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
import json
import logging
import re
import time
from typing import Any, Literal
from urllib.parse import quote, quote_plus, unquote, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..core.network_profiles import resolve_anti_hotlink_headers

from .connector_autodiscover import (
    autodiscover_connector_for_url,
    delete_local_connector,
    export_connector_bundle,
    import_connector_bundle,
    list_local_connectors_summary,
)
from .connector_registry import (
    CatalogDescriptor,
    ForumDescriptor,
    VideoPortalDescriptor,
    find_connector_for_url,
    get_connector_descriptor,
)
from .forum_board_engine import fetch_board_hierarchy, parse_forum_thread_page
from .gallery_catalog_engine import enrich_catalog_items, list_catalog_directory, read_catalog_gallery_detail
from .video_portal_engine import list_video_portal_directory, read_portal_category_cover
from .profile_directory_transport import DEFAULT_TRANSPORT_HEADERS
from .profile_hub_execution_runtime import PublicHTTPSHttpxTransport
from .integrated_sources_service import (
    clear_integrated_sources,
    get_integrated_source_ids,
    integrate_url,
    list_supported_integration_catalog,
    load_integrated_sources,
    remove_integrated_source,
)
from .timeline_browse_providers import BrowsePageResult, get_browse_provider, list_browse_providers
from .timeline_search_providers import (
    ALL_SEARCH_CATEGORIES,
    SearchCategory,
    SearchPageResult,
    _FXTWITTER_HEADERS,
    _X_SEARCH_PROFILE_CACHE as _X_PROFILE_CACHE,
    _X_SEARCH_TWEET_CACHE as _X_TWEET_CACHE,
    _clean_x_handle,
    _fetch_x_tweet_info,
    _fetch_x_user_info,
    _parse_fxtwitter_tweet,
    _parse_fxtwitter_user,
    _parse_syndication_tweet,
    _parse_vxtwitter_tweet,
    _upgrade_x_avatar,
    get_search_provider,
    list_search_providers,
)
from .profile_hub_workers import (
    _best_yt_thumbnail,
    _extract_yt_initial_data,
    _normalize_yt_relative_date,
    _yt_text,
    extract_portal_grid_albums_lexbor,
    extract_portal_grid_videos_lexbor,
    extract_portal_tube_videos_lexbor,
    extract_portal_state_videos_lexbor,
    extract_youtube_videos_lexbor,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/profile-hub/timeline", tags=["timeline-omni"])

# In-memory bounded TTL caches so repeated timeline renders and profile opens are instantaneous.
_OMNI_SEARCH_CACHE: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_DIRECTORY_COVER_CACHE: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_YT_RECO_CACHE: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()

_CACHE_TTL_SECONDS = 600.0  # 10 minutes
_MAX_CACHE_ENTRIES = 128


def _cache_get(cache: OrderedDict[str, tuple[float, dict[str, Any]]], key: str, ttl: float) -> dict[str, Any] | None:
    entry = cache.get(key)
    if not entry:
        return None
    if (time.time() - entry[0]) >= ttl:
        cache.pop(key, None)
        return None
    cache.move_to_end(key)
    return entry[1]


def _cache_put(cache: OrderedDict[str, tuple[float, dict[str, Any]]], key: str, payload: dict[str, Any], ttl: float) -> None:
    now = time.time()
    cache[key] = (now, payload)
    cache.move_to_end(key)
    expired = [k for k, (ts, _) in cache.items() if (now - ts) >= ttl]
    for k in expired:
        cache.pop(k, None)
    while len(cache) > _MAX_CACHE_ENTRIES:
        cache.popitem(last=False)


def _connector_origins(conn: CatalogDescriptor | ForumDescriptor | VideoPortalDescriptor | None) -> list[str]:
    if conn is None:
        return []
    origins: list[str] = []
    seen: set[str] = set()
    for raw in [conn.effective_base_url(), *(f"https://{d.removeprefix('*.')}" for d in conn.domains)]:
        val = (raw or "").strip().rstrip("/")
        if val and val not in seen:
            seen.add(val)
            origins.append(val)
    return origins


class XBatchEnrichItem(BaseModel):
    id: str = ""
    handle: str = ""


class XBatchEnrichRequest(BaseModel):
    items: list[XBatchEnrichItem] = Field(default_factory=list)
    handles: list[str] = Field(default_factory=list)


@router.get("/x-profile-info")
async def get_x_profile_info(handle: str = Query(..., min_length=1)):
    clean = _clean_x_handle(handle)
    if not clean:
        return {"ok": False, "profile": None}
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    }
    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True, headers=headers) as client:
        profile = await _fetch_x_user_info(client, clean)
    return {"ok": bool(profile), "profile": profile}


@router.post("/x-batch-enrich")
async def batch_enrich_x_items(req: XBatchEnrichRequest):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    }
    tweets_out: dict[str, dict[str, Any]] = {}
    profiles_out: dict[str, dict[str, Any]] = {}
    sem = asyncio.Semaphore(8)

    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True, headers=headers) as client:
        async def _enrich_tweet(item: XBatchEnrichItem):
            async with sem:
                info = await _fetch_x_tweet_info(client, item.handle, item.id)
                if info and info.get("id"):
                    tweets_out[info["id"]] = info
                    prof = info.get("profile")
                    if isinstance(prof, dict) and prof.get("handle"):
                        profiles_out[prof["handle"].lstrip("@").lower()] = prof

        async def _enrich_handle(h: str):
            clean = _clean_x_handle(h)
            if not clean:
                return
            async with sem:
                prof = await _fetch_x_user_info(client, clean)
                if prof:
                    profiles_out[clean.lower()] = prof

        tweet_items = [it for it in req.items[:24] if it.id]
        handle_set = {
            _clean_x_handle(h).lower()
            for h in ([*(it.handle for it in req.items if not it.id), *req.handles])
            if _clean_x_handle(h)
        }
        await asyncio.gather(
            *(_enrich_tweet(it) for it in tweet_items),
            *(_enrich_handle(h) for h in list(handle_set)[:20]),
            return_exceptions=True,
        )

    return {"ok": True, "tweets": tweets_out, "profiles": profiles_out}


def _extract_youtube_search_results(html: str, query_str: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Extract rich video/shorts posts and channel creators from YouTube search results."""
    data = _extract_yt_initial_data(html)
    posts: list[dict[str, Any]] = []
    creators: list[dict[str, Any]] = []
    seen_videos: set[str] = set()
    seen_channels: set[str] = set()
    if not data:
        return posts, creators

    def walk(node: Any):
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return

        if "channelRenderer" in node and isinstance(node["channelRenderer"], dict):
            cr = node["channelRenderer"]
            ch_id = str(cr.get("channelId") or "").strip()
            ch_name = _yt_text(cr.get("title"))
            nav_ep = ((cr.get("navigationEndpoint") or {}).get("browseEndpoint") or {})
            canonical_base = str(nav_ep.get("canonicalBaseUrl") or "").strip()
            ch_url = f"https://www.youtube.com{canonical_base}" if canonical_base.startswith("/") else (
                f"https://www.youtube.com/channel/{ch_id}" if ch_id else ""
            )
            if ch_url and ch_url not in seen_channels and ch_name:
                seen_channels.add(ch_url)
                av, _, _ = _best_yt_thumbnail(cr.get("thumbnail"))
                if av and av.startswith("//"):
                    av = f"https:{av}"
                sub_text = _yt_text(cr.get("videoCountText")) or _yt_text(cr.get("subscriberCountText"))
                handle = canonical_base.lstrip("/") if canonical_base.startswith("/@") else f"@{re.sub(r'[^a-z0-9_.-]+', '', ch_name.lower())}"
                creators.append({
                    "id": f"search-yt-ch-{ch_id or len(creators)+1}",
                    "name": ch_name,
                    "handle": handle,
                    "avatar": av or "",
                    "profileUrl": ch_url,
                    "site": "youtube",
                    "verified": bool(cr.get("ownerBadges")),
                    "bio": _yt_text(cr.get("descriptionSnippet")),
                    "stats": {"subscribers": sub_text} if sub_text else {},
                })
            return

        if "videoRenderer" in node and isinstance(node["videoRenderer"], dict):
            vr = node["videoRenderer"]
            v_id = str(vr.get("videoId") or "").strip()
            if v_id and v_id not in seen_videos:
                seen_videos.add(v_id)
                v_title = _yt_text(vr.get("title"))
                v_thumb, _, _ = _best_yt_thumbnail(vr.get("thumbnail"))
                v_dur = _yt_text(vr.get("lengthText"))
                v_views = _yt_text(vr.get("shortViewCountText")) or _yt_text(vr.get("viewCountText"))
                v_time = _normalize_yt_relative_date(_yt_text(vr.get("publishedTimeText")))
                owner_name = _yt_text(vr.get("ownerText")) or _yt_text(vr.get("longBylineText")) or "YouTube"
                owner_runs = ((vr.get("ownerText") or {}).get("runs") or (vr.get("longBylineText") or {}).get("runs") or [])
                owner_path = ""
                if owner_runs and isinstance(owner_runs[0], dict):
                    owner_path = str(
                        (((owner_runs[0].get("navigationEndpoint") or {}).get("browseEndpoint") or {}).get("canonicalBaseUrl"))
                        or (((owner_runs[0].get("navigationEndpoint") or {}).get("commandMetadata") or {}).get("webCommandMetadata") or {}).get("url")
                        or ""
                    ).strip()
                owner_url = f"https://www.youtube.com{owner_path}" if owner_path.startswith("/") else "https://www.youtube.com"
                owner_handle = owner_path.lstrip("/") if owner_path.startswith("/@") else f"@{re.sub(r'[^a-z0-9_.-]+', '', owner_name.lower()) or 'youtube'}"
                ch_thumb_r = (
                    ((vr.get("channelThumbnailSupportedRenderers") or {}).get("channelThumbnailWithLinkRenderer") or {}).get("thumbnail")
                    or {}
                )
                owner_avatar, _, _ = _best_yt_thumbnail(ch_thumb_r)
                if owner_avatar and owner_avatar.startswith("//"):
                    owner_avatar = f"https:{owner_avatar}"
                is_short = False
                nav_url = str(
                    (((vr.get("navigationEndpoint") or {}).get("commandMetadata") or {}).get("webCommandMetadata") or {}).get("url")
                    or ""
                )
                if "/shorts/" in nav_url or v_dur.lower() == "shorts":
                    is_short = True
                orig_url = f"https://www.youtube.com/shorts/{v_id}" if is_short else f"https://www.youtube.com/watch?v={v_id}"
                posts.append({
                    "id": f"omni-yt-{v_id}",
                    "creatorId": owner_url if owner_url != "https://www.youtube.com" else f"yt:{owner_handle}",
                    "creatorName": owner_name,
                    "creatorHandle": owner_handle,
                    "creatorAvatar": owner_avatar or f"https://i.ytimg.com/vi/{v_id}/hqdefault.jpg",
                    "creatorVerified": bool(vr.get("ownerBadges")),
                    "type": "video",
                    "source": "youtube",
                    "youtubeId": v_id,
                    "isShort": is_short,
                    "videoUrl": f"/api/proxy-video-stream?url={quote(orig_url, safe='')}",
                    "originalUrl": orig_url,
                    "sourcePage": owner_url if owner_url != "https://www.youtube.com" else undefined_or_none(None),
                    "thumbnail": v_thumb or f"https://i.ytimg.com/vi/{v_id}/hqdefault.jpg",
                    "title": v_title or f"Video {v_id}",
                    "duration": v_dur or ("Shorts" if is_short else ""),
                    "views": v_views or "",
                    "resolution": "1080p",
                    "comments": [],
                    "likes": None,
                    "liked": False,
                    "favorited": False,
                    "saved": False,
                    "date": v_time or "",
                })
            return

        if "shortsLockupViewModel" in node and isinstance(node["shortsLockupViewModel"], dict):
            slm = node["shortsLockupViewModel"]
            tap = ((slm.get("onTap") or {}).get("innertubeCommand") or {}).get("reelWatchEndpoint") or {}
            v_id = str(tap.get("videoId") or "").strip()
            if v_id and v_id not in seen_videos:
                seen_videos.add(v_id)
                v_title = _yt_text((slm.get("overlayMetadata") or {}).get("primaryText"))
                v_views = _yt_text((slm.get("overlayMetadata") or {}).get("secondaryText"))
                v_thumb, _, _ = _best_yt_thumbnail(slm.get("thumbnail"))
                orig_url = f"https://www.youtube.com/shorts/{v_id}"
                posts.append({
                    "id": f"omni-yt-short-{v_id}",
                    "creatorId": "yt:shorts",
                    "creatorName": query_str.strip() or "YouTube Shorts",
                    "creatorHandle": "@youtubeshorts",
                    "creatorAvatar": v_thumb or f"https://i.ytimg.com/vi/{v_id}/hqdefault.jpg",
                    "creatorVerified": False,
                    "type": "video",
                    "source": "youtube",
                    "youtubeId": v_id,
                    "isShort": True,
                    "videoUrl": f"/api/proxy-video-stream?url={quote(orig_url, safe='')}",
                    "originalUrl": orig_url,
                    "thumbnail": v_thumb or f"https://i.ytimg.com/vi/{v_id}/hqdefault.jpg",
                    "title": v_title or f"Short {v_id}",
                    "duration": "Shorts",
                    "views": v_views or "",
                    "resolution": "1080p",
                    "comments": [],
                    "likes": None,
                    "liked": False,
                    "favorited": False,
                    "saved": False,
                    "date": "",
                })
            return

        for val in node.values():
            if isinstance(val, (dict, list)):
                walk(val)

    walk(data.get("contents") or data)
    if not posts:
        can_v, _ = extract_youtube_videos_lexbor("https://www.youtube.com", data)
        for v in can_v[:20]:
            orig = str(v.get("originalUrl") or "")
            m = re.search(r"(?:[?&]v=|/shorts/)([A-Za-z0-9_-]{8,16})", orig)
            vid = m.group(1) if m else str(v.get("id") or "")
            is_short = "/shorts/" in orig
            posts.append({
                "id": f"omni-yt-{vid}",
                "creatorId": "yt:search",
                "creatorName": query_str.strip() or "YouTube",
                "creatorHandle": "@youtube",
                "creatorAvatar": v.get("thumbnailUrl") or "",
                "creatorVerified": False,
                "type": "video",
                "source": "youtube",
                "youtubeId": vid,
                "isShort": is_short,
                "videoUrl": f"/api/proxy-video-stream?url={quote(orig, safe='')}",
                "originalUrl": orig,
                "thumbnail": v.get("thumbnailUrl") or "",
                "title": v.get("title") or "YouTube Video",
                "duration": v.get("duration") or "",
                "views": v.get("views") or "",
                "resolution": "1080p",
                "comments": [],
                "likes": None,
                "liked": False,
                "favorited": False,
                "saved": False,
                "date": v.get("timeAgo") or "",
            })
    return posts[:28], creators[:10]


def undefined_or_none(val: Any) -> Any:
    return val


def _interleave_round_robin(queues: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Interleave per-source lists 1-by-1 in round-robin order without altering each source's internal ranking."""
    ordered_lists = [lst for lst in queues.values() if lst]
    if not ordered_lists:
        return []
    if len(ordered_lists) == 1:
        return list(ordered_lists[0])
    out: list[dict[str, Any]] = []
    max_len = max(len(lst) for lst in ordered_lists)
    for idx in range(max_len):
        for lst in ordered_lists:
            if idx < len(lst):
                out.append(lst[idx])
    return out


class IntegrateUrlRequest(BaseModel):
    url: str


@router.get("/integrated-sources")
async def get_integrated_sources():
    """Return strictly user-opted-in Timeline sources plus supported adapter catalog metadata."""
    return {
        "ok": True,
        "sources": load_integrated_sources(),
        "supportedCatalog": list_supported_integration_catalog(),
    }


@router.post("/integrate-url")
async def integrate_timeline_source_url(req: IntegrateUrlRequest):
    """Match a pasted network or profile/channel URL to a local adapter or auto-discover structurally."""
    result = integrate_url(req.url)
    if not result.get("ok") and result.get("reason") == "unsupported_domain":
        discovered = await autodiscover_connector_for_url(req.url)
        if discovered.get("ok"):
            result = integrate_url(req.url)
            if result.get("ok") and isinstance(result.get("integration"), dict):
                result["integration"] = {
                    **result["integration"],
                    "autoDiscovered": True,
                    "level": discovered.get("level") or result["integration"].get("level", "network"),
                    "suggestedHandle": discovered.get("suggestedHandle")
                    or result["integration"].get("suggestedHandle"),
                }
        elif discovered.get("reason"):
            result = {
                **result,
                "reason": discovered["reason"],
            }
    if result.get("ok"):
        _BROWSE_CACHE.clear()
        _OMNI_SEARCH_CACHE.clear()
    return result


@router.get("/connectors")
async def list_timeline_local_connectors():
    """List locally stored connectors (auto-discovered or user-imported)."""
    return {"ok": True, "connectors": list_local_connectors_summary()}


@router.get("/connectors/export")
async def export_timeline_local_connectors():
    """Export current local connector bundle JSON."""
    return export_connector_bundle()


@router.post("/connectors/import")
async def import_timeline_local_connectors(request: Request):
    """Validate and merge a JSON connector bundle into local connectors config."""
    raw = await request.body()
    try:
        res = import_connector_bundle(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": str(exc)}) from exc
    _BROWSE_CACHE.clear()
    _OMNI_SEARCH_CACHE.clear()
    return res


@router.delete("/connectors/{source_id}")
async def remove_timeline_local_connector(source_id: str):
    """Delete a local connector descriptor and refresh runtime caches."""
    res = delete_local_connector(source_id)
    _BROWSE_CACHE.clear()
    _OMNI_SEARCH_CACHE.clear()
    return res


@router.delete("/integrated-sources/{source_id}")
async def delete_integrated_source(source_id: str):
    """Disable an integrated Timeline source and return remaining active integrations."""
    updated = remove_integrated_source(source_id)
    _BROWSE_CACHE.clear()
    _OMNI_SEARCH_CACHE.clear()
    return {"ok": True, "removed": source_id.strip().lower(), "sources": updated}


@router.post("/integrated-sources/reset")
async def reset_all_integrated_sources():
    """Reset all integrated Timeline sources to an empty opt-in state."""
    cleared = clear_integrated_sources()
    _BROWSE_CACHE.clear()
    _OMNI_SEARCH_CACHE.clear()
    return {"ok": True, "sources": cleared}


class OmniSearchRequest(BaseModel):
    query: str
    source: str = "all"
    category: Literal["all", "profiles", "playlists", "videos", "shorts", "albums", "gifs", "posts"] = "all"
    cursors: dict[str, str] | None = None
    options: dict[str, Any] | None = None
    integrated_only: bool = False


@router.get("/search-sources")
async def get_search_sources(integrated_only: bool = Query(default=False)):
    """Return dynamically registered search providers and their supported categories."""
    allowed_ids = get_integrated_source_ids() if integrated_only else None
    sources_out = []
    for provider in list_search_providers():
        sid = provider.capabilities.source_id.lower()
        if allowed_ids is not None and sid not in allowed_ids:
            continue
        conn = get_connector_descriptor(provider.capabilities.source_id)
        sources_out.append({
            "id": provider.capabilities.source_id,
            "name": provider.capabilities.display_name,
            "categories": list(provider.capabilities.categories),
            "supportsLiveConnector": provider.capabilities.supports_live_connector,
            "iconKind": conn.icon_kind if conn is not None else None,
            "accentColor": getattr(conn, "accent_color", "") if conn is not None else "",
            "urlHints": dict(getattr(conn, "url_hints", {}) or {}) if conn is not None else {},
            "origins": _connector_origins(conn),
            "subfilters": list(conn.subfilters) if conn is not None else [],
            "capabilities": (
                conn.capabilities.to_frontend_dict(conn.search_categories)
                if conn is not None
                else None
            ),
        })
    return {"ok": True, "sources": sources_out}


@router.post("/omni-search")
async def omni_search_timeline(req: OmniSearchRequest):
    q = (req.query or "").strip()
    empty_sections: dict[str, list[dict[str, Any]]] = {cat: [] for cat in ALL_SEARCH_CATEGORIES}
    if len(q) < 2:
        return {
            "ok": True,
            "query": q,
            "posts": [],
            "creators": [],
            "sections": empty_sections,
            "cursors": {},
            "sourceStatus": {},
            "hasMore": False,
        }

    target_source = (req.source or "all").strip().lower()
    target_category = (req.category or "all").strip().lower()
    providers = list_search_providers()
    allowed_ids = get_integrated_source_ids() if req.integrated_only else None
    if allowed_ids is not None:
        providers = [p for p in providers if p.capabilities.source_id.lower() in allowed_ids]
        if not providers:
            return {
                "ok": True,
                "query": q,
                "posts": [],
                "creators": [],
                "sections": empty_sections,
                "cursors": {},
                "sourceStatus": {},
                "hasMore": False,
            }

    provider_sig = tuple((p.capabilities.source_id, p.capabilities.categories) for p in providers)
    cursor_sig = json.dumps(req.cursors or {}, sort_keys=True)
    options_sig = json.dumps(req.options or {}, sort_keys=True)
    gate_sig = ",".join(sorted(allowed_ids)) if allowed_ids is not None else "all"
    cache_key = f"{target_source}::{target_category}::{q.lower()}::{cursor_sig}::{options_sig}::{gate_sig}::{hash(provider_sig)}"
    now = time.time()
    cached = _cache_get(_OMNI_SEARCH_CACHE, cache_key, 180.0)
    if cached is not None:
        return cached

    work_items: list[tuple[Any, SearchCategory, str | None]] = []
    if req.cursors:
        for raw_key, cur_token in req.cursors.items():
            if not cur_token or ":" not in raw_key:
                continue
            src_id, cat_id = raw_key.split(":", 1)
            src_id = src_id.strip().lower()
            cat_id = cat_id.strip().lower()
            if allowed_ids is not None and src_id not in allowed_ids:
                continue
            if target_source != "all" and src_id != target_source:
                continue
            if target_category != "all" and cat_id != target_category:
                continue
            provider = get_search_provider(src_id)
            if provider and cat_id in provider.capabilities.categories:
                work_items.append((provider, cat_id, str(cur_token)))  # type: ignore[arg-type]
    else:
        for provider in providers:
            src_id = provider.capabilities.source_id.lower()
            if target_source != "all" and src_id != target_source:
                continue
            for cat_id in provider.capabilities.categories:
                if target_category != "all" and cat_id != target_category:
                    continue
                work_items.append((provider, cat_id, None))

    seen_profiles: set[str] = set()
    seen_items_by_cat: dict[str, set[str]] = {cat: set() for cat in ALL_SEARCH_CATEGORIES}
    seen_post_union: set[str] = set()
    profiles_by_src: dict[str, list[dict[str, Any]]] = {}
    cat_items_by_src: dict[str, dict[str, list[dict[str, Any]]]] = {cat: {} for cat in ALL_SEARCH_CATEGORIES}
    posts_by_src: dict[str, list[dict[str, Any]]] = {}
    cursors: dict[str, dict[str, Any]] = {}
    source_stats: dict[str, dict[str, Any]] = {}

    headers = {
        **DEFAULT_TRANSPORT_HEADERS,
        "Accept-Language": "en-US,en;q=0.9",
    }

    sem = asyncio.Semaphore(16)

    async def _run_one(provider, cat_id: SearchCategory, cur_token: str | None) -> tuple[str, SearchCategory, SearchPageResult]:
        async with sem:
            try:
                if req.options and getattr(provider, "supports_search_options", False):
                    coro = provider.search(client, q, cat_id, cur_token, options=req.options)
                else:
                    coro = provider.search(client, q, cat_id, cur_token)
                res = await asyncio.wait_for(
                    coro,
                    timeout=14.0,
                )
                return provider.capabilities.source_id, cat_id, res
            except asyncio.TimeoutError:
                return (
                    provider.capabilities.source_id,
                    cat_id,
                    SearchPageResult(source_id=provider.capabilities.source_id, category=cat_id, error="timeout"),
                )
            except Exception as exc:
                return (
                    provider.capabilities.source_id,
                    cat_id,
                    SearchPageResult(source_id=provider.capabilities.source_id, category=cat_id, error=str(exc)),
                )

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(14.0, connect=6.0),
        follow_redirects=True,
        headers=headers,
    ) as client:
        results = await asyncio.gather(
            *[_run_one(p, c, tok) for p, c, tok in work_items],
            return_exceptions=False,
        )

    for src_id, cat_id, res in sorted(results, key=lambda result: result[1] != "profiles"):
        st = source_stats.setdefault(
            src_id,
            {"ok_count": 0, "err_count": 0, "count": 0, "hasMore": False, "error": None},
        )
        if res.error:
            st["err_count"] += 1
            if not st["error"]:
                st["error"] = res.error
        else:
            st["ok_count"] += 1

        cursors[f"{src_id}:{cat_id}"] = {
            "cursor": res.next_cursor,
            "hasMore": bool(res.has_more),
        }
        if res.has_more:
            st["hasMore"] = True

        for prof in res.profiles:
            p_key = str(prof.get("profileUrl") or prof.get("id") or "").strip().lower()
            if not p_key or p_key in seen_profiles:
                continue
            seen_profiles.add(p_key)
            profiles_by_src.setdefault(src_id, []).append(prof)
            st["count"] += 1

        for item in res.items:
            i_key = str(item.get("originalUrl") or item.get("id") or "").strip().lower()
            if not i_key:
                continue
            if i_key not in seen_items_by_cat[cat_id]:
                seen_items_by_cat[cat_id].add(i_key)
                cat_items_by_src[cat_id].setdefault(src_id, []).append(item)
                st["count"] += 1
            if i_key not in seen_post_union:
                seen_post_union.add(i_key)
                posts_by_src.setdefault(src_id, []).append(item)

    interleaved_profiles = _interleave_round_robin(profiles_by_src)
    sections: dict[str, list[dict[str, Any]]] = {
        cat: (
            interleaved_profiles
            if cat == "profiles"
            else _interleave_round_robin(cat_items_by_src[cat])
        )
        for cat in ALL_SEARCH_CATEGORIES
    }
    creators = list(interleaved_profiles)
    posts = _interleave_round_robin(posts_by_src)

    source_status = {
        src_id: {
            "ok": bool(st["ok_count"] > 0 or st["err_count"] == 0),
            "count": st["count"],
            "hasMore": st["hasMore"],
            "error": None if st["ok_count"] > 0 else st["error"],
        }
        for src_id, st in source_stats.items()
    }
    has_more = any(entry["hasMore"] for entry in cursors.values())

    payload = {
        "ok": True,
        "query": q,
        "creators": creators,
        "posts": posts,
        "sections": sections,
        "cursors": cursors,
        "sourceStatus": source_status,
        "hasMore": has_more,
    }
    if posts or creators:
        _cache_put(_OMNI_SEARCH_CACHE, cache_key, payload, 180.0)
    return payload


@router.get("/youtube-recommendations")
async def youtube_recommendations(seed: str = Query("")):
    clean_seed = (seed or "").strip()
    if not clean_seed:
        return {"ok": True, "posts": [], "creators": []}
    cache_key = clean_seed.lower()
    cached = _cache_get(_YT_RECO_CACHE, cache_key, _CACHE_TTL_SECONDS)
    if cached is not None:
        return cached

    headers = {
        **DEFAULT_TRANSPORT_HEADERS,
        "Accept-Language": "en-US,en;q=0.9",
    }
    posts: list[dict[str, Any]] = []
    creators: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    queries = [clean_seed]
    if "shorts" not in clean_seed.lower():
        queries.append(f"{clean_seed} shorts")

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers=headers) as client:
        async def _run_q(q_str: str):
            try:
                url = f"https://www.youtube.com/results?search_query={quote_plus(q_str)}"
                resp = await client.get(url)
                if resp.status_code == 200:
                    p_list, c_list = _extract_youtube_search_results(resp.text, q_str)
                    for p in p_list:
                        if p["id"] not in seen_ids:
                            seen_ids.add(p["id"])
                            posts.append(p)
                    for c in c_list:
                        if c["profileUrl"] not in seen_ids:
                            seen_ids.add(c["profileUrl"])
                            creators.append(c)
            except Exception:
                pass

        await asyncio.gather(*(_run_q(q_str) for q_str in queries[:2]), return_exceptions=True)

    payload = {"ok": True, "posts": posts[:30], "creators": creators[:10]}
    if posts:
        _cache_put(_YT_RECO_CACHE, cache_key, payload, _CACHE_TTL_SECONDS)
    return payload


_ALLOWED_X_VIDEO_HOSTS = frozenset({"video.twimg.com", "pbs.twimg.com", "ton.twimg.com"})


@router.get("/x-video-stream")
async def stream_x_video(request: Request, url: str = Query(..., min_length=10)):
    """Stream X video.twimg.com MP4s with full HTTP Range support and X Referer."""
    parsed = urlsplit(url.strip())
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in _ALLOWED_X_VIDEO_HOSTS or parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="Unsupported X video host")

    upstream_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://x.com/",
        "Origin": "https://x.com",
    }
    req_range = request.headers.get("range")
    if req_range:
        upstream_headers["Range"] = req_range

    client = httpx.AsyncClient(timeout=20.0, follow_redirects=True)
    try:
        req = client.build_request("GET", url.strip(), headers=upstream_headers)
        resp = await client.send(req, stream=True)
    except Exception as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail="Could not stream X video") from exc

    if resp.status_code >= 400:
        status = resp.status_code
        await resp.aclose()
        await client.aclose()
        raise HTTPException(status_code=status, detail="X video unavailable")

    out_headers: dict[str, str] = {
        "Accept-Ranges": resp.headers.get("accept-ranges", "bytes"),
        "Cache-Control": "public, max-age=3600",
    }
    for h_key in ("content-length", "content-range"):
        if h_key in resp.headers:
            out_headers[h_key.title()] = resp.headers[h_key]

    media_type = resp.headers.get("content-type") or "video/mp4"

    async def _body_iter():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        _body_iter(),
        status_code=resp.status_code,
        media_type=media_type,
        headers=out_headers,
    )


_X_THREAD_CACHE: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()


@router.get("/x-post-thread")
async def get_x_post_thread(
    handle: str = Query(""),
    post_id: str = Query(..., min_length=5),
):
    clean_id = re.sub(r"[^\d]", "", str(post_id or ""))
    clean_handle = _clean_x_handle(handle)
    if not clean_id:
        return {"ok": False, "post": None, "authorProfile": None, "parent": None, "replies": []}

    cache_key = f"{clean_handle.lower()}::{clean_id}"
    cached = _cache_get(_X_THREAD_CACHE, cache_key, 180.0)
    if cached is not None:
        return cached

    headers = {
        **DEFAULT_TRANSPORT_HEADERS,
        "Accept-Language": "en-US,en;q=0.9",
    }
    focal_post: dict[str, Any] | None = None
    parent_post: dict[str, Any] | None = None
    author_profile: dict[str, Any] | None = None

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers=headers) as client:
        # 1. Fetch focal tweet (VxTwitter for real retweets + MP4 videos, plus syndication for parent)
        focal_post = await _fetch_x_tweet_info(client, clean_handle or "i", clean_id)
        try:
            syn_resp = await client.get(
                f"https://cdn.syndication.twimg.com/tweet-result?id={clean_id}&token=0",
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            )
            if syn_resp.status_code == 200:
                syn_data = syn_resp.json()
                if isinstance(syn_data, dict):
                    if not focal_post:
                        focal_post = _parse_syndication_tweet(syn_data, fallback_handle=clean_handle)
                    if isinstance(syn_data.get("parent"), dict):
                        parent_post = _parse_syndication_tweet(syn_data["parent"])
        except Exception:
            pass

        target_handle = clean_handle or (str((focal_post or {}).get("handle") or "").lstrip("@"))
        if target_handle:
            author_profile = await _fetch_x_user_info(client, target_handle)
            if focal_post and author_profile:
                focal_post = {
                    **focal_post,
                    "handle": target_handle,
                    "name": author_profile.get("name") or focal_post.get("name") or target_handle,
                    "avatar": author_profile.get("avatar") or focal_post.get("avatar") or "",
                    "banner": author_profile.get("banner") or "",
                    "bio": author_profile.get("bio") or "",
                    "followers": author_profile.get("followers"),
                    "following": author_profile.get("following"),
                    "verified": bool(author_profile.get("verified") or focal_post.get("verified")),
                }

    payload = {
        "ok": bool(focal_post or author_profile),
        "post": focal_post,
        "authorProfile": author_profile,
        "parent": parent_post,
        "replies": [],
    }
    if payload["ok"]:
        _cache_put(_X_THREAD_CACHE, cache_key, payload, 180.0)
    return payload


_BROWSE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


class TimelineBrowseRequest(BaseModel):
    source: str
    category: str = "popular"
    subfilter: str | None = None
    cursor: str | None = None
    limit: int = Field(default=24, ge=1, le=48)
    integrated_only: bool = False


@router.get("/browse-sources")
async def get_browse_sources(integrated_only: bool = Query(default=False)):
    """Return registered visual discovery browse providers and supported categories/subfilters."""
    allowed_ids = get_integrated_source_ids() if integrated_only else None
    sources_list = []
    for provider in list_browse_providers():
        sid = provider.capabilities.source_id.lower()
        if allowed_ids is not None and sid not in allowed_ids:
            continue
        conn = get_connector_descriptor(provider.capabilities.source_id)
        sources_list.append({
            "source_id": provider.capabilities.source_id,
            "display_name": provider.capabilities.display_name,
            "default_category": provider.capabilities.default_category,
            "categories": list(provider.capabilities.categories),
            "subfilters": list(provider.capabilities.subfilters),
            "supports_quick_url_open": provider.capabilities.supports_quick_url_open,
            "icon_kind": getattr(provider.capabilities, "icon_kind", "gallery_catalog"),
            "accentColor": getattr(conn, "accent_color", "") if conn is not None else "",
            "urlHints": dict(getattr(conn, "url_hints", {}) or {}) if conn is not None else {},
            "origins": _connector_origins(conn),
            "capabilities": getattr(provider.capabilities, "capabilities_meta", {}),
        })
    return {"ok": True, "sources": sources_list}


@router.post("/browse")
async def browse_timeline_source(req: TimelineBrowseRequest):
    """Fetch a live paginated discovery page for any configured visual catalog or forum board."""
    source_id = (req.source or "").strip().lower()
    if req.integrated_only and source_id not in get_integrated_source_ids():
        return {
            "source": source_id,
            "category": req.category,
            "subfilter": req.subfilter,
            "items": [],
            "profiles": [],
            "next_cursor": None,
            "has_more": False,
            "resolved_origin": None,
            "error": "source_not_integrated",
        }
    provider = get_browse_provider(source_id)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"Unsupported browse source: {source_id}")

    category = (req.category or provider.capabilities.default_category).strip().lower()
    subfilter = (req.subfilter or "").strip() or None
    conn = get_connector_descriptor(source_id)
    origin_hint = conn.effective_base_url() if conn is not None else source_id
    cache_key = f"{source_id}::{category}::{subfilter or ''}::{req.cursor or ''}::{req.limit}::{origin_hint}"
    now = time.time()
    cached = _BROWSE_CACHE.get(cache_key)
    if cached and (now - cached[0]) < 120.0:
        return cached[1]

    headers = {**DEFAULT_TRANSPORT_HEADERS, "Accept-Language": "en-US,en;q=0.9"}
    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True, headers=headers) as client:
            res: BrowsePageResult = await asyncio.wait_for(
                provider.browse(client, category, subfilter=subfilter, cursor=req.cursor, limit=req.limit),
                timeout=12.0,
            )
    except Exception as exc:
        res = BrowsePageResult(
            source_id=source_id,
            category=category,
            subfilter=subfilter,
            resolved_origin=origin_hint if conn is not None else None,
            error=str(exc),
        )

    payload = {
        "source": res.source_id,
        "category": res.category,
        "subfilter": res.subfilter,
        "items": res.items,
        "profiles": res.profiles,
        "dynamicSubfilters": list(getattr(res, "dynamic_subfilters", []) or []),
        "next_cursor": res.next_cursor,
        "has_more": res.has_more,
        "resolved_origin": res.resolved_origin,
        "error": res.error,
    }
    if not res.error and res.items:
        if len(_BROWSE_CACHE) > 256:
            _BROWSE_CACHE.clear()
        _BROWSE_CACHE[cache_key] = (now, payload)
    return payload


class CatalogEnrichItem(BaseModel):
    url: str
    source: str | None = None


class CatalogEnrichRequest(BaseModel):
    items: list[CatalogEnrichItem] = Field(default_factory=list, max_length=12)


class ThreadViewRequest(BaseModel):
    url: str
    page: int = Field(default=1, ge=1)
    page_url: str | None = Field(default=None, alias="pageUrl")

    model_config = {"populate_by_name": True}


class GalleryDetailRequest(BaseModel):
    url: str


@router.get("/directory")
async def get_catalog_directory(
    source: str = Query(..., min_length=1),
    kind: str = Query(default="categories"),
    page: int = Query(default=1, ge=1),
    page_url: str = Query(default="", alias="pageUrl", max_length=2048),
):
    """Fetch standardized category, artist, channel, or tag directories for a catalog or video portal connector."""
    conn = get_connector_descriptor(source)
    if not isinstance(conn, (CatalogDescriptor, VideoPortalDescriptor)):
        raise HTTPException(status_code=404, detail="Directory unavailable")
    headers = {**DEFAULT_TRANSPORT_HEADERS, "Accept-Language": "en-US,en;q=0.9"}
    try:
        async with httpx.AsyncClient(
            timeout=12.0,
            follow_redirects=True,
            headers=headers,
            transport=PublicHTTPSHttpxTransport(),
        ) as client:
            if isinstance(conn, VideoPortalDescriptor):
                return await asyncio.wait_for(list_video_portal_directory(client, conn, kind, page=page, page_url=page_url), timeout=12.0)
            return await asyncio.wait_for(list_catalog_directory(client, conn, kind, page=page, page_url=page_url), timeout=12.0)
    except (TimeoutError, httpx.HTTPError, ValueError):
        return {"source": conn.id, "kind": kind, "page": page, "items": [], "error": "directory_unavailable"}


@router.get("/directory-cover")
async def get_directory_cover(
    source: str = Query(..., min_length=1),
    url: str = Query(..., max_length=2048),
):
    conn = get_connector_descriptor(source)
    if not isinstance(conn, VideoPortalDescriptor):
        raise HTTPException(status_code=404, detail="Directory unavailable")
    key = f"{conn.id}:{url}"
    cached = _cache_get(_DIRECTORY_COVER_CACHE, key, _CACHE_TTL_SECONDS)
    if cached is not None:
        return cached
    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True, transport=PublicHTTPSHttpxTransport()) as client:
            thumbnail = await asyncio.wait_for(read_portal_category_cover(client, conn, url), timeout=6.0)
    except (ValueError, TimeoutError, httpx.HTTPError):
        return {"thumbnailUrl": None}
    result = {"thumbnailUrl": thumbnail or None}
    _cache_put(_DIRECTORY_COVER_CACHE, key, result, _CACHE_TTL_SECONDS)
    return result


@router.post("/catalog-enrich")
async def enrich_catalog_metadata(req: CatalogEnrichRequest):
    """Hydrate artist, channel, tag, and photo count metadata for visible gallery cards."""
    headers = {**DEFAULT_TRANSPORT_HEADERS, "Accept-Language": "en-US,en;q=0.9"}
    raw_items = [{"url": it.url, "source": it.source or ""} for it in req.items[:8]]
    async with httpx.AsyncClient(
        timeout=12.0,
        follow_redirects=True,
        headers=headers,
        transport=PublicHTTPSHttpxTransport(),
    ) as client:
        metadata = await asyncio.wait_for(enrich_catalog_items(client, raw_items), timeout=12.0)
    return {"ok": True, "metadata": metadata}


@router.get("/forum-boards")
async def get_forum_boards(source: str = Query(..., min_length=1)):
    """Fetch hierarchical board sections for a configured forum connector."""
    conn = get_connector_descriptor(source)
    if not isinstance(conn, ForumDescriptor):
        raise HTTPException(status_code=404, detail=f"Unsupported forum source: {source}")
    headers = {**DEFAULT_TRANSPORT_HEADERS, "Accept-Language": "en-US,en;q=0.9"}
    try:
        async with httpx.AsyncClient(
            timeout=12.0,
            follow_redirects=True,
            headers=headers,
            transport=PublicHTTPSHttpxTransport(),
        ) as client:
            sections = await asyncio.wait_for(fetch_board_hierarchy(client, conn), timeout=12.0)
            return {"ok": True, "source": conn.id, "sections": sections}
    except Exception as exc:
        return {"ok": False, "source": conn.id, "sections": [], "error": str(exc)}


@router.post("/thread-view")
async def read_forum_thread_view(req: ThreadViewRequest):
    """Fetch paginated forum thread posts, release specs, mirror links, and inline gallery photos."""
    target_url = (req.page_url or req.url or "").strip()
    if not target_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Valid thread URL is required")
    conn = find_connector_for_url(req.url.strip())
    if not isinstance(conn, ForumDescriptor):
        raise HTTPException(status_code=404, detail="Unknown forum thread connector")
    parsed_req = urlsplit(req.url.strip())
    if req.page_url:
        parsed_page = urlsplit(req.page_url.strip())
        req_host = (parsed_req.hostname or "").lower().removeprefix("www.")
        pg_host = (parsed_page.hostname or "").lower().removeprefix("www.")
        if req_host and pg_host and pg_host != req_host and not conn.matches_host(pg_host):
            raise HTTPException(status_code=400, detail="Thread pageUrl must match the thread forum origin")
    if not req.page_url and req.page > 1 and not re.search(r"/page\d+$", parsed_req.path, re.I):
        base_path = re.sub(r"/page\d+$", "", parsed_req.path.rstrip("/"))
        target_url = f"{parsed_req.scheme}://{parsed_req.netloc}{base_path}/page{req.page}"
    headers = {**DEFAULT_TRANSPORT_HEADERS, "Accept-Language": "en-US,en;q=0.9"}
    req_headers = resolve_anti_hotlink_headers(target_url, referer=req.url.strip() or conn.effective_base_url())
    try:
        async with httpx.AsyncClient(
            timeout=15.0,
            follow_redirects=True,
            headers=headers,
            transport=PublicHTTPSHttpxTransport(),
        ) as client:
            resp = await asyncio.wait_for(client.get(target_url, headers=req_headers), timeout=15.0)
            resp.raise_for_status()
            return parse_forum_thread_page(
                resp.text or "",
                str(resp.url or target_url),
                conn,
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Forum thread unavailable: {exc}") from exc


@router.post("/gallery-detail")
async def read_catalog_gallery_detail_route(req: GalleryDetailRequest):
    """Fetch a complete in-app visual gallery page with full-resolution photos, entities, and related galleries."""
    target_url = (req.url or "").strip()
    if not target_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Valid gallery URL is required")
    conn = find_connector_for_url(target_url)
    if not isinstance(conn, CatalogDescriptor):
        raise HTTPException(status_code=404, detail="Unknown gallery catalog connector")
    headers = {**DEFAULT_TRANSPORT_HEADERS, "Accept-Language": "en-US,en;q=0.9"}
    try:
        async with httpx.AsyncClient(
            timeout=15.0,
            follow_redirects=True,
            headers=headers,
            transport=PublicHTTPSHttpxTransport(),
        ) as client:
            return await asyncio.wait_for(
                read_catalog_gallery_detail(client, conn, target_url),
                timeout=15.0,
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Gallery detail unavailable: {exc}") from exc



