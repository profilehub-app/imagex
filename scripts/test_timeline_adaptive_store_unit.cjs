const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const front = path.resolve(__dirname, '../frontend-mobile-preview');
const esbuild = require(path.join(front, 'node_modules/esbuild'));

if (typeof global.localStorage === 'undefined') {
  const mem = new Map();
  global.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
}
if (typeof global.window === 'undefined') {
  global.window = global;
}
if (typeof global.window.addEventListener !== 'function') {
  global.window.addEventListener = () => {};
}
if (typeof global.window.removeEventListener !== 'function') {
  global.window.removeEventListener = () => {};
}

const bundle = esbuild.buildSync({
  stdin: {
    resolveDir: front,
    loader: 'tsx',
    contents: `
      export { useProfileTimelineStore } from './src/store/useProfileTimelineStore';
      export {
        fetchBrowseSources,
        fetchTimelineDirectory,
        enrichCatalogBatch,
        fetchForumBoards,
        fetchForumThreadPage,
      } from './src/services/timelineBrowse';
      export { loadTimelineCreatorProfile } from './src/services/timelineCreatorProfile';
      export {
        clearDynamicSources,
        getSourceCapabilities,
        getDynamicSourceLabel,
      } from './src/components/profile-hub/timeline/timelineSourceCapabilities';
      export { resolveTimelinePlatform } from './src/components/profile-hub/timeline/timelineModel';
      export { translations } from './src/i18n/translations';
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

const mod = new Module('timeline-adaptive-store-unit');
mod._compile(bundle.outputFiles[0].text, path.join(front, 'timeline-adaptive-store-unit.cjs'));
const fx = mod.exports;

test('fetchBrowseSources hydrates dynamic registry and exposes archetype capabilities', async () => {
  fx.clearDynamicSources();
  global.fetch = async (url) => {
    assert.match(String(url), /\/api\/profile-hub\/timeline\/browse-sources/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        sources: [
          {
            source_id: 'cat_alpha',
            display_name: 'Catalog Alpha',
            default_category: 'popular',
            categories: ['popular', 'recent'],
            subfilters: [],
            icon_kind: 'gallery_catalog',
            capabilities: {
              archetype: 'gallery_catalog',
              supportsComments: false,
              supportsSourceLikes: false,
              supportsDirectories: true,
              directoryKinds: ['categories', 'artists'],
            },
          },
          {
            source_id: 'board_one',
            display_name: 'Board One',
            default_category: 'recent',
            categories: ['recent', 'posts'],
            subfilters: [],
            icon_kind: 'forum_board',
            capabilities: {
              archetype: 'forum_board',
              supportsComments: false,
              supportsThreadReader: true,
              directoryKinds: ['boards'],
            },
          },
        ],
      }),
    };
  };

  await fx.fetchBrowseSources();
  assert.equal(fx.getDynamicSourceLabel('cat_alpha'), 'Catalog Alpha');
  const catCaps = fx.getSourceCapabilities('cat_alpha');
  assert.equal(catCaps.supportsComments, false);
  assert.equal(catCaps.supportsDirectories, true);
  assert.equal(fx.getSourceCapabilities('board_one').supportsThreadReader, true);
});

test('useProfileTimelineStore loadDirectory, queueCatalogEnrichment, loadForumBoards, and openThreadView work cleanly', async () => {
  let enrichCalls = 0;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/browse') && !u.includes('/browse-sources')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          source: 'cat_alpha',
          category: 'popular',
          resolved_origin: 'https://alpha.example',
          items: [
            {
              id: 'a-447',
              title: 'Studio Session',
              originalUrl: 'https://alpha.example/galleries/447-studio-session/',
              thumbnail: 'https://cdni.alpha.example/460/1/447.jpg',
              type: 'album',
              needsEnrichment: true,
            },
          ],
          profiles: [],
          has_more: false,
          next_cursor: null,
        }),
      };
    }
    if (u.includes('/directory')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          source: 'cat_alpha',
          kind: 'artists',
          page: 1,
          items: [
            { id: 'artist-1', name: 'Jane Doe', url: 'https://alpha.example/artists/jane-doe', kind: 'artist', count: 14 },
          ],
        }),
      };
    }
    if (u.includes('/catalog-enrich')) {
      enrichCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          metadata: {
            'https://alpha.example/galleries/447-studio-session/': {
              title: 'Full Descriptive Title',
              artists: [{ name: 'Jane Doe', url: 'https://alpha.example/artists/jane-doe', kind: 'artist' }],
              channels: [{ name: 'Studio Alpha', url: 'https://alpha.example/channels/studio-alpha', kind: 'channel' }],
              tags: ['portrait', 'studio'],
              photoCount: 32,
            },
          },
        }),
      };
    }
    if (u.includes('/forum-boards')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          source: 'board_one',
          sections: [
            {
              title: 'Releases',
              boards: [{ id: '325', boardId: '325', name: 'Studios', url: 'https://board.example/forums/325', role: 'studios' }],
            },
          ],
        }),
      };
    }
    if (u.includes('/thread-view')) {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          threadUrl: body.url,
          title: 'Multi Page Thread',
          threadKind: 'video_release',
          releaseSpecs: ['1080p', 'MP4'],
          photos: [{ id: 'p1', url: 'https://img.example/1.jpg' }],
          count: 1,
          posts: [
            {
              id: 'post-1',
              author: 'UploaderA',
              text: 'Release notes',
              photos: [{ id: 'p1', url: 'https://img.example/1.jpg' }],
              releaseLinks: [{ host: 'mirror.example', url: 'https://mirror.example/file.mp4', label: 'Mirror 1' }],
            },
          ],
          currentPage: body.page || 1,
          totalPages: 3,
          hasMore: (body.page || 1) < 3,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const store = fx.useProfileTimelineStore.getState();
  await store.loadBrowseFeed('cat_alpha', 'popular', null, true);
  assert.equal(fx.resolveTimelinePlatform('https://alpha.example/artists/jane-doe'), 'cat_alpha');

  await store.loadDirectory('cat_alpha', 'artists', 1);
  assert.equal(fx.useProfileTimelineStore.getState().directoriesByKey['cat_alpha:artists:1'].items[0].name, 'Jane Doe');

  await store.queueCatalogEnrichment([
    { url: 'https://alpha.example/galleries/447-studio-session/', source: 'cat_alpha' },
  ]);
  // Re-queuing the same URL must be deduplicated without a second fetch
  await store.queueCatalogEnrichment([
    { url: 'https://alpha.example/galleries/447-studio-session/', source: 'cat_alpha' },
  ]);
  assert.equal(enrichCalls, 1);

  const enrichedItem = fx.useProfileTimelineStore.getState().browseFeedsBySource.cat_alpha.items[0];
  assert.equal(enrichedItem.title, 'Full Descriptive Title');
  assert.equal(enrichedItem.artists?.[0]?.name, 'Jane Doe');
  assert.equal(enrichedItem.channels?.[0]?.name, 'Studio Alpha');
  assert.equal(enrichedItem.photoCount, 32);

  await store.loadForumBoards('board_one');
  assert.equal(fx.useProfileTimelineStore.getState().forumBoardsBySource.board_one.sections[0].boards[0].name, 'Studios');

  await store.openThreadView('https://board.example/threads/55-demo', 'Demo', 'board_one');
  assert.equal(fx.useProfileTimelineStore.getState().activeThreadView.data.currentPage, 1);
  await store.loadThreadPage(2);
  assert.equal(fx.useProfileTimelineStore.getState().activeThreadView.data.currentPage, 2);
  store.closeThreadView();
  assert.equal(fx.useProfileTimelineStore.getState().activeThreadView, null);
});

test('loadTimelineCreatorProfile preserves pagination and relatedEntities across pages', async () => {
  const pagesSeen = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    pagesSeen.push(body.page || 1);
    const pg = body.page || 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        profile_key: 'cat_alpha:artists/jane-doe',
        source_url: 'https://alpha.example/artists/jane-doe',
        name: 'Jane Doe',
        entityKind: 'artist',
        page: pg,
        hasMore: pg < 2,
        nextPage: pg < 2 ? 2 : null,
        relatedEntities: [{ name: 'Related Artist', url: 'https://alpha.example/artists/related', kind: 'artist', count: 5 }],
        profile_data: {
          name: 'Jane Doe',
          site: 'cat_alpha',
          entityKind: 'artist',
        },
        canonical_albums: [
          { url: `https://alpha.example/galleries/set-${pg}/`, title: `Set ${pg}`, thumbnailUrl: `https://cdn.example/${pg}.jpg` },
        ],
      }),
    };
  };

  const snap1 = await fx.loadTimelineCreatorProfile({
    url: 'https://alpha.example/artists/jane-doe',
    existingPosts: [],
    signal: new AbortController().signal,
    unnamedLabel: 'Unnamed',
  });
  assert.equal(snap1.creator.profileHasMore, true);
  assert.equal(snap1.creator.profileNextPage, 2);
  assert.equal(snap1.creator.relatedEntities?.[0]?.name, 'Related Artist');

  fx.useProfileTimelineStore.setState((s) => ({
    creatorProfiles: { ...s.creatorProfiles, [snap1.creator.id]: snap1.creator },
    posts: snap1.posts,
  }));

  await fx.useProfileTimelineStore.getState().loadMoreCreatorProfileAlbums(snap1.creator.id);
  assert.deepEqual(pagesSeen, [1, 2]);
  const updated = fx.useProfileTimelineStore.getState().creatorProfiles[snap1.creator.id];
  assert.equal(updated.profileHasMore, false);
});

test('pt-BR and en-US timelineBrowse translations maintain exact key parity', () => {
  const ptKeys = Object.keys(fx.translations['pt-BR'].timelineBrowse).sort();
  const enKeys = Object.keys(fx.translations['en-US'].timelineBrowse).sort();
  assert.deepEqual(ptKeys, enKeys);
});
