const VERSION = '1.3.0';
const HOME = 'https://x.com/home';
const EXPLORE = 'https://x.com/explore';
const HANDLE = /^[a-z0-9_]{1,15}$/i;
const POST_ID = /^\d{5,22}$/;
const CURSOR = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const origins = new Set(['http://127.0.0.1:8100', 'http://localhost:8100']);
const scopes = new Set(['recommended', 'following', 'explore', 'accounts', 'profile', 'post', 'search']);
const searchTabs = new Set(['top', 'people', 'videos', 'latest', 'photos']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readPage(tab, query) {
  // Tabs can respond only after Chrome starts the X content script on the new page.
  const deadline = Date.now() + 26000;
  while (Date.now() < deadline) {
    try {
      const result = await chrome.tabs.sendMessage(tab, query, { frameId: 0 });
      if (result?.error !== 'waiting_for_accounts') return result;
    } catch {
    }
    await delay(250);
  }
  return { error: 'source_timeout' };
}

function buildSearchUrl(searchQuery, searchTab) {
  const base = `https://x.com/search?q=${encodeURIComponent(searchQuery.trim())}&src=typed_query`;
  const tabMap = { top: '', people: '&f=user', videos: '&f=video', latest: '&f=live', photos: '&f=image' };
  return base + (tabMap[searchTab] || '');
}

async function batch(owner, { cursor, offset, scope, handle = '', postId = '', searchQuery = '', searchTab = 'top', backgroundOnly = false }) {
  const key = `feed:${owner}:${cursor}`;
  let feed = (await chrome.storage.session.get(key))[key];
  if (feed) {
    if (
      scope !== feed.scope ||
      handle !== feed.handle ||
      postId !== (feed.postId || '') ||
      searchQuery !== (feed.searchQuery || '') ||
      searchTab !== (feed.searchTab || 'top')
    ) return { error: 'cursor_mismatch' };
    if (offset === feed.offset) return feed.batch;
    if (offset !== feed.offset + 1) return { error: 'cursor_mismatch' };
    if (!await chrome.tabs.get(feed.tab).catch(() => null)) {
      await chrome.storage.session.remove(key);
      return { error: 'cursor_expired' };
    }
  } else {
    if (offset) return { error: 'cursor_expired' };
    const entries = Object.entries(await chrome.storage.session.get(null))
      .filter(([saved]) => saved.startsWith(`feed:${owner}:`));
    if (entries.length >= 10) {
      const searchEntries = entries.filter(([, entry]) => entry.scope === 'search');
      const pool = searchEntries.length ? searchEntries : entries;
      const [oldKey, oldFeed] = pool.reduce((oldest, entry) =>
        entry[1].touched < oldest[1].touched ? entry : oldest);
      await chrome.storage.session.remove(oldKey);
      await chrome.tabs.remove(oldFeed.tab).catch(() => {});
    }
    const url = scope === 'post'
      ? `https://x.com/${handle}/status/${postId}`
      : scope === 'profile'
        ? `https://x.com/${handle}`
        : scope === 'explore'
          ? EXPLORE
          : scope === 'search'
            ? buildSearchUrl(searchQuery, searchTab)
            : HOME;
    const tab = await chrome.tabs.create({ url, active: false, openerTabId: owner });
    feed = { tab: tab.id, scope, handle, postId, searchQuery, searchTab, backgroundOnly: Boolean(backgroundOnly || scope === 'search'), touched: Date.now(), offset: -1 };
    await chrome.storage.session.set({ [key]: feed });
  }

  const request = { type: 'imagex-x-read', scope, handle, postId, searchQuery, searchTab, advance: offset > 0 };
  let result = await readPage(feed.tab, request);
  if (result?.followingHandle && scope === 'accounts' && HANDLE.test(result.followingHandle)) {
    await chrome.tabs.update(feed.tab, { url: `https://x.com/${result.followingHandle}/following` });
    result = await readPage(feed.tab, { ...request, handle: result.followingHandle, expectAccounts: true });
  }
  if (result?.status === 'login_required') {
    if (feed.backgroundOnly || backgroundOnly || scope === 'search') {
      await chrome.storage.session.remove(key);
      await chrome.tabs.remove(feed.tab).catch(() => {});
    } else {
      await chrome.tabs.update(feed.tab, { active: true });
    }
    return result;
  }
  if (!result || result.error) return result || { error: 'source_unavailable' };
  await chrome.storage.session.set({
    [key]: { ...feed, offset, batch: result, touched: Date.now() },
  });
  return result;
}

const queues = new Map();
function enqueue(laneKey, task) {
  const prev = queues.get(laneKey) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  queues.set(laneKey, next);
  next.finally(() => {
    if (queues.get(laneKey) === next) queues.delete(laneKey);
  });
  return next;
}
chrome.runtime.onMessageExternal.addListener((query, sender, respond) => {
  if (!origins.has(sender.origin) || sender.frameId !== 0 || sender.tab?.id == null) return;
  if (query?.type === 'imagex-x-ping') {
    respond({ ok: true, version: VERSION, scopes: [...scopes] });
    return;
  }
  if (query?.type !== 'imagex-x-batch') {
    respond({ error: 'invalid_request' });
    return;
  }
  if (!scopes.has(query.scope)) {
    respond({ error: 'unsupported_scope' });
    return;
  }
  const cleanHandle = typeof query.handle === 'string' ? query.handle.trim().replace(/^@+/, '') : '';
  const cleanPostId = typeof query.postId === 'string' ? query.postId.trim() : '';
  const cleanSearchQuery = typeof query.searchQuery === 'string' ? query.searchQuery.trim() : '';
  const cleanSearchTab = typeof query.searchTab === 'string' && searchTabs.has(query.searchTab) ? query.searchTab : 'top';
  if (typeof query.cursor !== 'string' || !CURSOR.test(query.cursor) ||
      !Number.isSafeInteger(query.offset) || query.offset < 0 ||
      (query.scope === 'profile' && !HANDLE.test(cleanHandle)) ||
      (query.scope === 'post' && (!HANDLE.test(cleanHandle) || !POST_ID.test(cleanPostId))) ||
      (query.scope === 'search' && (!cleanSearchQuery || cleanSearchQuery.length > 200))) {
    respond({ error: 'invalid_request' });
    return;
  }
  const normalized = { ...query, handle: cleanHandle, postId: cleanPostId, searchQuery: cleanSearchQuery, searchTab: cleanSearchTab };
  const laneKey = normalized.scope === 'search'
    ? `${sender.tab.id}:search:${cleanSearchTab}:${cleanSearchQuery.toLowerCase()}`
    : `${sender.tab.id}:${normalized.scope}:${cleanHandle.toLowerCase()}:${cleanPostId}`;
  enqueue(laneKey, () => batch(sender.tab.id, normalized)).then(
    respond,
    () => respond({ error: 'source_unavailable' }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener(tab => {
  enqueue(`cleanup:${tab}`, async () => {
    const entries = Object.entries(await chrome.storage.session.get(null));
    for (const [key, feed] of entries) {
      if (key.startsWith(`feed:${tab}:`)) {
        await chrome.storage.session.remove(key);
        await chrome.tabs.remove(feed.tab).catch(() => {});
      } else if (feed.tab === tab) {
        await chrome.storage.session.remove(key);
      }
    }
  }).catch(() => {});
});
