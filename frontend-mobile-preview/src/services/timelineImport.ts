import {
  isTimelineDataPayload, resolveTimelinePlatform, sortTimelinePostsByPublication, timelinePostSourceKey,
  type TimelineCreator, type TimelineDataPayload, type TimelinePost, type TimelinePostRelation, type TimelineSocialMetrics,
} from '../components/profile-hub/timeline/timelineModel';

const MAX_EXPORT_CHARS = 4 * 1024 * 1024;
const MAX_ENTRIES = 2500;
const MAX_CREATORS = 250;
const MARKER = 'user_supplied_export' as const;
type OfflinePost = TimelinePost & { readonly importProvenance: typeof MARKER };

export interface TimelineExportPage {
  readonly creators: readonly TimelineCreator[];
  readonly posts: readonly OfflinePost[];
  readonly skipped: number;
  readonly completeness: 'unknown';
}

export interface TimelineExportMerge extends TimelineDataPayload {
  added: number;
  updated: number;
  duplicates: number;
  skipped: number;
  completeness: 'unknown';
}

export class TimelineExportError extends Error {
  constructor(readonly code: 'invalid_format' | 'too_large') { super(code); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
}

function cleanUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    // Permalinks only, without signed queries or fragment-based app state.
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
        || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname)
        || /^\d+(?:\.\d+){3}$/.test(url.hostname)
        || /(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

function date(value: unknown) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
      || !Number.isFinite(Date.parse(value))) return undefined;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day ? value : undefined;
}

function count(...values: unknown[]) {
  for (const v of values) if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  return null;
}

function metrics(raw: Record<string, unknown>): TimelineSocialMetrics {
  const official = record(raw.metrics) ?? {};
  const lab = record(raw.engagementMetrics) ?? {};
  return {
    likes: count(official.likes, lab.likes, raw.likes),
    replies: count(official.replies, lab.replies, raw.replyCount),
    reposts: count(official.reposts, lab.reposts, raw.repostCount),
    quotes: count(official.quotes, lab.quotes, raw.quoteCount),
    views: count(official.views, lab.views, raw.viewCount),
  };
}

function relation(value: unknown): TimelinePostRelation | undefined {
  const raw = record(value);
  if (!raw || (raw.kind !== 'quote' && raw.kind !== 'reply' && raw.kind !== 'repost')) return undefined;
  const data = record(raw.post);
  if (!data) return {kind: raw.kind};
  return {kind: raw.kind, post: {
    creatorName: text(data.creatorName, 160) || undefined,
    creatorHandle: text(data.creatorHandle, 160) || undefined,
    text: text(data.text, 10000) || undefined,
    originalUrl: cleanUrl(data.originalUrl),
  }};
}

function creatorKey(url: string) {
  const parsed = new URL(url);
  // Reuse platform recognition. Equal URLs are sufficient for other sources;
  // no guessed name, copyright, lookalike, or follower-list equivalence.
  const platform = resolveTimelinePlatform(url);
  const isSocialAlias = platform === 'x' || platform === 'instagram';
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  return isSocialAlias ? `${platform}:${path.toLowerCase()}` : `${parsed.origin}${path}`;
}

function sourceId(kind: 'creator' | 'post', key: string) {
  return `import-${kind}-${encodeURIComponent(key)}`;
}

export function isOfflineTimelinePost(value: TimelinePost): value is OfflinePost {
  return (value as Partial<OfflinePost>).importProvenance === MARKER;
}

/** Read an existing export selected by the person, with no network or storage operations. */
export function parseTimelineExport(jsonText: string): TimelineExportPage {
  if (typeof jsonText !== 'string') throw new TimelineExportError('invalid_format');
  if (jsonText.length > MAX_EXPORT_CHARS) throw new TimelineExportError('too_large');
  let payload: Record<string, unknown> | undefined;
  try { payload = record(JSON.parse(jsonText.replace(/^\uFEFF/, ''))); }
  catch { throw new TimelineExportError('invalid_format'); }
  if (!payload || !Array.isArray(payload.creators) || !Array.isArray(payload.posts)) throw new TimelineExportError('invalid_format');
  if (payload.creators.length > MAX_CREATORS || payload.posts.length > MAX_ENTRIES) throw new TimelineExportError('too_large');

  const creators = new Map<string, TimelineCreator>();
  const byOriginalId = new Map<string, TimelineCreator>();
  for (const raw of payload.creators) {
    const row = record(raw);
    const url = cleanUrl(row?.profileUrl);
    const originalId = text(row?.id, 256);
    const name = text(row?.name, 160) || text(row?.handle, 160);
    if (!url || !originalId || !name) continue;
    const key = creatorKey(url);
    const normalized: TimelineCreator = creators.get(key) ?? {
      id: sourceId('creator', key), name, handle: text(row?.handle, 160), avatar: '',
      site: resolveTimelinePlatform(url) || 'generic', profileUrl: url, verified: false, stats: {},
    };
    creators.set(key, normalized);
    if (!byOriginalId.has(originalId)) byOriginalId.set(originalId, normalized);
  }

  const posts: OfflinePost[] = [];
  let skipped = 0;
  for (const raw of payload.posts) {
    const row = record(raw);
    const url = cleanUrl(row?.originalUrl);
    const owner = byOriginalId.get(text(row?.creatorId, 256));
    if (!row || !url || !owner) { skipped++; continue; }
    const key = timelinePostSourceKey(url);
    const postRelation = relation(row.relation);
    const body = text(row.text, 10000) || text(row.caption, 10000)
      || (row.type === 'text' ? text(row.title, 10000) : '');
    if (!key || (!body && !postRelation)) { skipped++; continue; }
    const counts = metrics(row);
    posts.push({
      id: sourceId('post', key), creatorId: owner.id, creatorName: owner.name,
      creatorHandle: owner.handle, creatorAvatar: '', type: 'text', source: owner.site,
      originalUrl: url, title: '', text: body || undefined, relation: postRelation, metrics: counts,
      likes: counts.likes ?? null, comments: [], date: date(row.date) || '',
      dateObservedAt: date(row.dateObservedAt), importProvenance: MARKER,
    });
  }
  const activeAuthors = new Set(posts.map(post => post.creatorId));
  const result = {creators: [...creators.values()].filter(creator => activeAuthors.has(creator.id)),
    posts, skipped, completeness: 'unknown' as const};
  if (!isTimelineDataPayload(result)) throw new TimelineExportError('invalid_format');
  return result;
}

function comparable(url?: string) {
  return url ? timelinePostSourceKey(url) : '';
}

function richerPost(old: OfflinePost, incoming: OfflinePost): OfflinePost {
  // Prefer genuinely newer observations. A missing timestamp does not
  // overwrite previously collected text; it may only fill a missing field.
  const observed = Date.parse(incoming.dateObservedAt || '');
  const previous = Date.parse(old.dateObservedAt || '');
  const mayUpdate = Number.isFinite(observed) && (!Number.isFinite(previous) || observed > previous);
  const pick = <T,>(was: T | null | undefined, now: T | null | undefined) =>
    mayUpdate && now != null ? now : was ?? now ?? undefined;
  const combined = {...old};
  combined.text = pick(old.text, incoming.text);
  combined.relation = pick(old.relation, incoming.relation);
  combined.date = pick(old.date || undefined, incoming.date || undefined) || '';
  combined.dateObservedAt = pick(old.dateObservedAt, incoming.dateObservedAt);
  const counts: TimelineSocialMetrics = {};
  for (const key of ['likes', 'replies', 'reposts', 'quotes', 'views'] as const) {
    counts[key] = pick(old.metrics?.[key], incoming.metrics?.[key]) ?? null;
  }
  combined.metrics = counts;
  combined.likes = counts.likes ?? null;
  return combined;
}

/** Merge pages without replacing the user's live catalog, known metadata, IDs, or interactions. */
export function mergeTimelineExportPages(base: TimelineDataPayload, pages: readonly TimelineExportPage[]): TimelineExportMerge {
  const creators = new Map(base.creators.map(item => [item.id, item]));
  const authorByUrl = new Map<string, TimelineCreator>();
  for (const item of base.creators) {
    try { authorByUrl.set(creatorKey(item.profileUrl), item); } catch { /* preserve existing catalog */ }
  }
  const posts = new Map(base.posts.map(item => [item.id, item]));
  const byUrl = new Map<string, TimelinePost>();
  for (const item of base.posts) {
    const key = comparable(item.originalUrl);
    if (key && (!byUrl.has(key) || !isOfflineTimelinePost(item))) byUrl.set(key, item);
  }
  let added = 0, updated = 0, duplicates = 0, skipped = 0;
  const addedCreatorIds = new Set<string>();
  for (const page of pages) {
    skipped += page.skipped;
    const pageAuthors = new Map(page.creators.map(item => [item.id, item]));
    for (const incoming of page.posts) {
      const source = comparable(incoming.originalUrl);
      const prior = byUrl.get(source);
      if (prior) {
        duplicates++;
        // A text-only offline snapshot must not displace a richer native card.
        if (!isOfflineTimelinePost(prior)) continue;
        const merged = richerPost(prior, incoming);
        if (JSON.stringify(merged) !== JSON.stringify(prior)) { posts.set(prior.id, merged); byUrl.set(source, merged); updated++; }
        continue;
      }
      const importedAuthor = pageAuthors.get(incoming.creatorId);
      if (!source || !importedAuthor) { skipped++; continue; }
      const key = creatorKey(importedAuthor.profileUrl);
      const author = authorByUrl.get(key) || importedAuthor;
      if (author.id === importedAuthor.id && !authorByUrl.has(key)) {
        if (creators.has(author.id)) { skipped++; continue; }
        creators.set(author.id, author);
        addedCreatorIds.add(author.id);
        authorByUrl.set(key, author);
      }
      if (posts.has(incoming.id)) { skipped++; continue; }
      const post = {...incoming, creatorId: author.id};
      posts.set(post.id, post); byUrl.set(source, post); added++;
    }
  }
  const activeCreatorIds = new Set([...posts.values()].map(post => post.creatorId));
  return {creators: [...creators.values()].filter(creator => !addedCreatorIds.has(creator.id) || activeCreatorIds.has(creator.id)),
    posts: sortTimelinePostsByPublication([...posts.values()]), comments: base.comments,
    added, updated, duplicates, skipped, completeness: 'unknown'};
}
