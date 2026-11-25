// Run: node --test scripts/test_timeline_search_unit.cjs
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');

const front = path.resolve(__dirname, '../frontend-mobile-preview');
const esbuild = require(path.join(front, 'node_modules/esbuild'));

function loadSearchModules() {
  const bundle = esbuild.buildSync({
    stdin: {
      resolveDir: front,
      loader: 'ts',
      contents: `
        export * from './src/services/timelineSearch';
        export { mapPlaylistVideosToTimelinePosts } from './src/components/profile-hub/timeline/timelineModel';
      `,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logLevel: 'silent',
  });
  const mod = new Module('timeline-search-unit');
  mod._compile(bundle.outputFiles[0].text, path.join(front, 'timeline-search-unit.cjs'));
  return mod.exports;
}

test('mergeSearchSnapshot appends unbounded pages cleanly and deduplicates across sections', () => {
  const {
    createEmptySearchSnapshot,
    mergeSearchSnapshot,
    getDeduplicatedAllItems,
    filterSnapshotBySourceAndCategory,
  } = loadSearchModules();

  const page1Videos = Array.from({ length: 40 }, (_, i) => ({
    id: `yt-v-${i}`,
    creatorId: 'yt:@ch',
    creatorName: 'Channel',
    creatorHandle: '@ch',
    creatorAvatar: '',
    type: 'video',
    source: 'youtube',
    youtubeId: `vid_${i}`,
    originalUrl: `https://www.youtube.com/watch?v=vid_${i}`,
    title: `Luna Song ${i}`,
    comments: [],
    likes: null,
    date: '',
  }));
  const sharedXTweet = {
    id: 'omni-x-900',
    creatorId: 'x:lunafan',
    creatorName: 'Luna Fan',
    creatorHandle: '@lunafan',
    creatorAvatar: '',
    type: 'video',
    source: 'x',
    videoUrl: 'https://video.twimg.com/clip.mp4',
    originalUrl: 'https://x.com/lunafan/status/900',
    title: 'Luna clip',
    text: 'Luna clip on stage',
    comments: [],
    likes: 10,
    date: '2026-11-20T00:00:00Z',
  };

  let snap = createEmptySearchSnapshot('luna', ['youtube', 'x']);
  snap = mergeSearchSnapshot(snap, {
    query: 'luna',
    creators: [],
    posts: [...page1Videos, sharedXTweet],
    sections: {
      profiles: [],
      playlists: [],
      videos: [...page1Videos, sharedXTweet],
      shorts: [],
      albums: [],
      gifs: [],
      posts: [sharedXTweet],
    },
    cursors: { 'youtube:videos': { cursor: 'tok-p2', hasMore: true } },
    sourceStatus: {
      youtube: { ok: true, count: 40, hasMore: true },
      x: { ok: true, count: 1, hasMore: false },
    },
  });

  const page2Videos = [
    page1Videos[0], // duplicate across pages should be dropped
    ...Array.from({ length: 40 }, (_, i) => ({
      ...page1Videos[0],
      id: `yt-v-p2-${i}`,
      youtubeId: `vid_p2_${i}`,
      originalUrl: `https://www.youtube.com/watch?v=vid_p2_${i}`,
      title: `Luna Song Page 2 - ${i}`,
    })),
  ];

  snap = mergeSearchSnapshot(snap, {
    query: 'luna',
    creators: [],
    posts: page2Videos,
    sections: { profiles: [], playlists: [], videos: page2Videos, shorts: [], albums: [], gifs: [], posts: [] },
    cursors: { 'youtube:videos': { cursor: 'tok-p3', hasMore: true } },
    sourceStatus: { youtube: { ok: true, count: 40, hasMore: true } },
  });

  assert.equal(snap.videos.length, 81); // 40 yt p1 + 1 x + 40 yt p2, no artificial cap!
  const allView = getDeduplicatedAllItems(snap);
  const xOccurrences = allView.filter(item => item.id === 'omni-x-900');
  assert.equal(xOccurrences.length, 1);

  const filteredPosts = filterSnapshotBySourceAndCategory(snap, 'x', 'posts');
  assert.equal(filteredPosts.posts.length, 1);
  const filteredVideos = filterSnapshotBySourceAndCategory(snap, 'x', 'videos');
  assert.equal(filteredVideos.videos.length, 1);
});

test('classifyLocalSearchMatches finds Instagram, Slack, Pinterest and local posts without date suppression', () => {
  const { classifyLocalSearchMatches } = loadSearchModules();
  const localCreators = [
    {
      id: 'ig:luna.art',
      name: 'Luna Art',
      handle: '@luna.art',
      avatar: '',
      profileUrl: 'https://www.instagram.com/luna.art/',
      site: 'instagram',
    },
  ];
  const localPosts = [
    {
      id: 'ig-1',
      creatorId: 'ig:luna.art',
      creatorName: 'Luna Art',
      creatorHandle: '@luna.art',
      creatorAvatar: '',
      type: 'photo_grid',
      source: 'instagram',
      title: 'Sketch',
      caption: 'Luna concept sketch',
      photos: ['https://cdn.example/a.jpg'],
      originalUrl: 'https://www.instagram.com/p/abc/',
      comments: [],
      likes: null,
      date: '',
    },
    {
      id: 'slk-1',
      creatorId: 'slk:design',
      creatorName: 'Design Team',
      creatorHandle: '@design',
      creatorAvatar: '',
      type: 'text',
      source: 'slack',
      text: 'Shipping luna search updates today',
      originalUrl: 'https://workspace.slack.com/archives/C1/p1',
      comments: [],
      likes: null,
      date: '',
    },
  ];

  const matched = classifyLocalSearchMatches('luna', localCreators, localPosts);
  assert.equal(matched.profiles.length, 1);
  assert.equal(matched.albums.length, 1);
  assert.equal(matched.posts.length, 1);
});

test('createSearchCoordinator cancels stale slow responses and honors clear()', async () => {
  const { createSearchCoordinator } = loadSearchModules();

  let resolveSlow;
  let notifySlowStarted;
  const slowStarted = new Promise(r => { notifySlowStarted = r; });
  const calls = [];
  const coordinator = createSearchCoordinator({
    fetchSources: async () => [
      { id: 'youtube', name: 'YouTube', categories: ['videos', 'profiles', 'playlists'], supportsLiveConnector: false },
      { id: 'imgur', name: 'Imgur', categories: ['albums', 'gifs', 'posts'], supportsLiveConnector: false },
    ],
    postOmniSearch: async ({ query }) => {
      calls.push(query);
      if (query === 'lun') {
        return await new Promise(resolve => {
          resolveSlow = resolve;
          notifySlowStarted();
        });
      }
      return {
        ok: true,
        query,
        creators: [],
        posts: [{ id: `fast-${query}`, creatorId: 'yt:a', creatorName: 'YouTube', creatorHandle: '@youtube', creatorAvatar: '', type: 'video', source: 'youtube', title: `Fast ${query}`, originalUrl: `https://youtube.com/watch?v=${query}`, comments: [], likes: null, date: '' }],
        sections: { profiles: [], playlists: [], videos: [{ id: `fast-${query}`, creatorId: 'yt:a', creatorName: 'YouTube', creatorHandle: '@youtube', creatorAvatar: '', type: 'video', source: 'youtube', title: `Fast ${query}`, originalUrl: `https://youtube.com/watch?v=${query}`, comments: [], likes: null, date: '' }], shorts: [], albums: [], gifs: [], posts: [] },
        cursors: {},
        sourceStatus: { youtube: { ok: true, count: 1, hasMore: false } },
        hasMore: false,
      };
    },
  });

  await coordinator.initSources();
  const pSlow = coordinator.search('lun', 'all');
  await slowStarted;
  const pFast = coordinator.search('luna', 'all');
  await pFast;
  assert.equal(coordinator.getSnapshot()?.query, 'luna');

  resolveSlow({
    ok: true,
    query: 'lun',
    creators: [],
    posts: [{ id: 'stale-lun', creatorId: 'yt:old', creatorName: 'Old', creatorHandle: '@old', creatorAvatar: '', type: 'video', source: 'youtube', title: 'Stale', originalUrl: 'https://youtube.com/watch?v=old', comments: [], likes: null, date: '' }],
    sections: { profiles: [], playlists: [], videos: [{ id: 'stale-lun', creatorId: 'yt:old', creatorName: 'Old', creatorHandle: '@old', creatorAvatar: '', type: 'video', source: 'youtube', title: 'Stale', originalUrl: 'https://youtube.com/watch?v=old', comments: [], likes: null, date: '' }], shorts: [], albums: [], gifs: [], posts: [] },
    cursors: {},
    sourceStatus: { youtube: { ok: true, count: 1, hasMore: false } },
    hasMore: false,
  });
  await pSlow;
  assert.equal(coordinator.getSnapshot()?.query, 'luna');
  assert.equal(coordinator.getSnapshot()?.videos[0].id, 'fast-luna');

  coordinator.clear();
  assert.equal(coordinator.getSnapshot(), null);
});

test('createSearchCoordinator scopes initial single-source query and lazily expands on source switch', async () => {
  const { createSearchCoordinator } = loadSearchModules();
  const omniRequests = [];

  const coordinator = createSearchCoordinator({
    fetchSources: async () => [
      { id: 'youtube', name: 'YouTube', categories: ['videos'], supportsLiveConnector: false },
      { id: 'imgur', name: 'Imgur', categories: ['albums'], supportsLiveConnector: false },
      { id: 'portal_grid', name: 'PortalGrid', categories: ['videos'], supportsLiveConnector: false },
    ],
    postOmniSearch: async ({ query, source }) => {
      omniRequests.push({ query, source });
      return {
        ok: true,
        query,
        creators: [],
        posts: [],
        sections: { profiles: [], playlists: [], videos: [], shorts: [], albums: [], gifs: [], posts: [] },
        cursors: {},
        sourceStatus: { [source]: { ok: true, count: 0, hasMore: false } },
        hasMore: false,
      };
    },
  });

  await coordinator.search('luna', 'youtube');
  assert.deepEqual(omniRequests, [{ query: 'luna', source: 'youtube' }]);
  assert.deepEqual(coordinator.getSnapshot()?.fetchedSources, ['youtube']);

  await coordinator.ensureSourceFetched('imgur');
  assert.deepEqual(omniRequests.map(r => r.source), ['youtube', 'imgur']);

  await coordinator.ensureSourceFetched('all');
  // Must lazily fetch only remaining unqueried source ('portal_grid'), never re-fetching youtube or imgur!
  assert.deepEqual(omniRequests.map(r => r.source), ['youtube', 'imgur', 'portal_grid']);
});

test('mapPlaylistVideosToTimelinePosts maps YouTube URLs and preserves neutral attribution without sourcePage', () => {
  const { mapPlaylistVideosToTimelinePosts } = loadSearchModules();
  const mapped = mapPlaylistVideosToTimelinePosts(
    { id: 'pl-1', title: 'Luna Favorites', url: 'https://www.youtube.com/playlist?list=PL123' },
    { id: 'yt:pl', name: 'YouTube', handle: '@youtube', avatar: '', site: 'youtube' },
    [{ id: 'v1', title: 'Track 1', originalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', duration: '3:32' }],
    true,
  );
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].youtubeId, 'dQw4w9WgXcQ');
  assert.equal(mapped[0].type, 'video');
  assert.equal(mapped[0].source, 'youtube');
  assert.ok(!mapped[0].sourcePage);
});

test('createSearchCoordinator absorbs AbortError cleanly during initSources, search, and loadMore', async () => {
  const { createSearchCoordinator } = loadSearchModules();

  const coordinator = createSearchCoordinator({
    fetchSources: signal =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('signal is aborted without reason', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new DOMException('signal is aborted without reason', 'AbortError')), { once: true });
      }),
    postOmniSearch: ({ query, cursors }, signal) =>
      new Promise((resolve, reject) => {
        if (cursors) {
          signal?.addEventListener('abort', () => reject(new DOMException('signal is aborted without reason', 'AbortError')), { once: true });
          return;
        }
        resolve({
          ok: true,
          query,
          creators: [],
          posts: [],
          sections: { profiles: [], playlists: [], videos: [], shorts: [], albums: [], gifs: [], posts: [] },
          cursors: { 'youtube:videos': { cursor: 'c2', hasMore: true } },
          sourceStatus: { youtube: { ok: true, count: 0, hasMore: true } },
          hasMore: true,
        });
      }),
  });

  const c1 = new AbortController();
  const pInit = coordinator.initSources(c1.signal);
  c1.abort();
  const initList = await pInit;
  assert.deepEqual(initList, []);

  // Second coordinator where fetchSources works so search & loadMore abort path can be exercised
  const coord2 = createSearchCoordinator({
    fetchSources: async () => [{ id: 'youtube', name: 'YouTube', categories: ['videos'], supportsLiveConnector: false }],
    postOmniSearch: ({ query, cursors }, signal) =>
      new Promise((resolve, reject) => {
        if (cursors) {
          signal?.addEventListener('abort', () => reject(new DOMException('signal is aborted without reason', 'AbortError')), { once: true });
          return;
        }
        resolve({
          ok: true,
          query,
          creators: [],
          posts: [],
          sections: { profiles: [], playlists: [], videos: [], shorts: [], albums: [], gifs: [], posts: [] },
          cursors: { 'youtube:videos': { cursor: 'c2', hasMore: true } },
          sourceStatus: { youtube: { ok: true, count: 0, hasMore: true } },
          hasMore: true,
        });
      }),
  });

  await coord2.search('luna', 'youtube');
  const pMore = coord2.loadMore('youtube', 'videos');
  coord2.clear();
  const resAfterAbort = await pMore;
  assert.equal(resAfterAbort, null);
});

test('hasMoreForCategory tracks per-X-tab exhaustion and resolveSearchPostCreatorTarget routes X and neutral items safely', async () => {
  const { createSearchCoordinator, hasMoreForCategory, resolveSearchPostCreatorTarget } = loadSearchModules();

  const xResp = {
    'top:0': { ok: true, items: [{ id: 't1', url: 'https://x.com/alice/status/1', handle: 'alice', name: 'Alice', avatar: '', verified: false, date: '2026-01-01', text: 'luna', photos: [], hasVideo: false, metrics: {} }], relevantPeople: [] },
    'people:0': { ok: true, items: [{ handle: 'alice', name: 'Alice', avatar: '', verified: false }], relevantPeople: [] },
    'videos:0': { ok: true, items: [], relevantPeople: [] },
    'photos:0': { ok: true, items: [{ id: 'p1', url: 'https://x.com/alice/status/2', handle: 'alice', name: 'Alice', avatar: '', verified: false, date: '2026-01-01', text: 'pic', photos: ['https://pbs.twimg.com/a.jpg'], hasVideo: false, metrics: {} }], relevantPeople: [] },
    'photos:1': { ok: true, items: [], relevantPeople: [] },
  };

  const coord = createSearchCoordinator({
    fetchSources: async () => [{ id: 'x', name: 'X', categories: ['profiles', 'videos', 'albums', 'posts'], supportsLiveConnector: true }],
    postOmniSearch: async ({ query }) => ({
      ok: true,
      query,
      creators: [],
      posts: [],
      sections: { profiles: [], playlists: [], videos: [], shorts: [], albums: [], gifs: [], posts: [] },
      cursors: {},
      sourceStatus: { x: { ok: true, count: 0, hasMore: false } },
      hasMore: false,
    }),
    readLiveXSearch: async (offset, opts) => xResp[`${opts.searchTab}:${offset}`] || { ok: true, items: [] },
  });

  await coord.search('luna', 'x');
  await coord.ensureCategoryXTab('photos');
  assert.equal(hasMoreForCategory(coord.getSnapshot(), 'x', 'albums'), true);
  // Exhaust 'photos' tab on page 2
  await coord.loadMore('x', 'albums');
  assert.equal(hasMoreForCategory(coord.getSnapshot(), 'x', 'albums'), false);
  // 'posts' still has 'top' active
  assert.equal(hasMoreForCategory(coord.getSnapshot(), 'x', 'posts'), true);

  // Critical #1 regression check: X-fallback post routes to 'x' (never /scan-stream URL); neutral attribution returns null
  const xFallbackPost = { id: 'x-1', source: 'x', creatorId: 'https://x.com/lunafan', creatorName: 'Luna Fan', creatorHandle: '@lunafan', creatorAvatar: '', sourcePage: 'https://x.com/lunafan' };
  const xTarget = resolveSearchPostCreatorTarget(xFallbackPost, new Set());
  assert.equal(xTarget?.kind, 'x');
  assert.equal(xTarget?.account.handle, 'lunafan');

  const neutralImgurPost = { id: 'im-1', source: 'imgur', creatorId: 'imgur:imgur', creatorName: 'Imgur', creatorHandle: '@imgur', creatorAvatar: '' };
  assert.equal(resolveSearchPostCreatorTarget(neutralImgurPost, new Set()), null);

  const ytChannelPost = { id: 'yt-1', source: 'youtube', creatorId: 'https://www.youtube.com/@LunaVEVO', creatorName: 'LunaVEVO', creatorHandle: '@LunaVEVO', creatorAvatar: '', sourcePage: 'https://www.youtube.com/@LunaVEVO' };
  assert.deepEqual(resolveSearchPostCreatorTarget(ytChannelPost, new Set()), { kind: 'url', url: 'https://www.youtube.com/@LunaVEVO' });
});

test('mergeSearchSnapshot interleaves multi-source batches round-robin and stops local items from burying page 1', () => {
  const {
    createEmptySearchSnapshot,
    interleaveBySource,
    mergeSearchSnapshot,
    postSourceId,
  } = loadSearchModules();

  const makePost = (id, source) => ({
    id,
    creatorId: `${source}:c1`,
    creatorName: `${source} creator`,
    creatorHandle: `@${source}`,
    creatorAvatar: '',
    type: 'video',
    source,
    originalUrl: `https://${source}.example.com/v/${id}`,
    title: `luna ${id}`,
    comments: [],
    likes: null,
    date: '',
  });

  // 1. Direct round-robin helper preserves internal order per source while interleaving sources
  const rawMixed = [
    makePost('yt1', 'youtube'),
    makePost('yt2', 'youtube'),
    makePost('ep1', 'portal_grid'),
    makePost('ep2', 'portal_grid'),
    makePost('ph1', 'portal_tube'),
  ];
  assert.deepEqual(
    interleaveBySource(rawMixed, postSourceId).map(p => p.id),
    ['yt1', 'ep1', 'ph1', 'yt2', 'ep2'],
  );

  // Single-source input stays in exact original order
  assert.deepEqual(
    interleaveBySource([makePost('yt1', 'youtube'), makePost('yt2', 'youtube')], postSourceId).map(p => p.id),
    ['yt1', 'yt2'],
  );

  // 2. Optimistic local matches (before remote arrives) are themselves round-robin interleaved
  let snap = createEmptySearchSnapshot('luna');
  snap = mergeSearchSnapshot(
    snap,
    { query: 'luna', creators: [], posts: [], sections: {}, cursors: {}, sourceStatus: {} },
    {
      profiles: [],
      playlists: [],
      videos: [makePost('ph-loc-1', 'portal_tube'), makePost('ph-loc-2', 'portal_tube'), makePost('yt-loc-1', 'youtube')],
      shorts: [],
      albums: [],
      gifs: [],
      posts: [],
    },
  );
  assert.deepEqual(snap.videos.map(v => v.id), ['ph-loc-1', 'yt-loc-1', 'ph-loc-2']);

  // 3. First remote batch (fetchedSources was empty) re-interleaves remote + local so local PortalTube does not bury YouTube #1
  snap = mergeSearchSnapshot(snap, {
    query: 'luna',
    creators: [],
    posts: [],
    sections: {
      profiles: [],
      playlists: [],
      videos: [
        makePost('yt-1', 'youtube'),
        makePost('ep-1', 'portal_grid'),
        makePost('ph-1', 'portal_tube'),
        makePost('yt-2', 'youtube'),
        makePost('ep-2', 'portal_grid'),
      ],
      shorts: [],
      albums: [],
      gifs: [],
      posts: [],
    },
    cursors: {
      'youtube:videos': { cursor: 'yt-p2', hasMore: true },
      'portal_grid:videos': { cursor: 'ep-p2', hasMore: true },
      'portal_tube:videos': { cursor: 'ph-p2', hasMore: true },
    },
    sourceStatus: {
      youtube: { ok: true, count: 2, hasMore: true },
      portal_grid: { ok: true, count: 2, hasMore: true },
      portal_tube: { ok: true, count: 1, hasMore: true },
    },
    hasMore: true,
  });

  const page1Ids = snap.videos.map(v => v.id);
  assert.deepEqual(
    page1Ids.slice(0, 6),
    ['yt-1', 'ep-1', 'ph-1', 'yt-2', 'ep-2', 'ph-loc-1'],
  );
  assert.deepEqual(page1Ids.slice(6), ['yt-loc-1', 'ph-loc-2']);

  // 4. Page 2+ appends interleaved batch AFTER Page 1 (no top-of-feed reorder / scroll jump)
  snap = mergeSearchSnapshot(snap, {
    query: 'luna',
    creators: [],
    posts: [],
    sections: {
      profiles: [],
      playlists: [],
      videos: [
        makePost('yt-3', 'youtube'),
        makePost('ep-3', 'portal_grid'),
        makePost('ph-2', 'portal_tube'),
      ],
      shorts: [],
      albums: [],
      gifs: [],
      posts: [],
    },
    cursors: {
      'youtube:videos': { cursor: 'yt-p3', hasMore: true },
      'portal_grid:videos': { cursor: 'ep-p3', hasMore: true },
      'portal_tube:videos': { cursor: 'ph-p3', hasMore: true },
    },
    sourceStatus: {
      youtube: { ok: true, count: 1, hasMore: true },
      portal_grid: { ok: true, count: 1, hasMore: true },
      portal_tube: { ok: true, count: 1, hasMore: true },
    },
    hasMore: true,
  });

  assert.deepEqual(snap.videos.slice(0, page1Ids.length).map(v => v.id), page1Ids);
  assert.deepEqual(snap.videos.slice(page1Ids.length).map(v => v.id), ['yt-3', 'ep-3', 'ph-2']);
});

test('getSearchRenderSliceState progressively windows Search Results like Timeline and prefetches at buffer tail', () => {
  const { getSearchRenderSliceState } = loadSearchModules();
  const counts = {
    profiles: 130,
    playlists: 88,
    videos: 212,
    shorts: 41,
    albums: 212,
    gifs: 46,
    posts: 22,
  };

  // Single category mounts only windowCount items instead of all 212 DOM nodes at once
  const vidInitial = getSearchRenderSliceState(counts, 'videos', 6, 6);
  assert.equal(vidInitial.caps.videos, 6);
  assert.equal(vidInitial.caps.albums, 0);
  assert.equal(vidInitial.hasMoreInWindow, true);
  assert.equal(vidInitial.shouldPrefetchRemote, false);

  // Near end of buffered items -> prefetches next remote page ahead of running dry
  const vidNearTail = getSearchRenderSliceState(counts, 'videos', 206, 6);
  assert.equal(vidNearTail.caps.videos, 206);
  assert.equal(vidNearTail.hasMoreInWindow, true);
  assert.equal(vidNearTail.shouldPrefetchRemote, true);

  // 'all' view keeps every non-empty section visible with a small initial slice (~4 per section instead of 751 total)
  const allInitial = getSearchRenderSliceState(counts, 'all', 4, 4);
  assert.deepEqual(allInitial.caps, {
    profiles: 4,
    playlists: 4,
    videos: 4,
    shorts: 4,
    albums: 4,
    gifs: 4,
    posts: 4,
  });
  assert.equal(allInitial.hasMoreInWindow, true);
  assert.equal(allInitial.shouldPrefetchRemote, false);

  // Past end of local buffer -> exhausted window triggers remote load immediately
  const postsExhausted = getSearchRenderSliceState(counts, 'posts', 22, 6);
  assert.equal(postsExhausted.caps.posts, 22);
  assert.equal(postsExhausted.hasMoreInWindow, false);
  assert.equal(postsExhausted.shouldPrefetchRemote, true);
});


