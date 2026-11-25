import type { TimelinePlatform, TimelinePost } from './timelineModel';
import { getDynamicSource, getDynamicSourceLabel } from './timelineSourceCapabilities';

export type TimelineSource = 'all' | TimelinePlatform;
export type CatalogMode = 'recent' | 'recommended' | 'posts' | 'photos' | 'reels' |
  'videos' | 'shorts' | 'playlists' | 'community' | 'albums' | 'gifs' | 'popular';

export const TIMELINE_SOURCES: Record<string, { en: string; pt: string }> = {
  all: { en: 'All', pt: 'Tudo' },
  x: { en: 'X', pt: 'X' },
  youtube: { en: 'YouTube', pt: 'YouTube' },
  pinterest: { en: 'Pinterest', pt: 'Pinterest' },
  imgur: { en: 'Imgur', pt: 'Imgur' },
  generic: { en: 'Other sources', pt: 'Outras fontes' },
};

export function getTimelineSourceDisplayName(
  source: TimelineSource,
  lang: 'en' | 'pt' = 'en'
): string {
  const staticLabel = TIMELINE_SOURCES[source];
  if (staticLabel) return staticLabel[lang];
  return getDynamicSourceLabel(source) || String(source).toUpperCase();
}

export const CATALOG_MODE_LABELS: Record<CatalogMode, { en: string; pt: string }> = {
  recent: { en: 'Recent', pt: 'Recentes' },
  recommended: { en: 'For you', pt: 'Para você' },
  posts: { en: 'Posts', pt: 'Publicações' },
  photos: { en: 'Photos', pt: 'Fotos' },
  reels: { en: 'Reels', pt: 'Reels' },
  videos: { en: 'Videos', pt: 'Vídeos' },
  shorts: { en: 'Shorts', pt: 'Shorts' },
  playlists: { en: 'Playlists', pt: 'Playlists' },
  community: { en: 'Community', pt: 'Comunidade' },
  albums: { en: 'Albums', pt: 'Álbuns' },
  gifs: { en: 'GIFs', pt: 'GIFs' },
  popular: { en: 'Most viewed', pt: 'Mais vistos' },
};

export function catalogModes(source: TimelineSource): readonly CatalogMode[] {
  const dynamic = source !== 'all' ? getDynamicSource(source) : undefined;
  if (dynamic && dynamic.categories.length > 0) {
    return dynamic.categories as CatalogMode[];
  }
  switch (source) {
    case 'all': return ['recent', 'recommended'];
    case 'x': return [];
    case 'youtube': return ['recent', 'videos', 'shorts', 'playlists', 'community', 'popular'];
    case 'pinterest': return ['recent', 'photos', 'videos', 'popular'];
    case 'imgur': return ['recent', 'albums', 'gifs', 'videos', 'popular'];
    default: return ['recent', 'videos', 'albums', 'popular'];
  }
}

export function matchesCatalogMode(post: TimelinePost, mode: CatalogMode): boolean {
  const url = post.originalUrl || post.sourcePage || '';
  switch (mode) {
    case 'reels': return /\/(?:reel|reels)\//i.test(url);
    case 'shorts': return Boolean(post.isShort) || /\/shorts\//i.test(url);
    case 'photos': return post.mediaType === 'photo' || post.type === 'album' || post.type === 'photo_grid' || Boolean(post.photos?.length);
    case 'videos': return post.type === 'video' && !post.isShort && !/\/(?:shorts|reels?)\//i.test(url);
    case 'playlists': return post.type === 'playlist';
    case 'community': return /\/(?:post|community)\//i.test(url);
    case 'albums': return post.type === 'album' || post.type === 'photo_grid';
    case 'gifs': return post.type === 'gif' || post.mediaType === 'gif';
    default: return true;
  }
}

export function sourceViewCount(post: TimelinePost): number {
  const count = post.metrics?.views;
  if (count != null && Number.isFinite(count)) return count;
  const label = String(post.views ?? '').trim().toLowerCase();
  const abbreviated = label.match(/^([\d]+(?:[.,]\d+)?)\s*(k|m|b|mil|mi|bi|milhão|milhões)(?:\b|$)/);
  if (abbreviated) {
    const factor = abbreviated[2] === 'k' || abbreviated[2] === 'mil' ? 1_000
      : abbreviated[2] === 'b' || abbreviated[2] === 'bi' ? 1_000_000_000 : 1_000_000;
    return Number(abbreviated[1].replace(',', '.')) * factor;
  }
  const integer = label.match(/^(\d{1,3}(?:[,.\s]\d{3})+|\d+)(?:\b|$)/);
  return integer ? Number(integer[1].replace(/[,.\s]/g, '')) : -1;
}
