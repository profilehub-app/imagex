"""Extensible visual discovery browse providers for the Unified Timeline.

Powers ``GET /api/profile-hub/timeline/browse-sources`` and
``POST /api/profile-hub/timeline/browse`` dynamically from configured
catalog and forum descriptors without requiring saved creators first.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypedDict

import httpx

from .connector_registry import (
    CatalogDescriptor,
    ForumDescriptor,
    VideoPortalDescriptor,
    list_catalog_descriptors,
    list_forum_descriptors,
    list_video_portal_descriptors,
)
from .forum_board_engine import browse_forum_board
from .gallery_catalog_engine import browse_catalog
from .video_portal_engine import browse_video_portal

BrowseCategory = Literal["popular", "recent", "albums", "photos", "videos", "gifs", "posts"]


class BrowseSubfilterOption(TypedDict):
    id: str
    label_key: str
    fallback_label: str
    group: str


@dataclass(frozen=True)
class TimelineBrowseProviderCapabilities:
    source_id: str
    display_name: str
    default_category: BrowseCategory
    categories: tuple[BrowseCategory, ...]
    subfilters: tuple[BrowseSubfilterOption, ...] = ()
    supports_quick_url_open: bool = True
    icon_kind: str = "gallery_catalog"
    capabilities_meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class BrowsePageResult:
    source_id: str
    category: str
    subfilter: str | None = None
    items: list[dict[str, Any]] = field(default_factory=list)
    profiles: list[dict[str, Any]] = field(default_factory=list)
    dynamic_subfilters: list[dict[str, Any]] = field(default_factory=list)
    next_cursor: str | None = None
    has_more: bool = False
    resolved_origin: str | None = None
    error: str | None = None


class TimelineBrowseProvider(Protocol):
    capabilities: TimelineBrowseProviderCapabilities

    async def browse(
        self,
        client: httpx.AsyncClient,
        category: str,
        *,
        subfilter: str | None = None,
        cursor: str | None = None,
        limit: int = 24,
    ) -> BrowsePageResult:
        ...


class CatalogBrowseProvider:
    def __init__(self, descriptor: CatalogDescriptor) -> None:
        self._desc = descriptor
        self.capabilities = TimelineBrowseProviderCapabilities(
            source_id=descriptor.id,
            display_name=descriptor.display_name,
            default_category=descriptor.default_category,  # type: ignore[arg-type]
            categories=tuple(descriptor.catalog_modes),  # type: ignore[arg-type]
            subfilters=tuple(descriptor.subfilters),  # type: ignore[arg-type]
            supports_quick_url_open=True,
            icon_kind=descriptor.icon_kind,
            capabilities_meta=descriptor.capabilities.to_frontend_dict(descriptor.search_categories),
        )

    async def browse(
        self,
        client: httpx.AsyncClient,
        category: str,
        *,
        subfilter: str | None = None,
        cursor: str | None = None,
        limit: int = 24,
    ) -> BrowsePageResult:
        return await browse_catalog(
            client,
            self._desc,
            category,
            subfilter=subfilter,
            cursor=cursor,
            limit=limit,
        )


class ForumBrowseProvider:
    def __init__(self, descriptor: ForumDescriptor) -> None:
        self._desc = descriptor
        self.capabilities = TimelineBrowseProviderCapabilities(
            source_id=descriptor.id,
            display_name=descriptor.display_name,
            default_category=descriptor.default_category,  # type: ignore[arg-type]
            categories=tuple(descriptor.catalog_modes),  # type: ignore[arg-type]
            subfilters=tuple(descriptor.subfilters),  # type: ignore[arg-type]
            supports_quick_url_open=True,
            icon_kind=descriptor.icon_kind,
            capabilities_meta=descriptor.capabilities.to_frontend_dict(descriptor.search_categories),
        )

    async def browse(
        self,
        client: httpx.AsyncClient,
        category: str,
        *,
        subfilter: str | None = None,
        cursor: str | None = None,
        limit: int = 24,
    ) -> BrowsePageResult:
        return await browse_forum_board(
            client,
            self._desc,
            category,
            subfilter=subfilter,
            cursor=cursor,
            limit=limit,
        )


class VideoPortalBrowseProvider:
    def __init__(self, descriptor: VideoPortalDescriptor) -> None:
        self._desc = descriptor
        self.capabilities = TimelineBrowseProviderCapabilities(
            source_id=descriptor.id,
            display_name=descriptor.display_name,
            default_category=descriptor.default_category,  # type: ignore[arg-type]
            categories=tuple(descriptor.catalog_modes),  # type: ignore[arg-type]
            subfilters=tuple(descriptor.subfilters),  # type: ignore[arg-type]
            supports_quick_url_open=True,
            icon_kind=descriptor.icon_kind,
            capabilities_meta=descriptor.capabilities.to_frontend_dict(descriptor.search_categories),
        )

    async def browse(
        self,
        client: httpx.AsyncClient,
        category: str,
        *,
        subfilter: str | None = None,
        cursor: str | None = None,
        limit: int = 24,
    ) -> BrowsePageResult:
        return await browse_video_portal(
            client,
            self._desc,
            category,
            subfilter=subfilter,
            cursor=cursor,
            limit=limit,
        )


_BROWSE_PROVIDERS: dict[str, TimelineBrowseProvider] = {}


def register_browse_provider(provider: TimelineBrowseProvider) -> None:
    sid = str(provider.capabilities.source_id or "").strip().lower()
    if not sid:
        raise ValueError("Browse provider source_id must be non-empty")
    _BROWSE_PROVIDERS[sid] = provider


def _dynamic_browse_providers() -> dict[str, TimelineBrowseProvider]:
    merged: dict[str, TimelineBrowseProvider] = {}
    for c in list_catalog_descriptors():
        merged[c.id] = CatalogBrowseProvider(c)
    for f in list_forum_descriptors():
        merged[f.id] = ForumBrowseProvider(f)
    for vp in list_video_portal_descriptors():
        merged[vp.id] = VideoPortalBrowseProvider(vp)
    merged.update(_BROWSE_PROVIDERS)
    return merged


def list_browse_providers() -> tuple[TimelineBrowseProvider, ...]:
    return tuple(_dynamic_browse_providers().values())


def get_browse_provider(source_id: str) -> TimelineBrowseProvider | None:
    return _dynamic_browse_providers().get(str(source_id or "").strip().lower())
