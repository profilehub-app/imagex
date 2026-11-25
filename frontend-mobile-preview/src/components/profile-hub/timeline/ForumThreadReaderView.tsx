import React from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Images,
  Loader2,
  UserRound,
} from 'lucide-react';
import type { TimelineActiveThreadState } from '../../../store/useProfileTimelineStore';
import type { TimelinePhotoItem } from './timelineModel';
import { handleProxiedImageError } from '../../../services/profileHubImageFallback';
import { translations } from '../../../i18n/translations';

interface ForumThreadReaderViewProps {
  threadState: TimelineActiveThreadState;
  isEn: boolean;
  onBack: () => void;
  onLoadPage: (pageOrUrl: number | string) => void;
  onOpenEntity?: (entity: { name: string; url?: string; kind?: string }, source?: string) => void;
  onOpenLightbox: (
    images: string[],
    index: number,
    title?: string,
    albumUrl?: string,
    items?: TimelinePhotoItem[],
    expectedPhotoCount?: number
  ) => void;
}

export const ForumThreadReaderView: React.FC<ForumThreadReaderViewProps> = ({
  threadState,
  isEn,
  onBack,
  onLoadPage,
  onOpenEntity,
  onOpenLightbox,
}) => {
  const tBrowse = (translations[isEn ? 'en-US' : 'pt-BR'] as any).timelineBrowse || {};
  const { data, isLoading, error, threadUrl, title, source } = threadState;
  const currentPage = data?.currentPage || 1;
  const totalPages = data?.totalPages || 1;
  const normalizedPhotos = (data?.photos || []).map((p) => {
    const anyP = p as Record<string, any>;
    const resolvedUrl = String(anyP.originalUrl || anyP.url || anyP.thumbnailUrl || '').trim();
    return {
      ...p,
      url: resolvedUrl,
      thumbnailUrl: String(anyP.thumbnailUrl || resolvedUrl).trim() || undefined,
    };
  });
  const allThreadImages = normalizedPhotos.map((p) => p.url).filter(Boolean);

  return (
    <section
      className="space-y-4 min-w-0 max-w-full"
      data-forum-thread-reader="true"
      aria-label={data?.title || title}
    >
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] p-3">
        <button
          type="button"
          data-thread-reader-back
          onClick={onBack}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] px-3.5 py-2 text-xs font-bold text-[var(--tl-text-primary)] hover:border-[var(--tl-accent-border)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          <span>{tBrowse.backToFeed || (isEn ? 'Back to feed' : 'Voltar para o feed')}</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {allThreadImages.length > 0 && (
            <button
              type="button"
              onClick={() =>
                onOpenLightbox(
                  allThreadImages,
                  0,
                  data?.title || title,
                  data?.pageUrl || threadUrl,
                  normalizedPhotos,
                  data?.count || allThreadImages.length
                )
              }
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[var(--tl-accent)] px-3.5 py-2 text-xs font-bold text-[var(--tl-accent-contrast)] hover:bg-[var(--tl-accent-hover)]"
            >
              <Images className="h-4 w-4" aria-hidden />
              <span>{tBrowse.loadGallery || (isEn ? 'Open Gallery' : 'Abrir Galeria')} ({allThreadImages.length})</span>
            </button>
          )}
          <a
            href={data?.pageUrl || threadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] px-3 py-2 text-xs font-semibold text-[var(--tl-text-secondary)] hover:text-[var(--tl-text-primary)]"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            <span>{tBrowse.openSourcePage || (isEn ? 'Open source' : 'Abrir na fonte')}</span>
          </a>
        </div>
      </div>

      {/* Header & Breadcrumbs */}
      <div className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] p-4 space-y-2.5 min-w-0">
        {Array.isArray(data?.breadcrumbs) && data.breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--tl-text-muted)]">
            {data.breadcrumbs.map((crumb, idx) => (
              <React.Fragment key={`${crumb.name}-${idx}`}>
                {idx > 0 && <span aria-hidden>/</span>}
                {crumb.url && onOpenEntity ? (
                  <button
                    type="button"
                    onClick={() => onOpenEntity({ name: crumb.name, url: crumb.url, kind: 'subforum' }, source)}
                    className="inline-flex min-h-11 items-center px-1 hover:text-[var(--tl-accent-text)] underline-offset-2 hover:underline"
                  >
                    {crumb.name}
                  </button>
                ) : (
                  <span>{crumb.name}</span>
                )}
              </React.Fragment>
            ))}
          </nav>
        )}

        <h2 className="text-base sm:text-lg font-extrabold text-[var(--tl-text-primary)] break-words">
          {data?.title || title}
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          {data?.author && (
            data.authorUrl && onOpenEntity ? (
              <button
                type="button"
                onClick={() => {
                  if (data?.authorUrl && onOpenEntity) {
                    onOpenEntity({ name: data.author || '', url: data.authorUrl, kind: 'creator' }, source);
                  }
                }}
                className="tl-entity-chip"
              >
                <UserRound className="h-3.5 w-3.5" aria-hidden />
                <span>{data.author}</span>
              </button>
            ) : (
              <span className="tl-tag-chip">
                <UserRound className="h-3.5 w-3.5" aria-hidden />
                <span>{data.author}</span>
              </span>
            )
          )}
          {data?.threadKind && (
            <span className="rounded-full border border-[var(--tl-accent-border)] bg-[var(--tl-accent-soft)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--tl-accent-text-strong)]">
              {data.threadKind === 'video_release'
                ? (tBrowse.videoReleaseBadge || (isEn ? 'Video Release' : 'Lançamento de Vídeo'))
                : data.threadKind === 'download_pack'
                  ? (tBrowse.downloadPackBadge || (isEn ? 'Download Pack' : 'Pacote para Download'))
                  : data.threadKind === 'artist_collection'
                    ? (isEn ? 'Artist Collection' : 'Coleção')
                    : data.threadKind === 'inline_album'
                      ? (isEn ? 'Photo Set' : 'Álbum de Fotos')
                      : data.threadKind === 'discussion'
                        ? (isEn ? 'Discussion' : 'Discussão')
                        : data.threadKind}
            </span>
          )}
          {Array.isArray(data?.releaseSpecs) && data.releaseSpecs.map((spec) => (
            <span key={spec} className="tl-tag-chip font-mono">
              {spec}
            </span>
          ))}
        </div>
      </div>

      {/* Loading / Error */}
      {isLoading && (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] py-10 text-xs text-[var(--tl-text-muted)]">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--tl-accent-text)]" />
          <span>{isEn ? 'Loading thread...' : 'Carregando tópico...'}</span>
        </div>
      )}

      {!isLoading && error && (
        <div role="alert" className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-200 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => onLoadPage(currentPage)}
            className="min-h-11 rounded-xl border border-rose-400/40 px-3 py-1.5 font-bold hover:bg-rose-500/20"
          >
            {tBrowse.browseRetry || (isEn ? 'Retry' : 'Tentar novamente')}
          </button>
        </div>
      )}

      {/* Posts List */}
      {!isLoading && data && (
        <div className="space-y-3">
          {data.posts.map((p) => (
            <article
              key={p.id}
              data-forum-post-id={p.id}
              className="rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] p-4 space-y-3 min-w-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--tl-border)] pb-2 text-xs">
                <strong className="font-bold text-[var(--tl-text-primary)]">{p.author}</strong>
                {p.date && <span className="text-[11px] font-mono text-[var(--tl-text-muted)]">{p.date}</span>}
              </div>

              {p.text && (
                <p className="text-xs sm:text-sm leading-relaxed text-[var(--tl-text-secondary)] whitespace-pre-wrap break-words">
                  {p.text}
                </p>
              )}

              {Array.isArray(p.photos) && p.photos.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {p.photos.map((photo, pIdx) => {
                    const anyPhoto = photo as Record<string, any>;
                    const fullSrc = String(anyPhoto.originalUrl || anyPhoto.url || anyPhoto.thumbnailUrl || '').trim();
                    const thumbSrc = String(anyPhoto.thumbnailUrl || fullSrc).trim();
                    if (!thumbSrc) return null;
                    const lightboxIdx = Math.max(
                      0,
                      allThreadImages.findIndex((u) => u === fullSrc)
                    );
                    return (
                      <button
                        key={photo.id || `${p.id}-img-${pIdx}`}
                        type="button"
                        aria-label={isEn ? `Open image ${pIdx + 1}` : `Abrir imagem ${pIdx + 1}`}
                        onClick={() =>
                          onOpenLightbox(
                            allThreadImages,
                            lightboxIdx,
                            data.title || title,
                            data.pageUrl || threadUrl,
                            normalizedPhotos,
                            data.count || allThreadImages.length
                          )
                        }
                        className="relative aspect-[4/3] overflow-hidden rounded-xl border border-[var(--tl-border)] bg-black/30 cursor-pointer group"
                      >
                        <img
                          src={thumbSrc}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                          onError={(e) => {
                            handleProxiedImageError(e, {
                              rawUrl: thumbSrc,
                              referer: data.pageUrl || threadUrl,
                              hideOnExhausted: true,
                            });
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
              )}

              {Array.isArray(p.releaseLinks) && p.releaseLinks.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--tl-text-muted)]">
                    {tBrowse.releaseMirrors || (isEn ? 'Download mirrors' : 'Links externos')}
                  </div>
                  <div className="tl-tags-strip">
                    {p.releaseLinks.map((link, lIdx) => (
                      <a
                        key={`${link.url}-${lIdx}`}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tl-release-mirror-chip"
                      >
                        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                        <span>{link.label || link.host || link.url}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {/* Pagination Bar */}
      {totalPages > 1 && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--tl-border)] bg-[var(--tl-surface)] p-3"
          data-thread-pagination
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isLoading || currentPage <= 1}
              onClick={() => onLoadPage(Math.max(1, currentPage - 1))}
              className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] px-3 py-2 text-xs font-bold text-[var(--tl-text-primary)] disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              <span>{isEn ? 'Previous' : 'Anterior'}</span>
            </button>
            <span className="px-2 text-xs font-mono text-[var(--tl-text-secondary)]">
              {(tBrowse.threadPageLabel || (isEn ? 'Page {current} / {total}' : 'Página {current} de {total}'))
                .replace('{current}', String(currentPage))
                .replace('{total}', String(totalPages))}
            </span>
            <button
              type="button"
              disabled={isLoading || currentPage >= totalPages}
              onClick={() => onLoadPage(data?.nextPageUrl || (currentPage + 1))}
              className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] px-3 py-2 text-xs font-bold text-[var(--tl-text-primary)] disabled:opacity-40"
            >
              <span>{isEn ? 'Next' : 'Próxima'}</span>
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {currentPage < totalPages && (
            <button
              type="button"
              data-thread-latest-page
              disabled={isLoading}
              onClick={() => onLoadPage(totalPages)}
              className="inline-flex min-h-11 items-center rounded-xl bg-[var(--tl-accent-soft)] border border-[var(--tl-accent-border)] px-3.5 py-2 text-xs font-bold text-[var(--tl-accent-text-strong)] hover:bg-[var(--tl-accent-soft-hover)]"
            >
              {tBrowse.latestPage || (isEn ? 'Latest page' : 'Última página')} ({totalPages})
            </button>
          )}
        </div>
      )}
    </section>
  );
};
