"""Extensible multi-source timeline search provider registry and adapters.

Decouples platform search implementations (YouTube, PortalGrid, PortalTube, PortalState,
Imgur, X fallback, plus any future registered providers) from the orchestration
layer in ``timeline_omni_service.py``.
"""
from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import re
import time
from typing import Any, Literal, Protocol
from src.server.connector_registry import native_adapter_url, get_native_adapter
from urllib.parse import quote, quote_plus, unquote, urljoin, urlsplit

import httpx
from selectolax.lexbor import LexborHTMLParser

SearchCategory = Literal[
    "profiles",
    "playlists",
    "videos",
    "shorts",
    "albums",
    "gifs",
    "posts",
]

ALL_SEARCH_CATEGORIES: tuple[SearchCategory, ...] = (
    "profiles",
    "playlists",
    "videos",
    "shorts",
    "albums",
    "gifs",
    "posts",
)

NEUTRAL_PLATFORM_LABELS: dict[str, tuple[str, str]] = {
    "youtube": ("YouTube", "@youtube"),
    "portal_grid": ("PortalGrid", "@portal_grid"),
    "portal_tube": ("PortalTube", "@portal_tube"),
    "portal_state": ("PortalState", "@portal_state"),
    "imgur": ("Imgur", "@imgur"),
    "x": ("X", "@x"),
}


@dataclass(frozen=True)
class SearchProviderCapabilities:
    """Metadata describing a registered search provider's supported categories."""

    source_id: str
    display_name: str
    categories: tuple[SearchCategory, ...]
    supports_live_connector: bool = False


@dataclass
class SearchPageResult:
    """Normalized page output returned by a ``SearchProvider.search`` call."""

    source_id: str
    category: SearchCategory
    profiles: list[dict[str, Any]] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)
    next_cursor: str | None = None
    has_more: bool = False
    error: str | None = None


class SearchProvider(Protocol):
    """Contract implemented by every federated timeline search source adapter."""

    capabilities: SearchProviderCapabilities

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        cursor: str | None = None,
    ) -> SearchPageResult:
        """Execute a paginated search against one category of this source."""
        ...


_SEARCH_PROVIDERS: dict[str, SearchProvider] = {}
_UNREGISTERED_SEARCH_IDS: set[str] = set()


def register_search_provider(provider: SearchProvider) -> None:
    """Register or replace a search provider by ``capabilities.source_id``."""
    source_id = str(provider.capabilities.source_id or "").strip().lower()
    if not source_id:
        raise ValueError("SearchProvider source_id must be non-empty")
    _UNREGISTERED_SEARCH_IDS.discard(source_id)
    _SEARCH_PROVIDERS[source_id] = provider


def unregister_search_provider(source_id: str) -> None:
    """Remove a registered search provider if present."""
    sid = str(source_id or "").strip().lower()
    _SEARCH_PROVIDERS.pop(sid, None)
    if sid:
        _UNREGISTERED_SEARCH_IDS.add(sid)


def _dynamic_search_providers() -> dict[str, SearchProvider]:
    from .connector_registry import (
        list_catalog_descriptors,
        list_forum_descriptors,
        list_video_portal_descriptors,
    )

    merged: dict[str, SearchProvider] = dict(_SEARCH_PROVIDERS)
    for c in list_catalog_descriptors():
        if c.id not in merged and c.id not in _UNREGISTERED_SEARCH_IDS:
            merged[c.id] = CatalogSearchProvider(c)
    for f in list_forum_descriptors():
        if f.id not in merged and f.id not in _UNREGISTERED_SEARCH_IDS:
            merged[f.id] = ForumSearchProvider(f)
    for vp in list_video_portal_descriptors():
        if vp.id not in merged and vp.id not in _UNREGISTERED_SEARCH_IDS:
            merged[vp.id] = VideoPortalSearchProvider(vp)
    return merged


def list_search_providers() -> tuple[SearchProvider, ...]:
    """Return all currently registered search providers in registration order."""
    return tuple(_dynamic_search_providers().values())


def get_search_provider(source_id: str) -> SearchProvider | None:
    """Look up a single registered search provider by ID."""
    adapter = get_native_adapter(source_id)
    sid = adapter.id if adapter else str(source_id or "").strip().lower()
    return _dynamic_search_providers().get(sid)


def encode_search_cursor(payload: dict[str, Any]) -> str:
    """Encode pagination cursor state into an opaque URL-safe base64 token."""
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_search_cursor(token: str | None) -> dict[str, Any]:
    """Decode an opaque cursor token back into a dict, or ``{}`` on invalid input."""
    if not token or not isinstance(token, str):
        return {}
    try:
        padded = token + "=" * ((4 - len(token) % 4) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
        parsed = json.loads(decoded.decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _safe_handle(name: str, fallback: str = "creator") -> str:
    slug = re.sub(r"[^a-z0-9_.-]+", "", (name or "").lower()).strip("._-")
    return f"@{slug or fallback}"


def _neutral_attribution(source_id: str, override_label: str | None = None) -> tuple[str, str]:
    default_name, default_handle = NEUTRAL_PLATFORM_LABELS.get(
        source_id, (source_id.title() or "Source", f"@{source_id or 'source'}")
    )
    name = (override_label or "").strip() or default_name
    handle = _safe_handle(name, fallback=source_id or "source") if override_label else default_handle
    return name, handle


def _as_str_url(val: Any) -> str:
    if isinstance(val, (tuple, list)):
        val = val[0] if val else ""
    return str(val or "").strip()


def make_profile_entry(
    *,
    source_id: str,
    entry_id: str,
    name: str,
    profile_url: str,
    handle: str = "",
    avatar: str = "",
    verified: bool = False,
    bio: str = "",
    followers: int | str | None = None,
    subscribers_text: str = "",
    videos_count: int | str | None = None,
    photos_count: int | str | None = None,
    entity_kind: str = "",
) -> dict[str, Any]:
    """Build a normalized creator/channel search card."""
    clean_avatar = _as_str_url(avatar)
    clean_handle = (handle or "").strip()
    if clean_handle and not clean_handle.startswith("@"):
        clean_handle = f"@{clean_handle}"
    if not clean_handle:
        clean_handle = _safe_handle(name, fallback=source_id)
    entry: dict[str, Any] = {
        "id": entry_id,
        "name": name.strip() or clean_handle.lstrip("@"),
        "handle": clean_handle,
        "avatar": clean_avatar,
        "verified": bool(verified),
        "profileUrl": profile_url,
        "site": source_id,
        "bio": bio,
        "followers": followers,
        "subscribersText": subscribers_text,
        "videosCount": videos_count,
        "photosCount": photos_count,
    }
    if entity_kind:
        entry["entityKind"] = entity_kind
    return entry


def make_item_entry(
    *,
    source_id: str,
    item_id: str,
    item_type: Literal["video", "playlist", "photo_grid", "album", "gif", "text"],
    title: str,
    original_url: str,
    thumbnail: str = "",
    creator_name: str = "",
    creator_handle: str = "",
    creator_avatar: str = "",
    creator_verified: bool = False,
    source_page: str = "",
    video_url: str = "",
    youtube_id: str = "",
    is_short: bool = False,
    duration: str = "",
    views: str = "",
    resolution: str = "",
    date: str = "",
    text: str = "",
    photos: list[str] | None = None,
    photo_count: int | None = None,
    video_count: int | None = None,
    album_url: str = "",
    neutral_label: str | None = None,
    preview_video_url: str = "",
) -> dict[str, Any]:
    """Build a normalized media/post search card without synthetic query attribution."""
    clean_creator = (creator_name or "").strip()
    clean_handle = (creator_handle or "").strip()
    clean_source_page = (source_page or "").strip()
    if not clean_creator:
        clean_creator, clean_handle = _neutral_attribution(source_id, neutral_label)
        clean_source_page = ""
    elif not clean_handle:
        m_at = re.search(r"/@([A-Za-z0-9_.-]+)", clean_source_page) if clean_source_page else None
        clean_handle = f"@{m_at.group(1)}" if m_at else _safe_handle(clean_creator, fallback=source_id)

    if clean_source_page:
        creator_id = clean_source_page
    elif clean_handle:
        creator_id = f"{source_id}:{clean_handle.lstrip('@').lower()}"
    else:
        creator_id = f"{source_id}:search"

    clean_thumb = _as_str_url(thumbnail)
    clean_avatar = _as_str_url(creator_avatar) or clean_thumb
    payload: dict[str, Any] = {
        "id": item_id,
        "creatorId": creator_id,
        "creatorName": clean_creator,
        "creatorHandle": clean_handle if clean_handle.startswith("@") else f"@{clean_handle}",
        "creatorAvatar": clean_avatar,
        "creatorVerified": bool(creator_verified),
        "type": item_type,
        "source": source_id,
        "originalUrl": original_url,
        "thumbnail": clean_thumb,
        "title": title.strip() or clean_creator,
        "duration": duration,
        "views": views,
        "resolution": resolution,
        "comments": [],
        "likes": None,
        "liked": False,
        "favorited": False,
        "saved": False,
        "date": date,
    }
    if clean_source_page:
        payload["sourcePage"] = clean_source_page
    if video_url:
        payload["videoUrl"] = video_url
    elif item_type == "video" and not youtube_id and original_url:
        payload["videoUrl"] = f"/api/proxy-video-stream?url={quote(original_url, safe='')}"
    if youtube_id:
        payload["youtubeId"] = youtube_id
    if is_short:
        payload["isShort"] = True
    if text:
        payload["text"] = text
        payload["caption"] = text
    if photos:
        payload["photos"] = photos
    if photo_count is not None:
        payload["photoCount"] = photo_count
    if video_count is not None:
        payload["videoCount"] = video_count
    if album_url:
        payload["albumUrl"] = album_url
    if preview_video_url:
        payload["previewVideoUrl"] = preview_video_url
    return payload


def _http_url(base: str, raw: str | None) -> str:
    if not raw:
        return ""
    val = raw.strip()
    if val.startswith("//"):
        return f"https:{val}"
    if val.startswith(("http://", "https://")):
        return val
    low = val.lower()
    if low.startswith(("javascript:", "data:", "vbscript:", "mailto:", "tel:")):
        return ""
    if ":" in val.split("/", 1)[0]:
        return ""
    joined = urljoin(base, val)
    return joined if urlsplit(joined).scheme in ("http", "https") else ""


def _parse_int_count(text: str | None) -> int | None:
    if not text:
        return None
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*([KMBkmb])?", text.replace(",", ""))
    if not m:
        return None
    try:
        num = float(m.group(1))
    except ValueError:
        return None
    mult = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}.get((m.group(2) or "").lower(), 1)
    return int(num * mult)


def _yt_owner_from_runs(obj: Any) -> tuple[str, str]:
    if not isinstance(obj, dict):
        return "", ""
    for run in obj.get("runs") or []:
        if not isinstance(run, dict):
            continue
        name = (run.get("text") or "").strip()
        if not name:
            continue
        nav = (
            run.get("navigationEndpoint")
            or run.get("onTap", {}).get("innertubeCommand")
            or {}
        )
        web = (nav.get("commandMetadata") or {}).get("webCommandMetadata") or {}
        url_path = (web.get("url") or "").strip()
        if not url_path:
            browse_id = (nav.get("browseEndpoint") or {}).get("browseId") or ""
            canonical_base = (nav.get("browseEndpoint") or {}).get("canonicalBaseUrl") or ""
            url_path = canonical_base or (f"/channel/{browse_id}" if browse_id else "")
        full_url = _http_url("https://www.youtube.com", url_path) if url_path else ""
        return name, full_url
    return "", ""


def _extract_yt_innertube_context(raw_html: str) -> tuple[str | None, str | None]:
    if not raw_html:
        return None, None
    api_m = re.search(r'"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"', raw_html)
    ver_m = re.search(r'"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"', raw_html)
    return (api_m.group(1) if api_m else None), (ver_m.group(1) if ver_m else None)


def _yt_thumb_from_view_model(thumb_vm: Any) -> str:
    if not isinstance(thumb_vm, dict):
        return ""
    sources = ((thumb_vm.get("image") or {}).get("sources") or [])
    best_url = ""
    best_width = -1
    for src in sources:
        if not isinstance(src, dict):
            continue
        u = (src.get("url") or "").strip()
        if not u:
            continue
        w = int(src.get("width") or 0)
        if w >= best_width:
            best_width = w
            best_url = u
    return _http_url("https://www.youtube.com", best_url) if best_url else ""


def _yt_badge_texts(root: Any) -> list[str]:
    texts: list[str] = []

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            if "thumbnailBadgeViewModel" in node and isinstance(node["thumbnailBadgeViewModel"], dict):
                txt = (node["thumbnailBadgeViewModel"].get("text") or "").strip()
                if txt:
                    texts.append(txt)
            for v in node.values():
                _walk(v)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(root)
    return texts


def parse_youtube_search_payload(
    data: dict[str, Any],
    query: str,
    category: SearchCategory,
    raw_html: str = "",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None, str | None, str | None]:
    """Parse YouTube ``ytInitialData`` or ``/youtubei/v1/search`` JSON for one category."""
    from .profile_hub_workers import _best_yt_thumbnail, _normalize_yt_relative_date, _yt_text

    profiles: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []
    seen_profiles: set[str] = set()
    seen_items: set[str] = set()
    continuation_tokens: list[str] = []

    def _walk(node: Any) -> None:
        if isinstance(node, list):
            for child in node:
                _walk(child)
            return
        if not isinstance(node, dict):
            return

        if "continuationCommand" in node and isinstance(node["continuationCommand"], dict):
            tok = (node["continuationCommand"].get("token") or "").strip()
            if tok and tok not in continuation_tokens:
                continuation_tokens.append(tok)

        if category == "profiles" and "channelRenderer" in node and isinstance(node["channelRenderer"], dict):
            cr = node["channelRenderer"]
            cid = (cr.get("channelId") or "").strip()
            name = _yt_text(cr.get("title")).strip()
            nav_url = ((cr.get("navigationEndpoint") or {}).get("commandMetadata") or {}).get("webCommandMetadata", {}).get("url") or ""
            canonical = (cr.get("canonicalBaseUrl") or nav_url or (f"/channel/{cid}" if cid else "")).strip()
            profile_url = _http_url("https://www.youtube.com", canonical)
            if profile_url and name and profile_url not in seen_profiles:
                seen_profiles.add(profile_url)
                avatar_list = ((cr.get("thumbnail") or {}).get("thumbnails") or [])
                avatar = _http_url("https://www.youtube.com", avatar_list[-1].get("url")) if avatar_list else ""
                badges = json.dumps(cr.get("ownerBadges") or []).upper()
                verified = "VERIFIED" in badges
                handle = canonical.strip("/").split("/")[-1] if "/@" in canonical else ""
                sub_txt = _yt_text(cr.get("subscriberCountText")).strip()
                vids_txt = _yt_text(cr.get("videoCountText")).strip()
                if not handle and sub_txt.startswith("@"):
                    handle = sub_txt
                subs = ""
                videos_label = ""
                for txt_cand in (sub_txt, vids_txt):
                    low_cand = txt_cand.lower()
                    if not txt_cand or txt_cand.startswith("@"):
                        continue
                    if "subscriber" in low_cand or "inscrito" in low_cand:
                        subs = txt_cand
                    elif "video" in low_cand or "vídeo" in low_cand:
                        videos_label = txt_cand
                if not subs and sub_txt and not sub_txt.startswith("@"):
                    subs = sub_txt
                bio = _yt_text(cr.get("descriptionSnippet")).strip()
                profiles.append(
                    make_profile_entry(
                        source_id="youtube",
                        entry_id=f"yt-ch-{cid or len(profiles) + 1}",
                        name=name,
                        profile_url=profile_url,
                        handle=handle,
                        avatar=avatar,
                        verified=verified,
                        bio=bio,
                        subscribers_text=subs,
                        followers=_parse_int_count(subs),
                        videos_count=_parse_int_count(videos_label),
                    )
                )
            return

        if category in ("videos", "shorts") and "shortsLockupViewModel" in node and isinstance(node["shortsLockupViewModel"], dict):
            if category == "shorts":
                slm = node["shortsLockupViewModel"]
                tap = ((slm.get("onTap") or {}).get("innertubeCommand") or {}).get("reelWatchEndpoint") or {}
                v_id = (tap.get("videoId") or "").strip()
                if not v_id:
                    web_u = ((((slm.get("onTap") or {}).get("innertubeCommand") or {}).get("commandMetadata") or {}).get("webCommandMetadata") or {}).get("url") or ""
                    m_s = re.search(r"/shorts/([A-Za-z0-9_-]{11})", web_u)
                    v_id = m_s.group(1) if m_s else ""
                if v_id and v_id not in seen_items:
                    seen_items.add(v_id)
                    ov_meta = slm.get("overlayMetadata") or {}
                    title = ((ov_meta.get("primaryText") or {}).get("content") or _yt_text(ov_meta.get("primaryText")) or slm.get("accessibilityText") or "YouTube Short").strip()
                    views = ((ov_meta.get("secondaryText") or {}).get("content") or _yt_text(ov_meta.get("secondaryText")) or "").strip()
                    thumb = _yt_thumb_from_view_model((slm.get("thumbnailViewModel") or {}).get("thumbnailViewModel")) or f"https://i.ytimg.com/vi/{v_id}/hqdefault.jpg"
                    items.append(
                        make_item_entry(
                            source_id="youtube",
                            item_id=f"omni-yt-short-{v_id}",
                            item_type="video",
                            title=title,
                            original_url=f"https://www.youtube.com/shorts/{v_id}",
                            thumbnail=thumb,
                            youtube_id=v_id,
                            is_short=True,
                            views=views,
                            neutral_label="YouTube Shorts",
                        )
                    )
            return

        if category in ("videos", "shorts") and "videoRenderer" in node and isinstance(node["videoRenderer"], dict):
            vr = node["videoRenderer"]
            v_id = (vr.get("videoId") or "").strip()
            web_url = ((((vr.get("navigationEndpoint") or {}).get("commandMetadata") or {}).get("webCommandMetadata") or {}).get("url") or "")
            is_short = "/shorts/" in web_url
            if category == "shorts" and not is_short:
                return
            if category == "videos" and is_short:
                return
            if v_id and v_id not in seen_items:
                seen_items.add(v_id)
                title = _yt_text(vr.get("title")).strip() or v_id
                owner_name, owner_url = _yt_owner_from_runs(vr.get("ownerText"))
                if not owner_name:
                    owner_name, owner_url = _yt_owner_from_runs(vr.get("longBylineText"))
                best_thumb, _, _ = _best_yt_thumbnail(vr.get("thumbnail"))
                thumb = best_thumb or f"https://i.ytimg.com/vi/{v_id}/hqdefault.jpg"
                dur = _yt_text(vr.get("lengthText")).strip()
                views = (_yt_text(vr.get("shortViewCountText")) or _yt_text(vr.get("viewCountText"))).strip()
                date_str = _normalize_yt_relative_date(_yt_text(vr.get("publishedTimeText")).strip())
                badges = json.dumps(vr.get("ownerBadges") or []).upper()
                items.append(
                    make_item_entry(
                        source_id="youtube",
                        item_id=f"omni-yt-{v_id}",
                        item_type="video",
                        title=title,
                        original_url=f"https://www.youtube.com/shorts/{v_id}" if is_short else f"https://www.youtube.com/watch?v={v_id}",
                        thumbnail=thumb,
                        creator_name=owner_name,
                        creator_avatar=thumb,
                        creator_verified="VERIFIED" in badges,
                        source_page=owner_url,
                        youtube_id=v_id,
                        is_short=is_short,
                        duration=dur,
                        views=views,
                        date=date_str,
                    )
                )
            return

        if category == "playlists" and "lockupViewModel" in node and isinstance(node["lockupViewModel"], dict):
            lvm = node["lockupViewModel"]
            if lvm.get("contentType") in ("LOCKUP_CONTENT_TYPE_PLAYLIST", "LOCKUP_CONTENT_TYPE_COURSE"):
                pl_id = (lvm.get("contentId") or "").strip()
                if pl_id and pl_id not in seen_items:
                    seen_items.add(pl_id)
                    lvm_meta = (lvm.get("metadata") or {}).get("lockupMetadataViewModel") or {}
                    title = ((lvm_meta.get("title") or {}).get("content") or _yt_text(lvm_meta.get("title")) or pl_id).strip()
                    owner_name = ""
                    owner_url = ""
                    rows = ((lvm_meta.get("metadata") or {}).get("contentMetadataViewModel") or {}).get("metadataRows") or []
                    for row in rows:
                        for part in (row.get("metadataParts") or []):
                            txt_obj = part.get("text") or {}
                            cand = (txt_obj.get("content") or "").strip()
                            for cr in (txt_obj.get("commandRuns") or []):
                                web = (((cr.get("onTap") or {}).get("innertubeCommand") or {}).get("commandMetadata") or {}).get("webCommandMetadata") or {}
                                u = (web.get("url") or "").strip()
                                if u and not u.startswith("/watch") and not u.startswith("/playlist"):
                                    owner_name = cand
                                    owner_url = _http_url("https://www.youtube.com", u)
                                    break
                            if owner_name:
                                break
                        if owner_name:
                            break
                    coll = (lvm.get("contentImage") or {}).get("collectionThumbnailViewModel") or {}
                    primary_thumb = (coll.get("primaryThumbnail") or {}).get("thumbnailViewModel") or {}
                    thumb = _yt_thumb_from_view_model(primary_thumb)
                    v_count = None
                    for b_txt in _yt_badge_texts(lvm):
                        parsed_c = _parse_int_count(b_txt)
                        if parsed_c is not None:
                            v_count = parsed_c
                            break
                    items.append(
                        make_item_entry(
                            source_id="youtube",
                            item_id=f"omni-yt-pl-{pl_id}",
                            item_type="playlist",
                            title=title,
                            original_url=f"https://www.youtube.com/playlist?list={pl_id}",
                            thumbnail=thumb,
                            creator_name=owner_name,
                            creator_avatar=thumb,
                            source_page=owner_url,
                            video_count=v_count,
                        )
                    )
            return

        if category == "playlists" and "playlistRenderer" in node and isinstance(node["playlistRenderer"], dict):
            pr = node["playlistRenderer"]
            pl_id = (pr.get("playlistId") or "").strip()
            if pl_id and pl_id not in seen_items:
                seen_items.add(pl_id)
                title = _yt_text(pr.get("title")).strip() or pl_id
                owner_name, owner_url = _yt_owner_from_runs(pr.get("shortBylineText") or pr.get("longBylineText"))
                thumbs = pr.get("thumbnails") or []
                thumb = (_best_yt_thumbnail(thumbs[0])[0] if thumbs else None) or ""
                v_count = _parse_int_count(str(pr.get("videoCount") or _yt_text(pr.get("videoCountText"))))
                items.append(
                    make_item_entry(
                        source_id="youtube",
                        item_id=f"omni-yt-pl-{pl_id}",
                        item_type="playlist",
                        title=title,
                        original_url=f"https://www.youtube.com/playlist?list={pl_id}",
                        thumbnail=thumb,
                        creator_name=owner_name,
                        creator_avatar=thumb,
                        source_page=owner_url,
                        video_count=v_count,
                    )
                )
            return

        for v in node.values():
            _walk(v)

    _walk(data)
    api_key, client_version = _extract_yt_innertube_context(raw_html)
    next_tok = continuation_tokens[0] if continuation_tokens else None
    return profiles, items, next_tok, api_key, client_version


class YouTubeSearchProvider:
    """Federated search adapter for YouTube videos, shorts, channels, and playlists."""

    capabilities = SearchProviderCapabilities(
        source_id="youtube",
        display_name="YouTube",
        categories=("videos", "shorts", "profiles", "playlists"),
        supports_live_connector=False,
    )

    _INITIAL_SP: dict[SearchCategory, str] = {
        "videos": "",
        "shorts": "",
        "profiles": "EgIQAg%3D%3D",
        "playlists": "EgIQAw%3D%3D",
    }

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        cursor: str | None = None,
    ) -> SearchPageResult:
        from .profile_hub_workers import _extract_yt_initial_data

        if category not in self.capabilities.categories:
            return SearchPageResult(source_id="youtube", category=category)

        cursor_data = decode_search_cursor(cursor)
        headers = {"Accept-Language": "en-US,en;q=0.9"}
        try:
            if cursor_data.get("token"):
                token = str(cursor_data["token"])
                api_key = str(cursor_data.get("api_key") or "")
                client_version = str(cursor_data.get("client_version") or "2.20260101.00.00")
                endpoint = f"https://www.youtube.com/youtubei/v1/search?key={quote(api_key, safe='')}"
                body = {
                    "context": {
                        "client": {
                            "clientName": "WEB",
                            "clientVersion": client_version,
                            "hl": "en",
                            "gl": "US",
                        }
                    },
                    "continuation": token,
                }
                resp = await client.post(endpoint, json=body, headers=headers)
                if resp.status_code != 200:
                    return SearchPageResult(
                        source_id="youtube",
                        category=category,
                        error=f"http_{resp.status_code}",
                    )
                payload = resp.json()
                profiles, items, next_tok, _, _ = parse_youtube_search_payload(payload, query, category)
                has_page_results = bool(items or profiles)
                can_more = bool(next_tok and has_page_results)
                next_cursor = (
                    encode_search_cursor(
                        {"token": next_tok, "api_key": api_key, "client_version": client_version}
                    )
                    if can_more
                    else None
                )
                return SearchPageResult(
                    source_id="youtube",
                    category=category,
                    profiles=profiles,
                    items=items,
                    next_cursor=next_cursor,
                    has_more=can_more,
                )

            sp = self._INITIAL_SP.get(category, "")
            search_url = f"https://www.youtube.com/results?search_query={quote_plus(query.strip())}"
            if sp:
                search_url += f"&sp={sp}"
            resp = await client.get(search_url, headers=headers)
            if resp.status_code != 200:
                return SearchPageResult(
                    source_id="youtube",
                    category=category,
                    error=f"http_{resp.status_code}",
                )
            yt_data = _extract_yt_initial_data(resp.text)
            if not yt_data:
                return SearchPageResult(source_id="youtube", category=category)
            profiles, items, next_tok, api_key, client_version = parse_youtube_search_payload(
                yt_data, query, category, raw_html=resp.text
            )
            can_paginate = bool(next_tok and api_key and (items or profiles))
            next_cursor = (
                encode_search_cursor(
                    {
                        "token": next_tok,
                        "api_key": api_key,
                        "client_version": client_version or "2.20260101.00.00",
                    }
                )
                if can_paginate
                else None
            )
            return SearchPageResult(
                source_id="youtube",
                category=category,
                profiles=profiles,
                items=items,
                next_cursor=next_cursor,
                has_more=can_paginate,
            )
        except Exception as exc:
            return SearchPageResult(source_id="youtube", category=category, error=str(exc))


def _portal_grid_search_slug(query: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", query.strip().lower()).strip("-")
    return slug or quote(query.strip(), safe="")


def _clean_portal_grid_title(raw: str | None) -> str:
    cleaned = re.sub(r"[\u200b-\u200f\ufeff]+", "", str(raw or ""))
    cleaned = re.sub(r"\s*Explore Full Videos.*$", "", cleaned, flags=re.I)
    return re.sub(r"\s+", " ", cleaned).strip()


def _extract_portal_grid_next_url(tree: LexborHTMLParser, final_url: str, current_page: int) -> str | None:
    target_num = str(current_page + 1)
    fallback_next: str | None = None
    for a in tree.css(".numlist2 a[href], .numlist a[href], a[rel='next']"):
        href = (a.attributes.get("href") or "").strip()
        if not href or href == "#" or href.lower().startswith("javascript"):
            continue
        abs_url = urljoin(final_url, href)
        if not abs_url.startswith(("http://", "https://")):
            continue
        txt = a.text(strip=True)
        rel = (a.attributes.get("rel") or "").lower()
        if txt == target_num or re.search(rf"/{target_num}/?$", urlsplit(abs_url).path):
            return abs_url
        if "next" in rel or txt in (">", "»", "Next", "Próximo"):
            fallback_next = abs_url
    return fallback_next


def _portal_grid_playlist_creator(playlist_url: str) -> tuple[str, str]:
    m = re.search(r"/profile/([^/?#]+)/", playlist_url or "", re.I)
    if not m:
        return "", ""
    username = m.group(1).strip()
    if not username:
        return "", ""
    parts = urlsplit(playlist_url or "")
    origin = f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else native_adapter_url("portal_grid", "https://portal-grid.example")
    return username, f"{origin}/profile/{username}/"


class PortalGridSearchProvider:
    """Federated search adapter for PortalGrid videos, pornstars, playlists, and photo albums."""

    capabilities = SearchProviderCapabilities(
        source_id="portal_grid",
        display_name="PortalGrid",
        categories=("videos", "profiles", "playlists", "albums"),
        supports_live_connector=False,
    )

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        cursor: str | None = None,
    ) -> SearchPageResult:
        from .profile_hub_workers import (
            extract_portal_grid_albums_lexbor,
            extract_portal_grid_playlists_lexbor,
            extract_portal_grid_videos_lexbor,
        )

        if category not in self.capabilities.categories:
            return SearchPageResult(source_id="portal_grid", category=category)

        slug = _portal_grid_search_slug(query)
        cursor_data = decode_search_cursor(cursor)
        current_page = int(cursor_data.get("page") or 1)
        default_urls = {
            "videos": native_adapter_url("portal_grid", f"https://portal-grid.example/search/{slug}/"),
            "profiles": native_adapter_url("portal_grid", f"https://portal-grid.example/search-pornstars/{slug}/"),
            "playlists": native_adapter_url("portal_grid", f"https://portal-grid.example/search-playlists/{slug}/"),
            "albums": native_adapter_url("portal_grid", f"https://portal-grid.example/search-photos/{slug}/"),
        }
        target_url = str(cursor_data.get("url") or default_urls[category])
        try:
            resp = await client.get(target_url)
            if resp.status_code != 200:
                return SearchPageResult(source_id="portal_grid", category=category, error=f"http_{resp.status_code}")

            final_url = str(resp.url)
            tree = LexborHTMLParser(resp.text)
            next_url = _extract_portal_grid_next_url(tree, final_url, current_page)
            next_cursor = (
                encode_search_cursor({"url": next_url, "page": current_page + 1}) if next_url else None
            )

            if category == "profiles":
                profiles: list[dict[str, Any]] = []
                seen_p: set[str] = set()
                for card in tree.css(".mbprofile"):
                    a = card.css_first("a[href]")
                    if not a:
                        continue
                    p_url = urljoin(final_url, a.attributes.get("href") or "")
                    if not p_url or p_url in seen_p:
                        continue
                    seen_p.add(p_url)
                    img = card.css_first("img")
                    avatar = _http_url(
                        final_url,
                        (img.attributes.get("data-src") or img.attributes.get("src")) if img else "",
                    )
                    title_el = card.css_first(".mbtit, .mbtitle")
                    name = (title_el.text(strip=True) if title_el else a.attributes.get("title") or "").strip()
                    if not name:
                        name = p_url.rstrip("/").split("/")[-1].replace("-", " ").title()
                    raw_txt = card.text(separator=" ", strip=True)
                    v_m = re.search(r"Videos:\s*(\d+)", raw_txt, re.I)
                    p_m = re.search(r"Photos:\s*(\d+)", raw_txt, re.I)
                    profiles.append(
                        make_profile_entry(
                            source_id="portal_grid",
                            entry_id=f"ep-prof-{hashlib.sha256(p_url.encode()).hexdigest()[:12]}",
                            name=name,
                            profile_url=p_url,
                            avatar=avatar,
                            videos_count=int(v_m.group(1)) if v_m else None,
                            photos_count=int(p_m.group(1)) if p_m else None,
                        )
                    )
                return SearchPageResult(
                    source_id="portal_grid",
                    category=category,
                    profiles=profiles,
                    next_cursor=next_cursor,
                    has_more=bool(next_url),
                )

            if category == "videos":
                uploader_by_url: dict[str, tuple[str, str]] = {}
                for box in tree.css("div.mb"):
                    v_a = box.css_first("a[href*='/video-'], .mbtit a[href]")
                    up_a = box.css_first(".mb-uploader a[href], .mbuploader a[href]")
                    if v_a and up_a:
                        v_href = _http_url(final_url, v_a.attributes.get("href") or "")
                        up_name = up_a.text(strip=True)
                        up_href = _http_url(final_url, up_a.attributes.get("href") or "")
                        if v_href and up_name:
                            uploader_by_url[v_href] = (up_name, up_href)

                v_can, _ = extract_portal_grid_videos_lexbor(final_url, tree)
                items: list[dict[str, Any]] = []
                seen_v: set[str] = set()
                for v in v_can:
                    orig = str(v.get("originalUrl") or "")
                    if not orig or orig in seen_v:
                        continue
                    seen_v.add(orig)
                    up_name, up_url = uploader_by_url.get(orig, ("", ""))
                    if not up_name:
                        up_name = str(v.get("author") or v.get("uploader") or "").strip()
                        up_url = str(v.get("authorUrl") or "").strip()
                    items.append(
                        make_item_entry(
                            source_id="portal_grid",
                            item_id=f"omni-ep-{v.get('id') or len(items) + 1}",
                            item_type="video",
                            title=_clean_portal_grid_title(str(v.get("title") or "")) or "PortalGrid Video",
                            original_url=orig,
                            thumbnail=str(v.get("thumbnailUrl") or ""),
                            creator_name=up_name,
                            creator_avatar=str(v.get("thumbnailUrl") or ""),
                            source_page=up_url,
                            duration=str(v.get("duration") or ""),
                            views=str(v.get("views") or ""),
                            resolution=str(v.get("resolution") or "HD"),
                            date=str(v.get("timeAgo") or ""),
                            neutral_label="PortalGrid",
                        )
                    )
                return SearchPageResult(
                    source_id="portal_grid",
                    category=category,
                    items=items,
                    next_cursor=next_cursor,
                    has_more=bool(next_url),
                )

            if category == "playlists":
                pl_can, _, _ = extract_portal_grid_playlists_lexbor(final_url, final_url, tree, "")
                items = []
                seen_pl: set[str] = set()
                for pl in pl_can:
                    orig = str(pl.get("url") or pl.get("originalUrl") or "")
                    if not orig or orig in seen_pl:
                        continue
                    seen_pl.add(orig)
                    c_name, c_page = _portal_grid_playlist_creator(orig)
                    items.append(
                        make_item_entry(
                            source_id="portal_grid",
                            item_id=f"omni-ep-pl-{pl.get('id') or len(items) + 1}",
                            item_type="playlist",
                            title=str(pl.get("title") or "Playlist"),
                            original_url=orig,
                            thumbnail=str(pl.get("thumbnailUrl") or ""),
                            creator_name=c_name,
                            source_page=c_page,
                            video_count=pl.get("videoCount"),
                            neutral_label="PortalGrid",
                        )
                    )
                return SearchPageResult(
                    source_id="portal_grid",
                    category=category,
                    items=items,
                    next_cursor=next_cursor,
                    has_more=bool(next_url),
                )

            # albums
            alb_can, _ = extract_portal_grid_albums_lexbor(final_url, tree)
            items = []
            seen_alb: set[str] = set()
            for alb in alb_can:
                alb_url = str(alb.get("url") or alb.get("originalUrl") or "")
                if not alb_url or alb_url in seen_alb:
                    continue
                seen_alb.add(alb_url)
                cover = str(alb.get("thumbnailUrl") or "")
                items.append(
                    make_item_entry(
                        source_id="portal_grid",
                        item_id=f"omni-ep-alb-{alb.get('id') or len(items) + 1}",
                        item_type="photo_grid",
                        title=str(alb.get("title") or "PortalGrid Album"),
                        original_url=alb_url,
                        album_url=alb_url,
                        thumbnail=cover,
                        photos=[cover] if cover else [],
                        photo_count=alb.get("photoCount"),
                        neutral_label="PortalGrid",
                    )
                )
            return SearchPageResult(
                source_id="portal_grid",
                category=category,
                items=items,
                next_cursor=next_cursor,
                has_more=bool(next_url),
            )
        except Exception as exc:
            return SearchPageResult(source_id="portal_grid", category=category, error=str(exc))


_PH_COOKIES = {"accessAgeDisclaimerPH": "1", "age_verified": "1"}


def _has_ph_next_page(tree: LexborHTMLParser, current_page: int) -> bool:
    for a in tree.css(".pagination3 li.page_next a[href], li.page_next a[href], .pagination3 a[href]"):
        href = (a.attributes.get("href") or "").strip()
        if not href or href == "#":
            continue
        parent_cls = (a.parent.attributes.get("class") or "") if a.parent else ""
        if "page_next" in parent_cls or "next" in (a.attributes.get("rel") or "").lower():
            return True
        if f"page={current_page + 1}" in href:
            return True
    return False


class PortalTubeSearchProvider:
    """Federated search adapter for PortalTube videos, pornstars, channels, albums, and GIFs."""

    capabilities = SearchProviderCapabilities(
        source_id="portal_tube",
        display_name="PortalTube",
        categories=("videos", "profiles", "albums", "gifs"),
        supports_live_connector=False,
    )

    async def _get_ph(self, client: httpx.AsyncClient, url: str) -> httpx.Response:
        headers = {"Cookie": "accessAgeDisclaimerPH=1; age_verified=1"}
        resp = await client.get(url, headers=headers)
        if resp.status_code == 200 and "leastFactor" in resp.text:
            await asyncio.sleep(0.2)
            resp = await client.get(url, headers=headers)
        return resp

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        cursor: str | None = None,
    ) -> SearchPageResult:
        from .profile_hub_workers import (
            _decompose_portal_tube_sitewide,
            extract_portal_tube_albums_lexbor,
            extract_portal_tube_gifs_lexbor,
            extract_portal_tube_videos_lexbor,
        )

        if category not in self.capabilities.categories:
            return SearchPageResult(source_id="portal_tube", category=category)

        q_enc = quote_plus(query.strip())
        cursor_data = decode_search_cursor(cursor)
        try:
            if category == "profiles":
                ps_page = cursor_data.get("ps_page", 1) if cursor_data else 1
                ch_page = cursor_data.get("ch_page", 1) if cursor_data else 1
                ps_url = native_adapter_url("portal_tube", f"https://portal-tube.example/pornstars/search?search={q_enc}&page={ps_page}") if ps_page else None
                ch_url = native_adapter_url("portal_tube", f"https://portal-tube.example/channels/search?channelSearch={q_enc}&page={ch_page}") if ch_page else None
                tasks = []
                if ps_url:
                    tasks.append(self._get_ph(client, ps_url))
                if ch_url:
                    tasks.append(self._get_ph(client, ch_url))
                resps = await asyncio.gather(*tasks, return_exceptions=True)
                idx = 0
                profiles: list[dict[str, Any]] = []
                seen_p: set[str] = set()
                next_ps: int | None = None
                next_ch: int | None = None

                if ps_url:
                    r_ps = resps[idx]
                    idx += 1
                    if isinstance(r_ps, httpx.Response) and r_ps.status_code == 200:
                        t_ps = LexborHTMLParser(r_ps.text)
                        for li in t_ps.css("#pornstarsSearchResult li, ul.pornstarSearchResult li"):
                            a = (
                                li.css_first(".thumbnail-info-wrapper a.title")
                                or li.css_first("a.title")
                                or li.css_first(".title a")
                                or li.css_first("a[href*='/pornstar/'], a[href*='/model/']")
                            )
                            if not a:
                                continue
                            p_url = _http_url(native_adapter_url("portal_tube", "https://portal-tube.example"), a.attributes.get("href") or "")
                            if not p_url or p_url in seen_p:
                                continue
                            seen_p.add(p_url)
                            img = li.css_first("img")
                            avatar = _http_url(
                                native_adapter_url("portal_tube", "https://portal-tube.example"),
                                (img.attributes.get("data-thumb_url") or img.attributes.get("data-src") or img.attributes.get("src")) if img else "",
                            )
                            raw_a_name = a.text(strip=True)
                            if re.match(r"^rank\s*:\s*\d+$", raw_a_name, re.I):
                                raw_a_name = ""
                            name = (
                                raw_a_name
                                or (img.attributes.get("alt") if img else "")
                                or p_url.rstrip("/").split("/")[-1].replace("-", " ").title()
                            ).strip()
                            vids_el = li.css_first(".videosNumber")
                            views_el = li.css_first(".pstarViews")
                            vids_num = _parse_int_count(vids_el.text(strip=True) if vids_el else "")
                            subs_label = views_el.text(strip=True) if views_el else ""
                            verified = bool(li.css_first(".verifiedIcon, .verified-icon, [title*='Verified']"))
                            profiles.append(
                                make_profile_entry(
                                    source_id="portal_tube",
                                    entry_id=f"ph-ps-{hashlib.sha256(p_url.encode()).hexdigest()[:12]}",
                                    name=name,
                                    profile_url=p_url,
                                    avatar=avatar,
                                    verified=verified,
                                    subscribers_text=subs_label,
                                    videos_count=vids_num,
                                )
                            )
                        if _has_ph_next_page(t_ps, int(ps_page)):
                            next_ps = int(ps_page) + 1

                if ch_url:
                    r_ch = resps[idx]
                    if isinstance(r_ch, httpx.Response) and r_ch.status_code == 200:
                        t_ch = LexborHTMLParser(r_ch.text)
                        for wrapper in t_ch.css("#searchChannelsSection .channelsWrapper"):
                            title_a = (
                                wrapper.css_first(".descriptionContainer a.usernameLink")
                                or wrapper.css_first(".channelTitle a")
                                or next((el for el in wrapper.css("a.usernameLink") if el.text(strip=True)), None)
                                or wrapper.css_first("a[href*='/channels/']")
                            )
                            if not title_a:
                                continue
                            p_url = _http_url(native_adapter_url("portal_tube", "https://portal-tube.example"), title_a.attributes.get("href") or "")
                            if not p_url or "/channels/" not in p_url or p_url in seen_p:
                                continue
                            seen_p.add(p_url)
                            img = wrapper.css_first("img")
                            avatar = _http_url(
                                native_adapter_url("portal_tube", "https://portal-tube.example"),
                                (img.attributes.get("data-thumb_url") or img.attributes.get("data-src") or img.attributes.get("src")) if img else "",
                            )
                            raw_ch_name = title_a.text(strip=True)
                            if re.match(r"^rank\s*:?\s*\d+$", raw_ch_name, re.I):
                                raw_ch_name = ""
                            alt_name = re.sub(r"\s+avatar$", "", (img.attributes.get("alt") or "") if img else "", flags=re.I).strip()
                            name = (raw_ch_name or alt_name or p_url.rstrip("/").split("/")[-1].replace("-", " ").title()).strip()
                            if not name:
                                continue
                            desc_txt = wrapper.css_first(".descriptionContainer")
                            desc_raw = desc_txt.text(separator=" ", strip=True) if desc_txt else ""
                            m_sub = re.search(r"([\d,.]+[KMBkmb]?)\s*Subscribers", desc_raw, re.I)
                            m_vid = re.search(r"([\d,.]+[KMBkmb]?)\s*Videos", desc_raw, re.I)
                            subs_label = f"{m_sub.group(1)} subscribers" if m_sub else ""
                            profiles.append(
                                make_profile_entry(
                                    source_id="portal_tube",
                                    entry_id=f"ph-ch-{hashlib.sha256(p_url.encode()).hexdigest()[:12]}",
                                    name=name,
                                    profile_url=p_url,
                                    avatar=avatar,
                                    followers=_parse_int_count(m_sub.group(1)) if m_sub else None,
                                    subscribers_text=subs_label,
                                    videos_count=_parse_int_count(m_vid.group(1)) if m_vid else None,
                                )
                            )
                        if _has_ph_next_page(t_ch, int(ch_page)):
                            next_ch = int(ch_page) + 1

                has_more = bool(next_ps or next_ch)
                next_cursor = encode_search_cursor({"ps_page": next_ps, "ch_page": next_ch}) if has_more else None
                return SearchPageResult(
                    source_id="portal_tube",
                    category=category,
                    profiles=profiles,
                    next_cursor=next_cursor,
                    has_more=has_more,
                )

            page = int(cursor_data.get("page") or 1)
            route_map = {
                "videos": native_adapter_url("portal_tube", f"https://portal-tube.example/video/search?search={q_enc}&page={page}"),
                "albums": native_adapter_url("portal_tube", f"https://portal-tube.example/albums?search={q_enc}&page={page}"),
                "gifs": native_adapter_url("portal_tube", f"https://portal-tube.example/gifs/search?search={q_enc}&page={page}"),
            }
            url = route_map[category]
            resp = await self._get_ph(client, url)
            if resp.status_code != 200:
                return SearchPageResult(source_id="portal_tube", category=category, error=f"http_{resp.status_code}")
            tree = LexborHTMLParser(resp.text)
            has_next = _has_ph_next_page(tree, page)
            next_cursor = encode_search_cursor({"page": page + 1}) if has_next else None

            if category == "videos":
                _decompose_portal_tube_sitewide(tree)
                uploader_by_key: dict[str, tuple[str, str]] = {}
                for li in tree.css("#videoSearchResult li.pcVideoListItem, ul.search-video-thumbs li.pcVideoListItem, li.pcVideoListItem"):
                    vkey = (li.attributes.get("data-video-vkey") or "").strip()
                    u_a = li.css_first(".usernameWrap a[href], .videoUploaderBlock a[href]")
                    if u_a:
                        u_name = u_a.text(strip=True)
                        u_href = _http_url(native_adapter_url("portal_tube", "https://portal-tube.example"), u_a.attributes.get("href") or "")
                        if u_name and vkey and u_href:
                            uploader_by_key[vkey] = (u_name, u_href)
                        thumb_a = li.css_first("a.linkVideoThumb[href], a[href*='viewkey=']")
                        if thumb_a and u_name:
                            v_thumb_url = _http_url(native_adapter_url("portal_tube", "https://portal-tube.example"), thumb_a.attributes.get("href") or "")
                            if v_thumb_url:
                                uploader_by_key[v_thumb_url] = (u_name, u_href)

                search_node = tree.css_first("#videoSearchResult")
                v_can, _ = extract_portal_tube_videos_lexbor(url, search_node.html if search_node else tree)
                items: list[dict[str, Any]] = []
                seen_v: set[str] = set()
                for v in v_can:
                    orig = str(v.get("originalUrl") or "")
                    if not orig or orig in seen_v:
                        continue
                    seen_v.add(orig)
                    vid_id = str(v.get("id") or "")
                    up_name, up_url = uploader_by_key.get(vid_id) or uploader_by_key.get(orig) or ("", "")
                    if not up_name:
                        up_name = str(v.get("uploader") or "").strip()
                        up_url = str(v.get("uploaderUrl") or "").strip()
                    items.append(
                        make_item_entry(
                            source_id="portal_tube",
                            item_id=f"omni-ph-{vid_id or len(items) + 1}",
                            item_type="video",
                            title=str(v.get("title") or "PortalTube Video"),
                            original_url=orig,
                            thumbnail=str(v.get("thumbnailUrl") or ""),
                            creator_name=up_name,
                            creator_avatar=str(v.get("thumbnailUrl") or ""),
                            source_page=up_url,
                            duration=str(v.get("duration") or ""),
                            views=str(v.get("views") or ""),
                            resolution=str(v.get("resolution") or "HD"),
                            date=str(v.get("timeAgo") or ""),
                            neutral_label="PortalTube",
                        )
                    )
                return SearchPageResult(
                    source_id="portal_tube",
                    category=category,
                    items=items,
                    next_cursor=next_cursor,
                    has_more=has_next,
                )

            if category == "albums":
                alb_can, _ = extract_portal_tube_albums_lexbor(url, tree)
                items = []
                seen_a: set[str] = set()
                for a in alb_can:
                    orig = str(a.get("url") or a.get("originalUrl") or "")
                    if not orig or orig in seen_a:
                        continue
                    seen_a.add(orig)
                    cover = str(a.get("thumbnailUrl") or "")
                    items.append(
                        make_item_entry(
                            source_id="portal_tube",
                            item_id=f"omni-ph-alb-{a.get('id') or len(items) + 1}",
                            item_type="photo_grid",
                            title=str(a.get("title") or "PortalTube Album"),
                            original_url=orig,
                            album_url=orig,
                            thumbnail=cover,
                            photos=[cover] if cover else [],
                            photo_count=a.get("photoCount"),
                            neutral_label="PortalTube",
                        )
                    )
                return SearchPageResult(
                    source_id="portal_tube",
                    category=category,
                    items=items,
                    next_cursor=next_cursor,
                    has_more=has_next,
                )

            # gifs
            gif_can, _ = extract_portal_tube_gifs_lexbor(url, tree)
            items = []
            seen_g: set[str] = set()
            for g in gif_can:
                orig = str(g.get("originalUrl") or g.get("pageUrl") or "")
                stream_src = str(g.get("streamUrl") or g.get("mp4Url") or g.get("originalUrl") or "")
                key = orig or stream_src
                if not key or key in seen_g:
                    continue
                seen_g.add(key)
                thumb = str(g.get("thumbnailUrl") or "")
                video_proxy = (
                    stream_src
                    if stream_src.startswith("/api/")
                    else f"/api/proxy-video-stream?url={quote(stream_src, safe='')}&referer={quote(native_adapter_url('portal_tube', 'https://portal-tube.example/'), safe='')}"
                )
                items.append(
                    make_item_entry(
                        source_id="portal_tube",
                        item_id=f"omni-ph-gif-{g.get('id') or len(items) + 1}",
                        item_type="gif",
                        title=str(g.get("title") or "PortalTube GIF"),
                        original_url=str(g.get("pageUrl") or orig),
                        thumbnail=thumb,
                        video_url=video_proxy,
                        views=str(g.get("views") or ""),
                        neutral_label="PortalTube",
                    )
                )
            return SearchPageResult(
                source_id="portal_tube",
                category=category,
                items=items,
                next_cursor=next_cursor,
                has_more=has_next,
            )
        except Exception as exc:
            return SearchPageResult(source_id="portal_tube", category=category, error=str(exc))


_PORTAL_STATE_VIDEO_META_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_PORTAL_STATE_CACHE_TTL_SECONDS = 600.0
_PORTAL_STATE_META_CONCURRENCY = 8


def _format_xh_views(raw_views: Any) -> str:
    if raw_views is None or raw_views == "":
        return ""
    if isinstance(raw_views, (int, float)):
        n = float(raw_views)
    else:
        s = str(raw_views).strip()
        if not s:
            return ""
        digits = s.replace(",", "").strip()
        if not digits.isdigit():
            return s
        n = float(int(digits))
    if n <= 0:
        return ""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}".rstrip("0").rstrip(".") + "M"
    if n >= 10_000:
        return f"{round(n / 1_000)}K"
    if n >= 1_000:
        return f"{n / 1_000:.1f}".rstrip("0").rstrip(".") + "K"
    return str(int(n))


def _format_xh_created_date(created_val: Any) -> str:
    if isinstance(created_val, (int, float)) and created_val > 0:
        try:
            return datetime.fromtimestamp(float(created_val), timezone.utc).strftime("%Y-%m-%d")
        except Exception:
            return ""
    return ""


def _pick_portal_state_performer(models: Any, query: str) -> dict[str, Any] | None:
    if not isinstance(models, list):
        return None
    candidates = [m for m in models if isinstance(m, dict) and str(m.get("name") or "").strip()]
    if not candidates:
        return None
    q_tokens = [tok for tok in re.findall(r"[a-z0-9]{2,}", (query or "").lower())]
    if q_tokens:
        for cand in candidates:
            low_name = str(cand.get("name") or "").lower()
            if any(tok in low_name for tok in q_tokens):
                return cand
    return candidates[0]


def _extract_portal_state_video_page_creator(html: str, query: str) -> dict[str, Any]:
    from .profile_hub_workers import _extract_window_initials

    initials = _extract_window_initials(html or "")
    vm = initials.get("videoModel") if isinstance(initials, dict) else None
    ve = initials.get("videoEntity") if isinstance(initials, dict) else None
    vm = vm if isinstance(vm, dict) else {}
    ve = ve if isinstance(ve, dict) else {}

    tree = LexborHTMLParser(html or "")
    channel = vm.get("channelModel")
    author = vm.get("author")
    channel = channel if isinstance(channel, dict) else {}
    author = author if isinstance(author, dict) else {}

    creator_name = ""
    source_page = ""
    creator_avatar = ""

    ch_name = str(channel.get("name") or "").strip()
    ch_url = str(channel.get("pageURL") or channel.get("link") or "").strip()
    ch_logo = str(channel.get("logo") or "").strip()

    auth_name = str(author.get("name") or "").strip()
    auth_url = str(author.get("pageURL") or "").strip()
    auth_valid = bool(auth_name and auth_name.lower() not in {"user deleted", "deleted", "anonymous"})

    if ch_name and ch_url:
        creator_name = ch_name
        source_page = ch_url
        creator_avatar = ch_logo
    elif auth_valid and auth_url:
        creator_name = auth_name
        source_page = auth_url
        auth_img = tree.css_first(".entity-author-container img, a.entity-author-container__name img")
        if auth_img:
            creator_avatar = str(auth_img.attributes.get("src") or auth_img.attributes.get("data-src") or "").strip()
    else:
        perf = _pick_portal_state_performer(ve.get("pornstarModels") or vm.get("pornstarModels"), query)
        if perf:
            creator_name = str(perf.get("name") or "").strip()
            inurl = str(perf.get("inurl") or "").strip().strip("/")
            if inurl:
                source_page = native_adapter_url("portal_state", f"https://portal-state.example/pornstars/{inurl}")
                for a in tree.css(f"a[href*='/pornstars/{inurl}']"):
                    img = a.css_first("img")
                    if img:
                        creator_avatar = str(img.attributes.get("src") or img.attributes.get("data-src") or "").strip()
                        if creator_avatar:
                            break
        elif auth_valid:
            creator_name = auth_name

    return {
        "creator_name": creator_name,
        "source_page": source_page,
        "creator_avatar": creator_avatar,
        "resolution": str(ve.get("maxResolution") or "").strip(),
        "date": str(ve.get("dateAgo") or "").strip(),
    }


async def _fetch_portal_state_video_creator_meta(
    client: httpx.AsyncClient,
    video_url: str,
    query: str,
    sem: asyncio.Semaphore,
) -> dict[str, Any]:
    now = time.time()
    cache_key = f"{video_url}::{query.strip().lower()}"
    cached = _PORTAL_STATE_VIDEO_META_CACHE.get(cache_key)
    if cached and (now - cached[0]) < _PORTAL_STATE_CACHE_TTL_SECONDS:
        return cached[1]
    async with sem:
        try:
            resp = await client.get(video_url, timeout=3.5)
            if resp.status_code != 200 or not resp.text:
                return {}
            meta = _extract_portal_state_video_page_creator(resp.text, query)
            if len(_PORTAL_STATE_VIDEO_META_CACHE) >= 500:
                oldest = sorted(_PORTAL_STATE_VIDEO_META_CACHE.items(), key=lambda kv: kv[1][0])[:100]
                for k, _ in oldest:
                    _PORTAL_STATE_VIDEO_META_CACHE.pop(k, None)
            _PORTAL_STATE_VIDEO_META_CACHE[cache_key] = (now, meta)
            return meta
        except Exception:
            return {}


class PortalStateSearchProvider:
    """Federated search adapter for PortalState videos, creators (from landing & page metadata), and photo albums."""

    capabilities = SearchProviderCapabilities(
        source_id="portal_state",
        display_name="PortalState",
        categories=("videos", "profiles", "albums"),
        supports_live_connector=False,
    )

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        cursor: str | None = None,
    ) -> SearchPageResult:
        from .profile_hub_workers import (
            _extract_window_initials,
            extract_portal_state_albums_lexbor,
            extract_portal_state_videos_lexbor,
        )

        if category not in self.capabilities.categories:
            return SearchPageResult(source_id="portal_state", category=category)

        q_enc = quote(query.strip(), safe="")
        cursor_data = decode_search_cursor(cursor)
        page = int(cursor_data.get("page") or 1)
        try:
            if category == "albums":
                url = native_adapter_url("portal_state", f"https://portal-state.example/photos/search/{q_enc}") + (f"?page={page}" if page > 1 else "")
                resp = await client.get(url)
                if resp.status_code != 200:
                    return SearchPageResult(source_id="portal_state", category=category, error=f"http_{resp.status_code}")
                initials = _extract_window_initials(resp.text)
                photo_comp = (initials.get("searchResultsPhotoComponent") or {}) if isinstance(initials, dict) else {}
                pag = (
                    (photo_comp.get("pagination") if isinstance(photo_comp, dict) else None)
                    or (initials.get("pagination") if isinstance(initials, dict) else None)
                    or {}
                )
                next_p = pag.get("next") if isinstance(pag, dict) else None
                max_p = (pag.get("maxPages") or 1) if isinstance(pag, dict) else 1
                tree = LexborHTMLParser(resp.text)
                has_dom_next = bool(tree.css_first("a[rel='next'], li.next a[href], .pager-next a[href]"))
                if not next_p and has_dom_next:
                    next_p = page + 1
                can_more = bool(next_p and int(next_p) > page and (has_dom_next or not max_p or int(next_p) <= int(max_p)))
                next_cursor = encode_search_cursor({"page": int(next_p)}) if can_more else None

                plist = (photo_comp.get("list") or []) if isinstance(photo_comp, dict) else []
                items: list[dict[str, Any]] = []
                profiles: list[dict[str, Any]] = []
                seen_a: set[str] = set()
                seen_prof: set[str] = set()

                if isinstance(plist, list) and plist:
                    for g in plist:
                        if not isinstance(g, dict):
                            continue
                        orig = str(g.get("pageURL") or "").strip()
                        if not orig or orig in seen_a:
                            continue
                        seen_a.add(orig)
                        cover = str(g.get("imageURL") or g.get("thumbURL") or g.get("previewThumbURL") or "").strip()
                        author = g.get("author") if isinstance(g.get("author"), dict) else {}
                        a_name = str(author.get("name") or "").strip()
                        a_link = str(author.get("link") or "").strip()
                        a_img = str(author.get("img") or "").strip()
                        if a_name and a_link and a_link not in seen_prof:
                            seen_prof.add(a_link)
                            profiles.append(
                                make_profile_entry(
                                    source_id="portal_state",
                                    entry_id=f"xh-prof-{hashlib.sha256(a_link.encode()).hexdigest()[:12]}",
                                    name=a_name,
                                    profile_url=a_link,
                                    avatar=a_img,
                                )
                            )
                        pcount = g.get("imgCount")
                        items.append(
                            make_item_entry(
                                source_id="portal_state",
                                item_id=f"omni-xh-alb-{g.get('id') or len(items) + 1}",
                                item_type="photo_grid",
                                title=str(g.get("titleLocalized") or g.get("title") or "PortalState Gallery"),
                                original_url=orig,
                                album_url=orig,
                                thumbnail=cover,
                                photos=[cover] if cover else [],
                                photo_count=int(pcount) if isinstance(pcount, int) else None,
                                creator_name=a_name,
                                creator_avatar=a_img or cover,
                                source_page=a_link,
                                views=_format_xh_views(g.get("views")),
                                neutral_label="PortalState",
                            )
                        )
                else:
                    alb_can, _ = extract_portal_state_albums_lexbor(url, tree)
                    for a in alb_can:
                        orig = str(a.get("url") or a.get("originalUrl") or "")
                        if not orig or orig in seen_a:
                            continue
                        seen_a.add(orig)
                        cover = str(a.get("thumbnailUrl") or "")
                        items.append(
                            make_item_entry(
                                source_id="portal_state",
                                item_id=f"omni-xh-alb-{a.get('id') or len(items) + 1}",
                                item_type="photo_grid",
                                title=str(a.get("title") or "PortalState Gallery"),
                                original_url=orig,
                                album_url=orig,
                                thumbnail=cover,
                                photos=[cover] if cover else [],
                                photo_count=a.get("photoCount"),
                                views=_format_xh_views(a.get("views")),
                                neutral_label="PortalState",
                            )
                        )
                return SearchPageResult(
                    source_id="portal_state",
                    category=category,
                    profiles=profiles,
                    items=items,
                    next_cursor=next_cursor,
                    has_more=can_more,
                )

            # videos or profiles (extracted from searchResult.videoThumbProps + missing-landing video-page metadata)
            url = native_adapter_url("portal_state", f"https://portal-state.example/search/{q_enc}") + (f"?page={page}" if page > 1 else "")
            if category == "profiles":
                from .timeline_directory import search_adapted_directory_profiles

                result = await search_adapted_directory_profiles(client, self.capabilities.source_id, url, query, cursor)
                if result is not None:
                    return result
            resp = await client.get(url)
            if resp.status_code != 200:
                return SearchPageResult(source_id="portal_state", category=category, error=f"http_{resp.status_code}")

            initials = _extract_window_initials(resp.text)
            pag = (initials.get("pagination") or {}) if isinstance(initials, dict) else {}
            next_p = pag.get("next")
            max_p = pag.get("maxPages") or 1
            active_p = pag.get("active") or page
            can_more = bool(next_p and int(next_p) > int(active_p) and int(next_p) <= int(max_p))
            next_cursor = encode_search_cursor({"page": int(next_p)}) if can_more else None

            thumbs = ((initials.get("searchResult") or {}).get("videoThumbProps") or []) if isinstance(initials, dict) else []
            profiles = []
            items = []
            seen_prof = set()
            seen_v: set[str] = set()

            if isinstance(thumbs, list) and thumbs:
                missing_urls: list[str] = []
                for raw_v in thumbs:
                    if not isinstance(raw_v, dict):
                        continue
                    orig = str(raw_v.get("pageURL") or "").strip()
                    landing = raw_v.get("landing") or {}
                    c_name = str(landing.get("name") or "").strip() if isinstance(landing, dict) else ""
                    if orig and not c_name and orig not in missing_urls:
                        missing_urls.append(orig)

                hydrated_by_url: dict[str, dict[str, Any]] = {}
                if missing_urls:
                    sem = asyncio.Semaphore(_PORTAL_STATE_META_CONCURRENCY)
                    metas = await _gather_within_budget(
                        [_fetch_portal_state_video_creator_meta(client, u, query, sem) for u in missing_urls],
                        timeout=4.5,
                    )
                    for u, meta in zip(missing_urls, metas):
                        if isinstance(meta, dict) and meta:
                            hydrated_by_url[u] = meta

                for raw_v in thumbs:
                    if not isinstance(raw_v, dict):
                        continue
                    orig = str(raw_v.get("pageURL") or "").strip()
                    if not orig or orig in seen_v:
                        continue
                    seen_v.add(orig)
                    landing = raw_v.get("landing") or {}
                    c_name = str(landing.get("name") or "").strip() if isinstance(landing, dict) else ""
                    c_link = str(landing.get("link") or "").strip() if isinstance(landing, dict) else ""
                    c_logo = str(landing.get("logo") or "").strip() if isinstance(landing, dict) else ""
                    hydrated = hydrated_by_url.get(orig) or {}
                    if not c_name and hydrated:
                        c_name = str(hydrated.get("creator_name") or "").strip()
                        c_link = str(hydrated.get("source_page") or "").strip()
                        c_logo = str(hydrated.get("creator_avatar") or "").strip()

                    if c_name and c_link and c_link not in seen_prof:
                        seen_prof.add(c_link)
                        profiles.append(
                            make_profile_entry(
                                source_id="portal_state",
                                entry_id=f"xh-prof-{hashlib.sha256(c_link.encode()).hexdigest()[:12]}",
                                name=c_name,
                                profile_url=c_link,
                                avatar=c_logo,
                            )
                        )
                    dur_val = raw_v.get("duration")
                    if isinstance(dur_val, (int, float)) and dur_val > 0:
                        mins, secs = divmod(int(dur_val), 60)
                        hrs, mins = divmod(mins, 60)
                        dur_str = f"{hrs}:{mins:02d}:{secs:02d}" if hrs else f"{mins}:{secs:02d}"
                    else:
                        dur_str = str(dur_val or "")
                    thumb_u = str(raw_v.get("thumbURL") or raw_v.get("imageURL") or "")
                    res_str = str(hydrated.get("resolution") or "").strip() or (
                        "4K" if (raw_v.get("isUHD") or raw_v.get("isUhd")) else "HD"
                    )
                    date_str = _format_xh_created_date(raw_v.get("created")) or str(hydrated.get("date") or "")
                    items.append(
                        make_item_entry(
                            source_id="portal_state",
                            item_id=f"omni-xh-{raw_v.get('id') or len(items) + 1}",
                            item_type="video",
                            title=str(raw_v.get("title") or "PortalState Video"),
                            original_url=orig,
                            thumbnail=thumb_u,
                            creator_name=c_name,
                            creator_avatar=c_logo or thumb_u,
                            source_page=c_link,
                            duration=dur_str,
                            views=_format_xh_views(raw_v.get("views")),
                            resolution=res_str,
                            date=date_str,
                            neutral_label="PortalState",
                        )
                    )
            else:
                tree = LexborHTMLParser(resp.text)
                dom_creators: dict[str, tuple[str, str, str]] = {}
                for card in tree.css(".video-thumb, [data-video-id]"):
                    v_a = card.css_first("a.video-thumb__image-container, a[href*='/videos/']")
                    up_a = card.css_first("a.video-uploader__name")
                    if v_a and up_a:
                        v_href = str(v_a.attributes.get("href") or "").strip()
                        u_href = str(up_a.attributes.get("href") or "").strip()
                        u_name = up_a.text(strip=True)
                        logo_img = card.css_first("a.video-uploader-logo img")
                        u_logo = str(logo_img.attributes.get("src") or "") if logo_img else ""
                        if v_href and u_name:
                            dom_creators[v_href] = (u_name, u_href, u_logo)
                v_can, _ = extract_portal_state_videos_lexbor(url, tree)
                for v in v_can:
                    orig = str(v.get("originalUrl") or "")
                    if not orig or orig in seen_v:
                        continue
                    seen_v.add(orig)
                    c_name, c_link, c_logo = dom_creators.get(orig, ("", "", ""))
                    if c_name and c_link and c_link not in seen_prof:
                        seen_prof.add(c_link)
                        profiles.append(
                            make_profile_entry(
                                source_id="portal_state",
                                entry_id=f"xh-prof-{hashlib.sha256(c_link.encode()).hexdigest()[:12]}",
                                name=c_name,
                                profile_url=c_link,
                                avatar=c_logo,
                            )
                        )
                    items.append(
                        make_item_entry(
                            source_id="portal_state",
                            item_id=f"omni-xh-{v.get('id') or len(items) + 1}",
                            item_type="video",
                            title=str(v.get("title") or "PortalState Video"),
                            original_url=orig,
                            thumbnail=str(v.get("thumbnailUrl") or ""),
                            creator_name=c_name,
                            creator_avatar=c_logo or str(v.get("thumbnailUrl") or ""),
                            source_page=c_link,
                            duration=str(v.get("duration") or ""),
                            views=_format_xh_views(v.get("views")),
                            resolution=str(v.get("resolution") or "HD"),
                            date=str(v.get("timeAgo") or ""),
                            neutral_label="PortalState",
                        )
                    )

            if category == "profiles":
                return SearchPageResult(
                    source_id="portal_state",
                    category="profiles",
                    profiles=profiles,
                    next_cursor=next_cursor,
                    has_more=can_more,
                )
            return SearchPageResult(
                source_id="portal_state",
                category="videos",
                profiles=profiles,
                items=items,
                next_cursor=next_cursor,
                has_more=can_more,
            )
        except Exception as exc:
            return SearchPageResult(source_id="portal_state", category=category, error=str(exc))


_IMGUR_CLIENT_ID = "546c25a59c58ad7"


def _upgrade_imgur_thumb(url: str) -> tuple[str, str]:
    clean = url.split("?")[0]
    m = re.search(r"/([A-Za-z0-9]{5,12})b\.(jpe?g|png|webp|gif)$", clean, re.I)
    if m:
        img_id = m.group(1)
        ext = m.group(2)
        return re.sub(r"b\.(jpe?g|png|webp|gif)$", f".{ext}", clean, flags=re.I), img_id
    m2 = re.search(r"/([A-Za-z0-9]{5,12})\.(?:jpe?g|png|webp|gif|mp4)$", clean, re.I)
    return clean, (m2.group(1) if m2 else "")


async def fetch_imgur_album_photos(client: httpx.AsyncClient, album_url: str) -> dict[str, Any] | None:
    """Resolve full-res images and looping MP4s for an Imgur gallery or album URL."""
    parsed_album = urlsplit(str(album_url or "").strip())
    host = parsed_album.netloc.lower().split(":")[0]
    if parsed_album.scheme not in ("http", "https") or not (host == "imgur.com" or host.endswith(".imgur.com")):
        return None
    m = re.search(r"/(?:gallery|a)/(?:[a-z0-9-]+-)?([A-Za-z0-9]{4,12})(?:[/?#]|$)", parsed_album.path, re.I)
    if not m:
        return None
    album_id = m.group(1)
    headers = {"Accept": "application/json", "Referer": "https://imgur.com/"}

    photos: list[dict[str, Any]] = []
    title = ""
    api_url = f"https://api.imgur.com/post/v1/albums/{album_id}?client_id={_IMGUR_CLIENT_ID}&include=media,account"
    try:
        r = await client.get(api_url, headers=headers)
        if r.status_code == 200:
            data = r.json()
            title = str(data.get("title") or "").strip()
            for idx, item in enumerate(data.get("media") or []):
                if not isinstance(item, dict):
                    continue
                orig = str(item.get("url") or "").strip()
                if not orig:
                    continue
                meta = item.get("metadata") or {}
                mime = str(item.get("mime_type") or "").lower()
                is_anim = bool(meta.get("is_animated")) or orig.lower().endswith((".mp4", ".gif")) or "video" in mime
                ext = str(item.get("ext") or ("mp4" if is_anim else "jpg")).lower()
                img_id = str(item.get("id") or f"{album_id}-{idx}")
                thumb = f"https://i.imgur.com/{img_id}b.jpg" if ext != "mp4" else f"https://i.imgur.com/{img_id}b.jpg"
                entry: dict[str, Any] = {
                    "id": f"imgur-{img_id}",
                    "title": str(meta.get("title") or title or f"Imgur #{idx + 1}"),
                    "thumbnailUrl": thumb if not is_anim else orig,
                    "originalUrl": orig,
                    "pageUrl": album_url,
                    "sourcePage": album_url,
                    "width": int(item.get("width") or 0),
                    "height": int(item.get("height") or 0),
                    "type": "gif" if is_anim else "photo",
                    "format": ext,
                    "isAnimated": is_anim,
                    "isResolvedOriginal": True,
                }
                if is_anim and orig.lower().endswith(".mp4"):
                    entry["streamUrl"] = f"/api/proxy-video-stream?url={quote(orig, safe='')}&referer={quote('https://imgur.com/', safe='')}"
                photos.append(entry)
    except Exception:
        photos = []

    if not photos:
        try:
            r2 = await client.get(f"https://imgur.com/ajaxalbums/getimages/{album_id}/hit.json?all=true", headers=headers)
            if r2.status_code == 200:
                raw_imgs = ((r2.json().get("data") or {}).get("images") or [])
                for idx, im in enumerate(raw_imgs):
                    if not isinstance(im, dict) or not im.get("hash"):
                        continue
                    h = str(im["hash"])
                    ext = str(im.get("ext") or ".jpg")
                    if not ext.startswith("."):
                        ext = f".{ext}"
                    is_anim = ext.lower() in (".mp4", ".gif") or bool(im.get("animated"))
                    orig = f"https://i.imgur.com/{h}.mp4" if is_anim and im.get("ext") == ".gif" else f"https://i.imgur.com/{h}{ext}"
                    photos.append({
                        "id": f"imgur-{h}",
                        "title": str(im.get("title") or title or f"Imgur #{idx + 1}"),
                        "thumbnailUrl": f"https://i.imgur.com/{h}b.jpg",
                        "originalUrl": orig,
                        "pageUrl": album_url,
                        "sourcePage": album_url,
                        "width": int(im.get("width") or 0),
                        "height": int(im.get("height") or 0),
                        "type": "gif" if is_anim else "photo",
                        "format": ext.lstrip("."),
                        "isAnimated": is_anim,
                        "isResolvedOriginal": True,
                    })
        except Exception:
            pass

    if not photos:
        return None
    return {
        "success": True,
        "gallery_url": album_url,
        "title": title,
        "count": len(photos),
        "photos": photos,
        "paginationComplete": True,
    }


class ImgurSearchProvider:
    """Federated search adapter for Imgur albums, animated GIFs, and image posts."""

    capabilities = SearchProviderCapabilities(
        source_id="imgur",
        display_name="Imgur",
        categories=("albums", "gifs", "posts"),
        supports_live_connector=False,
    )

    async def _search_api_v3(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        page: int,
        seen_list: list[str],
        seen_ids: set[str],
    ) -> SearchPageResult | None:
        api_page = max(0, page - 1)
        api_url = f"https://api.imgur.com/3/gallery/search/top/all/{api_page}?q={quote_plus(query.strip())}"
        try:
            resp = await client.get(
                api_url,
                headers={"Authorization": f"Client-ID {_IMGUR_CLIENT_ID}", "Accept": "application/json"},
                timeout=6.0,
            )
            if resp.status_code != 200:
                return None
            payload = resp.json()
            raw_list = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(raw_list, list):
                return None
        except Exception:
            return None

        items: list[dict[str, Any]] = []
        for raw in raw_list:
            if not isinstance(raw, dict):
                continue
            item_id = str(raw.get("id") or "").strip()
            if not item_id:
                continue
            is_album = bool(raw.get("is_album"))
            raw_imgs = [im for im in (raw.get("images") or []) if isinstance(im, dict)]
            first_media = raw_imgs[0] if raw_imgs else raw
            is_anim = bool(
                raw.get("animated")
                or first_media.get("animated")
                or raw.get("mp4")
                or first_media.get("mp4")
                or str(first_media.get("type") or raw.get("type") or "").lower().startswith("video")
            )
            img_count = int(raw.get("images_count") or len(raw_imgs) or (1 if raw.get("link") else 0))

            if is_anim and (not is_album or img_count <= 1):
                card_cat: SearchCategory = "gifs"
            elif is_album or img_count > 1:
                card_cat = "albums"
            else:
                card_cat = "posts"

            if card_cat != category:
                continue
            if item_id in seen_ids:
                continue
            seen_ids.add(item_id)
            seen_list.append(item_id)

            title = str(raw.get("title") or "").strip() or "Imgur Post"
            account = str(raw.get("account_url") or "").strip()
            link = str(raw.get("link") or f"https://imgur.com/{'a' if is_album else 'gallery'}/{item_id}").strip()
            if is_album and "/a/" in link:
                gallery_url = link
            else:
                gallery_url = f"https://imgur.com/gallery/{item_id}" if is_album else link

            photo_urls: list[str] = []
            for im in raw_imgs:
                im_link = str(im.get("link") or "").strip()
                if im_link and not im_link.lower().endswith(".mp4"):
                    photo_urls.append(im_link)
            if not photo_urls and raw.get("cover"):
                photo_urls.append(f"https://i.imgur.com/{raw['cover']}.jpg")
            elif not photo_urls and not is_anim and str(raw.get("link") or "").startswith("https://i.imgur.com/"):
                photo_urls.append(str(raw["link"]))

            cover_id = str(raw.get("cover") or first_media.get("id") or item_id)
            thumb = (
                photo_urls[0]
                if photo_urls
                else f"https://i.imgur.com/{cover_id}.jpg"
            )
            views_num = raw.get("views")
            views_str = f"{int(views_num):,}" if isinstance(views_num, int) and views_num > 0 else ""
            dt_val = raw.get("datetime")
            date_iso = (
                datetime.fromtimestamp(int(dt_val), tz=timezone.utc).isoformat()
                if isinstance(dt_val, (int, float)) and dt_val > 0
                else ""
            )

            common_creator = {
                "creator_name": account,
                "creator_handle": account,
                "source_page": "",  # Deliberately omit profile scan URLs for Imgur
                "neutral_label": "Imgur",
            }
            if card_cat == "gifs":
                mp4_url = str(first_media.get("mp4") or raw.get("mp4") or f"https://i.imgur.com/{cover_id}.mp4")
                proxy_v = f"/api/proxy-video-stream?url={quote(mp4_url, safe='')}&referer={quote('https://imgur.com/', safe='')}"
                entry = make_item_entry(
                    source_id="imgur",
                    item_id=f"omni-imgur-gif-{item_id}",
                    item_type="gif",
                    title=title,
                    original_url=gallery_url,
                    thumbnail=thumb,
                    video_url=proxy_v,
                    views=views_str,
                    date=date_iso,
                    **common_creator,
                )
            elif card_cat == "albums":
                entry = make_item_entry(
                    source_id="imgur",
                    item_id=f"omni-imgur-alb-{item_id}",
                    item_type="album",
                    title=title,
                    original_url=gallery_url,
                    album_url=gallery_url,
                    thumbnail=thumb,
                    photos=photo_urls or ([thumb] if thumb else []),
                    photo_count=img_count if img_count > 0 else len(photo_urls),
                    views=views_str,
                    date=date_iso,
                    **common_creator,
                )
            else:
                entry = make_item_entry(
                    source_id="imgur",
                    item_id=f"omni-imgur-post-{item_id}",
                    item_type="photo_grid",
                    title=title,
                    original_url=gallery_url,
                    thumbnail=thumb,
                    photos=photo_urls or ([thumb] if thumb else []),
                    views=views_str,
                    date=date_iso,
                    **common_creator,
                )
            if isinstance(raw.get("ups"), int):
                entry["likes"] = raw["ups"]
            items.append(entry)

        can_more = bool(raw_list) and bool(items)
        next_cursor = encode_search_cursor({"page": page + 1, "seen": seen_list[-300:]}) if can_more else None
        return SearchPageResult(
            source_id="imgur",
            category=category,
            items=items,
            next_cursor=next_cursor,
            has_more=can_more,
        )

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        cursor: str | None = None,
    ) -> SearchPageResult:
        if category not in self.capabilities.categories:
            return SearchPageResult(source_id="imgur", category=category)

        cursor_data = decode_search_cursor(cursor)
        page = int(cursor_data.get("page") or 1)
        seen_list = list(cursor_data.get("seen") or [])
        seen_ids: set[str] = set(str(s) for s in seen_list)

        api_res = await self._search_api_v3(client, query, category, page, seen_list, seen_ids)
        if api_res is not None:
            return api_res

        q_enc = quote_plus(query.strip())
        url = (
            f"https://imgur.com/search?q={q_enc}"
            if page <= 1
            else f"https://imgur.com/search/score/all/page/{page}?q={q_enc}"
        )
        try:
            resp = await client.get(url)
            if resp.status_code != 200:
                return SearchPageResult(source_id="imgur", category=category, error=f"http_{resp.status_code}")

            tree = LexborHTMLParser(resp.text)
            cards = tree.css(".cards .post")
            items: list[dict[str, Any]] = []

            for card in cards:
                post_id = (card.attributes.get("id") or "").strip()
                a = card.css_first("a.image-list-link[href], a[href]")
                if not a:
                    continue
                href = _http_url("https://imgur.com", (a.attributes.get("href") or "").strip())
                if not href:
                    continue
                img = card.css_first("img")
                raw_src = _http_url("https://imgur.com", (img.attributes.get("src") or img.attributes.get("data-src")) if img else "")
                full_thumb, cover_id = _upgrade_imgur_thumb(raw_src) if raw_src else ("", "")
                title = ((img.attributes.get("alt") if img else "") or (a.attributes.get("title") or "") or "Imgur Post").strip()
                info_el = card.css_first(".post-info")
                info_txt = (info_el.text(separator=" ", strip=True) if info_el else "").lower()

                if "animated" in info_txt:
                    card_cat: SearchCategory = "gifs"
                elif "album" in info_txt:
                    card_cat = "albums"
                else:
                    card_cat = "posts"

                if card_cat != category:
                    continue
                dedupe_key = post_id or href
                if not dedupe_key or dedupe_key in seen_ids:
                    continue
                seen_ids.add(dedupe_key)
                seen_list.append(dedupe_key)

                if card_cat == "gifs":
                    mp4_url = f"https://i.imgur.com/{cover_id or post_id}.mp4"
                    proxy_v = f"/api/proxy-video-stream?url={quote(mp4_url, safe='')}&referer={quote('https://imgur.com/', safe='')}"
                    items.append(
                        make_item_entry(
                            source_id="imgur",
                            item_id=f"omni-imgur-gif-{post_id or len(items) + 1}",
                            item_type="gif",
                            title=title,
                            original_url=href,
                            thumbnail=full_thumb,
                            video_url=proxy_v,
                            neutral_label="Imgur",
                        )
                    )
                elif card_cat == "albums":
                    items.append(
                        make_item_entry(
                            source_id="imgur",
                            item_id=f"omni-imgur-alb-{post_id or len(items) + 1}",
                            item_type="album",
                            title=title,
                            original_url=href,
                            album_url=href,
                            thumbnail=full_thumb,
                            photos=[full_thumb] if full_thumb else [],
                            neutral_label="Imgur",
                        )
                    )
                else:
                    items.append(
                        make_item_entry(
                            source_id="imgur",
                            item_id=f"omni-imgur-post-{post_id or len(items) + 1}",
                            item_type="photo_grid",
                            title=title,
                            original_url=href,
                            thumbnail=full_thumb,
                            photos=[full_thumb] if full_thumb else [],
                            neutral_label="Imgur",
                        )
                    )

            can_more = bool(cards) and bool(items)
            next_cursor = encode_search_cursor({"page": page + 1, "seen": seen_list[-300:]}) if can_more else None
            return SearchPageResult(
                source_id="imgur",
                category=category,
                items=items,
                next_cursor=next_cursor,
                has_more=can_more,
            )
        except Exception as exc:
            return SearchPageResult(source_id="imgur", category=category, error=str(exc))


_FXTWITTER_HEADERS = {
    "User-Agent": "ImageXTimeline/1.0",
    "Accept": "application/json",
}
_X_SEARCH_PROFILE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_X_SEARCH_TWEET_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_X_CACHE_TTL_SECONDS = 600.0
_X_RESERVED_HANDLES = frozenset({
    "home", "explore", "search", "notifications", "messages", "i", "compose",
    "login", "signup", "settings", "hashtag", "tos", "privacy", "intent",
    "share", "download",
})


def _clean_x_handle(raw: str | None) -> str:
    if not raw:
        return ""
    cleaned = raw.strip().lstrip("@").split("/")[0].split("?")[0].strip()
    return cleaned if re.fullmatch(r"[A-Za-z0-9_]{1,30}", cleaned) else ""


def _upgrade_x_avatar(url: str | None) -> str:
    if not url:
        return ""
    return re.sub(r"_(?:normal|bigger|mini)\.(jpg|jpeg|png|webp)", r"_400x400.\1", url, flags=re.I)


def _parse_vxtwitter_user(user: dict[str, Any], fallback_handle: str = "") -> dict[str, Any]:
    screen_name = str(user.get("screen_name") or fallback_handle or "").strip().lstrip("@")
    return {
        "handle": f"@{screen_name}" if screen_name else "",
        "name": str(user.get("name") or screen_name or "").strip(),
        "avatar": _upgrade_x_avatar(str(user.get("profile_image_url") or user.get("avatar_url") or "").strip()),
        "banner": str(user.get("banner_url") or "").strip(),
        "bio": str(user.get("description") or "").strip(),
        "location": str(user.get("location") or "").strip(),
        "website": "",
        "joined": str(user.get("created_at") or "").strip(),
        "followers": user.get("followers_count") if isinstance(user.get("followers_count"), int) else None,
        "following": user.get("following_count") if isinstance(user.get("following_count"), int) else None,
        "postsCount": user.get("tweet_count") if isinstance(user.get("tweet_count"), int) else None,
        "likesCount": None,
        "verified": bool(user.get("verified")),
    }


def _parse_fxtwitter_user(user: dict[str, Any], fallback_handle: str = "") -> dict[str, Any]:
    screen_name = str(user.get("screen_name") or fallback_handle or "").strip().lstrip("@")
    website_obj = user.get("website")
    website = ""
    if isinstance(website_obj, dict):
        website = str(website_obj.get("display_url") or website_obj.get("url") or "").strip()
    elif isinstance(website_obj, str):
        website = website_obj.strip()
    ver_obj = user.get("verification")
    verified = bool(user.get("verified") or (isinstance(ver_obj, dict) and ver_obj.get("verified")))
    return {
        "handle": f"@{screen_name}" if screen_name else "",
        "name": str(user.get("name") or screen_name or "").strip(),
        "avatar": _upgrade_x_avatar(str(user.get("avatar_url") or "").strip()),
        "banner": str(user.get("banner_url") or "").strip(),
        "bio": str(user.get("description") or "").strip(),
        "location": str(user.get("location") or "").strip(),
        "website": website,
        "joined": str(user.get("joined") or "").strip(),
        "followers": user.get("followers") if isinstance(user.get("followers"), int) else None,
        "following": user.get("following") if isinstance(user.get("following"), int) else None,
        "postsCount": user.get("tweets") if isinstance(user.get("tweets"), int) else None,
        "likesCount": user.get("likes") if isinstance(user.get("likes"), int) else None,
        "verified": verified,
    }


def _parse_syndication_tweet(data: dict[str, Any], fallback_handle: str = "") -> dict[str, Any] | None:
    tid = str(data.get("id_str") or "").strip()
    if not tid:
        return None
    user = data.get("user") if isinstance(data.get("user"), dict) else {}
    screen_name = str(user.get("screen_name") or fallback_handle or "x").strip().lstrip("@")
    name = str(user.get("name") or screen_name).strip()
    avatar = _upgrade_x_avatar(str(user.get("profile_image_url_https") or "").strip())
    verified = bool(user.get("is_blue_verified") or user.get("verified"))
    photos: list[str] = []
    for p in data.get("photos") or []:
        if isinstance(p, dict) and p.get("url"):
            photos.append(str(p["url"]))
    video_url: str | None = None
    poster_url: str | None = None
    video_obj = data.get("video")
    if isinstance(video_obj, dict):
        poster_url = str(video_obj.get("poster") or "").strip() or None
        for var in video_obj.get("variants") or []:
            if isinstance(var, dict) and var.get("type") == "video/mp4" and var.get("src"):
                video_url = str(var["src"]).strip()
    if not photos and not video_url:
        for m in data.get("mediaDetails") or []:
            if not isinstance(m, dict):
                continue
            m_type = str(m.get("type") or "")
            if m_type == "photo" and m.get("media_url_https"):
                photos.append(str(m["media_url_https"]))
            elif m_type in ("video", "animated_gif"):
                poster_url = poster_url or str(m.get("media_url_https") or "").strip() or None
                v_info = m.get("video_info") if isinstance(m.get("video_info"), dict) else {}
                for var in v_info.get("variants") or []:
                    if isinstance(var, dict) and var.get("content_type") == "video/mp4" and var.get("url"):
                        video_url = str(var["url"]).strip()
    raw_text = str(data.get("text") or "").strip()
    clean_text = re.sub(r"\s*https://t\.co/[A-Za-z0-9]+\s*$", "", raw_text).strip() or raw_text
    return {
        "id": tid,
        "url": f"https://x.com/{screen_name}/status/{tid}",
        "handle": screen_name,
        "name": name,
        "avatar": avatar,
        "verified": verified,
        "date": str(data.get("created_at") or ""),
        "text": clean_text,
        "photos": photos,
        "video": video_url,
        "poster": poster_url,
        "hasVideo": bool(video_url),
        "metrics": {
            "replies": data.get("conversation_count") if isinstance(data.get("conversation_count"), int) else None,
            "reposts": None,
            "likes": data.get("favorite_count") if isinstance(data.get("favorite_count"), int) else None,
            "views": None,
        },
        "profile": {"handle": f"@{screen_name}", "name": name, "avatar": avatar, "verified": verified},
    }


def _parse_vxtwitter_tweet(data: dict[str, Any], fallback_handle: str = "") -> dict[str, Any] | None:
    tid = str(data.get("tweetID") or "").strip()
    if not tid:
        return None
    screen_name = str(data.get("user_screen_name") or fallback_handle or "x").strip().lstrip("@")
    name = str(data.get("user_name") or screen_name).strip()
    avatar = _upgrade_x_avatar(str(data.get("user_profile_image_url") or "").strip())
    photos: list[str] = []
    video_url: str | None = None
    poster_url: str | None = None
    for m in data.get("media_extended") or []:
        if not isinstance(m, dict):
            continue
        m_type = str(m.get("type") or "").lower()
        u = str(m.get("url") or "").strip()
        if m_type == "image" and u:
            photos.append(u)
        elif m_type in ("video", "gif") and u:
            video_url = u
            poster_url = str(m.get("thumbnail_url") or "").strip() or poster_url
    if not photos and not video_url:
        for u in data.get("mediaURLs") or []:
            if isinstance(u, str) and u.strip():
                if ".mp4" in u.lower() or "video.twimg.com" in u.lower():
                    video_url = u.strip()
                else:
                    photos.append(u.strip())
    raw_text = str(data.get("text") or "").strip()
    clean_text = re.sub(r"\s*https://t\.co/[A-Za-z0-9]+\s*$", "", raw_text).strip() or raw_text
    return {
        "id": tid,
        "url": str(data.get("tweetURL") or f"https://x.com/{screen_name}/status/{tid}"),
        "handle": screen_name,
        "name": name,
        "avatar": avatar,
        "verified": False,
        "date": str(data.get("date") or ""),
        "text": clean_text,
        "photos": photos,
        "video": video_url,
        "poster": poster_url,
        "hasVideo": bool(video_url),
        "metrics": {
            "replies": data.get("replies") if isinstance(data.get("replies"), int) else None,
            "reposts": data.get("retweets") if isinstance(data.get("retweets"), int) else None,
            "likes": data.get("likes") if isinstance(data.get("likes"), int) else None,
            "views": None,
        },
        "profile": {"handle": f"@{screen_name}", "name": name, "avatar": avatar},
    }


def _parse_fxtwitter_tweet(tweet: dict[str, Any], fallback_handle: str = "") -> dict[str, Any]:
    author = tweet.get("author") if isinstance(tweet.get("author"), dict) else {}
    profile = _parse_fxtwitter_user(author, fallback_handle=fallback_handle)
    media = tweet.get("media") if isinstance(tweet.get("media"), dict) else {}
    photos = [str(p["url"]) for p in (media.get("photos") or []) if isinstance(p, dict) and p.get("url")]
    video_url: str | None = None
    poster_url: str | None = None
    videos = media.get("videos") or []
    if videos and isinstance(videos[0], dict):
        video_url = str(videos[0].get("url") or "").strip() or None
        poster_url = str(videos[0].get("thumbnail_url") or "").strip() or None
    return {
        "id": str(tweet.get("id") or ""),
        "url": f"https://x.com/{profile['handle'].lstrip('@') or fallback_handle}/status/{tweet.get('id') or ''}",
        "handle": profile["handle"].lstrip("@"),
        "name": profile["name"],
        "avatar": profile["avatar"],
        "verified": profile["verified"],
        "date": str(tweet.get("created_at") or ""),
        "text": str(tweet.get("text") or "").strip(),
        "photos": photos,
        "video": video_url,
        "poster": poster_url,
        "hasVideo": bool(video_url),
        "metrics": {
            "replies": tweet.get("replies") if isinstance(tweet.get("replies"), int) else None,
            "reposts": tweet.get("retweets") if isinstance(tweet.get("retweets"), int) else None,
            "likes": tweet.get("likes") if isinstance(tweet.get("likes"), int) else None,
            "views": tweet.get("views") if isinstance(tweet.get("views"), int) else None,
        },
        "profile": profile,
    }


async def _fetch_x_user_info(client: httpx.AsyncClient, handle: str) -> dict[str, Any] | None:
    clean = _clean_x_handle(handle)
    if not clean:
        return None
    cache_key = clean.lower()
    now = time.time()
    cached = _X_SEARCH_PROFILE_CACHE.get(cache_key)
    if cached and (now - cached[0]) < _X_CACHE_TTL_SECONDS:
        return cached[1]
    try:
        resp = await client.get(f"https://api.fxtwitter.com/{clean}", headers=_FXTWITTER_HEADERS, timeout=3.5)
        if resp.status_code == 200:
            payload = resp.json()
            user = payload.get("user") if isinstance(payload, dict) else None
            if isinstance(user, dict) and (user.get("screen_name") or user.get("name")):
                parsed = _parse_fxtwitter_user(user, fallback_handle=clean)
                _X_SEARCH_PROFILE_CACHE[cache_key] = (now, parsed)
                return parsed
    except Exception:
        pass
    try:
        vresp = await client.get(f"https://api.vxtwitter.com/{clean}", headers=_FXTWITTER_HEADERS, timeout=3.5)
        if vresp.status_code == 200:
            vpayload = vresp.json()
            if isinstance(vpayload, dict) and (vpayload.get("screen_name") or vpayload.get("name")):
                parsed = _parse_vxtwitter_user(vpayload, fallback_handle=clean)
                _X_SEARCH_PROFILE_CACHE[cache_key] = (now, parsed)
                return parsed
    except Exception:
        pass
    return None


async def _gather_within_budget(coros: list[Any], timeout: float = 6.5) -> list[Any]:
    if not coros:
        return []
    tasks = [asyncio.create_task(c) for c in coros]
    done, pending = await asyncio.wait(tasks, timeout=timeout)
    for p in pending:
        p.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    results: list[Any] = []
    for t in tasks:
        if t in done and not t.cancelled():
            try:
                results.append(t.result())
            except Exception as exc:
                results.append(exc)
        else:
            results.append(None)
    return results


async def _fetch_x_tweet_info(client: httpx.AsyncClient, handle: str, tweet_id: str) -> dict[str, Any] | None:
    clean_id = re.sub(r"[^\d]", "", str(tweet_id or ""))
    clean_handle = _clean_x_handle(handle) or "i"
    if not clean_id:
        return None
    now = time.time()
    cached = _X_SEARCH_TWEET_CACHE.get(clean_id)
    if cached and (now - cached[0]) < _X_CACHE_TTL_SECONDS:
        return cached[1]
    vx_parsed: dict[str, Any] | None = None
    syn_parsed: dict[str, Any] | None = None

    async def _try_vx():
        nonlocal vx_parsed
        try:
            vr = await client.get(f"https://api.vxtwitter.com/{clean_handle}/status/{clean_id}", headers=_FXTWITTER_HEADERS, timeout=3.5)
            if vr.status_code == 200 and isinstance(vr.json(), dict):
                vx_parsed = _parse_vxtwitter_tweet(vr.json(), fallback_handle=clean_handle)
        except Exception:
            pass

    async def _try_syn():
        nonlocal syn_parsed
        try:
            sr = await client.get(
                f"https://cdn.syndication.twimg.com/tweet-result?id={clean_id}&token=0",
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
                timeout=3.5,
            )
            if sr.status_code == 200 and isinstance(sr.json(), dict):
                syn_parsed = _parse_syndication_tweet(sr.json(), fallback_handle=clean_handle)
        except Exception:
            pass

    await asyncio.gather(_try_vx(), _try_syn(), return_exceptions=True)
    if vx_parsed or syn_parsed:
        base = vx_parsed or syn_parsed
        other = syn_parsed if base is vx_parsed else vx_parsed
        assert base is not None
        if other:
            merged_metrics = {
                k: base["metrics"].get(k) if base["metrics"].get(k) is not None else other["metrics"].get(k)
                for k in ("replies", "reposts", "likes", "views")
            }
            parsed = {
                **base,
                "avatar": base.get("avatar") or other.get("avatar") or "",
                "verified": bool(base.get("verified") or other.get("verified")),
                "date": other.get("date") or base.get("date") or "",
                "photos": base.get("photos") or other.get("photos") or [],
                "video": base.get("video") or other.get("video"),
                "poster": base.get("poster") or other.get("poster"),
                "hasVideo": bool(base.get("hasVideo") or other.get("hasVideo")),
                "metrics": merged_metrics,
            }
        else:
            parsed = base
        _X_SEARCH_TWEET_CACHE[clean_id] = (now, parsed)
        return parsed

    try:
        resp = await client.get(f"https://api.fxtwitter.com/{clean_handle}/status/{clean_id}", headers=_FXTWITTER_HEADERS, timeout=3.5)
        if resp.status_code == 200 and isinstance(resp.json(), dict) and isinstance(resp.json().get("tweet"), dict):
            parsed = _parse_fxtwitter_tweet(resp.json()["tweet"], fallback_handle=clean_handle)
            _X_SEARCH_TWEET_CACHE[clean_id] = (now, parsed)
            return parsed
    except Exception:
        pass
    return None


class XFallbackSearchProvider:
    """Unauthenticated HTTP X search fallback via paginated ``site:x.com`` indexing and fx/vx/syndication hydration."""

    capabilities = SearchProviderCapabilities(
        source_id="x",
        display_name="X",
        categories=("profiles", "videos", "posts"),
        supports_live_connector=True,
    )

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        cursor: str | None = None,
    ) -> SearchPageResult:
        if category not in self.capabilities.categories:
            return SearchPageResult(source_id="x", category=category)

        cursor_data = decode_search_cursor(cursor)
        offset = int(cursor_data.get("offset") or 1)
        seen_list = list(cursor_data.get("seen") or [])
        seen_set = set(str(x).lower() for x in seen_list)
        try:
            if category == "profiles":
                q_str = quote_plus(f"site:x.com {query.strip()} -inurl:status")
                url = f"https://search.yahoo.com/search?p={q_str}&b={offset}"
                resp = await client.get(url)
                handles: list[str] = []
                seen_handle_lower: set[str] = set()
                if offset == 1:
                    exact = _clean_x_handle(query)
                    if exact and exact.lower() not in _X_RESERVED_HANDLES:
                        handles.append(exact)
                        seen_handle_lower.add(exact.lower())
                if resp.status_code == 200:
                    search_text = f"{unquote(resp.text)}\n{resp.text}"
                    for raw_h in re.findall(r"(?:https?://)?(?:www\.)?(?:x|twitter)\.com/([A-Za-z0-9_]{1,30})(?=[/?#\"'\s<&]|$)", search_text, re.I):
                        h = _clean_x_handle(raw_h)
                        if h and h.lower() not in _X_RESERVED_HANDLES and h.lower() not in seen_handle_lower:
                            handles.append(h)
                            seen_handle_lower.add(h.lower())

                new_handles = [h for h in handles if h.lower() not in seen_set][:8]
                fetched = await _gather_within_budget([_fetch_x_user_info(client, h) for h in new_handles], timeout=6.5)
                profiles: list[dict[str, Any]] = []
                for h, u in zip(new_handles, fetched):
                    seen_set.add(h.lower())
                    seen_list.append(h.lower())
                    if not isinstance(u, dict) or not u.get("handle"):
                        continue
                    clean_h = u["handle"].lstrip("@")
                    profiles.append(
                        make_profile_entry(
                            source_id="x",
                            entry_id=f"x:{clean_h.lower()}",
                            name=str(u.get("name") or clean_h),
                            profile_url=f"https://x.com/{clean_h}",
                            handle=clean_h,
                            avatar=str(u.get("avatar") or ""),
                            verified=bool(u.get("verified")),
                            bio=str(u.get("bio") or ""),
                            followers=u.get("followers"),
                        )
                    )
                can_more = len(new_handles) > 0 and resp.status_code == 200
                next_cursor = encode_search_cursor({"offset": offset + 10, "seen": seen_list[-200:]}) if can_more else None
                return SearchPageResult(
                    source_id="x",
                    category="profiles",
                    profiles=profiles,
                    next_cursor=next_cursor,
                    has_more=can_more,
                )

            # videos or posts
            q_str = quote_plus(f'"x.com" {query.strip()} status')
            url = f"https://search.yahoo.com/search?p={q_str}&b={offset}"
            resp = await client.get(url)
            pairs: list[tuple[str, str]] = []
            if resp.status_code == 200:
                search_text = f"{unquote(resp.text)}\n{resp.text}"
                for h_raw, tid_raw in re.findall(r"(?:https?://)?(?:www\.)?(?:x|twitter)\.com/([A-Za-z0-9_]{1,30})/status/(\d{5,22})", search_text, re.I):
                    if tid_raw not in seen_set and all(t != tid_raw for _, t in pairs):
                        pairs.append((h_raw, tid_raw))

            if len(pairs) < 6 and offset == 1:
                try:
                    bq = quote_plus(f'"x.com/" {query.strip()} status')
                    b_resp = await client.get(f"https://www.bing.com/search?q={bq}&first=1", timeout=5.0)
                    if b_resp.status_code == 200:
                        for b64_u in re.findall(r"u=a1([A-Za-z0-9_-]+)", b_resp.text):
                            try:
                                pad = b64_u + "=" * ((4 - len(b64_u) % 4) % 4)
                                decoded_u = base64.urlsafe_b64decode(pad).decode("utf-8", "ignore")
                            except Exception:
                                continue
                            m_st = re.search(r"(?:x|twitter)\.com/([A-Za-z0-9_]{1,30})/status/(\d{5,22})", decoded_u, re.I)
                            if m_st and m_st.group(2) not in seen_set and all(t != m_st.group(2) for _, t in pairs):
                                pairs.append((m_st.group(1), m_st.group(2)))
                except Exception:
                    pass

            pairs = pairs[:12]
            tweets = await _gather_within_budget([_fetch_x_tweet_info(client, h, t) for h, t in pairs], timeout=6.5)
            items: list[dict[str, Any]] = []
            for (h, tid), tw in zip(pairs, tweets):
                seen_set.add(tid)
                seen_list.append(tid)
                if not isinstance(tw, dict) or not tw.get("id"):
                    continue
                is_vid = bool(tw.get("hasVideo") or tw.get("video"))
                if category == "videos" and not is_vid:
                    continue
                t_handle = str(tw.get("handle") or h).lstrip("@")
                t_photos = list(tw.get("photos") or [])
                t_video = str(tw.get("video") or "")
                t_poster = str(tw.get("poster") or "")
                t_text = str(tw.get("text") or "")
                if is_vid:
                    item_type: Literal["video", "photo_grid", "text"] = "video"
                    thumb = t_poster or (t_photos[0] if t_photos else "") or str(tw.get("avatar") or "")
                elif t_photos:
                    item_type = "photo_grid"
                    thumb = t_photos[0]
                else:
                    item_type = "text"
                    thumb = str(tw.get("avatar") or "")
                entry = make_item_entry(
                    source_id="x",
                    item_id=f"omni-x-{tw['id']}",
                    item_type=item_type,
                    title=t_text[:120] or str(tw.get("name") or f"@{t_handle}"),
                    original_url=str(tw.get("url") or f"https://x.com/{t_handle}/status/{tw['id']}"),
                    thumbnail=thumb,
                    creator_name=str(tw.get("name") or t_handle),
                    creator_handle=t_handle,
                    creator_avatar=str(tw.get("avatar") or ""),
                    creator_verified=bool(tw.get("verified")),
                    source_page=f"https://x.com/{t_handle}",
                    video_url=t_video,
                    date=str(tw.get("date") or ""),
                    text=t_text,
                    photos=t_photos or None,
                )
                if isinstance(tw.get("metrics"), dict):
                    entry["metrics"] = tw["metrics"]
                items.append(entry)

            can_more = len(items) > 0 and resp.status_code == 200
            next_cursor = encode_search_cursor({"offset": offset + 10, "seen": seen_list[-200:]}) if can_more else None
            return SearchPageResult(
                source_id="x",
                category=category,
                items=items,
                next_cursor=next_cursor,
                has_more=can_more,
            )
        except Exception as exc:
            return SearchPageResult(source_id="x", category=category, error=str(exc))


class CatalogSearchProvider:
    supports_search_options = True

    def __init__(self, descriptor: Any) -> None:
        self._desc = descriptor
        cats = tuple(c for c in descriptor.search_categories if c != "all" and c in ALL_SEARCH_CATEGORIES)
        self.capabilities = SearchProviderCapabilities(
            source_id=descriptor.id,
            display_name=descriptor.display_name,
            categories=cats or ("profiles", "albums"),
        )

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        cursor: str | None = None,
        options: dict[str, Any] | None = None,
    ) -> SearchPageResult:
        from .gallery_catalog_engine import search_catalog

        return await search_catalog(client, self._desc, query, category, cursor=cursor, options=options)


class VideoPortalSearchProvider:
    supports_search_options = True

    def __init__(self, descriptor: Any) -> None:
        self._desc = descriptor
        cats = tuple(c for c in descriptor.search_categories if c != "all" and c in ALL_SEARCH_CATEGORIES)
        self.capabilities = SearchProviderCapabilities(
            source_id=descriptor.id,
            display_name=descriptor.display_name,
            categories=cats or ("profiles", "videos", "playlists"),
        )

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        cursor: str | None = None,
        options: dict[str, Any] | None = None,
    ) -> SearchPageResult:
        from .video_portal_engine import search_video_portal

        return await search_video_portal(client, self._desc, query, category, cursor=cursor, options=options)


class ForumSearchProvider:
    supports_search_options = True

    def __init__(self, descriptor: Any) -> None:
        self._desc = descriptor
        cats = tuple(c for c in descriptor.search_categories if c != "all" and c in ALL_SEARCH_CATEGORIES)
        self.capabilities = SearchProviderCapabilities(
            source_id=descriptor.id,
            display_name=descriptor.display_name,
            categories=cats or ("profiles", "albums", "videos", "gifs", "posts"),
        )

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        category: SearchCategory,
        cursor: str | None = None,
        options: dict[str, Any] | None = None,
    ) -> SearchPageResult:
        from .forum_board_engine import search_forum_board

        return await search_forum_board(client, self._desc, query, category, cursor=cursor, options=options)


def _register_builtin_providers() -> None:
    """Register all built-in federated search providers."""
    register_search_provider(YouTubeSearchProvider())
    register_search_provider(PortalGridSearchProvider())
    register_search_provider(PortalTubeSearchProvider())
    register_search_provider(PortalStateSearchProvider())
    register_search_provider(ImgurSearchProvider())
    register_search_provider(XFallbackSearchProvider())


_register_builtin_providers()
