import {
  resolveTimelinePlatform,
  timelinePostSourceKey,
  type TimelineCreator,
  type TimelinePlatform,
  type TimelinePost,
} from '../components/profile-hub/timeline/timelineModel';
import {
  registerDynamicSources,
  type DynamicSourceSubfilter,
  type DynamicUrlHints,
  type SourceCapabilities,
} from '../components/profile-hub/timeline/timelineSourceCapabilities';
import type { XAccount, XPost } from '../components/profile-hub/timeline/LiveSocialTimeline';
import { readLiveX, type XSearchTab } from './liveXConnector';

export type SearchCategoryTab =
  | 'all'
  | 'profiles'
  | 'playlists'
  | 'videos'
  | 'shorts'
  | 'albums'
  | 'gifs'
  | 'posts';

export type SearchBucketKey = Exclude<SearchCategoryTab, 'all'>;

export interface SearchFilterOptions {
  boardId?: string | null;
  subfilter?: string | null;
  searchScope?: 'titles' | 'posts';
  mediaFilter?: 'all' | 'images' | 'videos';
  sortBy?: string | null;
}

export interface SearchSourceDescriptor {
  id: string;
  name: string;
  categories: SearchCategoryTab[];
  supportsLiveConnector: boolean;
  iconKind?: string;
  accentColor?: string;
  urlHints?: DynamicUrlHints;
  origins?: string[];
  subfilters?: DynamicSourceSubfilter[];
  capabilities?: Partial<SourceCapabilities>;
}

export interface SearchCursorState {
  cursor: string | null;
  hasMore: boolean;
}

export interface SearchSourceStatus {
  ok: boolean;
  count: number;
  hasMore: boolean;
  error?: string | null;
}

export interface TimelineSearchSnapshot {
  query: string;
  sections: Record<SearchBucketKey, TimelineCreator[] | TimelinePost[]>;
  profiles: TimelineCreator[];
  playlists: TimelinePost[];
  videos: TimelinePost[];
  shorts: TimelinePost[];
  albums: TimelinePost[];
  gifs: TimelinePost[];
  posts: TimelinePost[];
  cursors: Record<string, SearchCursorState>;
  sourceStatus: Record<string, SearchSourceStatus>;
  fetchedSources: string[];
  loadingSources: string[];
  hasMore: boolean;
  xLiveStatus: 'idle' | 'live' | 'login_required' | 'unavailable';
  xTabHasMore: Partial<Record<XSearchTab, boolean>>;
  liveXPosts: Record<string, XPost>;
}

export type SearchPostCreatorTarget =
  | { kind: 'x'; account: XAccount }
  | { kind: 'url'; url: string }
  | { kind: 'local'; creatorId: string }
  | null;

export interface OmniSearchApiResponse {
  ok?: boolean;
  query: string;
  creators?: TimelineCreator[];
  posts?: TimelinePost[];
  sections?: Partial<Record<SearchBucketKey, unknown[]>>;
  cursors?: Record<string, SearchCursorState>;
  sourceStatus?: Record<string, SearchSourceStatus>;
  hasMore?: boolean;
}

export interface LocalSearchBuckets {
  profiles: TimelineCreator[];
  playlists: TimelinePost[];
  videos: TimelinePost[];
  shorts: TimelinePost[];
  albums: TimelinePost[];
  gifs: TimelinePost[];
  posts: TimelinePost[];
}

const BUCKET_KEYS: readonly SearchBucketKey[] = [
  'profiles',
  'playlists',
  'videos',
  'shorts',
  'albums',
  'gifs',
  'posts',
];

function profileIdentity(c: TimelineCreator): string {
  return (c.profileUrl || c.id || `${c.site}:${c.handle}`).trim().toLowerCase();
}

function postIdentity(p: TimelinePost): string {
  return timelinePostSourceKey(p.originalUrl || '') || (p.id || '').trim().toLowerCase();
}

export function createEmptySearchSnapshot(
  query: string,
  initialFetchedSources: readonly string[] = [],
): TimelineSearchSnapshot {
  const sections: Record<SearchBucketKey, TimelineCreator[] | TimelinePost[]> = {
    profiles: [],
    playlists: [],
    videos: [],
    shorts: [],
    albums: [],
    gifs: [],
    posts: [],
  };
  return {
    query,
    sections,
    profiles: [],
    playlists: [],
    videos: [],
    shorts: [],
    albums: [],
    gifs: [],
    posts: [],
    cursors: {},
    sourceStatus: {},
    fetchedSources: [...new Set(initialFetchedSources.map(s => s.toLowerCase()))],
    loadingSources: [],
    hasMore: false,
    xLiveStatus: 'idle',
    xTabHasMore: {},
    liveXPosts: {},
  };
}

export function xSearchTabsForCategory(category: SearchCategoryTab): readonly XSearchTab[] {
  if (category === 'profiles') return ['people', 'top'];
  if (category === 'videos') return ['videos', 'top'];
  if (category === 'albums') return ['photos'];
  if (category === 'posts') return ['top', 'latest'];
  if (category === 'all') return ['top', 'people', 'videos'];
  return [];
}

export function hasMoreForCategory(
  snapshot: TimelineSearchSnapshot | null,
  activeSource: string,
  activeCategory: SearchCategoryTab,
): boolean {
  if (!snapshot) return false;
  const normSource = (activeSource || 'all').trim().toLowerCase();
  if (normSource === 'all' && activeCategory === 'all') {
    return Boolean(snapshot.hasMore);
  }
  for (const [key, state] of Object.entries(snapshot.cursors || {})) {
    if (!state?.hasMore || !key.includes(':')) continue;
    const [src, cat] = key.split(':', 2);
    if (normSource !== 'all' && src !== normSource) continue;
    if (activeCategory !== 'all' && cat !== activeCategory) continue;
    return true;
  }
  if (normSource === 'all' || normSource === 'x') {
    const candidateTabs = xSearchTabsForCategory(activeCategory);
    if (candidateTabs.some(tab => snapshot.xTabHasMore?.[tab])) {
      return true;
    }
  }
  return false;
}

export interface SearchRenderSliceState {
  caps: Record<SearchBucketKey, number>;
  hasMoreInWindow: boolean;
  shouldPrefetchRemote: boolean;
}

/**
 * Mirrors Timeline's progressive rendering window so Search Results mount
 * viewport-sized card batches instead of dumping hundreds of cards into the DOM.
 */
export function getSearchRenderSliceState(
  counts: Record<SearchBucketKey, number>,
  activeCategory: SearchCategoryTab,
  windowCount: number,
  pageSize: number,
): SearchRenderSliceState {
  const safeWindow = Math.max(1, Math.floor(windowCount));
  const safePage = Math.max(1, Math.floor(pageSize));
  const caps: Record<SearchBucketKey, number> = {
    profiles: 0,
    playlists: 0,
    videos: 0,
    shorts: 0,
    albums: 0,
    gifs: 0,
    posts: 0,
  };

  if (activeCategory === 'all') {
    let hasMoreInWindow = false;
    let maxCount = 0;
    for (const key of BUCKET_KEYS) {
      const total = Math.max(0, counts[key] || 0);
      caps[key] = Math.min(total, safeWindow);
      if (total > safeWindow) hasMoreInWindow = true;
      if (total > maxCount) maxCount = total;
    }
    const shouldPrefetchRemote = !hasMoreInWindow || safeWindow + safePage >= maxCount;
    return { caps, hasMoreInWindow, shouldPrefetchRemote };
  }

  const activeTotal = Math.max(0, counts[activeCategory] || 0);
  caps[activeCategory] = Math.min(activeTotal, safeWindow);
  const hasMoreInWindow = safeWindow < activeTotal;
  const shouldPrefetchRemote = !hasMoreInWindow || safeWindow + safePage >= activeTotal;
  return { caps, hasMoreInWindow, shouldPrefetchRemote };
}

export function resolveSearchPostCreatorTarget(
  post: TimelinePost,
  knownCreatorIds: ReadonlySet<string>,
): SearchPostCreatorTarget {
  const sourceId = postSourceId(post);
  if (sourceId === 'x') {
    const cleanSourceUrl = (post.sourcePage || '').trim();
    const urlHandleMatch = cleanSourceUrl.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,30})/i);
    const rawHandle = (post.creatorHandle || urlHandleMatch?.[1] || '').replace(/^@/, '').trim();
    if (!rawHandle) return null;
    return {
      kind: 'x',
      account: {
        handle: rawHandle,
        name: post.creatorName || `@${rawHandle}`,
        avatar: typeof post.creatorAvatar === 'string' ? post.creatorAvatar : undefined,
        verified: post.creatorVerified,
      },
    };
  }
  const sourcePage = (post.sourcePage || '').trim();
  if (/^https?:\/\//i.test(sourcePage)) {
    return { kind: 'url', url: sourcePage };
  }
  const creatorId = (post.creatorId || '').trim();
  if (/^https?:\/\//i.test(creatorId)) {
    return { kind: 'url', url: creatorId };
  }
  if (creatorId && knownCreatorIds.has(creatorId)) {
    return { kind: 'local', creatorId };
  }
  return null;
}

function inferPostBucket(post: TimelinePost): Exclude<SearchBucketKey, 'profiles'> {
  if (post.type === 'playlist') return 'playlists';
  if (post.type === 'gif') return 'gifs';
  if (post.type === 'album' || post.type === 'photo_grid') {
    const src = postSourceId(post);
    if (src === 'x' || src === 'slack') return 'posts';
    return 'albums';
  }
  if (post.type === 'video') {
    if (post.isShort || /\/shorts\//i.test(post.originalUrl || '')) return 'shorts';
    return 'videos';
  }
  return 'posts';
}

export function postSourceId(post: TimelinePost): string {
  if (post.source) return String(post.source).toLowerCase();
  return resolveTimelinePlatform(post.originalUrl || post.sourcePage || '') || 'generic';
}

export function profileSourceId(profile: TimelineCreator): string {
  if (profile.site) return String(profile.site).toLowerCase();
  return resolveTimelinePlatform(profile.profileUrl || '') || 'generic';
}

export function classifyLocalSearchMatches(
  query: string,
  creators: readonly TimelineCreator[],
  posts: readonly TimelinePost[],
): LocalSearchBuckets {
  const q = query.trim().toLowerCase();
  const empty: LocalSearchBuckets = {
    profiles: [],
    playlists: [],
    videos: [],
    shorts: [],
    albums: [],
    gifs: [],
    posts: [],
  };
  if (q.length < 2) return empty;

  const seenProf = new Set<string>();
  for (const c of creators) {
    const matched = [c.name, c.handle, c.bio, c.profileUrl].some(v =>
      typeof v === 'string' && v.toLowerCase().includes(q),
    );
    if (!matched) continue;
    const key = profileIdentity(c);
    if (!seenProf.has(key)) {
      seenProf.add(key);
      empty.profiles.push(c);
    }
  }

  const seenByBucket: Record<Exclude<SearchBucketKey, 'profiles'>, Set<string>> = {
    playlists: new Set(),
    videos: new Set(),
    shorts: new Set(),
    albums: new Set(),
    gifs: new Set(),
    posts: new Set(),
  };

  for (const p of posts) {
    const matched = [p.title, p.caption, p.text, p.creatorName, p.creatorHandle].some(v =>
      typeof v === 'string' && v.toLowerCase().includes(q),
    );
    if (!matched) continue;
    const bucket = inferPostBucket(p);
    const key = postIdentity(p);
    if (!key || seenByBucket[bucket].has(key)) continue;
    seenByBucket[bucket].add(key);
    empty[bucket].push(p);
    // Social video posts also appear in Posts category
    const src = postSourceId(p);
    if (bucket === 'videos' && (src === 'x' || src === 'instagram' || src === 'slack')) {
      if (!seenByBucket.posts.has(key)) {
        seenByBucket.posts.add(key);
        empty.posts.push(p);
      }
    }
  }

  return empty;
}

export function interleaveBySource<T>(
  items: readonly T[],
  getSource: (item: T) => string,
): T[] {
  if (items.length <= 1) return [...items];
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const src = (getSource(item) || 'generic').trim().toLowerCase() || 'generic';
    let queue = buckets.get(src);
    if (!queue) {
      queue = [];
      buckets.set(src, queue);
    }
    queue.push(item);
  }
  if (buckets.size <= 1) return [...items];
  const queues = [...buckets.values()];
  const out: T[] = [];
  let maxLen = 0;
  for (const q of queues) {
    if (q.length > maxLen) maxLen = q.length;
  }
  for (let i = 0; i < maxLen; i += 1) {
    for (const q of queues) {
      if (i < q.length) out.push(q[i]);
    }
  }
  return out;
}

type ReinterleaveMode = 'incoming-first' | 'existing-first' | 'append';

function dedupeByIdentity<T>(
  list: readonly T[],
  getId: (item: T) => string,
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const k = getId(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function mergeBucket<T>(
  existing: readonly T[],
  incoming: readonly T[],
  local: readonly T[],
  getId: (item: T) => string,
  getSource: (item: T) => string,
  reinterleaveMode: ReinterleaveMode,
): T[] {
  if (reinterleaveMode === 'incoming-first') {
    return interleaveBySource(dedupeByIdentity([...incoming, ...existing, ...local], getId), getSource);
  }
  if (reinterleaveMode === 'existing-first') {
    return interleaveBySource(dedupeByIdentity([...existing, ...incoming, ...local], getId), getSource);
  }
  const seen = new Set(existing.map(getId).filter(Boolean));
  const freshIncoming = dedupeByIdentity([...incoming, ...local], getId).filter(item => !seen.has(getId(item)));
  return [...existing, ...interleaveBySource(freshIncoming, getSource)];
}

export function mergeSearchSnapshot(
  prev: TimelineSearchSnapshot,
  incoming: OmniSearchApiResponse,
  localMatches?: LocalSearchBuckets,
  extraSourcesFetched: readonly string[] = [],
  liveHasMore = false,
): TimelineSearchSnapshot {
  const rawSections = incoming.sections || {};
  const prevFetched = new Set(prev.fetchedSources.map(s => s.toLowerCase()));
  const incomingSources = [
    ...Object.keys(incoming.sourceStatus || {}),
    ...extraSourcesFetched,
  ].map(s => s.toLowerCase());
  const isInitialLocalOnly = prevFetched.size === 0 && incomingSources.length === 0;
  const introducesUnseenSource = incomingSources.some(s => !prevFetched.has(s));
  const prevFetchedNonXCount = [...prevFetched].filter(s => s !== 'x').length;
  const reinterleaveMode: ReinterleaveMode = (isInitialLocalOnly || introducesUnseenSource)
    ? (prevFetchedNonXCount === 0 ? 'incoming-first' : 'existing-first')
    : 'append';

  const fallbackBuckets: Record<Exclude<SearchBucketKey, 'profiles'>, TimelinePost[]> = {
    playlists: [],
    videos: [],
    shorts: [],
    albums: [],
    gifs: [],
    posts: [],
  };
  if (!incoming.sections && Array.isArray(incoming.posts) && incoming.posts.length) {
    for (const p of incoming.posts) {
      fallbackBuckets[inferPostBucket(p)].push(p);
    }
  }

  const nextProfiles = mergeBucket(
    prev.profiles,
    (rawSections.profiles as TimelineCreator[] | undefined) || incoming.creators || [],
    localMatches?.profiles || [],
    profileIdentity,
    profileSourceId,
    reinterleaveMode,
  );
  const nextPlaylists = mergeBucket(
    prev.playlists,
    (rawSections.playlists as TimelinePost[] | undefined) || fallbackBuckets.playlists,
    localMatches?.playlists || [],
    postIdentity,
    postSourceId,
    reinterleaveMode,
  );
  const nextVideos = mergeBucket(
    prev.videos,
    (rawSections.videos as TimelinePost[] | undefined) || fallbackBuckets.videos,
    localMatches?.videos || [],
    postIdentity,
    postSourceId,
    reinterleaveMode,
  );
  const nextShorts = mergeBucket(
    prev.shorts,
    (rawSections.shorts as TimelinePost[] | undefined) || fallbackBuckets.shorts,
    localMatches?.shorts || [],
    postIdentity,
    postSourceId,
    reinterleaveMode,
  );
  const nextAlbums = mergeBucket(
    prev.albums,
    (rawSections.albums as TimelinePost[] | undefined) || fallbackBuckets.albums,
    localMatches?.albums || [],
    postIdentity,
    postSourceId,
    reinterleaveMode,
  );
  const nextGifs = mergeBucket(
    prev.gifs,
    (rawSections.gifs as TimelinePost[] | undefined) || fallbackBuckets.gifs,
    localMatches?.gifs || [],
    postIdentity,
    postSourceId,
    reinterleaveMode,
  );
  const nextPosts = mergeBucket(
    prev.posts,
    (rawSections.posts as TimelinePost[] | undefined) || fallbackBuckets.posts,
    localMatches?.posts || [],
    postIdentity,
    postSourceId,
    reinterleaveMode,
  );

  const nextCursors: Record<string, SearchCursorState> = { ...prev.cursors };
  for (const [k, v] of Object.entries(incoming.cursors || {})) {
    nextCursors[k] = {
      cursor: v?.cursor ?? null,
      hasMore: Boolean(v?.hasMore),
    };
  }

  const nextStatus: Record<string, SearchSourceStatus> = { ...prev.sourceStatus };
  for (const [src, st] of Object.entries(incoming.sourceStatus || {})) {
    const prevCount = prev.sourceStatus[src]?.count || 0;
    nextStatus[src] = {
      ok: Boolean(st?.ok),
      count: Math.max(prevCount, st?.count || 0),
      hasMore: Boolean(st?.hasMore),
      error: st?.error ?? null,
    };
  }

  const fetchedSet = new Set(prev.fetchedSources.map(s => s.toLowerCase()));
  for (const src of Object.keys(incoming.sourceStatus || {})) fetchedSet.add(src.toLowerCase());
  for (const src of extraSourcesFetched) fetchedSet.add(src.toLowerCase());

  const hasMoreCursors = Object.values(nextCursors).some(c => c.hasMore);

  return {
    ...prev,
    sections: {
      profiles: nextProfiles,
      playlists: nextPlaylists,
      videos: nextVideos,
      shorts: nextShorts,
      albums: nextAlbums,
      gifs: nextGifs,
      posts: nextPosts,
    },
    profiles: nextProfiles,
    playlists: nextPlaylists,
    videos: nextVideos,
    shorts: nextShorts,
    albums: nextAlbums,
    gifs: nextGifs,
    posts: nextPosts,
    cursors: nextCursors,
    sourceStatus: nextStatus,
    fetchedSources: [...fetchedSet],
    hasMore: Boolean(hasMoreCursors || incoming.hasMore || liveHasMore),
  };
}

export function filterSnapshotBySourceAndCategory(
  snapshot: TimelineSearchSnapshot,
  sourceFilter: string,
  category: SearchCategoryTab,
): TimelineSearchSnapshot {
  const normSource = (sourceFilter || 'all').trim().toLowerCase();
  const matchProf = (c: TimelineCreator) => normSource === 'all' || profileSourceId(c) === normSource;
  const matchPost = (p: TimelinePost) => normSource === 'all' || postSourceId(p) === normSource;

  const profiles = (category === 'all' || category === 'profiles') ? snapshot.profiles.filter(matchProf) : [];
  const playlists = (category === 'all' || category === 'playlists') ? snapshot.playlists.filter(matchPost) : [];
  const videos = (category === 'all' || category === 'videos') ? snapshot.videos.filter(matchPost) : [];
  const shorts = (category === 'all' || category === 'shorts') ? snapshot.shorts.filter(matchPost) : [];
  const albums = (category === 'all' || category === 'albums') ? snapshot.albums.filter(matchPost) : [];
  const gifs = (category === 'all' || category === 'gifs') ? snapshot.gifs.filter(matchPost) : [];
  const posts = (category === 'all' || category === 'posts') ? snapshot.posts.filter(matchPost) : [];

  return {
    ...snapshot,
    sections: { profiles, playlists, videos, shorts, albums, gifs, posts },
    profiles,
    playlists,
    videos,
    shorts,
    albums,
    gifs,
    posts,
  };
}

export function getDeduplicatedAllItems(snapshot: TimelineSearchSnapshot): TimelinePost[] {
  const seen = new Set<string>();
  const out: TimelinePost[] = [];
  for (const list of [
    snapshot.playlists,
    snapshot.videos,
    snapshot.shorts,
    snapshot.albums,
    snapshot.gifs,
    snapshot.posts,
  ]) {
    for (const item of list) {
      const k = postIdentity(item);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

export function mapXAccountToCreator(acct: XAccount): TimelineCreator {
  const cleanHandle = (acct.handle || '').replace(/^@+/, '').trim();
  return {
    id: `x:${cleanHandle.toLowerCase()}`,
    name: acct.name || cleanHandle,
    handle: cleanHandle ? `@${cleanHandle}` : '@x',
    avatar: acct.avatar || '',
    banner: acct.banner,
    verified: Boolean(acct.verified),
    bio: acct.bio,
    profileUrl: `https://x.com/${encodeURIComponent(cleanHandle)}`,
    site: 'x',
    stats: {
      followers: acct.followers != null ? String(acct.followers) : undefined,
      posts: typeof acct.postsCount === 'number' ? acct.postsCount : undefined,
    },
  };
}

export function mapXPostToTimelinePost(xp: XPost): TimelinePost {
  const cleanHandle = (xp.handle || '').replace(/^@+/, '').trim() || 'x';
  const postKey = `live-x:${xp.id}`;
  const hasVid = Boolean(xp.video || (xp.hasVideo && xp.poster));
  return {
    id: postKey,
    creatorId: `x:${cleanHandle.toLowerCase()}`,
    creatorName: xp.name || cleanHandle,
    creatorHandle: `@${cleanHandle}`,
    creatorAvatar: xp.avatar || '',
    creatorVerified: Boolean(xp.verified),
    type: hasVid ? 'video' : xp.photos?.length ? 'photo_grid' : 'text',
    source: 'x',
    title: xp.text || xp.name || `@${cleanHandle}`,
    text: xp.text,
    caption: xp.text,
    photos: xp.photos,
    photoCount: xp.photos?.length || undefined,
    thumbnail: xp.poster || xp.photos?.[0] || xp.avatar || '',
    videoUrl: xp.video,
    originalUrl: xp.url || `https://x.com/${cleanHandle}/status/${xp.id}`,
    sourcePage: `https://x.com/${cleanHandle}`,
    date: xp.date || '',
    likes: xp.metrics?.likes ?? null,
    comments: [],
    metrics: xp.metrics,
    relation: xp.relation,
  };
}

export async function fetchSearchSources(signal?: AbortSignal): Promise<SearchSourceDescriptor[]> {
  try {
    const resp = await fetch('/api/profile-hub/timeline/search-sources?integrated_only=1', { signal });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!Array.isArray(data?.sources)) return [];
    const mapped: SearchSourceDescriptor[] = data.sources.map((s: Record<string, unknown>) => ({
      id: String(s.id || '').toLowerCase(),
      name: String(s.name || s.id || ''),
      categories: Array.isArray(s.categories) ? (s.categories as SearchCategoryTab[]) : [],
      supportsLiveConnector: Boolean(s.supportsLiveConnector),
      iconKind: typeof s.iconKind === 'string' ? s.iconKind : undefined,
      accentColor: typeof s.accentColor === 'string' ? s.accentColor : undefined,
      urlHints: s.urlHints && typeof s.urlHints === 'object' ? (s.urlHints as DynamicUrlHints) : undefined,
      origins: Array.isArray(s.origins) ? (s.origins as string[]) : undefined,
      subfilters: Array.isArray(s.subfilters) ? (s.subfilters as DynamicSourceSubfilter[]) : undefined,
      capabilities: s.capabilities && typeof s.capabilities === 'object'
        ? (s.capabilities as Partial<SourceCapabilities>)
        : undefined,
    }));
    // Only register external dynamic connectors (never clobber built-in video/social platforms,
    // and never overwrite browse catalog modes with search bucket tabs like 'all'/'profiles').
    registerDynamicSources(
      mapped
        .filter((item) => Boolean(item.capabilities))
        .map((item) => ({
          id: item.id,
          name: item.name,
          iconKind: item.iconKind,
          accentColor: item.accentColor,
          urlHints: item.urlHints,
          origins: item.origins,
          subfilters: item.subfilters,
          capabilities: item.capabilities,
        }))
    );
    return mapped;
  } catch {
    return [];
  }
}

function cleanSearchOptions(options?: SearchFilterOptions): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const out: Record<string, unknown> = {};
  if (options.boardId) out.boardId = options.boardId;
  if (options.subfilter) out.subfilter = options.subfilter;
  if (options.searchScope && options.searchScope !== 'titles') out.searchScope = options.searchScope;
  if (options.mediaFilter && options.mediaFilter !== 'all') out.mediaFilter = options.mediaFilter;
  if (options.sortBy && options.sortBy !== 'relevance') out.sortBy = options.sortBy;
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function defaultPostOmniSearch(
  body: {
    query: string;
    source: string;
    category?: SearchCategoryTab;
    cursors?: Record<string, string>;
    options?: Record<string, unknown>;
  },
  signal?: AbortSignal,
): Promise<OmniSearchApiResponse> {
  const resp = await fetch('/api/profile-hub/timeline/omni-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, integrated_only: true }),
    signal,
  });
  if (!resp.ok) throw new Error(`omni_search_${resp.status}`);
  return (await resp.json()) as OmniSearchApiResponse;
}

type LiveXCursorEntry = {
  cursor: string;
  offset: number;
  hasMore: boolean;
  searchTab: XSearchTab;
};

export interface SearchCoordinatorDeps {
  fetchSources: (signal?: AbortSignal) => Promise<SearchSourceDescriptor[]>;
  postOmniSearch: (
    body: {
      query: string;
      source: string;
      category?: SearchCategoryTab;
      cursors?: Record<string, string>;
      options?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ) => Promise<OmniSearchApiResponse>;
  readLiveXSearch?: (
    offset: number,
    query: { cursor: string; scope: 'search'; searchQuery: string; searchTab: XSearchTab; backgroundOnly: boolean },
    signal: AbortSignal,
  ) => Promise<{ status?: string; items?: unknown[]; relevantPeople?: unknown[] }>;
  newUuid?: () => string;
}

function makeUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return '5b252af6-ea4d-45e8-ad29-' + Math.floor(Math.random() * 1e12).toString().padStart(12, '0');
}

export function createSearchCoordinator(overrides: Partial<SearchCoordinatorDeps> = {}) {
  const deps: SearchCoordinatorDeps = {
    fetchSources: overrides.fetchSources || fetchSearchSources,
    postOmniSearch: overrides.postOmniSearch || defaultPostOmniSearch,
    readLiveXSearch:
      overrides.readLiveXSearch ||
      ((offset, q, signal) => readLiveX(offset, q, signal, false) as Promise<{ status?: string; items?: unknown[]; relevantPeople?: unknown[] }>),
    newUuid: overrides.newUuid || makeUuid,
  };

  let requestGeneration = 0;
  let activeController: AbortController | null = null;
  let cachedSources: SearchSourceDescriptor[] | null = null;
  let snapshot: TimelineSearchSnapshot | null = null;
  let localPool: { creators: readonly TimelineCreator[]; posts: readonly TimelinePost[] } = {
    creators: [],
    posts: [],
  };
  let liveXCursors: Partial<Record<XSearchTab, LiveXCursorEntry>> = {};
  const listeners = new Set<(snap: TimelineSearchSnapshot | null, sources: SearchSourceDescriptor[]) => void>();

  const notify = () => {
    const list = cachedSources || [];
    for (const cb of listeners) cb(snapshot, list);
  };

  const isAbortError = (err: unknown): boolean =>
    Boolean(err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'AbortError');

  const ensureSources = async (signal?: AbortSignal): Promise<SearchSourceDescriptor[]> => {
    if (cachedSources) return cachedSources;
    try {
      const loaded = await deps.fetchSources(signal);
      if (loaded.length) cachedSources = loaded;
      return loaded;
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) return cachedSources || [];
      return cachedSources || [];
    }
  };

  const runLiveXTabs = async (
    query: string,
    tabs: readonly XSearchTab[],
    gen: number,
    signal: AbortSignal,
    isAdvance = false,
  ) => {
    if (!deps.readLiveXSearch) return;
    await Promise.all(
      tabs.map(async tab => {
        try {
          const existing = liveXCursors[tab];
          if (isAdvance && (!existing || !existing.hasMore)) return;
          const cursor = isAdvance && existing ? existing.cursor : (deps.newUuid ? deps.newUuid() : makeUuid());
          const offset = isAdvance && existing ? existing.offset : 0;
          const res = await deps.readLiveXSearch!(
            offset,
            { cursor, scope: 'search', searchQuery: query, searchTab: tab, backgroundOnly: true },
            signal,
          );
          if (signal.aborted || gen !== requestGeneration || !snapshot || snapshot.query !== query) return;
          if (res?.status === 'login_required') {
            snapshot = { ...snapshot, xLiveStatus: 'login_required' };
            notify();
            return;
          }
          const rawItems = Array.isArray(res?.items) ? res.items : [];
          const rawRelevant = Array.isArray(res?.relevantPeople) ? res.relevantPeople : [];
          const nextProfiles: TimelineCreator[] = [];
          const nextVideos: TimelinePost[] = [];
          const nextAlbums: TimelinePost[] = [];
          const nextPosts: TimelinePost[] = [];
          const nextLiveMap: Record<string, XPost> = { ...snapshot.liveXPosts };

          for (const rp of rawRelevant) {
            if (rp && typeof rp === 'object' && 'handle' in rp) {
              nextProfiles.push(mapXAccountToCreator(rp as XAccount));
            }
          }
          for (const item of rawItems) {
            if (!item || typeof item !== 'object') continue;
            if (tab === 'people' || !('id' in item)) {
              if ('handle' in item) nextProfiles.push(mapXAccountToCreator(item as XAccount));
              continue;
            }
            const xp = item as XPost;
            const mapped = mapXPostToTimelinePost(xp);
            nextLiveMap[mapped.id] = xp;
            if (tab === 'videos' || mapped.type === 'video') nextVideos.push(mapped);
            if (tab === 'photos') nextAlbums.push(mapped);
            nextPosts.push(mapped);
          }

          const more = rawItems.length > 0;
          liveXCursors[tab] = { cursor, offset: offset + 1, hasMore: more, searchTab: tab };
          const nextTabHasMore: Partial<Record<XSearchTab, boolean>> = {
            ...snapshot.xTabHasMore,
            [tab]: more,
          };
          const liveAnyMore = Object.values(nextTabHasMore).some(Boolean);
          const httpXHasMore = Object.entries(snapshot.cursors || {}).some(
            ([k, st]) => k.startsWith('x:') && Boolean(st?.hasMore),
          );
          snapshot = mergeSearchSnapshot(
            { ...snapshot, xLiveStatus: 'live', xTabHasMore: nextTabHasMore, liveXPosts: nextLiveMap },
            {
              query,
              sections: {
                profiles: nextProfiles,
                videos: nextVideos,
                albums: nextAlbums,
                posts: nextPosts,
              },
              sourceStatus: {
                x: {
                  ok: true,
                  count: (snapshot.sourceStatus.x?.count || 0) + nextProfiles.length + nextPosts.length,
                  hasMore: Boolean(liveAnyMore || httpXHasMore),
                },
              },
            },
            undefined,
            ['x'],
            liveAnyMore,
          );
          notify();
        } catch (err) {
          if (signal.aborted || gen !== requestGeneration || !snapshot) return;
          const msg = err instanceof Error ? err.message : '';
          if (msg === 'connection_required' || msg === 'extension_reload_required') {
            snapshot = { ...snapshot, xLiveStatus: 'unavailable' };
            notify();
          }
        }
      }),
    );
  };

  return {
    getSnapshot: () => snapshot,
    getSources: () => cachedSources || [],
    subscribe(listener: (snap: TimelineSearchSnapshot | null, sources: SearchSourceDescriptor[]) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setLocalPool(creators: readonly TimelineCreator[], posts: readonly TimelinePost[]) {
      localPool = { creators, posts };
      if (snapshot && snapshot.query.length >= 2) {
        const localMatches = classifyLocalSearchMatches(snapshot.query, creators, posts);
        snapshot = mergeSearchSnapshot(snapshot, { query: snapshot.query }, localMatches);
        notify();
      }
    },
    invalidateSources() {
      cachedSources = null;
      notify();
    },
    clear() {
      requestGeneration += 1;
      activeController?.abort();
      activeController = null;
      liveXCursors = {};
      snapshot = null;
      notify();
    },
    async initSources(signal?: AbortSignal) {
      const list = await ensureSources(signal);
      notify();
      return list;
    },
    async search(
      rawQuery: string,
      sourceFilter = 'all',
      options?: SearchFilterOptions,
    ): Promise<TimelineSearchSnapshot | null> {
      const q = rawQuery.trim();
      if (q.length < 2) {
        this.clear();
        return null;
      }
      const gen = ++requestGeneration;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      liveXCursors = {};

      const normSource = (sourceFilter || 'all').trim().toLowerCase();
      const knownSources = await ensureSources(controller.signal);
      if (controller.signal.aborted || gen !== requestGeneration) return snapshot;

      const localMatches = classifyLocalSearchMatches(q, localPool.creators, localPool.posts);
      const isAll = normSource === 'all';
      const hasXIntegrated = knownSources.some(s => s.id.toLowerCase() === 'x');
      const initialLoading = isAll
        ? knownSources.map(s => s.id)
        : [normSource];

      snapshot = mergeSearchSnapshot(
        {
          ...createEmptySearchSnapshot(q),
          loadingSources: initialLoading,
        },
        { query: q },
        localMatches,
      );
      notify();

      const livePromise = (normSource === 'x' || (isAll && hasXIntegrated))
        ? runLiveXTabs(q, ['top', 'people', 'videos'], gen, controller.signal, false)
        : Promise.resolve();

      const cleanOpts = cleanSearchOptions(options);
      try {
        const data = await deps.postOmniSearch(
          cleanOpts ? { query: q, source: normSource, options: cleanOpts } : { query: q, source: normSource },
          controller.signal,
        );
        if (controller.signal.aborted || gen !== requestGeneration) return snapshot;
        const baseSnap = snapshot || createEmptySearchSnapshot(q);
        const liveAnyMore = Object.values(liveXCursors).some(c => c?.hasMore);
        snapshot = {
          ...mergeSearchSnapshot(baseSnap, data, undefined, isAll ? knownSources.map(s => s.id) : [normSource], liveAnyMore),
          loadingSources: [],
        };
        notify();
      } catch {
        if (!controller.signal.aborted && gen === requestGeneration && snapshot) {
          snapshot = { ...snapshot, loadingSources: [] };
          notify();
        }
      }

      await livePromise;
      return snapshot;
    },
    async refetchSource(
      targetSource: string,
      options?: SearchFilterOptions,
    ): Promise<TimelineSearchSnapshot | null> {
      if (!snapshot || snapshot.query.length < 2) return snapshot;
      const norm = (targetSource || '').trim().toLowerCase();
      if (!norm || norm === 'all') return snapshot;
      const q = snapshot.query;
      const gen = requestGeneration;
      const controller = activeController || new AbortController();
      if (!activeController && gen === requestGeneration) {
        activeController = controller;
      }

      // Strip previous results/cursors strictly for targetSource while keeping all other sources intact
      const keepProf = (c: TimelineCreator) => profileSourceId(c) !== norm;
      const keepPost = (p: TimelinePost) => postSourceId(p) !== norm;
      const nextCursors: Record<string, SearchCursorState> = {};
      for (const [k, v] of Object.entries(snapshot.cursors || {})) {
        if (!k.startsWith(`${norm}:`)) nextCursors[k] = v;
      }
      const nextStatus: Record<string, SearchSourceStatus> = { ...snapshot.sourceStatus };
      delete nextStatus[norm];

      const stripped: TimelineSearchSnapshot = {
        ...snapshot,
        profiles: snapshot.profiles.filter(keepProf),
        playlists: snapshot.playlists.filter(keepPost),
        videos: snapshot.videos.filter(keepPost),
        shorts: snapshot.shorts.filter(keepPost),
        albums: snapshot.albums.filter(keepPost),
        gifs: snapshot.gifs.filter(keepPost),
        posts: snapshot.posts.filter(keepPost),
        sections: {
          profiles: snapshot.profiles.filter(keepProf),
          playlists: snapshot.playlists.filter(keepPost),
          videos: snapshot.videos.filter(keepPost),
          shorts: snapshot.shorts.filter(keepPost),
          albums: snapshot.albums.filter(keepPost),
          gifs: snapshot.gifs.filter(keepPost),
          posts: snapshot.posts.filter(keepPost),
        },
        cursors: nextCursors,
        sourceStatus: nextStatus,
        fetchedSources: snapshot.fetchedSources.filter(s => s !== norm),
        loadingSources: [...new Set([...snapshot.loadingSources, norm])],
      };
      snapshot = stripped;
      notify();

      const cleanOpts = cleanSearchOptions(options);
      try {
        const res = await deps.postOmniSearch(
          cleanOpts ? { query: q, source: norm, options: cleanOpts } : { query: q, source: norm },
          controller.signal,
        );
        if (controller.signal.aborted || gen !== requestGeneration || !snapshot) return snapshot;
        snapshot = {
          ...mergeSearchSnapshot(snapshot, res, undefined, [norm]),
          loadingSources: snapshot.loadingSources.filter(s => s !== norm),
        };
        notify();
      } catch {
        if (!controller.signal.aborted && gen === requestGeneration && snapshot) {
          snapshot = {
            ...snapshot,
            fetchedSources: [...new Set([...snapshot.fetchedSources, norm])],
            loadingSources: snapshot.loadingSources.filter(s => s !== norm),
          };
          notify();
        }
      }
      return snapshot;
    },
    async ensureSourceFetched(
      nextSource: string,
      options?: SearchFilterOptions,
    ): Promise<TimelineSearchSnapshot | null> {
      if (!snapshot || snapshot.query.length < 2) return snapshot;
      const q = snapshot.query;
      const gen = requestGeneration;
      const norm = (nextSource || 'all').trim().toLowerCase();
      const sources = await ensureSources();
      if (gen !== requestGeneration || !snapshot) return snapshot;

      const fetched = new Set(snapshot.fetchedSources.map(s => s.toLowerCase()));
      const backendIds = sources.map(s => s.id.toLowerCase());
      const missing: string[] = norm === 'all'
        ? backendIds.filter(id => !fetched.has(id))
        : (backendIds.includes(norm) && !fetched.has(norm) ? [norm] : []);

      if (!missing.length) return snapshot;
      const controller = activeController || new AbortController();
      if (!activeController && gen === requestGeneration) {
        activeController = controller;
      }
      snapshot = {
        ...snapshot,
        loadingSources: [...new Set([...snapshot.loadingSources, ...missing])],
      };
      notify();

      const cleanOpts = norm !== 'all' ? cleanSearchOptions(options) : undefined;
      const fetchList = async () => {
        const results = await Promise.all(
          missing.map(src =>
            deps
              .postOmniSearch(
                cleanOpts && src === norm
                  ? { query: q, source: src, options: cleanOpts }
                  : { query: q, source: src },
                controller.signal,
              )
              .catch(() => null),
          ),
        );
        if (gen !== requestGeneration || !snapshot) return;
        let next = snapshot;
        for (let i = 0; i < missing.length; i += 1) {
          const res = results[i];
          if (res) {
            next = mergeSearchSnapshot(next, res, undefined, [missing[i]]);
          } else {
            next = { ...next, fetchedSources: [...new Set([...next.fetchedSources, missing[i]])] };
          }
        }
        snapshot = {
          ...next,
          loadingSources: next.loadingSources.filter(s => !missing.includes(s)),
        };
        notify();
      };

      await Promise.all([
        fetchList(),
        missing.includes('x') ? runLiveXTabs(q, ['top', 'people', 'videos'], gen, controller.signal, false) : Promise.resolve(),
      ]);
      return snapshot;
    },
    async ensureCategoryXTab(tab: 'latest' | 'photos') {
      if (!snapshot || snapshot.query.length < 2 || liveXCursors[tab]) return snapshot;
      if (snapshot.xLiveStatus === 'login_required' || snapshot.xLiveStatus === 'unavailable') return snapshot;
      const gen = requestGeneration;
      const controller = activeController || new AbortController();
      await runLiveXTabs(snapshot.query, [tab], gen, controller.signal, false);
      return snapshot;
    },
    async loadMore(
      activeSource: string,
      activeCategory: SearchCategoryTab,
      options?: SearchFilterOptions,
    ): Promise<TimelineSearchSnapshot | null> {
      if (!snapshot || snapshot.query.length < 2) return snapshot;
      const q = snapshot.query;
      const gen = requestGeneration;
      const controller = activeController || new AbortController();
      const normSource = (activeSource || 'all').trim().toLowerCase();

      const pendingCursors: Record<string, string> = {};
      for (const [key, state] of Object.entries(snapshot.cursors)) {
        if (!state?.hasMore || !state.cursor || !key.includes(':')) continue;
        const [src, cat] = key.split(':', 2);
        if (normSource !== 'all' && src !== normSource) continue;
        if (activeCategory !== 'all' && cat !== activeCategory) continue;
        pendingCursors[key] = state.cursor;
      }

      const xTabsToAdvance: XSearchTab[] = [];
      if (normSource === 'all' || normSource === 'x') {
        const candidateTabs = xSearchTabsForCategory(activeCategory);
        for (const t of candidateTabs) {
          if (liveXCursors[t]?.hasMore) xTabsToAdvance.push(t);
        }
      }

      if (!Object.keys(pendingCursors).length && !xTabsToAdvance.length) return snapshot;

      const cleanOpts = normSource !== 'all' ? cleanSearchOptions(options) : undefined;
      const tasks: Promise<unknown>[] = [];
      if (Object.keys(pendingCursors).length) {
        tasks.push(
          deps
            .postOmniSearch(
              cleanOpts
                ? { query: q, source: normSource, category: activeCategory, cursors: pendingCursors, options: cleanOpts }
                : { query: q, source: normSource, category: activeCategory, cursors: pendingCursors },
              controller.signal,
            )
            .then(data => {
              if (gen !== requestGeneration || !snapshot) return;
              const liveAnyMore = Object.values(liveXCursors).some(c => c?.hasMore);
              snapshot = mergeSearchSnapshot(snapshot, data, undefined, [], liveAnyMore);
              notify();
            }),
        );
      }
      if (xTabsToAdvance.length) {
        tasks.push(runLiveXTabs(q, xTabsToAdvance, gen, controller.signal, true));
      }

      try {
        await Promise.all(tasks);
      } catch (err) {
        if (!controller.signal.aborted && gen === requestGeneration && !isAbortError(err)) {
          throw err;
        }
      }
      return snapshot;
    },
  };
}
