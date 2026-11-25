const EXTENSION_ID = 'kioakhgfaddkgkogalnnbppmnkdgjdlj';
type ConnectorResponse = {
  ok?: boolean;
  version?: string;
  scopes?: string[];
  error?: string;
  status?: string;
  items?: unknown[];
  profile?: unknown;
  trends?: unknown[];
  relevantPeople?: unknown[];
};
type ExternalRuntime = {
  lastError?: { message?: string };
  sendMessage: (id: string, query: unknown, callback: (result?: ConnectorResponse) => void) => void;
};

let dedicatedBrowserConnected = false;

export async function pingXExtension(signal?: AbortSignal): Promise<{
  installed: boolean;
  version?: string;
  scopes?: string[];
}> {
  const runtime = (window as Window & { chrome?: { runtime?: ExternalRuntime } }).chrome?.runtime;
  if (
    !runtime?.sendMessage ||
    !['127.0.0.1', 'localhost'].includes(window.location.hostname) ||
    window.location.port !== '8100'
  ) {
    return { installed: false };
  }
  const result = await new Promise<ConnectorResponse | undefined>(resolve => {
    let settled = false;
    const done = (value?: ConnectorResponse) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(value);
    };
    const cancel = () => done(undefined);
    const timer = window.setTimeout(() => done(undefined), 1500);
    signal?.addEventListener('abort', cancel, { once: true });
    runtime.sendMessage(EXTENSION_ID, { type: 'imagex-x-ping' }, res => {
      if (runtime.lastError) done(undefined);
      else done(res);
    });
  });
  if (result?.ok) {
    return { installed: true, version: result.version, scopes: result.scopes };
  }
  return { installed: false };
}

export function proxyXVideoUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('/api/profile-hub/timeline/x-video-stream')) return trimmed;
  if (/^https?:\/\/(?:video|pbs|ton)\.twimg\.com\//i.test(trimmed)) {
    return `/api/profile-hub/timeline/x-video-stream?url=${encodeURIComponent(trimmed)}`;
  }
  return trimmed;
}

export async function isXDedicatedBrowserConnected(signal?: AbortSignal): Promise<boolean> {
  try {
    const resp = await fetch('/api/social-timeline/x/status', { signal });
    if (!resp.ok) return dedicatedBrowserConnected;
    const data = await resp.json();
    if (typeof data?.connected === 'boolean') {
      dedicatedBrowserConnected = data.connected;
      return data.connected;
    }
  } catch {
    // Ignore offline/aborted checks
  }
  return dedicatedBrowserConnected;
}

export type XSearchTab = 'top' | 'people' | 'videos' | 'latest' | 'photos';

export type LiveXBatchQuery = {
  cursor: string;
  scope: string;
  handle?: string;
  postId?: string;
  searchQuery?: string;
  searchTab?: XSearchTab;
  backgroundOnly?: boolean;
};

export async function readLiveX(
  offset: number,
  query: LiveXBatchQuery,
  signal: AbortSignal,
  allowDedicatedBrowser = false,
) {
  const normalizedQuery = {
    ...query,
    ...(query.handle ? { handle: query.handle.trim().replace(/^@+/, '') } : {}),
    ...(query.postId ? { postId: query.postId.trim() } : {}),
    ...(query.searchQuery !== undefined ? { searchQuery: query.searchQuery.trim() } : {}),
  };

  let extensionSawUnsupportedScope = false;
  const runtime = (window as Window & { chrome?: { runtime?: ExternalRuntime } }).chrome?.runtime;
  if (runtime?.sendMessage && ['127.0.0.1', 'localhost'].includes(window.location.hostname) &&
      window.location.port === '8100') {
    const browserBatch = await new Promise<ConnectorResponse | undefined>(resolve => {
      let settled = false;
      const done = (value?: ConnectorResponse) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve(value);
      };
      const cancel = () => done(undefined);
      const timer = window.setTimeout(() => done(undefined), 28000);
      signal.addEventListener('abort', cancel, { once: true });
      runtime.sendMessage(EXTENSION_ID, { type: 'imagex-x-batch', offset, ...normalizedQuery }, result => {
        if (runtime.lastError) {
          done(undefined);
        } else {
          done(result);
        }
      });
    });
    signal.throwIfAborted();
    if (browserBatch) {
      if (browserBatch.error) {
        if (['unsupported_scope', 'invalid_scope'].includes(browserBatch.error)) {
          extensionSawUnsupportedScope = true;
        } else {
          throw new Error(browserBatch.error);
        }
      } else {
        return browserBatch;
      }
    }
  }

  let canUseDedicated = allowDedicatedBrowser || dedicatedBrowserConnected;
  if (!canUseDedicated && (normalizedQuery.scope === 'post' || normalizedQuery.scope === 'explore' || normalizedQuery.scope === 'search')) {
    canUseDedicated = await isXDedicatedBrowserConnected(signal);
  }
  if (!canUseDedicated) {
    throw new Error(extensionSawUnsupportedScope ? 'extension_reload_required' : 'connection_required');
  }

  const response = await fetch(`/api/social-timeline/x/batch/${offset}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...normalizedQuery, advance: offset > 0 }),
    signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'source_unavailable');
  dedicatedBrowserConnected = true;
  return body;
}
