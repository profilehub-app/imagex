"""Runtime loader and typed registry for external visual catalog, forum board, and image host connectors.

Reads connector manifests from `IMAGEX_CONNECTORS_FILE` (or `config/connectors.local.json`
when present). Keeps engine, routing, search, and UI modules completely decoupled from
specific upstream site names or domains.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlsplit

from ..core import runtime_paths


def get_default_local_connectors_path() -> Path:
    return runtime_paths.get_app_base_dir() / "config" / "connectors.local.json"


DEFAULT_LOCAL_CONNECTORS_PATH = get_default_local_connectors_path()


@dataclass(frozen=True)
class SourceCapabilitiesSpec:
    archetype: str = "gallery_catalog"
    layout_mode: str = "editorial_wall"
    supports_comments: bool = False
    supports_source_likes: bool = False
    supports_native_playback: bool = False
    supports_videos_tab: bool = False
    supports_playlists: bool = False
    supports_artist_profiles: bool = True
    supports_directories: bool = True
    supports_thread_reader: bool = False
    directory_kinds: tuple[str, ...] = ()

    def to_frontend_dict(self, search_categories: tuple[str, ...]) -> dict[str, Any]:
        is_forum = self.archetype == "forum_board"
        is_catalog = self.archetype == "gallery_catalog"
        is_video_portal = self.archetype == "video_portal"
        return {
            "archetype": self.archetype,
            "layoutMode": self.layout_mode,
            "supportsComments": self.supports_comments,
            "supportsSourceLikes": self.supports_source_likes,
            "supportsNativePlayback": self.supports_native_playback,
            "supportsVideosTab": self.supports_videos_tab,
            "supportsPlaylists": self.supports_playlists,
            "supportsArtistProfiles": self.supports_artist_profiles,
            "supportsDirectories": self.supports_directories,
            "supportsThreadReader": self.supports_thread_reader,
            "directoryKinds": list(self.directory_kinds),
            "searchCategories": list(search_categories),
            "searchOptions": {
                "supportsBoardFilter": is_forum,
                "supportsSearchScope": is_forum,
                "supportsMediaFilter": is_forum,
                "supportsSubfilterSearch": is_forum or is_catalog or is_video_portal,
                "sortOptions": (
                    ["relevance", "recent", "replies"]
                    if is_forum
                    else (
                        ["relevance", "recent", "popular"]
                        if is_video_portal
                        else (["relevance", "popular", "recent"] if is_catalog else [])
                    )
                ),
            },
        }


@dataclass(frozen=True)
class CatalogDescriptor:
    id: str
    display_name: str
    base_url: str
    domains: tuple[str, ...] = ()
    domain_patterns: tuple[str, ...] = ()
    base_url_env: str = ""
    icon_kind: str = "gallery_catalog"
    root_mode: str = "api_list"
    catalog_modes: tuple[str, ...] = ("popular", "recent", "albums")
    default_category: str = "recent"
    search_categories: tuple[str, ...] = ("all", "profiles", "albums")
    subfilters: tuple[dict[str, str], ...] = ()
    capabilities: SourceCapabilitiesSpec = field(default_factory=SourceCapabilitiesSpec)
    browse: dict[str, Any] = field(default_factory=dict)
    selectors: dict[str, Any] = field(default_factory=dict)

    def effective_base_url(self) -> str:
        if self.base_url_env:
            override = os.environ.get(self.base_url_env, "").strip()
            if override:
                return override.rstrip("/")
        return self.base_url.rstrip("/")

    def matches_exact_domain(self, host: str) -> bool:
        return _match_exact_domain(host, self.domains, self.effective_base_url())

    def matches_pattern(self, host: str) -> bool:
        return _match_domain_pattern(host, self.domain_patterns)

    def matches_host(self, host: str) -> bool:
        return self.matches_exact_domain(host) or self.matches_pattern(host)


@dataclass(frozen=True)
class ForumDescriptor:
    id: str
    display_name: str
    base_url: str
    domains: tuple[str, ...] = ()
    domain_patterns: tuple[str, ...] = ()
    base_url_env: str = ""
    icon_kind: str = "forum_board"
    catalog_modes: tuple[str, ...] = ("albums", "videos", "gifs", "posts", "recent")
    default_category: str = "albums"
    search_categories: tuple[str, ...] = ("all", "profiles", "albums", "videos", "gifs", "posts")
    subfilters: tuple[dict[str, str], ...] = ()
    capabilities: SourceCapabilitiesSpec = field(
        default_factory=lambda: SourceCapabilitiesSpec(
            archetype="forum_board",
            supports_videos_tab=False,
            supports_thread_reader=True,
            directory_kinds=("boards",),
        )
    )
    forum: dict[str, Any] = field(default_factory=dict)

    def effective_base_url(self) -> str:
        if self.base_url_env:
            override = os.environ.get(self.base_url_env, "").strip()
            if override:
                return override.rstrip("/")
        return self.base_url.rstrip("/")

    def matches_exact_domain(self, host: str) -> bool:
        return _match_exact_domain(host, self.domains, self.effective_base_url())

    def matches_pattern(self, host: str) -> bool:
        return _match_domain_pattern(host, self.domain_patterns)

    def matches_host(self, host: str) -> bool:
        return self.matches_exact_domain(host) or self.matches_pattern(host)


@dataclass(frozen=True)
class VideoPortalDescriptor:
    id: str
    display_name: str
    canonical_origin: str
    domains: tuple[str, ...] = ()
    domain_patterns: tuple[str, ...] = ()
    base_url_env: str = ""
    icon_kind: str = "video_portal"
    accent_color: str = ""
    enabled: bool = True
    catalog_modes: tuple[str, ...] = ("videos", "popular", "recent", "playlists")
    default_category: str = "recent"
    search_categories: tuple[str, ...] = ("all", "profiles", "videos", "playlists")
    subfilters: tuple[dict[str, str], ...] = ()
    url_hints: dict[str, Any] = field(default_factory=dict)
    capabilities: SourceCapabilitiesSpec = field(
        default_factory=lambda: SourceCapabilitiesSpec(
            archetype="video_portal",
            layout_mode="video_wall",
            supports_comments=True,
            supports_source_likes=True,
            supports_native_playback=True,
            supports_videos_tab=True,
            supports_playlists=True,
            supports_artist_profiles=True,
            supports_directories=True,
            supports_thread_reader=False,
        )
    )
    routing: dict[str, Any] = field(default_factory=dict)
    video_cards: dict[str, Any] = field(default_factory=dict)
    profile: dict[str, Any] = field(default_factory=dict)
    watch: dict[str, Any] = field(default_factory=dict)
    comments: dict[str, Any] = field(default_factory=dict)
    browse: dict[str, Any] = field(default_factory=dict)
    search: dict[str, Any] = field(default_factory=dict)
    stream_fallback: dict[str, Any] = field(default_factory=dict)
    scraper: dict[str, Any] = field(default_factory=dict)

    @property
    def base_url(self) -> str:
        return self.canonical_origin

    def effective_base_url(self) -> str:
        if self.base_url_env:
            override = os.environ.get(self.base_url_env, "").strip()
            if override:
                return override.rstrip("/")
        return self.canonical_origin.rstrip("/")

    def matches_exact_domain(self, host: str) -> bool:
        return _match_exact_domain(host, self.domains, self.effective_base_url())

    def matches_pattern(self, host: str) -> bool:
        return _match_domain_pattern(host, self.domain_patterns)

    def matches_host(self, host: str) -> bool:
        return self.matches_exact_domain(host) or self.matches_pattern(host)

    def default_headers(self, referer: str | None = None) -> dict[str, str]:
        origin = self.effective_base_url()
        return {
            "Referer": referer or (origin + "/"),
            "Origin": origin,
            "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8",
        }

    def origins_list(self) -> list[str]:
        origins: list[str] = []
        base = self.effective_base_url()
        if base:
            origins.append(base)
        for d in self.domains:
            clean = str(d or "").strip().removeprefix("*.")
            if not clean:
                continue
            origin = clean if "://" in clean else f"https://{clean}"
            if origin not in origins:
                origins.append(origin.rstrip("/"))
        return origins

    def to_frontend_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "displayName": self.display_name,
            "iconKind": self.icon_kind,
            "accentColor": self.accent_color,
            "urlHints": dict(self.url_hints or {}),
            "catalogModes": list(self.catalog_modes),
            "defaultCategory": self.default_category,
            "searchCategories": list(self.search_categories),
            "subfilters": [dict(sf) for sf in self.subfilters],
            "capabilities": self.capabilities.to_frontend_dict(self.search_categories),
            "origins": self.origins_list(),
        }


@dataclass(frozen=True)
class ImageHostRule:
    id: str
    domains: tuple[str, ...] = ()
    viewer_path_prefixes: tuple[str, ...] = ()
    viewer_path_regex: str = ""
    direct_host_regex: str = ""
    direct_path_prefixes: tuple[str, ...] = ()
    direct_path_markers: tuple[str, ...] = ()
    thumb_to_full_replace: tuple[str, str] | None = None
    gateway_submit_names: tuple[str, ...] = ("imgContinue", "continue")

    def matches_host(self, host: str) -> bool:
        h = _clean_host(host)
        if not h:
            return False
        for d in self.domains:
            d_clean = _clean_host(d)
            if h == d_clean or h.endswith("." + d_clean):
                return True
        if self.direct_host_regex:
            try:
                if re.search(self.direct_host_regex, h, re.IGNORECASE):
                    return True
            except re.error:
                pass
        return False


@dataclass(frozen=True)
class ConnectorBundle:
    catalogs: tuple[CatalogDescriptor, ...] = ()
    forums: tuple[ForumDescriptor, ...] = ()
    video_portals: tuple[VideoPortalDescriptor, ...] = ()
    image_hosts: tuple[ImageHostRule, ...] = ()


_BUNDLE_CACHE: tuple[str, float, ConnectorBundle] | None = None


def clear_connector_cache() -> None:
    global _BUNDLE_CACHE
    _BUNDLE_CACHE = None


def _clean_host(host_or_url: str) -> str:
    raw = (host_or_url or "").strip()
    if "://" in raw:
        raw = urlsplit(raw).hostname or ""
    h = raw.lower().split(":", 1)[0].strip(".")
    if h.startswith("www."):
        h = h[4:]
    elif h.startswith("m."):
        h = h[2:]
    return h


def _match_exact_domain(
    host: str,
    domains: tuple[str, ...],
    effective_base_url: str = "",
) -> bool:
    h = _clean_host(host)
    if not h:
        return False
    all_domains = list(domains)
    if effective_base_url:
        base_host = _clean_host(effective_base_url)
        if base_host and base_host not in all_domains:
            all_domains.append(base_host)
    for d in all_domains:
        d_clean = _clean_host(d)
        if d_clean.startswith("*."):
            d_clean = d_clean[2:]
        if d_clean and (h == d_clean or h.endswith("." + d_clean)):
            return True
    return False


def _match_domain_pattern(
    host: str,
    patterns: tuple[str, ...],
) -> bool:
    h = _clean_host(host)
    if not h:
        return False
    for pat in patterns:
        p = pat.strip().lower()
        if p and p in h:
            return True
    return False


def _match_host(
    host: str,
    domains: tuple[str, ...],
    patterns: tuple[str, ...],
    effective_base_url: str = "",
) -> bool:
    return _match_exact_domain(host, domains, effective_base_url) or _match_domain_pattern(host, patterns)


def _parse_capabilities(
    raw: dict[str, Any] | None,
    *,
    default_archetype: str,
    default_layout_mode: str = "editorial_wall",
) -> SourceCapabilitiesSpec:
    data = raw or {}
    default_thread = default_archetype == "forum_board"
    default_dirs: tuple[str, ...] = ("boards",) if default_archetype == "forum_board" else ("categories",)
    raw_dirs = data.get("directoryKinds") or default_dirs
    normalized_dirs = tuple(
        "boards" if str(k).strip().lower() == "sections" else str(k).strip().lower()
        for k in raw_dirs
        if str(k).strip()
    )
    return SourceCapabilitiesSpec(
        archetype=str(data.get("archetype") or default_archetype),
        layout_mode=str(data.get("layoutMode") or default_layout_mode),
        supports_comments=bool(data.get("supportsComments", False)),
        supports_source_likes=bool(data.get("supportsSourceLikes", False)),
        supports_native_playback=bool(data.get("supportsNativePlayback", False)),
        supports_videos_tab=bool(data.get("supportsVideosTab", False)),
        supports_playlists=bool(data.get("supportsPlaylists", False)),
        supports_artist_profiles=bool(data.get("supportsArtistProfiles", True)),
        supports_directories=bool(data.get("supportsDirectories", True)),
        supports_thread_reader=bool(data.get("supportsThreadReader", default_thread)),
        directory_kinds=normalized_dirs,
    )


def get_writable_connectors_path() -> Path:
    env_path = os.environ.get("IMAGEX_CONNECTORS_FILE", "").strip()
    if env_path:
        return Path(env_path)
    return get_default_local_connectors_path()


def _resolve_config_path() -> Path | None:
    env_path = os.environ.get("IMAGEX_CONNECTORS_FILE", "").strip()
    if env_path:
        p = Path(env_path)
        return p if p.is_file() else None
    default_path = get_default_local_connectors_path()
    if default_path.is_file():
        return default_path
    return None


def load_connector_bundle(force_reload: bool = False) -> ConnectorBundle:
    global _BUNDLE_CACHE
    if force_reload:
        _BUNDLE_CACHE = None
    path = _resolve_config_path()
    if path is None:
        return ConnectorBundle()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return ConnectorBundle()
    key = str(path)
    if _BUNDLE_CACHE is not None and _BUNDLE_CACHE[0] == key and _BUNDLE_CACHE[1] == mtime:
        return _BUNDLE_CACHE[2]
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return ConnectorBundle()
    if not isinstance(payload, dict):
        return ConnectorBundle()

    catalogs: list[CatalogDescriptor] = []
    for raw in payload.get("catalogs") or []:
        if not isinstance(raw, dict) or not raw.get("id") or not raw.get("baseUrl"):
            continue
        root_mode = str(raw.get("rootMode") or "api_list")
        default_layout = "category_showcase" if root_mode == "category_first" else "editorial_wall"
        catalogs.append(
            CatalogDescriptor(
                id=str(raw["id"]).strip().lower(),
                display_name=str(raw.get("displayName") or raw["id"]),
                base_url=str(raw["baseUrl"]).rstrip("/"),
                domains=tuple(str(d) for d in (raw.get("domains") or [])),
                domain_patterns=tuple(str(p) for p in (raw.get("domainPatterns") or [])),
                base_url_env=str(raw.get("baseUrlEnv") or ""),
                icon_kind=str(raw.get("iconKind") or "gallery_catalog"),
                root_mode=root_mode,
                catalog_modes=tuple(str(m) for m in (raw.get("catalogModes") or ("popular", "recent", "albums"))),
                default_category=str(raw.get("defaultCategory") or "recent"),
                search_categories=tuple(str(c) for c in (raw.get("searchCategories") or ("all", "profiles", "albums"))),
                subfilters=tuple(dict(sf) for sf in (raw.get("subfilters") or []) if isinstance(sf, dict)),
                capabilities=_parse_capabilities(
                    raw.get("capabilities"),
                    default_archetype="gallery_catalog",
                    default_layout_mode=default_layout,
                ),
                browse=dict(raw.get("browse") or {}),
                selectors=dict(raw.get("selectors") or {}),
            )
        )

    forums: list[ForumDescriptor] = []
    for raw in payload.get("forums") or []:
        if not isinstance(raw, dict) or not raw.get("id") or not raw.get("baseUrl"):
            continue
        forums.append(
            ForumDescriptor(
                id=str(raw["id"]).strip().lower(),
                display_name=str(raw.get("displayName") or raw["id"]),
                base_url=str(raw["baseUrl"]).rstrip("/"),
                domains=tuple(str(d) for d in (raw.get("domains") or [])),
                domain_patterns=tuple(str(p) for p in (raw.get("domainPatterns") or [])),
                base_url_env=str(raw.get("baseUrlEnv") or ""),
                icon_kind=str(raw.get("iconKind") or "forum_board"),
                catalog_modes=tuple(str(m) for m in (raw.get("catalogModes") or ("albums", "videos", "gifs", "posts", "recent"))),
                default_category=str(raw.get("defaultCategory") or "albums"),
                search_categories=tuple(
                    str(c) for c in (raw.get("searchCategories") or ("all", "profiles", "albums", "videos", "gifs", "posts"))
                ),
                subfilters=tuple(dict(sf) for sf in (raw.get("subfilters") or []) if isinstance(sf, dict)),
                capabilities=_parse_capabilities(
                    raw.get("capabilities"),
                    default_archetype="forum_board",
                    default_layout_mode="forum_index",
                ),
                forum=dict(raw.get("forum") or {}),
            )
        )

    hosts: list[ImageHostRule] = []
    for raw in payload.get("imageHosts") or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        rep = raw.get("thumbToFullReplace")
        rep_tuple: tuple[str, str] | None = (
            (str(rep[0]), str(rep[1])) if isinstance(rep, list) and len(rep) == 2 else None
        )
        hosts.append(
            ImageHostRule(
                id=str(raw["id"]).strip().lower(),
                domains=tuple(str(d) for d in (raw.get("domains") or [])),
                viewer_path_prefixes=tuple(str(p) for p in (raw.get("viewerPathPrefixes") or [])),
                viewer_path_regex=str(raw.get("viewerPathRegex") or ""),
                direct_host_regex=str(raw.get("directHostRegex") or ""),
                direct_path_prefixes=tuple(str(p) for p in (raw.get("directPathPrefixes") or [])),
                direct_path_markers=tuple(str(p) for p in (raw.get("directPathMarkers") or [])),
                thumb_to_full_replace=rep_tuple,
                gateway_submit_names=tuple(str(n) for n in (raw.get("gatewaySubmitNames") or ("imgContinue", "continue"))),
            )
        )

    video_portals: list[VideoPortalDescriptor] = []
    for raw in payload.get("videoPortals") or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        if raw.get("enabled") is False:
            continue
        origin = str(raw.get("canonicalOrigin") or raw.get("baseUrl") or "").strip().rstrip("/")
        domains = tuple(str(d) for d in (raw.get("domains") or []) if d)
        if not origin and domains:
            origin = f"https://{domains[0].removeprefix('*.')}"
        if not origin:
            continue
        video_portals.append(
            VideoPortalDescriptor(
                id=str(raw["id"]).strip().lower(),
                display_name=str(raw.get("displayName") or raw["id"]),
                canonical_origin=origin,
                domains=domains,
                domain_patterns=tuple(str(p) for p in (raw.get("domainPatterns") or [])),
                base_url_env=str(raw.get("baseUrlEnv") or ""),
                icon_kind=str(raw.get("iconKind") or "video_portal"),
                accent_color=str(raw.get("accentColor") or ""),
                enabled=bool(raw.get("enabled", True)),
                catalog_modes=tuple(
                    str(m) for m in (raw.get("catalogModes") or ("videos", "popular", "recent", "playlists"))
                ),
                default_category=str(raw.get("defaultCategory") or "recent"),
                search_categories=tuple(
                    str(c) for c in (raw.get("searchCategories") or ("all", "profiles", "videos", "playlists"))
                ),
                subfilters=tuple(dict(sf) for sf in (raw.get("subfilters") or []) if isinstance(sf, dict)),
                url_hints=dict(raw.get("urlHints") or {}),
                capabilities=_parse_capabilities(
                    raw.get("capabilities"),
                    default_archetype="video_portal",
                    default_layout_mode="video_wall",
                ),
                routing=dict(raw.get("routing") or {}),
                video_cards=dict(raw.get("videoCards") or {}),
                profile=dict(raw.get("profile") or {}),
                watch=dict(raw.get("watch") or {}),
                comments=dict(raw.get("comments") or {}),
                browse=dict(raw.get("browse") or {}),
                search=dict(raw.get("search") or {}),
                stream_fallback=dict(raw.get("streamFallback") or {}),
                scraper=dict(raw["scraper"]) if isinstance(raw.get("scraper"), dict) else {},
            )
        )

    bundle = ConnectorBundle(
        catalogs=tuple(catalogs),
        forums=tuple(forums),
        video_portals=tuple(video_portals),
        image_hosts=tuple(hosts),
    )
    _BUNDLE_CACHE = (key, mtime, bundle)
    return bundle


def list_catalog_descriptors() -> tuple[CatalogDescriptor, ...]:
    return load_connector_bundle().catalogs


def list_forum_descriptors() -> tuple[ForumDescriptor, ...]:
    return load_connector_bundle().forums


def list_video_portal_descriptors() -> tuple[VideoPortalDescriptor, ...]:
    return load_connector_bundle().video_portals


def list_image_host_rules() -> tuple[ImageHostRule, ...]:
    return load_connector_bundle().image_hosts


def get_connector_descriptor(source_id: str) -> CatalogDescriptor | ForumDescriptor | VideoPortalDescriptor | None:
    sid = str(source_id or "").strip().lower()
    bundle = load_connector_bundle()
    for c in bundle.catalogs:
        if c.id == sid:
            return c
    for f in bundle.forums:
        if f.id == sid:
            return f
    for vp in bundle.video_portals:
        if vp.id == sid:
            return vp
    return None


def find_connector_for_url(url: str) -> CatalogDescriptor | ForumDescriptor | VideoPortalDescriptor | None:
    host = _clean_host(url)
    if not host:
        return None
    bundle = load_connector_bundle()
    # Pass 1: exact / subdomain domain matches always take precedence over substring patterns
    for c in bundle.catalogs:
        if c.matches_exact_domain(host):
            return c
    for f in bundle.forums:
        if f.matches_exact_domain(host):
            return f
    for vp in bundle.video_portals:
        if vp.matches_exact_domain(host):
            return vp
    # Pass 2: fallback substring pattern matches
    for c in bundle.catalogs:
        if c.matches_pattern(host):
            return c
    for f in bundle.forums:
        if f.matches_pattern(host):
            return f
    for vp in bundle.video_portals:
        if vp.matches_pattern(host):
            return vp
    return None
