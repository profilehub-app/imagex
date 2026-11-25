import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  Film,
  Globe,
  Heart,
  Info,
  Languages,
  Layers,
  ListPlus,
  Loader2,
  MapPin,
  Play,
  Search,
  Share2,
  Sparkles,
  Star,
  Tag,
  Tv,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  formatPortalMetric,
  type TimelineCreator,
  type TimelineEntityRef,
  type TimelinePhotoItem,
  type TimelinePlaylist,
  type TimelinePost,
} from './timelineModel';
import { timelinePlaybackRect, type TimelinePlaybackHandoff } from './TimelinePostCard';
import { getTimelineSourceDisplayName } from './timelineSourceNavigation';
import { SourceAvatar } from '../common/SourceAvatar';
import { useProfileTimelineStore } from '../../../store/useProfileTimelineStore';
import {
  profileShortcutIdentity,
  useProfileDirectoryLibraryStore,
} from '../../../store/useProfileDirectoryLibraryStore';
import { useProfileHubLibraryStore } from '../../../store/useProfileHubLibraryStore';
import { normalizeTimelinePostToLibraryItem } from '../../../services/profileHubLibraryModel';
import { useAppStore } from '../../../store/useAppStore';
import { translations } from '../../../i18n/translations';

export type VideoPortalProfileTab =
  | 'videos'
  | 'shorts'
  | 'cast'
  | 'channels'
  | 'playlists'
  | 'albums'
  | 'about';

export interface VideoPortalProfileViewProps {
  creator: TimelineCreator;
  posts: TimelinePost[];
  isEn: boolean;
  backLabel?: string;
  activeTab?: VideoPortalProfileTab;
  onActiveTabChange?: (tab: VideoPortalProfileTab) => void;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  onBack: () => void;
  onOpenVideo: (post: TimelinePost, handoff: TimelinePlaybackHandoff) => void;
  onOpenEntity: (entity: TimelineEntityRef) => void;
  onOpenLightbox: (
    images: string[],
    index?: number,
    title?: string,
    albumUrl?: string,
    items?: TimelinePhotoItem[],
    expectedCount?: number
  ) => void;
  onLoadMore?: () => void;
  onChangeSort?: (sort: string) => void;
}

function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

interface CinemaVideoCardProps {
  post: TimelinePost;
  creator: TimelineCreator;
  locale: string;
  isEn: boolean;
  isLiked: boolean;
  isFavorited: boolean;
  disableMotion?: boolean;
  isShortCard?: boolean;
  onToggleLike: (post: TimelinePost) => void;
  onToggleFavorite: (post: TimelinePost) => void;
  onOpenPlaylist: (post: TimelinePost) => void;
  onOpenVideo: (post: TimelinePost, handoff: TimelinePlaybackHandoff) => void;
}

const PortalCinemaVideoCard: React.FC<CinemaVideoCardProps> = ({
  post,
  creator,
  locale,
  isEn,
  isLiked,
  isFavorited,
  disableMotion,
  isShortCard = false,
  onToggleLike,
  onToggleFavorite,
  onOpenPlaylist,
  onOpenVideo,
}) => {
  const mediaWrapRef = useRef<HTMLButtonElement | null>(null);
  const [hoverPreviewActive, setHoverPreviewActive] = useState(false);

  const thumbUrl = post.thumbnail || creator.avatar || '';
  const formattedViews = formatPortalMetric(post.views, locale);
  const metaParts = [formattedViews ? `${formattedViews}` : '', post.date].filter(Boolean);
  const watchTarget = post.originalUrl || post.videoUrl;

  const triggerPlay = () => {
    const handoff: TimelinePlaybackHandoff = {
      currentTime: 0,
      isMuted: true,
      isPlaying: true,
      qualities: post.qualities,
      masterHlsUrl: post.masterHlsUrl,
      sourceRect: timelinePlaybackRect(mediaWrapRef.current),
    };
    onOpenVideo(post, handoff);
  };

  return (
    <article
      data-vp-video-card={post.id}
      className={`tl-vp-video-card${isShortCard ? ' tl-vp-video-card--short' : ''}${
        disableMotion ? '' : ' tl-pressable'
      }`}
    >
      <button
        ref={mediaWrapRef}
        type="button"
        onClick={triggerPlay}
        onMouseEnter={() => {
          if (post.previewVideoUrl) setHoverPreviewActive(true);
        }}
        onMouseLeave={() => setHoverPreviewActive(false)}
        onFocus={() => {
          if (post.previewVideoUrl) setHoverPreviewActive(true);
        }}
        onBlur={() => setHoverPreviewActive(false)}
        aria-label={post.title}
        className={`tl-vp-card-media${isShortCard ? ' tl-vp-card-media--short' : ''}`}
      >
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={post.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="tl-vp-card-thumb"
          />
        ) : (
          <div className="tl-vp-card-thumb-fallback">
            <Film className="h-7 w-7 opacity-40" aria-hidden="true" />
          </div>
        )}
        {hoverPreviewActive && post.previewVideoUrl && (
          <video
            src={post.previewVideoUrl}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            className="tl-vp-card-preview"
          />
        )}
        <div className="tl-vp-card-scrim" aria-hidden="true" />
        <div className="tl-vp-card-badges-top">
          {post.resolution && (
            <span className="tl-vp-badge tl-vp-badge--quality">{post.resolution}</span>
          )}
          {post.rating && (
            <span className="tl-vp-badge tl-vp-badge--rating">{post.rating}</span>
          )}
        </div>
        <div className="tl-vp-card-play-overlay" aria-hidden="true">
          <span className="tl-vp-card-play-circle">
            <Play className="h-4 w-4 fill-current ml-0.5" />
          </span>
        </div>
        {post.duration && (
          <span className="tl-vp-card-duration">{post.duration}</span>
        )}
      </button>

      <div className="tl-vp-card-body">
        <button
          type="button"
          onClick={triggerPlay}
          className="tl-vp-card-title text-left"
          title={post.title}
        >
          {post.title}
        </button>

        <div className="tl-vp-card-footer">
          <div className="tl-vp-card-meta">
            {metaParts.length > 0 ? (
              metaParts.map((part, idx) => (
                <React.Fragment key={`${idx}-${part}`}>
                  {idx > 0 && <span aria-hidden="true">·</span>}
                  <span className="truncate">{part}</span>
                </React.Fragment>
              ))
            ) : (
              <span className="opacity-70">{creator.name}</span>
            )}
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={() => onToggleLike(post)}
              aria-pressed={isLiked}
              aria-label={isEn ? 'Like video' : 'Curtir vídeo'}
              title={isEn ? 'Like video' : 'Curtir vídeo'}
              className={`tl-vp-icon-btn${isLiked ? ' is-liked text-rose-400' : ''}`}
            >
              <Heart className={`h-3.5 w-3.5${isLiked ? ' fill-current' : ''}`} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onToggleFavorite(post)}
              aria-pressed={isFavorited}
              aria-label={isEn ? 'Favorite video' : 'Favoritar vídeo'}
              title={isEn ? 'Favorite video' : 'Favoritar vídeo'}
              className={`tl-vp-icon-btn${isFavorited ? ' is-saved text-[var(--tl-accent-text)]' : ''}`}
            >
              <Bookmark className={`h-3.5 w-3.5${isFavorited ? ' fill-current' : ''}`} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onOpenPlaylist(post)}
              aria-label={isEn ? 'Add to playlist' : 'Adicionar à playlist'}
              title={isEn ? 'Add to playlist' : 'Adicionar à playlist'}
              className="tl-vp-icon-btn"
            >
              <ListPlus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {watchTarget && (
              <a
                href={watchTarget}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={isEn ? 'Open on source' : 'Abrir na fonte'}
                title={isEn ? 'Open on source' : 'Abrir na fonte'}
                className="tl-vp-icon-btn"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};

export const VideoPortalProfileView: React.FC<VideoPortalProfileViewProps> = ({
  creator,
  posts,
  isEn,
  backLabel,
  activeTab: controlledTab,
  onActiveTabChange,
  isLoading,
  isLoadingMore,
  onBack,
  onOpenVideo,
  onOpenEntity,
  onOpenLightbox,
  onLoadMore,
  onChangeSort,
}) => {
  const locale = isEn ? 'en-US' : 'pt-BR';
  const tBrowse = (translations[locale] as any).timelineBrowse || {};
  const disableMotion = useAppStore((s) => s.settings?.disableAllAnimations);
  const addNotification = useAppStore((s) => s.addNotification);
  const isGlobalMuted = useProfileTimelineStore((s) => s.isGlobalMuted);
  const likedPostIds = useProfileTimelineStore((s) => s.likedPostIds);
  const favoritedPostIds = useProfileTimelineStore((s) => s.favoritedPostIds);
  const toggleLike = useProfileTimelineStore((s) => s.toggleLike);
  const toggleFavorite = useProfileTimelineStore((s) => s.toggleFavorite);
  const toggleFollowCreator = useProfileTimelineStore((s) => s.toggleFollowCreator);
  const favorites = useProfileDirectoryLibraryStore((s) => s.favorites);
  const openPlaylistModal = useProfileHubLibraryStore((s) => s.openPlaylistModal);
  const libraryLiked = useProfileHubLibraryStore((s) => s.liked);
  const libraryFavorites = useProfileHubLibraryStore((s) => s.favorites);

  void isGlobalMuted;

  const creatorIdentity = profileShortcutIdentity(creator.profileUrl);
  const isFollowing = useMemo(
    () =>
      Boolean(
        creatorIdentity &&
          favorites.some(
            (fav) => fav.kind === 'profile' && profileShortcutIdentity(fav.url) === creatorIdentity
          )
      ),
    [creatorIdentity, favorites]
  );

  const [shareCopied, setShareCopied] = useState(false);
  const [localTab, setLocalTab] = useState<VideoPortalProfileTab>('videos');
  const [videoFilter, setVideoFilter] = useState('');
  const [castFilter, setCastFilter] = useState('');
  const [visibleVideoCount, setVisibleVideoCount] = useState(36);
  const [expandedPlaylistId, setExpandedPlaylistId] = useState<string | null>(null);

  const portalInfo = creator.portalInfo || {};
  const featuredPerformers = useMemo(
    () => (Array.isArray(creator.featuredPerformers) ? creator.featuredPerformers : []),
    [creator.featuredPerformers]
  );
  const affiliatedChannels = useMemo(
    () => (Array.isArray(creator.affiliatedChannels) ? creator.affiliatedChannels : []),
    [creator.affiliatedChannels]
  );
  const interests = useMemo(
    () => (Array.isArray(creator.interests) ? creator.interests : []),
    [creator.interests]
  );
  const relatedEntities = useMemo(
    () => (Array.isArray(creator.relatedEntities) ? creator.relatedEntities : []),
    [creator.relatedEntities]
  );
  const playlists: TimelinePlaylist[] = useMemo(
    () => (Array.isArray(creator.playlists) ? creator.playlists : []),
    [creator.playlists]
  );

  const creatorPosts = useMemo(
    () =>
      posts.filter(
        (p) =>
          p.creatorId === creator.id ||
          (creator.profileUrl &&
            (p.sourcePage === creator.profileUrl ||
              p.creatorHandle === creator.handle))
      ),
    [posts, creator.id, creator.profileUrl, creator.handle]
  );

  const shortPosts = useMemo(
    () => creatorPosts.filter((p) => p.type === 'video' && Boolean(p.isShort)),
    [creatorPosts]
  );
  const albumPosts = useMemo(
    () => creatorPosts.filter((p) => p.type === 'album' || p.type === 'photo_grid'),
    [creatorPosts]
  );
  const videoPosts = useMemo(
    () =>
      creatorPosts.filter(
        (p) =>
          (p.type === 'video' && !p.isShort) ||
          (p.type !== 'album' && p.type !== 'photo_grid' && p.type !== 'playlist' && !p.isShort)
      ),
    [creatorPosts]
  );

  const hasAboutContent = Boolean(
    creator.bio ||
      portalInfo.country ||
      portalInfo.languages ||
      portalInfo.joinedAt ||
      portalInfo.lastActive ||
      portalInfo.profileHits ||
      portalInfo.website ||
      interests.length > 0 ||
      relatedEntities.length > 0
  );

  const isModelProfile = creator.entityKind === 'creator';
  const featuredLabel = isModelProfile
    ? (tBrowse.portalTabStudios || (isEn ? 'Studios / Channels' : 'Estúdios / Canais'))
    : (tBrowse.portalTabCast || (isEn ? 'Cast / Models' : 'Elenco / Modelos'));
  const featuredSearchPlaceholder = isModelProfile
    ? (tBrowse.portalSearchStudiosPlaceholder || (isEn ? 'Filter studios or channels...' : 'Filtrar estúdios ou canais...'))
    : (tBrowse.portalSearchCastPlaceholder || (isEn ? 'Filter cast or models...' : 'Filtrar elenco ou modelos...'));
  const featuredEmptyLabel = isModelProfile
    ? (tBrowse.portalNoStudios || (isEn ? 'No studios or channels found.' : 'Nenhum estúdio ou canal encontrado.'))
    : (tBrowse.portalNoCast || (isEn ? 'No performers or models found.' : 'Nenhum artista ou modelo encontrado.'));

  const tabs = useMemo(() => {
    const list: Array<{ id: VideoPortalProfileTab; label: string; count?: number }> = [
      {
        id: 'videos',
        label: tBrowse.portalTabVideos || (isEn ? 'Videos' : 'Vídeos'),
        count: creator.stats?.videos ?? (portalInfo.totalPublicVideos || videoPosts.length || undefined),
      },
    ];
    if (shortPosts.length > 0) {
      list.push({
        id: 'shorts',
        label: tBrowse.shortsTab || 'Shorts',
        count: shortPosts.length,
      });
    }
    if (featuredPerformers.length > 0) {
      list.push({
        id: 'cast',
        label: featuredLabel,
        count: featuredPerformers.length,
      });
    }
    if (affiliatedChannels.length > 0) {
      list.push({
        id: 'channels',
        label: tBrowse.portalTabChannels || (isEn ? 'Network Channels' : 'Canais da Rede'),
        count: affiliatedChannels.length,
      });
    }
    if (playlists.length > 0) {
      list.push({
        id: 'playlists',
        label: tBrowse.portalTabPlaylists || 'Playlists',
        count: playlists.length,
      });
    }
    if (albumPosts.length > 0) {
      list.push({
        id: 'albums',
        label: tBrowse.portalTabAlbums || (isEn ? 'Albums' : 'Álbuns'),
        count: albumPosts.length,
      });
    }
    if (hasAboutContent) {
      list.push({
        id: 'about',
        label: tBrowse.portalTabAbout || (isEn ? 'About & Info' : 'Sobre e Informações'),
      });
    }
    return list;
  }, [
    tBrowse,
    isEn,
    creator.stats?.videos,
    portalInfo.totalPublicVideos,
    portalInfo.totalShorts,
    videoPosts.length,
    shortPosts.length,
    featuredPerformers.length,
    affiliatedChannels.length,
    playlists.length,
    albumPosts.length,
    hasAboutContent,
  ]);

  const activeTab: VideoPortalProfileTab = useMemo(() => {
    const candidate = controlledTab || localTab;
    if (tabs.some((t) => t.id === candidate)) return candidate;
    return tabs[0]?.id || 'videos';
  }, [controlledTab, localTab, tabs]);

  const selectTab = (tab: VideoPortalProfileTab) => {
    setLocalTab(tab);
    onActiveTabChange?.(tab);
  };

  const filteredVideos = useMemo(() => {
    const q = videoFilter.trim().toLowerCase();
    if (!q) return videoPosts;
    return videoPosts.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.tags && p.tags.some((t) => t.toLowerCase().includes(q)))
    );
  }, [videoPosts, videoFilter]);

  const renderedVideos = useMemo(
    () => filteredVideos.slice(0, visibleVideoCount),
    [filteredVideos, visibleVideoCount]
  );
  const hasMoreLocalVideos = visibleVideoCount < filteredVideos.length;

  const filteredCast = useMemo(() => {
    const q = castFilter.trim().toLowerCase();
    if (!q) return featuredPerformers;
    return featuredPerformers.filter((p) => p.name.toLowerCase().includes(q));
  }, [featuredPerformers, castFilter]);

  const sourceLabel = creator.site
    ? getTimelineSourceDisplayName(creator.site, isEn ? 'en' : 'pt')
    : tBrowse.videoPortalBadge || (isEn ? 'Video Portal' : 'Portal de Vídeos');

  const entityKindLabel = useMemo(() => {
    const k = creator.entityKind || 'channel';
    if (k === 'category') return tBrowse.entityCategory || (isEn ? 'Category' : 'Categoria');
    if (k === 'tag') return tBrowse.entityTag || 'Tag';
    if (k === 'creator') return tBrowse.entityCreator || (isEn ? 'Creator' : 'Criador');
    return tBrowse.entityChannel || (isEn ? 'Channel' : 'Canal');
  }, [creator.entityKind, tBrowse, isEn]);

  const officialWebsiteUrl = safeExternalUrl(portalInfo.website);
  const bannerUrl = safeExternalUrl(creator.banner);

  const metrics = useMemo(() => {
    const rows: Array<{ key: string; label: string; value: string; hint?: string }> = [];
    const totalVideos = creator.stats?.videos ?? portalInfo.totalPublicVideos ?? (videoPosts.length || null);
    const videosFormatted = formatPortalMetric(totalVideos, locale);
    if (videosFormatted) {
      rows.push({
        key: 'videos',
        label: tBrowse.portalTabVideos || (isEn ? 'Videos' : 'Vídeos'),
        value: videosFormatted,
      });
    }
    const subsFormatted = formatPortalMetric(creator.stats?.subscribers, locale);
    if (subsFormatted) {
      rows.push({
        key: 'subscribers',
        label: tBrowse.portalSubscribers || (isEn ? 'Subscribers' : 'Inscritos'),
        value: subsFormatted,
      });
    }
    const viewsFormatted = formatPortalMetric(creator.stats?.views, locale);
    if (viewsFormatted) {
      rows.push({
        key: 'views',
        label: tBrowse.portalViews || (isEn ? 'Views' : 'Visualizações'),
        value: viewsFormatted,
      });
    }
    const ratingText = formatPortalMetric(creator.stats?.rating || portalInfo.ratingPercent, locale);
    if (ratingText) {
      const votesCount =
        typeof portalInfo.ratingVotes === 'number' && portalInfo.ratingVotes > 0
          ? `${portalInfo.ratingVotes.toLocaleString(locale)} ${isEn ? 'votes' : 'votos'}`
          : undefined;
      rows.push({
        key: 'rating',
        label: tBrowse.portalRating || (isEn ? 'Rating' : 'Avaliação'),
        value: ratingText,
        hint: votesCount,
      });
    }
    const shortsTotal = creator.stats?.shorts ?? portalInfo.totalShorts;
    const shortsFormatted =
      typeof shortsTotal === 'number' && shortsTotal > 0
        ? formatPortalMetric(shortsTotal, locale)
        : null;
    if (shortsFormatted) {
      rows.push({
        key: 'shorts',
        label: tBrowse.shortsTab || 'Shorts',
        value: shortsFormatted,
      });
    }
    return rows;
  }, [creator.stats, portalInfo, videoPosts.length, locale, tBrowse, isEn]);

  const sortOptions = useMemo(() => {
    if (!Array.isArray(creator.supportsSort) || creator.supportsSort.length < 2) return [];
    return creator.supportsSort;
  }, [creator.supportsSort]);
  const activeSort = creator.activeSort || sortOptions[0] || 'best';

  const handleShareProfile = async () => {
    const shareTarget = creator.profileUrl;
    if (!shareTarget) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: creator.name, url: shareTarget });
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(shareTarget);
        setShareCopied(true);
        window.setTimeout(() => setShareCopied(false), 1800);
        addNotification({
          type: 'success',
          title: isEn ? 'Share' : 'Compartilhar',
          message: isEn ? 'Profile link copied!' : 'Link do perfil copiado!',
        });
      }
    } catch {
      // Clipboard/share dismissed cleanly
    }
  };

  const checkPostLiked = (post: TimelinePost) =>
    Boolean(likedPostIds[post.id] || libraryLiked.some((it) => it.id === post.id));

  const checkPostFavorited = (post: TimelinePost) =>
    Boolean(favoritedPostIds[post.id] || libraryFavorites.some((it) => it.id === post.id));

  const handleOpenPlaylistModal = (post: TimelinePost) => {
    const item = normalizeTimelinePostToLibraryItem(post, creator);
    if (item) openPlaylistModal(item);
  };

  const renderInfoEntries = () => {
    const items: Array<{ label: string; value: string; icon: React.ReactNode }> = [];
    if (portalInfo.country) {
      items.push({
        label: tBrowse.portalCountry || (isEn ? 'Country' : 'País'),
        value: String(portalInfo.country),
        icon: <MapPin className="h-3.5 w-3.5 text-[var(--tl-accent-text)]" aria-hidden="true" />,
      });
    }
    if (portalInfo.languages) {
      items.push({
        label: tBrowse.portalLanguages || (isEn ? 'Languages' : 'Idiomas'),
        value: String(portalInfo.languages),
        icon: <Languages className="h-3.5 w-3.5 text-[var(--tl-accent-text)]" aria-hidden="true" />,
      });
    }
    if (portalInfo.joinedAt) {
      items.push({
        label: tBrowse.portalJoined || (isEn ? 'Joined' : 'Membro desde'),
        value: String(portalInfo.joinedAt),
        icon: <Info className="h-3.5 w-3.5 text-[var(--tl-accent-text)]" aria-hidden="true" />,
      });
    }
    if (portalInfo.lastActive) {
      items.push({
        label: tBrowse.portalLastActive || (isEn ? 'Last active' : 'Última atividade'),
        value: String(portalInfo.lastActive),
        icon: <Sparkles className="h-3.5 w-3.5 text-[var(--tl-accent-text)]" aria-hidden="true" />,
      });
    }
    if (portalInfo.profileHits) {
      items.push({
        label: tBrowse.portalProfileHits || (isEn ? 'Profile hits' : 'Acessos ao perfil'),
        value: String(portalInfo.profileHits),
        icon: <Eye className="h-3.5 w-3.5 text-[var(--tl-accent-text)]" aria-hidden="true" />,
      });
    }
    if (typeof portalInfo.totalPublicVideos === 'number' && portalInfo.totalPublicVideos > 0) {
      items.push({
        label: tBrowse.portalPublicVideos || (isEn ? 'Public videos' : 'Vídeos públicos'),
        value: portalInfo.totalPublicVideos.toLocaleString(locale),
        icon: <Film className="h-3.5 w-3.5 text-[var(--tl-accent-text)]" aria-hidden="true" />,
      });
    }
    if (typeof portalInfo.totalPremiumVideos === 'number' && portalInfo.totalPremiumVideos > 0) {
      items.push({
        label: tBrowse.portalPremiumVideos || (isEn ? 'Exclusive videos' : 'Vídeos exclusivos'),
        value: portalInfo.totalPremiumVideos.toLocaleString(locale),
        icon: <Star className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />,
      });
    }
    return items;
  };

  const infoEntries = renderInfoEntries();
  const castQuickList = featuredPerformers.slice(0, 8);
  const castOverflowCount = Math.max(0, featuredPerformers.length - castQuickList.length);
  const relatedQuickList = castQuickList.length === 0 ? relatedEntities.slice(0, 8) : [];
  const relatedOverflowCount = Math.max(0, relatedEntities.length - relatedQuickList.length);

  return (
    <section
      className="tl-vp-root space-y-5"
      data-video-portal-profile={creator.site || 'portal'}
      data-entity-kind={creator.entityKind || 'channel'}
    >
      {/* Hero Banner & Identity Card */}
      <header className="tl-vp-hero">
        <div className="tl-vp-cover">
          {bannerUrl ? (
            <img
              src={bannerUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="tl-vp-cover-img"
            />
          ) : (
            <div className="tl-vp-cover-mesh" aria-hidden="true" />
          )}
          <div className="tl-vp-cover-scrim" aria-hidden="true" />

          <div className="tl-vp-cover-topbar">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={onBack}
                className="tl-vp-glass-btn"
              >
                <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{backLabel || (isEn ? 'Back' : 'Voltar')}</span>
              </button>
              <span className="tl-vp-glass-pill hidden sm:inline-flex">
                <Tv className="h-3.5 w-3.5 shrink-0 opacity-85" aria-hidden="true" />
                <span>{sourceLabel} · {entityKindLabel}</span>
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => void handleShareProfile()}
                aria-label={isEn ? 'Share profile' : 'Compartilhar perfil'}
                title={isEn ? 'Share profile' : 'Compartilhar perfil'}
                className="tl-vp-glass-icon-btn"
              >
                {shareCopied ? (
                  <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                ) : (
                  <Share2 className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
              {creator.profileUrl && (
                <a
                  href={creator.profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={tBrowse.openSourcePage || (isEn ? 'Open on source' : 'Abrir na fonte')}
                  title={tBrowse.openSourcePage || (isEn ? 'Open on source' : 'Abrir na fonte')}
                  className="tl-vp-glass-icon-btn"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="tl-vp-hero-body">
          <div className="tl-vp-identity-row">
            <button
              type="button"
              onClick={() => {
                if (creator.avatar) {
                  onOpenLightbox([creator.avatar], 0, creator.name, creator.profileUrl);
                }
              }}
              disabled={!creator.avatar}
              aria-label={creator.name}
              className="tl-vp-avatar-frame"
            >
              <SourceAvatar
                name={creator.name}
                src={creator.avatar}
                profileUrl={creator.profileUrl}
                referer={creator.profileUrl}
                hydrate={Boolean(creator.profileUrl)}
                disableMotion={disableMotion}
                className="h-full w-full object-cover"
              />
            </button>

            <div className="min-w-0 flex-1 space-y-1.5 pt-1">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-[var(--tl-text-primary)] leading-tight break-words">
                  {creator.name}
                </h1>
                {creator.verified && (
                  <span
                    className="tl-vp-verified-badge"
                    title={tBrowse.portalVerified || (isEn ? 'Verified' : 'Verificado')}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{tBrowse.portalVerified || (isEn ? 'Verified' : 'Verificado')}</span>
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--tl-text-muted)]">
                {creator.handle && (
                  <span className="font-mono text-[var(--tl-accent-text)] font-semibold">
                    {creator.handle}
                  </span>
                )}
                {portalInfo.country && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3 opacity-80" aria-hidden="true" />
                    <span>{String(portalInfo.country)}</span>
                  </span>
                )}
                {portalInfo.languages && (
                  <span className="inline-flex items-center gap-1">
                    <Languages className="h-3 w-3 opacity-80" aria-hidden="true" />
                    <span>{String(portalInfo.languages)}</span>
                  </span>
                )}
                <span className="sm:hidden text-[11px] font-semibold uppercase tracking-wider opacity-80">
                  {sourceLabel} · {entityKindLabel}
                </span>
              </div>
            </div>

            <div className="tl-vp-action-cluster">
              <button
                type="button"
                data-vp-follow="true"
                aria-pressed={isFollowing}
                onClick={() => toggleFollowCreator(creator)}
                className={`tl-vp-follow-btn${isFollowing ? ' is-following' : ''}${
                  disableMotion ? '' : ' tl-pressable'
                }`}
              >
                {isFollowing ? (
                  <UserCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <UserPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {isFollowing
                    ? (isEn ? 'Following' : 'Seguindo')
                    : (isEn ? 'Follow' : 'Seguir')}
                </span>
              </button>

              {officialWebsiteUrl && (
                <a
                  href={officialWebsiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tl-vp-site-btn"
                >
                  <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{tBrowse.portalOfficialSite || (isEn ? 'Official website' : 'Site oficial')}</span>
                </a>
              )}
            </div>
          </div>

          {/* Metrics Ribbon */}
          {metrics.length > 0 && (
            <dl className="tl-vp-metrics-grid" data-vp-metrics="true">
              {metrics.map((m) => (
                <div key={m.key} className="tl-vp-metric-cell" title={m.hint}>
                  <dd className="tl-vp-metric-val">{m.value}</dd>
                  <dt className="tl-vp-metric-label">{m.label}</dt>
                </div>
              ))}
            </dl>
          )}

          {/* Concise Bio */}
          {creator.bio && (
            <div className="flex items-start justify-between gap-3 pt-0.5">
              <p className="text-xs sm:text-[13px] text-[var(--tl-text-secondary)] leading-relaxed line-clamp-2 min-w-0">
                {creator.bio}
              </p>
              {hasAboutContent && activeTab !== 'about' && (
                <button
                  type="button"
                  onClick={() => selectTab('about')}
                  className="shrink-0 text-xs font-semibold text-[var(--tl-accent-text)] hover:text-[var(--tl-text-primary)] whitespace-nowrap"
                >
                  {tBrowse.portalTabAbout || (isEn ? 'About & Info' : 'Sobre')}
                </button>
              )}
            </div>
          )}

          {/* Compact Featured Cast / Studios Bar (max 8 pills — no 150-tag overflow) */}
          {castQuickList.length > 0 && (
            <div className="tl-vp-cast-strip" data-vp-cast-strip="true">
              <span className="tl-vp-cast-label">
                {isModelProfile ? (
                  <Tv className="h-3.5 w-3.5 opacity-80" aria-hidden="true" />
                ) : (
                  <Users className="h-3.5 w-3.5 opacity-80" aria-hidden="true" />
                )}
                <span>{featuredLabel}</span>
              </span>
              <div className="tl-vp-cast-track">
                {castQuickList.map((perf) => (
                  <button
                    key={`qcast-${perf.url || perf.name}`}
                    type="button"
                    onClick={() => onOpenEntity(perf)}
                    className="tl-vp-cast-chip"
                  >
                    {perf.thumbnailUrl ? (
                      <img
                        src={perf.thumbnailUrl}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-5 w-5 rounded-full object-cover shrink-0"
                      />
                    ) : (
                      <span className="h-5 w-5 rounded-full bg-[var(--tl-accent-soft)] text-[10px] font-bold flex items-center justify-center shrink-0">
                        {perf.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="truncate max-w-[130px]">{perf.name}</span>
                    {typeof perf.count === 'number' && perf.count > 0 && (
                      <span className="text-[10px] font-mono opacity-65">{perf.count}</span>
                    )}
                  </button>
                ))}
                {castOverflowCount > 0 && (
                  <button
                    type="button"
                    onClick={() => selectTab('cast')}
                    className="tl-vp-cast-more-btn"
                  >
                    +{castOverflowCount} {isEn ? 'more' : 'mais'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Compact Related Bar when no performer cast list exists */}
          {relatedQuickList.length > 0 && (
            <div className="tl-vp-cast-strip" data-vp-related-strip="true">
              <span className="tl-vp-cast-label">
                <Tag className="h-3.5 w-3.5 opacity-80" aria-hidden="true" />
                <span>{tBrowse.relatedEntities || (isEn ? 'Related' : 'Relacionados')}</span>
              </span>
              <div className="tl-vp-cast-track">
                {relatedQuickList.map((ent) => (
                  <button
                    key={`qrel-${ent.url || ent.name}`}
                    type="button"
                    onClick={() => ent.url && onOpenEntity(ent)}
                    disabled={!ent.url}
                    className="tl-vp-cast-chip pl-2.5"
                  >
                    <span className="truncate max-w-[140px]">{ent.name}</span>
                  </button>
                ))}
                {relatedOverflowCount > 0 && (
                  <button
                    type="button"
                    onClick={() => selectTab('about')}
                    className="tl-vp-cast-more-btn"
                  >
                    +{relatedOverflowCount} {isEn ? 'more' : 'mais'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Primary Profile Section Tabs */}
      <nav
        className="tl-vp-tabs-bar"
        aria-label={isEn ? 'Profile sections' : 'Seções do perfil'}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              data-vp-tab={tab.id}
              aria-pressed={isActive}
              onClick={() => selectTab(tab.id)}
              className={`tl-vp-tab-btn${isActive ? ' is-active' : ''}`}
            >
              <span>{tab.label}</span>
              {typeof tab.count === 'number' && tab.count > 0 && (
                <span className="tl-vp-tab-count">
                  {formatPortalMetric(tab.count, locale) || tab.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* TAB: VIDEOS */}
      {activeTab === 'videos' && (
        <div className="space-y-4">
          {(sortOptions.length > 1 || videoPosts.length > 6) && (
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              {sortOptions.length > 1 ? (
                <div className="tl-vp-sort-group" role="group" aria-label={isEn ? 'Sort videos' : 'Ordenar vídeos'}>
                  {sortOptions.map((opt) => {
                    const keyLow = opt.toLowerCase();
                    const isActiveSort = activeSort.toLowerCase() === keyLow;
                    const label =
                      keyLow === 'best' || keyLow === 'popular'
                        ? (tBrowse.portalSortBest || (isEn ? 'Best' : 'Melhores'))
                        : keyLow === 'new' || keyLow === 'latest' || keyLow === 'recent'
                          ? (tBrowse.portalSortLatest || (isEn ? 'Latest' : 'Recentes'))
                          : opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        data-vp-sort={opt}
                        aria-pressed={isActiveSort}
                        disabled={Boolean(isLoadingMore)}
                        onClick={() => {
                          if (!isActiveSort) onChangeSort?.(keyLow);
                        }}
                        className={`tl-vp-sort-pill${isActiveSort ? ' is-active' : ''}`}
                      >
                        {isLoadingMore && isActiveSort && (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                        )}
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div />
              )}

              {videoPosts.length > 6 && (
                <label className="tl-vp-filter-input-wrap">
                  <Search className="h-3.5 w-3.5 text-[var(--tl-text-muted)] shrink-0" aria-hidden="true" />
                  <input
                    type="search"
                    value={videoFilter}
                    onChange={(e) => {
                      setVideoFilter(e.target.value);
                      setVisibleVideoCount(36);
                    }}
                    placeholder={isEn ? 'Filter loaded videos...' : 'Filtrar vídeos carregados...'}
                    className="tl-vp-filter-input"
                  />
                </label>
              )}
            </div>
          )}

          {renderedVideos.length === 0 ? (
            isLoading ? (
              <div className="tl-vp-video-grid" aria-busy="true" aria-label={isEn ? 'Loading videos...' : 'Carregando vídeos...'}>
                {Array.from({ length: 6 }, (_, idx) => (
                  <div key={`vp-skel-${idx}`} className="tl-vp-skeleton-card">
                    <div className="tl-vp-skeleton-media" />
                    <div className="p-3 space-y-2">
                      <div className="h-3.5 w-5/6 rounded bg-[var(--tl-surface-elevated)]" />
                      <div className="h-3 w-2/5 rounded bg-[var(--tl-surface-elevated)] opacity-70" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] py-12 text-center text-xs text-[var(--tl-text-muted)]">
                <p>{isEn ? 'No videos available for this selection.' : 'Nenhum vídeo disponível para esta seleção.'}</p>
              </div>
            )
          ) : (
            <div className="tl-vp-video-grid" data-vp-video-grid="true">
              {renderedVideos.map((post) => (
                <PortalCinemaVideoCard
                  key={post.id}
                  post={post}
                  creator={creator}
                  locale={locale}
                  isEn={isEn}
                  isLiked={checkPostLiked(post)}
                  isFavorited={checkPostFavorited(post)}
                  disableMotion={disableMotion}
                  onToggleLike={(p) => toggleLike(p.id, p, creator)}
                  onToggleFavorite={(p) => toggleFavorite(p.id, p, creator)}
                  onOpenPlaylist={handleOpenPlaylistModal}
                  onOpenVideo={onOpenVideo}
                />
              ))}
            </div>
          )}

          {renderedVideos.length > 0 && !isLoading && (hasMoreLocalVideos || (creator.profileHasMore && onLoadMore)) && (
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2 pb-6">
              {hasMoreLocalVideos ? (
                <button
                  type="button"
                  onClick={() => setVisibleVideoCount((c) => c + 36)}
                  className="tl-entity-load-more-btn"
                >
                  {isEn
                    ? `Show more (${filteredVideos.length - renderedVideos.length} remaining)`
                    : `Mostrar mais (${filteredVideos.length - renderedVideos.length} restantes)`}
                </button>
              ) : (
                creator.profileHasMore &&
                onLoadMore && (
                  <button
                    type="button"
                    data-load-more-profile-albums="true"
                    disabled={isLoadingMore}
                    onClick={onLoadMore}
                    className="tl-entity-load-more-btn"
                  >
                    {isLoadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    <span>{tBrowse.portalLoadMoreVideos || (isEn ? 'Load more videos' : 'Carregar mais vídeos')}</span>
                  </button>
                )
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB: SHORTS */}
      {activeTab === 'shorts' && (
        <div className="space-y-4">
          {shortPosts.length === 0 ? (
            <div className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] py-12 text-center text-xs text-[var(--tl-text-muted)]">
              {isEn ? 'Open profile videos or source to browse short clips.' : 'Navegue pelos vídeos ou fonte para carregar mais shorts.'}
            </div>
          ) : (
            <div className="tl-vp-shorts-grid" data-vp-shorts-grid="true">
              {shortPosts.map((post) => (
                <PortalCinemaVideoCard
                  key={post.id}
                  post={post}
                  creator={creator}
                  locale={locale}
                  isEn={isEn}
                  isShortCard
                  isLiked={checkPostLiked(post)}
                  isFavorited={checkPostFavorited(post)}
                  disableMotion={disableMotion}
                  onToggleLike={(p) => toggleLike(p.id, p, creator)}
                  onToggleFavorite={(p) => toggleFavorite(p.id, p, creator)}
                  onOpenPlaylist={handleOpenPlaylistModal}
                  onOpenVideo={onOpenVideo}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB: CAST / MODELS */}
      {activeTab === 'cast' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="tl-vp-filter-input-wrap w-full sm:w-72">
              <Search className="h-3.5 w-3.5 text-[var(--tl-text-muted)] shrink-0" aria-hidden="true" />
              <input
                type="search"
                value={castFilter}
                onChange={(e) => setCastFilter(e.target.value)}
                placeholder={featuredSearchPlaceholder}
                className="tl-vp-filter-input"
              />
            </label>
            <span className="text-xs font-mono text-[var(--tl-text-muted)]">
              {filteredCast.length} / {featuredPerformers.length}
            </span>
          </div>

          {filteredCast.length === 0 ? (
            <div className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] py-12 text-center text-xs text-[var(--tl-text-muted)]">
              {featuredEmptyLabel}
            </div>
          ) : (
            <div className="tl-vp-cast-grid" data-vp-cast-grid="true">
              {filteredCast.map((perf) => (
                <button
                  key={`cast-${perf.url || perf.name}`}
                  type="button"
                  onClick={() => onOpenEntity(perf)}
                  className="tl-vp-cast-card"
                >
                  <div className="tl-vp-cast-avatar">
                    {perf.thumbnailUrl ? (
                      <img
                        src={perf.thumbnailUrl}
                        alt={perf.name}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-base font-extrabold text-[var(--tl-accent-text)]">
                        {perf.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 text-left">
                    <div className="text-xs font-bold text-[var(--tl-text-primary)] truncate">
                      {perf.name}
                    </div>
                    <div className="text-[11px] text-[var(--tl-text-muted)] flex items-center gap-1.5 mt-0.5">
                      {typeof perf.count === 'number' && perf.count > 0 && (
                        <span>{perf.count} {isEn ? 'videos' : 'vídeos'}</span>
                      )}
                      {perf.gender && (
                        <span className="uppercase text-[10px] opacity-75">{perf.gender}</span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB: NETWORK CHANNELS */}
      {activeTab === 'channels' && (
        <div className="space-y-4">
          {affiliatedChannels.length === 0 ? (
            <div className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] py-12 text-center text-xs text-[var(--tl-text-muted)]">
              {tBrowse.portalNoChannels || (isEn ? 'No affiliated channels found.' : 'Nenhum canal afiliado encontrado.')}
            </div>
          ) : (
            <div className="tl-vp-channels-grid" data-vp-channels-grid="true">
              {affiliatedChannels.map((ch) => (
                <button
                  key={`ch-${ch.url || ch.name}`}
                  type="button"
                  onClick={() => onOpenEntity(ch)}
                  className="tl-vp-channel-card"
                >
                  <div className="tl-vp-channel-thumb">
                    {ch.thumbnailUrl ? (
                      <img
                        src={ch.thumbnailUrl}
                        alt={ch.name}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Tv className="h-6 w-6 text-[var(--tl-text-muted)]" aria-hidden="true" />
                    )}
                  </div>
                  <div className="p-2.5 flex items-center justify-between gap-2 min-w-0">
                    <span className="text-xs font-bold text-[var(--tl-text-primary)] truncate">
                      {ch.name}
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 text-[var(--tl-text-muted)] shrink-0" aria-hidden="true" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB: PLAYLISTS */}
      {activeTab === 'playlists' && (
        <div className="space-y-3" data-vp-playlists-grid="true">
          {playlists.map((pl) => {
            const isOpen = expandedPlaylistId === pl.id;
            const plVideos = Array.isArray(pl.videos) ? pl.videos : [];
            return (
              <div
                key={pl.id}
                className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] overflow-hidden"
              >
                <div className="p-3.5 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setExpandedPlaylistId(isOpen ? null : pl.id)}
                    className="flex items-center gap-3 min-w-0 flex-1 text-left"
                  >
                    {pl.thumbnailUrl ? (
                      <img
                        src={pl.thumbnailUrl}
                        alt={pl.title}
                        referrerPolicy="no-referrer"
                        className="h-14 w-24 rounded-lg object-cover bg-[var(--tl-surface-elevated)] shrink-0"
                      />
                    ) : (
                      <div className="h-14 w-24 rounded-lg bg-[var(--tl-surface-elevated)] flex items-center justify-center shrink-0">
                        <Layers className="h-5 w-5 text-[var(--tl-text-muted)]" aria-hidden="true" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-bold text-[var(--tl-text-primary)] truncate">
                        {pl.title}
                      </h3>
                      <p className="text-xs text-[var(--tl-text-muted)] mt-0.5">
                        {typeof pl.videoCount === 'number'
                          ? `${pl.videoCount} ${isEn ? 'videos' : 'vídeos'}`
                          : `${plVideos.length} ${isEn ? 'videos' : 'vídeos'}`}
                      </p>
                    </div>
                  </button>
                  {pl.url && (
                    <button
                      type="button"
                      onClick={() => onOpenEntity({ name: pl.title, url: pl.url })}
                      className="tl-subfilter-pill shrink-0"
                    >
                      {tBrowse.quickUrlOpen || (isEn ? 'Open' : 'Abrir')}
                    </button>
                  )}
                </div>

                {isOpen && plVideos.length > 0 && (
                  <div className="px-3.5 pb-3.5 pt-2 border-t border-[var(--tl-border)] tl-vp-video-grid">
                    {plVideos.map((vp) => (
                      <PortalCinemaVideoCard
                        key={vp.id}
                        post={vp}
                        creator={creator}
                        locale={locale}
                        isEn={isEn}
                        isLiked={checkPostLiked(vp)}
                        isFavorited={checkPostFavorited(vp)}
                        disableMotion={disableMotion}
                        onToggleLike={(p) => toggleLike(p.id, p, creator)}
                        onToggleFavorite={(p) => toggleFavorite(p.id, p, creator)}
                        onOpenPlaylist={handleOpenPlaylistModal}
                        onOpenVideo={onOpenVideo}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* TAB: ALBUMS */}
      {activeTab === 'albums' && (
        <div className="tl-vp-channels-grid" data-vp-albums-grid="true">
          {albumPosts.map((alb) => (
            <button
              key={alb.id}
              type="button"
              onClick={() => {
                const imgs = alb.photos?.length ? alb.photos : (alb.thumbnail ? [alb.thumbnail] : []);
                if (imgs.length) {
                  onOpenLightbox(imgs, 0, alb.title, alb.albumUrl || alb.originalUrl, alb.photoItems, alb.photoCount);
                }
              }}
              className="tl-vp-channel-card"
            >
              <div className="tl-vp-channel-thumb">
                {alb.thumbnail ? (
                  <img
                    src={alb.thumbnail}
                    alt={alb.title}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <Layers className="h-6 w-6 text-[var(--tl-text-muted)]" aria-hidden="true" />
                )}
              </div>
              <div className="p-2.5 text-left">
                <div className="text-xs font-bold text-[var(--tl-text-primary)] line-clamp-2">
                  {alb.title}
                </div>
                {typeof alb.photoCount === 'number' && (
                  <div className="text-[11px] text-[var(--tl-text-muted)] mt-1">
                    {alb.photoCount} {isEn ? 'photos' : 'fotos'}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* TAB: ABOUT & INFO */}
      {activeTab === 'about' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-vp-about-panel="true">
          <div className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] p-4 sm:p-5 space-y-4">
            <h2 className="text-sm font-bold text-[var(--tl-text-primary)] flex items-center gap-2">
              <Info className="h-4 w-4 text-[var(--tl-accent-text)]" aria-hidden="true" />
              <span>{tBrowse.portalTabAbout || (isEn ? 'About & Info' : 'Sobre e Informações')}</span>
            </h2>

            {creator.bio && (
              <p className="text-xs sm:text-sm text-[var(--tl-text-secondary)] whitespace-pre-wrap break-words leading-relaxed">
                {creator.bio}
              </p>
            )}

            {infoEntries.length > 0 && (
              <dl className="tl-vp-info-list">
                {infoEntries.map((entry) => (
                  <div key={entry.label} className="tl-vp-info-row">
                    <dt className="tl-vp-info-key">
                      {entry.icon}
                      <span>{entry.label}</span>
                    </dt>
                    <dd className="tl-vp-info-val">{entry.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {officialWebsiteUrl && (
                <a
                  href={officialWebsiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tl-vp-site-btn"
                >
                  <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{tBrowse.portalOfficialSite || (isEn ? 'Official website' : 'Site oficial')}</span>
                </a>
              )}
              {creator.profileUrl && (
                <a
                  href={creator.profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tl-subfilter-pill"
                >
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{tBrowse.openSourcePage || (isEn ? 'Open Source Page' : 'Abrir na fonte')}</span>
                </a>
              )}
            </div>
          </div>

          {(interests.length > 0 || relatedEntities.length > 0) && (
            <div className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] p-4 sm:p-5 space-y-5">
              {interests.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--tl-text-muted)] flex items-center gap-1.5">
                    <Tag className="h-3.5 w-3.5 text-[var(--tl-accent-text)]" aria-hidden="true" />
                    <span>{tBrowse.portalInterests || (isEn ? 'Interests & tags' : 'Interesses e tags')}</span>
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {interests.map((tag) => (
                      <button
                        key={`int-${tag.url || tag.name}`}
                        type="button"
                        onClick={() => tag.url && onOpenEntity(tag)}
                        disabled={!tag.url}
                        className="tl-clean-tag-pill"
                      >
                        {tag.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {relatedEntities.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--tl-text-muted)] flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5 text-[var(--tl-accent-text)]" aria-hidden="true" />
                    <span>{tBrowse.relatedCreatorsLabel || (isEn ? 'Related channels & profiles' : 'Canais e perfis relacionados')}</span>
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {relatedEntities.slice(0, 28).map((ent) => (
                      <button
                        key={`rel-${ent.url || ent.name}`}
                        type="button"
                        onClick={() => ent.url && onOpenEntity(ent)}
                        disabled={!ent.url}
                        className="tl-clean-tag-pill"
                      >
                        <span>{ent.name}</span>
                        {typeof ent.count === 'number' && ent.count > 0 && (
                          <span className="opacity-65 ml-1">{ent.count}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
