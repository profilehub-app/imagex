import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Compass,
  Film,
  Flame,
  FolderHeart,
  Image as ImageIcon,
  ListVideo,
  Loader2,
  MessageSquare,
  RotateCcw,
  Search,
  SlidersHorizontal,
  UserCheck,
  Users,
} from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { translations } from '../../../i18n/translations';
import {
  filterSnapshotBySourceAndCategory,
  getDeduplicatedAllItems,
  getSearchRenderSliceState,
  hasMoreForCategory,
  postSourceId,
  profileSourceId,
  resolveSearchPostCreatorTarget,
  type SearchCategoryTab,
  type SearchFilterOptions,
  type SearchSourceDescriptor,
  type TimelineSearchSnapshot,
} from '../../../services/timelineSearch';
import type { ForumBoardSection } from '../../../services/timelineBrowse';
import { isOfflineTimelinePost } from '../../../services/timelineImport';
import { TimelineImportedPost } from './TimelineLocalImport';
import { XTimelineCard, type XAccount, type XPost } from './LiveSocialTimeline';
import { TimelinePlaybackHandoff, TimelinePostCard } from './TimelinePostCard';
import {
  CategoryShowcaseCard,
  EditorialGalleryCard,
  ForumThreadRow,
} from './AdaptiveSourceCards';
import {
  getDynamicSource,
  getSourceCapabilities,
  type DynamicSourceSubfilter,
} from './timelineSourceCapabilities';
import { renderSourceIcon } from './TimelineSourceBar';
import { TIMELINE_SOURCES, type TimelineSource } from './timelineSourceNavigation';
import { SourceAvatar } from '../common/SourceAvatar';
import type { TimelineCreator, TimelineEntityRef, TimelinePhotoItem, TimelinePost } from './timelineModel';

export interface TimelineSearchResultsProps {
  snapshot: TimelineSearchSnapshot | null;
  query: string;
  activeSource: string;
  activeCategory: SearchCategoryTab;
  availableSources: readonly SearchSourceDescriptor[];
  xPostsMode: 'top' | 'latest';
  knownCreatorIds: ReadonlySet<string>;
  suspended?: boolean;
  isEn: boolean;
  isLoadingInitial: boolean;
  isLoadingMore: boolean;
  onSelectSource: (sourceId: string) => void;
  onSelectCategory: (category: SearchCategoryTab) => void;
  onChangeXPostsMode: (mode: 'top' | 'latest') => void;
  onLoadMore: () => void;
  onOpenProfile: (creatorIdOrUrl: string, trigger?: HTMLElement, seed?: { name?: string; avatar?: string }) => void;
  onOpenXProfile: (account: XAccount, trigger: HTMLElement) => void;
  onOpenXPostDetail: (post: XPost) => void;
  onOpenVideo: (post: TimelinePost, handoff: TimelinePlaybackHandoff) => void;
  onOpenLightbox: (
    images: string[],
    index: number,
    title: string,
    albumUrl?: string,
    items?: TimelinePhotoItem[],
    expectedCount?: number,
  ) => void;
  onOpenComments: (post: TimelinePost) => void;
  onOpenGallery?: (post: TimelinePost) => void;
  onOpenEntity?: (entity: TimelineEntityRef) => void;
  onOpenThread?: (post: TimelinePost) => void;
  onOpenPlaylist: (post: TimelinePost) => void;
  activeSearchOptions?: SearchFilterOptions;
  onChangeSearchOptions?: (next: SearchFilterOptions) => void;
  activeSourceSubfilters?: readonly DynamicSourceSubfilter[];
  forumBoardSections?: readonly ForumBoardSection[];
  forumBoardsLoading?: boolean;
  onOpenDirectoryFromSearch?: (kind: string, initialFilter: string) => void;
}

function sourceDisplayLabel(
  sourceId: string,
  descriptors: readonly SearchSourceDescriptor[],
  isEn: boolean,
): string {
  const known = TIMELINE_SOURCES[sourceId as TimelineSource];
  if (known) return known[isEn ? 'en' : 'pt'];
  const desc = descriptors.find(s => s.id.toLowerCase() === sourceId.toLowerCase());
  return desc?.name || sourceId;
}

function postStableKey(post: TimelinePost): string {
  return (post.originalUrl || post.id).trim().toLowerCase();
}

const SEARCH_BUFFER_VIEWPORTS = 1;
const SEARCH_UNMEASURED_CARD_COUNT = 4;

export const TimelineSearchResults: React.FC<TimelineSearchResultsProps> = ({
  snapshot,
  query,
  activeSource,
  activeCategory,
  availableSources,
  xPostsMode,
  knownCreatorIds,
  suspended = false,
  isEn,
  isLoadingInitial,
  isLoadingMore,
  onSelectSource,
  onSelectCategory,
  onChangeXPostsMode,
  onLoadMore,
  onOpenProfile,
  onOpenXProfile,
  onOpenXPostDetail,
  onOpenVideo,
  onOpenLightbox,
  onOpenComments,
  onOpenGallery,
  onOpenEntity,
  onOpenThread,
  onOpenPlaylist,
  activeSearchOptions,
  onChangeSearchOptions,
  activeSourceSubfilters,
  forumBoardSections,
  forumBoardsLoading = false,
  onOpenDirectoryFromSearch,
}) => {
  const lang = useAppStore(state => state.settings?.language || (isEn ? 'en-US' : 'pt-BR'));
  const t = translations[lang].timelineSearch;
  const tBrowse = (translations[lang] as any).timelineBrowse || {};
  const sentinelRef = useRef<HTMLDivElement>(null);

  const sourcePills = useMemo(() => {
    const map = new Map<string, SearchSourceDescriptor>();
    for (const s of availableSources) {
      map.set(s.id.toLowerCase(), s);
    }
    if (snapshot) {
      for (const prof of snapshot.profiles) {
        const sid = profileSourceId(prof);
        if (sid && !map.has(sid)) {
          map.set(sid, {
            id: sid,
            name: sourceDisplayLabel(sid, availableSources, isEn),
            categories: ['profiles', 'posts'],
            supportsLiveConnector: false,
          });
        }
      }
      for (const item of getDeduplicatedAllItems(snapshot)) {
        const sid = postSourceId(item);
        if (sid && !map.has(sid)) {
          map.set(sid, {
            id: sid,
            name: sourceDisplayLabel(sid, availableSources, isEn),
            categories: ['posts', 'videos', 'albums'],
            supportsLiveConnector: false,
          });
        }
      }
    }
    return [...map.values()];
  }, [availableSources, snapshot, isEn]);

  const countsBySource = useMemo(() => {
    const counts = new Map<string, number>();
    if (!snapshot) return counts;
    for (const prof of snapshot.profiles) {
      const sid = profileSourceId(prof);
      counts.set(sid, (counts.get(sid) || 0) + 1);
    }
    for (const item of getDeduplicatedAllItems(snapshot)) {
      const sid = postSourceId(item);
      counts.set(sid, (counts.get(sid) || 0) + 1);
    }
    return counts;
  }, [snapshot]);

  const sourceScoped = useMemo(() => {
    if (!snapshot) return null;
    return filterSnapshotBySourceAndCategory(snapshot, activeSource, 'all');
  }, [snapshot, activeSource]);

  const allTotalCount = useMemo(() => {
    if (!sourceScoped) return 0;
    return sourceScoped.profiles.length + getDeduplicatedAllItems(sourceScoped).length;
  }, [sourceScoped]);

  const categoryTabs: Array<{ id: SearchCategoryTab; label: string; count: number; icon: React.ReactNode }> = useMemo(() => {
    const allTabs: Array<{ id: SearchCategoryTab; label: string; count: number; icon: React.ReactNode }> = [
      { id: 'all', label: t.categoryAll, count: allTotalCount, icon: <Search size={13} aria-hidden /> },
      { id: 'profiles', label: t.categoryProfiles, count: sourceScoped?.profiles.length || 0, icon: <Users size={14} aria-hidden /> },
      { id: 'playlists', label: t.categoryPlaylists, count: sourceScoped?.playlists.length || 0, icon: <ListVideo size={14} aria-hidden /> },
      { id: 'videos', label: t.categoryVideos, count: sourceScoped?.videos.length || 0, icon: <Film size={14} aria-hidden /> },
      { id: 'shorts', label: t.categoryShorts, count: sourceScoped?.shorts.length || 0, icon: <Flame size={14} aria-hidden /> },
      { id: 'albums', label: t.categoryAlbums, count: sourceScoped?.albums.length || 0, icon: <ImageIcon size={14} aria-hidden /> },
      { id: 'gifs', label: t.categoryGifs, count: sourceScoped?.gifs.length || 0, icon: <FolderHeart size={14} aria-hidden /> },
      { id: 'posts', label: t.categoryPosts, count: sourceScoped?.posts.length || 0, icon: <MessageSquare size={14} aria-hidden /> },
    ];
    if (!activeSource || activeSource === 'all') return allTabs;
    const caps = getSourceCapabilities(activeSource);
    const allowed = new Set((caps.searchCategories || []).map((c) => c.toLowerCase()));
    return allTabs.filter((tab) => {
      if (tab.id === 'all') return true;
      if (tab.id === 'profiles') return allowed.has('users') || allowed.has('profiles');
      if (tab.id === 'albums') return allowed.has('albums') || allowed.has('photos');
      return allowed.has(tab.id);
    });
  }, [t, allTotalCount, sourceScoped, activeSource]);

  const normSource = (activeSource || 'all').toLowerCase();
  const hasMoreForActiveView = useMemo(
    () => hasMoreForCategory(snapshot, activeSource, activeCategory),
    [snapshot, activeSource, activeCategory],
  );
  const profiles = sourceScoped?.profiles || [];
  const playlists = sourceScoped?.playlists || [];
  const videos = sourceScoped?.videos || [];
  const shorts = sourceScoped?.shorts || [];
  const albums = sourceScoped?.albums || [];
  const gifs = sourceScoped?.gifs || [];
  const postsRaw = sourceScoped?.posts || [];

  // In 'All' view, avoid rendering the exact same X video tweet twice back-to-back in Videos & Posts
  const postsInAll = useMemo(() => {
    if (activeCategory !== 'all') return postsRaw;
    const vidKeys = new Set(videos.map(postStableKey));
    return postsRaw.filter(p => !vidKeys.has(postStableKey(p)));
  }, [activeCategory, postsRaw, videos]);
  const renderedPosts = activeCategory === 'all' ? postsInAll : postsRaw;

  const activeCategoryCount = categoryTabs.find(tab => tab.id === activeCategory)?.count || 0;
  const countBeforeLoadRef = useRef<number>(activeCategoryCount);
  const wasLoadingMoreRef = useRef(false);
  const autoLoadStalledRef = useRef(false);

  const workspaceRef = useRef<HTMLElement | null>(null);
  const [renderPageSize, setRenderPageSize] = useState(SEARCH_UNMEASURED_CARD_COUNT);
  const renderWindowsRef = useRef(new Map<string, number>());
  const windowQueryRef = useRef(query);
  if (windowQueryRef.current !== query) {
    windowQueryRef.current = query;
    renderWindowsRef.current.clear();
  }
  const windowKey = JSON.stringify([query, normSource, activeCategory]);
  const [renderWindow, setRenderWindow] = useState({ key: windowKey, count: SEARCH_UNMEASURED_CARD_COUNT });
  const rememberedWindow = renderWindowsRef.current.get(windowKey) ?? 0;
  const currentWindowCount = renderWindow.key === windowKey
    ? renderWindow.count
    : Math.max(rememberedWindow, renderPageSize);

  const sectionCounts = useMemo(
    () => ({
      profiles: profiles.length,
      playlists: playlists.length,
      videos: videos.length,
      shorts: shorts.length,
      albums: albums.length,
      gifs: gifs.length,
      posts: renderedPosts.length,
    }),
    [profiles.length, playlists.length, videos.length, shorts.length, albums.length, gifs.length, renderedPosts.length],
  );
  const { caps, hasMoreInWindow, shouldPrefetchRemote } = useMemo(
    () => getSearchRenderSliceState(sectionCounts, activeCategory, currentWindowCount, renderPageSize),
    [sectionCounts, activeCategory, currentWindowCount, renderPageSize],
  );

  const visibleProfiles = useMemo(() => profiles.slice(0, caps.profiles), [profiles, caps.profiles]);
  const visiblePlaylists = useMemo(() => playlists.slice(0, caps.playlists), [playlists, caps.playlists]);
  const visibleVideos = useMemo(() => videos.slice(0, caps.videos), [videos, caps.videos]);
  const visibleShorts = useMemo(() => shorts.slice(0, caps.shorts), [shorts, caps.shorts]);
  const visibleAlbums = useMemo(() => albums.slice(0, caps.albums), [albums, caps.albums]);
  const visibleGifs = useMemo(() => gifs.slice(0, caps.gifs), [gifs, caps.gifs]);
  const visiblePosts = useMemo(() => renderedPosts.slice(0, caps.posts), [renderedPosts, caps.posts]);

  const firstVisibleItemKey =
    visibleVideos[0]?.id ||
    visibleProfiles[0]?.id ||
    visiblePlaylists[0]?.id ||
    visibleAlbums[0]?.id ||
    visibleShorts[0]?.id ||
    visibleGifs[0]?.id ||
    visiblePosts[0]?.id ||
    '';

  useEffect(() => {
    autoLoadStalledRef.current = false;
  }, [query, normSource, activeCategory]);

  useEffect(() => {
    if (isLoadingMore && !wasLoadingMoreRef.current) {
      countBeforeLoadRef.current = activeCategoryCount;
    } else if (!isLoadingMore && wasLoadingMoreRef.current) {
      autoLoadStalledRef.current = activeCategoryCount <= countBeforeLoadRef.current;
    }
    wasLoadingMoreRef.current = isLoadingMore;
  }, [isLoadingMore, activeCategoryCount]);

  useLayoutEffect(() => {
    renderWindowsRef.current.set(windowKey, currentWindowCount);
  }, [windowKey, currentWindowCount]);

  useLayoutEffect(() => {
    if (renderWindow.key !== windowKey) {
      setRenderWindow({
        key: windowKey,
        count: Math.max(renderWindowsRef.current.get(windowKey) ?? 0, renderPageSize),
      });
    }
  }, [windowKey, renderWindow.key, renderPageSize]);

  // Measure viewport & card height identically to Timeline feed so initial mount stays lightweight
  useLayoutEffect(() => {
    if (suspended) return;
    const ws = workspaceRef.current;
    if (!ws) return;
    const firstCard = ws.querySelector<HTMLElement>('[data-timeline-post-id], [data-search-profile-card]');
    const main = ws.closest('main');
    if (!firstCard) return;
    const measure = () => {
      const cardHeight = firstCard.getBoundingClientRect().height;
      const vh = main?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0);
      if (cardHeight <= 0 || vh <= 0) return;
      const listEl = firstCard.parentElement;
      const listStyle = listEl ? getComputedStyle(listEl) : null;
      const gap = listStyle ? (parseFloat(listStyle.rowGap) || 12) : 12;
      const columns = listStyle && listStyle.display === 'grid'
        ? Math.max(1, listStyle.gridTemplateColumns.split(' ').length)
        : 1;
      const rawPageSize = Math.max(
        SEARCH_UNMEASURED_CARD_COUNT,
        Math.ceil((vh * (1 + SEARCH_BUFFER_VIEWPORTS)) / (cardHeight + gap)) * columns,
      );
      const nextPageSize = Math.min(8, Math.max(SEARCH_UNMEASURED_CARD_COUNT, rawPageSize));
      setRenderPageSize(nextPageSize);
      setRenderWindow(cur => ({
        key: windowKey,
        count: Math.max(cur.key === windowKey ? cur.count : (renderWindowsRef.current.get(windowKey) ?? 0), nextPageSize),
      }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    if (main) observer.observe(main);
    observer.observe(firstCard);
    return () => observer.disconnect();
  }, [suspended, windowKey, firstVisibleItemKey]);

  const expandWindow = useCallback(() => {
    setRenderWindow(cur => ({
      key: windowKey,
      count: (cur.key === windowKey ? cur.count : renderPageSize) + renderPageSize,
    }));
  }, [windowKey, renderPageSize]);

  const triggerMoreSearch = useCallback((manual = false) => {
    if (hasMoreInWindow) {
      expandWindow();
    }
    const wantsRemoteFetch = !hasMoreInWindow || shouldPrefetchRemote;
    if (
      hasMoreForActiveView &&
      !isLoadingMore &&
      wantsRemoteFetch &&
      (manual || !autoLoadStalledRef.current)
    ) {
      if (manual) autoLoadStalledRef.current = false;
      onLoadMore();
    }
  }, [hasMoreInWindow, expandWindow, hasMoreForActiveView, isLoadingMore, shouldPrefetchRemote, onLoadMore]);

  const triggerMoreRef = useRef(triggerMoreSearch);
  triggerMoreRef.current = triggerMoreSearch;
  const canAutoAdvance = hasMoreInWindow || (hasMoreForActiveView && !autoLoadStalledRef.current);

  // Timeline-matched progressive lazy loader: expands windowed DOM batches & prefetches remote pages without blocking buffered scroll
  useEffect(() => {
    const node = sentinelRef.current;
    if (suspended || !node || !canAutoAdvance || isLoadingInitial || (!hasMoreInWindow && isLoadingMore)) {
      return;
    }
    const main = node.closest('main');
    const scrollTarget: HTMLElement | Window = main || window;
    let armed = false;
    let touchY: number | undefined;
    let loadedOnTouch = false;
    let lastScrollTop = main ? main.scrollTop : (typeof window !== 'undefined' ? window.scrollY : 0);

    const checkEnd = () => {
      if (!armed) return;
      const end = node.getBoundingClientRect();
      const viewportTop = main ? main.getBoundingClientRect().top : 0;
      const viewportBottom = main ? main.getBoundingClientRect().bottom : window.innerHeight;
      if (end.top < viewportBottom + 280 && end.bottom > viewportTop) {
        armed = false;
        if (touchY !== undefined) loadedOnTouch = true;
        triggerMoreRef.current(false);
      }
    };

    const wheel = (e: WheelEvent) => {
      if (e.deltaY > 0) {
        armed = true;
        checkEnd();
      }
    };
    const touchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY;
      loadedOnTouch = false;
    };
    const checkTouch = (nextY?: number) => {
      if (loadedOnTouch || touchY === undefined || nextY === undefined || nextY >= touchY - 8) return;
      armed = true;
      checkEnd();
    };
    const touchMove = (e: TouchEvent) => checkTouch(e.touches[0]?.clientY);
    const touchEnd = (e: TouchEvent) => {
      checkTouch(e.changedTouches[0]?.clientY);
      touchY = undefined;
    };
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowDown', 'PageDown', 'End', ' '].includes(e.key) && !e.shiftKey) {
        armed = true;
        checkEnd();
      }
    };
    const onScroll = () => {
      const cur = main ? main.scrollTop : window.scrollY;
      if (cur > lastScrollTop) armed = true;
      lastScrollTop = cur;
      checkEnd();
    };

    const observer = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(checkEnd, { root: main ?? null, rootMargin: '280px 0px' });
    observer?.observe(node);
    scrollTarget.addEventListener('wheel', wheel as EventListener, { passive: true });
    scrollTarget.addEventListener('touchstart', touchStart as EventListener, { passive: true });
    scrollTarget.addEventListener('touchmove', touchMove as EventListener, { passive: true });
    scrollTarget.addEventListener('touchend', touchEnd as EventListener, { passive: true });
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', key);
    return () => {
      observer?.disconnect();
      scrollTarget.removeEventListener('wheel', wheel as EventListener);
      scrollTarget.removeEventListener('touchstart', touchStart as EventListener);
      scrollTarget.removeEventListener('touchmove', touchMove as EventListener);
      scrollTarget.removeEventListener('touchend', touchEnd as EventListener);
      scrollTarget.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', key);
    };
  }, [
    suspended,
    canAutoAdvance,
    isLoadingMore,
    isLoadingInitial,
    windowKey,
  ]);

  const handleOpenCreatorCard = (c: TimelineCreator, triggerEl: HTMLElement) => {
    const cSite = profileSourceId(c);
    if (cSite === 'x') {
      onOpenXProfile(
        {
          handle: (c.handle || c.name).replace(/^@/, ''),
          name: c.name,
          avatar: c.avatar,
          banner: c.banner,
          verified: c.verified,
          bio: c.bio,
          followers: c.stats?.followers,
          postsCount: c.stats?.posts,
        },
        triggerEl,
      );
      return;
    }
    if (c.profileUrl) {
      onOpenProfile(c.profileUrl, triggerEl, { name: c.name, avatar: c.avatar });
    } else if (c.id) {
      onOpenProfile(c.id, triggerEl, { name: c.name, avatar: c.avatar });
    }
  };

  const renderFeedItem = (post: TimelinePost, sectionKey: string) => {
    const liveX = snapshot?.liveXPosts?.[post.id];
    if (liveX) {
      return (
        <XTimelineCard
          key={`${sectionKey}:${post.id}`}
          id={post.id}
          item={liveX}
          active={!suspended}
          isEn={isEn}
          onOpenProfile={onOpenXProfile}
          onOpenMedia={onOpenLightbox}
          onOpenPostDetail={onOpenXPostDetail}
          onOpenVideo={onOpenVideo}
          onOpenComments={snap => onOpenComments(snap)}
        />
      );
    }
    if (isOfflineTimelinePost(post)) {
      return (
        <TimelineImportedPost
          key={`${sectionKey}:${post.id}`}
          post={post}
          isEn={isEn}
          inFeed
          sourceLabel={sourceDisplayLabel(postSourceId(post), availableSources, isEn)}
        />
      );
    }
    const sid = postSourceId(post);
    const postCaps = getSourceCapabilities(sid, post);
    const handleEntityOpen = (entity: TimelineEntityRef) => {
      if (onOpenEntity) {
        onOpenEntity(entity);
      } else if (entity.url) {
        onOpenProfile(entity.url, undefined, { name: entity.name });
      }
    };
    if (postCaps.layoutMode === 'forum_index') {
      return (
        <ForumThreadRow
          key={`${sectionKey}:${post.id}`}
          post={post}
          isEn={isEn}
          onOpenThread={(p) => {
            if (onOpenThread) onOpenThread(p);
          }}
          onOpenLightbox={onOpenLightbox}
          onOpenEntity={handleEntityOpen}
        />
      );
    }
    if (postCaps.layoutMode === 'editorial_wall') {
      return (
        <EditorialGalleryCard
          key={`${sectionKey}:${post.id}`}
          post={post}
          sourceLabel={sourceDisplayLabel(sid, availableSources, isEn)}
          isEn={isEn}
          onOpenGallery={(p) => {
            if (onOpenGallery) onOpenGallery(p);
          }}
          onOpenLightbox={onOpenLightbox}
          onOpenEntity={handleEntityOpen}
        />
      );
    }
    if (postCaps.layoutMode === 'category_showcase') {
      return (
        <CategoryShowcaseCard
          key={`${sectionKey}:${post.id}`}
          post={post}
          sourceLabel={sourceDisplayLabel(sid, availableSources, isEn)}
          isEn={isEn}
          onOpenGallery={(p) => {
            if (onOpenGallery) onOpenGallery(p);
          }}
          onOpenLightbox={onOpenLightbox}
          onOpenEntity={handleEntityOpen}
        />
      );
    }
    const creatorTarget = resolveSearchPostCreatorTarget(post, knownCreatorIds);
    const openPostCreator = creatorTarget
      ? (_cid: string, el?: HTMLElement) => {
          if (creatorTarget.kind === 'x') {
            onOpenXProfile(creatorTarget.account, el ?? document.body);
          } else if (creatorTarget.kind === 'url') {
            onOpenProfile(creatorTarget.url, el, { name: post.creatorName, avatar: post.creatorAvatar });
          } else {
            onOpenProfile(creatorTarget.creatorId, el, { name: post.creatorName, avatar: post.creatorAvatar });
          }
        }
      : undefined;
    return (
      <TimelinePostCard
        key={`${sectionKey}:${post.id}`}
        post={post}
        suspended={suspended}
        sourceLabel={sourceDisplayLabel(sid, availableSources, isEn)}
        onOpenProfile={openPostCreator}
        onOpenEntity={(entity, _src, trigger) => {
          if (entity.url) onOpenProfile(entity.url, trigger, { name: entity.name });
        }}
        onOpenThread={onOpenThread}
        onOpenComments={() => onOpenComments(post)}
        onOpenLightbox={onOpenLightbox}
        onOpenVideo={onOpenVideo}
        onOpenPlaylist={onOpenPlaylist}
      />
    );
  };

  const sectionListClassName = (items: readonly TimelinePost[]): string => {
    if (!items.length) return 'tl-feed-list';
    const modes = new Set(items.map(p => getSourceCapabilities(postSourceId(p), p).layoutMode));
    if (modes.size === 1) {
      if (modes.has('editorial_wall')) return 'tl-feed-list tl-editorial-wall-grid';
      if (modes.has('category_showcase')) return 'tl-feed-list tl-category-showcase-grid';
      if (modes.has('forum_index')) return 'tl-feed-list tl-forum-thread-list';
    }
    return 'tl-feed-list';
  };

  const showProfiles = activeCategory === 'all' || activeCategory === 'profiles';
  const showPlaylists = activeCategory === 'all' || activeCategory === 'playlists';
  const showVideos = activeCategory === 'all' || activeCategory === 'videos';
  const showShorts = activeCategory === 'all' || activeCategory === 'shorts';
  const showAlbums = activeCategory === 'all' || activeCategory === 'albums';
  const showGifs = activeCategory === 'all' || activeCategory === 'gifs';
  const showPosts = activeCategory === 'all' || activeCategory === 'posts';

  const activeCountEmpty =
    (activeCategory === 'all' && allTotalCount === 0) ||
    (activeCategory === 'profiles' && profiles.length === 0) ||
    (activeCategory === 'playlists' && playlists.length === 0) ||
    (activeCategory === 'videos' && videos.length === 0) ||
    (activeCategory === 'shorts' && shorts.length === 0) ||
    (activeCategory === 'albums' && albums.length === 0) ||
    (activeCategory === 'gifs' && gifs.length === 0) ||
    (activeCategory === 'posts' && renderedPosts.length === 0);
  const canContinueEmptySearch = activeCountEmpty && hasMoreForActiveView;

  const renderSectionHeader = (
    cat: SearchCategoryTab,
    icon: React.ReactNode,
    label: string,
    shownCount: number,
    totalCount: number,
  ) => (
    <div className="flex items-center justify-between gap-2">
      <h3 className="tl-search-section-heading">
        {icon}
        <span>{label}</span>
        <span className="tl-search-section-badge">{totalCount}</span>
      </h3>
      {activeCategory === 'all' && shownCount < totalCount && (
        <button
          type="button"
          onClick={() => onSelectCategory(cat)}
          className="text-xs font-semibold text-[var(--tl-accent-text-strong)] hover:underline shrink-0"
        >
          {isEn ? `See all (${totalCount})` : `Ver todos (${totalCount})`}
        </button>
      )}
    </div>
  );

  const activeSourceCaps = useMemo(
    () => (normSource && normSource !== 'all' ? getSourceCapabilities(normSource) : null),
    [normSource],
  );
  const resolvedSubfilters = useMemo(() => {
    if (!normSource || normSource === 'all') return [];
    if (activeSourceSubfilters && activeSourceSubfilters.length > 0) return [...activeSourceSubfilters];
    const fromDesc = availableSources.find((s) => s.id.toLowerCase() === normSource)?.subfilters;
    if (fromDesc && fromDesc.length > 0) return [...fromDesc];
    return getDynamicSource(normSource)?.subfilters || [];
  }, [normSource, activeSourceSubfilters, availableSources]);

  const currentOpts: SearchFilterOptions = activeSearchOptions || {};
  const hasActiveSearchOptions = Boolean(
    currentOpts.boardId ||
    currentOpts.subfilter ||
    (currentOpts.searchScope && currentOpts.searchScope !== 'titles') ||
    (currentOpts.mediaFilter && currentOpts.mediaFilter !== 'all') ||
    (currentOpts.sortBy && currentOpts.sortBy !== 'relevance'),
  );
  const updateSearchOpt = (patch: Partial<SearchFilterOptions>) => {
    onChangeSearchOptions?.({ ...currentOpts, ...patch });
  };
  const resetSearchOpts = () => {
    onChangeSearchOptions?.({});
  };

  const tagSubfilters = useMemo(
    () => resolvedSubfilters.filter((sf) => sf.group !== 'sort'),
    [resolvedSubfilters],
  );
  const searchOptSpec = activeSourceCaps?.searchOptions;
  const showSourceOptionsPanel = Boolean(
    normSource !== 'all' &&
    activeSourceCaps &&
    (
      searchOptSpec?.supportsBoardFilter ||
      searchOptSpec?.supportsSearchScope ||
      searchOptSpec?.supportsMediaFilter ||
      (searchOptSpec?.supportsSubfilterSearch && tagSubfilters.length > 0) ||
      (activeSourceCaps.supportsDirectories && activeSourceCaps.directoryKinds.length > 0) ||
      (normSource === 'x' && snapshot?.xLiveStatus === 'live')
    ),
  );

  return (
    <section
      ref={workspaceRef}
      className="tl-search-workspace space-y-4 min-w-0 w-full"
      data-search-workspace="true"
      aria-label={isEn ? `Search results for ${query}` : `Resultados da busca por ${query}`}
    >
      {/* Federated Source Pills & Source-Adapted Search Options */}
      <div className="tl-search-header-card">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2 min-w-0 text-xs font-semibold text-[var(--tl-text-primary)]">
            {isLoadingInitial || (snapshot?.loadingSources.length ?? 0) > 0 ? (
              <>
                <Loader2 size={14} className="animate-spin text-[var(--tl-accent-text)] shrink-0" />
                <span className="truncate">{t.searchingAllSources}</span>
              </>
            ) : (
              <>
                <Search size={14} className="text-[var(--tl-accent-text)] shrink-0" />
                <span className="truncate">
                  “{query}” · {allTotalCount} {isEn ? 'results' : 'resultados'}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {hasActiveSearchOptions && onChangeSearchOptions && (
              <button
                type="button"
                data-search-reset-options="true"
                onClick={resetSearchOpts}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] px-2.5 py-1 text-[11px] font-semibold text-[var(--tl-text-secondary)] hover:border-[var(--tl-accent-border)] hover:text-[var(--tl-text-primary)] cursor-pointer transition-colors"
              >
                <RotateCcw size={11} aria-hidden="true" />
                <span>{isEn ? 'Reset filters' : 'Limpar filtros'}</span>
              </button>
            )}
            {snapshot?.xLiveStatus === 'login_required' && (normSource === 'all' || normSource === 'x') && (
              <span className="text-[11px] font-medium text-[var(--tl-text-muted)] flex items-center gap-1">
                <UserCheck size={12} aria-hidden />
                {t.xSignInHint}
              </span>
            )}
          </div>
        </div>

        {/* Source Filter Pills (wrapped cleanly so every integrated source is visible) */}
        <div className="tl-search-pill-row" role="tablist" aria-label={isEn ? 'Search sources' : 'Fontes da busca'}>
          <button
            type="button"
            role="tab"
            aria-selected={normSource === 'all'}
            data-search-source-pill="all"
            onClick={() => onSelectSource('all')}
            className={`tl-search-pill ${normSource === 'all' ? 'is-active' : ''}`}
          >
            <span>{t.allSources}</span>
            <span className="tl-search-pill-count">
              {snapshot ? snapshot.profiles.length + getDeduplicatedAllItems(snapshot).length : 0}
            </span>
          </button>

          {sourcePills.map(src => {
            const sid = src.id.toLowerCase();
            const isSelected = normSource === sid;
            const isFetched = Boolean(snapshot?.fetchedSources.includes(sid));
            const isFetchingThis = Boolean(snapshot?.loadingSources.includes(sid));
            const count = countsBySource.get(sid) || 0;
            return (
              <button
                key={sid}
                type="button"
                role="tab"
                aria-selected={isSelected}
                data-search-source-pill={sid}
                title={!isFetched ? t.sourceUnqueried : undefined}
                onClick={() => onSelectSource(isSelected ? 'all' : sid)}
                className={`tl-search-pill ${isSelected ? 'is-active' : ''}`}
              >
                {renderSourceIcon(sid as TimelineSource, 13)}
                <span>{sourceDisplayLabel(sid, availableSources, isEn)}</span>
                {isFetchingThis ? (
                  <Loader2 size={11} className="animate-spin opacity-80" aria-hidden />
                ) : (
                  <span className="tl-search-pill-count">
                    {isFetched || count > 0 ? count : '—'}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Category Filter Tabs */}
        <div className="tl-search-category-row mt-2.5" role="tablist" aria-label={isEn ? 'Content categories' : 'Categorias de conteúdo'}>
          {categoryTabs.map(tab => {
            const selected = activeCategory === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-search-category-tab={tab.id}
                onClick={() => onSelectCategory(tab.id)}
                className={`tl-search-cat-tab ${selected ? 'is-active' : ''}`}
              >
                {tab.icon}
                <span>{tab.label}</span>
                <span className="tl-search-cat-count">{tab.count}</span>
              </button>
            );
          })}
        </div>

        {/* Source-Adapted Native Search Options Panel (100% capability-driven, zero site hardcoding) */}
        {showSourceOptionsPanel && activeSourceCaps && (
          <div
            className="tl-search-options-panel"
            data-search-options-panel="true"
            data-search-options-archetype={activeSourceCaps.archetype}
          >
            <div className="tl-search-options-head">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--tl-text-muted)]">
                <SlidersHorizontal size={12} aria-hidden="true" />
                <span>
                  {isEn
                    ? `${sourceDisplayLabel(normSource, availableSources, true)} search options`
                    : `Opções de busca · ${sourceDisplayLabel(normSource, availableSources, false)}`}
                </span>
              </span>
            </div>

            {/* Forum Board Native Controls: Scope + Media + Sort + Subforum/Board Selector */}
            {searchOptSpec?.supportsBoardFilter && onChangeSearchOptions && (
              <div className="space-y-2.5">
                <div className="tl-search-options-controls">
                  {searchOptSpec.supportsSearchScope && (
                    <div className="tl-search-opt-group" data-search-opt-scope="true">
                      <span className="tl-search-opt-label">{isEn ? 'Scope' : 'Escopo'}</span>
                      <div className="tl-search-segmented" role="group" aria-label={isEn ? 'Search scope' : 'Escopo da busca'}>
                        {([
                          { id: 'titles', label: isEn ? 'Titles' : 'Títulos' },
                          { id: 'posts', label: isEn ? 'Full posts' : 'Posts completos' },
                        ] as const).map((opt) => {
                          const active = (currentOpts.searchScope || 'titles') === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              data-scope-option={opt.id}
                              aria-pressed={active}
                              onClick={() => updateSearchOpt({ searchScope: opt.id })}
                              className={`tl-search-seg-btn ${active ? 'is-active' : ''}`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {searchOptSpec.supportsMediaFilter && (
                    <div className="tl-search-opt-group" data-search-opt-media="true">
                      <span className="tl-search-opt-label">{isEn ? 'Content' : 'Tipo'}</span>
                      <div className="tl-search-segmented" role="group" aria-label={isEn ? 'Content type' : 'Tipo de conteúdo'}>
                        {([
                          { id: 'all', label: isEn ? 'All' : 'Tudo' },
                          { id: 'images', label: isEn ? 'Images' : 'Imagens' },
                          { id: 'videos', label: isEn ? 'Videos' : 'Vídeos' },
                        ] as const).map((opt) => {
                          const active = (currentOpts.mediaFilter || 'all') === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              data-media-option={opt.id}
                              aria-pressed={active}
                              onClick={() => updateSearchOpt({ mediaFilter: opt.id })}
                              className={`tl-search-seg-btn ${active ? 'is-active' : ''}`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {searchOptSpec.sortOptions.length > 0 && (
                    <div className="tl-search-opt-group" data-search-opt-sort="true">
                      <span className="tl-search-opt-label">{isEn ? 'Sort' : 'Ordenar'}</span>
                      <div className="tl-search-segmented" role="group" aria-label={isEn ? 'Sort order' : 'Ordenação'}>
                        {searchOptSpec.sortOptions.map((sortId) => {
                          const active = (currentOpts.sortBy || 'relevance') === sortId;
                          const sLabel =
                            sortId === 'recent' ? (isEn ? 'Recent' : 'Recentes')
                            : sortId === 'replies' ? (isEn ? 'Replies' : 'Respostas')
                            : sortId === 'popular' ? (isEn ? 'Popular' : 'Populares')
                            : (isEn ? 'Relevance' : 'Relevância');
                          return (
                            <button
                              key={sortId}
                              type="button"
                              data-sort-option={sortId}
                              aria-pressed={active}
                              onClick={() => updateSearchOpt({ sortBy: sortId })}
                              className={`tl-search-seg-btn ${active ? 'is-active' : ''}`}
                            >
                              {sLabel}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Board / Subforum Filter Strip + Full Board Tree Dropdown */}
                <div className="tl-search-opt-boards" data-search-opt-boards="true">
                  <span className="tl-search-opt-label">{isEn ? 'Section' : 'Seção'}</span>
                  <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
                    <button
                      type="button"
                      data-search-board-pill="all"
                      aria-pressed={!currentOpts.boardId}
                      onClick={() => updateSearchOpt({ boardId: null, subfilter: null })}
                      className={`tl-search-opt-chip ${!currentOpts.boardId ? 'is-active' : ''}`}
                    >
                      {isEn ? 'All sections' : 'Todas as seções'}
                    </button>
                    {tagSubfilters.map((sub) => {
                      const label = (sub.label_key && tBrowse[sub.label_key]) || sub.fallback_label || sub.id;
                      const isActive = currentOpts.boardId === sub.id;
                      return (
                        <button
                          key={sub.id}
                          type="button"
                          data-search-board-pill={sub.id}
                          aria-pressed={isActive}
                          onClick={() => updateSearchOpt({ boardId: isActive ? null : sub.id, subfilter: isActive ? null : sub.id })}
                          className={`tl-search-opt-chip ${isActive ? 'is-active' : ''}`}
                        >
                          {label}
                        </button>
                      );
                    })}
                    {forumBoardSections && forumBoardSections.length > 0 && (
                      <select
                        data-search-board-select="true"
                        aria-label={isEn ? 'Choose any section to search' : 'Escolher seção para buscar'}
                        value={currentOpts.boardId || ''}
                        onChange={(e) => {
                          const val = e.target.value || null;
                          updateSearchOpt({ boardId: val, subfilter: val });
                        }}
                        className="tl-search-board-select"
                      >
                        <option value="">{isEn ? 'All forum sections…' : 'Todas as seções do fórum…'}</option>
                        {forumBoardSections.map((sec) => (
                          <optgroup key={sec.title} label={sec.title}>
                            {sec.boards.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    )}
                    {forumBoardsLoading && (!forumBoardSections || forumBoardSections.length === 0) && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--tl-text-muted)]">
                        <Loader2 size={11} className="animate-spin" />
                        {isEn ? 'Loading sections…' : 'Carregando seções…'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Visual Gallery Catalog Native Controls: Tag/Topic Refinement + Directory Jump */}
            {!searchOptSpec?.supportsBoardFilter && activeSourceCaps.archetype === 'gallery_catalog' && (
              <div className="space-y-2.5">
                {tagSubfilters.length > 0 && onChangeSearchOptions && (
                  <div className="tl-search-opt-boards" data-search-opt-subfilters="true">
                    <span className="tl-search-opt-label">{isEn ? 'Refine' : 'Refinar'}</span>
                    <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
                      <button
                        type="button"
                        aria-pressed={!currentOpts.subfilter}
                        onClick={() => updateSearchOpt({ subfilter: null })}
                        className={`tl-search-opt-chip ${!currentOpts.subfilter ? 'is-active' : ''}`}
                      >
                        {isEn ? 'Any topic' : 'Qualquer tema'}
                      </button>
                      {tagSubfilters.map((sub) => {
                        const label = (sub.label_key && tBrowse[sub.label_key]) || sub.fallback_label || sub.id;
                        const isActive = currentOpts.subfilter === sub.id;
                        return (
                          <button
                            key={sub.id}
                            type="button"
                            data-search-subfilter-pill={sub.id}
                            aria-pressed={isActive}
                            onClick={() => updateSearchOpt({ subfilter: isActive ? null : sub.id })}
                            className={`tl-search-opt-chip ${isActive ? 'is-active' : ''}`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {activeSourceCaps.supportsDirectories && activeSourceCaps.directoryKinds.length > 0 && onOpenDirectoryFromSearch && (
                  <div className="tl-search-opt-boards" data-search-opt-directories="true">
                    <span className="tl-search-opt-label">{isEn ? 'Browse' : 'Explorar'}</span>
                    <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
                      {activeSourceCaps.directoryKinds.map((dirKind) => {
                        const dirLabel =
                          dirKind === 'categories' ? (tBrowse.dirCategories || (isEn ? 'Categories' : 'Categorias'))
                          : dirKind === 'artists' ? (tBrowse.dirArtists || (isEn ? 'Artists' : 'Artistas'))
                          : dirKind === 'channels' ? (tBrowse.dirChannels || (isEn ? 'Channels' : 'Canais'))
                          : dirKind === 'tags' ? (tBrowse.dirTags || 'Tags')
                          : (tBrowse.dirBoards || (isEn ? 'Boards' : 'Seções'));
                        return (
                          <button
                            key={dirKind}
                            type="button"
                            data-search-dir-jump={dirKind}
                            onClick={() => onOpenDirectoryFromSearch(dirKind, query)}
                            className="tl-search-dir-jump"
                          >
                            <Compass size={12} aria-hidden="true" />
                            <span>
                              {isEn ? `${dirLabel} matching “${query}”` : `${dirLabel} para “${query}”`}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Social Microblog (X) Mode Switch */}
            {normSource === 'x' && snapshot?.xLiveStatus === 'live' && (
              <div className="tl-search-opt-group">
                <span className="tl-search-opt-label">{isEn ? 'Sort' : 'Ordenar'}</span>
                <div className="tl-search-segmented">
                  {(['top', 'latest'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={xPostsMode === mode}
                      onClick={() => onChangeXPostsMode(mode)}
                      className={`tl-search-seg-btn ${xPostsMode === mode ? 'is-active' : ''}`}
                    >
                      {mode === 'top' ? t.xModeTop : t.xModeLatest}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* X Posts Top / Latest Switch when viewing All Sources -> Posts with Live X active */}
        {normSource === 'all' && activeCategory === 'posts' && snapshot?.xLiveStatus === 'live' && (
          <div className="mt-2.5 flex items-center gap-1.5">
            {(['top', 'latest'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                aria-pressed={xPostsMode === mode}
                onClick={() => onChangeXPostsMode(mode)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                  xPostsMode === mode
                    ? 'border-[var(--tl-accent-border)] bg-[var(--tl-accent-soft)] text-[var(--tl-text-primary)]'
                    : 'border-[var(--tl-border)] bg-transparent text-[var(--tl-text-muted)] hover:text-[var(--tl-text-primary)]'
                }`}
              >
                X · {mode === 'top' ? t.xModeTop : t.xModeLatest}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Empty State */}
      {!isLoadingInitial && (snapshot?.loadingSources.length ?? 0) === 0 && activeCountEmpty && (
        <div className="tl-feed-notice tl-feed-notice--empty" role="status">
          <p className="font-semibold text-sm text-[var(--tl-text-primary)]">
            {canContinueEmptySearch
              ? (isEn ? 'No matches on the pages checked so far.' : 'Nenhum resultado nas páginas consultadas até agora.')
              : t.noResultsTitle.replace('{query}', query)}
          </p>
          {!canContinueEmptySearch && <p className="text-xs text-[var(--tl-text-muted)] mt-1">{t.noResultsDesc}</p>}
        </div>
      )}

      {/* 1. Profiles & Channels Section */}
      {showProfiles && visibleProfiles.length > 0 && (
        <section className="tl-search-section space-y-2.5" data-search-section="profiles">
          {renderSectionHeader('profiles', <Users size={15} aria-hidden />, t.categoryProfiles, visibleProfiles.length, profiles.length)}
          <div className="tl-search-profiles-grid">
            {visibleProfiles.map(c => {
              const cSite = profileSourceId(c);
              const statsLine = [
                (c as TimelineCreator & { subscribersText?: string }).subscribersText || (c.stats?.followers ? `${c.stats.followers}` : ''),
                typeof (c as TimelineCreator & { videosCount?: number }).videosCount === 'number'
                  ? t.videosCountLabel.replace('{count}', String((c as TimelineCreator & { videosCount?: number }).videosCount))
                  : '',
                typeof (c as TimelineCreator & { photosCount?: number }).photosCount === 'number'
                  ? t.photosCountLabel.replace('{count}', String((c as TimelineCreator & { photosCount?: number }).photosCount))
                  : '',
              ]
                .filter(Boolean)
                .join(' · ');

              return (
                <button
                  key={c.id}
                  type="button"
                  data-search-profile-card={c.id}
                  onClick={e => handleOpenCreatorCard(c, e.currentTarget)}
                  className="tl-search-profile-card"
                >
                  <span className="h-11 w-11 shrink-0 overflow-hidden rounded-full bg-white/10">
                    <SourceAvatar
                      name={c.name}
                      src={c.avatar || null}
                      profileUrl={c.profileUrl}
                      referer={c.profileUrl}
                      lazyHydrate={Boolean(c.profileUrl)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="flex items-center gap-1 min-w-0">
                      <strong className="truncate text-xs font-bold text-[var(--tl-text-primary)]">{c.name}</strong>
                      {c.verified && <CheckCircle2 size={13} className="shrink-0 text-sky-400" aria-hidden />}
                      {c.entityKind && (
                        <span
                          data-entity-kind={c.entityKind}
                          className="shrink-0 rounded-full border border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--tl-text-secondary)]"
                        >
                          {c.entityKind === 'channel'
                            ? (t.entityChannelLabel || (isEn ? 'Channel' : 'Canal'))
                            : c.entityKind === 'category'
                              ? (t.entityCategoryLabel || (isEn ? 'Category' : 'Categoria'))
                              : c.entityKind === 'tag'
                                ? (t.entityTagLabel || 'Tag')
                                : (t.entityCreatorLabel || (isEn ? 'Creator' : 'Criador'))}
                        </span>
                      )}
                    </span>
                    <small className="block truncate text-[11px] text-[var(--tl-text-muted)]">
                      {c.handle} · {sourceDisplayLabel(cSite, availableSources, isEn)}
                    </small>
                    {statsLine && (
                      <small className="block truncate text-[10px] text-[var(--tl-text-secondary)] mt-0.5">
                        {statsLine}
                      </small>
                    )}
                  </span>
                  <span className="tl-search-profile-cta">{t.openProfile}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* 2. Playlists Section */}
      {showPlaylists && visiblePlaylists.length > 0 && (
        <section className="tl-search-section space-y-2.5" data-search-section="playlists">
          {renderSectionHeader('playlists', <ListVideo size={15} aria-hidden />, t.categoryPlaylists, visiblePlaylists.length, playlists.length)}
          <div className="tl-feed-list">
            {visiblePlaylists.map(pl => renderFeedItem(pl, 'pl'))}
          </div>
        </section>
      )}

      {/* 3. Videos Section */}
      {showVideos && visibleVideos.length > 0 && (
        <section className="tl-search-section space-y-2.5" data-search-section="videos">
          {renderSectionHeader('videos', <Film size={15} aria-hidden />, t.categoryVideos, visibleVideos.length, videos.length)}
          <div className={sectionListClassName(visibleVideos)}>
            {visibleVideos.map(v => renderFeedItem(v, 'vid'))}
          </div>
        </section>
      )}

      {/* 4. Shorts Section */}
      {showShorts && visibleShorts.length > 0 && (
        <section className="tl-search-section space-y-2.5" data-search-section="shorts">
          {renderSectionHeader('shorts', <Flame size={15} aria-hidden />, t.categoryShorts, visibleShorts.length, shorts.length)}
          <div className="tl-feed-list">
            {visibleShorts.map(s => renderFeedItem(s, 'short'))}
          </div>
        </section>
      )}

      {/* 5. Albums & Photos Section */}
      {showAlbums && visibleAlbums.length > 0 && (
        <section className="tl-search-section space-y-2.5" data-search-section="albums">
          {renderSectionHeader('albums', <ImageIcon size={15} aria-hidden />, t.categoryAlbums, visibleAlbums.length, albums.length)}
          <div className={sectionListClassName(visibleAlbums)}>
            {visibleAlbums.map(a => renderFeedItem(a, 'alb'))}
          </div>
        </section>
      )}

      {/* 6. GIFs Section */}
      {showGifs && visibleGifs.length > 0 && (
        <section className="tl-search-section space-y-2.5" data-search-section="gifs">
          {renderSectionHeader('gifs', <FolderHeart size={15} aria-hidden />, t.categoryGifs, visibleGifs.length, gifs.length)}
          <div className={sectionListClassName(visibleGifs)}>
            {visibleGifs.map(g => renderFeedItem(g, 'gif'))}
          </div>
        </section>
      )}

      {/* 7. Posts Section */}
      {showPosts && visiblePosts.length > 0 && (
        <section className="tl-search-section space-y-2.5" data-search-section="posts">
          {renderSectionHeader('posts', <MessageSquare size={15} aria-hidden />, t.categoryPosts, visiblePosts.length, renderedPosts.length)}
          <div className={sectionListClassName(visiblePosts)}>
            {visiblePosts.map(p => renderFeedItem(p, 'post'))}
          </div>
        </section>
      )}

      {/* Continuous Pagination Footer (expands buffered DOM window & fetches additional remote pages) */}
      {(hasMoreInWindow || hasMoreForActiveView || isLoadingMore) && (
        <div className="tl-feed-pagination pt-2">
          <button
            type="button"
            data-search-load-more="true"
            disabled={isLoadingMore && !hasMoreInWindow}
            onClick={() => triggerMoreSearch(true)}
            className="tl-workspace-refresh min-h-11 px-5"
          >
            {isLoadingMore && <Loader2 size={15} className="animate-spin mr-1.5" aria-hidden />}
            <span>{isLoadingMore ? t.loadingMoreResults : canContinueEmptySearch
              ? (isEn ? 'Continue search' : 'Continuar buscando')
              : t.loadMoreResults}</span>
          </button>
          <div ref={sentinelRef} className="h-3 w-full pointer-events-none" aria-hidden="true" />
        </div>
      )}
    </section>
  );
};
