import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Sparkles,
  Clock,
  Loader2,
  RefreshCw,
  Compass,
  ChevronLeft,
  Heart,
  ArrowUpRight,
  UsersRound,
  AlertCircle,
  Check,
  CheckCircle2,
  Inbox,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
  Layers,
  ListVideo,
  Play,
  ExternalLink,
} from 'lucide-react';
import { isOfflineTimelinePost, mergeTimelineExportPages } from '../../../services/timelineImport';
import { TimelineImportedPost, usePublishedTimelineImports } from './TimelineLocalImport';
import { useTimelineX, XProfileHeaderCard, XTimelineCard, type XAccount, type XPost, type XTarget } from './LiveSocialTimeline';
import { XPhotoThreadModal, XPostDetailView, XRelevantPeopleCard, useXPostThread } from './XPostDetailView';
import { renderSourceIcon, TimelineSourceBar, TimelineSourceLinks } from './TimelineSourceBar';
import { TimelineSearchResults } from './TimelineSearchResults';
import { TimelineSourcesSheet, type SheetCreatorEntry } from './TimelineSourcesSheet';
import { computeMobileChromeCollapsed, deriveActiveTimelineSources } from './timelineOptIn';
import { AppDialog } from '../../common/AppDialog';
import { fetchPlaylistVideos } from '../../../services/profileHubApi';
import {
  createSearchCoordinator,
  filterSnapshotBySourceAndCategory,
  getDeduplicatedAllItems,
  type SearchCategoryTab,
  type SearchFilterOptions,
  type SearchSourceDescriptor,
  type TimelineSearchSnapshot,
} from '../../../services/timelineSearch';
import { SourceAvatar } from '../common/SourceAvatar';
import {
  CATALOG_MODE_LABELS,
  TIMELINE_SOURCES,
  catalogModes,
  getTimelineSourceDisplayName,
  matchesCatalogMode,
  sourceViewCount,
  type CatalogMode,
  type TimelineSource,
} from './timelineSourceNavigation';
import { getDynamicSourceAccent, getSourceCapabilities } from './timelineSourceCapabilities';
import { ForumThreadReaderView } from './ForumThreadReaderView';
import { GalleryDetailView } from './GalleryDetailView';
import { CatalogEntityView } from './CatalogEntityView';
import { VideoPortalProfileView, type VideoPortalProfileTab } from './VideoPortalProfileView';
import {
  CategoryShowcaseCard,
  CategoryShowcaseStrip,
  EditorialGalleryCard,
  ForumBoardTreePanel,
  ForumThreadRow,
  VisualDirectoryExplorer,
} from './AdaptiveSourceCards';
import { TimelineStoriesBar } from './TimelineStoriesBar';
import { TimelinePlaybackHandoff, TimelinePostCard } from './TimelinePostCard';
import { AdaptiveProfileHeader } from './AdaptiveProfileHeader';
import { AdaptiveProfileContent } from './AdaptiveProfileContent';
import { TimelineWatchSession, TimelineWatchView } from './TimelineWatchView';
import { createTimelineWatchHistory } from '../../../services/timelineWatchHistory';
import { loadTimelineCreatorProfile, TimelineCreatorProfileSnapshot } from '../../../services/timelineCreatorProfile';
import { engagementSourceUrl } from '../../../services/profileHubEngagement';
import {
  TimelineCreator,
  TimelinePlatform,
  TimelinePost,
  TIMELINE_BACKGROUND_POLL_MS,
  classifyTimelineDirectUrl,
  doesPostMatchCreator,
  findUndiscoveredCreatorIds,
  resolveCachedPostPlatform,
  shouldAutoRefreshTimeline,
  sortTimelinePostsByPublication,
  mapPlaylistVideosToTimelinePosts,
  resolveCreatorHandle,
  resolveTimelinePlatform,
  timelinePostSourceKey,
} from './timelineModel';
import { CommentsBottomSheet } from './CommentsBottomSheet';
import { PhotoLightboxModal } from './PhotoLightboxModal';
import { translations } from '../../../i18n/translations';
import { useShallow } from 'zustand/react/shallow';
import { CreatorWatchReturnTarget, useProfileTimelineStore } from '../../../store/useProfileTimelineStore';
import { useProfileHubLibraryStore } from '../../../store/useProfileHubLibraryStore';
import { useMiniPlayerStore } from '../../../store/useMiniPlayerStore';
import { usePersistentPlayerStore } from '../../../store/usePersistentPlayerStore';
import { rankForYouPosts } from '../../../services/timelineRecommendation';
import { useAppStore } from '../../../store/useAppStore';

interface ProfileTimelineViewProps {
  active?: boolean;
  isMobileOnly?: boolean;
  onWatchOpenChange?: (open: boolean) => void;
  toolbarAction?: React.ReactNode;
  mobileSearchOpen?: boolean;
  sourcesSheetOpen?: boolean;
  mobileChromeCollapsed?: boolean;
  sourcesTriggerRef?: React.RefObject<HTMLElement | null>;
  onMobileSearchOpenChange?: (open: boolean) => void;
  onOpenSourcesSheet?: () => void;
  onCloseSourcesSheet?: () => void;
  onMobileChromeCollapsedChange?: (collapsed: boolean) => void;
}

type CreatorSnapshot = TimelineCreatorProfileSnapshot;
type CreatorSeed = {name?: string; avatar?: string | null};
type CreatorEntry = {url: string; snapshot?: CreatorSnapshot; scroll: number; activeTab: string; error?: boolean; seed?: CreatorSeed; returnTo?: CreatorWatchReturnTarget | null};
const TIMELINE_CREATOR_HISTORY_KEY = 'imagexTimelineCreator';
type WatchEntry = {session: TimelineWatchSession; scroll: number; section: 'comments' | 'related'};
// UI cache retains the active viewer and one neighbor in each direction. History is not truncated.
const WATCH_UI_NEIGHBOR_RADIUS = 1;
// Bound layout restoration to the player startup window; a quiet completed/error layout
// gets one second for its final render/observer delivery before accepting a clamped target.
const WATCH_SCROLL_RESTORE_MAX_WAIT_MS = 20_000;
const WATCH_SCROLL_LAYOUT_SETTLE_MS = 1_000;
const WATCH_SCROLL_PIXEL_TOLERANCE = 1;
// One extra viewport absorbs normal scrolling without mounting the whole catalog.
const FEED_BUFFER_VIEWPORTS = 1;
// SSR / an unmeasured or hidden layout starts with one card, then uses real geometry.
const FEED_UNMEASURED_CARD_COUNT = 1;
const X_TABS = [
  {scope: 'recommended', en: 'For you', pt: 'Para você'},
  {scope: 'following', en: 'Following', pt: 'Seguindo'},
  {scope: 'explore', en: 'Explore', pt: 'Explorar'},
  {scope: 'accounts', en: 'Followed accounts', pt: 'Perfis seguidos'},
] as const;
const xPostId = (post: XPost) => `live-x:${post.id}`;

function TimelineFeedNotice({kind, children, action, animate = false}: {
  kind: 'loading' | 'empty' | 'error' | 'end' | 'more';
  children: React.ReactNode;
  action?: React.ReactNode;
  animate?: boolean;
}) {
  const Icon = kind === 'error' ? AlertCircle : kind === 'end' ? Check
    : kind === 'empty' ? Inbox : Loader2;
  return <div className="tl-feed-notice" data-feed-state={kind}>
    <div role={kind === 'error' ? 'alert' : 'status'} className="tl-feed-notice-message">
      <Icon aria-hidden size={kind === 'loading' || kind === 'empty' ? 24 : 17}
        className={animate ? 'animate-spin motion-reduce:animate-none' : undefined} />
      <span>{children}</span>
    </div>
    {action}
  </div>;
}

export const ProfileTimelineView: React.FC<ProfileTimelineViewProps> = ({
  active = true,
  isMobileOnly = false,
  onWatchOpenChange,
  toolbarAction,
  mobileSearchOpen: controlledMobileSearchOpen,
  sourcesSheetOpen: controlledSourcesSheetOpen,
  mobileChromeCollapsed: controlledMobileChromeCollapsed,
  sourcesTriggerRef,
  onMobileSearchOpenChange,
  onOpenSourcesSheet,
  onCloseSourcesSheet,
  onMobileChromeCollapsedChange,
}) => {
  const [localMobileSearchOpen, setLocalMobileSearchOpen] = useState(false);
  const [localSourcesSheetOpen, setLocalSourcesSheetOpen] = useState(false);
  const [localChromeCollapsed, setLocalChromeCollapsed] = useState(false);
  const effectiveMobileSearchOpen = controlledMobileSearchOpen ?? localMobileSearchOpen;
  const effectiveSourcesSheetOpen = controlledSourcesSheetOpen ?? localSourcesSheetOpen;
  const effectiveChromeCollapsed = controlledMobileChromeCollapsed ?? localChromeCollapsed;
  const setEffectiveSourcesSheetOpen = useCallback((open: boolean) => {
    if (open) {
      if (onOpenSourcesSheet) onOpenSourcesSheet();
      else setLocalSourcesSheetOpen(true);
    } else {
      if (onCloseSourcesSheet) onCloseSourcesSheet();
      else setLocalSourcesSheetOpen(false);
    }
  }, [onOpenSourcesSheet, onCloseSourcesSheet]);
  const setEffectiveChromeCollapsed = useCallback((collapsed: boolean) => {
    if (onMobileChromeCollapsedChange) onMobileChromeCollapsedChange(collapsed);
    else setLocalChromeCollapsed(collapsed);
  }, [onMobileChromeCollapsedChange]);
  void onMobileSearchOpenChange;
  void setLocalMobileSearchOpen;
  const activeRef = useRef(active);
  activeRef.current = active;
  const lastRefreshAtRef = useRef<number | null>(null);
  const isRefreshingFeedRef = useRef(false);
  const isEn = useAppStore(state => state.settings?.language === 'en-US');
  const disableAllAnimations = useAppStore(state => state.settings?.disableAllAnimations);

  const {
    history: libraryHistory,
    liked: libraryLiked,
    favorites: libraryFavorites,
    playlists: libraryPlaylists,
    hydrateLibrary,
  } = useProfileHubLibraryStore(
    useShallow((state) => ({
      history: state.history,
      liked: state.liked,
      favorites: state.favorites,
      playlists: state.playlists,
      hydrateLibrary: state.hydrateLibrary,
    }))
  );

  useEffect(() => {
    if (active) {
      void hydrateLibrary();
      void useAppStore.getState().syncVideos();
    }
  }, [active, hydrateLibrary]);

  const {
    creators,
    creatorProfiles,
    posts,
    likedPostIds,
    favoritedPostIds,
    savedPostIds,
    isLoading,
    error,
    activeFilter,
    searchQuery,
    selectedCreatorId,
    activeCommentsPostId,
    activeAutoplayPostId,
    lightbox,
    pendingCreatorProfileUrl,
    pendingCreatorSeed,
    pendingCreatorReturn,
    setPendingCreatorProfileUrl,
    setPendingLibraryWatchRestore,
    refreshTimeline,
    refreshMissingCreators,
    discoverCreatorCatalog,
    isDiscoveringCreator,
    creatorRefreshErrors,
    creatorRefreshedAt,
    setActiveFilter,
    setSearchQuery,
    setSelectedCreatorId,
    setActiveAutoplayPostId,
    openComments,
    closeComments,
    openLightbox,
    closeLightbox,
    nextLightboxImage,
    prevLightboxImage,
    browseCapabilities,
    browseFeedsBySource,
    dynamicSubfiltersBySource,
    directoriesByKey,
    forumBoardsBySource,
    activeThreadView,
    isLoadingMoreProfile,
    hydrateBrowseCapabilities,
    loadIntegratedSources,
    integrateSourceUrl,
    removeIntegratedSource,
    resetIntegratedSources,
    clearLastIntegrationResult,
    integratedSources,
    integratedSourcesStatus,
    isIntegratingSource,
    lastIntegrationResult,
    loadBrowseFeed,
    loadMoreBrowseFeed,
    loadDirectory,
    queueCatalogEnrichment,
    loadForumBoards,
    openThreadView,
    loadThreadPage,
    closeThreadView,
    loadMoreCreatorProfileAlbums,
    switchCreatorProfileSort,
  } = useProfileTimelineStore();
  const [desktopOptInUrl, setDesktopOptInUrl] = useState('');
  const [desktopOptInInvalid, setDesktopOptInInvalid] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [source, setSource] = useState<TimelineSource>('all');
  const [sourceModes, setSourceModes] = useState<Partial<Record<TimelineSource, CatalogMode>>>({});
  const [visualScopeMode, setVisualScopeMode] = useState<'discover' | 'followed'>('discover');
  const [browseSubfilters, setBrowseSubfilters] = useState<Partial<Record<TimelineSource, string | null>>>({});
  const [searchOptionsBySource, setSearchOptionsBySource] = useState<Record<string, SearchFilterOptions>>({});
  const searchOptionsRef = useRef<Record<string, SearchFilterOptions>>({});
  searchOptionsRef.current = searchOptionsBySource;
  const [activeDirectoryKind, setActiveDirectoryKind] = useState<string | null>(null);
  const [directoryInitialFilter, setDirectoryInitialFilter] = useState<string>('');
  const [quickEntityUrl, setQuickEntityUrl] = useState('');
  const [galleryStack, setGalleryStack] = useState<Array<{ url: string; post?: TimelinePost; source?: string }>>([]);
  const activeGallery = galleryStack.length > 0 ? galleryStack[galleryStack.length - 1] : null;
  const [xProfileMode, setXProfileMode] = useState<'posts' | 'media'>('posts');
  const [xTab, setXTab] = useState<typeof X_TABS[number]['scope']>('recommended');
  const [xProfile, setXProfile] = useState<XAccount>();
  const [xPostStack, setXPostStack] = useState<XPost[]>([]);
  const [xPhotoModal, setXPhotoModal] = useState<{ post: XPost; index: number } | null>(null);
  const [savedCreatorFilter, setSavedCreatorFilter] = useState('');
  const [showAllSavedCreators, setShowAllSavedCreators] = useState(false);
  const xPostReturnScrollRef = useRef<number | null>(null);
  const activeXPost = xPostStack.length > 0 ? xPostStack[xPostStack.length - 1] : null;
  const xPostThread = useXPostThread(activeXPost, active && Boolean(activeXPost) && !selectedCreatorId);
  const xProfileReturn = useRef<{scroll: number; top: number; card?: string}>();
  const xProfileHeading = useRef<HTMLHeadingElement>(null);
  const integratedSourceIds = useMemo(
    () => new Set(integratedSources.map((row) => row.id.toLowerCase())),
    [integratedSources]
  );
  const hasSavedXCreator = useMemo(
    () => creators.some((creator) => resolveTimelinePlatform(creator.profileUrl, creator.site) === 'x'),
    [creators]
  );
  const isXIntegrated = integratedSourceIds.has('x') || hasSavedXCreator || Boolean(xProfile);
  const xAccounts = !xProfile && !activeXPost && source === 'x' && xTab === 'accounts';
  const xTarget = useMemo<XTarget>(() => {
    if (xProfile) return {key: `profile:${xProfile.handle.toLowerCase()}`, scope: 'profile', handle: xProfile.handle};
    const scope = source === 'x' ? xTab : 'recommended';
    return {key: scope, scope};
  }, [source, xTab, xProfile]);
  const canShowX = isXIntegrated && (Boolean(xProfile) || source === 'x' || source === 'all');
  const {feed: xFeed, accounts: followedXAccounts, xFollowedHandles, load: loadX} = useTimelineX(xTarget, active && canShowX && !selectedCreatorId);
  const openXProfile = (account: XAccount, trigger: HTMLElement) => {
    if (xPostStack.length > 0) setXPostStack([]);
    if (xProfile?.handle.toLowerCase() === account.handle.toLowerCase()) return;
    if (!xProfile) xProfileReturn.current = {
      scroll: timelineRef.current?.closest('main')?.scrollTop ?? 0,
      top: trigger.getBoundingClientRect().top,
      card: trigger.closest<HTMLElement>('[data-x-entry]')?.dataset.xEntry,
    };
    setXProfileMode('posts');
    setXProfile(account);
  };
  const openXPostDetail = (post: XPost) => {
    const main = timelineRef.current?.closest('main');
    if (xPostStack.length === 0 && main) {
      xPostReturnScrollRef.current = main.scrollTop;
    }
    setXPostStack(prev => {
      if (prev.length > 0 && prev[prev.length - 1].id === post.id) return prev;
      return [...prev, post];
    });
    if (main) main.scrollTop = 0;
  };
  const closeXPostDetail = () => {
    setXPostStack(prev => {
      if (prev.length <= 1) {
        const savedScroll = xPostReturnScrollRef.current;
        xPostReturnScrollRef.current = null;
        if (savedScroll != null) {
          requestAnimationFrame(() => {
            const main = timelineRef.current?.closest('main');
            if (main) main.scrollTop = savedScroll;
          });
        }
        return [];
      }
      return prev.slice(0, -1);
    });
  };
  const feedListRef = useRef<HTMLDivElement | null>(null);
  const feedSentinelRef = useRef<HTMLDivElement | null>(null);
  const [feedWindow, setFeedWindow] = useState({key: '', count: FEED_UNMEASURED_CARD_COUNT});
  const feedWindows = useRef(new Map<string, number>());
  const [feedPageSize, setFeedPageSize] = useState(FEED_UNMEASURED_CARD_COUNT);
  const pinnedFeedPostRef = useRef<string | null>(null);
  const mountedFeedPostIdsRef = useRef(new Set<string>());
  const pendingFeedFocusRef = useRef<string | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const [isRefreshingTimeline, setIsRefreshingTimeline] = useState(false);
  const refreshFeed = useCallback(async (signal?: AbortSignal) => {
    if (!activeRef.current || signal?.aborted || isRefreshingFeedRef.current) return;
    isRefreshingFeedRef.current = true;
    setIsRefreshingTimeline(true);
    try {
      await refreshTimeline(signal);
      if (!signal?.aborted) lastRefreshAtRef.current = Date.now();
    } finally {
      isRefreshingFeedRef.current = false;
      if (!signal?.aborted) setIsRefreshingTimeline(false);
    }
  }, [refreshTimeline]);
  const feedScrollRef = useRef(0);
  const [watchSession, setWatchSession] = useState<TimelineWatchSession | null>(null);
  const watchRef = useRef<TimelineWatchSession | null>(null);
  watchRef.current = watchSession;
  const historyRef = useRef<ReturnType<typeof createTimelineWatchHistory<WatchEntry>> | null>(null);
  if (!historyRef.current) historyRef.current = createTimelineWatchHistory<WatchEntry>({
    location: () => window.location.href, state: () => window.history.state,
    push: (state, url) => {const next = {...state}; delete next[TIMELINE_CREATOR_HISTORY_KEY]; window.history.pushState(next, '', url);}, back: () => window.history.back(),
    token: () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  });
  const watchHistory = historyRef.current;
  const creatorHistoryRef = useRef<ReturnType<typeof createTimelineWatchHistory<CreatorEntry>> | null>(null);
  if (!creatorHistoryRef.current) creatorHistoryRef.current = createTimelineWatchHistory<CreatorEntry>({
    stateKey: TIMELINE_CREATOR_HISTORY_KEY,
    retainKnownEntries: true,
    location: () => window.location.href, state: () => window.history.state,
    push: (state, url) => window.history.pushState(state, '', url), back: () => window.history.back(),
    token: () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  });
  const creatorHistory = creatorHistoryRef.current;
  const [creatorEntry, setCreatorEntry] = useState<{token:string;value:CreatorEntry} | null>(null);
  const [creatorEntries, setCreatorEntries] = useState(creatorHistory.entries);
  const creatorEntryRef = useRef(creatorEntry);
  creatorEntryRef.current = creatorEntry;
  const creatorCacheRef = useRef(new Map<string, CreatorSnapshot>());
  const settledCreatorTokensRef = useRef(new Set<string>());
  const completedCreatorTokensRef = useRef(new Set<string>());
  const creatorRequestRef = useRef<AbortController | null>(null);
  const [creatorLoading, setCreatorLoading] = useState(false);
  const [creatorAttempt, setCreatorAttempt] = useState(0);
  const pendingCreatorScrollRef = useRef<number | null>(null);
  const snapshotCreator = useCallback(() => {
    const entry = creatorEntryRef.current;
    if (!activeRef.current || !entry || creatorHistory.current()?.token !== entry.token) return;
    const value = {...entry.value, scroll:timelineRef.current?.closest('main')?.scrollTop ?? entry.value.scroll};
    creatorHistory.save(value);
    creatorEntryRef.current = {...entry, value};
  }, [creatorHistory]);
  const [watchEntries, setWatchEntries] = useState(watchHistory.entries);
  const [activeWatchToken, setActiveWatchToken] = useState<string | null>(null);
  const playerSnapshotRef = useRef<(() => TimelinePlaybackHandoff) | null>(null);
  const sectionSnapshotRef = useRef<'comments'|'related'>('related');
  const watchClosingRef = useRef(false);
  const watchSuspendedRef = useRef(false);
  const restoreWatchReturnRef = useRef(false);
  const pendingWatchScrollRef = useRef<number | null>(null);
  useEffect(() => { onWatchOpenChange?.(!!watchSession && !creatorEntry); }, [!!watchSession, !!creatorEntry, onWatchOpenChange]);
  useEffect(() => () => onWatchOpenChange?.(false), [onWatchOpenChange]);
  const watchReturnRef = useRef<{scroll: number; trigger: HTMLElement | null}>({scroll:0, trigger:null});
  const snapshotWatch = useCallback(() => {
    const entry = watchHistory.current();
    if (!activeRef.current || creatorEntryRef.current || watchSuspendedRef.current || !entry) return;
    const handoff = playerSnapshotRef.current?.() || entry.value.session.handoff;
    watchHistory.save({session:{...entry.value.session, handoff}, scroll:pendingWatchScrollRef.current ?? timelineRef.current?.closest('main')?.scrollTop ?? 0, section:sectionSnapshotRef.current});
  }, [watchHistory]);
  const openWatchCreator = (sourceUrl: string, seed?: CreatorSeed, returnTo?: CreatorWatchReturnTarget | null) => {
    if (!activeRef.current) return;
    const url = engagementSourceUrl(sourceUrl);
    if (!url) return;
    setGalleryStack([]);
    snapshotWatch(); snapshotCreator();
    try {
      const known = Object.values(creatorProfiles).find(creator => engagementSourceUrl(creator.profileUrl) === url);
      const cached = creatorCacheRef.current.get(url) || (known ? {creator:known,posts:posts.filter(post => doesPostMatchCreator(post, known))} : undefined);
      const entry = creatorHistory.open({url, snapshot:cached, scroll:0, activeTab:'timeline', seed, returnTo});
      creatorRequestRef.current?.abort();
      watchSuspendedRef.current = true;
      setWatchEntries(watchHistory.entries());
      setCreatorEntries(creatorHistory.entries());
      setCreatorEntry(entry); creatorEntryRef.current = entry;
      pendingCreatorScrollRef.current = 0;
      setActiveAutoplayPostId(null); closeComments();
    } catch {
      const app = useAppStore.getState();
      const english = app.settings.language === 'en-US';
      app.addNotification({type:'error', title:english ? 'Could not open profile' : 'Não foi possível abrir o perfil', message:english ? 'The profile could not be added to navigation history. Try again.' : 'Não foi possível adicionar o perfil ao histórico de navegação. Tente novamente.'});
    }
  };
  const closeCreator = () => {
    const activeEntry = creatorEntryRef.current;
    if (creatorHistory.entries().length <= 1 && activeEntry?.value.returnTo) {
      const returnTarget = activeEntry.value.returnTo;
      if (returnTarget.watchSession) {
        setPendingLibraryWatchRestore(returnTarget);
      }
      settledCreatorTokensRef.current.clear();
      completedCreatorTokensRef.current.clear();
      creatorHistory.clear();
      creatorRequestRef.current?.abort();
      creatorEntryRef.current = null;
      setCreatorEntry(null);
      setCreatorEntries([]);
      useAppStore.getState().navigateToView(returnTarget.viewId);
      return;
    }
    snapshotCreator();
    creatorHistory.back();
  };
  useEffect(() => {
    if (!active || !pendingCreatorProfileUrl) return;
    const targetUrl = pendingCreatorProfileUrl;
    const targetSeed = pendingCreatorSeed || undefined;
    const targetReturn = pendingCreatorReturn || null;
    setPendingCreatorProfileUrl(null);
    openWatchCreator(targetUrl, targetSeed, targetReturn);
  }, [active, pendingCreatorProfileUrl, pendingCreatorSeed, pendingCreatorReturn, setPendingCreatorProfileUrl]);
  useEffect(() => {
    if (!active || !creatorEntry) { creatorRequestRef.current?.abort(); setCreatorLoading(false); return; }
    if (completedCreatorTokensRef.current.has(creatorEntry.token) || settledCreatorTokensRef.current.has(creatorEntry.token)) {setCreatorLoading(false); return;}
    const controller = new AbortController();
    creatorRequestRef.current = controller;
    const token = creatorEntry.token;
    const url = creatorEntry.value.url;
    setCreatorLoading(true);
    const apply = (snapshot: CreatorSnapshot, error = false) => {
      if (controller.signal.aborted || creatorRequestRef.current !== controller || creatorEntryRef.current?.token !== token) return;
      creatorCacheRef.current.set(url, snapshot);
      const value = {...creatorEntryRef.current.value,snapshot,error:error || !!snapshot.incomplete};
      creatorHistory.save(value);
      const next = {token,value}; creatorEntryRef.current = next; setCreatorEntry(next); setCreatorEntries(creatorHistory.entries());
    };
    const cached = creatorEntry.value.snapshot;
    const seed = creatorEntry.value.seed;
    void loadTimelineCreatorProfile({url, existingCreator:cached?.creator, expectedName:seed?.name, seedAvatar:seed?.avatar, existingPosts:cached?.posts || [], signal:controller.signal, onSnapshot:snapshot => apply(snapshot), unnamedLabel:''}).then(snapshot => {if (!controller.signal.aborted) {settledCreatorTokensRef.current.add(token); if (!snapshot.incomplete) completedCreatorTokensRef.current.add(token);} apply(snapshot);}).catch(() => {
      if (controller.signal.aborted || creatorRequestRef.current !== controller || creatorEntryRef.current?.token !== token) return;
      settledCreatorTokensRef.current.add(token);
      const next = {token,value:{...creatorEntryRef.current.value,error:true}};
      creatorHistory.save(next.value); creatorEntryRef.current = next; setCreatorEntry(next); setCreatorEntries(creatorHistory.entries());
    }).finally(() => {
      if (!controller.signal.aborted && creatorRequestRef.current === controller) setCreatorLoading(false);
    });
    return () => {controller.abort(); if (creatorRequestRef.current === controller) creatorRequestRef.current = null;};
  }, [active, creatorEntry?.token, creatorAttempt, creatorHistory]);
  useLayoutEffect(() => {
    if (!active || !creatorEntry || pendingCreatorScrollRef.current === null) return;
    const targetScroll = pendingCreatorScrollRef.current;
    const main = timelineRef.current?.closest('main');
    if (main) main.scrollTop = targetScroll;
    let rafId = 0;
    if (typeof requestAnimationFrame !== 'undefined') {
      rafId = requestAnimationFrame(() => {
        const container = timelineRef.current?.closest('main');
        if (container && activeRef.current && creatorEntryRef.current?.token === creatorEntry.token) {
          container.scrollTop = targetScroll;
        }
      });
    }
    if (creatorEntry.value.snapshot || creatorEntry.value.error) pendingCreatorScrollRef.current = null;
    return () => {
      if (rafId && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId);
    };
  }, [active, creatorEntry]);
  useLayoutEffect(() => {
    if (!active || !creatorEntry) return;
    timelineRef.current?.querySelector<HTMLElement>('[data-creator-active="true"] button')?.focus({preventScroll:true});
  }, [active, creatorEntry?.token]);
  const openWatchSession = (session: TimelineWatchSession) => {
    if (!activeRef.current || watchClosingRef.current) return false;
    snapshotCreator(); snapshotWatch();
    let entry: ReturnType<typeof watchHistory.open>;
    try {
      entry = watchHistory.open({session, scroll:0, section:'related'});
    } catch {
      watchClosingRef.current = false;
      const app = useAppStore.getState();
      const english = app.settings.language === 'en-US';
      app.addNotification({type:'error', title:english ? 'Could not open video' : 'Não foi possível abrir o vídeo', message:english ? 'Your browser could not add this video to navigation history. Try again.' : 'O navegador não conseguiu adicionar este vídeo ao histórico de navegação. Tente novamente.'});
      return false;
    }
    if (!watchRef.current) watchReturnRef.current = {scroll:timelineRef.current?.closest('main')?.scrollTop ?? 0, trigger:document.activeElement instanceof HTMLElement ? document.activeElement : null};
    creatorRequestRef.current?.abort();
    creatorEntryRef.current = null; setCreatorEntry(null); watchSuspendedRef.current = false;
    sectionSnapshotRef.current = 'related';
    closeComments(); setActiveAutoplayPostId(null);
    watchRef.current = session;
    playerSnapshotRef.current = null;
    setWatchEntries(watchHistory.entries());
    setActiveWatchToken(entry.token); setWatchSession(session);
    pendingWatchScrollRef.current = 0;
    return true;
  };
  const openVideo = (post: TimelinePost, handoff: TimelinePlaybackHandoff) => openWatchSession({post, handoff, authorUrl:engagementSourceUrl(creatorEntryRef.current?.value.snapshot?.creator.profileUrl || creatorProfiles[post.creatorId]?.profileUrl) || undefined});
  const pendingExpandHandoff = useMiniPlayerStore(state => state.pendingExpandHandoff);
  const handledExpandAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !pendingExpandHandoff) return;
    if (handledExpandAtRef.current === pendingExpandHandoff.capturedAt) return;
    const { source, handoff: consumed } = pendingExpandHandoff;
    const originCtx = source.originContext as { surface?: string; creatorUrl?: string } | undefined;
    if (
      originCtx?.surface !== 'timeline-watch' &&
      source.returnRoute?.view !== 'timeline-preview' &&
      source.returnRoute?.view !== 'timeline'
    ) {
      return;
    }
    const targetPost =
      posts.find(p => p.id === source.id) ||
      ((source as unknown as { rawPost?: TimelinePost }).rawPost ?? null);
    if (!targetPost) return;
    handledExpandAtRef.current = pendingExpandHandoff.capturedAt;
    const flipRect = usePersistentPlayerStore.getState().consumePendingFlipRect();
    openWatchSession({
      post: targetPost,
      handoff: {
        currentTime: consumed.currentTime,
        sourceRect: flipRect
          ? { x: flipRect.left, y: flipRect.top, width: flipRect.width, height: flipRect.height }
          : (consumed.sourceRect ?? undefined),
        isMuted: Boolean(consumed.isMuted),
        isPlaying: consumed.isPlaying,
        volume: consumed.volume,
        playbackRate: consumed.playbackRate,
        selectedQuality: consumed.selectedQuality,
        qualities: consumed.qualities
          ? consumed.qualities
              .filter((q): q is { height: number; label: string; streamUrl: string } => Boolean(q.streamUrl))
              .map(q => ({ label: q.label, streamUrl: q.streamUrl, height: q.height }))
          : targetPost.qualities,
        masterHlsUrl: consumed.masterHlsUrl ?? targetPost.masterHlsUrl,
      },
      authorUrl:
        originCtx?.creatorUrl ||
        engagementSourceUrl(creatorProfiles[targetPost.creatorId]?.profileUrl) ||
        undefined,
    });
  }, [active, pendingExpandHandoff, posts, creatorProfiles]);
  const closeWatch = useCallback(() => {
    if (!watchRef.current || watchClosingRef.current) return;
    snapshotWatch();
    if (watchHistory.back()) { watchClosingRef.current = true; return; }
    restoreWatchReturnRef.current = true;
    watchRef.current = null; playerSnapshotRef.current = null;
    setActiveAutoplayPostId(null); setActiveWatchToken(null); setWatchSession(null);
  }, [setActiveAutoplayPostId, snapshotWatch, snapshotCreator, watchHistory, creatorHistory]);
  useLayoutEffect(() => {
    if (!active || creatorEntry) return;
    const container = timelineRef.current?.closest('main');
    if (watchSession && pendingWatchScrollRef.current !== null && container) {
      const target = pendingWatchScrollRef.current;
      const activeView = timelineRef.current?.querySelector<HTMLElement>('[data-watch-active="true"]');
      let stopped = false;
      let frame: number | null = null;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      let resize: ResizeObserver | null = null;
      let mutations: MutationObserver | null = null;
      const stop = (clearTarget = true) => {
        stopped = true;
        if (clearTarget) pendingWatchScrollRef.current = null;
        if (frame !== null) cancelAnimationFrame(frame);
        if (quietTimer !== null) clearTimeout(quietTimer);
        if (deadline !== null) clearTimeout(deadline);
        resize?.disconnect(); mutations?.disconnect();
        container.removeEventListener('wheel', intent);
        container.removeEventListener('touchstart', intent);
        container.removeEventListener('touchmove', intent);
        container.removeEventListener('pointerdown', intent);
        window.removeEventListener('keydown', keyIntent);
      };
      const intent = () => stop();
      const keyIntent = (event: KeyboardEvent) => {
        if (['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(event.key)) stop();
      };
      const retry = () => {
        if (stopped) return;
        frame = null;
        container.scrollTop = target;
        if (Math.abs(container.scrollTop - target) <= WATCH_SCROLL_PIXEL_TOLERANCE) {stop(); return;}
        if (quietTimer !== null) clearTimeout(quietTimer);
        // Loaded comments may have fewer rows after cache eviction (collapsed replies),
        // or an origin can terminate/fail before the old height. Accept the available
        // position after the layout settles; restoration never dispatches page requests.
        if (!activeView?.querySelector('[aria-busy="true"], [data-watch-loading="true"]')) {
          quietTimer = setTimeout(() => stop(), WATCH_SCROLL_LAYOUT_SETTLE_MS);
        }
      };
      const changed = () => {
        if (!stopped && frame === null) frame = requestAnimationFrame(retry);
      };
      container.addEventListener('wheel', intent, {passive:true});
      container.addEventListener('touchstart', intent, {passive:true});
      container.addEventListener('touchmove', intent, {passive:true});
      container.addEventListener('pointerdown', intent, {passive:true});
      window.addEventListener('keydown', keyIntent, {passive:true});
      if (activeView && typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(changed); resize.observe(activeView);
      }
      if (activeView && typeof MutationObserver !== 'undefined') {
        mutations = new MutationObserver(changed);
        mutations.observe(activeView, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['aria-busy','data-watch-loading','hidden','style']});
      }
      deadline = setTimeout(() => stop(), WATCH_SCROLL_RESTORE_MAX_WAIT_MS);
      retry(); // Keep the existing pre-paint restoration when the cached height is ready.
      return () => stop(false);
    } else if (!watchSession && restoreWatchReturnRef.current) {
      restoreWatchReturnRef.current = false;
      if (container) container.scrollTop = watchReturnRef.current.scroll;
      const trigger = watchReturnRef.current.trigger;
      if (trigger?.isConnected) trigger.focus({preventScroll:true});
    }
  }, [active, !!creatorEntry, watchSession, activeWatchToken]);
  useEffect(() => {
    const restore = () => {
      // Ignore unrelated route locations; only opaque local timeline entries restore here.
      if (window.location.hash !== '#/timeline-preview') return;
      snapshotCreator(); snapshotWatch();
      const restoredCreator = creatorHistory.restore().entry;
      creatorRequestRef.current?.abort();
      creatorEntryRef.current = restoredCreator; setCreatorEntry(restoredCreator); setCreatorEntries(creatorHistory.entries());
      pendingCreatorScrollRef.current = restoredCreator?.value.scroll ?? null;
      watchClosingRef.current = false;
      const {entry, sameLocation} = watchHistory.restore();
      if (!sameLocation) return;
      watchSuspendedRef.current = !!restoredCreator;
      restoreWatchReturnRef.current = !entry && sameLocation && !!watchRef.current;
      watchRef.current = entry?.value.session || null;
      playerSnapshotRef.current = null;
      pendingWatchScrollRef.current = restoredCreator ? null : entry?.value.scroll ?? null;
      sectionSnapshotRef.current = entry?.value.section ?? 'related';
      setActiveAutoplayPostId(null);
      setWatchEntries(watchHistory.entries()); setActiveWatchToken(entry?.token || null);
      setWatchSession(entry?.value.session || null);
    };
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.currentView === previous.currentView) return;
      if (state.currentView === 'timeline-preview') { restore(); return; }
      settledCreatorTokensRef.current.clear(); completedCreatorTokensRef.current.clear(); creatorHistory.clear(); creatorRequestRef.current?.abort(); creatorEntryRef.current = null; setCreatorEntry(null); setCreatorEntries([]);
      watchHistory.clear(); watchClosingRef.current = false; watchSuspendedRef.current = false;
      restoreWatchReturnRef.current = false; watchRef.current = null; playerSnapshotRef.current = null;
      setWatchEntries([]); setActiveWatchToken(null); setWatchSession(null);
    });
    return () => {
      window.removeEventListener('popstate', restore); window.removeEventListener('hashchange', restore);
      unsubscribe();
      // Do not clear here: StrictMode replays effect setup/cleanup on the same mount.
      // The session registry is released with the component instance on actual unmount.
    };
  }, [setActiveAutoplayPostId, snapshotWatch, snapshotCreator, watchHistory, creatorHistory]);
  const previousCreatorRef = useRef(selectedCreatorId);
  const currentCreatorRef = useRef(selectedCreatorId);
  const catalogProfileReturn = useRef<{postId?: string; creatorId: string; top?: number}>();
  currentCreatorRef.current = selectedCreatorId;

  const knownCreatorIds = useMemo(
    () => new Set([...creators.map(c => c.id), ...Object.keys(creatorProfiles || {})]),
    [creators, creatorProfiles],
  );

  const openCreator = (id: string | null, trigger?: HTMLElement) => {
    if (id && !knownCreatorIds.has(id)) return;
    const container = timelineRef.current?.closest('main');
    if (!selectedCreatorId && id && container) {
      feedScrollRef.current = container.scrollTop;
      const control = trigger ?? document.activeElement?.closest<HTMLElement>('[data-creator-id]');
      catalogProfileReturn.current = {
        creatorId: id,
        top: control?.getBoundingClientRect().top,
        postId: control?.closest<HTMLElement>('[data-timeline-post-id]')?.dataset.timelinePostId,
      };
    }
    setSelectedCreatorId(id);
  };

  useEffect(() => {
    if (!active || creatorEntry || watchSession) {
      refreshControllerRef.current?.abort();
      useProfileTimelineStore.getState().suspendRequests();
      setIsRefreshingTimeline(false);
      return;
    }
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    const runAutoCheck = () => {
      if (controller.signal.aborted) return;
      if (shouldAutoRefreshTimeline({
        active: activeRef.current,
        inCreatorProfile: Boolean(creatorEntry),
        inWatchSession: Boolean(watchSession),
        isRefreshing: isRefreshingFeedRef.current,
        lastRefreshAt: lastRefreshAtRef.current,
        now: Date.now(),
      })) {
        void refreshFeed(controller.signal);
      }
    };
    // Defer one microtask so StrictMode's setup replay does not consume bootstrap
    // with an already-aborted signal. Short returns stay debounced by cooldown.
    void Promise.resolve().then(runAutoCheck);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') runAutoCheck();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const pollTimer = window.setInterval(runAutoCheck, TIMELINE_BACKGROUND_POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(pollTimer);
      controller.abort();
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null;
    };
  }, [active, !!creatorEntry, !!watchSession, refreshFeed]);

  useEffect(() => {
    if (!active || creatorEntry || watchSession || lastRefreshAtRef.current === null || isRefreshingFeedRef.current) {
      return;
    }
    const missingIds = findUndiscoveredCreatorIds(creators, creatorRefreshedAt, isDiscoveringCreator, creatorRefreshErrors);
    if (missingIds.length === 0) return;
    const signal = refreshControllerRef.current?.signal;
    if (signal?.aborted) return;
    void refreshMissingCreators(missingIds, signal);
  }, [active, !!creatorEntry, !!watchSession, creators, creatorRefreshedAt, isDiscoveringCreator, creatorRefreshErrors, refreshMissingCreators]);

  // Filtragem dos posts + Omni-Search Federado & YouTube Deep Discovery
  const [activeCustomCommentPost, setActiveCustomCommentPost] = useState<TimelinePost | null>(null);
  const searchCoordinatorRef = useRef<ReturnType<typeof createSearchCoordinator> | null>(null);
  if (!searchCoordinatorRef.current) {
    searchCoordinatorRef.current = createSearchCoordinator();
  }
  const sourceRef = useRef<TimelineSource>(source);
  sourceRef.current = source;
  const searchDebounceRef = useRef<number | null>(null);
  const [searchSnapshot, setSearchSnapshot] = useState<TimelineSearchSnapshot | null>(null);
  const [searchSources, setSearchSources] = useState<SearchSourceDescriptor[]>([]);
  const [searchCategory, setSearchCategory] = useState<SearchCategoryTab>('all');
  const [searchLoadingInitial, setSearchLoadingInitial] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [xPostsMode, setXPostsMode] = useState<'top' | 'latest'>('top');
  const [activePlaylistPost, setActivePlaylistPost] = useState<TimelinePost | null>(null);
  const [playlistModalVideos, setPlaylistModalVideos] = useState<TimelinePost[]>([]);
  const [playlistModalLoading, setPlaylistModalLoading] = useState(false);
  const [playlistModalError, setPlaylistModalError] = useState('');
  const playlistModalAbortRef = useRef<AbortController | null>(null);
  const [ytRecommendedPosts, setYtRecommendedPosts] = useState<TimelinePost[]>([]);
  const ytDeepScannedRef = useRef(false);

  const publishedImports = usePublishedTimelineImports();
  const combinedFeed = useMemo(() => publishedImports.posts.length > 0
    ? mergeTimelineExportPages({creators, posts}, [{
        ...publishedImports, posts: publishedImports.posts.filter(isOfflineTimelinePost), skipped: 0,
      }])
    : {creators, posts}, [creators, posts, publishedImports]);
  const query = (searchQuery || '').trim().toLowerCase();
  const displayedCreators = query
    ? creators.filter(creator => [creator.name, creator.handle].some(value => value?.toLowerCase().includes(query)))
    : creators;
  const creatorSites = useMemo(() => new Map(
    combinedFeed.creators.map(creator => [creator.id, resolveTimelinePlatform(creator.profileUrl, creator.site)]),
  ), [combinedFeed.creators]);
  const sourceOf = useCallback((post: TimelinePost) => {
    return resolveCachedPostPlatform(post, creatorSites.get(post.creatorId));
  }, [creatorSites]);

  const omniSearchLoading = searchLoadingInitial;
  const omniSearchSeqRef = useRef(0);
  const skipNextDebounceQueryRef = useRef<string | null>(null);

  useEffect(() => {
    const coord = searchCoordinatorRef.current;
    if (!coord) return;
    return coord.subscribe((snap, srcs) => {
      setSearchSnapshot(snap);
      setSearchSources(srcs);
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void searchCoordinatorRef.current?.initSources(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [active]);

  useEffect(() => {
    searchCoordinatorRef.current?.setLocalPool(combinedFeed.creators, combinedFeed.posts);
  }, [combinedFeed.creators, combinedFeed.posts]);

  const runOmniSearch = useCallback(async (rawQuery: string, _signal?: AbortSignal, immediate = false) => {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    const coord = searchCoordinatorRef.current;
    if (!coord) return;
    const clean = rawQuery.trim();
    if (immediate && clean.length >= 2) {
      skipNextDebounceQueryRef.current = clean.toLowerCase();
    }
    if (clean.length < 2) {
      skipNextDebounceQueryRef.current = null;
      omniSearchSeqRef.current += 1;
      coord.clear();
      setSearchLoadingInitial(false);
      return;
    }
    const seq = ++omniSearchSeqRef.current;
    setSearchLoadingInitial(true);
    try {
      const activeSrc = sourceRef.current;
      const activeOpts = activeSrc && activeSrc !== 'all' ? searchOptionsRef.current[activeSrc] : undefined;
      await coord.search(clean, activeSrc, activeOpts);
    } catch {
      // Aborted or stale search cleanup
    } finally {
      if (seq === omniSearchSeqRef.current) {
        setSearchLoadingInitial(false);
      }
    }
  }, []);

  const handleChangeSearchOptions = useCallback((nextOpts: SearchFilterOptions) => {
    const activeSrc = sourceRef.current;
    if (!activeSrc || activeSrc === 'all') return;
    searchOptionsRef.current = { ...searchOptionsRef.current, [activeSrc]: nextOpts };
    setSearchOptionsBySource(searchOptionsRef.current);
    void searchCoordinatorRef.current?.refetchSource(activeSrc, nextOpts);
  }, []);

  const handleOpenDirectoryFromSearch = useCallback((dirKind: string, initialFilter: string) => {
    setSearchQuery('');
    searchCoordinatorRef.current?.clear();
    setDirectoryInitialFilter(initialFilter);
    setActiveDirectoryKind(dirKind);
  }, [setSearchQuery]);

  const openGalleryView = useCallback((postOrUrl: TimelinePost | string) => {
    const url = typeof postOrUrl === 'string'
      ? postOrUrl.trim()
      : String(postOrUrl.albumUrl || postOrUrl.originalUrl || '').trim();
    if (!url) return;
    closeThreadView();
    const post = typeof postOrUrl === 'string' ? undefined : postOrUrl;
    const src = post ? sourceOf(post) : undefined;
    setGalleryStack((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].url === url) return prev;
      return [...prev, { url, post, source: src }];
    });
    const main = timelineRef.current?.closest('main');
    if (main) main.scrollTop = 0;
  }, [closeThreadView, sourceOf]);

  const closeGalleryView = useCallback(() => {
    setGalleryStack((prev) => prev.slice(0, -1));
  }, []);

  const handleSelectSource = useCallback((nextSource: TimelineSource) => {
    setSource(nextSource);
    setActiveDirectoryKind(null);
    setDirectoryInitialFilter('');
    setGalleryStack([]);
    closeThreadView();
    if (nextSource !== 'all') {
      const nextCaps = getSourceCapabilities(nextSource);
      const allowed = new Set((nextCaps.searchCategories || []).map((c) => c.toLowerCase()));
      setSearchCategory((prevCat) => {
        if (prevCat === 'all') return prevCat;
        if (prevCat === 'profiles' && (allowed.has('users') || allowed.has('profiles'))) return prevCat;
        if (prevCat === 'albums' && (allowed.has('albums') || allowed.has('photos'))) return prevCat;
        if (allowed.has(prevCat)) return prevCat;
        return 'all';
      });
    }
    if (query.length >= 2) {
      const nextOpts = nextSource !== 'all' ? searchOptionsRef.current[nextSource] : undefined;
      void searchCoordinatorRef.current?.ensureSourceFetched(nextSource, nextOpts);
    }
  }, [query.length, closeThreadView]);

  const handleSelectSearchCategory = useCallback((nextCategory: SearchCategoryTab) => {
    setSearchCategory(nextCategory);
    if (sourceRef.current !== 'all' && sourceRef.current !== 'x') return;
    if (nextCategory === 'albums') {
      void searchCoordinatorRef.current?.ensureCategoryXTab('photos');
    } else if (nextCategory === 'posts' && xPostsMode === 'latest') {
      void searchCoordinatorRef.current?.ensureCategoryXTab('latest');
    }
  }, [xPostsMode]);

  const handleChangeXPostsMode = useCallback((mode: 'top' | 'latest') => {
    setXPostsMode(mode);
    if (mode === 'latest' && (sourceRef.current === 'all' || sourceRef.current === 'x')) {
      void searchCoordinatorRef.current?.ensureCategoryXTab('latest');
    }
  }, []);

  const handleLoadMoreSearch = useCallback(async () => {
    const coord = searchCoordinatorRef.current;
    if (!coord || searchLoadingMore) return;
    setSearchLoadingMore(true);
    try {
      const activeOpts = source !== 'all' ? searchOptionsRef.current[source] : undefined;
      await coord.loadMore(source, searchCategory, activeOpts);
    } catch {
      // Aborted pagination cleanup
    } finally {
      setSearchLoadingMore(false);
    }
  }, [source, searchCategory, searchLoadingMore]);

  const openSearchPlaylist = useCallback(async (post: TimelinePost) => {
    playlistModalAbortRef.current?.abort();
    const controller = new AbortController();
    playlistModalAbortRef.current = controller;
    setActivePlaylistPost(post);
    setPlaylistModalVideos([]);
    setPlaylistModalError('');
    if (!post.originalUrl) {
      setPlaylistModalLoading(false);
      setPlaylistModalError(isEn ? 'Playlist URL is unavailable.' : 'A URL desta playlist está indisponível.');
      return;
    }
    setPlaylistModalLoading(true);
    try {
      const res = await fetchPlaylistVideos(post.originalUrl, controller.signal);
      if (controller.signal.aborted) return;
      const mapped = mapPlaylistVideosToTimelinePosts(
        { id: post.id, title: post.title, url: post.originalUrl },
        {
          id: post.creatorId,
          name: post.creatorName,
          handle: post.creatorHandle,
          avatar: post.creatorAvatar,
          site: post.source || 'generic',
        },
        res.videos || [],
        isEn,
      );
      setPlaylistModalVideos(mapped);
    } catch {
      if (!controller.signal.aborted) {
        setPlaylistModalError(isEn ? 'Unable to load playlist videos. Try again.' : 'Não foi possível carregar os vídeos da playlist. Tente novamente.');
      }
    } finally {
      if (playlistModalAbortRef.current === controller) {
        setPlaylistModalLoading(false);
      }
    }
  }, [isEn]);

  const closePlaylistModal = useCallback(() => {
    playlistModalAbortRef.current?.abort();
    setActivePlaylistPost(null);
    setPlaylistModalVideos([]);
    setPlaylistModalError('');
    setPlaylistModalLoading(false);
  }, []);

  useEffect(() => {
    if (!active) return;
    if (query.length < 2) {
      skipNextDebounceQueryRef.current = null;
      omniSearchSeqRef.current += 1;
      searchCoordinatorRef.current?.clear();
      setSearchCategory('all');
      setXPostsMode('top');
      setSearchLoadingInitial(false);
      return;
    }
    if (skipNextDebounceQueryRef.current === query) {
      skipNextDebounceQueryRef.current = null;
      return;
    }
    const controller = new AbortController();
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = window.setTimeout(() => {
      searchDebounceRef.current = null;
      void runOmniSearch(searchQuery, controller.signal);
    }, 400);
    return () => {
      if (searchDebounceRef.current !== null) {
        window.clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
      controller.abort();
    };
  }, [active, query, searchQuery, runOmniSearch]);

  useEffect(() => {
    const ytIntegrated = integratedSourceIds.has('youtube') || creatorSites.has('youtube');
    if (!active || source !== 'youtube' || !ytIntegrated || publishedImports.posts.length > 0) return;
    const ytCreators = creators.filter(c => (creatorSites.get(c.id) || 'generic') === 'youtube');
    const hasYtShorts = posts.some(p => sourceOf(p) === 'youtube' && /\/shorts\//i.test(p.originalUrl || ''));
    const hasYtCommunity = posts.some(p => sourceOf(p) === 'youtube' && /\/(?:post|community)\//i.test(p.originalUrl || ''));
    const hasYtPlaylists = ytCreators.some(c => (c.playlists?.length || 0) > 0);

    if (!ytDeepScannedRef.current && ytCreators.length > 0 && (!hasYtShorts || !hasYtCommunity || !hasYtPlaylists)) {
      ytDeepScannedRef.current = true;
      void (async () => {
        for (const ytCreator of ytCreators) {
          await discoverCreatorCatalog(ytCreator.id, undefined, false);
        }
      })();
    }

    const seedNames = ytCreators.slice(0, 3).map(c => c.name).filter(Boolean).join(' ');
    if (ytRecommendedPosts.length === 0 && seedNames) {
      const controller = new AbortController();
      const seed = `${seedNames} official videos shorts`;
      void fetch(`/api/profile-hub/timeline/youtube-recommendations?seed=${encodeURIComponent(seed)}`, {
        signal: controller.signal,
      })
        .then(r => (r.ok ? r.json() : null))
        .then(data => {
          if (data?.ok && Array.isArray(data.posts) && !controller.signal.aborted) {
            setYtRecommendedPosts(data.posts);
          }
        })
        .catch(() => {});
      return () => controller.abort();
    }
  }, [active, source, creators, creatorSites, integratedSourceIds, posts, sourceOf, discoverCreatorCatalog, ytRecommendedPosts.length, publishedImports.posts.length]);

  const dynamicBrowseSourceIds = useMemo(
    () => Object.keys(browseCapabilities).filter(Boolean),
    [browseCapabilities]
  );

  const availableSources = useMemo(
    () =>
      deriveActiveTimelineSources({
        integratedSources,
        integratedSourcesStatus,
        browseCapabilities,
        creatorSites: creatorSites.values(),
        postSources: combinedFeed.posts.map(sourceOf),
        activeSource: source,
      }),
    [integratedSources, integratedSourcesStatus, browseCapabilities, creatorSites, combinedFeed.posts, sourceOf, source]
  );

  const platformBreakdown = useMemo(() => {
    const postCounts = new Map<TimelinePlatform, number>();
    const creatorCounts = new Map<TimelinePlatform, number>();
    for (const c of combinedFeed.creators) {
      const site = (creatorSites.get(c.id) || 'generic') as TimelinePlatform;
      creatorCounts.set(site, (creatorCounts.get(site) || 0) + 1);
    }
    for (const p of combinedFeed.posts) {
      if (!creatorSites.has(p.creatorId)) continue;
      const site = (sourceOf(p) || 'generic') as TimelinePlatform;
      postCounts.set(site, (postCounts.get(site) || 0) + 1);
    }
    if (canShowX && xFeed?.items?.length) {
      const xPostLen = xFeed.items.filter(item => 'id' in item).length;
      postCounts.set('x', (postCounts.get('x') || 0) + xPostLen);
    }
    for (const sid of dynamicBrowseSourceIds) {
      const bCount = browseFeedsBySource[sid]?.items?.length || 0;
      if (bCount > 0 && (postCounts.get(sid) || 0) === 0) {
        postCounts.set(sid, bCount);
      }
    }
    const order = Array.from(
      new Set<TimelinePlatform>([
        ...integratedSources.map((row) => row.id.toLowerCase()),
        ...(integratedSourcesStatus === 'unavailable' ? dynamicBrowseSourceIds : []),
        ...Array.from(creatorCounts.keys()),
        ...Array.from(postCounts.keys()),
      ])
    ).filter((site) => Boolean(site) && site !== 'all');
    const alwaysShow = new Set<string>([
      ...integratedSourceIds,
      ...(integratedSourcesStatus === 'unavailable' ? dynamicBrowseSourceIds : []),
    ]);
    return order
      .map(site => ({
        site,
        posts: postCounts.get(site) || 0,
        creators: creatorCounts.get(site) || 0,
      }))
      .filter(entry => entry.posts > 0 || entry.creators > 0 || alwaysShow.has(entry.site))
      .sort((a, b) => {
        const aActive = a.posts > 0 || a.creators > 0 ? 1 : 0;
        const bActive = b.posts > 0 || b.creators > 0 ? 1 : 0;
        if (bActive !== aActive) return bActive - aActive;
        if (b.posts !== a.posts) return b.posts - a.posts;
        return b.creators - a.creators;
      });
  }, [
    combinedFeed.creators,
    combinedFeed.posts,
    creatorSites,
    sourceOf,
    canShowX,
    xFeed?.items,
    browseFeedsBySource,
    dynamicBrowseSourceIds,
    integratedSources,
    integratedSourceIds,
    integratedSourcesStatus,
  ]);
  const activeSourceCaps = useMemo(
    () => (source !== 'all' ? getSourceCapabilities(source) : null),
    [source, browseCapabilities]
  );
  const isVisualBrowseSource = Boolean(
    source !== 'all' && (
      browseCapabilities[source]
      || activeSourceCaps?.archetype === 'gallery_catalog'
      || activeSourceCaps?.archetype === 'forum_board'
    )
  );
  const currentBrowseSubfilter = browseSubfilters[source] ?? null;
  const activeBrowseSlice = isVisualBrowseSource ? browseFeedsBySource[source] : undefined;
  const activeBrowseSubfilters = useMemo(
    () => {
      const staticSubs = browseCapabilities[source]?.subfilters || [];
      const dynSubs = dynamicSubfiltersBySource[source] || activeBrowseSlice?.dynamicSubfilters || [];
      if (dynSubs.length === 0) return staticSubs;
      const seen = new Set(staticSubs.map((s) => s.id));
      return [...staticSubs, ...dynSubs.filter((s) => !seen.has(s.id))];
    },
    [browseCapabilities, dynamicSubfiltersBySource, activeBrowseSlice?.dynamicSubfilters, source]
  );
  const tBrowse = (translations[isEn ? 'en-US' : 'pt-BR'] as any).timelineBrowse || {};
  const catalogMode = source === 'all'
    ? (activeFilter === 'para_voce' ? 'recommended' : 'recent')
    : sourceModes[source] ?? catalogModes(source)[0];
  const activeLayoutMode = isVisualBrowseSource && visualScopeMode === 'discover'
    ? (activeSourceCaps?.layoutMode || 'standard')
    : 'standard';
  const mediaGrid = xProfile ? xProfileMode === 'media'
    : activeLayoutMode === 'forum_index'
      ? false
      : (isVisualBrowseSource
          ? catalogMode !== 'posts'
          : Boolean(catalogMode && ['videos', 'shorts', 'playlists', 'photos', 'reels', 'albums', 'gifs'].includes(catalogMode)));
  useEffect(() => {
    if (active) {
      void loadIntegratedSources();
      void hydrateBrowseCapabilities();
    }
  }, [active, loadIntegratedSources, hydrateBrowseCapabilities]);
  useEffect(() => {
    if (!active || activeLayoutMode !== 'category_showcase' || selectedCreatorId || query.length >= 2) return;
    void loadDirectory(source, 'categories', 1);
  }, [active, activeLayoutMode, source, selectedCreatorId, query.length, loadDirectory]);
  useEffect(() => {
    if (!active || !isVisualBrowseSource || selectedCreatorId || query.length >= 2) return;
    if (visualScopeMode === 'discover') {
      void loadBrowseFeed(source, catalogMode, currentBrowseSubfilter);
    }
  }, [
    active,
    isVisualBrowseSource,
    source,
    catalogMode,
    visualScopeMode,
    currentBrowseSubfilter,
    selectedCreatorId,
    query.length,
    loadBrowseFeed,
  ]);
  useEffect(() => {
    if (!active || !isVisualBrowseSource) return;
    if (activeDirectoryKind === 'boards') {
      void loadForumBoards(source);
    } else if (activeDirectoryKind) {
      void loadDirectory(source, activeDirectoryKind, 1);
    }
  }, [active, isVisualBrowseSource, source, activeDirectoryKind, loadForumBoards, loadDirectory]);
  useEffect(() => {
    if (!active || query.length < 2 || source === 'all') return;
    if (activeSourceCaps?.searchOptions?.supportsBoardFilter) {
      void loadForumBoards(source);
    }
  }, [active, query.length, source, activeSourceCaps?.searchOptions?.supportsBoardFilter, loadForumBoards]);
  const useSourceMode = (mode: CatalogMode) => {
    if (source === 'all') setActiveFilter(mode === 'recommended' ? 'para_voce' : 'recentes');
    else setSourceModes(current => ({...current, [source]: mode}));
  };
  const xItems = useMemo(() => canShowX
    ? (xFeed?.items ?? []).filter((item): item is XPost => 'id' in item &&
      (!xProfile || xProfileMode === 'posts' || Boolean(item.photos.length || item.video || item.hasVideo)))
    : [], [canShowX, xFeed?.items, xProfile, xProfileMode]);
  const xPostsById = useMemo(() => new Map(xItems.map(item => [xPostId(item), item])), [xItems]);
  const playlistPosts = useMemo<TimelinePost[]>(() => {
    const out: TimelinePost[] = [];
    for (const creator of combinedFeed.creators) {
      const cSite = creatorSites.get(creator.id) || 'generic';
      if (source !== 'all' && cSite !== source) continue;
      for (const pl of creator.playlists || []) {
        out.push({
          id: `pl-post-${creator.id}-${pl.id}`,
          creatorId: creator.id,
          creatorName: creator.name,
          creatorHandle: creator.handle,
          creatorAvatar: creator.avatar,
          creatorVerified: creator.verified,
          type: 'playlist',
          source: cSite,
          title: pl.title,
          thumbnail: pl.thumbnailUrl || creator.avatar,
          originalUrl: pl.url || creator.profileUrl,
          videoCount: pl.videoCount,
          photoCount: pl.videoCount,
          views: pl.videoCount ? `${pl.videoCount} videos` : undefined,
          date: pl.updatedAt || '',
          comments: [],
          likes: null,
          liked: false,
          favorited: false,
          saved: false,
        });
      }
    }
    return out;
  }, [combinedFeed.creators, creatorSites, source]);
  const displayedPosts = useMemo(() => {
    const livePosts: TimelinePost[] = xItems.map(item => ({
      id: xPostId(item), creatorId: `x:${item.handle.toLowerCase()}`, creatorName: item.name,
      creatorHandle: item.handle, creatorAvatar: item.avatar || '', title: item.text || item.name,
      type: 'text', text: item.text, date: item.date, originalUrl: item.url,
      source: 'x', comments: [], likes: item.metrics.likes ?? null,
    }));
    const sourceKeys = new Set(livePosts.map(post => timelinePostSourceKey(post.originalUrl || '')).filter(Boolean));
    const scopedToX = Boolean(xProfile) || (source === 'x' && xTab !== 'recommended');
    const basePool = catalogMode === 'playlists' ? [...playlistPosts, ...combinedFeed.posts] : combinedFeed.posts;
    const savedPosts = scopedToX ? [] : basePool.filter(post => {
      if (!creatorSites.has(post.creatorId) || (source !== 'all' && sourceOf(post) !== source)) return false;
      const key = post.originalUrl && sourceOf(post) === 'x' ? timelinePostSourceKey(post.originalUrl) : '';
      if ((key && sourceKeys.has(key)) || (catalogMode && !matchesCatalogMode(post, catalogMode))) return false;
      if (key) sourceKeys.add(key);
      return true;
    });
    const ytDiscoveryExtras =
      !scopedToX && source === 'youtube' && publishedImports.posts.length === 0 && ytRecommendedPosts.length > 0
        ? ytRecommendedPosts.filter(post => {
            const key = timelinePostSourceKey(post.originalUrl || post.id);
            if (key && sourceKeys.has(key)) return false;
            if (catalogMode && !matchesCatalogMode(post, catalogMode)) return false;
            if (key) sourceKeys.add(key);
            return true;
          })
        : [];
    const discoverPosts =
      isVisualBrowseSource && visualScopeMode === 'discover'
        ? (activeBrowseSlice?.items ?? [])
        : [];
    const candidates = source === 'x'
      ? [...livePosts, ...savedPosts]
      : (isVisualBrowseSource && visualScopeMode === 'discover')
        ? discoverPosts
        : [...savedPosts, ...ytDiscoveryExtras, ...livePosts];
    const searchedPosts = query && !scopedToX
      ? candidates.filter(post => [post.title, post.caption, post.text, post.creatorName, post.creatorHandle]
        .some(value => value?.toLowerCase().includes(query)))
      : candidates;
    if (scopedToX || source === 'x' || (isVisualBrowseSource && visualScopeMode === 'discover')) return searchedPosts;
    if (catalogMode === 'popular') {
      return sortTimelinePostsByPublication(searchedPosts).sort((a, b) => sourceViewCount(b) - sourceViewCount(a));
    }
    if (catalogMode === 'recommended') {
      return rankForYouPosts(searchedPosts, {
        creators: combinedFeed.creators,
        history: libraryHistory,
        liked: libraryLiked,
        favorites: libraryFavorites,
        playlists: libraryPlaylists,
        likedPostIds,
        favoritedPostIds,
        savedPostIds,
      });
    }
    return sortTimelinePostsByPublication(searchedPosts);
  }, [
    catalogMode,
    combinedFeed,
    creatorSites, source, sourceOf, xItems, xProfile, xTab,
    playlistPosts,
    ytRecommendedPosts,
    publishedImports.posts.length,
    isVisualBrowseSource,
    visualScopeMode,
    activeBrowseSlice?.items,
    query,
    libraryHistory,
    libraryLiked,
    libraryFavorites,
    libraryPlaylists,
    likedPostIds,
    favoritedPostIds,
    savedPostIds,
  ]);
  const activeIdx = displayedPosts.findIndex(post => post.id === activeAutoplayPostId);
  // Local text cards must not block the existing native prefetch handoff.
  const nextNativePostId = activeIdx < 0 ? undefined
    : displayedPosts.slice(activeIdx + 1).find(post => !isOfflineTimelinePost(post) && !xPostsById.has(post.id))?.id;
  const feedWindowKey = JSON.stringify([catalogMode, query, source, xTarget.key, xProfile ? xProfileMode : null]);
  const feedCount = feedWindow.key === feedWindowKey
    ? feedWindow.count : Math.max(feedWindows.current.get(feedWindowKey) ?? 0, feedPageSize);
  if (feedWindow.key === feedWindowKey && activeAutoplayPostId && activeIdx >= 0 &&
      (activeIdx < feedCount || mountedFeedPostIdsRef.current.has(activeAutoplayPostId))) {
    pinnedFeedPostRef.current = activeAutoplayPostId;
  }
  const pinnedFeedPostId = feedWindow.key === feedWindowKey ? pinnedFeedPostRef.current : null;
  // Keep a playing/handoff card's keyed node even if new posts push it beyond the prefix.
  const renderedFeedPosts = displayedPosts.filter((post, index) => index < feedCount || post.id === pinnedFeedPostId);
  useEffect(() => {
    if (!active) return;
    const candidates = renderedFeedPosts
      .filter((p) => {
        const postSource = sourceOf(p);
        const caps = getSourceCapabilities(postSource, p);
        if (caps.archetype !== 'gallery_catalog') return false;
        if (!(p.originalUrl || p.albumUrl)) return false;
        const needsPhotoHydration =
          p.photoCount == null || (Array.isArray(p.photos) ? p.photos.length <= 1 : true);
        return Boolean(p.needsEnrichment || needsPhotoHydration || /^\d+$/.test((p.title || '').trim()));
      })
      .map((p) => ({
        url: String(p.originalUrl || p.albumUrl || ''),
        source: String(sourceOf(p) || source),
      }))
      .filter((c) => Boolean(c.url));
    if (candidates.length > 0) {
      void queueCatalogEnrichment(candidates);
    }
  }, [active, renderedFeedPosts, source, sourceOf, queueCatalogEnrichment]);
  useLayoutEffect(() => {
    mountedFeedPostIdsRef.current = new Set(renderedFeedPosts.map(post => post.id));
    feedWindows.current.set(feedWindowKey, feedCount);
  });
  const hasMoreFeedPosts = renderedFeedPosts.length < displayedPosts.length;
  const expandFeed = useCallback(() => {
    setFeedWindow(current => ({key: feedWindowKey, count: (current.key === feedWindowKey ? current.count : feedPageSize) + feedPageSize}));
  }, [feedWindowKey, feedPageSize]);

  const hasXMore = canShowX && !selectedCreatorId && xFeed?.status === 'ready' && !xFeed.error;
  const browseXMore = hasXMore && !xFeed.loading;
  const hasBrowseMore = isVisualBrowseSource && visualScopeMode === 'discover' && Boolean(activeBrowseSlice?.hasMore);
  const loadMoreFeed = useCallback((manual = false) => {
    if (hasMoreFeedPosts || browseXMore || hasBrowseMore) expandFeed();
    if (hasBrowseMore) void loadMoreBrowseFeed(source);
    if (browseXMore && (manual || !xFeed?.paused)) void loadX(xTarget);
  }, [browseXMore, expandFeed, hasBrowseMore, hasMoreFeedPosts, loadMoreBrowseFeed, loadX, source, xFeed?.paused, xTarget]);

  useLayoutEffect(() => {
    if (feedWindow.key !== feedWindowKey) {
      pinnedFeedPostRef.current = null;
      setFeedWindow({key: feedWindowKey, count: feedCount});
    }
  }, [feedWindowKey, feedWindow.key, feedCount]);

  useLayoutEffect(() => {
    if (!active || watchSession || selectedCreatorId) return;
    const list = feedListRef.current;
    const firstCard = list?.querySelector<HTMLElement>('[data-timeline-post-id]');
    const main = timelineRef.current?.closest('main');
    if (!list || !firstCard || !main) return;
    const measure = () => {
      const cardHeight = firstCard.getBoundingClientRect().height;
      const viewportHeight = main.clientHeight;
      if (cardHeight <= 0 || viewportHeight <= 0) return;
      const listStyle = getComputedStyle(list);
      const gap = parseFloat(listStyle.rowGap) || parseFloat(getComputedStyle(firstCard.nextElementSibling || firstCard).marginTop) || 0;
      const columns = listStyle.display === 'grid' ? listStyle.gridTemplateColumns.split(' ').length : 1;
      const rawPageSize = Math.max(FEED_UNMEASURED_CARD_COUNT, Math.ceil(viewportHeight * (1 + FEED_BUFFER_VIEWPORTS) / (cardHeight + gap)) * columns);
      const pageSize = Math.min(mediaGrid ? 8 : 4, rawPageSize);
      setFeedPageSize(pageSize);
      // Resize can fill the viewport, but never discard cards already reached.
      setFeedWindow(current => ({key: feedWindowKey, count: Math.max(current.key === feedWindowKey ? current.count : 0, pageSize)}));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(main); observer.observe(firstCard);
    return () => observer.disconnect();
  }, [active, feedWindowKey, mediaGrid, renderedFeedPosts[0]?.id, watchSession, selectedCreatorId]);

  useLayoutEffect(() => {
    const main = timelineRef.current?.closest('main');
    if (!main) return;
    if (xProfile) {
      main.scrollTop = 0;
      xProfileHeading.current?.focus({preventScroll: true});
      return;
    }
    const anchor = xProfileReturn.current;
    if (!anchor) return;
    const entry = Array.from(timelineRef.current?.querySelectorAll<HTMLElement>('[data-x-entry]') || [])
      .find(card => card.dataset.xEntry === anchor.card);
    const trigger = entry?.matches('button') ? entry : entry?.querySelector('button');
    main.scrollTop = trigger ? main.scrollTop + trigger.getBoundingClientRect().top - anchor.top : anchor.scroll;
    trigger?.focus({preventScroll: true});
    xProfileReturn.current = undefined;
  }, [xProfile]);

  useEffect(() => {
    if (!active || (!hasMoreFeedPosts && (!browseXMore || xFeed?.paused) && !hasBrowseMore) || watchSession || selectedCreatorId) return;
    const main = timelineRef.current?.closest('main');
    const sentinel = feedSentinelRef.current;
    if (!main || !sentinel) return;
    let armed = false;
    let touchY: number | undefined;
    let loadedOnTouch = false;
    const checkEnd = () => {
      if (!armed) return;
      const end = sentinel.getBoundingClientRect();
      const viewport = main.getBoundingClientRect();
      if (end.top < viewport.bottom + 120 && end.bottom > viewport.top) {
        armed = false;
        if (touchY !== undefined) loadedOnTouch = true;
        loadMoreFeed();
      }
    };
    // Intersection alone (including new data/layout/return from watch) never expands.
    // A fresh downward input is required for every automatic batch.
    const wheel = (event: WheelEvent) => { if (event.deltaY > 0) { armed = true; checkEnd(); } };
    const touchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
      loadedOnTouch = false;
    };
    const checkTouch = (nextY?: number) => {
      if (loadedOnTouch || touchY === undefined || nextY === undefined || nextY >= touchY - 8) return;
      armed = true;
      checkEnd();
    };
    const touchMove = (event: TouchEvent) => checkTouch(event.touches[0]?.clientY);
    const touchEnd = (event: TouchEvent) => {
      checkTouch(event.changedTouches[0]?.clientY);
      touchY = undefined;
    };
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) && !event.shiftKey) { armed = true; checkEnd(); }
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(checkEnd, {root: main});
    observer?.observe(sentinel);
    main.addEventListener('wheel', wheel, {passive:true});
    main.addEventListener('touchstart', touchStart, {passive:true});
    main.addEventListener('touchmove', touchMove, {passive:true});
    main.addEventListener('touchend', touchEnd, {passive:true});
    main.addEventListener('keydown', key);
    main.addEventListener('scroll', checkEnd, {passive:true});
    return () => {
      observer?.disconnect();
      main.removeEventListener('wheel', wheel); main.removeEventListener('touchstart', touchStart);
      main.removeEventListener('touchmove', touchMove); main.removeEventListener('keydown', key);
      main.removeEventListener('touchend', touchEnd);
      main.removeEventListener('scroll', checkEnd);
    };
  }, [active, hasMoreFeedPosts, browseXMore, hasBrowseMore, xFeed?.paused, watchSession, selectedCreatorId, loadMoreFeed, feedCount]);

  useLayoutEffect(() => {
    if (!active) return;
    const id = pendingFeedFocusRef.current;
    if (!id) return;
    const card = Array.from(feedListRef.current?.querySelectorAll<HTMLElement>('[data-timeline-post-id]') || []).find(element => element.dataset.timelinePostId === id);
    const control = card?.querySelector<HTMLElement>('button, a[href], [tabindex="0"]');
    if (control) { control.focus({preventScroll:true}); pendingFeedFocusRef.current = null; }
  }, [active, feedCount]);

  // Autoplay automático do primeiro vídeo (incluindo vídeos do X) quando o feed carrega
  useEffect(() => {
    if (active && !watchSession && !selectedCreatorId && activeIdx === -1) {
      const firstVideo = displayedPosts.find(p => {
        if (p.type === 'video' || p.type === 'gif') return true;
        const liveX = xPostsById.get(p.id);
        return Boolean(liveX && (liveX.video || liveX.hasVideo));
      });
      if (firstVideo) {
        setActiveAutoplayPostId(firstVideo.id);
      } else if (activeAutoplayPostId) setActiveAutoplayPostId(null);
    }
  }, [active, watchSession, selectedCreatorId, activeAutoplayPostId, activeIdx, displayedPosts, xPostsById, setActiveAutoplayPostId]);

  // App's main owns scrolling. Keep the feed position locally while a profile is open,
  // and drive mobile headroom header collapse/reveal smoothly on scroll.
  const prevMobileScrollTopRef = useRef(0);
  const chromeTransitionLockUntilRef = useRef(0);
  const effectiveChromeCollapsedRef = useRef(effectiveChromeCollapsed);
  effectiveChromeCollapsedRef.current = effectiveChromeCollapsed;
  useEffect(() => {
    if (!active) return;
    const container = timelineRef.current?.closest('main');
    if (!container) return;
    const lockedOpen =
      effectiveMobileSearchOpen ||
      effectiveSourcesSheetOpen ||
      query.length >= 2 ||
      Boolean(watchSession) ||
      Boolean(creatorEntry);
    const onMainScroll = () => {
      if (!watchRef.current && !currentCreatorRef.current) feedScrollRef.current = container.scrollTop;
      if (!isMobileOnly) return;
      if (lockedOpen) {
        prevMobileScrollTopRef.current = container.scrollTop;
        if (effectiveChromeCollapsedRef.current) {
          setEffectiveChromeCollapsed(false);
        }
        return;
      }
      // Ignore layout-shift / scroll-anchoring adjustments while chrome collapse transition runs,
      // but never trap the header collapsed when scrollTop returns to the top of <main>.
      if (
        container.scrollTop > 16 &&
        typeof performance !== 'undefined' &&
        performance.now() < chromeTransitionLockUntilRef.current
      ) {
        prevMobileScrollTopRef.current = container.scrollTop;
        return;
      }
      const next = computeMobileChromeCollapsed(
        effectiveChromeCollapsedRef.current,
        container.scrollTop,
        prevMobileScrollTopRef.current,
        lockedOpen
      );
      prevMobileScrollTopRef.current = container.scrollTop;
      if (next !== effectiveChromeCollapsedRef.current) {
        if (typeof performance !== 'undefined') {
          chromeTransitionLockUntilRef.current = performance.now() + 340;
        }
        setEffectiveChromeCollapsed(next);
      }
    };
    onMainScroll();
    container.addEventListener('scroll', onMainScroll, { passive: true });
    return () => container.removeEventListener('scroll', onMainScroll);
  }, [active, isMobileOnly, effectiveMobileSearchOpen, effectiveSourcesSheetOpen, query.length, watchSession, creatorEntry, setEffectiveChromeCollapsed]);

  const prevGalleryOpenRef = useRef(Boolean(activeGallery));
  useLayoutEffect(() => {
    const wasGalleryOpen = prevGalleryOpenRef.current;
    const isGalleryOpen = Boolean(activeGallery);
    prevGalleryOpenRef.current = isGalleryOpen;
    if (!active || !isMobileOnly || !(wasGalleryOpen && !isGalleryOpen)) return;
    if (effectiveChromeCollapsedRef.current) {
      if (typeof performance !== 'undefined') {
        chromeTransitionLockUntilRef.current = performance.now() + 340;
      }
      setEffectiveChromeCollapsed(false);
    }
    const container = timelineRef.current?.closest('main');
    if (container && container.scrollTop !== 0 && container.scrollTop <= 160) {
      container.scrollTop = 0;
      prevMobileScrollTopRef.current = 0;
    }
  }, [active, isMobileOnly, activeGallery, setEffectiveChromeCollapsed]);

  const feedNavKey = !selectedCreatorId && !creatorEntry && !watchSession && !xProfile && !activeXPost
    ? `${source}|${catalogMode}|${visualScopeMode}|${currentBrowseSubfilter || ''}|${activeDirectoryKind || ''}|${xTab}`
    : null;
  const prevFeedNavKeyRef = useRef<string | null>(feedNavKey);
  useLayoutEffect(() => {
    if (!feedNavKey) {
      prevFeedNavKeyRef.current = null;
      return;
    }
    const prevKey = prevFeedNavKeyRef.current;
    prevFeedNavKeyRef.current = feedNavKey;
    if (!active || !isMobileOnly || prevKey === null || prevKey === feedNavKey) return;
    const container = timelineRef.current?.closest('main');
    if (effectiveChromeCollapsedRef.current) {
      if (typeof performance !== 'undefined') {
        chromeTransitionLockUntilRef.current = performance.now() + 340;
      }
      setEffectiveChromeCollapsed(false);
    }
    if (container && container.scrollTop !== 0) {
      container.scrollTop = 0;
    }
    prevMobileScrollTopRef.current = 0;
  }, [active, isMobileOnly, feedNavKey, setEffectiveChromeCollapsed]);

  const handleIntegrateOptionA = useCallback(async (rawUrl: string) => {
    const res = await integrateSourceUrl(rawUrl);
    searchCoordinatorRef.current?.invalidateSources();
    if (res.ok && res.integration?.sourceId) {
      const matchedId = res.integration.sourceId as TimelineSource;
      handleSelectSource(matchedId);
      setDesktopOptInUrl('');
      setDesktopOptInInvalid(false);
      if (res.targetProfileUrl) {
        openWatchCreator(res.targetProfileUrl, {
          name: res.integration.suggestedHandle || res.integration.displayName,
        });
      }
    }
    return res;
  }, [integrateSourceUrl, handleSelectSource, openWatchCreator]);

  const handleRemoveNetwork = useCallback(async (sid: string) => {
    await removeIntegratedSource(sid);
    searchCoordinatorRef.current?.invalidateSources();
    if (source === sid) {
      handleSelectSource('all');
    }
  }, [removeIntegratedSource, source, handleSelectSource]);

  const handleResetNetworks = useCallback(async () => {
    await resetIntegratedSources();
    searchCoordinatorRef.current?.invalidateSources();
    handleSelectSource('all');
  }, [resetIntegratedSources, handleSelectSource]);

  useLayoutEffect(() => {
    if (!active || previousCreatorRef.current === selectedCreatorId) return;
    const container = timelineRef.current?.closest('main');
    if (container && !selectedCreatorId) {
      const anchor = catalogProfileReturn.current;
      const control = anchor?.postId
        ? Array.from(feedListRef.current?.querySelectorAll<HTMLElement>('[data-timeline-post-id]') ?? [])
          .find(post => post.dataset.timelinePostId === anchor.postId)?.querySelector<HTMLElement>('[data-post-creator-id]')
        : Array.from(timelineRef.current?.querySelectorAll<HTMLElement>('button[data-creator-id]') ?? [])
          .find(button => button.dataset.creatorId === anchor?.creatorId);
      container.scrollTop = control && anchor?.top !== undefined
        ? container.scrollTop + control.getBoundingClientRect().top - anchor.top : feedScrollRef.current;
      control?.focus({preventScroll: true});
      catalogProfileReturn.current = undefined;
    } else if (container) container.scrollTop = 0;
    previousCreatorRef.current = selectedCreatorId;
  }, [active, selectedCreatorId]);

  const selectedCreator = selectedCreatorId ? creatorProfiles?.[selectedCreatorId] || creators.find(c => c.id === selectedCreatorId) : undefined;
  const refreshCreators = selectedCreator ? [selectedCreator] : source === 'all' ? creators
    : creators.filter(creator => (creatorSites.get(creator.id) ?? 'generic') === source);
  const canRefreshSource = source === 'all' || isVisualBrowseSource || (source === 'x' ? xFeed?.status === 'ready' : refreshCreators.length > 0);
  const isRefreshingScope = selectedCreator
    ? Boolean(isDiscoveringCreator[selectedCreator.id])
    : (isVisualBrowseSource && visualScopeMode === 'discover')
      ? Boolean(activeBrowseSlice?.isLoading)
      : (source === 'all' && isRefreshingTimeline) || refreshCreators.some(creator => isDiscoveringCreator[creator.id]);
  const scopeRefreshFailed = refreshCreators.some(creator => creatorRefreshErrors[creator.id]);
  const refreshIconClass = `w-3.5 h-3.5 ${isRefreshingScope && !disableAllAnimations ? 'animate-spin motion-reduce:animate-none' : ''}`;
  const refreshButtonClass = 'flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl bg-[var(--tl-surface)] border border-[var(--tl-border)] text-xs font-semibold text-[var(--tl-text-secondary)] hover:text-[var(--tl-text-primary)] hover:border-[var(--tl-accent-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tl-accent-hover)] disabled:opacity-50 disabled:cursor-wait transition-colors shrink-0';
  const hasEntries = xAccounts ? Boolean(xFeed?.items.length) : displayedPosts.length > 0;
  const xLoading = canShowX && (!xFeed || xFeed.loading);
  const initialLoading = !hasEntries && (xLoading || Boolean(isVisualBrowseSource && visualScopeMode === 'discover' && activeBrowseSlice?.isLoading) || (!xProfile && !xAccounts && (isLoading || isRefreshingScope)));
  const loadingMore = hasEntries && (Boolean(canShowX && xFeed?.loading && xFeed.offset > 0) || Boolean(isVisualBrowseSource && visualScopeMode === 'discover' && activeBrowseSlice?.isLoadingMore));
  const catalogError = !xProfile && source !== 'x'
    ? ((isVisualBrowseSource && visualScopeMode === 'discover' ? activeBrowseSlice?.error : null) || error)
    : null;
  const xConnectionRequired = xFeed?.error === 'connection_required' || xFeed?.error === 'extension_reload_required';
  const xExtensionReloadRequired = xFeed?.error === 'extension_reload_required';
  const xError = canShowX && xFeed && !xFeed.loading && (xFeed.error || xFeed.status === 'login_required')
    ? xExtensionReloadRequired
      ? (isEn
          ? 'Reload the IMAGEX · X extension once at chrome://extensions (or click Connect X) to load this X view.'
          : 'Recarregue a extensão IMAGEX · X uma vez em chrome://extensions (ou clique em Conectar X) para carregar esta tela do X.')
      : xConnectionRequired
        ? (isEn ? 'Connect X to include posts from your account.' : 'Conecte o X para incluir posts da sua conta.')
        : xFeed.status === 'login_required' && !xFeed.error
          ? (isEn ? 'Sign in to X in the browser window and try again.' : 'Entre no X na janela do navegador e tente novamente.')
          : (isEn ? 'Could not read this view on X.' : 'Não foi possível ler esta tela do X.')
    : null;
  const xPageError = Boolean(xError && hasEntries && xFeed && xFeed.offset > 0);
  const xNotice = xError && <TimelineFeedNotice kind="error" action={
    <button type="button" className={`${refreshButtonClass} min-h-11`}
      onClick={() => {
        feedListRef.current?.focus({preventScroll: true});
        void loadX(xTarget, false, xConnectionRequired);
      }}>
      {xConnectionRequired ? (isEn ? 'Connect X' : 'Conectar X') : (isEn ? 'Try again' : 'Tentar novamente')}
    </button>
  }>{xError}</TimelineFeedNotice>;
  const moreLabel = xAccounts ? (isEn ? 'Load more accounts' : 'Carregar mais perfis')
    : (isEn ? 'Load more posts' : 'Carregar mais publicações');
  const activeCommentPost = (activeCustomCommentPost && activeCustomCommentPost.id === activeCommentsPostId ? activeCustomCommentPost : null)
    || displayedPosts.find(post => post.id === activeCommentsPostId)
    || posts.find(post => post.id === activeCommentsPostId)
    || creatorEntry?.value.snapshot?.posts.find(post => post.id === activeCommentsPostId)
    || null;

  const activeWatchIndex = watchEntries.findIndex(entry => entry.token === activeWatchToken);
  const cachedWatchEntries = watchEntries.slice(Math.max(0, activeWatchIndex - WATCH_UI_NEIGHBOR_RADIUS), Math.max(0, activeWatchIndex) + WATCH_UI_NEIGHBOR_RADIUS + 1);

  return (
    <div
      ref={timelineRef}
      data-disable-animations={disableAllAnimations ? 'true' : undefined}
      className={`w-full max-w-full min-w-0 text-[var(--tl-text-primary)] flex flex-col space-y-4 ${watchSession && !creatorEntry && !activeThreadView && !activeGallery ? 'max-w-7xl mx-auto' : 'tl-workspace mx-auto'}`}
    >
      {activeThreadView && !watchSession && (
        <ForumThreadReaderView
          threadState={activeThreadView}
          isEn={isEn}
          onBack={closeThreadView}
          onLoadPage={(pageOrUrl) => void loadThreadPage(pageOrUrl)}
          onOpenEntity={(entity) => {
            closeThreadView();
            if (entity.url) openWatchCreator(entity.url, { name: entity.name });
          }}
          onOpenLightbox={(imgs, idx, ttl, albUrl, items, expectedCount) =>
            openLightbox(imgs, idx, ttl, albUrl, items, expectedCount)
          }
        />
      )}
      {activeGallery && !watchSession && !activeThreadView && (
        <GalleryDetailView
          key={activeGallery.url}
          galleryUrl={activeGallery.url}
          seedPost={activeGallery.post}
          sourceLabel={activeGallery.source ? getTimelineSourceDisplayName(activeGallery.source, isEn ? 'en' : 'pt') : undefined}
          isEn={isEn}
          onBack={closeGalleryView}
          onOpenLightbox={(imgs, idx, ttl, albUrl, items, expectedCount) =>
            openLightbox(imgs, idx, ttl, albUrl, items, expectedCount)
          }
          onOpenEntity={(entity) => {
            if (entity.url) openWatchCreator(entity.url, { name: entity.name });
          }}
          onOpenRelatedGallery={(relPost) => openGalleryView(relPost)}
        />
      )}
      {cachedWatchEntries.map(entry => <div key={entry.token} data-watch-entry={entry.token} data-watch-active={active && !creatorEntry && entry.token === activeWatchToken} hidden={!!creatorEntry || entry.token !== activeWatchToken}>
        <TimelineWatchView onOpenCreator={openWatchCreator} initialSection={entry.value.section} onSectionChange={value => {if (entry.token === activeWatchToken) sectionSnapshotRef.current = value;}} session={entry.value.session} active={active && !creatorEntry && entry.token === activeWatchToken} onClose={closeWatch} onChangeVideo={openWatchSession} registerPlaybackSnapshot={entry.token === activeWatchToken ? snapshot => {playerSnapshotRef.current = snapshot;} : undefined}/>
      </div>)}
      {creatorEntries.map(profileEntry => {
        const snapCreator = profileEntry.value.snapshot?.creator;
        const entrySite = snapCreator ? resolveTimelinePlatform(snapCreator.profileUrl, snapCreator.site) : undefined;
        const entryCaps = entrySite ? getSourceCapabilities(entrySite) : undefined;
        const isCatalogHub = Boolean(entryCaps && (entryCaps.archetype === 'gallery_catalog' || entryCaps.archetype === 'forum_board'));
        const isVideoPortalHub = Boolean(entryCaps?.archetype === 'video_portal');
        const resolvedBackLabel =
          creatorEntries.length <= 1 && profileEntry.value.returnTo
            ? (profileEntry.value.returnTo.watchSession
                ? (isEn ? 'Back to Video' : 'Voltar ao vídeo')
                : (isEn ? 'Back' : 'Voltar'))
            : undefined;
        return (
        <div key={profileEntry.token} data-timeline-creator data-creator-active={!activeThreadView && !activeGallery && profileEntry.token === creatorEntry?.token} hidden={!!activeThreadView || !!activeGallery || profileEntry.token !== creatorEntry?.token} className="space-y-4">
        {!profileEntry.value.snapshot && <button type="button" onClick={closeCreator} className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-[var(--tl-text-secondary)] hover:text-[var(--tl-text-primary)] hover:bg-[var(--tl-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--tl-accent-hover)]"><ChevronLeft className="w-4 h-4"/>{creatorEntries.length <= 1 && profileEntry.value.returnTo?.watchSession ? (isEn ? 'Back to Video' : 'Voltar ao vídeo') : (isEn ? 'Back' : 'Voltar')}</button>}
        {creatorLoading && profileEntry.token === creatorEntry?.token && <p role="status" className="px-3.5 text-xs text-[var(--tl-text-muted)]">{isEn ? 'Loading profile…' : 'Carregando…'}</p>}
        {profileEntry.value.error && <div role="alert" className="px-3.5 text-xs text-[var(--tl-text-muted)]"><p>{profileEntry.value.snapshot?.incomplete ? (isEn ? 'Some profile content could not be loaded. Available content is preserved; try again to check the source.' : 'Parte do conteúdo do perfil não pôde ser carregada. O conteúdo disponível foi preservado; tente consultar a fonte novamente.') : (isEn ? 'Could not load the profile. Available content is preserved.' : 'Não foi possível carregar o perfil. O conteúdo disponível foi preservado.')}</p><button type="button" disabled={creatorLoading} onClick={() => {completedCreatorTokensRef.current.delete(profileEntry.token); settledCreatorTokensRef.current.delete(profileEntry.token); setCreatorAttempt(value => value + 1);}} className={refreshButtonClass}><RefreshCw className="w-3.5 h-3.5"/>{isEn ? 'Try again' : 'Tentar novamente'}</button></div>}
        {profileEntry.value.snapshot && (isCatalogHub ? (
          <CatalogEntityView
            key={profileEntry.value.url}
            creator={profileEntry.value.snapshot.creator}
            posts={profileEntry.value.snapshot.posts}
            isEn={isEn}
            isLoadingMore={isLoadingMoreProfile}
            onBack={closeCreator}
            onOpenGallery={(p) => openGalleryView(p)}
            onOpenThread={(p) => void openThreadView(p, p.title, sourceOf(p))}
            onOpenEntity={(entity) => {
              if (entity.url) openWatchCreator(entity.url, { name: entity.name });
            }}
            onOpenLightbox={openLightbox}
            onLoadMore={() => {
              const snap = profileEntry.value.snapshot;
              if (!snap?.creator?.id) return;
              void loadMoreCreatorProfileAlbums(snap.creator.id, snap.creator, snap.posts).then((updated) => {
                if (!updated || creatorEntryRef.current?.token !== profileEntry.token) return;
                creatorCacheRef.current.set(creatorEntryRef.current.value.url, updated);
                const next = {
                  token: profileEntry.token,
                  value: { ...creatorEntryRef.current.value, snapshot: updated },
                };
                creatorHistory.save(next.value);
                creatorEntryRef.current = next;
                setCreatorEntry(next);
                setCreatorEntries(creatorHistory.entries());
              });
            }}
          />
        ) : isVideoPortalHub ? (
          <VideoPortalProfileView
            key={profileEntry.value.url}
            creator={profileEntry.value.snapshot.creator}
            posts={profileEntry.value.snapshot.posts}
            isEn={isEn}
            backLabel={resolvedBackLabel}
            activeTab={(profileEntry.value.activeTab as VideoPortalProfileTab) || 'videos'}
            onActiveTabChange={(tab) => {
              if (creatorEntryRef.current?.token !== profileEntry.token) return;
              const next = { token: profileEntry.token, value: { ...creatorEntryRef.current.value, activeTab: tab } };
              creatorHistory.save(next.value);
              creatorEntryRef.current = next;
              setCreatorEntry(next);
              setCreatorEntries(creatorHistory.entries());
            }}
            isLoading={creatorLoading && profileEntry.token === creatorEntry?.token}
            isLoadingMore={isLoadingMoreProfile}
            onBack={closeCreator}
            onOpenVideo={openVideo}
            onOpenEntity={(entity) => {
              if (entity.url) {
                openWatchCreator(entity.url, { name: entity.name, avatar: entity.thumbnailUrl || null });
              }
            }}
            onOpenLightbox={openLightbox}
            onChangeSort={(sortKey) => {
              const snap = profileEntry.value.snapshot;
              if (!snap?.creator?.id) return;
              void switchCreatorProfileSort(snap.creator.id, sortKey, snap.creator).then((updated) => {
                if (!updated || creatorEntryRef.current?.token !== profileEntry.token) return;
                creatorCacheRef.current.set(creatorEntryRef.current.value.url, updated);
                const next = {
                  token: profileEntry.token,
                  value: { ...creatorEntryRef.current.value, snapshot: updated },
                };
                creatorHistory.save(next.value);
                creatorEntryRef.current = next;
                setCreatorEntry(next);
                setCreatorEntries(creatorHistory.entries());
              });
            }}
            onLoadMore={() => {
              const snap = profileEntry.value.snapshot;
              if (!snap?.creator?.id) return;
              void loadMoreCreatorProfileAlbums(snap.creator.id, snap.creator, snap.posts).then((updated) => {
                if (!updated || creatorEntryRef.current?.token !== profileEntry.token) return;
                creatorCacheRef.current.set(creatorEntryRef.current.value.url, updated);
                const next = {
                  token: profileEntry.token,
                  value: { ...creatorEntryRef.current.value, snapshot: updated },
                };
                creatorHistory.save(next.value);
                creatorEntryRef.current = next;
                setCreatorEntry(next);
                setCreatorEntries(creatorHistory.entries());
              });
            }}
          />
        ) : <>
          <AdaptiveProfileHeader
            creator={profileEntry.value.snapshot.creator}
            onBack={closeCreator}
            backLabel={
              creatorEntries.length <= 1 && profileEntry.value.returnTo
                ? (profileEntry.value.returnTo.watchSession
                    ? (isEn ? 'Back to Video' : 'Voltar ao vídeo')
                    : (isEn ? 'Back' : 'Voltar'))
                : undefined
            }
          />
          <AdaptiveProfileContent
            key={profileEntry.value.url}
            activeTab={profileEntry.value.activeTab}
            onActiveTabChange={tab => {
              if (creatorEntryRef.current?.token !== profileEntry.token) return;
              const next = {token:profileEntry.token,value:{...creatorEntryRef.current.value,activeTab:tab}};
              creatorHistory.save(next.value); creatorEntryRef.current = next; setCreatorEntry(next); setCreatorEntries(creatorHistory.entries());
            }}
            suspended={!active || profileEntry.token !== creatorEntry?.token}
            creator={profileEntry.value.snapshot.creator}
            posts={profileEntry.value.snapshot.posts}
            onOpenVideo={openVideo}
            onOpenProfile={id => {
              if (id.startsWith('http')) {
                openWatchCreator(id);
                return;
              }
              const creator = creatorProfiles[id] || profileEntry.value.snapshot?.creator;
              if (creator?.profileUrl) openWatchCreator(creator.profileUrl);
            }}
            onOpenEntity={(entity) => {
              if (entity.url) openWatchCreator(entity.url, { name: entity.name });
            }}
            onOpenThread={(p) => void openThreadView(p, p.title, sourceOf(p))}
            onOpenGallery={(p) => openGalleryView(p)}
            onLoadMoreProfile={() => {
              const snap = profileEntry.value.snapshot;
              if (!snap?.creator?.id) return;
              void loadMoreCreatorProfileAlbums(snap.creator.id, snap.creator, snap.posts).then((updated) => {
                if (!updated || creatorEntryRef.current?.token !== profileEntry.token) return;
                creatorCacheRef.current.set(creatorEntryRef.current.value.url, updated);
                const next = {
                  token: profileEntry.token,
                  value: { ...creatorEntryRef.current.value, snapshot: updated },
                };
                creatorHistory.save(next.value);
                creatorEntryRef.current = next;
                setCreatorEntry(next);
                setCreatorEntries(creatorHistory.entries());
              });
            }}
            isLoadingMoreProfile={isLoadingMoreProfile}
            onOpenComments={openComments}
            onOpenLightbox={openLightbox}
            isDesktop={!isMobileOnly}
          />
        </>)}
      </div>);})}
      <div hidden={!!watchSession || !!creatorEntry || !!activeThreadView || !!activeGallery} className="tl-feed-surface space-y-4"
        data-wide-feed={!selectedCreator || mediaGrid || undefined}>
      {!selectedCreator && <>
        <div className={isMobileOnly && effectiveChromeCollapsed ? 'tl-mobile-chrome-strip tl-mobile-chrome-strip--collapsed space-y-2.5' : 'tl-mobile-chrome-strip space-y-2.5'}>
        <div className={isMobileOnly && !effectiveMobileSearchOpen && query.length < 2 ? 'tl-mobile-search-slot tl-mobile-search-slot--collapsed' : 'tl-mobile-search-slot'}>
        <header className="tl-workspace-header">
          <div className="tl-workspace-title-group">
            <h2>Timeline</h2>
            {(source !== 'all' || (query.length >= 2 && searchSnapshot)) && (
              <span className="tl-workspace-badge">
                {query.length >= 2 && searchSnapshot
                  ? (() => {
                      const scoped = filterSnapshotBySourceAndCategory(searchSnapshot, source, 'all');
                      const count = scoped.profiles.length + getDeduplicatedAllItems(scoped).length;
                      const srcName = source === 'all'
                        ? (isEn ? 'All sources' : 'Todas as fontes')
                        : getTimelineSourceDisplayName(source, isEn ? 'en' : 'pt');
                      return `${srcName} · ${count} ${isEn ? 'results' : 'resultados'}`;
                    })()
                  : `${getTimelineSourceDisplayName(source, isEn ? 'en' : 'pt')} · ${displayedPosts.length} ${isEn ? 'items' : 'itens'}`}
              </span>
            )}
          </div>

          {/* YouTube-Style Top Omni-Search Bar across ALL integrated sources */}
          <form
            role="search"
            className="tl-omni-search-bar"
            onSubmit={e => {
              e.preventDefault();
              if (xProfile) setXProfile(undefined);
              if (xPostStack.length) setXPostStack([]);
              if (activeDirectoryKind) setActiveDirectoryKind(null);
              const direct = classifyTimelineDirectUrl(searchQuery);
              if (direct) {
                const label = getTimelineSourceDisplayName(direct.source, isEn ? 'en' : 'pt');
                if (direct.kind === 'video') {
                  const directPost: TimelinePost = {
                    id: `direct-${direct.source}-${direct.url}`,
                    creatorId: `${direct.source}:direct`,
                    creatorName: label,
                    creatorHandle: `@${direct.source}`,
                    creatorAvatar: '',
                    type: 'video',
                    source: direct.source,
                    originalUrl: direct.url,
                    videoUrl: `/api/proxy-video-stream?url=${encodeURIComponent(direct.url)}`,
                    title: label,
                    comments: [],
                    likes: null,
                    date: new Date().toISOString(),
                  };
                  openVideo(directPost, {
                    currentTime: 0,
                    isMuted: false,
                    isPlaying: true,
                    volume: 1,
                    playbackRate: 1,
                  });
                  return;
                }
                if (direct.kind === 'playlist') {
                  void openSearchPlaylist({
                    id: `direct-pl-${direct.url}`,
                    creatorId: `${direct.source}:direct`,
                    creatorName: label,
                    creatorHandle: `@${direct.source}`,
                    creatorAvatar: '',
                    type: 'playlist',
                    source: direct.source,
                    originalUrl: direct.url,
                    playlistUrl: direct.url,
                    title: label,
                    comments: [],
                    likes: null,
                    date: new Date().toISOString(),
                  });
                  return;
                }
                if (direct.kind === 'thread') {
                  void openThreadView(direct.url, label, direct.source);
                  return;
                }
                openWatchCreator(direct.url, { name: label });
                return;
              }
              void runOmniSearch(searchQuery, undefined, true);
            }}
          >
            <div className="tl-omni-search-field">
              <Search size={16} aria-hidden="true" className="tl-omni-search-leading-icon" />
              <input
                type="search"
                data-omni-search-input="true"
                value={searchQuery}
                onChange={e => {
                  skipNextDebounceQueryRef.current = null;
                  if (xProfile) setXProfile(undefined);
                  if (xPostStack.length) setXPostStack([]);
                  if (e.target.value.trim().length >= 2 && activeDirectoryKind) {
                    setActiveDirectoryKind(null);
                  }
                  setSearchQuery(e.target.value);
                }}
                placeholder={
                  source !== 'all'
                    ? (isEn
                        ? `Search in ${getTimelineSourceDisplayName(source, 'en')}…`
                        : `Pesquisar em ${getTimelineSourceDisplayName(source, 'pt')}…`)
                    : (isEn
                        ? 'Search any artist, album, video, or topic across all integrated sources…'
                        : 'Pesquisar qualquer artista, álbum, vídeo ou tema em todas as fontes…')
                }
                aria-label={
                  isEn
                    ? 'Search across all integrated sources'
                    : 'Pesquisar em todas as fontes integradas'
                }
                className="tl-omni-search-input"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    searchCoordinatorRef.current?.clear();
                  }}
                  aria-label={isEn ? 'Clear search' : 'Limpar busca'}
                  className="tl-omni-search-clear"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              )}
            </div>
            <button
              type="submit"
              data-omni-search-submit="true"
              aria-label={isEn ? 'Search all sources' : 'Pesquisar em todas as fontes'}
              title={isEn ? 'Search all sources' : 'Pesquisar em todas as fontes'}
              className="tl-omni-search-submit"
            >
              {omniSearchLoading ? (
                <Loader2 size={16} aria-hidden="true" className="animate-spin" />
              ) : (
                <Search size={16} aria-hidden="true" />
              )}
              <span className="hidden sm:inline">{isEn ? 'Search' : 'Buscar'}</span>
            </button>
          </form>

          <div className="tl-workspace-actions">
            {canRefreshSource && <button type="button" className="tl-workspace-refresh"
              disabled={isLoading || isRefreshingScope || (canShowX && xFeed?.loading)}
              aria-busy={isRefreshingScope || (canShowX && xFeed?.loading)}
              aria-label={isEn ? 'Refresh' : 'Atualizar'} title={isEn ? 'Refresh' : 'Atualizar'}
              onClick={async () => {
                if (source === 'x') await loadX(xTarget, true);
                else if (source === 'all') {
                  void refreshFeed(refreshControllerRef.current?.signal);
                  if (xFeed?.status === 'ready') void loadX(xTarget, true);
                } else if (isVisualBrowseSource && visualScopeMode === 'discover') {
                  await loadBrowseFeed(source, catalogMode, currentBrowseSubfilter, true);
                } else {
                  const signal = refreshControllerRef.current?.signal;
                  for (const creator of refreshCreators) {
                    if (signal?.aborted) break;
                    await discoverCreatorCatalog(creator.id, signal, true);
                  }
                }
              }}><RefreshCw aria-hidden className={refreshIconClass} /></button>}
            {toolbarAction}
          </div>
        </header>
        </div>
        {!xProfile && !activeXPost && <>
          {(integratedSources.length > 0 || availableSources.size > 1) && (
            <TimelineSourceBar
              source={source}
              available={availableSources}
              dynamicSources={searchSources}
              isEn={isEn}
              isMobile={isMobileOnly}
              disableAnimations={Boolean(disableAllAnimations)}
              onChange={handleSelectSource}
            />
          )}
          {query.length < 2 && (
            <>
              <nav aria-label={source === 'x' ? (isEn ? 'X feed' : 'Feed do X') : (isEn ? 'Feed views' : 'Visualizações do feed')} className="tl-mode-bar">
                {source === 'x' ? X_TABS.map(tab => <button key={tab.scope} type="button" aria-pressed={xTab === tab.scope}
                  onClick={() => setXTab(tab.scope)}>{isEn ? tab.en : tab.pt}</button>)
                  : catalogModes(source).map(mode => <button key={mode} type="button" aria-pressed={catalogMode === mode}
                    onClick={() => useSourceMode(mode)}>{CATALOG_MODE_LABELS[mode]?.[isEn ? 'en' : 'pt'] || mode}</button>)}
              </nav>
              {isVisualBrowseSource && (() => {
                const isVideoPortal = activeSourceCaps?.archetype === 'video_portal';
                const inlineSubfilters = isVideoPortal
                  ? activeBrowseSubfilters.filter((sub) => sub.group !== 'category')
                  : activeBrowseSubfilters;
                const categoryRibbonSubfilters = isVideoPortal
                  ? activeBrowseSubfilters.filter((sub) => sub.group === 'category')
                  : [];
                return (
                <>
                <div className="tl-subfilter-strip" data-visual-subfilter-strip="true" aria-label={isEn ? 'Source filters' : 'Filtros da fonte'}>
                  <button
                    type="button"
                    aria-pressed={visualScopeMode === 'discover' && !activeDirectoryKind}
                    onClick={() => {
                      setVisualScopeMode('discover');
                      setActiveDirectoryKind(null);
                    }}
                    className="tl-subfilter-pill"
                  >
                    {tBrowse.discoverTab || (isEn ? 'Discover' : 'Descobrir')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={visualScopeMode === 'followed' && !activeDirectoryKind}
                    onClick={() => {
                      setVisualScopeMode('followed');
                      setActiveDirectoryKind(null);
                    }}
                    className="tl-subfilter-pill"
                  >
                    {tBrowse.followedTab || (isEn ? 'Following' : 'Seguidos')}
                  </button>
                  {activeSourceCaps?.supportsDirectories && activeSourceCaps.directoryKinds.map((dirKind) => {
                    const dirLabel =
                      dirKind === 'categories' ? (tBrowse.dirCategories || (isEn ? 'Categories' : 'Categorias'))
                      : dirKind === 'artists' ? (tBrowse.dirArtists || (isEn ? 'Artists' : 'Artistas'))
                      : dirKind === 'channels' ? (tBrowse.dirChannels || (isEn ? 'Channels' : 'Canais'))
                      : dirKind === 'tags' ? (tBrowse.dirTags || 'Tags')
                      : (tBrowse.dirBoards || (isEn ? 'Boards' : 'Fóruns'));
                    const isDirActive = activeDirectoryKind === dirKind;
                    return (
                      <button
                        key={`dir-${dirKind}`}
                        type="button"
                        data-directory-kind={dirKind}
                        aria-pressed={isDirActive}
                        onClick={() => {
                          closeThreadView();
                          setActiveDirectoryKind(isDirActive ? null : dirKind);
                        }}
                        className="tl-subfilter-pill"
                      >
                        {dirLabel}
                      </button>
                    );
                  })}
                  {inlineSubfilters.map((sub) => {
                    const isSubActive = currentBrowseSubfilter === sub.id;
                    const label = (sub.label_key && tBrowse[sub.label_key]) || sub.fallback_label;
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        data-subfilter-id={sub.id}
                        aria-pressed={isSubActive}
                        onClick={() => {
                          setVisualScopeMode('discover');
                          setActiveDirectoryKind(null);
                          setBrowseSubfilters((prev) => ({
                            ...prev,
                            [source]: isSubActive ? null : sub.id,
                          }));
                        }}
                        className="tl-subfilter-pill"
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {visualScopeMode === 'discover' && !activeDirectoryKind && categoryRibbonSubfilters.length > 0 && (
                  <div className="tl-category-ribbon" data-category-ribbon="true" aria-label={isEn ? 'Categories' : 'Categorias'}>
                    {currentBrowseSubfilter && (
                      <button
                        type="button"
                        onClick={() => setBrowseSubfilters((prev) => ({ ...prev, [source]: null }))}
                        className="tl-category-ribbon-pill is-reset"
                      >
                        {isEn ? 'All' : 'Todas'}
                      </button>
                    )}
                    {categoryRibbonSubfilters.map((sub) => {
                      const isSubActive = currentBrowseSubfilter === sub.id;
                      const label = (sub.label_key && tBrowse[sub.label_key]) || sub.fallback_label;
                      return (
                        <button
                          key={sub.id}
                          type="button"
                          data-subfilter-id={sub.id}
                          aria-pressed={isSubActive}
                          onClick={() => {
                            setBrowseSubfilters((prev) => ({
                              ...prev,
                              [source]: isSubActive ? null : sub.id,
                            }));
                          }}
                          className={`tl-category-ribbon-pill${isSubActive ? ' is-active' : ''}`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
                </>
                );
              })()}
              <TimelineSourceLinks source={source} isEn={isEn} />
            </>
          )}
        </>}
        </div>
      </>}

      <div className={selectedCreator ? undefined : 'tl-feed-layout tl-feed-with-context'}>
      {/* Perfil Adaptativo Selecionado */}
      {selectedCreator ? (() => {
        const selSite = resolveTimelinePlatform(selectedCreator.profileUrl, selectedCreator.site);
        const selCaps = getSourceCapabilities(selSite);
        if (selCaps.archetype === 'gallery_catalog' || selCaps.archetype === 'forum_board') {
          return (
            <CatalogEntityView
              key={`profile-${selectedCreator.id}`}
              creator={selectedCreator}
              posts={posts}
              isEn={isEn}
              isLoadingMore={isLoadingMoreProfile}
              onBack={() => openCreator(null)}
              onOpenGallery={(p) => openGalleryView(p)}
              onOpenThread={(p) => void openThreadView(p, p.title, sourceOf(p))}
              onOpenEntity={(entity) => {
                if (entity.url) openWatchCreator(entity.url, { name: entity.name });
              }}
              onOpenLightbox={(imgs, idx, ttl, albUrl, items, expectedCount) =>
                openLightbox(imgs, idx, ttl, albUrl, items, expectedCount)
              }
              onLoadMore={() => void loadMoreCreatorProfileAlbums(selectedCreator.id)}
            />
          );
        }
        if (selCaps.archetype === 'video_portal') {
          return (
            <VideoPortalProfileView
              key={`profile-${selectedCreator.id}`}
              creator={selectedCreator}
              posts={posts}
              isEn={isEn}
              isLoading={isRefreshingScope}
              isLoadingMore={isLoadingMoreProfile}
              onBack={() => openCreator(null)}
              onOpenVideo={openVideo}
              onOpenEntity={(entity) => {
                if (entity.url) {
                  openWatchCreator(entity.url, { name: entity.name, avatar: entity.thumbnailUrl || null });
                }
              }}
              onOpenLightbox={openLightbox}
              onChangeSort={(sortKey) => void switchCreatorProfileSort(selectedCreator.id, sortKey, selectedCreator)}
              onLoadMore={() => void loadMoreCreatorProfileAlbums(selectedCreator.id)}
            />
          );
        }
        return (
        <div key={`profile-${selectedCreator.id}`} className="space-y-4">
          <div className="flex justify-end px-3.5">
            <button
              type="button"
              onClick={() => void discoverCreatorCatalog(selectedCreator.id, refreshControllerRef.current?.signal, true)}
              disabled={isRefreshingScope}
              aria-busy={isRefreshingScope}
              className={refreshButtonClass}
            >
              <RefreshCw aria-hidden="true" className={refreshIconClass} />
              <span>{isEn ? 'Refresh profile' : 'Atualizar perfil'}</span>
            </button>
          </div>
          <AdaptiveProfileHeader
            creator={selectedCreator}
            onBack={() => openCreator(null)}
          />
          <AdaptiveProfileContent
            suspended={!active || !!watchSession}
            onOpenVideo={openVideo}
            creator={selectedCreator}
            posts={posts}
            onOpenProfile={(id: string, trig?: HTMLElement) => {
              if (id.startsWith('http')) {
                openWatchCreator(id);
                return;
              }
              openCreator(id, trig);
            }}
            onOpenEntity={(entity) => {
              if (entity.url) openWatchCreator(entity.url, { name: entity.name });
            }}
            onOpenThread={(p) => void openThreadView(p, p.title, sourceOf(p))}
            onOpenGallery={(p) => openGalleryView(p)}
            onLoadMoreProfile={() => void loadMoreCreatorProfileAlbums(selectedCreator.id)}
            isLoadingMoreProfile={isLoadingMoreProfile}
            onOpenComments={(id) => openComments(id)}
            onOpenLightbox={(imgs, idx, ttl, albUrl, items, expectedCount) =>
              openLightbox(imgs, idx, ttl, albUrl, items, expectedCount)
            }
            isDesktop={!isMobileOnly}
          />
        </div>
        );
      })() : (
        /* Palco Principal: Stories + Avisos + Perfil X + Busca Omni + Diretório + Feed */
        <div className="tl-feed-main-col min-w-0 space-y-3.5">
          {isVisualBrowseSource && activeDirectoryKind && query.length < 2 ? (
            (() => {
              if (activeDirectoryKind === 'boards') {
                const boardsSlice = forumBoardsBySource[source];
                return (
                  <ForumBoardTreePanel
                    key={`boards-${source}-${directoryInitialFilter}`}
                    sections={boardsSlice?.sections || []}
                    isLoading={boardsSlice?.isLoading}
                    isEn={isEn}
                    activeBoardId={currentBrowseSubfilter}
                    initialFilter={directoryInitialFilter}
                    onSelectBoard={(boardId) => {
                      setVisualScopeMode('discover');
                      setActiveDirectoryKind(null);
                      setDirectoryInitialFilter('');
                      setBrowseSubfilters((prev) => ({ ...prev, [source]: boardId }));
                    }}
                  />
                );
              }
              const dirKey = `${source}:${activeDirectoryKind}:1`;
              const dirSlice = directoriesByKey[dirKey];
              return (
                <VisualDirectoryExplorer
                  key={`dir-${source}-${activeDirectoryKind}-${directoryInitialFilter}`}
                  kind={activeDirectoryKind}
                  source={source}
                  items={dirSlice?.items || []}
                  isLoading={!dirSlice || (dirSlice.isLoading && dirSlice.items.length === 0)}
                  isLoadingMore={Boolean(dirSlice?.isLoading && (dirSlice?.items?.length || 0) > 0)}
                  hasMore={Boolean(dirSlice?.hasMore)}
                  error={dirSlice?.error}
                  isEn={isEn}
                  initialFilter={directoryInitialFilter}
                  onLoadMore={() => {
                    const nextPage = dirSlice?.nextPage || ((dirSlice?.page || 1) + 1);
                    void loadDirectory(source, activeDirectoryKind, nextPage, true);
                  }}
                  onRetry={() => {
                    const nextPage = dirSlice?.nextPage;
                    void loadDirectory(source, activeDirectoryKind, nextPage || 1, Boolean(nextPage));
                  }}
                  onSelectItem={(item) => {
                    if (activeDirectoryKind === 'tags' && !item.url.startsWith('http')) {
                      setVisualScopeMode('discover');
                      setActiveDirectoryKind(null);
                      setDirectoryInitialFilter('');
                      setBrowseSubfilters((prev) => ({ ...prev, [source]: item.id }));
                    } else {
                      openWatchCreator(item.url, { name: item.name, avatar: item.avatar || item.thumbnailUrl });
                    }
                  }}
                />
              );
            })()
          ) : (
            <>
          {!(!xProfile && !activeXPost && query.length >= 2) && scopeRefreshFailed && (
            <div className="tl-scope-warning" role="status">
              <AlertCircle aria-hidden="true" className="w-4 h-4 shrink-0 text-amber-400" />
              <span>
                {isEn
                  ? 'Some sources could not be checked. Loaded content is preserved; try refreshing again.'
                  : 'Não foi possível consultar algumas fontes. O conteúdo carregado foi preservado; tente atualizar novamente.'}
              </span>
            </div>
          )}

          {/* Full-page X Post Detail View with Live Replies (mirrors X.com /status/{id}) */}
          {activeXPost && xPostThread ? (
            <XPostDetailView
              thread={xPostThread}
              xFollowedHandles={xFollowedHandles}
              isEn={isEn}
              onBack={closeXPostDetail}
              onOpenProfile={openXProfile}
              onOpenPost={openXPostDetail}
              onOpenPhoto={(p, idx) => setXPhotoModal({ post: p, index: idx })}
              onOpenVideo={openVideo}
            />
          ) : (
            <>
          {/* Complete X Profile Header Card when xProfile is active */}
          {xProfile && (
            <XProfileHeaderCard
              account={xProfile}
              profileData={xFeed?.profile}
              isFollowedOnX={xFollowedHandles.has(xProfile.handle.replace(/^@/, '').toLowerCase())}
              postsCount={(xFeed?.items || []).filter(item => 'id' in item).length}
              mediaCount={
                (xFeed?.items || []).filter(
                  (item): item is XPost =>
                    'id' in item && Boolean(item.photos.length || item.video || item.hasVideo)
                ).length
              }
              mode={xProfileMode}
              onSelectMode={setXProfileMode}
              onBack={() => setXProfile(undefined)}
              isEn={isEn}
              onOpenAvatar={(url, title) => openLightbox([url], 0, title)}
            />
          )}

          {/* X Explore Trending Topics Banner (mirrors X.com /explore) */}
          {!xProfile && source === 'x' && xTab === 'explore' && (xFeed?.trends?.length ?? 0) > 0 && (
            <section
              className="tl-x-explore-trends"
              data-x-explore-trends
              aria-label={isEn ? 'Explore trending on X' : 'Assuntos do momento no X'}
            >
              <div className="tl-x-explore-trends-header">
                <div className="flex items-center gap-2">
                  <Compass size={17} aria-hidden className="text-[#1d9bf0]" />
                  <h3>{isEn ? "What's happening" : 'O que está acontecendo'}</h3>
                </div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--tl-text-muted)]">
                  {isEn ? 'X Explore' : 'Explorar no X'}
                </span>
              </div>
              <div className="tl-x-trends-grid">
                {xFeed!.trends!.slice(0, 8).map((trend, idx) => (
                  <button
                    key={`${trend.topic}-${idx}`}
                    type="button"
                    data-x-trend-item
                    onClick={() => {
                      setXTab('recommended');
                      setSearchQuery(trend.topic);
                      void runOmniSearch(trend.topic, undefined, true);
                    }}
                    className="tl-x-trend-row"
                  >
                    {trend.category && (
                      <span className="tl-x-trend-meta">{trend.category}</span>
                    )}
                    <strong className="tl-x-trend-topic">{trend.topic}</strong>
                    {trend.postCount && (
                      <span className="tl-x-trend-meta">{trend.postCount}</span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Organized Federated Search Workspace replaces browse feed while searching */}
          {!xProfile && !activeXPost && query.length >= 2 ? (
            <TimelineSearchResults
              snapshot={searchSnapshot?.query === searchQuery.trim() ? searchSnapshot : null}
              query={searchQuery.trim()}
              activeSource={source}
              activeCategory={searchCategory}
              availableSources={searchSources}
              xPostsMode={xPostsMode}
              knownCreatorIds={knownCreatorIds}
              suspended={!active || !!watchSession || !!creatorEntry}
              isEn={isEn}
              isLoadingInitial={searchLoadingInitial || searchSnapshot?.query !== searchQuery.trim()}
              isLoadingMore={searchLoadingMore}
              onSelectSource={nextSrc => handleSelectSource(nextSrc as TimelineSource)}
              onSelectCategory={handleSelectSearchCategory}
              onChangeXPostsMode={handleChangeXPostsMode}
              onLoadMore={() => void handleLoadMoreSearch()}
              onOpenProfile={(cidOrUrl, trigger, seed) => {
                if (cidOrUrl.startsWith('http')) {
                  openWatchCreator(cidOrUrl, seed);
                } else if (knownCreatorIds.has(cidOrUrl)) {
                  openCreator(cidOrUrl, trigger);
                }
              }}
              onOpenXProfile={openXProfile}
              onOpenXPostDetail={openXPostDetail}
              onOpenVideo={openVideo}
              onOpenLightbox={(imgs, idx, ttl, albUrl, items, expectedCount) =>
                openLightbox(imgs, idx, ttl, albUrl, items, expectedCount)
              }
              onOpenComments={post => {
                setActiveCustomCommentPost(post);
                openComments(post.id);
              }}
              onOpenGallery={post => openGalleryView(post)}
              onOpenEntity={entity => {
                if (entity.url) openWatchCreator(entity.url, { name: entity.name });
              }}
              onOpenThread={post => void openThreadView(post, post.title, sourceOf(post))}
              onOpenPlaylist={pl => void openSearchPlaylist(pl)}
              activeSearchOptions={source !== 'all' ? searchOptionsBySource[source] : undefined}
              onChangeSearchOptions={handleChangeSearchOptions}
              activeSourceSubfilters={activeBrowseSubfilters}
              forumBoardSections={source !== 'all' ? forumBoardsBySource[source]?.sections : undefined}
              forumBoardsLoading={source !== 'all' ? Boolean(forumBoardsBySource[source]?.isLoading) : false}
              onOpenDirectoryFromSearch={handleOpenDirectoryFromSearch}
            />
          ) : (
            <>
              {/* Stories de Criadores (exibido no feed e 100% contido na coluna dos cards) */}
              {!xProfile && source === 'all' && displayedCreators.length > 0 && (
                <div className="tl-stories-section min-w-0">
                  <TimelineStoriesBar
                    creators={displayedCreators}
                    selectedCreatorId={selectedCreatorId}
                    onSelectCreator={openCreator}
                  />
                </div>
              )}

              {/* Category-First HD Showcase visual category ribbon */}
              {activeLayoutMode === 'category_showcase' && !xProfile && (
                <CategoryShowcaseStrip
                  categories={directoriesByKey[`${source}:categories:1`]?.items || []}
                  activeSubfilter={currentBrowseSubfilter}
                  isLoading={directoriesByKey[`${source}:categories:1`]?.isLoading}
                  isEn={isEn}
                  onOpenCategoryProfile={(cat) => openWatchCreator(cat.url, { name: cat.name, avatar: cat.avatar })}
                  onSelectCategoryFilter={(slug) => {
                    setVisualScopeMode('discover');
                    setActiveDirectoryKind(null);
                    setBrowseSubfilters((prev) => ({
                      ...prev,
                      [source]: prev[source] === slug ? null : slug,
                    }));
                  }}
                  onBrowseAllCategories={() => setActiveDirectoryKind('categories')}
                />
              )}

              {/* Forum Board active index header banner */}
              {activeLayoutMode === 'forum_index' && !xProfile && (
                <div className="tl-forum-index-header" data-forum-index-banner="true">
                  <div className="min-w-0">
                    <span className="text-[10px] font-extrabold uppercase tracking-widest text-[var(--tl-accent-text)]">
                      {isEn ? 'Forum Thread Index' : 'Índice de Tópicos'}
                    </span>
                    <p className="text-xs text-[var(--tl-text-secondary)] truncate">
                      {currentBrowseSubfilter
                        ? currentBrowseSubfilter.replace(/^\d+-/, '').replace(/-/g, ' ')
                        : (CATALOG_MODE_LABELS[catalogMode]?.[isEn ? 'en' : 'pt'] || catalogMode)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveDirectoryKind('boards')}
                    className="tl-nav-back-btn shrink-0"
                  >
                    {isEn ? 'Browse All Boards' : 'Todos os Fóruns'}
                  </button>
                </div>
              )}

              <div
                key="timeline-feed"
                ref={feedListRef}
                tabIndex={-1}
                data-layout-mode={activeLayoutMode}
                data-archetype={activeSourceCaps?.archetype}
                style={
                  getDynamicSourceAccent(source)
                    ? ({ '--tl-source-accent': getDynamicSourceAccent(source) } as React.CSSProperties)
                    : undefined
                }
                className={`tl-feed-list ${
                  activeLayoutMode === 'video_wall'
                    ? 'tl-video-wall-grid'
                    : activeLayoutMode === 'editorial_wall'
                      ? 'tl-editorial-wall-grid'
                      : activeLayoutMode === 'category_showcase'
                        ? 'tl-category-showcase-grid'
                        : activeLayoutMode === 'forum_index'
                          ? 'tl-forum-thread-list'
                          : mediaGrid
                            ? 'tl-feed-media'
                            : ''
                }`}
              >
            {!xPageError && xNotice}
            {catalogError && <TimelineFeedNotice kind="error" action={
              <button type="button" className={`${refreshButtonClass} min-h-11`}
                onClick={() => {
                  if (isVisualBrowseSource && visualScopeMode === 'discover') {
                    void loadBrowseFeed(source, catalogMode, currentBrowseSubfilter, true);
                  } else {
                    void refreshFeed(refreshControllerRef.current?.signal);
                  }
                }}
                disabled={isLoading || isRefreshingTimeline || isRefreshingScope}>
                {isEn ? 'Retry' : 'Tentar novamente'}
              </button>
            }>{catalogError}</TimelineFeedNotice>}
            {initialLoading && <TimelineFeedNotice kind="loading" animate={!disableAllAnimations}>
              {xAccounts ? (isEn ? 'Loading followed accounts…' : 'Carregando perfis seguidos…')
                : (isEn ? 'Loading posts…' : 'Carregando publicações…')}
            </TimelineFeedNotice>}
            {!hasEntries && !initialLoading && !catalogError && !xError && !omniSearchLoading && (
              integratedSources.length === 0 &&
              integratedSourcesStatus !== 'unavailable' &&
              source === 'all' &&
              !query &&
              !xAccounts ? (
                <div className="tl-cold-start-card tl-live-enter" data-cold-start-card="true">
                  <div className="w-11 h-11 rounded-2xl bg-[var(--tl-accent-soft)] border border-[var(--tl-accent-border)] text-[var(--tl-accent-text-strong)] flex items-center justify-center">
                    <Layers size={20} aria-hidden="true" />
                  </div>
                  <div className="space-y-1 max-w-md">
                    <h3 className="text-sm font-bold text-[var(--tl-text-primary)]">
                      {tBrowse.coldStartTitle || (isEn ? 'Clean Timeline Ready to Integrate' : 'Timeline pronta para integrar')}
                    </h3>
                    <p className="text-xs text-[var(--tl-text-muted)] leading-relaxed">
                      {tBrowse.coldStartDesc || (isEn
                        ? 'Fresh installs start with 0 pre-installed sources. Paste any network URL or creator link to begin.'
                        : 'Downloads limpos iniciam com 0 fontes pré-instaladas. Cole o link de uma rede ou perfil/canal para começar.')}
                    </p>
                  </div>
                  {isMobileOnly ? (
                    <button
                      type="button"
                      data-cold-start-cta="true"
                      onClick={() => setEffectiveSourcesSheetOpen(true)}
                      className="tl-pressable w-full max-w-xs min-h-[44px] px-4 rounded-xl bg-[var(--tl-accent)] text-[var(--tl-accent-contrast)] text-xs font-bold inline-flex items-center justify-center gap-2 hover:bg-[var(--tl-accent-hover)]"
                    >
                      <Plus size={16} aria-hidden="true" />
                      <span>{tBrowse.coldStartMobileCta || (isEn ? 'Add first source by link' : 'Adicionar 1ª fonte por link')}</span>
                    </button>
                  ) : (
                    <form
                      className="w-full max-w-md flex items-stretch gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const trimmed = desktopOptInUrl.trim();
                        if (!trimmed) {
                          setDesktopOptInInvalid(true);
                          return;
                        }
                        void handleIntegrateOptionA(trimmed);
                      }}
                    >
                      <input
                        type="url"
                        value={desktopOptInUrl}
                        onChange={(e) => {
                          setDesktopOptInUrl(e.target.value);
                          if (desktopOptInInvalid) setDesktopOptInInvalid(false);
                        }}
                        placeholder={tBrowse.pasteUrlPlaceholder}
                        aria-label={tBrowse.pasteUrlPlaceholder || (isEn ? 'Paste source or creator URL' : 'Cole link da rede ou perfil')}
                        className="tl-context-link-input tl-focus-ring"
                      />
                      <button
                        type="submit"
                        disabled={isIntegratingSource}
                        className="tl-context-link-submit tl-pressable inline-flex items-center gap-1.5"
                      >
                        <Plus size={15} aria-hidden="true" />
                        <span>{isIntegratingSource ? (tBrowse.integratingBtn || (isEn ? 'Integrating...' : 'Integrando...')) : (tBrowse.integrateBtn || (isEn ? 'Integrate' : 'Integrar'))}</span>
                      </button>
                    </form>
                  )}
                </div>
              ) : (
                <TimelineFeedNotice kind="empty">
                  {xAccounts ? (isEn ? 'X has not returned any followed accounts.' : 'O X ainda não mostrou perfis seguidos.')
                    : query ? (isEn ? 'No posts match this search in the loaded content.' : 'Nenhuma publicação corresponde à busca no conteúdo carregado.')
                    : xProfile && xProfileMode === 'media' ? (isEn ? 'No media in the posts loaded so far.' : 'Nenhuma mídia nas publicações carregadas até agora.')
                    : source === 'all' ? (isEn ? 'No timeline posts available.' : 'Nenhuma publicação disponível na linha do tempo.')
                    : (isEn ? 'No posts are available in this view.' : 'Nenhuma publicação disponível nesta visualização.')}
                </TimelineFeedNotice>
              )
            )}
            {xAccounts && xFeed?.items.map(item => <XTimelineCard key={item.handle} item={item}
              active={active && !watchSession && !creatorEntry} isEn={isEn} onOpenProfile={openXProfile} onOpenMedia={openLightbox} />)}
            {!xAccounts && renderedFeedPosts.map((post) => {
              const livePost = xPostsById.get(post.id);
              if (livePost) return <XTimelineCard key={`${xTarget.key}:${post.id}`} id={post.id} item={livePost}
                active={active && !watchSession && !creatorEntry} isEn={isEn} onOpenProfile={openXProfile} onOpenMedia={openLightbox}
                onOpenPostDetail={openXPostDetail}
                onOpenXPhoto={(p, idx) => setXPhotoModal({ post: p, index: idx })}
                onOpenVideo={openVideo}
                onOpenComments={(snap) => { setActiveCustomCommentPost(snap); openComments(snap.id); }} />;

              if (isOfflineTimelinePost(post)) {
                return <TimelineImportedPost key={post.id} post={post} isEn={isEn} inFeed sourceLabel={getTimelineSourceDisplayName(sourceOf(post), isEn ? 'en' : 'pt')} />;
              }
              if (activeLayoutMode === 'editorial_wall') {
                return (
                  <EditorialGalleryCard
                    key={post.id}
                    post={post}
                    sourceLabel={getTimelineSourceDisplayName(sourceOf(post), isEn ? 'en' : 'pt')}
                    isEn={isEn}
                    onOpenGallery={(p) => openGalleryView(p)}
                    onOpenLightbox={(imgs, idx, ttl, albUrl, items, expectedCount) =>
                      openLightbox(imgs, idx, ttl, albUrl, items, expectedCount)
                    }
                    onOpenEntity={(entity) => {
                      if (entity.url) openWatchCreator(entity.url, { name: entity.name });
                    }}
                    onSelectSubfilter={(sub) => {
                      setVisualScopeMode('discover');
                      setBrowseSubfilters((prev) => ({ ...prev, [source]: sub }));
                    }}
                  />
                );
              }
              if (activeLayoutMode === 'category_showcase') {
                return (
                  <CategoryShowcaseCard
                    key={post.id}
                    post={post}
                    sourceLabel={getTimelineSourceDisplayName(sourceOf(post), isEn ? 'en' : 'pt')}
                    isEn={isEn}
                    onOpenGallery={(p) => openGalleryView(p)}
                    onOpenLightbox={(imgs, idx, ttl, albUrl, items, expectedCount) =>
                      openLightbox(imgs, idx, ttl, albUrl, items, expectedCount)
                    }
                    onOpenEntity={(entity) => {
                      if (entity.url) openWatchCreator(entity.url, { name: entity.name });
                    }}
                    onSelectSubfilter={(sub) => {
                      setVisualScopeMode('discover');
                      setBrowseSubfilters((prev) => ({ ...prev, [source]: sub }));
                    }}
                  />
                );
              }
              if (activeLayoutMode === 'forum_index') {
                return (
                  <ForumThreadRow
                    key={post.id}
                    post={post}
                    isEn={isEn}
                    onOpenThread={(p) => void openThreadView(p, p.title, sourceOf(p))}
                    onOpenLightbox={(imgs, idx, ttl, albUrl, items, expectedCount) =>
                      openLightbox(imgs, idx, ttl, albUrl, items, expectedCount)
                    }
                    onOpenEntity={(entity) => {
                      if (entity.url) openWatchCreator(entity.url, { name: entity.name });
                    }}
                  />
                );
              }
              const isNext = post.id === nextNativePostId;
              return (
                <TimelinePostCard
                  suspended={!active || !!watchSession}
                  onOpenVideo={openVideo}
                  onOpenPlaylist={pl => void openSearchPlaylist(pl)}
                  onOpenGallery={(p) => openGalleryView(p)}
                  key={post.id}
                  post={post}
                  sourceLabel={getTimelineSourceDisplayName(sourceOf(post), isEn ? 'en' : 'pt')}
                  onOpenProfile={(creatorId, trigger) => {
                    if (creatorId.startsWith('http')) {
                      openWatchCreator(creatorId, { name: post.creatorName, avatar: post.creatorAvatar });
                    } else if (creatorProfiles[creatorId] || creators.some(c => c.id === creatorId)) {
                      openCreator(creatorId, trigger);
                    } else if (post.sourcePage?.startsWith('http')) {
                      openWatchCreator(post.sourcePage, { name: post.creatorName, avatar: post.creatorAvatar });
                    }
                  }}
                  onOpenEntity={(entity) => {
                    if (entity.url) openWatchCreator(entity.url, { name: entity.name });
                  }}
                  onOpenThread={(p) => void openThreadView(p, p.title, sourceOf(p))}
                  onOpenComments={(id) => {
                    setActiveCustomCommentPost(post);
                    openComments(id);
                  }}
                  onOpenLightbox={(imgs, idx, ttl, albUrl, items, expectedCount) =>
                    openLightbox(imgs, idx, ttl, albUrl, items, expectedCount)
                  }
                  onSelectSubfilter={(sub) => {
                    if (isVisualBrowseSource) {
                      setVisualScopeMode('discover');
                      setBrowseSubfilters((prev) => ({ ...prev, [source]: sub }));
                    } else {
                      setSearchQuery(sub);
                      void runOmniSearch(sub, undefined, true);
                    }
                  }}
                  isDesktop={!isMobileOnly}
                  isNextInQueue={isNext}
                />
              );
            })}
            {xPageError && xNotice}
            {loadingMore && <TimelineFeedNotice kind="more" animate={!disableAllAnimations}>
              {xAccounts ? (isEn ? 'Loading more accounts…' : 'Carregando mais perfis…')
                : (isEn ? 'Loading more posts…' : 'Carregando mais publicações…')}
            </TimelineFeedNotice>}
            {hasEntries && !hasMoreFeedPosts && !hasBrowseMore && !xLoading && !xError && !catalogError && (xFeed?.paused || !hasXMore) &&
              <TimelineFeedNotice kind="end">
                {hasXMore ? (xAccounts ? (isEn ? 'No new accounts in this batch.' : 'Nenhum perfil novo nesta rodada.')
                  : (isEn ? 'No new posts in this batch.' : 'Nenhuma publicação nova nesta rodada.'))
                  : (isEn ? 'You’ve reached the end of the feed.' : 'Você chegou ao fim do feed.')}
              </TimelineFeedNotice>}
            {(hasMoreFeedPosts || hasXMore || hasBrowseMore || loadingMore) && <div className="tl-feed-pagination">
              <button type="button" className={`${refreshButtonClass} min-h-11`}
                aria-disabled={!hasMoreFeedPosts && !browseXMore && !hasBrowseMore} aria-busy={loadingMore || undefined}
                onClick={() => {
                  if (!hasMoreFeedPosts && !browseXMore && !hasBrowseMore) return;
                  pendingFeedFocusRef.current = displayedPosts.find((post, index) => index >= feedCount && post.id !== pinnedFeedPostId)?.id || null;
                  loadMoreFeed(true);
                }}>{moreLabel}</button>
              <div ref={feedSentinelRef} className="h-2 w-full pointer-events-none" aria-hidden="true" />
            </div>}
          </div>
            </>
          )}
            </>
          )}
            </>
          )}
        </div>
      )}
      {!selectedCreator && (
        <aside className="tl-source-context" aria-label={isEn ? 'Timeline context and filters' : 'Contexto e filtros da timeline'}>
          {/* X Relevant People Card when viewing an X Post Detail thread */}
          {activeXPost && xPostThread && (
            <XRelevantPeopleCard
              focalPost={xPostThread.focalPost}
              authorProfile={xPostThread.authorProfile}
              replies={xPostThread.replies}
              relevantPeople={xPostThread.relevantPeople}
              relatedFeedAccounts={[...(xFeed?.relevantPeople ?? []), ...followedXAccounts, ...xItems]}
              xFollowedHandles={xFollowedHandles}
              isEn={isEn}
              onOpenProfile={openXProfile}
            />
          )}

          {source === 'x' && !xAccounts && !activeXPost && followedXAccounts.length > 0 && (
            <div className="tl-context-card">
              <h3><UsersRound size={17} aria-hidden />{isEn ? 'Followed accounts' : 'Perfis seguidos'}</h3>
              {followedXAccounts.slice(0, 4).map(account => <button key={account.handle} type="button"
                data-x-entry={account.handle.toLowerCase()} className="tl-source-account"
                onClick={event => openXProfile(account, event.currentTarget)}>
                {account.avatar ? <img src={account.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  : <span aria-hidden className="tl-source-account-initial">{account.name.slice(0, 1)}</span>}
                <span><strong>{account.name}</strong><small>@{account.handle}</small></span>
              </button>)}
              <button type="button" className="tl-source-external" onClick={() => { if (xProfile) setXProfile(undefined); setXTab('accounts'); }}>
                {isEn ? 'View accounts' : 'Ver perfis'} <ArrowUpRight aria-hidden size={15} />
              </button>
            </div>
          )}

          {isVisualBrowseSource && (
            <div className="tl-context-card" data-visual-source-context="true">
              <div className="tl-context-card-header">
                <h3><Compass size={16} aria-hidden />{getTimelineSourceDisplayName(source, isEn ? 'en' : 'pt')}</h3>
                {(query.length >= 2
                  ? Boolean(searchOptionsBySource[source]?.boardId || searchOptionsBySource[source]?.subfilter)
                  : Boolean(currentBrowseSubfilter)) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (query.length >= 2) {
                        handleChangeSearchOptions({ ...(searchOptionsBySource[source] || {}), boardId: null, subfilter: null });
                      } else {
                        setBrowseSubfilters((prev) => ({ ...prev, [source]: null }));
                      }
                    }}
                    className="tl-context-reset-btn"
                  >
                    {isEn ? 'Reset' : 'Limpar'}
                  </button>
                )}
              </div>
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const raw = quickEntityUrl.trim();
                  if (!raw.startsWith('http')) return;
                  const direct = classifyTimelineDirectUrl(raw);
                  const low = raw.toLowerCase();
                  const label = getTimelineSourceDisplayName(direct?.source || source, isEn ? 'en' : 'pt');
                  if (direct?.kind === 'video') {
                    openVideo(
                      {
                        id: `quick-${direct.source}-${raw}`,
                        creatorId: `${direct.source}:direct`,
                        creatorName: label,
                        creatorHandle: `@${direct.source}`,
                        creatorAvatar: '',
                        type: 'video',
                        source: direct.source,
                        originalUrl: raw,
                        videoUrl: `/api/proxy-video-stream?url=${encodeURIComponent(raw)}`,
                        title: label,
                        comments: [],
                        likes: null,
                        date: new Date().toISOString(),
                      },
                      { currentTime: 0, isMuted: false, isPlaying: true, volume: 1, playbackRate: 1 }
                    );
                  } else if (direct?.kind === 'playlist') {
                    void openSearchPlaylist({
                      id: `quick-pl-${raw}`,
                      creatorId: `${direct.source}:direct`,
                      creatorName: label,
                      creatorHandle: `@${direct.source}`,
                      creatorAvatar: '',
                      type: 'playlist',
                      source: direct.source,
                      originalUrl: raw,
                      playlistUrl: raw,
                      title: label,
                      comments: [],
                      likes: null,
                      date: new Date().toISOString(),
                    });
                  } else if (activeSourceCaps?.supportsThreadReader && low.includes('/threads/')) {
                    void openThreadView(raw, label, source);
                  } else if (low.includes('/galleries/') || low.includes('/pics/')) {
                    openGalleryView(raw);
                  } else if (low.includes('/threads/')) {
                    void openThreadView(raw, label, source);
                  } else {
                    openWatchCreator(raw, { name: label });
                  }
                  setQuickEntityUrl('');
                }}
              >
                <input
                  type="url"
                  value={quickEntityUrl}
                  onChange={(e) => setQuickEntityUrl(e.target.value)}
                  placeholder={
                    activeSourceCaps?.archetype === 'video_portal'
                      ? (tBrowse.quickUrlPlaceholderVideoPortal || (isEn ? 'Paste channel, model, or video URL...' : 'Colar URL de canal, modelo ou vídeo...'))
                      : (tBrowse.quickUrlPlaceholder || (isEn ? 'Paste gallery or thread URL...' : 'Colar URL de galeria ou tópico...'))
                  }
                  className="min-w-0 flex-1 rounded-xl border border-[var(--tl-border)] bg-[var(--tl-surface)] px-2.5 py-1.5 text-xs text-[var(--tl-text-primary)] outline-none focus:border-[var(--tl-accent-hover)]"
                />
                <button
                  type="submit"
                  className="min-h-9 rounded-xl bg-[var(--tl-accent)] px-3 py-1.5 text-xs font-bold text-[var(--tl-accent-contrast)] hover:bg-[var(--tl-accent-hover)]"
                >
                  {tBrowse.quickUrlOpen || (isEn ? 'Open' : 'Abrir')}
                </button>
              </form>
              {activeBrowseSubfilters.length > 0 && activeSourceCaps?.archetype !== 'video_portal' && (
                <div className="tl-tags-strip">
                  {activeBrowseSubfilters.map((sub) => {
                    const isSearching = query.length >= 2;
                    const activeSearchSub = searchOptionsBySource[source]?.boardId || searchOptionsBySource[source]?.subfilter || null;
                    const isSubActive = isSearching ? activeSearchSub === sub.id : currentBrowseSubfilter === sub.id;
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => {
                          if (isSearching) {
                            const nextVal = isSubActive ? null : sub.id;
                            const isBoard = Boolean(activeSourceCaps?.searchOptions?.supportsBoardFilter);
                            handleChangeSearchOptions({
                              ...(searchOptionsBySource[source] || {}),
                              ...(isBoard ? { boardId: nextVal, subfilter: nextVal } : { subfilter: nextVal }),
                            });
                            return;
                          }
                          setVisualScopeMode('discover');
                          setBrowseSubfilters((prev) => ({
                            ...prev,
                            [source]: isSubActive ? null : sub.id,
                          }));
                        }}
                        className={`tl-tag-chip ${isSubActive ? 'border-[var(--tl-accent-border)] bg-[var(--tl-accent-soft)] text-[var(--tl-text-primary)]' : ''}`}
                      >
                        {(sub.label_key && tBrowse[sub.label_key]) || sub.fallback_label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Painel de Redes e Fontes Integradas (Opt-In por link no Desktop + Mobile Bottom Sheet) */}
          <div className="tl-context-card" data-integrated-networks-card="true">
            <div className="tl-context-card-header">
              <h3><Layers size={16} aria-hidden />{tBrowse.integratedNetworksTitle || (isEn ? 'Integrated Networks' : 'Redes Integradas')}</h3>
              <div className="flex items-center gap-1.5">
                {integratedSources.length > 0 && (
                  <button
                    type="button"
                    data-reset-sources="true"
                    onClick={() => void handleResetNetworks()}
                    title={tBrowse.resetSourcesBtn || (isEn ? 'Clear all' : 'Limpar todas')}
                    className="tl-context-reset-btn tl-pressable inline-flex items-center gap-1"
                  >
                    <RotateCcw size={12} aria-hidden />
                    <span>{tBrowse.resetSourcesBtn || (isEn ? 'Clear all' : 'Limpar todas')}</span>
                  </button>
                )}
                {(source !== 'all' || xProfile || activeXPost) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (xProfile) setXProfile(undefined);
                      if (xPostStack.length) setXPostStack([]);
                      handleSelectSource('all');
                    }}
                    className="tl-context-reset-btn tl-pressable"
                  >
                    {isEn ? 'Show all' : 'Ver tudo'}
                  </button>
                )}
              </div>
            </div>

            <form
              className="tl-context-link-form"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = desktopOptInUrl.trim();
                if (!trimmed) {
                  setDesktopOptInInvalid(true);
                  return;
                }
                void handleIntegrateOptionA(trimmed);
              }}
              noValidate
            >
              <div className="tl-context-link-row">
                <input
                  type="url"
                  inputMode="url"
                  data-desktop-optin-input="true"
                  value={desktopOptInUrl}
                  onChange={(e) => {
                    setDesktopOptInUrl(e.target.value);
                    if (desktopOptInInvalid) setDesktopOptInInvalid(false);
                    if (lastIntegrationResult) clearLastIntegrationResult();
                  }}
                  placeholder={tBrowse.pasteUrlPlaceholder}
                  aria-label={tBrowse.pasteUrlPlaceholder || (isEn ? 'Paste source or creator URL' : 'Cole link da rede ou perfil')}
                  className="tl-context-link-input tl-focus-ring"
                />
                <button
                  type="submit"
                  disabled={isIntegratingSource}
                  data-desktop-optin-submit="true"
                  className="tl-context-link-submit tl-pressable inline-flex items-center gap-1"
                >
                  <Plus size={14} aria-hidden />
                  <span>{isIntegratingSource ? (tBrowse.integratingBtn || (isEn ? 'Integrating...' : 'Integrando...')) : (tBrowse.integrateBtn || (isEn ? 'Integrate' : 'Integrar'))}</span>
                </button>
              </div>
              {desktopOptInInvalid && (
                <p role="status" className="tl-live-enter text-xs text-rose-400">
                  {tBrowse.integrationInvalidUrl || (isEn ? 'Enter a valid URL.' : 'Informe uma URL válida.')}
                </p>
              )}
              {!desktopOptInInvalid && lastIntegrationResult && (
                lastIntegrationResult.ok && lastIntegrationResult.integration ? (
                  <p role="status" className="tl-integrated-pulse flex items-center gap-1.5 text-xs text-emerald-400">
                    <CheckCircle2 size={14} className="shrink-0" aria-hidden />
                    <span>
                      {lastIntegrationResult.integration.level === 'profile'
                        ? tBrowse.integrationMatchedProfile
                        : tBrowse.integrationMatchedNetwork}
                    </span>
                  </p>
                ) : (
                  <p role="status" className="tl-live-enter text-xs text-rose-400">
                    {lastIntegrationResult.reason === 'unsupported_domain'
                      ? tBrowse.integrationUnsupported
                      : tBrowse.integrationInvalidUrl}
                  </p>
                )
              )}
            </form>

            {platformBreakdown.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] p-3 text-center space-y-1">
                <p className="text-xs font-semibold text-[var(--tl-text-primary)]">
                  {tBrowse.integratedNetworksEmpty || (isEn ? 'No networks integrated yet.' : 'Nenhuma rede integrada ainda.')}
                </p>
                <p className="text-[11px] text-[var(--tl-text-muted)]">
                  {tBrowse.integratedZeroHint || (isEn ? 'Paste a network or profile link above to activate it locally.' : 'Cole acima o link de uma rede ou perfil para ativar localmente.')}
                </p>
              </div>
            ) : (
              <div className="tl-context-platform-list">
                {platformBreakdown.map(({ site, posts: postCount, creators: creatorCount }) => {
                  const isCurrent = source === site;
                  const label = getTimelineSourceDisplayName(site, isEn ? 'en' : 'pt');
                  const isNewlyIntegrated = lastIntegrationResult?.ok && lastIntegrationResult.integration?.sourceId === site;
                  const removeLabel = String(tBrowse.removeSourceLabel || (isEn ? 'Remove source {name}' : 'Remover fonte {name}')).replace('{name}', label);
                  return (
                    <div key={site} className={`tl-context-platform-item tl-live-enter ${isNewlyIntegrated ? 'tl-integrated-pulse' : ''}`}>
                      <button
                        type="button"
                        data-context-source={site}
                        aria-pressed={isCurrent}
                        aria-label={`${isEn ? 'Switch to' : 'Alternar para'} ${label} (${postCount} ${isEn ? 'posts' : 'posts'})`}
                        onClick={() => {
                          if (xProfile) setXProfile(undefined);
                          if (xPostStack.length) setXPostStack([]);
                          handleSelectSource(isCurrent && !xProfile && !activeXPost ? 'all' : site);
                        }}
                        className="tl-context-platform-row tl-pressable flex-1 min-w-0"
                      >
                        <span className="tl-context-platform-icon" data-platform={site}>
                          {renderSourceIcon(site, 14)}
                        </span>
                        <span className="tl-context-platform-info">
                          <strong>{label}</strong>
                          <small>
                            {creatorCount > 0
                              ? `${creatorCount} ${creatorCount === 1 ? (isEn ? 'profile' : 'perfil') : (isEn ? 'profiles' : 'perfis')}`
                              : (isEn ? 'Integrated' : 'Integrada')}
                          </small>
                        </span>
                        <span className="tl-context-platform-count">{postCount}</span>
                      </button>
                      {integratedSourceIds.has(site) && (
                        <button
                          type="button"
                          data-remove-context-source={site}
                          onClick={() => void handleRemoveNetwork(site)}
                          aria-label={removeLabel}
                          title={removeLabel}
                          className="tl-context-platform-remove tl-pressable"
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Criadores Ativos da Fonte — Dinâmico, pesquisável e rolável para TODOS os criadores salvos */}
          {(() => {
            const rawList = source === 'all' || source === 'x' ? displayedCreators : refreshCreators;
            if (rawList.length === 0) return null;
            const filterNorm = savedCreatorFilter.trim().toLowerCase();
            const filteredList = filterNorm
              ? rawList.filter(c => {
                  const cSite = (creatorSites.get(c.id) || 'generic') as TimelinePlatform;
                  return (
                    c.name.toLowerCase().includes(filterNorm) ||
                    (c.handle || '').toLowerCase().includes(filterNorm) ||
                    getTimelineSourceDisplayName(cSite, isEn ? 'en' : 'pt').toLowerCase().includes(filterNorm)
                  );
                })
              : rawList;
            const visibleCreators = showAllSavedCreators || filterNorm ? filteredList : filteredList.slice(0, 10);
            return (
              <div className="tl-context-card" data-saved-creators-card>
                <div className="tl-context-card-header">
                  <h3>
                    <UsersRound size={16} aria-hidden />
                    {source === 'all' || source === 'x'
                      ? isEn
                        ? 'Saved Creators'
                        : 'Criadores Salvos'
                      : isEn
                        ? 'Source Profiles'
                        : 'Perfis desta Fonte'}
                  </h3>
                  <span className="tl-context-badge">{rawList.length}</span>
                </div>
                {rawList.length > 6 && (
                  <div className="tl-context-search-box">
                    <Search size={13} aria-hidden className="shrink-0 text-[var(--tl-text-muted)]" />
                    <input
                      type="search"
                      value={savedCreatorFilter}
                      onChange={e => setSavedCreatorFilter(e.target.value)}
                      placeholder={isEn ? `Filter ${rawList.length} creators…` : `Filtrar ${rawList.length} criadores…`}
                      aria-label={isEn ? 'Filter saved creators' : 'Filtrar criadores salvos'}
                      className="tl-context-search-input"
                    />
                    {savedCreatorFilter && (
                      <button
                        type="button"
                        onClick={() => setSavedCreatorFilter('')}
                        aria-label={isEn ? 'Clear creator filter' : 'Limpar filtro'}
                        className="tl-context-search-clear"
                      >
                        <X size={12} aria-hidden />
                      </button>
                    )}
                  </div>
                )}
                <div className="tl-context-creator-list max-h-[380px] overflow-y-auto pr-0.5">
                  {visibleCreators.map(creator => {
                    const cSite = (creatorSites.get(creator.id) || 'generic') as TimelinePlatform;
                    const cHandle = resolveCreatorHandle({
                      handle: creator.handle,
                      name: creator.name,
                      profileUrl: creator.profileUrl,
                    });
                    const hasValidAv = Boolean(
                      creator.avatar && !creator.avatar.startsWith('data:image/gif') && creator.avatar.length > 20
                    );
                    return (
                      <button
                        key={creator.id}
                        type="button"
                        onClick={event => {
                          if (cSite === 'x') {
                            const hMatch = creator.profileUrl?.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,20})/i);
                            const xHandle = (hMatch?.[1] || cHandle || creator.name).replace(/^@/, '');
                            openXProfile(
                              {
                                handle: xHandle,
                                name: creator.name,
                                avatar: hasValidAv ? creator.avatar : undefined,
                                banner: creator.banner,
                                verified: creator.verified,
                                bio: creator.bio,
                                followers: creator.stats?.followers,
                                postsCount: creator.stats?.posts,
                              },
                              event.currentTarget
                            );
                            return;
                          }
                          if (xProfile) setXProfile(undefined);
                          if (xPostStack.length) setXPostStack([]);
                          openCreator(creator.id, event.currentTarget);
                        }}
                        aria-label={`${isEn ? 'Inspect creator' : 'Inspecionar criador'} ${creator.name}`}
                        className="tl-source-account tl-context-creator-row"
                      >
                        <span className="tl-context-creator-avatar">
                          <SourceAvatar
                            name={creator.name}
                            src={hasValidAv ? creator.avatar : null}
                            profileUrl={creator.profileUrl}
                            referer={creator.profileUrl}
                            lazyHydrate={Boolean(creator.profileUrl)}
                            alt=""
                            className="w-full h-full object-cover rounded-full"
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <strong className="truncate">{creator.name}</strong>
                          <small className="truncate">{cHandle || getTimelineSourceDisplayName(cSite, isEn ? 'en' : 'pt')}</small>
                        </span>
                        <span className="tl-post-source tl-context-mini-source" data-platform={cSite}>
                          {renderSourceIcon(cSite, 11)}
                        </span>
                      </button>
                    );
                  })}
                  {filteredList.length === 0 && (
                    <p className="py-3 text-center text-xs text-[var(--tl-text-muted)]">
                      {isEn ? 'No saved creators match that filter.' : 'Nenhum criador salvo corresponde ao filtro.'}
                    </p>
                  )}
                </div>
                {!filterNorm && filteredList.length > 10 && (
                  <button
                    type="button"
                    onClick={() => setShowAllSavedCreators(prev => !prev)}
                    className="tl-context-show-all-btn"
                  >
                    {showAllSavedCreators
                      ? isEn
                        ? 'Show fewer'
                        : 'Mostrar menos'
                      : isEn
                        ? `Show all ${filteredList.length} creators`
                        : `Ver todos os ${filteredList.length} criadores`}
                  </button>
                )}
              </div>
            );
          })()}
        </aside>
      )}
      </div>

      </div>
      {/* Gaveta Bottom Sheet de Comentários */}
      <CommentsBottomSheet
        post={activeCommentPost}
        isOpen={active && !!activeCommentsPostId}
        onClose={closeComments}
      />

      {/* X Split Photo + Replies Modal */}
      {active && xPhotoModal && (
        <XPhotoThreadModal
          post={xPhotoModal.post}
          initialIndex={xPhotoModal.index}
          isEn={isEn}
          onClose={() => setXPhotoModal(null)}
          onOpenProfile={openXProfile}
          onOpenPostDetail={openXPostDetail}
        />
      )}

      {/* In-App Playlist Modal */}
      {active && activePlaylistPost && (
        <AppDialog
          titleId="tl-search-playlist-modal-title"
          onClose={closePlaylistModal}
          className="tl-playlist-dialog m-auto max-w-2xl w-[min(94vw,680px)] rounded-2xl border border-[var(--tl-border-strong)] bg-[var(--tl-surface)] text-[var(--tl-text-primary)] p-0 shadow-2xl backdrop:bg-black/75"
        >
          <div className="flex flex-col max-h-[85vh]">
            <header className="flex items-start justify-between gap-3 border-b border-[var(--tl-border)] px-4 py-3.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-semibold text-[var(--tl-accent-text)]">
                  <ListVideo size={15} aria-hidden />
                  <span>{isEn ? 'Playlist' : 'Playlist'}</span>
                </div>
                <h3 id="tl-search-playlist-modal-title" className="text-sm sm:text-base font-bold truncate mt-0.5">
                  {activePlaylistPost.title}
                </h3>
                {activePlaylistPost.creatorName && (
                  <p className="text-xs text-[var(--tl-text-muted)] truncate">{activePlaylistPost.creatorName}</p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {activePlaylistPost.originalUrl && (
                  <a
                    href={activePlaylistPost.originalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--tl-border)] px-2.5 py-1 text-xs font-semibold text-[var(--tl-text-secondary)] hover:text-[var(--tl-text-primary)] hover:bg-[var(--tl-surface-hover)]"
                  >
                    <ExternalLink size={12} aria-hidden />
                    <span>{isEn ? 'Open on source' : 'Abrir na fonte'}</span>
                  </a>
                )}
                <button
                  type="button"
                  onClick={closePlaylistModal}
                  aria-label={isEn ? 'Close' : 'Fechar'}
                  className="p-1.5 rounded-full text-[var(--tl-text-muted)] hover:text-[var(--tl-text-primary)] hover:bg-[var(--tl-surface-hover)]"
                >
                  <X size={16} aria-hidden />
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-3.5 space-y-2">
              {playlistModalLoading && (
                <div className="flex items-center justify-center py-10 gap-2 text-xs text-[var(--tl-text-muted)]">
                  <Loader2 size={16} className="animate-spin text-[var(--tl-accent-text)]" />
                  <span>{isEn ? 'Loading playlist videos…' : 'Carregando vídeos da playlist…'}</span>
                </div>
              )}
              {!playlistModalLoading && playlistModalError && (
                <p className="py-8 text-center text-xs text-rose-400">{playlistModalError}</p>
              )}
              {!playlistModalLoading && !playlistModalError && playlistModalVideos.length === 0 && (
                <p className="py-8 text-center text-xs text-[var(--tl-text-muted)]">
                  {isEn ? 'No videos found in this playlist.' : 'Nenhum vídeo disponível nesta playlist.'}
                </p>
              )}
              {!playlistModalLoading && playlistModalVideos.map((vid, idx) => (
                <button
                  key={vid.id || idx}
                  type="button"
                  data-playlist-track={vid.id}
                  onClick={() => {
                    closePlaylistModal();
                    openVideo(vid, { currentTime: 0, isMuted: false, isPlaying: true });
                  }}
                  className="w-full flex items-center gap-3 rounded-xl border border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] p-2 text-left hover:border-[var(--tl-accent-border)] hover:bg-[var(--tl-surface-hover)] transition-colors group"
                >
                  <span className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-black/50">
                    {vid.thumbnail && (
                      <img src={vid.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                    )}
                    <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-85 group-hover:opacity-100">
                      <Play size={16} className="text-white fill-white" aria-hidden />
                    </span>
                    {vid.duration && (
                      <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 text-[10px] font-mono text-white">
                        {vid.duration}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-xs font-semibold text-[var(--tl-text-primary)] line-clamp-2">
                      {vid.title}
                    </strong>
                    {vid.views && (
                      <small className="block text-[11px] text-[var(--tl-text-muted)] mt-0.5">
                        {vid.views}
                      </small>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </AppDialog>
      )}

      {/* Mobile Bottom Sheet for Integrated Networks + Option A Link Integration */}
      <TimelineSourcesSheet
        open={active && effectiveSourcesSheetOpen}
        onClose={() => setEffectiveSourcesSheetOpen(false)}
        integratedSources={integratedSources}
        activeSource={source}
        creatorEntries={(displayedCreators || []).map((c): SheetCreatorEntry => {
          const sid = (creatorSites.get(c.id) || 'generic') as string;
          return {
            id: c.id,
            name: c.name,
            handle: resolveCreatorHandle({ handle: c.handle, name: c.name, profileUrl: c.profileUrl }),
            avatar: c.avatar || '',
            profileUrl: c.profileUrl,
            site: sid,
            postCount: combinedFeed.posts.filter(p => p.creatorId === c.id).length,
          };
        })}
        creatorSearch={savedCreatorFilter}
        postCountBySource={Object.fromEntries(platformBreakdown.map(row => [row.site, row.posts]))}
        creatorCountBySource={Object.fromEntries(platformBreakdown.map(row => [row.site, row.creators]))}
        integrating={isIntegratingSource}
        lastIntegrationResult={lastIntegrationResult}
        onCreatorSearchChange={setSavedCreatorFilter}
        onSelectSource={(sid) => {
          if (xProfile) setXProfile(undefined);
          if (xPostStack.length) setXPostStack([]);
          handleSelectSource(sid as TimelineSource);
        }}
        onSelectCreator={(cid) => {
          const targetCreator = combinedFeed.creators.find(c => c.id === cid);
          if (targetCreator && creatorSites.get(targetCreator.id) === 'x') {
            const cHandle = resolveCreatorHandle({
              handle: targetCreator.handle,
              name: targetCreator.name,
              profileUrl: targetCreator.profileUrl,
            });
            openXProfile(
              {
                handle: cHandle.replace(/^@/, ''),
                name: targetCreator.name,
                avatar: targetCreator.avatar,
              },
              timelineRef.current || document.body
            );
            return;
          }
          if (xProfile) setXProfile(undefined);
          if (xPostStack.length) setXPostStack([]);
          openCreator(cid);
        }}
        onIntegrateUrl={async (url) => {
          await handleIntegrateOptionA(url);
        }}
        onRemoveSource={handleRemoveNetwork}
        onResetSources={handleResetNetworks}
        triggerRef={sourcesTriggerRef}
      />

      {/* Lightbox de Fotos */}
      {active && <PhotoLightboxModal
        lightbox={lightbox}
        onClose={closeLightbox}
        onNext={nextLightboxImage}
        onPrev={prevLightboxImage}
      />}
    </div>
  );
};
