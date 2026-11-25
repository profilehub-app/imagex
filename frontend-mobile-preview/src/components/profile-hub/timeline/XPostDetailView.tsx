import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { SourceAvatar } from '../common/SourceAvatar';
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
import { formatCompactCount, type XAccount, type XPost } from './LiveSocialTimeline';
import type { TimelineCreator, TimelinePost } from './timelineModel';
import type { TimelinePlaybackHandoff } from './TimelinePostCard';
import {
  isXDedicatedBrowserConnected,
  pingXExtension,
  proxyXVideoUrl,
  readLiveX,
} from '../../../services/liveXConnector';
import { useProfileTimelineStore } from '../../../store/useProfileTimelineStore';
import { useProfileHubLibraryStore } from '../../../store/useProfileHubLibraryStore';
import { useMiniPlayerStore } from '../../../store/useMiniPlayerStore';
import {
  UniversalVideoPlayer,
  type UniversalVideoPlayerHandle,
} from '../../video-player/ui/UniversalVideoPlayer';
import type {
  PlaybackHandoffSnapshot,
  UniversalVideoSource,
} from '../../video-player/engine/videoPlayerCore';
import { useShallow } from 'zustand/react/shallow';

function formatVideoDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

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
    // ignore quota errors
  }
}

function makeCursor(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function formatXRelativeTime(raw: string | undefined, isEn: boolean): string {
  if (!raw) return '';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return raw;
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return isEn ? `${Math.max(1, diffSec)}s` : `${Math.max(1, diffSec)}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const d = new Date(ts);
  const now = new Date();
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(isEn ? 'en-US' : 'pt-BR', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(isEn ? 'en-US' : 'pt-BR', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatXFocalTimestamp(raw: string | undefined, isEn: boolean): string {
  if (!raw) return '';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return raw;
  const d = new Date(ts);
  const timePart = d.toLocaleTimeString(isEn ? 'en-US' : 'pt-BR', {
    hour: 'numeric',
    minute: '2-digit',
  });
  const datePart = d.toLocaleDateString(isEn ? 'en-US' : 'pt-BR', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${timePart} · ${datePart}`;
}

export function XRichText({
  text,
  className = '',
  onOpenHandle,
}: {
  text?: string;
  className?: string;
  onOpenHandle?: (handle: string, trigger: HTMLElement) => void;
}) {
  if (!text?.trim()) return null;
  const tokens = text.split(/(https?:\/\/[^\s]+|@[A-Za-z0-9_]{1,15}|#[A-Za-z0-9_\u00C0-\u024F]+)/g);
  return (
    <p className={`whitespace-pre-wrap break-words ${className}`}>
      {tokens.map((part, idx) => {
        if (/^https?:\/\//i.test(part)) {
          return (
            <a
              key={idx}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-[#1d9bf0] hover:underline"
            >
              {part.replace(/^https?:\/\/(?:www\.)?/i, '').slice(0, 42)}
              {part.replace(/^https?:\/\/(?:www\.)?/i, '').length > 42 ? '…' : ''}
            </a>
          );
        }
        if (/^@[A-Za-z0-9_]{1,15}$/.test(part)) {
          return (
            <button
              key={idx}
              type="button"
              onClick={e => {
                e.stopPropagation();
                onOpenHandle?.(part.slice(1), e.currentTarget);
              }}
              className="inline font-medium text-[#1d9bf0] hover:underline"
            >
              {part}
            </button>
          );
        }
        if (/^#[A-Za-z0-9_\u00C0-\u024F]+$/.test(part)) {
          return (
            <span key={idx} className="text-[#1d9bf0]">
              {part}
            </span>
          );
        }
        return <React.Fragment key={idx}>{part}</React.Fragment>;
      })}
    </p>
  );
}

export function XMediaImage({
  src,
  sourceUrl,
  alt,
  className,
}: {
  src: string;
  sourceUrl?: string;
  alt: string;
  className?: string;
}) {
  const [proxying, setProxying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setProxying(false);
    setFailed(false);
  }, [src]);

  if (failed || !src) {
    return (
      <div className="flex h-48 w-full items-center justify-center bg-white/[0.04] text-xs text-[var(--tl-text-muted)]">
        {alt}
      </div>
    );
  }
  const activeSrc =
    proxying && src.startsWith('http')
      ? `/api/proxy-image?url=${encodeURIComponent(src)}&referer=${encodeURIComponent(sourceUrl || src)}`
      : src;

  return (
    <img
      src={activeSrc}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={className}
      onError={() => {
        if (!proxying && src.startsWith('http')) setProxying(true);
        else setFailed(true);
      }}
    />
  );
}

/**
 * X-authentic natural rounded media layout (single photo without black sidebars,
 * 2/3/4-photo X mosaic grid, or video player).
 */
export function XMediaGrid({
  photos,
  video,
  poster,
  hasVideo,
  postId,
  postKey,
  handle,
  title,
  sourceUrl,
  authorName,
  authorAvatar,
  density = 'card',
  isEn,
  active = true,
  onOpenPhoto,
  onOpenWatch,
}: {
  photos: string[];
  video?: string;
  poster?: string;
  hasVideo?: boolean;
  postId?: string;
  postKey?: string;
  handle?: string;
  title?: string;
  sourceUrl?: string;
  authorName: string;
  authorAvatar?: string;
  density?: 'card' | 'cinema';
  isEn: boolean;
  active?: boolean;
  onOpenPhoto: (index: number) => void;
  onOpenWatch?: (handoff: TimelinePlaybackHandoff, resolvedVideoUrl: string) => void;
}) {
  const playerRef = useRef<UniversalVideoPlayerHandle>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const recordedHistoryRef = useRef<string | null>(null);
  const autoResolveAttemptedRef = useRef(false);

  const [resolvedVideo, setResolvedVideo] = useState<string | undefined>(undefined);
  const [resolvedPoster, setResolvedPoster] = useState<string | undefined>(undefined);
  const [resolvingVideo, setResolvingVideo] = useState(false);
  const [resolveFailed, setResolveFailed] = useState(false);
  const [inViewport, setInViewport] = useState(density === 'cinema');

  const mediaKey = postKey || (postId ? `live-x:${postId}` : sourceUrl || '');

  const { activeAutoplayPostId, setActiveAutoplayPostId, isGlobalMuted } = useProfileTimelineStore(
    useShallow(state => ({
      activeAutoplayPostId: state.activeAutoplayPostId,
      setActiveAutoplayPostId: state.setActiveAutoplayPostId,
      isGlobalMuted: state.isGlobalMuted,
    }))
  );
  const recordHistory = useProfileHubLibraryStore(state => state.recordHistory);

  useEffect(() => {
    setResolvedVideo(undefined);
    setResolvedPoster(undefined);
    setResolvingVideo(false);
    setResolveFailed(false);
    recordedHistoryRef.current = null;
    autoResolveAttemptedRef.current = false;
  }, [video, postId, sourceUrl]);

  const effectiveVideo = proxyXVideoUrl(video || resolvedVideo);
  const effectivePoster = poster || resolvedPoster;
  const cleanHandle = (handle || '').replace(/^@/, '');

  const resolveVideoStream = useCallback(async () => {
    if (resolvingVideo) return;
    let targetHandle = cleanHandle;
    let targetId = postId || '';
    if ((!targetHandle || !targetId) && sourceUrl) {
      const m = sourceUrl.match(/\/([^/]+)\/status\/(\d+)/i);
      if (m) {
        targetHandle = targetHandle || m[1];
        targetId = targetId || m[2];
      }
    }
    if (!targetHandle || !targetId) {
      setResolveFailed(true);
      return;
    }
    setResolvingVideo(true);
    setResolveFailed(false);
    try {
      const resp = await fetch(
        `/api/profile-hub/timeline/x-post-thread?handle=${encodeURIComponent(targetHandle)}&post_id=${encodeURIComponent(targetId)}`
      );
      if (resp.ok) {
        const data = await resp.json();
        const foundVideo = data?.post?.video;
        if (foundVideo) {
          setResolvedVideo(foundVideo);
          if (data?.post?.poster) setResolvedPoster(data.post.poster);
          setResolvingVideo(false);
          return;
        }
      }
      setResolveFailed(true);
    } catch {
      setResolveFailed(true);
    } finally {
      setResolvingVideo(false);
    }
  }, [resolvingVideo, cleanHandle, postId, sourceUrl]);

  // Coordinate inline autoplay & auto-resolution as X video cards enter the viewport.
  useEffect(() => {
    if (!active || (!effectiveVideo && !hasVideo)) return;
    if (density === 'cinema') {
      setInViewport(true);
      if (hasVideo && !effectiveVideo && !autoResolveAttemptedRef.current) {
        autoResolveAttemptedRef.current = true;
        void resolveVideoStream();
      }
      return;
    }
    const el = videoContainerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[0];
        const visibleEnough = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.45);
        setInViewport(visibleEnough);
        if (visibleEnough) {
          if (mediaKey) setActiveAutoplayPostId(mediaKey);
          if (hasVideo && !effectiveVideo && !autoResolveAttemptedRef.current) {
            autoResolveAttemptedRef.current = true;
            void resolveVideoStream();
          }
        }
      },
      { threshold: [0, 0.45, 0.75] }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, effectiveVideo, hasVideo, density, mediaKey, setActiveAutoplayPostId, resolveVideoStream]);

  const isAutoplayActive = active && (density === 'cinema' || (inViewport && (!activeAutoplayPostId || activeAutoplayPostId === mediaKey)));

  const universalSource = useMemo<UniversalVideoSource | null>(() => {
    if (!effectiveVideo) return null;
    const profileUrl = cleanHandle ? `https://x.com/${encodeURIComponent(cleanHandle)}` : undefined;
    return {
      id: mediaKey || effectiveVideo,
      title: title || authorName || (cleanHandle ? `@${cleanHandle}` : 'X Video'),
      streamUrl: effectiveVideo,
      originalUrl: sourceUrl || effectiveVideo,
      sourceUrl: sourceUrl || effectiveVideo,
      thumbnailUrl: effectivePoster || authorAvatar,
      posterUrl: effectivePoster || authorAvatar,
      sourceType: 'timeline',
      creatorName: authorName || cleanHandle || 'X',
      creatorHandle: cleanHandle ? `@${cleanHandle}` : undefined,
      creatorAvatar: authorAvatar,
      qualities: [{ label: 'HD', height: 1080, streamUrl: effectiveVideo }],
      returnRoute: { view: 'timeline-preview' },
      originContext: { surface: 'timeline-watch', creatorUrl: profileUrl },
    };
  }, [effectiveVideo, mediaKey, title, authorName, cleanHandle, sourceUrl, effectivePoster, authorAvatar]);

  const handlePlaybackStateChange = useCallback(
    (state: { isPlaying: boolean; isVideoReady: boolean; duration: number }) => {
      if (!state.isPlaying || !state.isVideoReady || !effectiveVideo) return;
      const trackKey = mediaKey || effectiveVideo;
      if (recordedHistoryRef.current === trackKey) return;
      recordedHistoryRef.current = trackKey;
      const profileUrl = cleanHandle ? `https://x.com/${encodeURIComponent(cleanHandle)}` : undefined;
      void recordHistory({
        id: trackKey,
        kind: 'video',
        title: title || authorName || (cleanHandle ? `@${cleanHandle}` : 'X Video'),
        sourceUrl: sourceUrl || effectiveVideo,
        videoUrl: effectiveVideo,
        thumbnailUrl: effectivePoster || authorAvatar,
        duration: formatVideoDuration(state.duration) || undefined,
        creatorId: cleanHandle ? `x:${cleanHandle.toLowerCase()}` : undefined,
        creatorName: authorName || cleanHandle || 'X',
        creatorHandle: cleanHandle ? `@${cleanHandle}` : undefined,
        creatorAvatar: authorAvatar || undefined,
        creatorUrl: profileUrl,
        platform: 'x',
      });
    },
    [effectiveVideo, mediaKey, title, authorName, cleanHandle, sourceUrl, effectivePoster, authorAvatar, recordHistory]
  );

  const handleMinimizeToMiniPlayer = useCallback(() => {
    if (!universalSource) return;
    const snap: PlaybackHandoffSnapshot = playerRef.current?.capturePlaybackSnapshot() || {
      currentTime: 0,
      isPlaying: true,
      isMuted: false,
      volume: 1,
      playbackRate: 1,
      selectedQuality: 'auto',
    };
    useMiniPlayerStore.getState().openMiniPlayer({ source: universalSource, handoff: snap });
  }, [universalSource]);

  const cleanPhotos = photos.filter(Boolean);

  if (cleanPhotos.length > 0 && !effectiveVideo && !hasVideo) {
    if (cleanPhotos.length === 1) {
      return (
        <div
          className="tl-x-media-single"
          data-social-carousel
          onClick={e => e.stopPropagation()}
        >
          <button
            type="button"
            className="tl-x-media-single-btn"
            aria-label={isEn ? `Open photo from ${authorName}` : `Abrir foto de ${authorName}`}
            onClick={() => onOpenPhoto(0)}
          >
            <XMediaImage
              src={cleanPhotos[0]}
              sourceUrl={sourceUrl}
              alt={isEn ? `Photo 1 of 1` : `Foto 1 de 1`}
              className="tl-x-media-single-img"
            />
          </button>
        </div>
      );
    }

    const gridClass =
      cleanPhotos.length === 2
        ? 'tl-x-media-grid tl-x-media-grid--2'
        : cleanPhotos.length === 3
          ? 'tl-x-media-grid tl-x-media-grid--3'
          : 'tl-x-media-grid tl-x-media-grid--4';

    return (
      <div className={gridClass} data-social-carousel onClick={e => e.stopPropagation()}>
        {cleanPhotos.slice(0, 4).map((url, idx) => (
          <button
            key={`${url}-${idx}`}
            type="button"
            className={`tl-x-media-cell ${cleanPhotos.length === 3 && idx === 0 ? 'row-span-2' : ''}`}
            aria-label={isEn ? `Open photo ${idx + 1} of ${cleanPhotos.length}` : `Abrir foto ${idx + 1} de ${cleanPhotos.length}`}
            onClick={() => onOpenPhoto(idx)}
          >
            <XMediaImage
              src={url}
              sourceUrl={sourceUrl}
              alt={isEn ? `Photo ${idx + 1} of ${cleanPhotos.length}` : `Foto ${idx + 1} de ${cleanPhotos.length}`}
              className="h-full w-full object-cover"
            />
          </button>
        ))}
      </div>
    );
  }

  if (effectiveVideo && universalSource && !resolveFailed) {
    return (
      <div
        ref={videoContainerRef}
        className="tl-x-media-single tl-x-uvp-frame"
        data-x-video-player
        onClick={e => e.stopPropagation()}
      >
        <UniversalVideoPlayer
          ref={playerRef}
          source={universalSource}
          density={density}
          posterUrl={effectivePoster}
          aspectRatio="16/9"
          autoPlayOnActive={isAutoplayActive}
          isActive={isAutoplayActive}
          initialMuted={density === 'cinema' ? false : isGlobalMuted}
          suspended={!active}
          preloadMetadata={true}
          ambientGlowEnabled={density === 'cinema'}
          onPlaybackStateChange={handlePlaybackStateChange}
          onMinimizeToMiniPlayer={handleMinimizeToMiniPlayer}
          onRequestWatch={
            onOpenWatch
              ? (_src, handoff) =>
                  onOpenWatch(
                    {
                      currentTime: handoff.currentTime,
                      isMuted: Boolean(handoff.isMuted),
                      isPlaying: handoff.isPlaying,
                      volume: handoff.volume,
                      playbackRate: handoff.playbackRate,
                      selectedQuality: handoff.selectedQuality,
                    },
                    effectiveVideo
                  )
              : undefined
          }
          onErrorFallback={() => setResolveFailed(true)}
          className="w-full max-h-[540px] rounded-2xl overflow-hidden bg-black"
        />
      </div>
    );
  }

  if (hasVideo || effectivePoster) {
    return (
      <div
        ref={videoContainerRef}
        className="tl-x-media-single tl-post-video-link relative block"
        onClick={e => e.stopPropagation()}
      >
        {effectivePoster ? (
          <XMediaImage
            src={effectivePoster}
            sourceUrl={sourceUrl}
            alt={isEn ? 'Video preview on X' : 'Prévia de vídeo no X'}
            className="tl-x-media-single-img"
          />
        ) : (
          <div className="flex h-64 w-full items-center justify-center bg-black/70 text-xs text-[var(--tl-text-muted)]">
            {isEn ? 'X Video' : 'Vídeo do X'}
          </div>
        )}
        {!resolveFailed ? (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              void resolveVideoStream();
            }}
            disabled={resolvingVideo}
            aria-label={isEn ? 'Play video' : 'Reproduzir vídeo'}
            className="tl-x-video-play-btn"
          >
            {resolvingVideo ? <Loader2 size={26} className="animate-spin" /> : <Play size={26} fill="currentColor" />}
          </button>
        ) : (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="tl-post-video-label"
          >
            <ExternalLink aria-hidden size={15} />
            {isEn ? 'Open video on X' : 'Abrir vídeo no X'}
          </a>
        )}
      </div>
    );
  }

  return null;
}

export interface XThreadState {
  focalPost: XPost;
  authorProfile: XAccount | null;
  parentPosts: XPost[];
  replies: XPost[];
  relevantPeople: XAccount[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  sourceMode: 'live' | 'fallback' | 'seed';
  extensionHint: boolean;
  extensionNeedsReload: boolean;
  loadMore: () => void;
  refresh: (connectDedicated?: boolean) => void;
}

export function useXPostThread(seedPost: XPost | null, active: boolean): XThreadState | null {
  const [focalPost, setFocalPost] = useState<XPost | null>(seedPost);
  const [authorProfile, setAuthorProfile] = useState<XAccount | null>(null);
  const [parentPosts, setParentPosts] = useState<XPost[]>([]);
  const [replies, setReplies] = useState<XPost[]>([]);
  const [relevantPeople, setRelevantPeople] = useState<XAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [sourceMode, setSourceMode] = useState<'live' | 'fallback' | 'seed'>('seed');
  const [extensionHint, setExtensionHint] = useState(false);
  const [extensionNeedsReload, setExtensionNeedsReload] = useState(false);

  const cursorRef = useRef<string>('');
  const offsetRef = useRef<number>(0);
  const liveConnectedRef = useRef<boolean>(false);
  const allowDedicatedRef = useRef<boolean>(false);
  const seedId = seedPost?.id || '';
  const seedHandle = (seedPost?.handle || '').replace(/^@/, '');

  const mergeThreadBatch = useCallback(
    (items: XPost[], isFirstBatch: boolean) => {
      if (!items.length) {
        setHasMore(false);
        return;
      }
      const focalIndex = items.findIndex(item => item.id === seedId);
      if (isFirstBatch && focalIndex >= 0) {
        const focal = items[focalIndex];
        setFocalPost(prev => ({
          ...(prev || focal),
          ...focal,
          text: focal.text || prev?.text,
          avatar: focal.avatar || prev?.avatar,
          banner: focal.banner || prev?.banner,
          verified: focal.verified ?? prev?.verified,
          photos: focal.photos.length > 0 ? focal.photos : prev?.photos || [],
          video: focal.video || prev?.video,
          poster: focal.poster || prev?.poster,
          hasVideo: Boolean(focal.hasVideo || prev?.hasVideo),
          metrics: {
            replies: focal.metrics.replies ?? prev?.metrics.replies,
            reposts: focal.metrics.reposts ?? prev?.metrics.reposts,
            likes: focal.metrics.likes ?? prev?.metrics.likes,
            views: focal.metrics.views ?? prev?.metrics.views,
            bookmarks: focal.metrics.bookmarks ?? prev?.metrics.bookmarks,
            quotes: focal.metrics.quotes ?? prev?.metrics.quotes,
          },
        }));
        if (focalIndex > 0) {
          setParentPosts(items.slice(0, focalIndex));
        }
        const incomingReplies = items.slice(focalIndex + 1).filter(it => it.id !== seedId);
        setReplies(incomingReplies);
        setHasMore(true);
      } else {
        const incomingReplies = items.filter(it => it.id !== seedId);
        if (incomingReplies.length === 0) {
          setHasMore(false);
          return;
        }
        setReplies(prev => {
          const seen = new Set(prev.map(r => r.id));
          const additions = incomingReplies.filter(r => !seen.has(r.id));
          if (additions.length === 0) {
            setHasMore(false);
            return prev;
          }
          return [...prev, ...additions];
        });
      }
    },
    [seedId]
  );

  const fetchThread = useCallback(
    async (signal: AbortSignal, forceDedicated = false) => {
      if (!seedPost || !seedId || !seedHandle) return;
      cursorRef.current = makeCursor();
      offsetRef.current = 0;
      liveConnectedRef.current = false;
      setLoading(true);
      setExtensionHint(false);
      setExtensionNeedsReload(false);
      setParentPosts([]);
      setReplies([]);
      setRelevantPeople([]);
      setHasMore(false);

      // Extract any @mentioned handles in the post text and enrich their real X profiles in parallel
      const mentionHandles = Array.from(
        new Set(
          (seedPost.text || '')
            .match(/@([A-Za-z0-9_]{1,15})/g)
            ?.map(m => m.slice(1))
            .filter(h => h.toLowerCase() !== seedHandle.toLowerCase()) || []
        )
      ).slice(0, 4);
      if (seedPost.relation?.post?.creatorHandle) {
        const qh = seedPost.relation.post.creatorHandle.replace(/^@/, '');
        if (qh && qh.toLowerCase() !== seedHandle.toLowerCase() && !mentionHandles.includes(qh)) {
          mentionHandles.unshift(qh);
        }
      }
      if (mentionHandles.length > 0) {
        void fetch('/api/profile-hub/timeline/x-batch-enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [], handles: mentionHandles }),
          signal,
        })
          .then(r => (r.ok ? r.json() : null))
          .then(data => {
            if (signal.aborted || !data?.ok || !data.profiles) return;
            const enrichedMentions = mentionHandles
              .map(h => data.profiles[h.toLowerCase()])
              .filter(Boolean) as XAccount[];
            if (enrichedMentions.length > 0) {
              setRelevantPeople(prev => {
                const seen = new Set(prev.map(p => (p.handle || '').replace(/^@/, '').toLowerCase()));
                const additions = enrichedMentions.filter(
                  p => !seen.has((p.handle || '').replace(/^@/, '').toLowerCase())
                );
                return additions.length ? [...prev, ...additions] : prev;
              });
            }
          })
          .catch(() => {});
      }

      // Run backend enrichment (author bio/banner/followers + VxTwitter retweets/video + syndication) in parallel
      // and apply focal metadata immediately as soon as it arrives (don't wait for slow live-browser reads).
      const enrichPromise = fetch(
        `/api/profile-hub/timeline/x-post-thread?handle=${encodeURIComponent(seedHandle)}&post_id=${encodeURIComponent(seedId)}`,
        { signal }
      )
        .then(r => (r.ok ? r.json() : null))
        .then(enriched => {
          if (!signal.aborted && enriched?.ok) {
            if (enriched.authorProfile) {
              setAuthorProfile(enriched.authorProfile);
            }
            if (enriched.post) {
              const ep = enriched.post as XPost;
              setFocalPost(prev => ({
                ...(prev || seedPost),
                name: prev?.name || ep.name,
                avatar: prev?.avatar || ep.avatar,
                banner: prev?.banner || ep.banner,
                verified: prev?.verified ?? ep.verified,
                bio: prev?.bio || ep.bio,
                text: prev?.text && prev.text.length >= (ep.text?.length || 0) ? prev.text : ep.text || prev?.text,
                date: prev?.date || ep.date,
                photos: (prev?.photos?.length || 0) > 0 ? prev!.photos : ep.photos || [],
                video: prev?.video || ep.video,
                poster: prev?.poster || ep.poster,
                hasVideo: Boolean(prev?.hasVideo || ep.hasVideo),
                metrics: {
                  replies: prev?.metrics?.replies ?? ep.metrics?.replies,
                  reposts: prev?.metrics?.reposts ?? ep.metrics?.reposts,
                  likes: prev?.metrics?.likes ?? ep.metrics?.likes,
                  views: prev?.metrics?.views ?? ep.metrics?.views,
                  bookmarks: prev?.metrics?.bookmarks ?? ep.metrics?.bookmarks,
                },
              }));
            }
          }
          return enriched;
        })
        .catch(() => null);

      const dedicatedReady = forceDedicated || allowDedicatedRef.current || (await isXDedicatedBrowserConnected(signal));
      if (dedicatedReady) allowDedicatedRef.current = true;

      // Try reading live signed-in X thread via Chrome extension or connected dedicated browser
      let liveWorked = false;
      try {
        const batch = (await readLiveX(
          0,
          { cursor: cursorRef.current, scope: 'post', handle: seedHandle, postId: seedId },
          signal,
          dedicatedReady
        )) as { status?: string; items?: XPost[]; relevantPeople?: XAccount[] };
        if (!signal.aborted && batch?.status === 'ready' && Array.isArray(batch.items) && batch.items.length > 0) {
          liveWorked = true;
          liveConnectedRef.current = true;
          offsetRef.current = 1;
          setSourceMode('live');
          mergeThreadBatch(batch.items, true);
          if (Array.isArray(batch.relevantPeople) && batch.relevantPeople.length > 0) {
            setRelevantPeople(prev => {
              const seen = new Set(batch.relevantPeople!.map(p => (p.handle || '').replace(/^@/, '').toLowerCase()));
              return [
                ...batch.relevantPeople!,
                ...prev.filter(p => !seen.has((p.handle || '').replace(/^@/, '').toLowerCase())),
              ];
            });
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          const msg = err instanceof Error ? err.message : '';
          if (msg === 'extension_reload_required') {
            setExtensionNeedsReload(true);
          } else {
            const ping = await pingXExtension(signal);
            if (!signal.aborted && ping.installed && !ping.scopes?.includes('post')) {
              setExtensionNeedsReload(true);
            }
          }
        }
      }

      const enriched = await enrichPromise;
      if (signal.aborted) return;

      if (enriched?.ok) {
        if (!liveWorked) {
          if (enriched.parent) {
            setParentPosts([enriched.parent as XPost]);
          }
          if (Array.isArray(enriched.replies) && enriched.replies.length > 0) {
            setReplies(enriched.replies as XPost[]);
          }
          setSourceMode('fallback');
          // Show reload / connect hint if expected replies > loaded replies
          const expectedReplies = seedPost.metrics?.replies ?? enriched.post?.metrics?.replies ?? 0;
          if (expectedReplies > 0 && (!enriched.replies || enriched.replies.length === 0)) {
            setExtensionHint(true);
          }
        }
      } else if (!liveWorked) {
        setExtensionHint(Boolean((seedPost.metrics?.replies ?? 0) > 0));
      }

      setLoading(false);
    },
    [seedPost, seedId, seedHandle, mergeThreadBatch]
  );

  const [refreshNonce, setRefreshNonce] = useState(0);
  const pendingForceDedicatedRef = useRef(false);

  useEffect(() => {
    setFocalPost(seedPost);
    setAuthorProfile(null);
    if (!active || !seedPost) return;
    const forceDedicated = pendingForceDedicatedRef.current;
    pendingForceDedicatedRef.current = false;
    const controller = new AbortController();
    void fetchThread(controller.signal, forceDedicated);
    return () => controller.abort();
  }, [active, seedId, seedHandle, refreshNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    if (!liveConnectedRef.current || loadingMore || !hasMore || !seedId || !seedHandle) return;
    setLoadingMore(true);
    const controller = new AbortController();
    void readLiveX(
      offsetRef.current,
      { cursor: cursorRef.current, scope: 'post', handle: seedHandle, postId: seedId },
      controller.signal,
      allowDedicatedRef.current
    )
      .then(batch => {
        const b = batch as { status?: string; items?: XPost[] };
        if (b?.status === 'ready' && Array.isArray(b.items)) {
          offsetRef.current += 1;
          mergeThreadBatch(b.items, false);
        } else {
          setHasMore(false);
        }
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore, seedId, seedHandle, mergeThreadBatch]);

  if (!seedPost || !focalPost) return null;

  return {
    focalPost,
    authorProfile,
    parentPosts,
    replies,
    relevantPeople,
    loading,
    loadingMore,
    hasMore,
    sourceMode,
    extensionHint,
    extensionNeedsReload,
    loadMore,
    refresh: (connectDedicated = false) => {
      if (connectDedicated) pendingForceDedicatedRef.current = true;
      setRefreshNonce(n => n + 1);
    },
  };
}

function buildXTimelinePostSnapshot(post: XPost, postKey: string, isLiked: boolean, isFavorited: boolean): TimelinePost {
  const cleanHandle = post.handle.replace(/^@/, '');
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
}

function XReplyRow({
  reply,
  replyingToHandle,
  isEn,
  onOpenProfile,
  onOpenPost,
  onOpenPhoto,
}: {
  reply: XPost;
  replyingToHandle?: string;
  isEn: boolean;
  onOpenProfile: (account: XAccount, trigger: HTMLElement) => void;
  onOpenPost: (post: XPost) => void;
  onOpenPhoto: (post: XPost, index: number) => void;
}) {
  const cleanHandle = reply.handle.replace(/^@/, '');
  const postKey = `live-x:${reply.id}`;
  const profileUrl = `https://x.com/${encodeURIComponent(cleanHandle)}`;
  const { isLiked, isFavorited, toggleLike, toggleFavorite } = useProfileTimelineStore(
    useShallow(state => ({
      isLiked: Boolean(state.likedPostIds[postKey]),
      isFavorited: Boolean(state.favoritedPostIds[postKey]),
      toggleLike: state.toggleLike,
      toggleFavorite: state.toggleFavorite,
    }))
  );
  const [isReposted, setIsReposted] = useState<boolean>(() => Boolean(readStoredReposts()[postKey]));
  const [copied, setCopied] = useState(false);

  const likesVal = reply.metrics.likes != null ? reply.metrics.likes + (isLiked ? 1 : 0) : isLiked ? 1 : null;
  const repostsVal = reply.metrics.reposts != null ? reply.metrics.reposts + (isReposted ? 1 : 0) : isReposted ? 1 : null;

  return (
    <article
      className="tl-x-reply-row"
      data-x-reply-id={reply.id}
      onClick={e => {
        if ((e.target as HTMLElement).closest('a, button, video')) return;
        onOpenPost(reply);
      }}
    >
      <button
        type="button"
        className="tl-x-reply-avatar"
        onClick={e => {
          e.stopPropagation();
          onOpenProfile(reply, e.currentTarget);
        }}
        aria-label={reply.name}
      >
        <SourceAvatar
          name={reply.name}
          src={reply.avatar || null}
          profileUrl={profileUrl}
          referer={profileUrl}
          lazyHydrate
          alt=""
          className="h-full w-full object-cover"
        />
      </button>

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[14px] leading-snug">
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onOpenProfile(reply, e.currentTarget);
            }}
            className="inline-flex items-center gap-1 font-bold text-[var(--tl-text-primary)] hover:underline"
          >
            <span className="truncate max-w-[200px]">{reply.name}</span>
            {reply.verified && <VerifiedSealIcon size={15} className="shrink-0 text-[#1d9bf0]" />}
          </button>
          <span className="truncate text-[var(--tl-text-muted)]">@{cleanHandle}</span>
          {reply.date && (
            <>
              <span className="text-[var(--tl-text-muted)]">·</span>
              <time dateTime={reply.date} className="text-xs text-[var(--tl-text-muted)]">
                {formatXRelativeTime(reply.date, isEn)}
              </time>
            </>
          )}
        </div>

        {replyingToHandle && (
          <p className="text-xs text-[var(--tl-text-muted)]">
            {isEn ? 'Replying to' : 'Respondendo a'}{' '}
            <span className="text-[#1d9bf0]">@{replyingToHandle.replace(/^@/, '')}</span>
          </p>
        )}

        <XRichText
          text={reply.text}
          className="text-[15px] leading-relaxed text-[var(--tl-text-primary)]"
          onOpenHandle={(h, trigger) => onOpenProfile({ handle: h, name: h }, trigger)}
        />

        {(reply.photos.length > 0 || reply.video || reply.hasVideo) && (
          <div className="pt-1">
            <XMediaGrid
              photos={reply.photos}
              video={reply.video}
              poster={reply.poster}
              hasVideo={reply.hasVideo}
              postId={reply.id}
              handle={cleanHandle}
              sourceUrl={reply.url}
              authorName={reply.name}
              isEn={isEn}
              onOpenPhoto={idx => onOpenPhoto(reply, idx)}
            />
          </div>
        )}

        <div className="tl-x-reply-actions">
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onOpenPost(reply);
            }}
            aria-label={isEn ? 'Reply' : 'Responder'}
            className="tl-x-metric-pill tl-x-metric-pill--reply"
          >
            <XReplySvg size={16} />
            {reply.metrics.replies != null && <span className="font-mono">{formatCompactCount(reply.metrics.replies)}</span>}
          </button>

          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              setIsReposted(prev => {
                const next = !prev;
                const map = readStoredReposts();
                if (next) map[postKey] = true;
                else delete map[postKey];
                writeStoredReposts(map);
                return next;
              });
            }}
            aria-pressed={isReposted}
            aria-label={isEn ? 'Repost' : 'Republicar'}
            className={`tl-x-metric-pill tl-x-metric-pill--repost ${isReposted ? 'is-active' : ''}`}
          >
            <XRepostSvg size={16} />
            {repostsVal != null && <span className="font-mono">{formatCompactCount(repostsVal)}</span>}
          </button>

          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              toggleLike(postKey, buildXTimelinePostSnapshot(reply, postKey, isLiked, isFavorited));
            }}
            aria-pressed={isLiked}
            aria-label={isEn ? 'Like' : 'Curtir'}
            className={`tl-x-metric-pill tl-x-metric-pill--like ${isLiked ? 'is-active' : ''}`}
          >
            <XHeartSvg size={16} filled={isLiked} />
            {likesVal != null && <span className="font-mono">{formatCompactCount(likesVal)}</span>}
          </button>

          <span className="tl-x-metric-pill tl-x-metric-pill--views">
            <XViewsSvg size={16} />
            {reply.metrics.views != null && <span className="font-mono">{formatCompactCount(reply.metrics.views)}</span>}
          </span>

          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                toggleFavorite(postKey, buildXTimelinePostSnapshot(reply, postKey, isLiked, isFavorited));
              }}
              aria-pressed={isFavorited}
              aria-label={isEn ? 'Bookmark' : 'Favoritar'}
              className={`tl-x-metric-pill tl-x-metric-pill--bookmark ${isFavorited ? 'is-active' : ''}`}
            >
              <XBookmarkSvg size={15} filled={isFavorited} />
            </button>
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                if (navigator.clipboard?.writeText) {
                  void navigator.clipboard.writeText(reply.url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }
              }}
              aria-label={isEn ? 'Share' : 'Compartilhar'}
              className="tl-x-metric-pill tl-x-metric-pill--share"
            >
              {copied ? <Check size={14} className="text-emerald-400" /> : <XShareSvg size={15} />}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * Right-sidebar "Relevant people" card shown alongside XPostDetailView (matching X.com).
 */
export function XRelevantPeopleCard({
  focalPost,
  authorProfile,
  replies,
  relevantPeople = [],
  relatedFeedAccounts = [],
  xFollowedHandles,
  isEn,
  onOpenProfile,
}: {
  focalPost: XPost;
  authorProfile: XAccount | null;
  replies: XPost[];
  relevantPeople?: XAccount[];
  relatedFeedAccounts?: XAccount[];
  xFollowedHandles?: Set<string>;
  isEn: boolean;
  onOpenProfile: (account: XAccount, trigger: HTMLElement) => void;
}) {
  const { followedCreatorIds, creators, toggleFollowCreator } = useProfileTimelineStore(
    useShallow(state => ({
      followedCreatorIds: state.followedCreatorIds,
      creators: state.creators,
      toggleFollowCreator: state.toggleFollowCreator,
    }))
  );

  const people = useMemo<XAccount[]>(() => {
    const out: XAccount[] = [];
    const seen = new Set<string>();
    const pushPerson = (p: XAccount) => {
      if (out.length >= 6) return;
      const h = (p.handle || '').replace(/^@/, '').toLowerCase();
      if (!h || seen.has(h)) return;
      seen.add(h);
      out.push({ ...p, handle: (p.handle || '').replace(/^@/, '') });
    };
    pushPerson({
      handle: authorProfile?.handle || focalPost.handle,
      name: authorProfile?.name || focalPost.name,
      avatar: authorProfile?.avatar || focalPost.avatar,
      banner: authorProfile?.banner || focalPost.banner,
      verified: authorProfile?.verified ?? focalPost.verified,
      isFollowing: authorProfile?.isFollowing ?? focalPost.isFollowing,
      bio: authorProfile?.bio || focalPost.bio,
      followers: authorProfile?.followers ?? focalPost.followers,
      following: authorProfile?.following ?? focalPost.following,
      postsCount: authorProfile?.postsCount ?? focalPost.postsCount,
    });
    for (const rp of relevantPeople) {
      pushPerson(rp);
    }
    if (focalPost.relation?.post?.creatorHandle) {
      const qh = focalPost.relation.post.creatorHandle.replace(/^@/, '');
      pushPerson({
        handle: qh,
        name: focalPost.relation.post.creatorName || qh,
      });
    }
    for (const r of replies.slice(0, 4)) {
      pushPerson(r);
    }
    // Include active accounts from the user's current X feed / followed accounts if still under 5 entries
    for (const acc of relatedFeedAccounts) {
      if (out.length >= 5) break;
      pushPerson(acc);
    }
    return out;
  }, [focalPost, authorProfile, relevantPeople, replies, relatedFeedAccounts]);

  return (
    <div className="tl-context-card tl-x-relevant-card" data-x-relevant-people>
      <h3>{isEn ? 'Relevant people' : 'Pessoas relevantes'}</h3>
      <div className="space-y-3">
        {people.map(person => {
          const cleanH = person.handle.replace(/^@/, '');
          const creatorId = `x:${cleanH.toLowerCase()}`;
          const profileUrl = `https://x.com/${encodeURIComponent(cleanH)}`;
          const isFollowed = Boolean(
            xFollowedHandles?.has(cleanH.toLowerCase()) ||
              person.isFollowing ||
              followedCreatorIds[creatorId] ||
              creators.some(c => c.profileUrl?.toLowerCase().includes(`x.com/${cleanH.toLowerCase()}`))
          );
          return (
            <div key={cleanH} className="tl-x-relevant-person">
              <div className="flex items-start gap-2.5">
                <button
                  type="button"
                  onClick={e => onOpenProfile(person, e.currentTarget)}
                  className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-white/10"
                >
                  <SourceAvatar
                    name={person.name}
                    src={person.avatar || null}
                    profileUrl={profileUrl}
                    referer={profileUrl}
                    lazyHydrate
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={e => onOpenProfile(person, e.currentTarget)}
                    className="block max-w-full text-left"
                  >
                    <div className="flex items-center gap-1">
                      <strong className="truncate text-sm font-bold text-[var(--tl-text-primary)] hover:underline">
                        {person.name}
                      </strong>
                      {person.verified && <VerifiedSealIcon size={14} className="shrink-0 text-[#1d9bf0]" />}
                    </div>
                    <small className="block truncate text-xs text-[var(--tl-text-muted)]">@{cleanH}</small>
                  </button>
                </div>
                <button
                  type="button"
                  aria-pressed={isFollowed}
                  onClick={() => {
                    const snap: TimelineCreator = {
                      id: creatorId,
                      name: person.name || cleanH,
                      handle: `@${cleanH}`,
                      avatar: person.avatar || '',
                      banner: person.banner,
                      profileUrl,
                      site: 'x',
                      verified: Boolean(person.verified),
                      bio: person.bio,
                      stats: {
                        followers: person.followers != null ? String(person.followers) : undefined,
                      },
                    };
                    toggleFollowCreator(snap);
                  }}
                  className={`tl-x-relevant-follow ${isFollowed ? 'is-following' : ''}`}
                >
                  {isFollowed ? (isEn ? 'Following' : 'Seguindo') : isEn ? 'Follow' : 'Seguir'}
                </button>
              </div>
              {person.bio && (
                <p className="mt-1.5 line-clamp-3 pl-[50px] text-xs leading-relaxed text-[var(--tl-text-secondary)]">
                  {person.bio}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Full-page X Post Detail View (mirrors X.com /status/{id} experience).
 */
export function XPostDetailView({
  thread,
  xFollowedHandles,
  isEn,
  onBack,
  onOpenProfile,
  onOpenPost,
  onOpenPhoto,
  onOpenVideo,
}: {
  thread: XThreadState;
  xFollowedHandles?: Set<string>;
  isEn: boolean;
  onBack: () => void;
  onOpenProfile: (account: XAccount, trigger: HTMLElement) => void;
  onOpenPost: (post: XPost) => void;
  onOpenPhoto: (post: XPost, index: number) => void;
  onOpenVideo?: (post: TimelinePost, handoff: TimelinePlaybackHandoff) => void;
}) {
  const {
    focalPost,
    authorProfile,
    parentPosts,
    replies,
    loading,
    loadingMore,
    hasMore,
    extensionHint,
    extensionNeedsReload,
    loadMore,
    refresh,
  } = thread;
  const cleanHandle = focalPost.handle.replace(/^@/, '');
  const postKey = `live-x:${focalPost.id}`;
  const creatorId = `x:${cleanHandle.toLowerCase()}`;
  const profileUrl = `https://x.com/${encodeURIComponent(cleanHandle)}`;
  const replyInputRef = useRef<HTMLInputElement>(null);

  const { isLiked, isFavorited, storeFollowed, userComments, toggleLike, toggleFavorite, toggleFollowCreator, addComment } =
    useProfileTimelineStore(
      useShallow(state => ({
        isLiked: Boolean(state.likedPostIds[postKey]),
        isFavorited: Boolean(state.favoritedPostIds[postKey]),
        storeFollowed: Boolean(
          state.followedCreatorIds[creatorId] ||
            state.creators.some(c => c.profileUrl?.toLowerCase().includes(`x.com/${cleanHandle.toLowerCase()}`))
        ),
        userComments: state.userComments[postKey] || [],
        toggleLike: state.toggleLike,
        toggleFavorite: state.toggleFavorite,
        toggleFollowCreator: state.toggleFollowCreator,
        addComment: state.addComment,
      }))
    );
  const isFollowed = Boolean(
    xFollowedHandles?.has(cleanHandle.toLowerCase()) ||
      authorProfile?.isFollowing ||
      focalPost.isFollowing ||
      storeFollowed
  );

  const [isReposted, setIsReposted] = useState<boolean>(() => Boolean(readStoredReposts()[postKey]));
  const [copied, setCopied] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const [sortMode, setSortMode] = useState<'relevant' | 'recent' | 'liked'>('relevant');

  useEffect(() => {
    setIsReposted(Boolean(readStoredReposts()[postKey]));
    setReplyDraft('');
  }, [postKey]);

  const sortedReplies = useMemo(() => {
    if (sortMode === 'relevant') return replies;
    const copy = [...replies];
    if (sortMode === 'liked') {
      return copy.sort((a, b) => (b.metrics.likes ?? -1) - (a.metrics.likes ?? -1));
    }
    return copy.sort((a, b) => (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0));
  }, [replies, sortMode]);

  const handleReplySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyDraft.trim()) return;
    addComment(postKey, replyDraft.trim());
    setReplyDraft('');
  };

  const displayRepliesCount =
    focalPost.metrics.replies != null
      ? Math.max(focalPost.metrics.replies, replies.length) + userComments.length
      : replies.length + userComments.length > 0
        ? replies.length + userComments.length
        : null;
  const displayRepostsCount =
    focalPost.metrics.reposts != null ? focalPost.metrics.reposts + (isReposted ? 1 : 0) : isReposted ? 1 : null;
  const displayLikesCount =
    focalPost.metrics.likes != null ? focalPost.metrics.likes + (isLiked ? 1 : 0) : isLiked ? 1 : null;
  const displayBookmarksCount =
    focalPost.metrics.bookmarks != null ? focalPost.metrics.bookmarks + (isFavorited ? 1 : 0) : isFavorited ? 1 : null;

  return (
    <section className="tl-x-post-detail" data-x-post-detail={focalPost.id} aria-label={isEn ? 'X Post thread' : 'Publicação do X'}>
      {/* Sticky Top Bar: ← Post */}
      <header className="tl-x-detail-topbar">
        <button type="button" onClick={onBack} className="tl-x-detail-back-btn" aria-label={isEn ? 'Back' : 'Voltar'}>
          <ArrowLeft size={18} aria-hidden />
          <span>{isEn ? 'Back' : 'Voltar'}</span>
        </button>
        <h2 className="text-lg font-extrabold tracking-tight text-[var(--tl-text-primary)]">
          {isEn ? 'Post' : 'Post'}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => refresh(false)}
            disabled={loading}
            aria-label={isEn ? 'Refresh replies' : 'Atualizar respostas'}
            title={isEn ? 'Refresh replies' : 'Atualizar respostas'}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--tl-text-secondary)] hover:bg-[var(--tl-surface-hover)] hover:text-[var(--tl-text-primary)]"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <a
            href={focalPost.url}
            target="_blank"
            rel="noopener noreferrer"
            className="tl-x-profile-ext-btn"
          >
            <XBrandIcon size={12} />
            <span>{isEn ? 'Open on X' : 'Abrir no X'}</span>
            <ExternalLink size={12} aria-hidden />
          </a>
        </div>
      </header>

      {/* Parent / Ancestor Tweets (if replying to an earlier post) */}
      {parentPosts.length > 0 && (
        <div className="tl-x-parent-chain">
          {parentPosts.map(parent => {
            const pHandle = parent.handle.replace(/^@/, '');
            const pUrl = `https://x.com/${encodeURIComponent(pHandle)}`;
            return (
              <div
                key={parent.id}
                className="tl-x-parent-row"
                onClick={e => {
                  if ((e.target as HTMLElement).closest('a, button')) return;
                  onOpenPost(parent);
                }}
              >
                <div className="flex flex-col items-center">
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      onOpenProfile(parent, e.currentTarget);
                    }}
                    className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-white/10"
                  >
                    <SourceAvatar
                      name={parent.name}
                      src={parent.avatar || null}
                      profileUrl={pUrl}
                      referer={pUrl}
                      lazyHydrate
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </button>
                  <div className="tl-x-thread-line" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1 pb-4">
                  <div className="flex items-center gap-1.5 text-sm">
                    <strong className="truncate font-bold text-[var(--tl-text-primary)]">{parent.name}</strong>
                    {parent.verified && <VerifiedSealIcon size={14} className="shrink-0 text-[#1d9bf0]" />}
                    <span className="truncate text-[var(--tl-text-muted)]">@{pHandle}</span>
                    {parent.date && <span className="text-xs text-[var(--tl-text-muted)]">· {formatXRelativeTime(parent.date, isEn)}</span>}
                  </div>
                  <XRichText
                    text={parent.text}
                    className="mt-1 text-[15px] leading-relaxed text-[var(--tl-text-primary)]"
                    onOpenHandle={(h, trigger) => onOpenProfile({ handle: h, name: h }, trigger)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Focal Post Main Block */}
      <article className="tl-x-focal-post">
        {/* Author Row */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={e => onOpenProfile(authorProfile || focalPost, e.currentTarget)}
            className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-white/15 bg-white/10"
          >
            <SourceAvatar
              name={authorProfile?.name || focalPost.name}
              src={authorProfile?.avatar || focalPost.avatar || null}
              profileUrl={profileUrl}
              referer={profileUrl}
              hydrate
              alt=""
              className="h-full w-full object-cover"
            />
          </button>

          <button
            type="button"
            onClick={e => onOpenProfile(authorProfile || focalPost, e.currentTarget)}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[15px] font-extrabold text-[var(--tl-text-primary)] hover:underline">
                {authorProfile?.name || focalPost.name}
              </span>
              {(authorProfile?.verified || focalPost.verified) && (
                <VerifiedSealIcon size={16} className="shrink-0 text-[#1d9bf0]" />
              )}
            </div>
            <span className="block truncate text-[13px] text-[var(--tl-text-muted)]">@{cleanHandle}</span>
          </button>

          <button
            type="button"
            aria-pressed={isFollowed}
            onClick={() => {
              const snap: TimelineCreator = {
                id: creatorId,
                name: authorProfile?.name || focalPost.name || cleanHandle,
                handle: `@${cleanHandle}`,
                avatar: authorProfile?.avatar || focalPost.avatar || '',
                banner: authorProfile?.banner || focalPost.banner,
                profileUrl,
                site: 'x',
                verified: Boolean(authorProfile?.verified || focalPost.verified),
                bio: authorProfile?.bio || focalPost.bio,
                stats: {
                  followers:
                    (authorProfile?.followers ?? focalPost.followers) != null
                      ? String(authorProfile?.followers ?? focalPost.followers)
                      : undefined,
                },
              };
              toggleFollowCreator(snap);
            }}
            className={`tl-x-follow-btn ${isFollowed ? 'is-following' : ''}`}
          >
            {isFollowed ? <UserCheck size={14} /> : <UserPlus size={14} />}
            <span>{isFollowed ? (isEn ? 'Following' : 'Seguindo') : isEn ? 'Follow' : 'Seguir'}</span>
          </button>
        </div>

        {/* Focal Copy */}
        <XRichText
          text={focalPost.text}
          className="mt-3.5 text-[17px] leading-[1.52] text-[var(--tl-text-primary)]"
          onOpenHandle={(h, trigger) => onOpenProfile({ handle: h, name: h }, trigger)}
        />

        {/* Quoted Post if present */}
        {focalPost.relation?.kind === 'quote' && focalPost.relation.post && (
          <div className="tl-post-reference mt-3">
            <div className="flex items-center gap-1.5 text-xs">
              <strong className="text-[var(--tl-text-primary)]">
                {focalPost.relation.post.creatorName || focalPost.relation.post.creatorHandle}
              </strong>
              {focalPost.relation.post.creatorHandle && (
                <span className="text-[var(--tl-text-muted)]">{focalPost.relation.post.creatorHandle}</span>
              )}
            </div>
            {focalPost.relation.post.text && (
              <p className="text-sm leading-relaxed text-[var(--tl-text-primary)]">{focalPost.relation.post.text}</p>
            )}
            {focalPost.relation.post.photos && focalPost.relation.post.photos.length > 0 && (
              <XMediaGrid
                photos={focalPost.relation.post.photos}
                sourceUrl={focalPost.relation.post.originalUrl}
                authorName={focalPost.relation.post.creatorName || 'X'}
                isEn={isEn}
                onOpenPhoto={idx => onOpenPhoto(focalPost, idx)}
              />
            )}
          </div>
        )}

        {/* Focal Media (Natural full-width X rounding, using ImageX UniversalVideoPlayer) */}
        {(focalPost.photos.length > 0 || focalPost.video || focalPost.hasVideo) && (
          <div className="mt-3.5">
            <XMediaGrid
              photos={focalPost.photos}
              video={focalPost.video}
              poster={focalPost.poster}
              hasVideo={focalPost.hasVideo}
              postId={focalPost.id}
              postKey={postKey}
              handle={cleanHandle}
              title={focalPost.text || focalPost.name}
              sourceUrl={focalPost.url}
              authorName={focalPost.name}
              authorAvatar={authorProfile?.avatar || focalPost.avatar}
              density="cinema"
              isEn={isEn}
              onOpenPhoto={idx => onOpenPhoto(focalPost, idx)}
              onOpenWatch={
                onOpenVideo
                  ? (handoff, resolvedVideoUrl) =>
                      onOpenVideo(
                        {
                          ...buildXTimelinePostSnapshot(focalPost, postKey, isLiked, isFavorited),
                          type: 'video',
                          videoUrl: resolvedVideoUrl,
                          qualities: [{ label: 'HD', height: 1080, streamUrl: resolvedVideoUrl }],
                        },
                        handoff
                      )
                  : undefined
              }
            />
          </div>
        )}

        {/* Timestamp & Views Metadata Line (5:45 PM · Aug 19, 2026 · 11.6K Views) */}
        <div className="tl-x-focal-meta">
          {focalPost.date && (
            <time dateTime={focalPost.date}>{formatXFocalTimestamp(focalPost.date, isEn)}</time>
          )}
          {focalPost.metrics.views != null && (
            <>
              <span>·</span>
              <span>
                <strong className="font-bold text-[var(--tl-text-primary)]">
                  {formatCompactCount(focalPost.metrics.views)}
                </strong>{' '}
                {isEn ? 'Views' : 'Visualizações'}
              </span>
            </>
          )}
        </div>

        {/* Interactive 5-Action Bar (evenly spaced like X) */}
        <div className="tl-x-focal-actions">
          <button
            type="button"
            onClick={() => replyInputRef.current?.focus()}
            aria-label={isEn ? 'Reply to post' : 'Responder publicação'}
            className="tl-x-metric-pill tl-x-metric-pill--reply"
          >
            <XReplySvg size={19} />
            <span className="font-mono">{formatCompactCount(displayRepliesCount)}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setIsReposted(prev => {
                const next = !prev;
                const map = readStoredReposts();
                if (next) map[postKey] = true;
                else delete map[postKey];
                writeStoredReposts(map);
                return next;
              });
            }}
            aria-pressed={isReposted}
            aria-label={isEn ? 'Repost' : 'Republicar'}
            className={`tl-x-metric-pill tl-x-metric-pill--repost ${isReposted ? 'is-active' : ''}`}
          >
            <XRepostSvg size={19} />
            <span className="font-mono">{formatCompactCount(displayRepostsCount)}</span>
          </button>

          <button
            type="button"
            onClick={() => toggleLike(postKey, buildXTimelinePostSnapshot(focalPost, postKey, isLiked, isFavorited))}
            aria-pressed={isLiked}
            aria-label={isEn ? 'Like post' : 'Curtir publicação'}
            className={`tl-x-metric-pill tl-x-metric-pill--like ${isLiked ? 'is-active' : ''}`}
          >
            <XHeartSvg size={19} filled={isLiked} />
            <span className="font-mono">{formatCompactCount(displayLikesCount)}</span>
          </button>

          <button
            type="button"
            onClick={() => toggleFavorite(postKey, buildXTimelinePostSnapshot(focalPost, postKey, isLiked, isFavorited))}
            aria-pressed={isFavorited}
            aria-label={isEn ? 'Bookmark post' : 'Salvar nos favoritos'}
            className={`tl-x-metric-pill tl-x-metric-pill--bookmark ${isFavorited ? 'is-active' : ''}`}
          >
            <XBookmarkSvg size={19} filled={isFavorited} />
            {displayBookmarksCount != null && <span className="font-mono">{formatCompactCount(displayBookmarksCount)}</span>}
          </button>

          <button
            type="button"
            onClick={() => {
              if (navigator.clipboard?.writeText) {
                void navigator.clipboard.writeText(focalPost.url);
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              }
            }}
            aria-label={isEn ? 'Share post' : 'Compartilhar publicação'}
            className="tl-x-metric-pill tl-x-metric-pill--share"
          >
            {copied ? <Check size={18} className="text-emerald-400" /> : <XShareSvg size={19} />}
          </button>
        </div>
      </article>

      {/* Reply Sort Controls + Inline "Post your reply" Composer */}
      <div className="tl-x-reply-composer-section">
        <div className="flex items-center justify-between gap-2 pb-2.5">
          <div className="flex items-center gap-1.5">
            {(['relevant', 'recent', 'liked'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                aria-pressed={sortMode === mode}
                onClick={() => setSortMode(mode)}
                className={`rounded-full px-3 py-1 text-xs font-bold transition-colors ${
                  sortMode === mode
                    ? 'bg-white/12 text-[var(--tl-text-primary)]'
                    : 'text-[var(--tl-text-muted)] hover:bg-white/[0.05] hover:text-[var(--tl-text-secondary)]'
                }`}
              >
                {mode === 'relevant'
                  ? isEn
                    ? 'Relevant'
                    : 'Relevantes'
                  : mode === 'recent'
                    ? isEn
                      ? 'Recent'
                      : 'Recentes'
                    : isEn
                      ? 'Most liked'
                      : 'Mais curtidas'}
              </button>
            ))}
          </div>
          {loading && (
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--tl-text-muted)]">
              <Loader2 size={13} className="animate-spin text-[#1d9bf0]" />
              {isEn ? 'Loading replies from X…' : 'Carregando respostas do X…'}
            </span>
          )}
        </div>

        <form onSubmit={handleReplySubmit} className="tl-x-reply-composer">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1d9bf0]/15 text-xs font-extrabold text-[#1d9bf0]">
            {isEn ? 'You' : 'Vc'}
          </span>
          <input
            ref={replyInputRef}
            type="text"
            value={replyDraft}
            onChange={e => setReplyDraft(e.target.value)}
            placeholder={isEn ? 'Post your reply' : 'Postar sua resposta'}
            aria-label={isEn ? 'Post your reply' : 'Postar sua resposta'}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--tl-text-primary)] placeholder:text-[var(--tl-text-muted)] outline-none"
          />
          <button
            type="submit"
            disabled={!replyDraft.trim()}
            className="rounded-full bg-[#1d9bf0] px-4 py-1.5 text-xs font-extrabold text-white transition-opacity hover:bg-[#1a8cd8] disabled:opacity-40"
          >
            {isEn ? 'Reply' : 'Responder'}
          </button>
        </form>
      </div>

      {/* Thread Replies List */}
      <div className="tl-x-replies-list" data-x-replies-list>
        {/* User's own local replies posted in ImageX */}
        {userComments.map((c, idx) => (
          <article key={`local-reply-${idx}`} className="tl-x-reply-row">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1d9bf0]/15 text-xs font-extrabold text-[#1d9bf0]">
              {isEn ? 'You' : 'Vc'}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-1.5 text-sm">
                <strong className="font-bold text-[var(--tl-text-primary)]">{c.author}</strong>
                <span className="text-[var(--tl-text-muted)]">{c.handle || '@you'}</span>
                <span className="text-[var(--tl-text-muted)]">·</span>
                <span className="text-xs text-[var(--tl-text-muted)]">{c.time}</span>
              </div>
              <p className="text-xs text-[var(--tl-text-muted)]">
                {isEn ? 'Replying to' : 'Respondendo a'} <span className="text-[#1d9bf0]">@{cleanHandle}</span>
              </p>
              <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-[var(--tl-text-primary)]">
                {c.text}
              </p>
            </div>
          </article>
        ))}

        {/* Live X Replies */}
        {sortedReplies.map(reply => (
          <XReplyRow
            key={reply.id}
            reply={reply}
            replyingToHandle={cleanHandle}
            isEn={isEn}
            onOpenProfile={onOpenProfile}
            onOpenPost={onOpenPost}
            onOpenPhoto={onOpenPhoto}
          />
        ))}

        {/* Loading skeleton when fetching first replies */}
        {loading && sortedReplies.length === 0 && (
          <div className="space-y-4 p-4">
            {[0, 1].map(i => (
              <div key={i} className="flex animate-pulse gap-3">
                <div className="h-10 w-10 shrink-0 rounded-full bg-white/10" />
                <div className="flex-1 space-y-2 py-1">
                  <div className="h-3 w-40 rounded bg-white/10" />
                  <div className="h-3 w-4/5 rounded bg-white/10" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Helpful Empty / Reload Extension Notice */}
        {!loading && sortedReplies.length === 0 && userComments.length === 0 && (
          <div className="p-6 text-center space-y-2.5">
            <p className="text-sm font-semibold text-[var(--tl-text-secondary)]">
              {extensionNeedsReload
                ? isEn
                  ? 'Your Chrome extension IMAGEX · X was updated — reload it once in chrome://extensions (v1.2.0) to enable live X replies & Explore, or click Connect X below.'
                  : 'Sua extensão IMAGEX · X foi atualizada — recarregue-a uma vez em chrome://extensions (v1.2.0) para ativar respostas e Explorar ao vivo, ou clique em Conectar X abaixo.'
                : extensionHint
                  ? isEn
                    ? 'Live X replies require an active X session — click Connect X below or reload the IMAGEX · X extension in chrome://extensions.'
                    : 'Respostas ao vivo do X precisam de uma sessão ativa do X — clique em Conectar X abaixo ou recarregue a extensão IMAGEX · X em chrome://extensions.'
                  : isEn
                    ? 'No replies loaded for this post yet.'
                    : 'Nenhuma resposta carregada para esta publicação ainda.'}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {(extensionHint || extensionNeedsReload) && (
                <button
                  type="button"
                  onClick={() => refresh(true)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#1d9bf0] px-4 py-1.5 text-xs font-extrabold text-white hover:bg-[#1a8cd8]"
                >
                  <XBrandIcon size={12} />
                  {isEn ? 'Connect X & load replies' : 'Conectar X e carregar respostas'}
                </button>
              )}
              <button
                type="button"
                onClick={() => refresh(false)}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] px-3.5 py-1.5 text-xs font-bold text-[var(--tl-text-primary)] hover:bg-[var(--tl-surface-hover)]"
              >
                <RefreshCw size={13} />
                {isEn ? 'Retry loading replies' : 'Tentar carregar respostas'}
              </button>
              <a
                href={focalPost.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1d9bf0]/15 px-3.5 py-1.5 text-xs font-bold text-[#1d9bf0] hover:bg-[#1d9bf0]/25"
              >
                <ExternalLink size={13} />
                {isEn ? 'View thread on X' : 'Ver thread no X'}
              </a>
            </div>
          </div>
        )}

        {/* Load More Replies Button */}
        {hasMore && !loading && (
          <div className="flex justify-center p-4">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-2 rounded-full border border-[var(--tl-border-strong)] bg-[var(--tl-surface-elevated)] px-5 py-2 text-xs font-bold text-[#1d9bf0] hover:bg-[var(--tl-surface-hover)] disabled:opacity-50"
            >
              {loadingMore && <Loader2 size={14} className="animate-spin" />}
              {isEn ? 'Show more replies' : 'Mostrar mais respostas'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * X-style Split Photo + Thread Modal (mirrors clicking an image on X.com:
 * full-res photo on the left theater stage, post + live replies on the right).
 */
export function XPhotoThreadModal({
  post,
  initialIndex,
  isEn,
  onClose,
  onOpenProfile,
  onOpenPostDetail,
}: {
  post: XPost;
  initialIndex: number;
  isEn: boolean;
  onClose: () => void;
  onOpenProfile: (account: XAccount, trigger: HTMLElement) => void;
  onOpenPostDetail: (post: XPost) => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const thread = useXPostThread(post, true);
  const focalPost = thread?.focalPost || post;
  const photos = focalPost.photos.filter(Boolean);
  const currentUrl = photos[Math.min(index, Math.max(0, photos.length - 1))] || '';
  const cleanHandle = focalPost.handle.replace(/^@/, '');
  const postKey = `live-x:${focalPost.id}`;
  const profileUrl = `https://x.com/${encodeURIComponent(cleanHandle)}`;
  const [replyDraft, setReplyDraft] = useState('');

  const { isLiked, isFavorited, userComments, toggleLike, toggleFavorite, addComment } = useProfileTimelineStore(
    useShallow(state => ({
      isLiked: Boolean(state.likedPostIds[postKey]),
      isFavorited: Boolean(state.favoritedPostIds[postKey]),
      userComments: state.userComments[postKey] || [],
      toggleLike: state.toggleLike,
      toggleFavorite: state.toggleFavorite,
      addComment: state.addComment,
    }))
  );
  const [isReposted, setIsReposted] = useState<boolean>(() => Boolean(readStoredReposts()[postKey]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setIndex(i => Math.min(photos.length - 1, i + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, photos.length]);

  const likesVal = focalPost.metrics.likes != null ? focalPost.metrics.likes + (isLiked ? 1 : 0) : isLiked ? 1 : null;
  const repostsVal = focalPost.metrics.reposts != null ? focalPost.metrics.reposts + (isReposted ? 1 : 0) : isReposted ? 1 : null;
  const repliesVal =
    focalPost.metrics.replies != null
      ? Math.max(focalPost.metrics.replies, thread?.replies.length || 0) + userComments.length
      : (thread?.replies.length || 0) + userComments.length || null;

  return (
    <div
      className="fixed inset-0 z-[70] flex bg-black/92 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label={isEn ? 'X Post media viewer' : 'Visualizador de mídia do X'}
      onClick={onClose}
    >
      {/* Left Theater Stage: Full Image + Carousel Controls + Action Bar */}
      <div
        className="relative flex flex-1 flex-col items-center justify-center p-4 sm:p-8 min-w-0"
        onClick={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={isEn ? 'Close' : 'Fechar'}
          className="absolute left-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/70 text-white hover:bg-white/15"
        >
          <X size={20} />
        </button>

        {photos.length > 1 && index > 0 && (
          <button
            type="button"
            onClick={() => setIndex(i => Math.max(0, i - 1))}
            aria-label={isEn ? 'Previous photo' : 'Foto anterior'}
            className="absolute left-4 top-1/2 z-10 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-black/70 text-white hover:bg-white/20"
          >
            <ChevronLeft size={22} />
          </button>
        )}

        <div className="flex max-h-[82vh] max-w-full flex-1 items-center justify-center overflow-hidden">
          {currentUrl && (
            <XMediaImage
              src={currentUrl}
              sourceUrl={focalPost.url}
              alt={focalPost.name}
              className="max-h-[82vh] max-w-full rounded-xl object-contain"
            />
          )}
        </div>

        {photos.length > 1 && index < photos.length - 1 && (
          <button
            type="button"
            onClick={() => setIndex(i => Math.min(photos.length - 1, i + 1))}
            aria-label={isEn ? 'Next photo' : 'Próxima foto'}
            className="absolute right-4 top-1/2 z-10 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-black/70 text-white hover:bg-white/20"
          >
            <ChevronRight size={22} />
          </button>
        )}

        {/* Bottom Theater Action Bar */}
        <div className="mt-4 flex items-center gap-6 rounded-full bg-white/[0.06] px-6 py-2 text-white/85">
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenPostDetail(focalPost);
            }}
            className="tl-x-metric-pill tl-x-metric-pill--reply text-white/85"
          >
            <XReplySvg size={18} />
            <span className="font-mono">{formatCompactCount(repliesVal)}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setIsReposted(prev => {
                const next = !prev;
                const map = readStoredReposts();
                if (next) map[postKey] = true;
                else delete map[postKey];
                writeStoredReposts(map);
                return next;
              });
            }}
            aria-pressed={isReposted}
            className={`tl-x-metric-pill tl-x-metric-pill--repost ${isReposted ? 'is-active' : 'text-white/85'}`}
          >
            <XRepostSvg size={18} />
            <span className="font-mono">{formatCompactCount(repostsVal)}</span>
          </button>
          <button
            type="button"
            onClick={() => toggleLike(postKey, buildXTimelinePostSnapshot(focalPost, postKey, isLiked, isFavorited))}
            aria-pressed={isLiked}
            className={`tl-x-metric-pill tl-x-metric-pill--like ${isLiked ? 'is-active' : 'text-white/85'}`}
          >
            <XHeartSvg size={18} filled={isLiked} />
            <span className="font-mono">{formatCompactCount(likesVal)}</span>
          </button>
          <button
            type="button"
            onClick={() => toggleFavorite(postKey, buildXTimelinePostSnapshot(focalPost, postKey, isLiked, isFavorited))}
            aria-pressed={isFavorited}
            className={`tl-x-metric-pill tl-x-metric-pill--bookmark ${isFavorited ? 'is-active' : 'text-white/85'}`}
          >
            <XBookmarkSvg size={18} filled={isFavorited} />
          </button>
        </div>
      </div>

      {/* Right Split Thread Panel (Desktop, mirrors X's Photo + Replies side column) */}
      <aside
        className="hidden lg:flex w-[390px] shrink-0 flex-col border-l border-white/12 bg-[var(--tl-bg)] text-[var(--tl-text-primary)] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--tl-border)] space-y-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={e => {
                onClose();
                onOpenProfile(thread?.authorProfile || focalPost, e.currentTarget);
              }}
              className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-white/10"
            >
              <SourceAvatar
                name={focalPost.name}
                src={thread?.authorProfile?.avatar || focalPost.avatar || null}
                profileUrl={profileUrl}
                referer={profileUrl}
                hydrate
                alt=""
                className="h-full w-full object-cover"
              />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <strong className="truncate text-sm font-bold">{focalPost.name}</strong>
                {focalPost.verified && <VerifiedSealIcon size={14} className="shrink-0 text-[#1d9bf0]" />}
              </div>
              <span className="block truncate text-xs text-[var(--tl-text-muted)]">@{cleanHandle}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenPostDetail(focalPost);
              }}
              className="rounded-full border border-[var(--tl-border-strong)] px-3 py-1 text-[11px] font-bold text-[#1d9bf0] hover:bg-white/[0.06]"
            >
              {isEn ? 'Open thread' : 'Abrir thread'}
            </button>
          </div>

          <XRichText
            text={focalPost.text}
            className="text-[15px] leading-relaxed text-[var(--tl-text-primary)]"
          />

          <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--tl-text-muted)]">
            {focalPost.date && <time dateTime={focalPost.date}>{formatXFocalTimestamp(focalPost.date, isEn)}</time>}
            {focalPost.metrics.views != null && (
              <>
                <span>·</span>
                <span>
                  <strong className="text-[var(--tl-text-primary)]">{formatCompactCount(focalPost.metrics.views)}</strong>{' '}
                  {isEn ? 'Views' : 'Visualizações'}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Inline Reply Composer */}
        <form
          onSubmit={e => {
            e.preventDefault();
            if (!replyDraft.trim()) return;
            addComment(postKey, replyDraft.trim());
            setReplyDraft('');
          }}
          className="flex items-center gap-2 border-b border-[var(--tl-border)] p-3.5"
        >
          <input
            type="text"
            value={replyDraft}
            onChange={e => setReplyDraft(e.target.value)}
            placeholder={isEn ? 'Post your reply' : 'Postar sua resposta'}
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--tl-text-primary)] placeholder:text-[var(--tl-text-muted)] outline-none"
          />
          <button
            type="submit"
            disabled={!replyDraft.trim()}
            className="rounded-full bg-[#1d9bf0] px-3.5 py-1 text-xs font-bold text-white disabled:opacity-40"
          >
            {isEn ? 'Reply' : 'Responder'}
          </button>
        </form>

        {/* Live Replies inside Photo Split Panel */}
        <div className="divide-y divide-[var(--tl-border)]">
          {userComments.map((c, idx) => (
            <div key={`modal-local-${idx}`} className="p-3.5 space-y-1">
              <div className="flex items-center gap-1.5 text-xs">
                <strong className="font-bold">{c.author}</strong>
                <span className="text-[var(--tl-text-muted)]">· {c.time}</span>
              </div>
              <p className="text-sm text-[var(--tl-text-primary)]">{c.text}</p>
            </div>
          ))}
          {(thread?.replies || []).map(reply => (
            <XReplyRow
              key={reply.id}
              reply={reply}
              replyingToHandle={cleanHandle}
              isEn={isEn}
              onOpenProfile={(acc, trigger) => {
                onClose();
                onOpenProfile(acc, trigger);
              }}
              onOpenPost={p => {
                onClose();
                onOpenPostDetail(p);
              }}
              onOpenPhoto={(p, idx) => {
                onClose();
                onOpenPostDetail(p);
                void idx;
              }}
            />
          ))}
          {thread?.loading && (thread?.replies.length || 0) === 0 && (
            <div className="flex items-center justify-center gap-2 p-6 text-xs text-[var(--tl-text-muted)]">
              <Loader2 size={15} className="animate-spin text-[#1d9bf0]" />
              {isEn ? 'Loading replies…' : 'Carregando respostas…'}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
