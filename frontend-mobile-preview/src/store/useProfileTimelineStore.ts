import { create } from 'zustand';
import type { ViewId } from '../types';
import type { TimelineWatchSession } from '../components/profile-hub/timeline/TimelineWatchView';
import {
  TimelineCreator,
  TimelinePost,
  TimelineComment,
  TimelineLightboxState,
  TimelinePhotoItem,
  TimelinePlaylist,
  TimelineVideoQuality,
  TimelineSourceIdentityHint,
  doesPostMatchCreator,
  hasKnownExactPublicationDate,
  mapScanResponseToTimelinePosts,
  mergeRefreshedTimelinePosts,
  mergeTimelineCreatorStats,
  resolveCreatorHandle,
  resolveTimelinePlatform,
  sanitizeCreatorHandle,
  sortTimelinePostsByPublication,
  timelinePublicationTime,
  extractPlaylistsFromScan,
  upgradePhotoUrlFast,
} from '../components/profile-hub/timeline/timelineModel';
import { discoverRecentProfileRoot, fetchAlbumPhotos } from '../services/profileHubApi';
import {
  enrichCatalogBatch,
  fetchBrowseSources,
  fetchForumBoards,
  fetchForumThreadPage,
  fetchIntegratedSourcesApi,
  fetchTimelineBrowsePage,
  fetchTimelineDirectory,
  integrateTimelineUrlApi,
  removeIntegratedSourceApi,
  resetIntegratedSourcesApi,
  type BrowseSubfilterOption,
  type CatalogEnrichmentMetadata,
  type ForumBoardSection,
  type ForumThreadViewResponse,
  type TimelineBrowseFeedSlice,
  type TimelineBrowseSourceCapability,
  type TimelineDirectoryItem,
} from '../services/timelineBrowse';
import type {
  IntegratedSourceRecord,
  IntegratedSourcesStatus,
  IntegrateUrlResult,
} from '../components/profile-hub/timeline/timelineOptIn';
import { loadTimelineCreatorProfile } from '../services/timelineCreatorProfile';
import { registerDynamicOrigin } from '../components/profile-hub/timeline/timelineSourceCapabilities';
import { useAppStore } from './useAppStore';
import { readTimelineCatalog, writeTimelineCatalog, catalogSnapshot } from '../services/timelineCatalogCache';
import {useProfileDirectoryLibraryStore} from './useProfileDirectoryLibraryStore';
import {useProfileHubLibraryStore} from './useProfileHubLibraryStore';
import {
  canonicalLibraryMediaKey,
  normalizeTimelinePostToLibraryItem,
} from '../services/profileHubLibraryModel';
import {projectSavedTimelineCreators} from '../services/timelineSavedCreators';
import {engagementSourceUrl} from '../services/profileHubEngagement';

interface CachedAlbumState {
  items: TimelinePhotoItem[];
  page: number;
  totalPages: number;
  hasMore: boolean;
  nextPageUrl: string | null;
  complete: boolean;
}
const albumPhotosMemoryCache = new Map<string, CachedAlbumState>();
const browseControllers = new Map<string, AbortController>();
const browseLoadMoreControllers = new Map<string, AbortController>();
const enrichedCatalogUrls = new Set<string>();
const enrichingCatalogUrls = new Set<string>();
let threadViewController: AbortController | undefined;
let profileLoadMoreController: AbortController | undefined;

const MAX_ALBUM_CACHE_ENTRIES = 200;
const MAX_ENRICHED_URL_SET = 500;

function setAlbumPhotosMemoryCache(key: string, value: CachedAlbumState): void {
  if (albumPhotosMemoryCache.has(key)) {
    albumPhotosMemoryCache.delete(key);
  }
  albumPhotosMemoryCache.set(key, value);
  while (albumPhotosMemoryCache.size > MAX_ALBUM_CACHE_ENTRIES) {
    const oldest = albumPhotosMemoryCache.keys().next().value;
    if (!oldest) break;
    albumPhotosMemoryCache.delete(oldest);
  }
}

function rememberEnrichedUrl(url: string): void {
  if (enrichedCatalogUrls.has(url)) {
    enrichedCatalogUrls.delete(url);
  }
  enrichedCatalogUrls.add(url);
  while (enrichedCatalogUrls.size > MAX_ENRICHED_URL_SET) {
    const oldest = enrichedCatalogUrls.values().next().value;
    if (!oldest) break;
    enrichedCatalogUrls.delete(oldest);
  }
}
// Each opening owns its completion, including reopening the same album.
let lightboxRequestVersion = 0;
let lightboxAlbumController: AbortController | undefined;
let timelineBootstrapRequest: Promise<void> | undefined;
let timelineIdentityHints: TimelineSourceIdentityHint[] = [];
const creatorCatalogControllers = new Map<string, AbortController>();
let timelineHasBootstrapped = false;
let timelineFavoritesSubscribed = false;
let timelineLibrarySubscribed = false;

export interface CreatorWatchReturnTarget {
  viewId: ViewId;
  watchSession: TimelineWatchSession | null;
  playlistId: string | null;
  preferDesktopPreview?: boolean;
}

export interface TimelineDirectorySlice {
  items: TimelineDirectoryItem[];
  page: number;
  hasMore: boolean;
  nextPage: number | null;
  nextPageUrl?: string | null;
  isLoading: boolean;
  error: string | null;
}

export interface TimelineForumBoardsSlice {
  sections: ForumBoardSection[];
  isLoading: boolean;
  error: string | null;
}

export interface TimelineActiveThreadState {
  threadUrl: string;
  title: string;
  source?: string;
  isLoading: boolean;
  data: ForumThreadViewResponse | null;
  error: string | null;
}

interface ProfileTimelineState {
  creators: TimelineCreator[];
  creatorProfiles: Record<string,TimelineCreator>;
  posts: TimelinePost[];
  isLoading: boolean;
  error: string | null;

  activeFilter: 'recentes' | 'para_voce';
  searchQuery: string;
  selectedCreatorId: string | null;
  activeProfileTab: string;

  activeAutoplayPostId: string | null;
  isDiscoveringCreator: Record<string, boolean>;
  discoveredCreatorIds: Record<string, boolean>;
  creatorRefreshErrors: Record<string, boolean>;
  creatorRefreshedAt: Record<string, number>;

  activeCommentsPostId: string | null;
  lightbox: TimelineLightboxState;
  browseCapabilities: Record<string, TimelineBrowseSourceCapability>;
  browseFeedsBySource: Record<string, TimelineBrowseFeedSlice>;
  enrichedCatalogByUrl: Record<string, CatalogEnrichmentMetadata>;
  dynamicSubfiltersBySource: Record<string, BrowseSubfilterOption[]>;
  directoriesByKey: Record<string, TimelineDirectorySlice>;
  forumBoardsBySource: Record<string, TimelineForumBoardsSlice>;
  activeThreadView: TimelineActiveThreadState | null;
  isLoadingMoreProfile: boolean;
  integratedSources: IntegratedSourceRecord[];
  integratedSourcesStatus: IntegratedSourcesStatus;
  isIntegratingSource: boolean;
  lastIntegrationResult: IntegrateUrlResult | null;

  likedPostIds: Record<string, boolean>;
  savedPostIds: Record<string, boolean>;
  favoritedPostIds: Record<string, boolean>;
  followedCreatorIds: Record<string, boolean>;
  userComments: Record<string, TimelineComment[]>;
  isGlobalMuted: boolean;

  // Actions
  loadTimelineData: () => Promise<void>;
  setActiveFilter: (filter: 'recentes' | 'para_voce') => void;
  setSearchQuery: (query: string) => void;
  setSelectedCreatorId: (creatorId: string | null) => void;
  setActiveProfileTab: (tab: string) => void;
  setActiveAutoplayPostId: (postId: string | null) => void;
  discoverCreatorCatalog: (
    creatorId: string,
    signal?: AbortSignal,
    streamFull?: boolean,
    options?: { sort?: string; force?: boolean }
  ) => Promise<void>;
  refreshTimeline: (signal?: AbortSignal) => Promise<void>;
  refreshMissingCreators: (creatorIds: string[], signal?: AbortSignal) => Promise<void>;
  suspendRequests: () => void;
  toggleLike: (postId: string, postSnapshot?: TimelinePost, creatorSnapshot?: Partial<TimelineCreator> | null) => void;
  toggleSave: (postId: string) => void;
  toggleFavorite: (postId: string, postSnapshot?: TimelinePost, creatorSnapshot?: Partial<TimelineCreator> | null) => void;
  pendingCreatorProfileUrl: string | null;
  pendingCreatorSeed: { name?: string; avatar?: string | null } | null;
  pendingCreatorReturn: CreatorWatchReturnTarget | null;
  pendingLibraryWatchRestore: CreatorWatchReturnTarget | null;
  setPendingCreatorProfileUrl: (
    url: string | null,
    seed?: { name?: string; avatar?: string | null } | null,
    returnTarget?: CreatorWatchReturnTarget | null
  ) => void;
  setPendingLibraryWatchRestore: (target: CreatorWatchReturnTarget | null) => void;
  clearPendingLibraryWatchRestore: () => void;
  toggleFollowCreator: (creator: string | TimelineCreator) => boolean;
  openComments: (postId: string) => void;
  closeComments: () => void;
  addComment: (postId: string, text: string) => void;
  openLightbox: (
    images: string[],
    index?: number,
    title?: string,
    albumUrl?: string,
    items?: TimelinePhotoItem[],
    expectedPhotoCount?: number
  ) => void;
  updateLightboxItemResolution: (
    index: number,
    resolved: {
      url: string;
      width?: number;
      height?: number;
      fileSizeBytes?: number;
      format?: string;
      requiresProxy?: boolean;
    }
  ) => void;
  updatePostStream: (
    postId: string,
    updated: {
      videoUrl?: string;
      masterHlsUrl?: string;
      qualities?: TimelineVideoQuality[];
    }
  ) => void;
  closeLightbox: () => void;
  nextLightboxImage: () => void;
  prevLightboxImage: () => void;
  loadNextAlbumPage: () => Promise<void>;
  hydrateBrowseCapabilities: (force?: boolean) => Promise<void>;
  loadIntegratedSources: () => Promise<void>;
  integrateSourceUrl: (rawUrl: string) => Promise<IntegrateUrlResult>;
  removeIntegratedSource: (sourceId: string) => Promise<void>;
  resetIntegratedSources: () => Promise<void>;
  clearLastIntegrationResult: () => void;
  loadBrowseFeed: (
    source: string,
    category?: string,
    subfilter?: string | null,
    reset?: boolean
  ) => Promise<void>;
  loadMoreBrowseFeed: (source: string) => Promise<void>;
  loadDirectory: (source: string, kind: string, page?: number, append?: boolean) => Promise<void>;
  queueCatalogEnrichment: (items: Array<{ url: string; source: string }>) => Promise<void>;
  loadForumBoards: (source: string) => Promise<void>;
  openThreadView: (postOrUrl: TimelinePost | string, title?: string, source?: string) => Promise<void>;
  loadThreadPage: (pageOrUrl: number | string) => Promise<void>;
  closeThreadView: () => void;
  loadMoreCreatorProfileAlbums: (
    creatorId: string,
    creatorOverride?: TimelineCreator,
    existingPostsOverride?: TimelinePost[]
  ) => Promise<{ creator: TimelineCreator; posts: TimelinePost[] } | null>;
  switchCreatorProfileSort: (
    creatorId: string,
    sort: string,
    creatorOverride?: TimelineCreator
  ) => Promise<{ creator: TimelineCreator; posts: TimelinePost[] } | null>;
  toggleGlobalMute: () => void;
}

const STORAGE_KEY = 'imagex_timeline_interactions_v1';

function loadPersistedInteractions() {
  if (typeof window === 'undefined') {
    return { liked: {}, saved: {}, favorited: {}, followed: {}, userComments: {} };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { liked: {}, saved: {}, favorited: {}, followed: {}, userComments: {} };
    return JSON.parse(raw);
  } catch {
    return { liked: {}, saved: {}, favorited: {}, followed: {}, userComments: {} };
  }
}

function persistInteractions(state: {
  liked: Record<string, boolean>;
  saved: Record<string, boolean>;
  favorited: Record<string, boolean>;
  followed: Record<string, boolean>;
  userComments: Record<string, TimelineComment[]>;
}) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

const initialInteractions = loadPersistedInteractions();

function reconcileSavedCreators() {
  const state=useProfileTimelineStore.getState();
  const known={...state.creatorProfiles};
  for(const creator of state.creators) known[creator.id]=creator;
  const creators=projectSavedTimelineCreators(useProfileDirectoryLibraryStore.getState().favorites,Object.values(known));
  for(const creator of creators) known[creator.id]=creator;
  for(const creator of state.creators) {
    if(!creators.some(current=>current.id===creator.id) && state.selectedCreatorId!==creator.id) creatorCatalogControllers.get(creator.id)?.abort();
  }
  useProfileTimelineStore.setState({creators,creatorProfiles:known});
}

function subscribeToSavedCreators() {
  if(timelineFavoritesSubscribed) return;
  timelineFavoritesSubscribed=true;
  useProfileDirectoryLibraryStore.subscribe((state,previous)=>{
    if(state.favorites!==previous.favorites) reconcileSavedCreators();
  });
}

function reconcileLibraryInteractions(previousLikedKeys?: Set<string>, previousFavKeys?: Set<string>) {
  const lib = useProfileHubLibraryStore.getState();
  const state = useProfileTimelineStore.getState();
  const likedKeys = new Set(lib.liked.map((entry) => entry.key));
  const likedIds = new Set(lib.liked.map((entry) => entry.id));
  const favKeys = new Set(lib.favorites.map((entry) => entry.key));
  const favIds = new Set(lib.favorites.map((entry) => entry.id));

  const nextLiked = lib.hydrated ? ({} as Record<string, boolean>) : { ...state.likedPostIds };
  const nextFav = lib.hydrated ? ({} as Record<string, boolean>) : { ...state.favoritedPostIds };

  if (lib.hydrated) {
    for (const id of likedIds) nextLiked[id] = true;
    for (const id of favIds) nextFav[id] = true;
  }

  for (const post of state.posts) {
    const key = canonicalLibraryMediaKey(post);
    const matchesLike = Boolean(likedIds.has(post.id) || (key && likedKeys.has(key)));
    if (matchesLike) {
      nextLiked[post.id] = true;
    } else if (lib.hydrated || (previousLikedKeys && key && previousLikedKeys.has(key))) {
      delete nextLiked[post.id];
    }

    const matchesFav = Boolean(favIds.has(post.id) || (key && favKeys.has(key)));
    if (matchesFav) {
      nextFav[post.id] = true;
    } else if (lib.hydrated || (previousFavKeys && key && previousFavKeys.has(key))) {
      delete nextFav[post.id];
    }
  }

  const prevLikedKeys = Object.keys(state.likedPostIds).filter((k) => state.likedPostIds[k]);
  const curLikedKeys = Object.keys(nextLiked).filter((k) => nextLiked[k]);
  const likedChanged =
    prevLikedKeys.length !== curLikedKeys.length ||
    curLikedKeys.some((k) => !state.likedPostIds[k]);

  const prevFavKeys = Object.keys(state.favoritedPostIds).filter((k) => state.favoritedPostIds[k]);
  const curFavKeys = Object.keys(nextFav).filter((k) => nextFav[k]);
  const favChanged =
    prevFavKeys.length !== curFavKeys.length ||
    curFavKeys.some((k) => !state.favoritedPostIds[k]);

  if (likedChanged || favChanged) {
    persistInteractions({
      liked: nextLiked,
      saved: state.savedPostIds,
      favorited: nextFav,
      followed: state.followedCreatorIds,
      userComments: state.userComments,
    });
    useProfileTimelineStore.setState({
      likedPostIds: nextLiked,
      favoritedPostIds: nextFav,
    });
  }
}

function prioritizeCreatorsForDiscovery(creators: TimelineCreator[]): Array<{ id: string; url: string }> {
  // Prioritize lightweight social feeds first before heavier remote catalog scans.
  const priorityOrder: Record<string, number> = {
    youtube: 0,
    x: 1,
    pinterest: 2,
    imgur: 3,
    generic: 9,
  };
  return [...creators]
    .sort((a, b) => {
      const siteA = resolveTimelinePlatform(a.profileUrl, a.site) || 'generic';
      const siteB = resolveTimelinePlatform(b.profileUrl, b.site) || 'generic';
      return (priorityOrder[siteA] ?? 9) - (priorityOrder[siteB] ?? 9);
    })
    .map((creator) => ({ id: creator.id, url: creator.profileUrl }));
}

export function applyCatalogEnrichmentToPost(
  post: TimelinePost,
  meta: CatalogEnrichmentMetadata | undefined
): TimelinePost {
  if (!meta) return post;
  const primaryArtist = Array.isArray(meta.artists) && meta.artists.length > 0 ? meta.artists[0] : undefined;
  const nextTitle = meta.title && (!post.title || /^\d+$/.test(post.title.trim()) || post.needsEnrichment || /\s+\d{5,}$/.test(post.title.trim()))
    ? meta.title
    : post.title;
  const rawTags = Array.isArray(meta.tags) ? meta.tags : [];
  const normalizedTags = rawTags
    .map((t: any) => (typeof t === 'string' ? t.trim() : String(t?.name || '').trim()))
    .filter(Boolean);
  const rawTagEntities = Array.isArray(meta.tagEntities)
    ? meta.tagEntities
    : rawTags.filter((t: any) => t && typeof t === 'object' && typeof t.name === 'string');
  const normalizedTagEntities = rawTagEntities
    .map((t: any) => ({
      name: String(t?.name || '').trim(),
      url: typeof t?.url === 'string' ? t.url : undefined,
      kind: (t?.kind || 'tag') as any,
    }))
    .filter((t: any) => Boolean(t.name));
  const metaPhotos = Array.isArray(meta.photos)
    ? meta.photos.filter((u): u is string => typeof u === 'string' && Boolean(u.trim()))
    : [];
  const metaPhotoItems: TimelinePhotoItem[] = Array.isArray(meta.photoItems)
    ? meta.photoItems
        .filter((it) => it && typeof it.url === 'string' && Boolean(it.url.trim()))
        .map((it, idx) => ({
          ...it,
          id: it.id || `${post.id}-ph-${idx}`,
          thumbnailUrl: it.thumbnailUrl || it.url,
          pageUrl: it.pageUrl || post.albumUrl || post.originalUrl,
          sourcePage: it.sourcePage || post.albumUrl || post.originalUrl,
        }))
    : metaPhotos.map((u, idx) => ({
        id: `${post.id}-ph-${idx}`,
        url: u,
        thumbnailUrl: u,
        pageUrl: post.albumUrl || post.originalUrl,
        sourcePage: post.albumUrl || post.originalUrl,
        isResolvedOriginal: true,
      }));
  const shouldUpdateCreatorName = Boolean(
    meta.author &&
      (!post.creatorName ||
        post.creatorName.includes(' - ') ||
        post.creatorId.endsWith(':discover') ||
        post.creatorHandle === `@${post.source || ''}`)
  );
  const resolvedPhotoCount =
    typeof meta.photoCount === 'number' && meta.photoCount > 0
      ? meta.photoCount
      : metaPhotos.length > 0
        ? metaPhotos.length
        : post.photoCount;
  return {
    ...post,
    title: nextTitle,
    creatorName: shouldUpdateCreatorName ? (meta.author || primaryArtist?.name || post.creatorName) : post.creatorName,
    sourcePage: meta.authorUrl || primaryArtist?.url || post.sourcePage,
    artists: Array.isArray(meta.artists) && meta.artists.length > 0
      ? meta.artists.map((a) => ({ ...a, kind: (a.kind || 'artist') as any }))
      : post.artists,
    channels: Array.isArray(meta.channels) && meta.channels.length > 0
      ? meta.channels.map((c) => ({ ...c, kind: (c.kind || 'channel') as any }))
      : post.channels,
    tags: normalizedTags.length > 0 ? normalizedTags : post.tags,
    tagEntities: normalizedTagEntities.length > 0 ? normalizedTagEntities : post.tagEntities,
    photos: metaPhotos.length > 0 ? metaPhotos : post.photos,
    photoItems: metaPhotoItems.length > 0 ? metaPhotoItems : post.photoItems,
    photoCount: resolvedPhotoCount,
    needsEnrichment: false,
  };
}

function subscribeToLibraryStore() {
  if (timelineLibrarySubscribed) return;
  timelineLibrarySubscribed = true;
  useProfileHubLibraryStore.subscribe((state, previous) => {
    if (
      state.liked !== previous.liked ||
      state.favorites !== previous.favorites ||
      state.hydrated !== previous.hydrated
    ) {
      reconcileLibraryInteractions(
        new Set(previous.liked.map((entry) => entry.key)),
        new Set(previous.favorites.map((entry) => entry.key))
      );
    }
  });
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  useProfileTimelineStore.subscribe((state, previous) => {
    if (state.posts !== previous.posts) {
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        reconcileLibraryInteractions();
      }, 600);
    }
  });
}

export const useProfileTimelineStore = create<ProfileTimelineState>((set, get) => ({
  creators: [],
  creatorProfiles: {},
  posts: [],
  isLoading: false,
  error: null,

  activeFilter: 'recentes',
  searchQuery: '',
  selectedCreatorId: null,
  activeProfileTab: 'timeline',

  activeAutoplayPostId: null,
  isDiscoveringCreator: {},
  discoveredCreatorIds: {},
  creatorRefreshErrors: {},
  creatorRefreshedAt: {},

  activeCommentsPostId: null,
  lightbox: {
    isOpen: false,
    images: [],
    items: [],
    currentIndex: 0,
    title: '',
    albumUrl: undefined,
    isLoadingAlbum: false,
    albumPage: 1,
    albumTotalPages: 1,
    albumHasMore: false,
    albumNextPageUrl: null,
    isLoadingMoreAlbumPages: false,
  },
  browseCapabilities: {},
  browseFeedsBySource: {},
  enrichedCatalogByUrl: {},
  dynamicSubfiltersBySource: {},
  directoriesByKey: {},
  forumBoardsBySource: {},
  activeThreadView: null,
  isLoadingMoreProfile: false,
  integratedSources: [],
  integratedSourcesStatus: 'idle',
  isIntegratingSource: false,
  lastIntegrationResult: null,

  likedPostIds: initialInteractions.liked || {},
  savedPostIds: initialInteractions.saved || {},
  favoritedPostIds: initialInteractions.favorited || {},
  followedCreatorIds: initialInteractions.followed || {},
  userComments: initialInteractions.userComments || {},
  isGlobalMuted: true,
  pendingCreatorProfileUrl: null,
  pendingCreatorSeed: null,
  pendingCreatorReturn: null,
  pendingLibraryWatchRestore: null,
  setPendingCreatorProfileUrl: (url, seed = null, returnTarget = null) =>
    set({
      pendingCreatorProfileUrl: url,
      pendingCreatorSeed: url ? seed : null,
      pendingCreatorReturn: url ? returnTarget : null,
    }),
  setPendingLibraryWatchRestore: (target) => set({ pendingLibraryWatchRestore: target }),
  clearPendingLibraryWatchRestore: () => set({ pendingLibraryWatchRestore: null }),

  loadTimelineData: () => {
    if (timelineBootstrapRequest) return timelineBootstrapRequest;
    const request = (async () => {
    set({ isLoading: true, error: null });
    const isEn = useAppStore.getState().settings?.language === 'en-US';

    try {
      if(!timelineHasBootstrapped) {
        const cached = await readTimelineCatalog();
        if(cached) {
          timelineIdentityHints=cached.identityHints;
          const cleanCachedCreators = cached.creators.map((creator) => {
            const cleanHandle = resolveCreatorHandle({
              handle: creator.handle,
              name: creator.name,
              profileUrl: creator.profileUrl,
            });
            return cleanHandle && cleanHandle !== creator.handle ? { ...creator, handle: cleanHandle } : creator;
          });
          const cachedCreatorById = new Map(cleanCachedCreators.map((creator) => [creator.id, creator]));
          const cleanCachedPosts = cached.posts.map((post) => {
            if (sanitizeCreatorHandle(post.creatorHandle)) return post;
            const owner = cachedCreatorById.get(post.creatorId);
            const cleanHandle = resolveCreatorHandle({
              handle: owner?.handle || post.creatorHandle,
              name: owner?.name || post.creatorName,
              profileUrl: owner?.profileUrl,
            });
            return cleanHandle !== post.creatorHandle ? { ...post, creatorHandle: cleanHandle } : post;
          });
          set(state=>({
            creatorProfiles:{...Object.fromEntries(cleanCachedCreators.map(creator=>[creator.id,creator])),...state.creatorProfiles},
            posts:sortTimelinePostsByPublication(cleanCachedPosts),
            creatorRefreshedAt:cached.creatorRefreshedAt
          }));
        }
        timelineHasBootstrapped=true;
      }
      subscribeToSavedCreators();
      subscribeToLibraryStore();
      reconcileSavedCreators();
      await Promise.all([
        useProfileDirectoryLibraryStore.getState().initSync(),
        useProfileHubLibraryStore.getState().hydrateLibrary(),
        get().loadIntegratedSources(),
      ]);
      reconcileSavedCreators();
      reconcileLibraryInteractions();
      const library=useProfileDirectoryLibraryStore.getState();
      set({isLoading:false,error:!library.favoritesHydrated && !get().creators.length
        ? (isEn ? 'Could not load saved creators. Try again.' : 'Não foi possível carregar os criadores salvos. Tente novamente.') : null});
    } catch (err: any) {
      set({
        error: err.message || (isEn ? 'Unknown error' : 'Erro desconhecido'),
        isLoading: false,
      });
    }
    })();
    timelineBootstrapRequest = request;
    void request.finally(() => {
      if (timelineBootstrapRequest === request) timelineBootstrapRequest = undefined;
    });
    return request;
  },

  setActiveFilter: (filter) => set({ activeFilter: filter }),
  setSearchQuery: (query) => set({ searchQuery: query }),

  setSelectedCreatorId: (creatorId) => {
    set({
      selectedCreatorId: creatorId,
      activeProfileTab: 'timeline',
      activeAutoplayPostId: null,
    });
    if (creatorId) {
      void get().discoverCreatorCatalog(creatorId, undefined, true);
    }
  },

  setActiveProfileTab: (tab) => set({ activeProfileTab: tab }),

  setActiveAutoplayPostId: (postId) => set({ activeAutoplayPostId: postId }),

  discoverCreatorCatalog: async (
    creatorId: string,
    parentSignal?: AbortSignal,
    streamFull = false,
    options?: { sort?: string; force?: boolean }
  ) => {
    const state = get();
    if (parentSignal?.aborted || (state.isDiscoveringCreator[creatorId] && !options?.force)) {
      return;
    }
    const creator = state.creators.find((c) => c.id === creatorId) || state.creatorProfiles[creatorId];
    if (!creator || !creator.profileUrl || !creator.profileUrl.startsWith('http')) {
      return;
    }
    const creatorSite = resolveTimelinePlatform(creator.profileUrl, creator.site);
    // Live-connector social networks (X, Instagram, Pinterest, Imgur, Slack) do not use
    // the video-catalog /api/profile-hub/recent endpoint. Refresh X profiles via x-profile-info
    // and mark other social profiles checked cleanly without triggering false 422 warnings.
    if (creatorSite && ['x', 'instagram', 'pinterest', 'imgur', 'slack'].includes(creatorSite)) {
      if (creatorSite === 'x') {
        const handleMatch = creator.profileUrl.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,20})/i);
        const handle = handleMatch?.[1] || (creator.handle || '').replace(/^@/, '');
        if (handle) {
          try {
            const resp = await fetch(`/api/profile-hub/timeline/x-profile-info?handle=${encodeURIComponent(handle)}`, {
              signal: parentSignal,
            });
            if (resp.ok && !parentSignal?.aborted) {
              const data = await resp.json();
              const prof = data?.profile;
              if (prof) {
                set((s) => {
                  const updateCreator = (c: TimelineCreator): TimelineCreator => ({
                    ...c,
                    name: prof.name || c.name,
                    handle: prof.handle || c.handle,
                    avatar: prof.avatar || c.avatar,
                    banner: prof.banner || c.banner,
                    bio: prof.bio || c.bio,
                    verified: Boolean(prof.verified ?? c.verified),
                    stats: {
                      ...c.stats,
                      ...(prof.followers != null ? { followers: String(prof.followers) } : {}),
                      ...(prof.postsCount != null ? { posts: prof.postsCount } : {}),
                    },
                  });
                  const updatedCreators = s.creators.map((c) => (c.id === creatorId ? updateCreator(c) : c));
                  const existing = s.creatorProfiles[creatorId] || creator;
                  return {
                    creators: updatedCreators,
                    creatorProfiles: { ...s.creatorProfiles, [creatorId]: updateCreator(existing) },
                    creatorRefreshErrors: { ...s.creatorRefreshErrors, [creatorId]: false },
                    creatorRefreshedAt: { ...s.creatorRefreshedAt, [creatorId]: Date.now() },
                    discoveredCreatorIds: { ...s.discoveredCreatorIds, [creatorId]: true },
                  };
                });
                return;
              }
            }
          } catch {
            // Keep cached X profile metadata intact
          }
        }
      }
      set((s) => ({
        creatorRefreshErrors: { ...s.creatorRefreshErrors, [creatorId]: false },
        creatorRefreshedAt: { ...s.creatorRefreshedAt, [creatorId]: Date.now() },
        discoveredCreatorIds: { ...s.discoveredCreatorIds, [creatorId]: true },
      }));
      return;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, {once:true});
    creatorCatalogControllers.set(creatorId, controller);

    set((s) => ({
      isDiscoveringCreator: { ...s.isDiscoveringCreator, [creatorId]: true },
      creatorRefreshErrors: { ...s.creatorRefreshErrors, [creatorId]: false },
    }));

    const applyScanResult = (scanData: any) => {
      if (!scanData || signal?.aborted) return;
      set((s) => {
        const targetCreator = s.creators.find((c) => c.id === creatorId) || s.creatorProfiles[creatorId];
        if (!targetCreator || targetCreator.profileUrl !== creator.profileUrl) return s;

        const hero = scanData?.profile_data;
        const nextName = (typeof hero?.name === 'string' && hero.name.trim())
          || (typeof scanData?.name === 'string' && scanData.name.trim())
          || targetCreator.name;
        const nextAvatar = (typeof hero?.avatarUrl === 'string' && hero.avatarUrl.trim())
          || (typeof scanData?.cover_url === 'string' && scanData.cover_url.trim())
          || targetCreator.avatar;
        const nextHandle = resolveCreatorHandle({
          handle: hero?.handle || targetCreator.handle,
          name: nextName,
          profileUrl: targetCreator.profileUrl,
        });
        const nextVerified = hero?.verified !== undefined ? Boolean(hero.verified) : targetCreator.verified;
        const nextBio = (typeof hero?.tagline === 'string' && hero.tagline.trim())
          || (typeof scanData?.description === 'string' && scanData.description.trim())
          || targetCreator.bio;
        const nextSite = resolveTimelinePlatform(
          targetCreator.profileUrl,
          (typeof hero?.site === 'string' ? hero.site : undefined) || targetCreator.site
        ) || targetCreator.site;
        if (nextSite && targetCreator.profileUrl) {
          registerDynamicOrigin(targetCreator.profileUrl, nextSite);
        }
        const nextStats = mergeTimelineCreatorStats(targetCreator.stats, hero?.stats, hero?.bio_details);
        const nextEntityKind = (hero?.entityKind || scanData?.entityKind || targetCreator.entityKind) as TimelineCreator['entityKind'];
        const nextBanner = (typeof hero?.bannerUrl === 'string' && hero.bannerUrl.trim())
          || (typeof scanData?.bannerUrl === 'string' && scanData.bannerUrl.trim())
          || targetCreator.banner;
        const nextPortalInfo = (hero?.portalInfo && typeof hero.portalInfo === 'object' ? hero.portalInfo : undefined)
          || (scanData?.portalInfo && typeof scanData.portalInfo === 'object' ? scanData.portalInfo : undefined)
          || targetCreator.portalInfo;
        const nextPerformers = Array.isArray(scanData?.featuredPerformers)
          ? scanData.featuredPerformers.filter((r: any) => r && typeof r.name === 'string')
          : Array.isArray(hero?.featuredPerformers)
            ? hero.featuredPerformers.filter((r: any) => r && typeof r.name === 'string')
            : targetCreator.featuredPerformers;
        const nextAffiliated = Array.isArray(scanData?.affiliatedChannels)
          ? scanData.affiliatedChannels.filter((r: any) => r && typeof r.name === 'string')
          : Array.isArray(hero?.affiliatedChannels)
            ? hero.affiliatedChannels.filter((r: any) => r && typeof r.name === 'string')
            : targetCreator.affiliatedChannels;
        const nextInterests = Array.isArray(scanData?.interests)
          ? scanData.interests.filter((r: any) => r && typeof r.name === 'string')
          : Array.isArray(hero?.interests)
            ? hero.interests.filter((r: any) => r && typeof r.name === 'string')
            : targetCreator.interests;
        const rawSupportsSort = Array.isArray(scanData?.supportsSort)
          ? scanData.supportsSort
          : Array.isArray(hero?.supportsSort)
            ? hero.supportsSort
            : undefined;
        const nextSupportsSort = rawSupportsSort
          ? rawSupportsSort.filter((v: any) => typeof v === 'string' && v.trim())
          : targetCreator.supportsSort;
        const nextActiveSort = options?.sort
          || (typeof scanData?.activeSort === 'string' && scanData.activeSort.trim() ? scanData.activeSort.trim() : undefined)
          || (typeof hero?.activeSort === 'string' && hero.activeSort.trim() ? hero.activeSort.trim() : undefined)
          || targetCreator.activeSort;
        const rawRelated = Array.isArray(scanData?.relatedEntities)
          ? scanData.relatedEntities
          : Array.isArray(hero?.relatedEntities)
            ? hero.relatedEntities
            : undefined;
        const nextRelated = rawRelated
          ? rawRelated.filter((r: any) => r && typeof r.name === 'string')
          : targetCreator.relatedEntities;

        const refreshedCreator: TimelineCreator = {
          ...targetCreator,
          name: nextName,
          avatar: nextAvatar,
          banner: nextBanner,
          handle: nextHandle || targetCreator.handle,
          site: nextSite,
          entityKind: nextEntityKind,
          verified: nextVerified,
          stats: nextStats,
          bio: nextBio,
          relatedEntities: nextRelated,
          portalInfo: nextPortalInfo,
          featuredPerformers: nextPerformers,
          affiliatedChannels: nextAffiliated,
          interests: nextInterests,
          supportsSort: nextSupportsSort,
          activeSort: nextActiveSort,
          profilePage: typeof scanData?.page === 'number' ? scanData.page : targetCreator.profilePage,
          profileHasMore: typeof scanData?.hasMore === 'boolean' ? scanData.hasMore : targetCreator.profileHasMore,
          profileNextPage: typeof scanData?.nextPage === 'number' || scanData?.nextPage === null ? scanData.nextPage : targetCreator.profileNextPage,
        };

        const mergedCreatorPosts = mapScanResponseToTimelinePosts(
          refreshedCreator,
          scanData,
          s.posts,
          timelineIdentityHints
        );

        const scannedPlaylists = extractPlaylistsFromScan(refreshedCreator, scanData);
        const updatedPlaylists: TimelinePlaylist[] =
          scannedPlaylists.length > 0 ? scannedPlaylists : (targetCreator.playlists || []);

        const updatedCreators = s.creators.map((c) =>
          c.id === creatorId
            ? {
                ...c,
                name: refreshedCreator.name,
                avatar: refreshedCreator.avatar,
                banner: refreshedCreator.banner,
                handle: refreshedCreator.handle,
                site: refreshedCreator.site,
                entityKind: refreshedCreator.entityKind,
                verified: refreshedCreator.verified,
                bio: refreshedCreator.bio,
                playlists: updatedPlaylists,
                relatedEntities: refreshedCreator.relatedEntities,
                portalInfo: refreshedCreator.portalInfo,
                featuredPerformers: refreshedCreator.featuredPerformers,
                affiliatedChannels: refreshedCreator.affiliatedChannels,
                interests: refreshedCreator.interests,
                supportsSort: refreshedCreator.supportsSort,
                activeSort: refreshedCreator.activeSort,
                // Loaded tabs count their own items. Partial discovery cannot
                // replace source-reported totals or turn an unknown into zero.
                stats: mergeTimelineCreatorStats(c.stats, hero?.stats, hero?.bio_details),
              }
            : c
        );

        const currentPostsWithCleanHandle = s.posts.map((post) => {
          if (post.creatorId !== creatorId) return post;
          const postNeedsHandleRepair = !sanitizeCreatorHandle(post.creatorHandle) || (refreshedCreator.handle && post.creatorHandle !== refreshedCreator.handle);
          const postNeedsMetaRepair = (refreshedCreator.name && post.creatorName !== refreshedCreator.name)
            || (refreshedCreator.avatar && post.creatorAvatar !== refreshedCreator.avatar);
          if (!postNeedsHandleRepair && !postNeedsMetaRepair) return post;
          return {
            ...post,
            creatorName: refreshedCreator.name || post.creatorName,
            creatorHandle: refreshedCreator.handle || post.creatorHandle,
            creatorAvatar: refreshedCreator.avatar || post.creatorAvatar,
          };
        });

        return {
          creators: updatedCreators,
          creatorProfiles:{...s.creatorProfiles,[creatorId]:{...refreshedCreator,playlists:updatedPlaylists}},
          // Only insert newly discovered identities. Keep all concurrent posts,
          // player references and local interaction IDs intact.
          posts: mergeRefreshedTimelinePosts(currentPostsWithCleanHandle, mergedCreatorPosts),
        };
      });
    };

    try {
      const knownDates = get().posts.filter(post => post.creatorId === creatorId && hasKnownExactPublicationDate(post))
        .map(post => post.originalUrl!);
      const knownMedia = [...new Set([...get().posts,...timelineIdentityHints].filter(post => post.creatorId === creatorId && post.type !== 'video')
        .flatMap(post => [post.originalUrl,post.albumUrl]).filter((url): url is string => Boolean(url)))];
      const finalScan = await discoverRecentProfileRoot(
        creator.profileUrl,
        signal,
        creator.name,
        knownDates,
        knownMedia,
        streamFull ? (snapshot) => applyScanResult(snapshot) : undefined,
        undefined,
        options?.sort,
      );
      applyScanResult(finalScan);
      if (!signal?.aborted) {
        const latestCreator = get().creatorProfiles[creatorId] || get().creators.find((c) => c.id === creatorId);
        if (latestCreator?.profileUrl) {
          useProfileDirectoryLibraryStore.getState().updateFavoriteMetadata?.({
            kind: 'profile',
            url: latestCreator.profileUrl,
            name: latestCreator.name,
            imageUrl: latestCreator.avatar || null,
            bannerUrl: latestCreator.banner,
            entityKind: latestCreator.entityKind,
            source: latestCreator.site,
            verified: latestCreator.verified,
            portalInfo: latestCreator.portalInfo,
          });
        }
      }
      if (signal?.aborted) {
        set(s => ({isDiscoveringCreator:{...s.isDiscoveringCreator,[creatorId]:false}}));
        return;
      }
      set((s) => {
        if (!(s.creators.find(c=>c.id===creatorId) || s.creatorProfiles[creatorId]) || (s.creators.find(c=>c.id===creatorId) || s.creatorProfiles[creatorId]).profileUrl!==creator.profileUrl) {
          return {isDiscoveringCreator:{...s.isDiscoveringCreator,[creatorId]:false}};
        }
        return {
        creatorRefreshErrors: { ...s.creatorRefreshErrors, [creatorId]: Boolean(finalScan.discovery_errors?.length) },
        creatorRefreshedAt: (s.creators.find(c=>c.id===creatorId) || s.creatorProfiles[creatorId])?.profileUrl === creator.profileUrl
          && !finalScan.discovery_errors?.length
          ? { ...s.creatorRefreshedAt, [creatorId]: Date.now() } : s.creatorRefreshedAt,
        isDiscoveringCreator: { ...s.isDiscoveringCreator, [creatorId]: false },
        discoveredCreatorIds: { ...s.discoveredCreatorIds, [creatorId]: true },
      };
      });
      if (!signal?.aborted && (get().creators.find(c=>c.id===creatorId) || get().creatorProfiles[creatorId])?.profileUrl===creator.profileUrl) {
        const current = get();
        void writeTimelineCatalog(catalogSnapshot({...current,creators:Object.values(current.creatorProfiles)},timelineIdentityHints,current.creatorRefreshedAt));
      }
    } catch {
      set((s) => ({
        creatorRefreshErrors: { ...s.creatorRefreshErrors, [creatorId]: !signal?.aborted },
        isDiscoveringCreator: { ...s.isDiscoveringCreator, [creatorId]: false },
      }));
    } finally {
      parentSignal?.removeEventListener('abort', abort);
      if (creatorCatalogControllers.get(creatorId) === controller) creatorCatalogControllers.delete(creatorId);
    }
  },

  suspendRequests: () => {
    for (const controller of creatorCatalogControllers.values()) controller.abort();
    for (const controller of browseControllers.values()) controller.abort();
    for (const controller of browseLoadMoreControllers.values()) controller.abort();
    threadViewController?.abort();
    profileLoadMoreController?.abort();
    lightboxAlbumController?.abort();
    lightboxAlbumController = undefined;
    lightboxRequestVersion++;
    set(state => state.lightbox.isLoadingAlbum ? {lightbox:{...state.lightbox,isLoadingAlbum:false}} : state);
  },

  refreshMissingCreators: async (creatorIds: string[], signal?: AbortSignal) => {
    if (signal?.aborted || creatorIds.length === 0) return;
    await get().loadTimelineData();
    const targetSet = new Set(creatorIds);
    const creators = prioritizeCreatorsForDiscovery(get().creators.filter(creator => targetSet.has(creator.id)));
    for (const creator of creators) {
      if (signal?.aborted) return;
      if (get().creators.some(current => current.id === creator.id && current.profileUrl === creator.url)) {
        await get().discoverCreatorCatalog(creator.id, signal);
      }
    }
  },

  refreshTimeline: async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    await get().loadTimelineData();
    // Prioritize social/YouTube creators first so YouTube/Instagram tabs are populated immediately.
    const creators = prioritizeCreatorsForDiscovery(get().creators);
    for (const creator of creators) {
      if (signal?.aborted) return;
      if (get().creators.some(current => current.id === creator.id && current.profileUrl === creator.url)) {
        await get().discoverCreatorCatalog(creator.id, signal);
      }
    }
  },

  toggleLike: (postId, postSnapshot, creatorSnapshot) => {
    const state = get();
    const nextValue = !state.likedPostIds[postId];
    const nextLiked = { ...state.likedPostIds, [postId]: nextValue };
    if (!nextValue) delete nextLiked[postId];
    persistInteractions({
      liked: nextLiked,
      saved: state.savedPostIds,
      favorited: state.favoritedPostIds,
      followed: state.followedCreatorIds,
      userComments: state.userComments,
    });
    set({ likedPostIds: nextLiked });

    const matchedPost = postSnapshot || state.posts.find((p) => p.id === postId);
    const matchedCreator =
      creatorSnapshot ||
      (matchedPost
        ? state.creatorProfiles[matchedPost.creatorId] ||
          state.creators.find((c) => c.id === matchedPost.creatorId)
        : undefined);
    const libItem = matchedPost
      ? normalizeTimelinePostToLibraryItem(matchedPost, matchedCreator)
      : { id: postId, kind: 'video' as const, title: '' };
    if (libItem) {
      void useProfileHubLibraryStore.getState().setLikedItem(libItem, nextValue);
    }
  },

  toggleSave: (postId) => {
    set((state) => {
      const nextSaved = { ...state.savedPostIds, [postId]: !state.savedPostIds[postId] };
      persistInteractions({
        liked: state.likedPostIds,
        saved: nextSaved,
        favorited: state.favoritedPostIds,
        followed: state.followedCreatorIds,
        userComments: state.userComments,
      });
      return { savedPostIds: nextSaved };
    });
  },

  toggleFavorite: (postId, postSnapshot, creatorSnapshot) => {
    const state = get();
    const nextValue = !state.favoritedPostIds[postId];
    const nextFav = { ...state.favoritedPostIds, [postId]: nextValue };
    if (!nextValue) delete nextFav[postId];
    persistInteractions({
      liked: state.likedPostIds,
      saved: state.savedPostIds,
      favorited: nextFav,
      followed: state.followedCreatorIds,
      userComments: state.userComments,
    });
    set({ favoritedPostIds: nextFav });

    const matchedPost = postSnapshot || state.posts.find((p) => p.id === postId);
    const matchedCreator =
      creatorSnapshot ||
      (matchedPost
        ? state.creatorProfiles[matchedPost.creatorId] ||
          state.creators.find((c) => c.id === matchedPost.creatorId)
        : undefined);
    const libItem = matchedPost
      ? normalizeTimelinePostToLibraryItem(matchedPost, matchedCreator)
      : { id: postId, kind: 'video' as const, title: '' };
    if (libItem) {
      void useProfileHubLibraryStore.getState().setFavoriteItem(libItem, nextValue);
    }
  },

  toggleFollowCreator: (input) => {
    const creator=typeof input==='string' ? get().creators.find(item=>item.id===input) || get().creatorProfiles[input] : input;
    if(!creator || !engagementSourceUrl(creator.profileUrl)) return false;
    subscribeToSavedCreators();
    const state = get();
    const currentlyFollowed = Boolean(
      state.followedCreatorIds[creator.id] ||
      state.creators.some(c => c.id === creator.id || c.profileUrl?.toLowerCase() === creator.profileUrl.toLowerCase())
    );
    const nextFollowed = { ...state.followedCreatorIds };
    if (currentlyFollowed) {
      delete nextFollowed[creator.id];
    } else {
      nextFollowed[creator.id] = true;
    }
    persistInteractions({
      liked: state.likedPostIds,
      saved: state.savedPostIds,
      favorited: state.favoritedPostIds,
      followed: nextFollowed,
      userComments: state.userComments,
    });
    set(s=>({
      followedCreatorIds: nextFollowed,
      creatorProfiles:{...s.creatorProfiles,[creator.id]:creator},
    }));
    const accepted=useProfileDirectoryLibraryStore.getState().toggleFavorite({kind:'profile',url:creator.profileUrl,name:creator.name || null,imageUrl:creator.avatar || null});
    if(accepted && timelineHasBootstrapped) {
      const current=get();
      void writeTimelineCatalog(catalogSnapshot({...current,creators:Object.values(current.creatorProfiles)},timelineIdentityHints,current.creatorRefreshedAt));
    }
    return true;
  },

  openComments: (postId) => set({ activeCommentsPostId: postId }),

  closeComments: () => set({ activeCommentsPostId: null }),

  addComment: (postId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const isEn = useAppStore.getState().settings?.language === 'en-US';

    const newComment: TimelineComment = {
      author: isEn ? 'You' : 'Você',
      handle: isEn ? '@user' : '@usuario',
      avatar: '',
      time: isEn ? 'just now' : 'agora',
      likes: '0',
      text: trimmed,
      isAuthor: true,
    };

    set((state) => {
      const postComments = state.userComments[postId] || [];
      const nextComments = {
        ...state.userComments,
        [postId]: [newComment, ...postComments],
      };
      persistInteractions({
        liked: state.likedPostIds,
        saved: state.savedPostIds,
        favorited: state.favoritedPostIds,
        followed: state.followedCreatorIds,
        userComments: nextComments,
      });
      return { userComments: nextComments };
    });
  },

  openLightbox: (images, index = 0, title = '', albumUrl, items, expectedPhotoCount) => {
    lightboxAlbumController?.abort();
    lightboxAlbumController = undefined;
    const requestVersion = ++lightboxRequestVersion;
    const ownsLightbox = () => requestVersion === lightboxRequestVersion;
    const cachedEntry = albumUrl ? albumPhotosMemoryCache.get(albumUrl) : undefined;
    const cachedItems = cachedEntry?.items;
    let baseItems = items;
    let baseImages = images;

    if (cachedItems && cachedItems.length > (items?.length || 0)) {
      baseItems = cachedItems;
      baseImages = cachedItems.map((it) => it.url);
    }

    const cleanImages = (baseImages || []).map((u) => upgradePhotoUrlFast(u)).filter(Boolean);
    const initialItems: TimelinePhotoItem[] =
      baseItems && baseItems.length === cleanImages.length
        ? baseItems.map((it, idx) => ({ ...it, url: cleanImages[idx] || it.url }))
        : cleanImages.map((u) => ({
            url: u,
            thumbnailUrl: u,
            sourcePage: albumUrl,
          }));

    const matchingPost = get().posts.find(
      (p) => (albumUrl && (p.albumUrl === albumUrl || p.originalUrl === albumUrl)) || (!albumUrl && title && p.title === title)
    );
    let creatorAlbumCount = 0;
    for (const c of get().creators) {
      const a = (c as any).albums?.find(
        (alb: any) =>
          (albumUrl && (alb.url === albumUrl || alb.source_url === albumUrl || alb.albumUrl === albumUrl)) ||
          (!albumUrl && title && alb.title === title)
      );
      if (a && typeof a.photoCount === 'number') {
        creatorAlbumCount = a.photoCount;
        break;
      }
    }
    const expectedCount = expectedPhotoCount || matchingPost?.photoCount || creatorAlbumCount || 0;
    const hasCachedFullAlbum = Boolean(
      cachedEntry && (cachedEntry.complete || cachedEntry.items.length >= Math.max(expectedCount, 5))
    );

    const hasEnoughLocalPhotos =
      cleanImages.length > 4 &&
      (expectedCount <= 0 || cleanImages.length >= expectedCount) &&
      !(cleanImages.length >= 2 && cleanImages[0] === cleanImages[1]);

    if (hasEnoughLocalPhotos && albumUrl && !albumPhotosMemoryCache.has(albumUrl)) {
      setAlbumPhotosMemoryCache(albumUrl, {
        items: initialItems,
        page: 1,
        totalPages: 1,
        hasMore: false,
        nextPageUrl: null,
        complete: true,
      });
    }

    const needsRemoteAlbumFetch = Boolean(
      albumUrl &&
        albumUrl.startsWith('http') &&
        !hasCachedFullAlbum &&
        !hasEnoughLocalPhotos &&
        (!cachedItems ||
          cleanImages.length <= 4 ||
          (expectedCount > 0 && cleanImages.length < expectedCount) ||
          (cleanImages.length >= 2 && cleanImages[0] === cleanImages[1]))
    );

    set({
      lightbox: {
        isOpen: true,
        images: cleanImages,
        items: initialItems,
        currentIndex: Math.max(0, Math.min(index, Math.max(0, cleanImages.length - 1))),
        title,
        albumUrl,
        isLoadingAlbum: needsRemoteAlbumFetch,
        albumPage: cachedEntry?.page ?? 1,
        albumTotalPages: cachedEntry?.totalPages ?? 1,
        albumHasMore: cachedEntry?.hasMore ?? false,
        albumNextPageUrl: cachedEntry?.nextPageUrl ?? null,
        isLoadingMoreAlbumPages: false,
      },
    });

    if (needsRemoteAlbumFetch && albumUrl) {
      const controller = new AbortController();
      lightboxAlbumController = controller;
      void fetchAlbumPhotos(albumUrl, controller.signal, 1)
        .then((res) => {
          if (controller.signal.aborted) return;
          if (!res.photos || res.photos.length === 0) {
            if (!ownsLightbox()) return;
            set((s) => ({
              lightbox: { ...s.lightbox, isLoadingAlbum: false },
            }));
            return;
          }

          const fetchedItems: TimelinePhotoItem[] = res.photos.map((p) => {
            const rawUrl = p.originalUrl || p.thumbnailUrl;
            const upUrl = upgradePhotoUrlFast(rawUrl);
            return {
              id: p.id,
              url: upUrl,
              thumbnailUrl: p.thumbnailUrl || rawUrl,
              pageUrl: p.pageUrl,
              sourcePage: p.sourcePage || albumUrl,
              width: p.width,
              height: p.height,
              fileSizeBytes: p.fileSizeBytes,
              format: p.format,
              isResolvedOriginal: p.isResolvedOriginal,
              isAnimated: p.type === 'gif' || (p as any).isAnimated,
            };
          });
          const fetchedUrls = fetchedItems.map((it) => it.url);
          const pageNum = res.page ?? 1;
          const totalPgs = res.totalPages ?? 1;
          const hasMore = Boolean(res.hasMore);
          const nextPageUrl = res.nextPageUrl ?? null;

          setAlbumPhotosMemoryCache(albumUrl, {
            items: fetchedItems,
            page: pageNum,
            totalPages: totalPgs,
            hasMore,
            nextPageUrl,
            complete: res.metadata.paginationComplete === true && !hasMore,
          });

          set((s) => {
            const updatedPosts = s.posts.map((post) =>
              post.albumUrl === albumUrl || post.originalUrl === albumUrl
                ? {
                    ...post,
                    photos: fetchedUrls,
                    photoItems: fetchedItems,
                    photoCount: res.metadata.photoCount ?? post.photoCount,
                  }
                : post
            );

            const updatedCreators = s.creators.map((c) => {
              const cAlbums = (c as any).albums;
              if (!cAlbums || !Array.isArray(cAlbums)) return c;
              const hasMatching = cAlbums.some(
                (alb: any) =>
                  alb.url === albumUrl ||
                  alb.source_url === albumUrl ||
                  alb.albumUrl === albumUrl
              );
              if (!hasMatching) return c;
              return {
                ...c,
                albums: cAlbums.map((alb: any) =>
                  alb.url === albumUrl ||
                  alb.source_url === albumUrl ||
                  alb.albumUrl === albumUrl
                    ? {
                        ...alb,
                        photos: fetchedUrls,
                        photoItems: fetchedItems,
                        photoCount: res.metadata.photoCount ?? alb.photoCount,
                      }
                    : alb
                ),
              };
            });

            if (!ownsLightbox() || !s.lightbox.isOpen || s.lightbox.albumUrl !== albumUrl) {
              return {
                posts: updatedPosts,
                creators: updatedCreators,
              };
            }

            return {
              posts: updatedPosts,
              creators: updatedCreators,
              lightbox: {
                ...s.lightbox,
                images: fetchedUrls,
                items: fetchedItems,
                currentIndex: Math.min(s.lightbox.currentIndex, Math.max(0, fetchedUrls.length - 1)),
                isLoadingAlbum: false,
                albumPage: pageNum,
                albumTotalPages: totalPgs,
                albumHasMore: hasMore,
                albumNextPageUrl: nextPageUrl,
                isLoadingMoreAlbumPages: false,
              },
            };
          });
        })
        .catch(() => {
          if (!ownsLightbox()) return;
          set((s) => ({
            lightbox: { ...s.lightbox, isLoadingAlbum: false },
          }));
        })
        .finally(() => {
          if (lightboxAlbumController === controller) lightboxAlbumController = undefined;
        });
    }
  },

  loadNextAlbumPage: async () => {
    const lb = get().lightbox;
    const albumUrl = lb.albumUrl;
    if (!lb.isOpen || !albumUrl || !lb.albumHasMore || lb.isLoadingMoreAlbumPages || lb.isLoadingAlbum) {
      return;
    }
    const nextPage = (lb.albumPage || 1) + 1;
    const nextPageUrl = lb.albumNextPageUrl || null;
    set((s) => ({
      lightbox: { ...s.lightbox, isLoadingMoreAlbumPages: true },
    }));
    try {
      const res = await fetchAlbumPhotos(albumUrl, undefined, nextPage, { pageUrl: nextPageUrl });
      const incomingItems: TimelinePhotoItem[] = (res.photos || []).map((p) => {
        const rawUrl = p.originalUrl || p.thumbnailUrl;
        const upUrl = upgradePhotoUrlFast(rawUrl);
        return {
          id: p.id,
          url: upUrl,
          thumbnailUrl: p.thumbnailUrl || rawUrl,
          pageUrl: p.pageUrl,
          sourcePage: p.sourcePage || albumUrl,
          width: p.width,
          height: p.height,
          fileSizeBytes: p.fileSizeBytes,
          format: p.format,
          isResolvedOriginal: p.isResolvedOriginal,
          isAnimated: p.type === 'gif' || (p as any).isAnimated,
        };
      });
      set((s) => {
        if (!s.lightbox.isOpen || s.lightbox.albumUrl !== albumUrl) return s;
        const currentItems = s.lightbox.items || [];
        const seenKeys = new Set(
          currentItems.map((it) => it.id || it.pageUrl || it.thumbnailUrl || it.url)
        );
        const appendedItems = [...currentItems];
        for (const item of incomingItems) {
          const key = item.id || item.pageUrl || item.thumbnailUrl || item.url;
          if (key && !seenKeys.has(key)) {
            seenKeys.add(key);
            appendedItems.push(item);
          }
        }
        const appendedUrls = appendedItems.map((it) => it.url);
        const resolvedPage = res.page ?? nextPage;
        const resolvedTotal = Math.max(res.totalPages ?? s.lightbox.albumTotalPages ?? resolvedPage, resolvedPage);
        const hasMore = Boolean(res.hasMore);
        const updatedNextUrl = res.nextPageUrl ?? null;

        setAlbumPhotosMemoryCache(albumUrl, {
          items: appendedItems,
          page: resolvedPage,
          totalPages: resolvedTotal,
          hasMore,
          nextPageUrl: updatedNextUrl,
          complete: !hasMore,
        });

        return {
          lightbox: {
            ...s.lightbox,
            images: appendedUrls,
            items: appendedItems,
            albumPage: resolvedPage,
            albumTotalPages: resolvedTotal,
            albumHasMore: hasMore,
            albumNextPageUrl: updatedNextUrl,
            isLoadingMoreAlbumPages: false,
          },
        };
      });
    } catch {
      set((s) => ({
        lightbox: { ...s.lightbox, isLoadingMoreAlbumPages: false },
      }));
    }
  },

  hydrateBrowseCapabilities: async (force = false) => {
    if (!force && Object.keys(get().browseCapabilities).length > 0) return;
    try {
      const caps = await fetchBrowseSources();
      const map: Record<string, TimelineBrowseSourceCapability> = {};
      for (const c of caps) {
        if (c?.source_id) map[c.source_id] = c;
      }
      set({ browseCapabilities: map });
    } catch {
      // Ignore offline error; capabilities remain lazy
    }
  },

  loadIntegratedSources: async () => {
    set({ integratedSourcesStatus: 'loading' });
    try {
      const res = await fetchIntegratedSourcesApi();
      set({
        integratedSources: Array.isArray(res.sources) ? res.sources : [],
        integratedSourcesStatus: 'loaded',
      });
    } catch {
      set({ integratedSourcesStatus: 'unavailable' });
    }
  },

  integrateSourceUrl: async (rawUrl) => {
    set({ isIntegratingSource: true });
    try {
      const data = await integrateTimelineUrlApi(rawUrl);
      const sources: IntegratedSourceRecord[] = Array.isArray(data?.sources) ? data.sources : get().integratedSources;
      const result: IntegrateUrlResult = {
        ok: Boolean(data?.ok),
        matched: Boolean(data?.matched),
        supported: Boolean(data?.supported),
        reason: typeof data?.reason === 'string' ? data.reason : undefined,
        host: typeof data?.host === 'string' ? data.host : undefined,
        integration: data?.integration,
        sources,
        targetProfileUrl:
          data?.ok && data?.integration?.level === 'profile'
            ? String(data.integration.targetUrl || rawUrl)
            : null,
      };
      set({
        integratedSources: sources,
        integratedSourcesStatus: 'loaded',
        isIntegratingSource: false,
        lastIntegrationResult: result,
      });
      if (result.ok) {
        await get().hydrateBrowseCapabilities(true);
      }
      return result;
    } catch {
      const failResult: IntegrateUrlResult = {
        ok: false,
        matched: false,
        supported: false,
        reason: 'network_error',
        sources: get().integratedSources,
      };
      set({
        isIntegratingSource: false,
        lastIntegrationResult: failResult,
      });
      return failResult;
    }
  },

  removeIntegratedSource: async (sourceId) => {
    try {
      const data = await removeIntegratedSourceApi(sourceId);
      const sources: IntegratedSourceRecord[] = Array.isArray(data?.sources) ? data.sources : [];
      const sid = String(sourceId || '').trim().toLowerCase();
      set((s) => {
        const nextFeeds = { ...s.browseFeedsBySource };
        delete nextFeeds[sid];
        return {
          integratedSources: sources,
          integratedSourcesStatus: 'loaded',
          browseFeedsBySource: nextFeeds,
          lastIntegrationResult: null,
        };
      });
      await get().hydrateBrowseCapabilities(true);
    } catch {
      // keep existing state on transient HTTP error
    }
  },

  resetIntegratedSources: async () => {
    try {
      await resetIntegratedSourcesApi();
      set({
        integratedSources: [],
        integratedSourcesStatus: 'loaded',
        browseFeedsBySource: {},
        dynamicSubfiltersBySource: {},
        browseCapabilities: {},
        lastIntegrationResult: null,
      });
    } catch {
      // ignore transient error
    }
  },

  clearLastIntegrationResult: () => set({ lastIntegrationResult: null }),

  loadBrowseFeed: async (source, category, subfilter = null, reset = false) => {
    const sid = String(source || '').trim().toLowerCase();
    if (!sid) return;
    const existing = get().browseFeedsBySource[sid];
    const targetCategory = category || existing?.category || get().browseCapabilities[sid]?.default_category || 'popular';
    const targetSubfilter = subfilter !== undefined ? subfilter : (existing?.subfilter ?? null);
    if (
      !reset &&
      existing &&
      existing.category === targetCategory &&
      existing.subfilter === targetSubfilter &&
      (existing.isLoading || (existing.items.length > 0 && !existing.error))
    ) {
      return;
    }

    browseControllers.get(sid)?.abort();
    browseLoadMoreControllers.get(sid)?.abort();
    const controller = new AbortController();
    browseControllers.set(sid, controller);

    set((s) => ({
      browseFeedsBySource: {
        ...s.browseFeedsBySource,
        [sid]: {
          items: reset ? [] : (existing?.items || []),
          profiles: existing?.profiles || [],
          category: targetCategory,
          subfilter: targetSubfilter,
          cursor: null,
          hasMore: false,
          isLoading: true,
          isLoadingMore: false,
          error: null,
          resolvedOrigin: existing?.resolvedOrigin ?? null,
        },
      },
    }));

    try {
      const res = await fetchTimelineBrowsePage({
        source: sid,
        category: targetCategory,
        subfilter: targetSubfilter,
        cursor: null,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const incomingDynamicSubs = Array.isArray(res.dynamicSubfilters) && res.dynamicSubfilters.length > 0
        ? res.dynamicSubfilters
        : undefined;
      set((s) => ({
        dynamicSubfiltersBySource: incomingDynamicSubs
          ? { ...s.dynamicSubfiltersBySource, [sid]: incomingDynamicSubs }
          : s.dynamicSubfiltersBySource,
        browseFeedsBySource: {
          ...s.browseFeedsBySource,
          [sid]: {
            items: res.items,
            profiles: res.profiles,
            dynamicSubfilters: incomingDynamicSubs || s.dynamicSubfiltersBySource[sid] || existing?.dynamicSubfilters,
            category: res.category,
            subfilter: res.subfilter ?? null,
            cursor: res.nextCursor,
            hasMore: res.hasMore,
            isLoading: false,
            isLoadingMore: false,
            error: res.error ?? null,
            resolvedOrigin: res.resolvedOrigin ?? null,
          },
        },
      }));
    } catch (err: any) {
      if (controller.signal.aborted) return;
      set((s) => ({
        browseFeedsBySource: {
          ...s.browseFeedsBySource,
          [sid]: {
            ...(s.browseFeedsBySource[sid] || {
              items: [],
              profiles: [],
              category: targetCategory,
              subfilter: targetSubfilter,
              cursor: null,
              hasMore: false,
            }),
            isLoading: false,
            isLoadingMore: false,
            error: err?.message || 'Failed to load browse feed',
          },
        },
      }));
    }
  },

  loadMoreBrowseFeed: async (source) => {
    const sid = String(source || '').trim().toLowerCase();
    const slice = get().browseFeedsBySource[sid];
    if (!slice || slice.isLoading || slice.isLoadingMore || !slice.hasMore || !slice.cursor) {
      return;
    }
    browseLoadMoreControllers.get(sid)?.abort();
    const controller = new AbortController();
    browseLoadMoreControllers.set(sid, controller);
    const expectedCategory = slice.category;
    const expectedSubfilter = slice.subfilter;
    const expectedCursor = slice.cursor;
    set((s) => ({
      browseFeedsBySource: {
        ...s.browseFeedsBySource,
        [sid]: { ...slice, isLoadingMore: true, error: null },
      },
    }));
    try {
      const res = await fetchTimelineBrowsePage({
        source: sid,
        category: expectedCategory,
        subfilter: expectedSubfilter,
        cursor: expectedCursor,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      set((s) => {
        const cur = s.browseFeedsBySource[sid];
        if (
          !cur
          || cur.category !== expectedCategory
          || cur.subfilter !== expectedSubfilter
          || cur.cursor !== expectedCursor
        ) {
          return s;
        }
        const seen = new Set(cur.items.map((it) => it.originalUrl || it.albumUrl || it.id));
        const merged = [...cur.items];
        for (const item of res.items) {
          const k = item.originalUrl || item.albumUrl || item.id;
          if (!seen.has(k)) {
            seen.add(k);
            merged.push(item);
          }
        }
        return {
          browseFeedsBySource: {
            ...s.browseFeedsBySource,
            [sid]: {
              ...cur,
              items: merged,
              cursor: res.nextCursor,
              hasMore: res.hasMore,
              isLoadingMore: false,
              error: res.error ?? null,
            },
          },
        };
      });
    } catch (err: any) {
      if (controller.signal.aborted) return;
      set((s) => {
        const cur = s.browseFeedsBySource[sid];
        if (
          !cur
          || cur.category !== expectedCategory
          || cur.subfilter !== expectedSubfilter
          || cur.cursor !== expectedCursor
        ) {
          return s;
        }
        return {
          browseFeedsBySource: {
            ...s.browseFeedsBySource,
            [sid]: { ...cur, isLoadingMore: false, error: err?.message || 'Load more failed' },
          },
        };
      });
    }
  },

  updateLightboxItemResolution: (index, resolved) => {
    set((state) => {
      if (!state.lightbox.isOpen || index < 0 || index >= state.lightbox.images.length) {
        return state;
      }
      const nextImages = [...state.lightbox.images];
      nextImages[index] = resolved.url;

      const nextItems = state.lightbox.items ? [...state.lightbox.items] : [];
      if (nextItems[index]) {
        nextItems[index] = {
          ...nextItems[index],
          url: resolved.url,
          width: resolved.width || nextItems[index].width,
          height: resolved.height || nextItems[index].height,
          fileSizeBytes: resolved.fileSizeBytes || nextItems[index].fileSizeBytes,
          format: resolved.format || nextItems[index].format,
          isResolvedOriginal: true,
          requiresProxy: resolved.requiresProxy ?? nextItems[index].requiresProxy,
        };
      }

      return {
        lightbox: {
          ...state.lightbox,
          images: nextImages,
          items: nextItems,
        },
      };
    });
  },

  closeLightbox: () => {
    lightboxAlbumController?.abort();
    lightboxAlbumController = undefined;
    lightboxRequestVersion++;
    set((state) => ({
      lightbox: { ...state.lightbox, isOpen: false, isLoadingAlbum: false },
    }));
  },

  nextLightboxImage: () => {
    set((state) => {
      const { images, currentIndex } = state.lightbox;
      if (images.length === 0) return state;
      const nextIdx = (currentIndex + 1) % images.length;
      return { lightbox: { ...state.lightbox, currentIndex: nextIdx } };
    });
  },

  prevLightboxImage: () => {
    set((state) => {
      const { images, currentIndex } = state.lightbox;
      if (images.length === 0) return state;
      const prevIdx = (currentIndex - 1 + images.length) % images.length;
      return { lightbox: { ...state.lightbox, currentIndex: prevIdx } };
    });
  },

  updatePostStream: (postId, updated) => {
    // An unsuccessful renewal must not erase usable cached stream fields.
    const defined = Object.fromEntries(Object.entries(updated).filter(([, value]) => value !== undefined));
    set((state) => ({
      posts: state.posts.map((p) =>
        p.id === postId ? { ...p, ...defined } : p
      ),
    }));
  },

  loadDirectory: async (source, kind, page = 1, append = false) => {
    const sid = String(source || '').trim().toLowerCase();
    const k = String(kind || 'categories').trim().toLowerCase();
    if (!sid) return;
    const baseKey = `${sid}:${k}:1`;
    const key = append || page > 1 ? baseKey : `${sid}:${k}:${page}`;
    const existing = get().directoriesByKey[key];
    if (existing && (existing.isLoading || (!append && page === 1 && existing.items.length > 0 && !existing.error))) {
      return;
    }
    set((s) => ({
      directoriesByKey: {
        ...s.directoriesByKey,
        [key]: {
          items: existing?.items || [],
          page: existing?.page || page,
          hasMore: existing?.hasMore ?? false,
          nextPage: existing?.nextPage ?? null,
          nextPageUrl: existing?.nextPageUrl ?? null,
          isLoading: true,
          error: null,
        },
      },
    }));
    try {
      const res = await fetchTimelineDirectory({
        source: sid, kind: k, page, pageUrl: append ? existing?.nextPageUrl : null,
      });
      if (res.error) throw new Error(res.error);
      set((s) => {
        const prevItems = append && s.directoriesByKey[key]?.items ? s.directoriesByKey[key].items : [];
        const seen = new Set(prevItems.map((it) => it.url || it.id));
        const merged = [...prevItems];
        for (const it of res.items) {
          const uk = it.url || it.id;
          if (!seen.has(uk)) {
            seen.add(uk);
            merged.push(it);
          }
        }
        return {
          directoriesByKey: {
            ...s.directoriesByKey,
            [key]: {
              items: append ? merged : res.items,
              page: res.page,
              hasMore: Boolean(res.hasMore),
              nextPage: res.nextPage ?? (res.hasMore ? res.page + 1 : null),
              nextPageUrl: res.nextPageUrl,
              isLoading: false,
              error: res.error ?? null,
            },
          },
        };
      });
    } catch (err: any) {
      set((s) => ({
        directoriesByKey: {
          ...s.directoriesByKey,
          [key]: {
            items: existing?.items || [],
            page: existing?.page || page,
            hasMore: existing?.hasMore ?? false,
            nextPage: existing?.nextPage ?? null,
            nextPageUrl: existing?.nextPageUrl ?? null,
            isLoading: false,
            error: err?.message || 'Failed to load directory',
          },
        },
      }));
    }
  },

  queueCatalogEnrichment: async (items) => {
    const pending = items
      .filter((it) => it?.url && it?.source)
      .filter((it) => !enrichedCatalogUrls.has(it.url) && !enrichingCatalogUrls.has(it.url))
      .slice(0, 8);
    if (pending.length === 0) return;
    for (const it of pending) enrichingCatalogUrls.add(it.url);
    try {
      const metadata = await enrichCatalogBatch(pending);
      for (const it of pending) {
        if (metadata && metadata[it.url]) {
          rememberEnrichedUrl(it.url);
        }
      }
      if (!metadata || Object.keys(metadata).length === 0) return;

      const patchPost = (post: TimelinePost): TimelinePost => {
        const key = post.originalUrl || post.albumUrl || '';
        const meta = (key && metadata[key]) || (post.albumUrl && metadata[post.albumUrl]) || undefined;
        return applyCatalogEnrichmentToPost(post, meta);
      };

      set((s) => {
        const nextFeeds: Record<string, TimelineBrowseFeedSlice> = { ...s.browseFeedsBySource };
        for (const [sid, slice] of Object.entries(nextFeeds)) {
          nextFeeds[sid] = {
            ...slice,
            items: slice.items.map(patchPost),
          };
        }
        return {
          enrichedCatalogByUrl: { ...s.enrichedCatalogByUrl, ...metadata },
          browseFeedsBySource: nextFeeds,
          posts: s.posts.map(patchPost),
        };
      });
      if (timelineHasBootstrapped) {
        const current = get();
        void writeTimelineCatalog(
          catalogSnapshot(
            { ...current, creators: Object.values(current.creatorProfiles) },
            timelineIdentityHints,
            current.creatorRefreshedAt
          )
        );
      }
    } catch {
      // Ignore silent background enrichment failure
    } finally {
      for (const it of pending) enrichingCatalogUrls.delete(it.url);
    }
  },

  loadForumBoards: async (source) => {
    const sid = String(source || '').trim().toLowerCase();
    if (!sid) return;
    const existing = get().forumBoardsBySource[sid];
    if (existing && !existing.isLoading && existing.sections.length > 0 && !existing.error) {
      return;
    }
    set((s) => ({
      forumBoardsBySource: {
        ...s.forumBoardsBySource,
        [sid]: { sections: existing?.sections || [], isLoading: true, error: null },
      },
    }));
    try {
      const res = await fetchForumBoards(sid);
      set((s) => ({
        forumBoardsBySource: {
          ...s.forumBoardsBySource,
          [sid]: { sections: res.sections, isLoading: false, error: res.error ?? null },
        },
      }));
    } catch (err: any) {
      set((s) => ({
        forumBoardsBySource: {
          ...s.forumBoardsBySource,
          [sid]: {
            sections: existing?.sections || [],
            isLoading: false,
            error: err?.message || 'Failed to load forum boards',
          },
        },
      }));
    }
  },

  openThreadView: async (postOrUrl, title, source) => {
    const threadUrl = typeof postOrUrl === 'string'
      ? postOrUrl.trim()
      : String(postOrUrl.originalUrl || postOrUrl.albumUrl || '').trim();
    if (!threadUrl) return;
    const resolvedTitle = title || (typeof postOrUrl === 'string' ? '' : postOrUrl.title) || 'Thread';
    const resolvedSource = source || (typeof postOrUrl === 'string' ? undefined : postOrUrl.source);
    threadViewController?.abort();
    const controller = new AbortController();
    threadViewController = controller;
    set({
      activeThreadView: {
        threadUrl,
        title: resolvedTitle,
        source: resolvedSource,
        isLoading: true,
        data: null,
        error: null,
      },
    });
    try {
      const data = await fetchForumThreadPage({ url: threadUrl, page: 1, signal: controller.signal });
      if (controller.signal.aborted) return;
      set((s) => (
        s.activeThreadView?.threadUrl === threadUrl
          ? {
              activeThreadView: {
                ...s.activeThreadView,
                title: data.title || resolvedTitle,
                isLoading: false,
                data,
                error: data.error ?? null,
              },
            }
          : s
      ));
    } catch (err: any) {
      if (controller.signal.aborted) return;
      set((s) => (
        s.activeThreadView?.threadUrl === threadUrl
          ? {
              activeThreadView: {
                ...s.activeThreadView,
                isLoading: false,
                error: err?.message || 'Failed to load thread',
              },
            }
          : s
      ));
    }
  },

  loadThreadPage: async (pageOrUrl) => {
    const current = get().activeThreadView;
    if (!current || current.isLoading) return;
    threadViewController?.abort();
    const controller = new AbortController();
    threadViewController = controller;
    set((s) => (
      s.activeThreadView
        ? { activeThreadView: { ...s.activeThreadView, isLoading: true, error: null } }
        : s
    ));
    try {
      const data = await fetchForumThreadPage(
        typeof pageOrUrl === 'number'
          ? { url: current.threadUrl, page: pageOrUrl, signal: controller.signal }
          : { url: current.threadUrl, pageUrl: pageOrUrl, signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      set((s) => (
        s.activeThreadView?.threadUrl === current.threadUrl
          ? {
              activeThreadView: {
                ...s.activeThreadView,
                title: data.title || s.activeThreadView.title,
                isLoading: false,
                data,
                error: data.error ?? null,
              },
            }
          : s
      ));
    } catch (err: any) {
      if (controller.signal.aborted) return;
      set((s) => (
        s.activeThreadView
          ? { activeThreadView: { ...s.activeThreadView, isLoading: false, error: err?.message || 'Failed to load thread page' } }
          : s
      ));
    }
  },

  closeThreadView: () => {
    threadViewController?.abort();
    threadViewController = undefined;
    set({ activeThreadView: null });
  },

  loadMoreCreatorProfileAlbums: async (creatorId, creatorOverride, existingPostsOverride) => {
    const state = get();
    const creator = creatorOverride || state.creatorProfiles[creatorId] || state.creators.find((c) => c.id === creatorId);
    if (!creator || !creator.profileUrl || !creator.profileHasMore || state.isLoadingMoreProfile) {
      return null;
    }
    const nextPage = creator.profileNextPage || ((creator.profilePage || 1) + 1);
    profileLoadMoreController?.abort();
    const controller = new AbortController();
    profileLoadMoreController = controller;
    set({ isLoadingMoreProfile: true });
    try {
      const isEn = useAppStore.getState().settings?.language === 'en-US';
      const basePosts = existingPostsOverride ?? get().posts.filter((p) => doesPostMatchCreator(p, creator));
      const snap = await loadTimelineCreatorProfile({
        url: creator.profileNextPageUrl || creator.profileUrl,
        existingCreator: creator,
        expectedName: creator.name,
        seedAvatar: creator.avatar,
        existingPosts: basePosts,
        signal: controller.signal,
        unnamedLabel: isEn ? 'Creator' : 'Criador',
        page: creator.profileNextPageUrl ? 1 : nextPage,
        sort: creator.activeSort,
      });
      const mergedCreatorPosts = mergeRefreshedTimelinePosts(basePosts, snap.posts);
      set((s) => ({
        isLoadingMoreProfile: false,
        creatorProfiles: {
          ...s.creatorProfiles,
          [creator.id]: snap.creator,
        },
        posts: mergeRefreshedTimelinePosts(s.posts, mergedCreatorPosts),
      }));
      return { creator: snap.creator, posts: mergedCreatorPosts };
    } catch {
      set({ isLoadingMoreProfile: false });
      return null;
    }
  },

  switchCreatorProfileSort: async (creatorId, sort, creatorOverride) => {
    const state = get();
    const creator = creatorOverride || state.creatorProfiles[creatorId] || state.creators.find((c) => c.id === creatorId);
    if (!creator || !creator.profileUrl) return null;
    const cleanSort = String(sort || '').trim().toLowerCase();
    if (!cleanSort) return null;
    profileLoadMoreController?.abort();
    const controller = new AbortController();
    profileLoadMoreController = controller;
    set({ isLoadingMoreProfile: true });
    try {
      const isEn = useAppStore.getState().settings?.language === 'en-US';
      const snap = await loadTimelineCreatorProfile({
        url: creator.profileUrl,
        existingCreator: { ...creator, activeSort: cleanSort },
        expectedName: creator.name,
        seedAvatar: creator.avatar,
        existingPosts: [],
        signal: controller.signal,
        unnamedLabel: isEn ? 'Creator' : 'Criador',
        page: 1,
        sort: cleanSort,
      });
      if (controller.signal.aborted) return null;
      const updatedCreator: TimelineCreator = { ...snap.creator, activeSort: cleanSort };
      set((s) => ({
        isLoadingMoreProfile: false,
        creatorProfiles: {
          ...s.creatorProfiles,
          [creator.id]: updatedCreator,
        },
        posts: mergeRefreshedTimelinePosts(s.posts, snap.posts),
      }));
      return { creator: updatedCreator, posts: snap.posts };
    } catch {
      set({ isLoadingMoreProfile: false });
      return null;
    }
  },

  toggleGlobalMute: () => set((state) => ({ isGlobalMuted: !state.isGlobalMuted })),
}));
