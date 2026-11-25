import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Repeat2 } from 'lucide-react';
import type { TimelinePostRelation, TimelineSocialMetrics } from './timelineModel';

const arrowClass = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--tl-text-primary)] hover:bg-[var(--tl-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--tl-accent)] disabled:opacity-35';
const textClass = 'tl-post-copy';

function safeSourceLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function TimelineSocialCarousel({ images, previews, sourceUrl, isEn, onOpen }: {
  images: string[];
  previews?: string[];
  sourceUrl?: string;
  isEn: boolean;
  onOpen: (index: number) => void;
}) {
  const [position, setPosition] = useState(0);
  const [failedUrl, setFailedUrl] = useState<string>();
  const [proxyingUrl, setProxyingUrl] = useState<string>();
  if (!images.length) return null;
  const index = Math.min(position, images.length - 1);
  const src = previews?.[index] || images[index];
  const direct = safeSourceLink(src);
  const proxy = direct && proxyingUrl === src
    ? `/api/proxy-image?url=${encodeURIComponent(direct)}&referer=${encodeURIComponent(safeSourceLink(sourceUrl) || direct)}`
    : undefined;
  const previewUrl = proxy || direct || (/^\/(?!\/)/.test(src) ? src : undefined);
  const label = isEn ? `Photo ${index + 1} of ${images.length}` : `Foto ${index + 1} de ${images.length}`;
  const move = (delta: number) => setPosition(value => Math.max(0, Math.min(value + delta, images.length - 1)));
  return <section className="tl-post-media"
    aria-label={isEn ? 'Post media' : 'Mídia da publicação'} data-social-carousel
    onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        move(event.key === 'ArrowLeft' ? -1 : 1);
      }
    }}>
    <button type="button" className="tl-post-frame block w-full focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--tl-accent)]"
      aria-label={isEn ? `Open ${label}` : `Abrir ${label}`} onClick={() => onOpen(index)}>
      {failedUrl === src || !previewUrl ? <span className="text-sm text-white" role="status">{isEn ? 'Photo unavailable' : 'Foto indisponível'}</span>
        : <img key={previewUrl} src={previewUrl} alt={label} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => {
          if (direct && proxyingUrl !== src) setProxyingUrl(src);
          else setFailedUrl(src);
        }}
          className="h-full w-full object-contain" />}
    </button>
    {images.length > 1 && <div className="tl-post-carousel-controls">
      <button type="button" className={arrowClass} aria-label={isEn ? 'Previous photo' : 'Foto anterior'}
        disabled={index === 0} onClick={() => move(-1)}><ChevronLeft aria-hidden="true" className="h-4 w-4" /></button>
      <span aria-live="polite" aria-atomic="true">{label}</span>
      <button type="button" className={arrowClass} aria-label={isEn ? 'Next photo' : 'Próxima foto'}
        disabled={index === images.length - 1} onClick={() => move(1)}><ChevronRight aria-hidden="true" className="h-4 w-4" /></button>
    </div>}
  </section>;
}

export function TimelineSocialBody({ text, relation, isEn, onOpenReferencedMedia }: {
  text?: string;
  relation?: TimelinePostRelation;
  isEn: boolean;
  onOpenReferencedMedia: (images: string[], index: number, title: string) => void;
}) {
  const kind = relation?.kind;
  const reference = relation?.post;
  const referenceLabel = kind === 'repost' ? (isEn ? 'Reposted publication' : 'Publicação republicada')
    : kind === 'reply' ? (isEn ? 'In reply to' : 'Em resposta a') : (isEn ? 'Quoted publication' : 'Publicação citada');
  const source = safeSourceLink(reference?.originalUrl);
  const author = reference?.creatorName?.trim() || reference?.creatorHandle?.trim();
  const photos = reference?.photos?.filter(Boolean) ?? [];
  const authorAndHandle = author && reference?.creatorHandle && author !== reference.creatorHandle;
  if (!text?.trim() && !relation) return null;
  return <div className="min-w-0 space-y-2.5" data-social-body>
    {text?.trim() && <p className={textClass}>{text}</p>}
    {relation && <section aria-label={referenceLabel} data-social-relation={kind}
      className="tl-post-reference">
      <div className="flex items-center gap-1.5 text-xs text-[var(--tl-text-muted)]">
        {kind === 'repost' && <Repeat2 aria-hidden="true" className="h-4 w-4" />}
        <span>{referenceLabel}</span>
      </div>
      {author && <div className="flex flex-wrap items-center gap-x-2 text-xs [overflow-wrap:anywhere]">
        <span className="font-semibold text-[var(--tl-text-primary)]">{author}</span>
        {authorAndHandle && <span className="text-[var(--tl-text-muted)]">{reference.creatorHandle}</span>}
      </div>}
      {reference?.text?.trim() && <p className={textClass}>{reference.text}</p>}
      {photos.length > 0 && <TimelineSocialCarousel images={photos} sourceUrl={source} isEn={isEn}
        onOpen={index => onOpenReferencedMedia(photos, index, author || referenceLabel)} />}
      {!photos.length && reference?.thumbnailUrl && <div className="tl-post-media tl-post-frame max-w-sm">
        <img src={reference.thumbnailUrl} alt={isEn ? 'Source preview' : 'Prévia da origem'}
          className="h-full w-full object-contain" loading="lazy" decoding="async" />
      </div>}
      {!author && !reference?.text?.trim() && !photos.length && !reference?.thumbnailUrl &&
        <p className="text-xs text-[var(--tl-text-muted)]">{isEn ? 'Original details unavailable.' : 'Detalhes do original indisponíveis.'}</p>}
      {source && <a href={source} target="_blank" rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center gap-1.5 text-xs text-[var(--tl-accent-text)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--tl-accent)]">
        <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />{isEn ? 'Open original publication' : 'Abrir publicação original'}
      </a>}
    </section>}
  </div>;
}

export function TimelineSocialMetricsRow({ metrics = {}, isEn }: { metrics?: TimelineSocialMetrics; isEn: boolean }) {
  const labels: ReadonlyArray<[keyof TimelineSocialMetrics, string]> = [
    ['likes', isEn ? 'Likes' : 'Curtidas'],
    ['replies', isEn ? 'Replies' : 'Respostas'],
    ['reposts', isEn ? 'Reposts' : 'Republicações'],
    ['quotes', isEn ? 'Quotes' : 'Citações'],
    ['views', isEn ? 'Views' : 'Visualizações'],
  ];
  return <dl aria-label={isEn ? 'Source metrics' : 'Métricas da origem'} className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--tl-text-muted)]" data-social-source-metrics>
    {labels.filter(([key]) => key === 'likes' || key === 'replies' || metrics[key] !== undefined).map(([key, label]) =>
      <div key={key} className="flex gap-1.5"><dt>{label}</dt><dd className="font-mono" title={metrics[key] == null ? (isEn ? 'Not provided by source' : 'Não informado pela origem') : undefined}>{metrics[key] ?? '—'}</dd></div>)}
  </dl>;
}
