import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, Check, ChevronLeft, ExternalLink, Globe, MapPin, UserCheck, UserPlus } from 'lucide-react';
import { TimelineSocialBody, TimelineSocialMetricsRow } from './TimelineSocialContent';
import { TimelinePostIdentity } from './TimelinePostIdentity';
import { SourceAvatar } from '../common/SourceAvatar';
import { XMediaGrid, XRichText, formatXRelativeTime } from './XPostDetailView';
import {
  VerifiedSealIcon,
  XBookmarkSvg,
  XBrandIcon,
  XHeartSvg,
  XReplySvg,
  XRepostSvg,
  XShareSvg,
  XViewsSvg,
} from './TimelineBrandIcons';
import type { TimelineCreator, TimelinePost, TimelinePostRelation, TimelineSocialMetrics } from './timelineModel';
import type { TimelinePlaybackHandoff } from './TimelinePostCard';
import { readLiveX } from '../../../services/liveXConnector';
import { useProfileTimelineStore } from '../../../store/useProfileTimelineStore';
import { useShallow } from 'zustand/react/shallow';

export type XScope = 'recommended' | 'following' | 'explore' | 'accounts' | 'profile';
export type XTrend = {
  topic: string;
  category?: string;
  postCount?: string;
};
export type XAccount = {
  handle: string;
  name: string;
  avatar?: string;
  banner?: string;
  verified?: boolean;
  isFollowing?: boolean;
  bio?: string;
  location?: string;
  website?: string;
  joined?: string;
  followers?: string | number | null;
  following?: string | number | null;
  postsCount?: string | number | null;
};
export type XPost = XAccount & {
  id: string;
  url: string;
  date: string;
  text?: string;
  photos: string[];
  video?: string;
  poster?: string;
  hasVideo?: boolean;
  relation?: TimelinePostRelation;
  metrics: TimelineSocialMetrics;
};
type Entry = XAccount | XPost;
export type XTarget = { key: string; scope: XScope; handle?: string };
type Feed = {
  cursor: string;
  offset: number;
  items: Entry[];
  profile?: XAccount | null;
  trends?: XTrend[];
  relevantPeople?: XAccount[];
  loading: boolean;
  status?: 'ready' | 'login_required';
  error?: string;
  paused?: boolean;
};
type Batch = {
  status: Feed['status'];
  items: Entry[];
  profile?: XAccount | null;
  trends?: XTrend[];
  relevantPeople?: XAccount[];
};

const buttonClass =
  'inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-[var(--tl-text-secondary)] hover:bg-[var(--tl-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--tl-accent)] disabled:opacity-50';
const identity = (item: Entry) => ('id' in item ? item.id : item.handle.toLowerCase());

const REPOST_STORAGE_KEY = 'imagex_x_reposts_v1';

function readStoredReposts(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(REPOST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeStoredReposts(map: Record<string, boolean>) {
  try {
    localStorage.setItem(REPOST_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota errors
  }
}

export function formatCompactCount(val: string | number | null | undefined): string {
  if (val === null || val === undefined || val === '') return '—';
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return '—';
    if (!/^\d+$/.test(trimmed)) return trimmed;
    val = Number(trimmed);
  }
  if (!Number.isFinite(val)) return '—';
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (val >= 10_000) return `${(val / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  if (val >= 1_000) return val.toLocaleString();
  return String(val);
}

function newFeed(items: Entry[] = [], profile?: XAccount | null): Feed {
  // LAN HTTP origins don't expose crypto.randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const cursor = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { cursor, offset: 0, items, profile: profile ?? null, loading: false };
}

export function useTimelineX(target: XTarget, active: boolean) {
  const dedicatedBrowser = useRef(false);
  const [feeds, setFeeds] = useState<Record<string, Feed>>({});
  const cache = useRef<Record<string, Feed>>({});
  const controllers = useRef(new Map<string, AbortController>());
  const enrichedIdsRef = useRef(new Set<string>());
  const feed = feeds[target.key];

  const update = useCallback((key: string, entry: Feed) => {
    cache.current[key] = entry;
    setFeeds(current => ({ ...current, [key]: entry }));
  }, []);

  const enrichFeedInBackground = useCallback(
    async (key: string, destination: XTarget, items: Entry[], signal: AbortSignal) => {
      try {
        const unenrichedTweets: Array<{ id: string; handle: string }> = [];
        const handlesToEnrich = new Set<string>();

        if (destination.scope === 'profile' && destination.handle) {
          handlesToEnrich.add(destination.handle.replace(/^@/, ''));
        }

        for (const item of items) {
          const cleanH = item.handle.replace(/^@/, '');
          if ('id' in item) {
            const needsTweetEnrich =
              !item.avatar ||
              item.metrics.reposts == null ||
              (item.hasVideo && !item.video);
            if (!enrichedIdsRef.current.has(item.id) && needsTweetEnrich) {
              unenrichedTweets.push({ id: item.id, handle: cleanH });
            } else if (!item.avatar && cleanH) {
              handlesToEnrich.add(cleanH);
            }
          } else if (!item.avatar && cleanH) {
            handlesToEnrich.add(cleanH);
          }
        }

        if (unenrichedTweets.length === 0 && handlesToEnrich.size === 0) return;

        for (const t of unenrichedTweets) enrichedIdsRef.current.add(t.id);

        const resp = await fetch('/api/profile-hub/timeline/x-batch-enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: unenrichedTweets.slice(0, 20),
            handles: Array.from(handlesToEnrich).slice(0, 16),
          }),
          signal,
        });
        if (!resp.ok || signal.aborted) return;
        const data = await resp.json();
        if (!data?.ok || signal.aborted) return;

        const tweetsMap: Record<string, any> = data.tweets || {};
        const profilesMap: Record<string, any> = data.profiles || {};

        const current = cache.current[key];
        if (!current) return;

        let changed = false;
        const nextItems = current.items.map(item => {
          const hKey = item.handle.replace(/^@/, '').toLowerCase();
          const prof = profilesMap[hKey];
          if ('id' in item) {
            const tw = tweetsMap[item.id];
            if (!tw && !prof) return item;
            changed = true;
            return {
              ...item,
              name: item.name || tw?.name || prof?.name || item.handle,
              avatar: item.avatar || tw?.avatar || prof?.avatar || undefined,
              banner: item.banner || tw?.banner || prof?.banner || undefined,
              verified: item.verified ?? tw?.verified ?? prof?.verified ?? false,
              bio: item.bio || tw?.bio || prof?.bio || undefined,
              followers: item.followers ?? tw?.followers ?? prof?.followers ?? null,
              following: item.following ?? tw?.following ?? prof?.following ?? null,
              photos: item.photos.length > 0 ? item.photos : (Array.isArray(tw?.photos) ? tw.photos : []),
              video: item.video || tw?.video || undefined,
              poster: item.poster || tw?.poster || undefined,
              hasVideo: Boolean(item.hasVideo || tw?.hasVideo || tw?.video),
              metrics: {
                replies: item.metrics.replies ?? tw?.metrics?.replies,
                reposts: item.metrics.reposts ?? tw?.metrics?.reposts,
                likes: item.metrics.likes ?? tw?.metrics?.likes,
                views: item.metrics.views ?? tw?.metrics?.views,
                quotes: item.metrics.quotes,
              },
            };
          } else {
            if (!prof) return item;
            changed = true;
            return {
              ...item,
              name: item.name || prof.name || item.handle,
              avatar: item.avatar || prof.avatar || undefined,
              banner: item.banner || prof.banner || undefined,
              verified: item.verified ?? prof.verified ?? false,
              bio: item.bio || prof.bio || undefined,
              location: item.location || prof.location || undefined,
              website: item.website || prof.website || undefined,
              joined: item.joined || prof.joined || undefined,
              followers: item.followers ?? prof.followers ?? null,
              following: item.following ?? prof.following ?? null,
              postsCount: item.postsCount ?? prof.postsCount ?? null,
            };
          }
        });

        let nextProfile = current.profile;
        if (destination.scope === 'profile' && destination.handle) {
          const pKey = destination.handle.replace(/^@/, '').toLowerCase();
          const enrichedProf = profilesMap[pKey];
          if (enrichedProf) {
            changed = true;
            nextProfile = {
              handle: destination.handle.replace(/^@/, ''),
              name: current.profile?.name || enrichedProf.name || destination.handle,
              avatar: current.profile?.avatar || enrichedProf.avatar || undefined,
              banner: current.profile?.banner || enrichedProf.banner || undefined,
              verified: current.profile?.verified ?? enrichedProf.verified ?? false,
              bio: current.profile?.bio || enrichedProf.bio || undefined,
              location: current.profile?.location || enrichedProf.location || undefined,
              website: current.profile?.website || enrichedProf.website || undefined,
              joined: current.profile?.joined || enrichedProf.joined || undefined,
              followers: current.profile?.followers ?? enrichedProf.followers ?? null,
              following: current.profile?.following ?? enrichedProf.following ?? null,
              postsCount: current.profile?.postsCount ?? enrichedProf.postsCount ?? null,
            };
          }
        }

        if (changed) {
          update(key, {
            ...current,
            items: nextItems,
            profile: nextProfile,
          });
        }
      } catch {
        // Offline / fixture mode: keep DOM items as-is
      }
    },
    [update]
  );

  const load = useCallback(
    async (destination: XTarget, reset = false, connect = false) => {
      if (connect) dedicatedBrowser.current = true;
      const existing = cache.current[destination.key];
      if (existing?.loading && !reset) return;
      controllers.current.get(destination.key)?.abort();
      const controller = new AbortController();
      controllers.current.set(destination.key, controller);
      const restart = reset || existing?.error === 'cursor_expired' || existing?.error === 'cursor_mismatch';
      const current = (restart ? newFeed(existing?.items, existing?.profile) : existing) ?? newFeed();
      update(destination.key, { ...current, loading: true, error: undefined });
      const cleanDestHandle = destination.handle?.trim().replace(/^@+/, '') || undefined;

      // Immediately fetch full X profile metadata in parallel so banner/bio/following/followers
      // populate in ~250ms instead of waiting on background tab hydration.
      if (destination.scope === 'profile' && cleanDestHandle && current.offset === 0) {
        void fetch(`/api/profile-hub/timeline/x-profile-info?handle=${encodeURIComponent(cleanDestHandle)}`, {
          signal: controller.signal,
        })
          .then(r => (r.ok ? r.json() : null))
          .then(data => {
            if (controller.signal.aborted || !data?.ok || !data.profile) return;
            const latest = cache.current[destination.key];
            if (!latest) return;
            const ep = data.profile as XAccount;
            const merged: XAccount = {
              handle: cleanDestHandle,
              name: latest.profile?.name || ep.name || cleanDestHandle,
              avatar: latest.profile?.avatar || ep.avatar || undefined,
              banner: latest.profile?.banner || ep.banner || undefined,
              verified: Boolean(latest.profile?.verified ?? ep.verified),
              isFollowing: latest.profile?.isFollowing ?? ep.isFollowing,
              bio: latest.profile?.bio || ep.bio || undefined,
              location: latest.profile?.location || ep.location || undefined,
              website: latest.profile?.website || ep.website || undefined,
              joined: latest.profile?.joined || ep.joined || undefined,
              followers: latest.profile?.followers ?? ep.followers ?? null,
              following: latest.profile?.following ?? ep.following ?? null,
              postsCount: latest.profile?.postsCount ?? ep.postsCount ?? null,
            };
            update(destination.key, { ...latest, profile: merged });
          })
          .catch(() => {});
      }

      try {
        const body = await readLiveX(
          current.offset,
          {
            cursor: current.cursor,
            scope: destination.scope,
            handle: cleanDestHandle,
          },
          controller.signal,
          dedicatedBrowser.current
        );
        if (controller.signal.aborted) return;
        const batch = body as Batch;
        const latestNow = cache.current[destination.key] || current;
        if (batch.status === 'login_required') {
          update(destination.key, { ...latestNow, loading: false, status: batch.status, error: undefined });
          return;
        }
        const previous = current.offset ? latestNow.items : [];
        const seen = new Set(previous.map(identity));
        const additions = batch.items.filter(item => {
          const key = identity(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const mergedItems = [...previous, ...additions];
        const bp = batch.profile;
        const lp = latestNow.profile;
        const mergedProfile: XAccount | null =
          bp || lp
            ? {
                handle: (bp?.handle || lp?.handle || cleanDestHandle || '').replace(/^@/, ''),
                name: bp?.name || lp?.name || cleanDestHandle || '',
                avatar: bp?.avatar || lp?.avatar || undefined,
                banner: bp?.banner || lp?.banner || undefined,
                verified: Boolean(bp?.verified ?? lp?.verified),
                isFollowing: bp?.isFollowing ?? lp?.isFollowing,
                bio: bp?.bio || lp?.bio || undefined,
                location: bp?.location || lp?.location || undefined,
                website: bp?.website || lp?.website || undefined,
                joined: bp?.joined || lp?.joined || undefined,
                followers: bp?.followers ?? lp?.followers ?? null,
                following: bp?.following ?? lp?.following ?? null,
                postsCount: bp?.postsCount ?? lp?.postsCount ?? null,
              }
            : null;
        const mergedTrends =
          Array.isArray(batch.trends) && batch.trends.length > 0 ? batch.trends : latestNow.trends;
        const mergedRelevant =
          Array.isArray(batch.relevantPeople) && batch.relevantPeople.length > 0
            ? batch.relevantPeople
            : latestNow.relevantPeople;
        update(destination.key, {
          ...latestNow,
          status: 'ready',
          error: undefined,
          offset: current.offset + 1,
          items: mergedItems,
          profile: mergedProfile,
          trends: mergedTrends,
          relevantPeople: mergedRelevant,
          loading: false,
          paused: additions.length === 0,
        });
        void enrichFeedInBackground(destination.key, destination, mergedItems, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          const latestNow = cache.current[destination.key] || current;
          update(destination.key, {
            ...latestNow,
            loading: false,
            error: error instanceof Error ? error.message : 'source_unavailable',
          });
          if (destination.scope === 'profile' && destination.handle) {
            void enrichFeedInBackground(destination.key, destination, latestNow.items, controller.signal);
          }
        }
      } finally {
        if (controllers.current.get(destination.key) === controller) controllers.current.delete(destination.key);
      }
    },
    [update, enrichFeedInBackground]
  );

  useEffect(() => {
    if (active && !cache.current[target.key]) void load(target);
  }, [active, target, load]);

  useEffect(() => {
    // X can render the Following shell before the first account cards arrive.
    if (
      active &&
      target.scope === 'accounts' &&
      feed?.status === 'ready' &&
      feed.offset === 1 &&
      !feed.items.length &&
      !feed.loading &&
      !feed.error
    ) {
      void load(target);
    }
  }, [active, feed, load, target]);

  useEffect(() => {
    const pending = controllers.current;
    return () => {
      for (const [key, controller] of pending) {
        controller.abort();
        // React's development effect replay will start requests again.
        delete cache.current[key];
      }
      pending.clear();
    };
  }, []);

  const xFollowedHandles = useMemo(() => {
    const handles = new Set<string>();
    const addHandle = (raw?: string) => {
      const clean = (raw || '').replace(/^@/, '').trim().toLowerCase();
      if (clean) handles.add(clean);
    };
    for (const item of feeds.accounts?.items ?? []) {
      addHandle(item.handle);
    }
    for (const item of feeds.following?.items ?? []) {
      addHandle(item.handle);
    }
    for (const f of Object.values(feeds)) {
      if (f?.profile?.isFollowing) addHandle(f.profile.handle);
      for (const item of f?.items ?? []) {
        if (item.isFollowing) addHandle(item.handle);
      }
    }
    return handles;
  }, [feeds]);

  return { feed, accounts: feeds.accounts?.items ?? [], xFollowedHandles, load };
}

function formatXJoinedDate(raw: string, isEn: boolean): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withoutPrefix = trimmed.replace(/^(?:Joined|Entrou em)\s+/i, '').trim();
  const parsed = Date.parse(withoutPrefix);
  if (
    Number.isFinite(parsed) &&
    (/\d{2}:\d{2}:\d{2}/.test(withoutPrefix) ||
      /[+-]\d{4}/.test(withoutPrefix) ||
      /^\d{4}-\d{2}-\d{2}/.test(withoutPrefix))
  ) {
    const d = new Date(parsed);
    const formatted = d.toLocaleDateString(isEn ? 'en-US' : 'pt-BR', {
      month: 'long',
      year: 'numeric',
    });
    return `${isEn ? 'Joined' : 'Entrou em'} ${formatted}`;
  }
  return `${isEn ? 'Joined' : 'Entrou em'} ${withoutPrefix}`;
}

export function XProfileHeaderCard({
  account,
  profileData,
  isFollowedOnX,
  postsCount,
  mediaCount,
  mode,
  onSelectMode,
  onBack,
  isEn,
  onOpenAvatar,
}: {
  account: XAccount;
  profileData?: XAccount | null;
  isFollowedOnX?: boolean;
  postsCount: number;
  mediaCount: number;
  mode: 'posts' | 'media';
  onSelectMode: (mode: 'posts' | 'media') => void;
  onBack: () => void;
  isEn: boolean;
  onOpenAvatar?: (url: string, title: string) => void;
}) {
  const [bannerError, setBannerError] = useState(false);
  const cleanHandle = (profileData?.handle || account.handle || '').replace(/^@/, '');
  const displayName = profileData?.name || account.name || cleanHandle;
  const avatarUrl = profileData?.avatar || account.avatar || '';
  const bannerUrl = !bannerError ? (profileData?.banner || account.banner || '') : '';
  const bio = profileData?.bio || account.bio || '';
  const location = profileData?.location || account.location || '';
  const website = profileData?.website || account.website || '';
  const joined = profileData?.joined || account.joined || '';
  const followers = profileData?.followers ?? account.followers;
  const following = profileData?.following ?? account.following;
  const totalPosts = profileData?.postsCount ?? account.postsCount ?? (postsCount > 0 ? postsCount : null);
  const verified = Boolean(profileData?.verified ?? account.verified);
  const profileUrl = `https://x.com/${encodeURIComponent(cleanHandle)}`;
  const creatorId = `x:${cleanHandle.toLowerCase()}`;

  const { isFollowed, toggleFollowCreator } = useProfileTimelineStore(
    useShallow(state => ({
      isFollowed: Boolean(
        state.followedCreatorIds[creatorId] ||
          state.creators.some(c => c.profileUrl?.toLowerCase().includes(`x.com/${cleanHandle.toLowerCase()}`))
      ),
      toggleFollowCreator: state.toggleFollowCreator,
    }))
  );
  const followingOnX = Boolean(isFollowedOnX || profileData?.isFollowing || account.isFollowing);
  const effectiveFollowed = followingOnX || isFollowed;

  const handleToggleFollow = () => {
    const snapshot: TimelineCreator = {
      id: creatorId,
      name: displayName,
      handle: `@${cleanHandle}`,
      avatar: avatarUrl,
      banner: bannerUrl || undefined,
      profileUrl,
      site: 'x',
      verified,
      bio: bio || undefined,
      stats: {
        followers: followers != null ? String(followers) : undefined,
        posts: typeof totalPosts === 'number' ? totalPosts : undefined,
      },
    };
    toggleFollowCreator(snapshot);
  };

  return (
    <section className="tl-x-profile-card" aria-label={`${displayName} (@${cleanHandle})`}>
      {/* Top bar with Back button + Title + Post count */}
      <div className="tl-x-profile-topbar">
        <button type="button" onClick={onBack} className="tl-x-profile-back-btn">
          <ChevronLeft aria-hidden size={18} />
          <span>{isEn ? 'Back' : 'Voltar'}</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-base font-bold text-[var(--tl-text-primary)]">{displayName}</h2>
            {verified && <VerifiedSealIcon size={16} className="shrink-0 text-[#1d9bf0]" />}
          </div>
          <p className="text-xs text-[var(--tl-text-muted)]">
            {totalPosts != null
              ? `${formatCompactCount(totalPosts)} ${isEn ? 'posts' : 'publicações'}`
              : `@${cleanHandle}`}
          </p>
        </div>
        <a
          href={profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="tl-x-profile-ext-btn"
        >
          <XBrandIcon size={13} />
          <span>{isEn ? 'View on X' : 'Ver no X'}</span>
          <ExternalLink aria-hidden size={12} />
        </a>
      </div>

      {/* Hero Banner */}
      <div className="tl-x-profile-banner">
        {bannerUrl ? (
          <img
            src={bannerUrl}
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setBannerError(true)}
          />
        ) : (
          <div className="tl-x-profile-banner-fallback">
            <XBrandIcon size={42} className="text-white/10" />
          </div>
        )}
      </div>

      {/* Profile Identity & Actions */}
      <div className="tl-x-profile-body">
        <div className="tl-x-profile-avatar-row">
          <button
            type="button"
            className="tl-x-profile-avatar-wrap"
            onClick={() => avatarUrl && onOpenAvatar?.(avatarUrl, displayName)}
            disabled={!avatarUrl}
            aria-label={displayName}
          >
            <SourceAvatar
              name={displayName}
              src={avatarUrl || null}
              profileUrl={profileUrl}
              referer={profileUrl}
              hydrate
              alt={displayName}
              className="h-full w-full object-cover"
            />
          </button>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              type="button"
              onClick={handleToggleFollow}
              aria-pressed={effectiveFollowed}
              title={
                followingOnX
                  ? isEn
                    ? isFollowed
                      ? 'Following on X & saved in ImageX'
                      : 'Following on X · Click to also save in ImageX'
                    : isFollowed
                      ? 'Seguindo no X e salvo no ImageX'
                      : 'Seguindo no X · Clique para salvar no ImageX'
                  : undefined
              }
              className={`tl-x-follow-btn ${effectiveFollowed ? 'is-following' : ''}`}
            >
              {effectiveFollowed ? <UserCheck size={15} /> : <UserPlus size={15} />}
              <span>
                {effectiveFollowed
                  ? isEn
                    ? 'Following'
                    : 'Seguindo'
                  : isEn
                    ? 'Follow'
                    : 'Seguir'}
              </span>
            </button>
          </div>
        </div>

        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-lg font-extrabold leading-tight text-[var(--tl-text-primary)]">{displayName}</h3>
            {verified && <VerifiedSealIcon size={18} className="shrink-0 text-[#1d9bf0]" />}
          </div>
          <p className="text-sm text-[var(--tl-text-muted)]">@{cleanHandle}</p>
        </div>

        {bio && (
          <p className="mt-3 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-[var(--tl-text-primary)]">
            {bio}
          </p>
        )}

        {(location || website || joined) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-[var(--tl-text-muted)]">
            {location && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={13} className="shrink-0" />
                <span>{location}</span>
              </span>
            )}
            {website && (
              <a
                href={website.startsWith('http') ? website : `https://${website}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[#1d9bf0] hover:underline"
              >
                <Globe size={13} className="shrink-0" />
                <span>{website.replace(/^https?:\/\//, '')}</span>
              </a>
            )}
            {joined && (
              <span className="inline-flex items-center gap-1">
                <Calendar size={13} className="shrink-0" />
                <span>{formatXJoinedDate(joined, isEn)}</span>
              </span>
            )}
          </div>
        )}

        {/* Followers / Following / Posts metrics row */}
        <div className="mt-3.5 flex flex-wrap items-center gap-5 text-sm">
          <div className="flex items-baseline gap-1">
            <span className="font-bold text-[var(--tl-text-primary)]">{formatCompactCount(following)}</span>
            <span className="text-xs text-[var(--tl-text-muted)]">{isEn ? 'Following' : 'Seguindo'}</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="font-bold text-[var(--tl-text-primary)]">{formatCompactCount(followers)}</span>
            <span className="text-xs text-[var(--tl-text-muted)]">{isEn ? 'Followers' : 'Seguidores'}</span>
          </div>
          {totalPosts != null && (
            <div className="flex items-baseline gap-1">
              <span className="font-bold text-[var(--tl-text-primary)]">{formatCompactCount(totalPosts)}</span>
              <span className="text-xs text-[var(--tl-text-muted)]">{isEn ? 'Posts' : 'Publicações'}</span>
            </div>
          )}
        </div>
      </div>

      {/* Profile Navigation Tabs: Posts | Media */}
      <div className="tl-x-profile-tabs" role="tablist" aria-label={isEn ? 'Profile sections' : 'Seções do perfil'}>
        <button
          type="button"
          onClick={() => onSelectMode('posts')}
          aria-pressed={mode === 'posts'}
          className={`tl-x-profile-tab ${mode === 'posts' ? 'is-active' : ''}`}
        >
          <span>{isEn ? 'Posts' : 'Publicações'}</span>
        </button>
        <button
          type="button"
          onClick={() => onSelectMode('media')}
          aria-pressed={mode === 'media'}
          className={`tl-x-profile-tab ${mode === 'media' ? 'is-active' : ''}`}
        >
          <span>{isEn ? 'Media' : 'Mídia'}</span>
        </button>
      </div>
    </section>
  );
}

export function XTimelineCard({
  item,
  id,
  active,
  isEn,
  onOpenProfile,
  onOpenMedia,
  onOpenComments,
  onOpenPostDetail,
  onOpenXPhoto,
  onOpenVideo,
}: {
  item: Entry;
  id?: string;
  active: boolean;
  isEn: boolean;
  onOpenProfile: (account: XAccount, trigger: HTMLElement) => void;
  onOpenMedia: (photos: string[], index: number, title: string) => void;
  onOpenComments?: (post: TimelinePost, xPost: XPost) => void;
  onOpenPostDetail?: (xPost: XPost, trigger?: HTMLElement) => void;
  onOpenXPhoto?: (xPost: XPost, index: number) => void;
  onOpenVideo?: (post: TimelinePost, handoff: TimelinePlaybackHandoff) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!active) video.current?.pause();
  }, [active]);

  const post = 'id' in item ? item : undefined;
  const postKey = id || (post ? `live-x:${post.id}` : `x-acct:${item.handle}`);
  const cleanHandle = item.handle.replace(/^@/, '');
  const profileUrl = `https://x.com/${encodeURIComponent(cleanHandle)}`;

  const { isLiked, isFavorited, userCommentsCount, toggleLike, toggleFavorite } = useProfileTimelineStore(
    useShallow(state => ({
      isLiked: Boolean(state.likedPostIds[postKey]),
      isFavorited: Boolean(state.favoritedPostIds[postKey]),
      userCommentsCount: (state.userComments[postKey] || []).length,
      toggleLike: state.toggleLike,
      toggleFavorite: state.toggleFavorite,
    }))
  );

  const [isReposted, setIsReposted] = useState<boolean>(() => Boolean(readStoredReposts()[postKey]));
  const [copied, setCopied] = useState(false);

  const date = post?.date && Number.isFinite(Date.parse(post.date)) ? post.date : undefined;
  const hasVideoPreview = Boolean(post?.video || (post?.hasVideo && post.poster));

  const buildTimelinePostSnapshot = useCallback((): TimelinePost | undefined => {
    if (!post) return undefined;
    return {
      id: postKey,
      creatorId: `x:${cleanHandle.toLowerCase()}`,
      creatorName: post.name || cleanHandle,
      creatorHandle: `@${cleanHandle}`,
      creatorAvatar: post.avatar || '',
      creatorVerified: Boolean(post.verified),
      type: post.video ? 'video' : post.photos.length ? 'photo_grid' : 'text',
      source: 'x',
      title: post.text || post.name || `@${cleanHandle}`,
      text: post.text,
      caption: post.text,
      photos: post.photos,
      thumbnail: post.poster || post.photos[0] || post.avatar || '',
      videoUrl: post.video,
      originalUrl: post.url,
      date: post.date,
      likes: post.metrics.likes ?? 0,
      liked: isLiked,
      favorited: isFavorited,
      saved: false,
      comments: [],
      metrics: post.metrics,
    };
  }, [post, postKey, cleanHandle, isLiked, isFavorited]);

  const handleToggleLike = (e: React.MouseEvent) => {
    e.stopPropagation();
    const snap = buildTimelinePostSnapshot();
    if (!snap) return;
    toggleLike(postKey, snap);
  };

  const handleToggleRepost = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsReposted(prev => {
      const next = !prev;
      const map = readStoredReposts();
      if (next) map[postKey] = true;
      else delete map[postKey];
      writeStoredReposts(map);
      return next;
    });
  };

  const handleToggleBookmark = (e: React.MouseEvent) => {
    e.stopPropagation();
    const snap = buildTimelinePostSnapshot();
    if (!snap) return;
    toggleFavorite(postKey, snap);
  };

  const handleOpenPost = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!post) return;
    if (onOpenPostDetail) {
      onOpenPostDetail(post, e.currentTarget as HTMLElement);
      return;
    }
    const snap = buildTimelinePostSnapshot();
    if (snap && onOpenComments) {
      onOpenComments(snap, post);
    }
  };

  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation();
    const targetUrl = post?.url || profileUrl;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(targetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  const repliesCount =
    post?.metrics.replies != null
      ? post.metrics.replies + userCommentsCount
      : userCommentsCount > 0
        ? userCommentsCount
        : null;
  const repostsCount =
    post?.metrics.reposts != null ? post.metrics.reposts + (isReposted ? 1 : 0) : isReposted ? 1 : null;
  const likesCount = post?.metrics.likes != null ? post.metrics.likes + (isLiked ? 1 : 0) : isLiked ? 1 : null;
  const bookmarksCount =
    post?.metrics.bookmarks != null ? post.metrics.bookmarks + (isFavorited ? 1 : 0) : isFavorited ? 1 : null;

  return (
    <article
      className={`tl-post tl-post--x ${post ? 'cursor-pointer' : ''}`}
      data-timeline-post-id={id}
      data-timeline-source="x"
      data-x-entry={identity(item)}
      onClick={e => {
        if (!post) return;
        const target = e.target as HTMLElement;
        if (target.closest('a, button, video, input, textarea')) return;
        handleOpenPost(e);
      }}
    >
      <div className="tl-post-header">
        <TimelinePostIdentity
          name={item.name}
          handle={`@${cleanHandle}`}
          verifiedLabel={item.verified ? (isEn ? 'Verified creator' : 'Criador verificado') : undefined}
          platform="x"
          sourceLabel="X"
          dateTime={date}
          dateLabel={date && formatXRelativeTime(date, isEn)}
          avatar={
            <SourceAvatar
              name={item.name}
              src={item.avatar || null}
              profileUrl={profileUrl}
              referer={profileUrl}
              lazyHydrate
              alt=""
              className="h-full w-full object-cover"
            />
          }
          onOpenProfile={event => onOpenProfile(item, event.currentTarget)}
        />
      </div>
      {post ? (
        <>
          <div className="space-y-2.5" data-social-body>
            {post.text?.trim() && (
              <XRichText
                text={post.text}
                className="tl-post-copy text-[15px] leading-[1.55]"
                onOpenHandle={(h, trigger) => onOpenProfile({ handle: h, name: h }, trigger)}
              />
            )}
            {post.relation && (
              <TimelineSocialBody
                relation={post.relation}
                isEn={isEn}
                onOpenReferencedMedia={onOpenMedia}
              />
            )}
          </div>
          {!post.text?.trim() && !post.relation && !post.photos.length && !hasVideoPreview && !post.hasVideo && (
            <p className="text-sm text-[var(--tl-text-secondary)]">
              {isEn ? 'Post preview unavailable.' : 'Prévia da publicação indisponível.'}
            </p>
          )}
          {(post.photos.length > 0 || post.video || hasVideoPreview || post.hasVideo) && (
            <XMediaGrid
              photos={post.photos}
              video={post.video}
              poster={post.poster}
              hasVideo={post.hasVideo}
              postId={post.id}
              postKey={postKey}
              handle={cleanHandle}
              title={post.text || post.name}
              sourceUrl={post.url}
              authorName={post.name}
              authorAvatar={post.avatar}
              density="card"
              isEn={isEn}
              active={active}
              onOpenPhoto={index => {
                if (onOpenXPhoto) onOpenXPhoto(post, index);
                else onOpenMedia(post.photos, index, post.name);
              }}
              onOpenWatch={
                onOpenVideo
                  ? (handoff, resolvedVideoUrl) => {
                      const snap = buildTimelinePostSnapshot();
                      if (snap) {
                        onOpenVideo(
                          {
                            ...snap,
                            type: 'video',
                            videoUrl: resolvedVideoUrl,
                            qualities: [{ label: 'HD', height: 1080, streamUrl: resolvedVideoUrl }],
                          },
                          handoff
                        );
                      }
                    }
                  : undefined
              }
            />
          )}
          <div className="tl-post-footer tl-post-footer--x">
            <div className="tl-x-engagement-bar">
              <button
                type="button"
                onClick={handleOpenPost}
                aria-label={isEn ? 'View replies and comments' : 'Ver respostas e comentários'}
                className="tl-x-metric-pill tl-x-metric-pill--reply"
              >
                <XReplySvg size={17} />
                <span className="font-mono">{formatCompactCount(repliesCount)}</span>
              </button>

              <button
                type="button"
                onClick={handleToggleRepost}
                aria-pressed={isReposted}
                aria-label={isEn ? 'Repost' : 'Republicar'}
                className={`tl-x-metric-pill tl-x-metric-pill--repost ${isReposted ? 'is-active' : ''}`}
              >
                <XRepostSvg size={17} />
                <span className="font-mono">{formatCompactCount(repostsCount)}</span>
              </button>

              <button
                type="button"
                onClick={handleToggleLike}
                aria-pressed={isLiked}
                aria-label={isEn ? 'Like post' : 'Curtir publicação'}
                className={`tl-x-metric-pill tl-x-metric-pill--like ${isLiked ? 'is-active' : ''}`}
              >
                <XHeartSvg size={17} filled={isLiked} />
                <span className="font-mono">{formatCompactCount(likesCount)}</span>
              </button>

              <span
                className="tl-x-metric-pill tl-x-metric-pill--views"
                title={isEn ? 'Views' : 'Visualizações'}
              >
                <XViewsSvg size={17} />
                <span className="font-mono">{formatCompactCount(post.metrics.views)}</span>
              </span>

              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleToggleBookmark}
                  aria-pressed={isFavorited}
                  aria-label={isEn ? 'Bookmark post' : 'Salvar nos favoritos'}
                  className={`tl-x-metric-pill tl-x-metric-pill--bookmark ${isFavorited ? 'is-active' : ''}`}
                >
                  <XBookmarkSvg size={16} filled={isFavorited} />
                  {bookmarksCount != null && <span className="font-mono">{formatCompactCount(bookmarksCount)}</span>}
                </button>
                <button
                  type="button"
                  onClick={handleShare}
                  aria-label={isEn ? 'Copy post link' : 'Copiar link da publicação'}
                  className="tl-x-metric-pill tl-x-metric-pill--share"
                >
                  {copied ? <Check size={15} className="text-emerald-400" /> : <XShareSvg size={16} />}
                </button>
              </div>
            </div>
            <div className="sr-only">
              <TimelineSocialMetricsRow metrics={post.metrics} isEn={isEn} />
            </div>
            <a href={post.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className={buttonClass}>
              <ExternalLink aria-hidden size={13} />
              {isEn ? 'Open on X' : 'Abrir no X'}
            </a>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between gap-3">
          {item.bio ? (
            <p className="whitespace-pre-wrap break-words text-sm text-[var(--tl-text-secondary)]">{item.bio}</p>
          ) : (
            <p className="text-xs text-[var(--tl-text-muted)]">@{cleanHandle}</p>
          )}
          <button
            type="button"
            onClick={event => onOpenProfile(item, event.currentTarget)}
            className="shrink-0 rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-white/15"
          >
            {isEn ? 'View profile' : 'Ver perfil'}
          </button>
        </div>
      )}
    </article>
  );
}
