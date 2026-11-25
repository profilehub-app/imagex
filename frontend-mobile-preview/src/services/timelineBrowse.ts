import {
  mapBrowseItemToTimelinePost,
  resolveTimelinePlatform,
  type TimelineCreator,
  type TimelinePhotoItem,
  type TimelinePlatform,
  type TimelinePost,
} from '../components/profile-hub/timeline/timelineModel';
import {
  registerDynamicOrigin,
  registerDynamicSources,
  type DirectoryKind,
  type DynamicUrlHints,
  type SourceCapabilities,
} from '../components/profile-hub/timeline/timelineSourceCapabilities';

export interface BrowseSubfilterOption {
  id: string;
  label_key: string;
  fallback_label: string;
  group: string;
  path?: string;
}

export interface TimelineBrowseSourceCapability {
  source_id: string;
  display_name: string;
  default_category: string;
  categories: string[];
  subfilters: BrowseSubfilterOption[];
  supports_quick_url_open?: boolean;
  icon_kind?: string;
  accentColor?: string;
  urlHints?: DynamicUrlHints;
  capabilities?: Partial<SourceCapabilities>;
  origins?: string[];
}

export interface TimelineDirectoryItem {
  id: string;
  name: string;
  url: string;
  kind: DirectoryKind | string;
  count?: number;
  avatar?: string;
  thumbnailUrl?: string;
  hasCoverPreview?: boolean;
  verified?: boolean;
  subscribersText?: string;
  rank?: number;
}

export interface TimelineDirectoryResponse {
  source: string;
  kind: string;
  page: number;
  items: TimelineDirectoryItem[];
  hasMore?: boolean;
  nextPage?: number | null;
  nextPageUrl?: string | null;
  maxPage?: number;
  error?: string | null;
}

export interface CatalogEnrichmentMetadata {
  title?: string;
  author?: string;
  authorUrl?: string;
  artists?: Array<{ name: string; url?: string; kind?: string }>;
  channels?: Array<{ name: string; url?: string; kind?: string }>;
  tags?: string[];
  tagEntities?: Array<{ name: string; url?: string; kind?: string }>;
  photoCount?: number;
  photos?: string[];
  photoItems?: TimelinePhotoItem[];
}

export interface ForumBoardItem {
  id: string;
  boardId: string;
  name: string;
  url: string;
  role?: string;
}

export interface ForumBoardSection {
  title: string;
  boards: ForumBoardItem[];
}

export interface ForumBoardsResponse {
  ok: boolean;
  source: string;
  sections: ForumBoardSection[];
  error?: string | null;
}

export interface ForumThreadPost {
  id: string;
  author: string;
  authorUrl?: string;
  date?: string;
  text: string;
  photos: Array<{ id?: string; url: string; thumbnailUrl?: string; pageUrl?: string }>;
  releaseLinks: Array<{ host?: string; url: string; label?: string }>;
}

export interface ForumThreadViewResponse {
  success: boolean;
  threadUrl: string;
  pageUrl?: string;
  title: string;
  author?: string;
  authorUrl?: string;
  breadcrumbs?: Array<{ name: string; url?: string }>;
  threadKind?: string;
  releaseSpecs?: string[];
  photos: TimelinePhotoItem[];
  count: number;
  posts: ForumThreadPost[];
  currentPage: number;
  totalPages: number;
  hasMore: boolean;
  nextPageUrl?: string | null;
  paginationComplete?: boolean;
  error?: string | null;
}

export interface TimelineBrowsePageResponse {
  source: string;
  category: string;
  subfilter?: string | null;
  items: TimelinePost[];
  profiles: TimelineCreator[];
  dynamicSubfilters?: BrowseSubfilterOption[];
  nextCursor: string | null;
  hasMore: boolean;
  resolvedOrigin?: string | null;
  error?: string | null;
}

export interface TimelineBrowseFeedSlice {
  items: TimelinePost[];
  profiles: TimelineCreator[];
  dynamicSubfilters?: BrowseSubfilterOption[];
  category: string;
  subfilter: string | null;
  cursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  resolvedOrigin?: string | null;
}

export async function fetchBrowseSources(
  signal?: AbortSignal,
  integratedOnly = true
): Promise<TimelineBrowseSourceCapability[]> {
  const endpoint = integratedOnly
    ? '/api/profile-hub/timeline/browse-sources?integrated_only=1'
    : '/api/profile-hub/timeline/browse-sources';
  const response = await fetch(endpoint, {
    method: 'GET',
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  const sources: TimelineBrowseSourceCapability[] = Array.isArray(data?.sources) ? data.sources : [];
  if (sources.length > 0) {
    registerDynamicSources(sources);
  }
  return sources;
}

export async function fetchIntegratedSourcesApi(signal?: AbortSignal): Promise<{
  ok: boolean;
  sources: Array<{
    id: string;
    displayName: string;
    originUrl: string;
    domains: string[];
    kind: string;
    addedVia: string;
    integratedAt: string;
  }>;
}> {
  const response = await fetch('/api/profile-hub/timeline/integrated-sources', {
    method: 'GET',
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return {
    ok: Boolean(data?.ok ?? true),
    sources: Array.isArray(data?.sources) ? data.sources : [],
  };
}

export async function integrateTimelineUrlApi(rawUrl: string, signal?: AbortSignal) {
  const response = await fetch('/api/profile-hub/timeline/integrate-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: rawUrl }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

export async function removeIntegratedSourceApi(sourceId: string, signal?: AbortSignal) {
  const sid = encodeURIComponent(String(sourceId || '').trim().toLowerCase());
  const response = await fetch(`/api/profile-hub/timeline/integrated-sources/${sid}`, {
    method: 'DELETE',
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

export async function resetIntegratedSourcesApi(signal?: AbortSignal) {
  const response = await fetch('/api/profile-hub/timeline/integrated-sources/reset', {
    method: 'POST',
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchTimelineBrowsePage(params: {
  source: TimelinePlatform | string;
  category?: string;
  subfilter?: string | null;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<TimelineBrowsePageResponse> {
  const sourceId = String(params.source || '').trim().toLowerCase() as TimelinePlatform;
  const response = await fetch('/api/profile-hub/timeline/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: sourceId,
      category: params.category || 'popular',
      subfilter: params.subfilter || null,
      cursor: params.cursor || null,
      limit: params.limit || 24,
      integrated_only: true,
    }),
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  if (typeof data?.resolved_origin === 'string' && data.resolved_origin) {
    registerDynamicOrigin(data.resolved_origin, sourceId);
  }
  const rawItems = Array.isArray(data?.items) ? data.items : [];
  const items = rawItems.map((it: Record<string, any>) =>
    mapBrowseItemToTimelinePost(it, sourceId)
  );
  if (items[0]?.originalUrl) {
    registerDynamicOrigin(items[0].originalUrl, sourceId);
  }
  const rawProfiles = Array.isArray(data?.profiles) ? data.profiles : [];
  const profiles: TimelineCreator[] = rawProfiles.map((p: Record<string, any>) => ({
    id: String(p.id || p.profileUrl || `${sourceId}:${p.name}`),
    name: String(p.name || sourceId),
    handle: String(p.handle || `@${sourceId}`),
    avatar: String(p.avatar || ''),
    profileUrl: String(p.profileUrl || ''),
    site: resolveTimelinePlatform(String(p.profileUrl || ''), String(p.site || sourceId)) || sourceId,
    verified: Boolean(p.verified),
    stats: {},
    bio: typeof p.bio === 'string' ? p.bio : undefined,
  }));

  const rawDynamicSubs = Array.isArray(data?.dynamicSubfilters) ? data.dynamicSubfilters : [];
  const dynamicSubfilters: BrowseSubfilterOption[] = rawDynamicSubs
    .filter((s: any) => s && typeof s.id === 'string' && s.id.trim())
    .map((s: any) => ({
      id: String(s.id),
      label_key: String(s.label_key || ''),
      fallback_label: String(s.fallback_label || s.id),
      group: String(s.group || 'category'),
      path: typeof s.path === 'string' ? s.path : undefined,
    }));

  return {
    source: String(data?.source || sourceId),
    category: String(data?.category || params.category || 'popular'),
    subfilter: data?.subfilter ?? params.subfilter ?? null,
    items,
    profiles,
    dynamicSubfilters,
    nextCursor: typeof data?.next_cursor === 'string' ? data.next_cursor : null,
    hasMore: Boolean(data?.has_more),
    resolvedOrigin: typeof data?.resolved_origin === 'string' ? data.resolved_origin : null,
    error: typeof data?.error === 'string' && data.error ? data.error : null,
  };
}

export async function fetchTimelineDirectory(params: {
  source: string;
  kind: string;
  page?: number;
  pageUrl?: string | null;
  signal?: AbortSignal;
}): Promise<TimelineDirectoryResponse> {
  const qs = new URLSearchParams({
    source: String(params.source || '').trim().toLowerCase(),
    kind: String(params.kind || 'categories').trim().toLowerCase(),
    page: String(params.page && params.page > 0 ? params.page : 1),
  });
  if (params.pageUrl) qs.set('pageUrl', params.pageUrl);
  const response = await fetch(`/api/profile-hub/timeline/directory?${qs.toString()}`, {
    method: 'GET',
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return {
    source: String(data?.source || params.source),
    kind: String(data?.kind || params.kind),
    page: typeof data?.page === 'number' ? data.page : (params.page || 1),
    items: Array.isArray(data?.items) ? data.items : [],
    hasMore: Boolean(data?.hasMore),
    nextPage: typeof data?.nextPage === 'number' ? data.nextPage : null,
    nextPageUrl: typeof data?.nextPageUrl === 'string' ? data.nextPageUrl : null,
    maxPage: typeof data?.maxPage === 'number' ? data.maxPage : undefined,
    error: typeof data?.error === 'string' ? data.error : null,
  };
}

export async function fetchDirectoryCover(source: string, url: string, signal: AbortSignal): Promise<string> {
  const query = new URLSearchParams({ source, url });
  const response = await fetch(`/api/profile-hub/timeline/directory-cover?${query}`, { signal });
  if (!response.ok) return '';
  const data = await response.json();
  return typeof data?.thumbnailUrl === 'string' ? data.thumbnailUrl : '';
}

export async function enrichCatalogBatch(
  items: Array<{ url: string; source: string }>,
  signal?: AbortSignal
): Promise<Record<string, CatalogEnrichmentMetadata>> {
  if (!Array.isArray(items) || items.length === 0) return {};
  const response = await fetch('/api/profile-hub/timeline/catalog-enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data?.metadata && typeof data.metadata === 'object' ? data.metadata : {};
}

export async function fetchForumBoards(
  source: string,
  signal?: AbortSignal
): Promise<ForumBoardsResponse> {
  const qs = new URLSearchParams({
    source: String(source || '').trim().toLowerCase(),
  });
  const response = await fetch(`/api/profile-hub/timeline/forum-boards?${qs.toString()}`, {
    method: 'GET',
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return {
    ok: Boolean(data?.ok ?? true),
    source: String(data?.source || source),
    sections: Array.isArray(data?.sections) ? data.sections : [],
    error: typeof data?.error === 'string' ? data.error : null,
  };
}

export async function fetchForumThreadPage(params: {
  url: string;
  page?: number;
  pageUrl?: string;
  signal?: AbortSignal;
}): Promise<ForumThreadViewResponse> {
  const response = await fetch('/api/profile-hub/timeline/thread-view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: params.url,
      page: params.page || 1,
      pageUrl: params.pageUrl || undefined,
    }),
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return {
    success: Boolean(data?.success ?? true),
    threadUrl: String(data?.threadUrl || params.url),
    pageUrl: typeof data?.pageUrl === 'string' ? data.pageUrl : undefined,
    title: String(data?.title || ''),
    author: typeof data?.author === 'string' ? data.author : undefined,
    authorUrl: typeof data?.authorUrl === 'string' ? data.authorUrl : undefined,
    breadcrumbs: Array.isArray(data?.breadcrumbs) ? data.breadcrumbs : [],
    threadKind: typeof data?.threadKind === 'string' ? data.threadKind : undefined,
    releaseSpecs: Array.isArray(data?.releaseSpecs) ? data.releaseSpecs : [],
    photos: Array.isArray(data?.photos) ? data.photos : [],
    count: typeof data?.count === 'number' ? data.count : 0,
    posts: Array.isArray(data?.posts) ? data.posts : [],
    currentPage: typeof data?.currentPage === 'number' ? data.currentPage : 1,
    totalPages: typeof data?.totalPages === 'number' ? data.totalPages : 1,
    hasMore: Boolean(data?.hasMore),
    nextPageUrl: typeof data?.nextPageUrl === 'string' ? data.nextPageUrl : null,
    paginationComplete: typeof data?.paginationComplete === 'boolean' ? data.paginationComplete : undefined,
    error: typeof data?.error === 'string' ? data.error : null,
  };
}

export interface GalleryDetailResponse {
  ok: boolean;
  source: string;
  sourceName: string;
  galleryUrl: string;
  title: string;
  author?: string;
  authorUrl?: string;
  artists: Array<{ name: string; url?: string; kind?: string }>;
  channels: Array<{ name: string; url?: string; kind?: string }>;
  tags: string[];
  tagEntities: Array<{ name: string; url?: string; kind?: string }>;
  photos: TimelinePhotoItem[];
  count: number;
  relatedGalleries: TimelinePost[];
  error?: string | null;
}

export async function fetchGalleryDetail(
  url: string,
  signal?: AbortSignal
): Promise<GalleryDetailResponse> {
  const response = await fetch('/api/profile-hub/timeline/gallery-detail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  const sourceId = String(data?.source || '').trim().toLowerCase() as TimelinePlatform;
  const rawRelated = Array.isArray(data?.relatedGalleries) ? data.relatedGalleries : [];
  const relatedGalleries = rawRelated.map((it: Record<string, any>) =>
    mapBrowseItemToTimelinePost(it, sourceId || 'generic')
  );
  const rawPhotos = Array.isArray(data?.photos) ? data.photos : [];
  const photos: TimelinePhotoItem[] = rawPhotos
    .map((p: Record<string, any>) => ({
      id: p.id,
      url: String(p.originalUrl || p.url || p.thumbnailUrl || ''),
      thumbnailUrl: String(p.thumbnailUrl || p.originalUrl || p.url || ''),
      pageUrl: p.pageUrl || data.galleryUrl,
      sourcePage: p.sourcePage || data.galleryUrl,
      width: typeof p.width === 'number' ? p.width : undefined,
      height: typeof p.height === 'number' ? p.height : undefined,
      format: p.format,
      isResolvedOriginal: Boolean(p.isResolvedOriginal),
      requiresProxy: Boolean(p.requiresProxy),
      isAnimated: Boolean(p.isAnimated),
    }))
    .filter((p: TimelinePhotoItem) => Boolean(p.url));

  return {
    ok: Boolean(data?.ok ?? true),
    source: sourceId,
    sourceName: String(data?.sourceName || sourceId),
    galleryUrl: String(data?.galleryUrl || url),
    title: String(data?.title || ''),
    author: typeof data?.author === 'string' ? data.author : undefined,
    authorUrl: typeof data?.authorUrl === 'string' ? data.authorUrl : undefined,
    artists: Array.isArray(data?.artists) ? data.artists : [],
    channels: Array.isArray(data?.channels) ? data.channels : [],
    tags: Array.isArray(data?.tags) ? data.tags : [],
    tagEntities: Array.isArray(data?.tagEntities) ? data.tagEntities : [],
    photos,
    count: typeof data?.count === 'number' ? data.count : photos.length,
    relatedGalleries,
    error: typeof data?.error === 'string' ? data.error : null,
  };
}
