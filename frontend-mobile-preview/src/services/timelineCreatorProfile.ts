import {discoverProfileRoot, discoverRecentProfileRoot} from './profileHubApi';
import type {ProfileRoot} from './profileHubApi';
import {engagementSourceUrl} from './profileHubEngagement';
import {
  extractPlaylistsFromScan,
  mapScanResponseToTimelinePosts,
  mergeTimelineCreatorStats,
  resolveTimelinePlatform,
} from '../components/profile-hub/timeline/timelineModel';
import type {
  TimelineCreator,
  TimelineEntityKind,
  TimelineEntityRef,
  TimelinePost,
} from '../components/profile-hub/timeline/timelineModel';
import { getSourceCapabilities, registerDynamicOrigin } from '../components/profile-hub/timeline/timelineSourceCapabilities';

export interface TimelineCreatorProfileSnapshot {creator:TimelineCreator; posts:TimelinePost[]; incomplete?:boolean;}
interface Options {
  url:string;
  existingCreator?:TimelineCreator;
  expectedName?:string;
  seedAvatar?:string | null;
  existingPosts:TimelinePost[];
  signal:AbortSignal;
  onSnapshot?:(value:TimelineCreatorProfileSnapshot)=>void;
  unnamedLabel:string;
  page?:number;
  sort?:string;
}

/** Normalize optional performer/channel/interest link lists emitted by portal backends. */
function normalizeRichEntityList(raw: unknown): TimelineEntityRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const normalized: TimelineEntityRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) continue;
    normalized.push({
      name,
      url: typeof obj.url === 'string' && obj.url.trim() ? obj.url.trim() : undefined,
      kind: typeof obj.kind === 'string' ? (obj.kind as TimelineEntityRef['kind']) : undefined,
      count: typeof obj.count === 'number' && Number.isFinite(obj.count) ? obj.count : undefined,
      thumbnailUrl: typeof obj.thumbnailUrl === 'string' && obj.thumbnailUrl.trim() ? obj.thumbnailUrl.trim() : undefined,
      gender: typeof obj.gender === 'string' && obj.gender.trim() ? obj.gender.trim() : undefined,
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

/** Full creator catalog using the Hub scanner and the existing timeline media mappers.
 * Does not add a creator to the saved feed, change favorites, or navigate the app.
 */
export async function loadTimelineCreatorProfile(options:Options):Promise<TimelineCreatorProfileSnapshot> {
  const url=engagementSourceUrl(options.url);
  if (!url) throw new Error('Invalid creator URL');
  const previous=options.existingCreator;
  const publish=(root:ProfileRoot):TimelineCreatorProfileSnapshot => {
    if (options.signal.aborted) throw new DOMException('Cancelled','AbortError');
    const hero=root.profile_data as Record<string, any> | undefined;
    const rootAny = root as Record<string, any>;
    const resolvedSourceUrl = engagementSourceUrl(root.source_url || hero?.url || hero?.profileUrl || url);
    if (!root.profile_key || !resolvedSourceUrl) throw new Error('Invalid creator response');
    const entityKind = (hero?.entityKind || rootAny.entityKind || previous?.entityKind) as TimelineEntityKind | undefined;
    const resolvedSite = resolveTimelinePlatform(resolvedSourceUrl, hero?.site || previous?.site) || previous?.site;
    if (resolvedSite && resolvedSourceUrl) {
      registerDynamicOrigin(resolvedSourceUrl, resolvedSite);
    }
    const rawRelated = Array.isArray(rootAny.relatedEntities)
      ? rootAny.relatedEntities
      : Array.isArray(hero?.relatedEntities)
        ? hero.relatedEntities
        : undefined;
    const relatedEntities = rawRelated
      ? (rawRelated.filter((r: any) => r && typeof r.name === 'string') as TimelineEntityRef[])
      : previous?.relatedEntities;
    const featuredPerformers = normalizeRichEntityList(rootAny.featuredPerformers ?? hero?.featuredPerformers) || previous?.featuredPerformers;
    const affiliatedChannels = normalizeRichEntityList(rootAny.affiliatedChannels ?? hero?.affiliatedChannels) || previous?.affiliatedChannels;
    const interests = normalizeRichEntityList(rootAny.interests ?? hero?.interests) || previous?.interests;
    const portalInfo = (hero?.portalInfo && typeof hero.portalInfo === 'object' ? hero.portalInfo : undefined)
      || (rootAny.portalInfo && typeof rootAny.portalInfo === 'object' ? rootAny.portalInfo : undefined)
      || previous?.portalInfo;
    const rawSupportsSort = Array.isArray(rootAny.supportsSort)
      ? rootAny.supportsSort
      : Array.isArray(hero?.supportsSort)
        ? hero.supportsSort
        : undefined;
    const supportsSort = rawSupportsSort
      ? rawSupportsSort.filter((s: unknown): s is string => typeof s === 'string' && Boolean(s.trim()))
      : previous?.supportsSort;
    const activeSort = options.sort
      || (typeof rootAny.activeSort === 'string' && rootAny.activeSort.trim() ? rootAny.activeSort.trim() : undefined)
      || (typeof hero?.activeSort === 'string' && hero.activeSort.trim() ? hero.activeSort.trim() : undefined)
      || previous?.activeSort;
    const creator:TimelineCreator={
      id:previous?.id || root.profile_key,
      name:hero?.name || root.name || previous?.name || options.expectedName || options.unnamedLabel,
      handle:hero?.handle || previous?.handle || '',
      avatar:hero?.avatarUrl || previous?.avatar || options.seedAvatar || '',
      banner:hero?.bannerUrl || rootAny.bannerUrl || previous?.banner,
      site:resolvedSite,
      entityKind,
      profileUrl: previous?.profileUrl || resolvedSourceUrl,
      verified:hero?.verified ?? previous?.verified ?? false,
      stats:mergeTimelineCreatorStats(previous?.stats, hero?.stats as Record<string, unknown> | undefined, hero?.bio_details),
      bio:root.description || hero?.tagline || hero?.bio || previous?.bio,
      relatedEntities,
      portalInfo,
      featuredPerformers,
      affiliatedChannels,
      interests,
      supportsSort,
      activeSort,
      profilePage: typeof rootAny.page === 'number' ? rootAny.page : previous?.profilePage,
      profileHasMore: typeof rootAny.hasMore === 'boolean' ? rootAny.hasMore : previous?.profileHasMore,
      profileNextPage: typeof rootAny.nextPage === 'number' || rootAny.nextPage === null ? rootAny.nextPage : previous?.profileNextPage,
      profileNextPageUrl: typeof rootAny.nextPageUrl === 'string' || rootAny.nextPageUrl === null ? rootAny.nextPageUrl : previous?.profileNextPageUrl,
    };
    const playlists=extractPlaylistsFromScan(creator,root);
    creator.playlists=playlists.length ? playlists : previous?.playlists;
    const snapshot={creator,posts:mapScanResponseToTimelinePosts(creator,root,options.existingPosts),incomplete:Boolean(root.discovery_errors?.length)};
    options.onSnapshot?.(snapshot);
    return snapshot;
  };
  const targetSite = resolveTimelinePlatform(url, previous?.site);
  const caps = getSourceCapabilities(targetSite);
  if (caps.archetype === 'gallery_catalog' || caps.archetype === 'forum_board' || caps.archetype === 'video_portal') {
    const root = await discoverRecentProfileRoot(
      url,
      options.signal,
      options.expectedName,
      [],
      [],
      partial => { publish(partial); },
      options.page,
      options.sort,
    );
    return publish(root);
  }
  // Opening a creator requests their catalog; feed refresh keeps its separate recent transport.
  const root=await discoverProfileRoot(url,options.signal,partial => { publish(partial); });
  return publish(root);
}
