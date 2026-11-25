import type { TimelineBrowseSourceCapability } from '../../../services/timelineBrowse';
import type { TimelinePlatform } from './timelineModel';

export type IntegratedSourcesStatus = 'idle' | 'loading' | 'loaded' | 'unavailable';

export interface IntegratedSourceRecord {
  id: string;
  displayName: string;
  originUrl: string;
  domains: string[];
  kind: 'builtin' | 'connector' | string;
  addedVia: string;
  integratedAt: string;
}

export interface UrlIntegrationDescriptor {
  ok: boolean;
  matched: boolean;
  supported: boolean;
  sourceId?: string;
  displayName?: string;
  kind?: string;
  originUrl?: string;
  domains?: string[];
  level?: 'network' | 'profile' | 'item';
  targetUrl?: string;
  suggestedHandle?: string | null;
  iconKind?: string;
  alreadyIntegrated?: boolean;
  autoDiscovered?: boolean;
  reason?: string;
  host?: string;
}

export interface IntegrateUrlResult {
  ok: boolean;
  matched: boolean;
  supported: boolean;
  reason?: string;
  host?: string;
  integration?: UrlIntegrationDescriptor;
  sources: IntegratedSourceRecord[];
  /** Present when level === 'profile' and the app can immediately open or scan the target URL. */
  targetProfileUrl?: string | null;
}

export interface DeriveActiveSourcesInput {
  integratedSources: readonly IntegratedSourceRecord[];
  integratedSourcesStatus: IntegratedSourcesStatus;
  browseCapabilities: Record<string, TimelineBrowseSourceCapability>;
  creatorSites: Iterable<string | null | undefined>;
  postSources: Iterable<string | null | undefined>;
  activeSource?: string | null;
}

/**
 * Computes strictly active Timeline source pills from explicit user integrations,
 * imported/saved creator records, and loaded feed posts.
 * Zero built-in platforms are ever added by default.
 */
export function deriveActiveTimelineSources(input: DeriveActiveSourcesInput): Set<TimelinePlatform> {
  const result = new Set<TimelinePlatform>(['all']);

  for (const row of input.integratedSources || []) {
    const sid = String(row?.id || '').trim().toLowerCase();
    if (sid) result.add(sid);
  }

  // Only allow mocked browseCapabilities without explicit /integrated-sources
  // when backend opt-in endpoint is unavailable (e.g. offline static Playwright tests).
  if (input.integratedSourcesStatus === 'unavailable') {
    for (const sid of Object.keys(input.browseCapabilities || {})) {
      const norm = String(sid || '').trim().toLowerCase();
      if (norm) result.add(norm);
    }
  } else {
    for (const sid of Object.keys(input.browseCapabilities || {})) {
      const norm = String(sid || '').trim().toLowerCase();
      if (norm && input.integratedSources.some((row) => row.id.toLowerCase() === norm)) {
        result.add(norm);
      }
    }
  }

  for (const site of input.creatorSites || []) {
    const norm = String(site || '').trim().toLowerCase();
    if (norm) result.add(norm);
  }

  for (const pSource of input.postSources || []) {
    const norm = String(pSource || '').trim().toLowerCase();
    if (norm && norm !== 'all') result.add(norm);
  }

  const current = String(input.activeSource || '').trim().toLowerCase();
  if (current && current !== 'all') {
    result.add(current);
  }

  return result;
}

/**
 * Pure headroom state machine for retracting mobile top chrome when scrolling down
 * and revealing it on upward scroll, top-of-feed, or active search/sheet locks.
 */
export function computeMobileChromeCollapsed(
  currentCollapsed: boolean,
  scrollTop: number,
  prevScrollTop: number,
  lockedOpen: boolean
): boolean {
  if (lockedOpen || scrollTop <= 16) return false;
  const delta = scrollTop - prevScrollTop;
  if (!currentCollapsed && scrollTop > 48 && delta >= 14) return true;
  if (currentCollapsed && prevScrollTop - scrollTop >= 12) return false;
  return currentCollapsed;
}

/**
 * Evaluates swipe-down gesture displacement/velocity on a Bottom Sheet handle/header,
 * preventing dismissal while an inner list still has downward scroll offset.
 */
export function computeBottomSheetDismiss(
  dragY: number,
  velocityY: number,
  innerScrollTop: number,
  thresholdPx = 90
): { activeDragY: number; shouldDismiss: boolean } {
  if (innerScrollTop > 0 || dragY <= 0) {
    return { activeDragY: 0, shouldDismiss: false };
  }
  const activeDragY = Math.round(dragY);
  const shouldDismiss = activeDragY >= thresholdPx || (activeDragY >= 28 && velocityY >= 0.45);
  return { activeDragY, shouldDismiss };
}
