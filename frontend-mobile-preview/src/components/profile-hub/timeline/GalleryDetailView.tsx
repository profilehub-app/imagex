import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  ChevronRight,
  ExternalLink,
  Heart,
  Loader2,
  Maximize2,
  Share2,
} from 'lucide-react';
import {
  TimelineEntityRef,
  TimelinePhotoItem,
  TimelinePost,
  upgradePhotoUrlFast,
} from './timelineModel';
import { fetchGalleryDetail, type GalleryDetailResponse } from '../../../services/timelineBrowse';
import { useProfileTimelineStore } from '../../../store/useProfileTimelineStore';
import { useAppStore } from '../../../store/useAppStore';

function proxyUrl(rawUrl: string, referer?: string): string {
  return `/api/proxy-image?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(referer || rawUrl)}`;
}

function handleImgError(e: React.SyntheticEvent<HTMLImageElement>, rawUrl: string, referer?: string) {
  const img = e.currentTarget;
  if (!img.dataset.proxied && rawUrl.startsWith('http')) {
    img.dataset.proxied = '1';
    img.src = proxyUrl(rawUrl, referer);
  } else {
    img.style.opacity = '0';
  }
}

export interface GalleryDetailViewProps {
  galleryUrl: string;
  seedPost?: TimelinePost | null;
  sourceLabel?: string;
  isEn: boolean;
  onBack: () => void;
  onOpenLightbox: (
    images: string[],
    index: number,
    title?: string,
    albumUrl?: string,
    items?: TimelinePhotoItem[],
    expectedPhotoCount?: number
  ) => void;
  onOpenEntity: (entity: TimelineEntityRef) => void;
  onOpenRelatedGallery: (post: TimelinePost) => void;
}

/**
 * Full in-app Visual Gallery Detail Page.
 * Mirrors native gallery pages: header metadata (clickable artists, channels, categories/tags),
 * complete multi-column photo grid (clicking photo #N opens Lightbox at #N), Slideshow action,
 * and clickable Related Galleries navigation at the bottom.
 */
export const GalleryDetailView: React.FC<GalleryDetailViewProps> = ({
  galleryUrl,
  seedPost,
  sourceLabel,
  isEn,
  onBack,
  onOpenLightbox,
  onOpenEntity,
  onOpenRelatedGallery,
}) => {
  const [data, setData] = useState<GalleryDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const postId = seedPost?.id || `gal:${galleryUrl}`;
  const isLiked = useProfileTimelineStore((s) => Boolean(s.likedPostIds[postId]));
  const isFav = useProfileTimelineStore((s) => Boolean(s.favoritedPostIds[postId]));
  const toggleLike = useProfileTimelineStore((s) => s.toggleLike);
  const toggleFavorite = useProfileTimelineStore((s) => s.toggleFavorite);
  const addNotification = useAppStore((s) => s.addNotification);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    setData(null);

    void fetchGalleryDetail(galleryUrl, controller.signal)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setIsLoading(false);
      })
      .catch((err: any) => {
        if (cancelled || err?.name === 'AbortError') return;
        setError(err?.message || (isEn ? 'Failed to load gallery' : 'Não foi possível carregar a galeria'));
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [galleryUrl, reloadTick, isEn]);

  const title = data?.title || seedPost?.title || (isEn ? 'Gallery' : 'Galeria');
  const displaySource = data?.sourceName || sourceLabel || '';
  const artists = data?.artists?.length ? data.artists : (seedPost?.artists || []);
  const channels = data?.channels?.length ? data.channels : (seedPost?.channels || []);
  const tagEntities = useMemo<Array<{ name: string; url?: string; kind?: string }>>(() => {
    if (data?.tagEntities?.length) return data.tagEntities;
    if (seedPost?.tagEntities?.length) return seedPost.tagEntities;
    return (seedPost?.tags || []).map((t) => ({ name: String(t), kind: 'tag' }));
  }, [data?.tagEntities, seedPost?.tagEntities, seedPost?.tags]);

  const photos: TimelinePhotoItem[] = useMemo(() => {
    if (data?.photos?.length) return data.photos;
    if (isLoading && !data) return [];
    if (seedPost?.photoItems?.length) return seedPost.photoItems;
    if (seedPost?.photos?.length) {
      return seedPost.photos.map((u, idx) => ({
        id: `seed-${idx}`,
        url: upgradePhotoUrlFast(u) || u,
        thumbnailUrl: u,
        pageUrl: galleryUrl,
        sourcePage: galleryUrl,
      }));
    }
    return [];
  }, [data, isLoading, seedPost?.photoItems, seedPost?.photos, galleryUrl]);

  const lightboxImages = useMemo(
    () => photos.map((p) => p.url || p.thumbnailUrl || '').filter(Boolean),
    [photos]
  );

  const syntheticPost = useMemo<TimelinePost>(() => {
    if (seedPost) return seedPost;
    return {
      id: postId,
      creatorId: data?.authorUrl || `gallery:${galleryUrl}`,
      creatorName: data?.author || displaySource || 'Gallery',
      creatorHandle: '',
      creatorAvatar: photos[0]?.thumbnailUrl || '',
      type: 'album',
      source: data?.source || 'generic',
      title,
      originalUrl: data?.galleryUrl || galleryUrl,
      albumUrl: data?.galleryUrl || galleryUrl,
      thumbnail: photos[0]?.thumbnailUrl || '',
      photos: lightboxImages,
      photoCount: photos.length,
      comments: [],
      likes: null,
      date: '',
    };
  }, [seedPost, postId, data, galleryUrl, displaySource, photos, title, lightboxImages]);

  const openPhotoAt = (index: number) => {
    if (lightboxImages.length === 0) return;
    const alreadyLoadedFull = Boolean(data?.ok && photos.length > 0);
    onOpenLightbox(
      lightboxImages,
      index,
      title,
      alreadyLoadedFull ? undefined : (data?.galleryUrl || galleryUrl),
      photos,
      photos.length
    );
  };

  const handleShare = () => {
    const target = data?.galleryUrl || galleryUrl;
    if (!target || typeof navigator.clipboard?.writeText !== 'function') return;
    navigator.clipboard.writeText(target).then(() => {
      addNotification({
        type: 'info',
        title: isEn ? 'Link copied' : 'Link copiado',
        message: isEn ? 'Gallery link copied to clipboard.' : 'Link da galeria copiado para a área de transferência.',
      });
    }).catch(() => {});
  };

  const primaryBreadcrumbEntity = artists[0] || channels[0] || tagEntities[0];

  return (
    <section
      className="tl-gallery-detail space-y-5 min-w-0 max-w-full"
      data-gallery-detail-view="true"
      data-gallery-url={galleryUrl}
    >
      {/* Top Navigation & Action Bar */}
      <div className="tl-gallery-detail-topbar">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            data-gallery-detail-back="true"
            onClick={onBack}
            className="tl-nav-back-btn"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{isEn ? 'Back' : 'Voltar'}</span>
          </button>

          <nav aria-label="Breadcrumb" className="hidden sm:flex items-center gap-1.5 min-w-0 text-xs text-[var(--tl-text-muted)]">
            {displaySource && <span className="font-semibold text-[var(--tl-text-secondary)] shrink-0">{displaySource}</span>}
            {primaryBreadcrumbEntity?.name && (
              <>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
                {primaryBreadcrumbEntity.url ? (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenEntity({
                        name: primaryBreadcrumbEntity.name,
                        url: primaryBreadcrumbEntity.url,
                        kind: (primaryBreadcrumbEntity.kind || 'artist') as any,
                      })
                    }
                    className="truncate hover:text-[var(--tl-accent-text)] transition-colors cursor-pointer"
                  >
                    {primaryBreadcrumbEntity.name}
                  </button>
                ) : (
                  <span className="truncate">{primaryBreadcrumbEntity.name}</span>
                )}
              </>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {lightboxImages.length > 0 && (
            <button
              type="button"
              data-gallery-open-slideshow="true"
              onClick={() => openPhotoAt(0)}
              className="tl-gallery-primary-btn"
            >
              <Maximize2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{isEn ? 'Slideshow' : 'Tela cheia'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => toggleLike(postId, syntheticPost)}
            aria-pressed={isLiked}
            aria-label={isEn ? 'Like gallery' : 'Curtir galeria'}
            className={`tl-clean-icon-btn ${isLiked ? 'text-rose-400' : ''}`}
          >
            <Heart className={`h-4 w-4 ${isLiked ? 'fill-current' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => toggleFavorite(postId, syntheticPost)}
            aria-pressed={isFav}
            aria-label={isEn ? 'Save gallery' : 'Salvar galeria'}
            className={`tl-clean-icon-btn ${isFav ? 'text-[var(--tl-accent-text)]' : ''}`}
          >
            <Bookmark className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
          </button>
          <button
            type="button"
            onClick={handleShare}
            aria-label={isEn ? 'Copy link' : 'Copiar link'}
            className="tl-clean-icon-btn"
          >
            <Share2 className="h-4 w-4" />
          </button>
          <a
            href={data?.galleryUrl || galleryUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={isEn ? 'Open original page' : 'Abrir na fonte'}
            className="tl-clean-icon-btn"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>

      {/* Gallery Metadata Header */}
      <header className="tl-gallery-detail-header">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-base sm:text-xl font-extrabold tracking-tight text-[var(--tl-text-primary)] leading-snug break-words">
            {title}
          </h1>
          <span className="text-xs font-mono text-[var(--tl-text-muted)] shrink-0" data-gallery-photo-total={photos.length}>
            {photos.length > 0
              ? (photos.length === 1
                  ? (isEn ? '1 photo' : '1 foto')
                  : (isEn ? `${photos.length} photos` : `${photos.length} fotos`))
              : (isLoading ? (isEn ? 'Loading…' : 'Carregando…') : '')}
          </span>
        </div>

        {(artists.length > 0 || channels.length > 0 || tagEntities.length > 0) && (
          <div className="tl-gallery-meta-groups">
            {artists.length > 0 && (
              <div className="tl-gallery-meta-row" data-gallery-artists="true">
                <span className="tl-gallery-meta-label">{isEn ? 'Artists' : 'Artistas'}</span>
                <div className="flex flex-wrap gap-1.5">
                  {artists.map((artist) => (
                    <button
                      key={`ga-${artist.url || artist.name}`}
                      type="button"
                      data-entity-chip="artist"
                      onClick={() => artist.url && onOpenEntity({ name: artist.name, url: artist.url, kind: 'artist' })}
                      className="tl-clean-entity-pill tl-clean-entity-pill--accent"
                    >
                      {artist.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {channels.length > 0 && (
              <div className="tl-gallery-meta-row" data-gallery-channels="true">
                <span className="tl-gallery-meta-label">{isEn ? 'Channel' : 'Canal'}</span>
                <div className="flex flex-wrap gap-1.5">
                  {channels.map((ch) => (
                    <button
                      key={`gc-${ch.url || ch.name}`}
                      type="button"
                      data-entity-chip="channel"
                      onClick={() => ch.url && onOpenEntity({ name: ch.name, url: ch.url, kind: 'channel' })}
                      className="tl-clean-entity-pill"
                    >
                      {ch.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tagEntities.length > 0 && (
              <div className="tl-gallery-meta-row" data-gallery-tags="true">
                <span className="tl-gallery-meta-label">{isEn ? 'Tags' : 'Tags'}</span>
                <div className="flex flex-wrap gap-1.5">
                  {tagEntities.slice(0, 20).map((tag, idx) => (
                    <button
                      key={`gt-${tag.url || tag.name}-${idx}`}
                      type="button"
                      onClick={() => {
                        if (tag.url) {
                          onOpenEntity({ name: tag.name, url: tag.url, kind: (tag.kind || 'category') as any });
                        }
                      }}
                      className="tl-clean-tag-pill"
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </header>

      {/* Gallery Full Photo Grid */}
      {isLoading && photos.length === 0 ? (
        <div className="tl-gallery-loading">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--tl-accent-text)]" />
          <span>{isEn ? 'Loading full gallery...' : 'Carregando galeria completa...'}</span>
        </div>
      ) : error && photos.length === 0 ? (
        <div role="alert" className="tl-gallery-error">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setReloadTick((n) => n + 1)}
            className="tl-nav-back-btn"
          >
            {isEn ? 'Retry' : 'Tentar novamente'}
          </button>
        </div>
      ) : (
        <div className="tl-gallery-photo-grid" data-gallery-photo-grid="true">
          {photos.map((photo, idx) => {
            const thumb = photo.thumbnailUrl || photo.url;
            return (
              <button
                key={photo.id || `${thumb}-${idx}`}
                type="button"
                data-gallery-photo-tile={idx}
                onClick={() => openPhotoAt(idx)}
                className="tl-gallery-photo-tile group"
                aria-label={isEn ? `View photo ${idx + 1} of ${photos.length}` : `Ver foto ${idx + 1} de ${photos.length}`}
              >
                <img
                  src={thumb}
                  alt={`${title} #${idx + 1}`}
                  loading={idx < 8 ? 'eager' : 'lazy'}
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="tl-gallery-photo-img"
                  onError={(e) => handleImgError(e, thumb, data?.galleryUrl || galleryUrl)}
                />
                <span className="tl-gallery-photo-index">{idx + 1}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Related Galleries */}
      {Array.isArray(data?.relatedGalleries) && data!.relatedGalleries.length > 0 && (
        <section className="space-y-3 pt-2" data-gallery-related-section="true">
          <div className="flex items-center justify-between gap-2 border-t border-[var(--tl-border)] pt-4">
            <h2 className="text-sm font-extrabold text-[var(--tl-text-primary)]">
              {isEn ? 'Related Galleries' : 'Galerias Relacionadas'}
            </h2>
            <span className="text-xs font-mono text-[var(--tl-text-muted)]">
              {data!.relatedGalleries.length}
            </span>
          </div>
          <div className="tl-gallery-related-grid">
            {data!.relatedGalleries.map((rel) => {
              const cover = rel.thumbnail || rel.photos?.[0] || '';
              return (
                <button
                  key={rel.id}
                  type="button"
                  data-related-gallery-card="true"
                  onClick={() => onOpenRelatedGallery(rel)}
                  className="tl-gallery-related-card group"
                >
                  <div className="tl-gallery-related-media">
                    {cover && (
                      <img
                        src={cover}
                        alt={rel.title}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                        onError={(e) => handleImgError(e, cover, rel.albumUrl || rel.originalUrl)}
                      />
                    )}
                  </div>
                  <span className="tl-gallery-related-title">{rel.title}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
};
