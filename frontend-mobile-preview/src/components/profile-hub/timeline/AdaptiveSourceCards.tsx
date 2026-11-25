import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  ChevronRight,
  Download,
  ExternalLink,
  Heart,
  Image as ImageIcon,
  MessageSquare,
  Search,
  Share2,
  X,
} from 'lucide-react';
import {
  TimelineEntityRef,
  TimelinePhotoItem,
  TimelinePost,
  upgradePhotoUrlFast,
} from './timelineModel';
import { fetchDirectoryCover, type ForumBoardSection, type TimelineDirectoryItem } from '../../../services/timelineBrowse';
import { useProfileTimelineStore } from '../../../store/useProfileTimelineStore';
import { useAppStore } from '../../../store/useAppStore';

function buildProxyThumb(rawUrl: string, referer?: string): string {
  return `/api/proxy-image?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(referer || rawUrl)}`;
}

function handleSmartImgError(e: React.SyntheticEvent<HTMLImageElement>, rawUrl: string, referer?: string) {
  const img = e.currentTarget;
  if (!img.dataset.proxied && rawUrl.startsWith('http')) {
    img.dataset.proxied = '1';
    img.src = buildProxyThumb(rawUrl, referer);
  } else {
    img.style.opacity = '0';
  }
}

function normalizeTagList(post: TimelinePost): Array<{ label: string; url?: string }> {
  const out: Array<{ label: string; url?: string }> = [];
  const seen = new Set<string>();
  const entitiesByName = new Map<string, string>();
  for (const ent of post.tagEntities || []) {
    if (ent?.name && ent.url) {
      entitiesByName.set(ent.name.trim().toLowerCase(), ent.url);
    }
  }
  for (const raw of post.tags || []) {
    const label = typeof raw === 'string'
      ? raw.trim()
      : String((raw as unknown as { name?: string })?.name || '').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const url = typeof raw === 'object' && raw !== null
      ? (raw as unknown as { url?: string }).url
      : entitiesByName.get(key);
    out.push({ label, url });
  }
  return out;
}

function useShareAction(url: string | undefined, isEn: boolean) {
  const addNotification = useAppStore((s) => s.addNotification);
  return () => {
    if (!url) return;
    if (typeof navigator.clipboard?.writeText === 'function') {
      navigator.clipboard.writeText(url).then(() => {
        addNotification({
          type: 'info',
          title: isEn ? 'Link copied' : 'Link copiado',
          message: isEn ? 'Link copied to clipboard.' : 'Link copiado para a área de transferência.',
        });
      }).catch(() => {});
    }
  };
}

export interface AdaptiveGalleryCardProps {
  post: TimelinePost;
  sourceLabel: string;
  isEn: boolean;
  onOpenGallery?: (post: TimelinePost) => void;
  onOpenLightbox: (
    images: string[],
    index: number,
    title: string,
    albumUrl?: string,
    items?: TimelinePhotoItem[],
    expectedCount?: number
  ) => void;
  onOpenEntity?: (entity: TimelineEntityRef) => void;
  onSelectSubfilter?: (subfilter: string) => void;
}

/**
 * Editorial Photo-Wall Card (`layoutMode === 'editorial_wall'`).
 * 100% theme-native (`--tl-*`), compact visual-first photo-wall card.
 * Clicking cover or title opens the full in-app Gallery Detail Page (`onOpenGallery`).
 */
export const EditorialGalleryCard: React.FC<AdaptiveGalleryCardProps> = ({
  post,
  isEn,
  onOpenGallery,
  onOpenLightbox,
  onOpenEntity,
  onSelectSubfilter,
}) => {
  const isLiked = useProfileTimelineStore((s) => Boolean(s.likedPostIds[post.id]));
  const isFav = useProfileTimelineStore((s) => Boolean(s.favoritedPostIds[post.id]));
  const toggleLike = useProfileTimelineStore((s) => s.toggleLike);
  const toggleFavorite = useProfileTimelineStore((s) => s.toggleFavorite);
  const handleShare = useShareAction(post.originalUrl || post.albumUrl, isEn);

  const coverThumb = post.thumbnail || post.photos?.[0] || '';
  const lightboxImages = useMemo(() => {
    if (Array.isArray(post.photos) && post.photos.length > 0) {
      return post.photos.map((u) => upgradePhotoUrlFast(u) || u);
    }
    const hd = post.previewHdUrl || upgradePhotoUrlFast(coverThumb) || coverThumb;
    return hd ? [hd] : [];
  }, [post.photos, post.previewHdUrl, coverThumb]);

  const photoCount = Math.max(post.photoCount || 0, post.photos?.length || 0);
  const artists = Array.isArray(post.artists) ? post.artists : [];
  const channels = Array.isArray(post.channels) ? post.channels : [];
  const tags = useMemo(() => normalizeTagList(post), [post]);
  const isGif = post.type === 'gif' || post.mediaType === 'gif';

  const openGallery = () => {
    if (onOpenGallery && (post.albumUrl || post.originalUrl)) {
      onOpenGallery(post);
      return;
    }
    if (lightboxImages.length === 0) return;
    onOpenLightbox(
      lightboxImages,
      0,
      post.title,
      post.albumUrl || post.originalUrl,
      post.photoItems,
      photoCount > 1 ? photoCount : undefined
    );
  };

  return (
    <article
      className="tl-editorial-card group"
      data-layout-card="editorial_wall"
      data-timeline-post-id={post.id}
      data-post-id={post.id}
    >
      <button
        type="button"
        onClick={openGallery}
        className="tl-editorial-cover"
        aria-label={isEn ? `Open gallery ${post.title}` : `Abrir galeria ${post.title}`}
      >
        {coverThumb ? (
          <img
            src={coverThumb}
            alt={post.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="tl-editorial-cover-img"
            onError={(e) => handleSmartImgError(e, coverThumb, post.albumUrl || post.originalUrl)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[var(--tl-surface-elevated)] text-[var(--tl-text-muted)]">
            <ImageIcon className="h-5 w-5 opacity-40" />
          </div>
        )}
        <div className="tl-editorial-cover-scrim" aria-hidden="true" />
        {(isGif || photoCount > 1) && (
          <div className="tl-editorial-cover-badges">
            {isGif && <span className="tl-editorial-badge">GIF</span>}
            {photoCount > 1 && (
              <span className="tl-editorial-badge" data-photo-count={photoCount}>
                {photoCount}
              </span>
            )}
          </div>
        )}
      </button>

      <div className="tl-editorial-body">
        <button
          type="button"
          onClick={openGallery}
          className="tl-editorial-title text-left"
        >
          {post.title}
        </button>

        {(artists.length > 0 || channels.length > 0) && (
          <div className="tl-editorial-entities" data-editorial-entities="true">
            {artists.slice(0, 3).map((artist) => (
              <button
                key={`art-${artist.url || artist.name}`}
                type="button"
                data-entity-kind="artist"
                data-entity-chip="artist"
                onClick={() => onOpenEntity?.({ ...artist, kind: 'artist' })}
                className="tl-clean-entity-pill tl-clean-entity-pill--accent"
              >
                <span className="truncate">{artist.name}</span>
              </button>
            ))}
            {channels.slice(0, 2).map((ch) => (
              <button
                key={`ch-${ch.url || ch.name}`}
                type="button"
                data-entity-kind="channel"
                data-entity-chip="channel"
                onClick={() => onOpenEntity?.({ ...ch, kind: 'channel' })}
                className="tl-clean-entity-pill"
              >
                <span className="truncate">{ch.name}</span>
              </button>
            ))}
          </div>
        )}

        {tags.length > 0 && (
          <div className="tl-editorial-tags">
            {tags.slice(0, 4).map((tag) => (
              <button
                key={`t-${tag.label}`}
                type="button"
                onClick={() => {
                  if (tag.url && onOpenEntity) {
                    onOpenEntity({ name: tag.label, url: tag.url, kind: 'tag' });
                  } else {
                    onSelectSubfilter?.(tag.label);
                  }
                }}
                className="tl-clean-tag-pill"
              >
                {tag.label}
              </button>
            ))}
          </div>
        )}

        <div className="tl-editorial-footer">
          <button
            type="button"
            onClick={openGallery}
            className="text-[11px] font-semibold text-[var(--tl-text-muted)] hover:text-[var(--tl-accent-text)] transition-colors cursor-pointer"
          >
            {photoCount > 1
              ? (isEn ? `${photoCount} photos` : `${photoCount} fotos`)
              : (isEn ? 'Open gallery' : 'Abrir galeria')}
          </button>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => toggleLike(post.id, post)}
              aria-pressed={isLiked}
              aria-label={isEn ? 'Like gallery' : 'Curtir galeria'}
              className={`tl-clean-icon-btn ${isLiked ? 'text-rose-400' : ''}`}
            >
              <Heart className={`h-4 w-4 ${isLiked ? 'fill-current' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => toggleFavorite(post.id, post)}
              aria-pressed={isFav}
              aria-label={isEn ? 'Save gallery' : 'Salvar galeria'}
              className={`tl-clean-icon-btn ${isFav ? 'text-[var(--tl-accent-text)]' : ''}`}
            >
              <Bookmark className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
            </button>
            <button
              type="button"
              onClick={handleShare}
              aria-label={isEn ? 'Share link' : 'Compartilhar link'}
              className="tl-clean-icon-btn"
            >
              <Share2 className="h-4 w-4" />
            </button>
            {post.originalUrl && (
              <a
                href={post.originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={isEn ? 'Open on source' : 'Abrir na fonte'}
                className="tl-clean-icon-btn"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};

/**
 * Category-First Visual Ribbon (`layoutMode === 'category_showcase'`).
 * 100% theme-native (`--tl-*`) horizontal category strip.
 * Clicking a category opens its dedicated Category Hub (`onOpenCategoryProfile`).
 */
export const CategoryShowcaseStrip: React.FC<{
  categories: TimelineDirectoryItem[];
  activeSubfilter: string | null;
  isLoading?: boolean;
  isEn: boolean;
  onOpenCategoryProfile: (item: TimelineDirectoryItem) => void;
  onSelectCategoryFilter: (slug: string) => void;
  onBrowseAllCategories: () => void;
}> = ({
  categories,
  activeSubfilter,
  isLoading,
  isEn,
  onOpenCategoryProfile,
  onBrowseAllCategories,
}) => {
  const featured = useMemo(() => {
    const withThumb = categories.filter((c) => Boolean(c.avatar));
    return (withThumb.length >= 6 ? withThumb : categories).slice(0, 16);
  }, [categories]);

  if (!isLoading && featured.length === 0) return null;

  return (
    <section
      className="tl-showcase-ribbon"
      data-showcase-category-strip="true"
      aria-label={isEn ? 'Featured Categories' : 'Categorias em Destaque'}
    >
      <div className="tl-showcase-ribbon-head">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--tl-text-secondary)] truncate">
            {isEn ? 'Categories' : 'Categorias'}
          </h3>
          {categories.length > 0 && (
            <span className="text-[11px] font-mono text-[var(--tl-text-muted)]">
              {categories.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onBrowseAllCategories}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-[var(--tl-accent-text)] hover:bg-[var(--tl-surface-hover)] transition-colors shrink-0 cursor-pointer"
        >
          <span>{isEn ? 'All categories' : 'Ver todas'}</span>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {isLoading && featured.length === 0 ? (
        <div className="tl-showcase-ribbon-track">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="tl-showcase-cat-tile animate-pulse opacity-50" />
          ))}
        </div>
      ) : (
        <div className="tl-showcase-ribbon-track">
          {featured.map((cat) => {
            const isActive = activeSubfilter?.toLowerCase() === cat.id.toLowerCase();
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => onOpenCategoryProfile(cat)}
                className={`tl-showcase-cat-tile ${isActive ? 'is-active' : ''}`}
                aria-label={isEn ? `Open ${cat.name} category` : `Abrir categoria ${cat.name}`}
              >
                {cat.avatar ? (
                  <img
                    src={cat.avatar}
                    alt={cat.name}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="tl-showcase-cat-img"
                    onError={(e) => handleSmartImgError(e, cat.avatar!, cat.url)}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-[var(--tl-surface-elevated)]" />
                )}
                <div className="tl-showcase-cat-scrim" aria-hidden="true" />
                <span className="tl-showcase-cat-label">{cat.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
};

/**
 * Category-First Widescreen Gallery Card (`layoutMode === 'category_showcase'`).
 * 100% theme-native (`--tl-*`), clean widescreen 16:10 photography with zero hardcoded purple,
 * zero repeated site-name banner, and zero cheap icons. Clicking opens the full Gallery Detail Page.
 */
export const CategoryShowcaseCard: React.FC<AdaptiveGalleryCardProps> = ({
  post,
  isEn,
  onOpenGallery,
  onOpenLightbox,
  onOpenEntity,
  onSelectSubfilter,
}) => {
  const isLiked = useProfileTimelineStore((s) => Boolean(s.likedPostIds[post.id]));
  const isFav = useProfileTimelineStore((s) => Boolean(s.favoritedPostIds[post.id]));
  const toggleLike = useProfileTimelineStore((s) => s.toggleLike);
  const toggleFavorite = useProfileTimelineStore((s) => s.toggleFavorite);
  const handleShare = useShareAction(post.originalUrl || post.albumUrl, isEn);

  const coverThumb = post.thumbnail || post.photos?.[0] || '';
  const lightboxImages = useMemo(() => {
    if (Array.isArray(post.photos) && post.photos.length > 0) {
      return post.photos.map((u) => upgradePhotoUrlFast(u) || u);
    }
    const hd = post.previewHdUrl || upgradePhotoUrlFast(coverThumb) || coverThumb;
    return hd ? [hd] : [];
  }, [post.photos, post.previewHdUrl, coverThumb]);

  const photoCount = Math.max(post.photoCount || 0, post.photos?.length || 0);
  const artists = Array.isArray(post.artists) ? post.artists : [];
  const tags = useMemo(() => normalizeTagList(post), [post]);

  const openGallery = () => {
    if (onOpenGallery && (post.albumUrl || post.originalUrl)) {
      onOpenGallery(post);
      return;
    }
    if (lightboxImages.length === 0) return;
    onOpenLightbox(
      lightboxImages,
      0,
      post.title,
      post.albumUrl || post.originalUrl,
      post.photoItems,
      photoCount > 1 ? photoCount : undefined
    );
  };

  return (
    <article
      className="tl-showcase-card group"
      data-layout-card="category_showcase"
      data-timeline-post-id={post.id}
      data-post-id={post.id}
    >
      <button
        type="button"
        onClick={openGallery}
        className="tl-showcase-media"
        aria-label={isEn ? `Open gallery ${post.title}` : `Abrir galeria ${post.title}`}
      >
        {coverThumb ? (
          <img
            src={coverThumb}
            alt={post.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="tl-showcase-media-img"
            onError={(e) => handleSmartImgError(e, coverThumb, post.albumUrl || post.originalUrl)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[var(--tl-surface-elevated)] text-[var(--tl-text-muted)]">
            <ImageIcon className="h-6 w-6 opacity-40" />
          </div>
        )}
        <div className="tl-showcase-media-overlay" aria-hidden="true" />
        {photoCount > 1 && (
          <span className="tl-showcase-count-pill" data-photo-count={photoCount}>
            {photoCount} {isEn ? 'photos' : 'fotos'}
          </span>
        )}
      </button>

      <div className="tl-showcase-card-bottom">
        <button
          type="button"
          onClick={openGallery}
          className="tl-editorial-title text-left"
        >
          {post.title}
        </button>

        {artists.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {artists.slice(0, 3).map((artist) => (
              <button
                key={`sa-${artist.url || artist.name}`}
                type="button"
                data-entity-kind="artist"
                data-entity-chip="artist"
                onClick={() => onOpenEntity?.({ ...artist, kind: 'artist' })}
                className="tl-clean-entity-pill tl-clean-entity-pill--accent"
              >
                <span className="truncate">{artist.name}</span>
              </button>
            ))}
          </div>
        )}

        {tags.length > 0 && (
          <div className="tl-showcase-cats-row">
            {tags.slice(0, 5).map((tag) => (
              <button
                key={`sc-${tag.label}`}
                type="button"
                onClick={() => {
                  if (tag.url && onOpenEntity) {
                    onOpenEntity({ name: tag.label, url: tag.url, kind: 'category' });
                  } else {
                    onSelectSubfilter?.(tag.label);
                  }
                }}
                className="tl-clean-tag-pill"
              >
                {tag.label}
              </button>
            ))}
          </div>
        )}

        <div className="tl-editorial-footer">
          <button
            type="button"
            onClick={openGallery}
            className="text-[11px] font-semibold text-[var(--tl-accent-text)] hover:underline cursor-pointer"
          >
            {isEn ? 'Open gallery' : 'Abrir galeria'}
          </button>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => toggleLike(post.id, post)}
              aria-pressed={isLiked}
              aria-label={isEn ? 'Like' : 'Curtir'}
              className={`tl-clean-icon-btn ${isLiked ? 'text-rose-400' : ''}`}
            >
              <Heart className={`h-4 w-4 ${isLiked ? 'fill-current' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => toggleFavorite(post.id, post)}
              aria-pressed={isFav}
              aria-label={isEn ? 'Save' : 'Salvar'}
              className={`tl-clean-icon-btn ${isFav ? 'text-[var(--tl-accent-text)]' : ''}`}
            >
              <Bookmark className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
            </button>
            <button
              type="button"
              onClick={handleShare}
              aria-label={isEn ? 'Share' : 'Compartilhar'}
              className="tl-clean-icon-btn"
            >
              <Share2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
};

/**
 * Structured Forum Thread Row (`layoutMode === 'forum_index'`).
 * 100% theme-native forum index row with subforum breadcrumb badge, thread kind tag,
 * uploader, reply/page counts, specs, mirrors, and direct Read Thread / Photos CTAs.
 */
export const ForumThreadRow: React.FC<{
  post: TimelinePost;
  isEn: boolean;
  onOpenThread: (post: TimelinePost) => void;
  onOpenLightbox: (
    images: string[],
    index: number,
    title: string,
    albumUrl?: string,
    items?: TimelinePhotoItem[],
    expectedCount?: number
  ) => void;
  onOpenEntity?: (entity: TimelineEntityRef) => void;
}> = ({
  post,
  isEn,
  onOpenThread,
  onOpenLightbox,
  onOpenEntity,
}) => {
  const isFav = useProfileTimelineStore((s) => Boolean(s.favoritedPostIds[post.id]));
  const toggleFavorite = useProfileTimelineStore((s) => s.toggleFavorite);

  const kind = post.threadKind || (post.mediaType === 'video_release' ? 'video_release' : post.type === 'gif' ? 'gif' : 'inline_album');
  const kindLabel =
    kind === 'video_release' ? (isEn ? 'Video Release' : 'Vídeo')
    : kind === 'download_pack' ? (isEn ? 'Download Pack' : 'Pacote')
    : kind === 'artist_collection' ? (isEn ? 'Collection' : 'Coleção')
    : kind === 'gif' || post.type === 'gif' ? 'GIF'
    : kind === 'discussion' ? (isEn ? 'Discussion' : 'Discussão')
    : (isEn ? 'Photo Set' : 'Álbum');

  const threadUrl = post.originalUrl || post.albumUrl || '';
  const hasGalleryTarget = Boolean(threadUrl);

  return (
    <article
      className="tl-forum-row"
      data-layout-card="forum_index"
      data-thread-kind={kind}
      data-timeline-post-id={post.id}
      data-post-id={post.id}
    >
      <div className="tl-forum-row-main">
        <div className="tl-forum-row-top">
          <span className={`tl-forum-kind-pill tl-forum-kind-pill--${kind}`}>
            {kindLabel}
          </span>
          {post.boardName && (
            post.boardUrl && onOpenEntity ? (
              <button
                type="button"
                onClick={() => onOpenEntity({ name: post.boardName!, url: post.boardUrl, kind: 'subforum' })}
                className="tl-forum-board-crumb"
              >
                {post.boardName}
              </button>
            ) : (
              <span className="tl-forum-board-crumb">{post.boardName}</span>
            )
          )}
          {post.releaseSpecs?.slice(0, 4).map((spec) => (
            <span key={spec} className="tl-forum-spec-pill">
              {spec}
            </span>
          ))}
          {post.hosts?.slice(0, 3).map((host) => (
            <span key={host} className="tl-forum-spec-pill">
              {host}
            </span>
          ))}
        </div>

        <button
          type="button"
          onClick={() => onOpenThread(post)}
          className="tl-forum-row-title text-left"
        >
          {post.title}
        </button>

        <div className="tl-forum-row-meta">
          {post.creatorName && (
            <button
              type="button"
              onClick={() => {
                if (post.sourcePage?.startsWith('http') && onOpenEntity) {
                  onOpenEntity({ name: post.creatorName, url: post.sourcePage, kind: 'creator' });
                } else {
                  onOpenThread(post);
                }
              }}
              className="font-semibold text-[var(--tl-text-secondary)] hover:text-[var(--tl-accent-text)] transition-colors truncate max-w-[180px] cursor-pointer"
            >
              {post.creatorName}
            </button>
          )}
          {typeof post.replyCount === 'number' && post.replyCount > 0 && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--tl-text-muted)]">
              <MessageSquare className="h-3 w-3 opacity-70" aria-hidden="true" />
              <span>{post.replyCount.toLocaleString()}</span>
            </span>
          )}
          {typeof post.totalPages === 'number' && post.totalPages > 1 && (
            <span className="font-mono text-[11px] text-[var(--tl-text-muted)]">
              {post.totalPages} {isEn ? 'pages' : 'páginas'}
            </span>
          )}
        </div>

        {Array.isArray(post.releaseLinks) && post.releaseLinks.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {post.releaseLinks.slice(0, 4).map((link, idx) => (
              <a
                key={`${link.url}-${idx}`}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="tl-release-mirror-chip"
              >
                <Download className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{link.label || link.host || (isEn ? 'Mirror' : 'Link')}</span>
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="tl-forum-row-actions">
        <button
          type="button"
          data-open-thread-reader="true"
          onClick={() => onOpenThread(post)}
          className="tl-forum-cta tl-forum-cta--primary"
        >
          <span>{isEn ? 'Read Thread' : 'Ler Tópico'}</span>
        </button>
        {hasGalleryTarget && (
          <button
            type="button"
            data-open-thread-gallery="true"
            onClick={() =>
              onOpenLightbox(
                post.photos?.length ? post.photos : (post.thumbnail ? [post.thumbnail] : []),
                0,
                post.title,
                threadUrl,
                post.photoItems,
                post.photoCount
              )
            }
            className="tl-forum-cta tl-forum-cta--secondary"
          >
            <span>{isEn ? 'Photos' : 'Fotos'}</span>
          </button>
        )}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => toggleFavorite(post.id, post)}
            aria-pressed={isFav}
            aria-label={isEn ? 'Bookmark thread' : 'Salvar tópico'}
            className={`tl-clean-icon-btn ${isFav ? 'text-[var(--tl-accent-text)]' : ''}`}
          >
            <Bookmark className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
          </button>
          {threadUrl && (
            <a
              href={threadUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={isEn ? 'Open thread externally' : 'Abrir tópico na fonte'}
              className="tl-clean-icon-btn"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>
    </article>
  );
};

/**
 * Searchable Forum Board Tree Explorer (`activeDirectoryKind === 'boards'`).
 */
export const ForumBoardTreePanel: React.FC<{
  sections: ForumBoardSection[];
  isLoading?: boolean;
  isEn: boolean;
  activeBoardId?: string | null;
  initialFilter?: string;
  onSelectBoard: (boardId: string) => void;
}> = ({ sections, isLoading, isEn, activeBoardId, initialFilter = '', onSelectBoard }) => {
  const [filter, setFilter] = useState(initialFilter);
  const q = filter.trim().toLowerCase();

  const filteredSections = useMemo(() => {
    if (!q) return sections;
    return sections
      .map((sec) => ({
        ...sec,
        boards: sec.boards.filter(
          (b) => b.name.toLowerCase().includes(q) || sec.title.toLowerCase().includes(q) || (b.role || '').toLowerCase().includes(q)
        ),
      }))
      .filter((sec) => sec.boards.length > 0);
  }, [sections, q]);

  const roleBadgeLabel = (role?: string) => {
    switch (role) {
      case 'album_sets': return isEn ? 'Photo Sets' : 'Álbuns';
      case 'video_releases': return isEn ? 'Videos' : 'Vídeos';
      case 'artist_collections': return isEn ? 'Collections' : 'Coleções';
      case 'gif_boards': return 'GIFs';
      case 'link_drops': return isEn ? 'Links' : 'Links';
      default: return '';
    }
  };

  return (
    <section className="space-y-3" data-directory-panel="boards">
      <div className="tl-directory-toolbar">
        <div className="tl-directory-search-wrap">
          <Search className="h-4 w-4 text-[var(--tl-text-muted)] shrink-0" aria-hidden="true" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={isEn ? 'Filter forum sections & boards...' : 'Filtrar seções e subfóruns...'}
            aria-label={isEn ? 'Filter boards' : 'Filtrar fóruns'}
            className="tl-directory-search-input"
          />
          {filter && (
            <button type="button" onClick={() => setFilter('')} aria-label={isEn ? 'Clear filter' : 'Limpar filtro'} className="p-1 text-[var(--tl-text-muted)] hover:text-[var(--tl-text-primary)]">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <span className="text-[11px] font-mono text-[var(--tl-text-muted)] shrink-0">
          {filteredSections.reduce((sum, s) => sum + s.boards.length, 0)} {isEn ? 'boards' : 'fóruns'}
        </span>
      </div>

      {isLoading && sections.length === 0 ? (
        <div className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] p-6 text-center text-xs text-[var(--tl-text-muted)]">
          {isEn ? 'Loading forum directory...' : 'Carregando estrutura de fóruns...'}
        </div>
      ) : filteredSections.length === 0 ? (
        <div className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] p-6 text-center text-xs text-[var(--tl-text-muted)]">
          {isEn ? 'No boards match this filter.' : 'Nenhum subfórum corresponde ao filtro.'}
        </div>
      ) : (
        filteredSections.map((section) => (
          <div
            key={section.title}
            className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] overflow-hidden"
          >
            <div className="flex items-center justify-between gap-2 border-b border-[var(--tl-border)] bg-[var(--tl-surface-elevated)] px-4 py-2.5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--tl-text-secondary)]">
                {section.title}
              </h3>
              <span className="text-[11px] font-mono text-[var(--tl-text-muted)]">
                {section.boards.length}
              </span>
            </div>
            <div className="tl-forum-board-grid">
              {section.boards.map((b) => {
                const isActive = activeBoardId === b.id;
                const rLabel = roleBadgeLabel(b.role);
                return (
                  <button
                    key={b.id}
                    type="button"
                    data-forum-board-id={b.boardId || b.id}
                    aria-pressed={isActive}
                    onClick={() => onSelectBoard(b.id)}
                    className={`tl-forum-board-tile ${isActive ? 'is-active' : ''}`}
                  >
                    <span className="min-w-0 truncate text-left text-xs font-semibold text-[var(--tl-text-primary)]">
                      {b.name}
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {rLabel && <span className="tl-forum-board-role">{rLabel}</span>}
                      <ChevronRight className="h-3.5 w-3.5 opacity-55" aria-hidden="true" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </section>
  );
};

function DirectoryCover({ item, source }: { item: TimelineDirectoryItem; source?: string }) {
  const coverRef = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState('');
  const original = item.thumbnailUrl || item.avatar;

  useEffect(() => {
    const cover = coverRef.current;
    if (!cover || original || !item.hasCoverPreview || !source) return;
    const controller = new AbortController();
    const load = () => {
      void fetchDirectoryCover(source, item.url, controller.signal).then(url => {
        if (!controller.signal.aborted) setPreview(url);
      }).catch(() => {});
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => controller.abort();
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        load();
      }
    }, { rootMargin: '160px 0px' });
    observer.observe(cover);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [item.hasCoverPreview, item.url, original, source]);

  const image = original || preview;
  return (
    <span className="tl-directory-cover" ref={coverRef} aria-hidden="true">
      <ImageIcon className="h-5 w-5 opacity-40" />
      {image && (
        <img
          key={image}
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="tl-directory-visual-img"
          onError={e => handleSmartImgError(e, image, item.url)}
        />
      )}
    </span>
  );
}

export const VisualDirectoryExplorer: React.FC<{
  kind: string;
  source?: string;
  items: TimelineDirectoryItem[];
  isLoading?: boolean;
  isLoadingMore?: boolean;
  hasMore?: boolean;
  error?: string | null;
  isEn: boolean;
  initialFilter?: string;
  onSelectItem: (item: TimelineDirectoryItem) => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
}> = ({ kind, source, items, isLoading, isLoadingMore, hasMore, error, isEn, initialFilter = '', onSelectItem, onLoadMore, onRetry }) => {
  const [filter, setFilter] = useState(initialFilter);
  const [visibleLimit, setVisibleLimit] = useState(48);

  const q = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return items;
    return items.filter((it) => it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q));
  }, [items, q]);

  const useVisualGrid = kind === 'categories' || (kind !== 'tags' && items.some(it => it.avatar || it.thumbnailUrl));
  const shown = filtered.slice(0, visibleLimit);
  const remaining = Math.max(0, filtered.length - shown.length);

  const placeholder =
    kind === 'artists' ? (isEn ? 'Filter artists...' : 'Filtrar artistas...')
    : kind === 'channels' ? (isEn ? 'Filter channels & studios...' : 'Filtrar canais e estúdios...')
    : kind === 'tags' ? (isEn ? 'Filter tags...' : 'Filtrar tags...')
    : (isEn ? 'Filter categories...' : 'Filtrar categorias...');

  return (
    <section
      className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] p-4 space-y-3.5"
      data-directory-panel={kind}
      data-directory-mode={useVisualGrid ? 'visual_grid' : 'pill_index'}
    >
      <div className="tl-directory-toolbar">
        <div className="tl-directory-search-wrap">
          <Search className="h-4 w-4 text-[var(--tl-text-muted)] shrink-0" aria-hidden="true" />
          <input
            type="search"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setVisibleLimit(48);
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            className="tl-directory-search-input"
          />
          {filter && (
            <button type="button" onClick={() => setFilter('')} aria-label={isEn ? 'Clear filter' : 'Limpar filtro'} className="p-1 text-[var(--tl-text-muted)] hover:text-[var(--tl-text-primary)]">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <span className="text-[11px] font-mono text-[var(--tl-text-muted)] shrink-0">
          {filtered.length.toLocaleString()} {isEn ? 'items' : 'itens'}
        </span>
      </div>

      {isLoading && items.length === 0 ? (
        <div className="py-8 text-center text-xs text-[var(--tl-text-muted)]">
          <span role="status">{isEn ? 'Loading directory...' : 'Carregando diretório...'}</span>
        </div>
      ) : shown.length === 0 ? (
        !error && (
          <div className="py-8 text-center text-xs text-[var(--tl-text-muted)]" role="status">
            {hasMore && q
              ? (isEn ? 'No matches on the loaded pages.' : 'Nenhum resultado nas páginas carregadas.')
              : q
                ? (isEn ? 'No entries match your filter.' : 'Nenhum item corresponde ao filtro.')
                : (isEn ? 'This directory is empty.' : 'O diretório está vazio.')}
          </div>
        )
      ) : useVisualGrid ? (
        <div className={`tl-directory-visual-grid ${kind === 'artists' ? 'tl-directory-visual-grid--portrait' : ''}`}>
          {shown.map((item) => {
            const imgSrc = item.avatar || item.thumbnailUrl || '';
            const countLabel = item.subscribersText
              || (typeof item.count === 'number' && item.count > 0 ? item.count.toLocaleString() : '');
            return (
            <button
              key={item.id}
              type="button"
              data-directory-item-id={item.id}
              onClick={() => onSelectItem({ ...item, avatar: imgSrc || item.avatar })}
              className="tl-directory-visual-card group"
            >
              <DirectoryCover key={`${item.url}:${imgSrc}`} item={item} source={source} />
              <div className="tl-directory-visual-scrim" aria-hidden="true" />
              {typeof item.rank === 'number' && item.rank > 0 && (
                <span className="absolute top-1.5 left-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-mono font-bold text-amber-300">
                  #{item.rank}
                </span>
              )}
              {countLabel && (
                <span className="tl-directory-visual-count">{countLabel}</span>
              )}
              <span className="tl-directory-visual-name inline-flex items-center gap-1">
                <span>{item.name}</span>
                {item.verified && <span aria-label="verified" className="text-sky-400 text-[10px]">✓</span>}
              </span>
            </button>
          );})}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {shown.map((item) => (
            <button
              key={item.id}
              type="button"
              data-directory-item-id={item.id}
              onClick={() => onSelectItem(item)}
              className="tl-clean-tag-pill"
            >
              <span>{item.name}</span>
              {typeof item.count === 'number' && item.count > 0 && (
                <span className="ml-1 opacity-70">({item.count.toLocaleString()})</span>
              )}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="tl-feed-notice" data-feed-state="error">
          <div className="tl-feed-notice-message" role="alert">
            {isEn ? 'The directory could not be loaded.' : 'Não foi possível carregar o diretório.'}
          </div>
          {onRetry && (
            <button className="tl-directory-load-more-btn" type="button" onClick={onRetry}>
              {isEn ? 'Try again' : 'Tentar novamente'}
            </button>
          )}
        </div>
      )}

      {(remaining > 0 || (!error && hasMore && onLoadMore)) && (
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setVisibleLimit((v) => v + 60)}
              className="tl-entity-load-more-btn"
            >
              {isEn ? `Show more (${remaining.toLocaleString()} remaining)` : `Mostrar mais (${remaining.toLocaleString()} restantes)`}
            </button>
          )}
          {!error && hasMore && onLoadMore && (
            <button
              type="button"
              data-directory-load-more="true"
              disabled={isLoadingMore}
              onClick={onLoadMore}
              className="tl-directory-load-more-btn"
            >
              {isEn ? (isLoadingMore ? 'Loading...' : 'Load next page') : (isLoadingMore ? 'Carregando...' : 'Carregar próxima página')}
            </button>
          )}
        </div>
      )}
    </section>
  );
};
