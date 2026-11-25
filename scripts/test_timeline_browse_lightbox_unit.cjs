// Run: node --test scripts/test_timeline_browse_lightbox_unit.cjs
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');

const front = path.resolve(__dirname, '../frontend-mobile-preview');
const esbuild = require(path.join(front, 'node_modules/esbuild'));

const bundle = esbuild.buildSync({
  stdin: {
    resolveDir: front,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { fetchAlbumPhotos } from './src/services/profileHubApi';
      import { fetchBrowseSources, fetchTimelineBrowsePage } from './src/services/timelineBrowse';
      import { loadTimelineCreatorProfile } from './src/services/timelineCreatorProfile';
      import { registerDynamicSources } from './src/components/profile-hub/timeline/timelineSourceCapabilities';
      import { useProfileTimelineStore } from './src/store/useProfileTimelineStore';
      import { PhotoLightboxPaginationBar, resolveLightboxDisplaySrc, getNextLightboxErrorSrc } from './src/components/profile-hub/timeline/PhotoLightboxModal';

      const noop = () => {};
      export { registerDynamicSources };
      export function renderLightbox(lightboxOverrides = {}) {
        return renderToStaticMarkup(
          <PhotoLightboxPaginationBar
            title="Board Thread"
            albumPage={1}
            albumTotalPages={5}
            albumHasMore={true}
            isEn={true}
            onLoadNext={noop}
            {...lightboxOverrides}
          />
        );
      }

      export {
        fetchAlbumPhotos,
        fetchBrowseSources,
        fetchTimelineBrowsePage,
        loadTimelineCreatorProfile,
        useProfileTimelineStore,
        resolveLightboxDisplaySrc,
        getNextLightboxErrorSrc,
      };
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

const mod = new Module('timeline-browse-lightbox-unit');
mod._compile(bundle.outputFiles[0].text, path.join(front, 'timeline-browse-lightbox-unit.cjs'));
const fx = mod.exports;

test('fetchAlbumPhotos forwards pageUrl and returns multi-page metadata', async () => {
  let capturedBody = null;
  global.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        photos: [{ id: 'p2', originalUrl: 'https://img-cdn.example/images/45/p2.jpg', thumbnailUrl: 'https://thumb-cdn.example/thumbs/45/p2.jpg' }],
        page: 2,
        totalPages: 5,
        hasMore: true,
        nextPageUrl: 'https://board.example/threads/123-Test/page3',
        paginationComplete: false,
      }),
    };
  };

  const res = await fx.fetchAlbumPhotos('https://board.example/threads/123-Test', undefined, 2, {
    pageUrl: 'https://board.example/threads/123-Test/page2',
  });
  assert.equal(capturedBody.page, 2);
  assert.equal(capturedBody.pageUrl, 'https://board.example/threads/123-Test/page2');
  assert.equal(res.page, 2);
  assert.equal(res.totalPages, 5);
  assert.equal(res.hasMore, true);
  assert.equal(res.nextPageUrl, 'https://board.example/threads/123-Test/page3');
});

test('useProfileTimelineStore loadBrowseFeed and loadMoreBrowseFeed paginate and deduplicate', async () => {
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!body.cursor) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          source: 'cat_alpha',
          category: 'popular',
          items: [
            { id: 'pp_1', title: 'Set 1', originalUrl: 'https://alpha.example/galleries/s1/', thumbnail: 'https://cdni.alpha.example/460/1/s1.jpg', type: 'album' },
          ],
          profiles: [],
          next_cursor: 'cur_page_2',
          has_more: true,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        source: 'cat_alpha',
        category: 'popular',
        items: [
          { id: 'pp_1', title: 'Set 1', originalUrl: 'https://alpha.example/galleries/s1/', thumbnail: 'https://cdni.alpha.example/460/1/s1.jpg', type: 'album' },
          { id: 'pp_2', title: 'Set 2', originalUrl: 'https://alpha.example/galleries/s2/', thumbnail: 'https://cdni.alpha.example/460/1/s2.jpg', type: 'album' },
        ],
        profiles: [],
        next_cursor: null,
        has_more: false,
      }),
    };
  };

  await fx.useProfileTimelineStore.getState().loadBrowseFeed('cat_alpha', 'popular');
  let feed = fx.useProfileTimelineStore.getState().browseFeedsBySource.cat_alpha;
  assert.equal(feed.items.length, 1);
  assert.equal(feed.hasMore, true);

  await fx.useProfileTimelineStore.getState().loadMoreBrowseFeed('cat_alpha');
  feed = fx.useProfileTimelineStore.getState().browseFeedsBySource.cat_alpha;
  assert.equal(feed.items.length, 2);
  assert.equal(feed.hasMore, false);
});

test('useProfileTimelineStore openLightbox and loadNextAlbumPage append multi-page thread photos cleanly', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.page === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          photos: [
            { id: 'v1', originalUrl: '', thumbnailUrl: 'https://thumb-cdn.example/thumbs/45/v1.jpg', pageUrl: 'https://viewer.example/show/45/v1.jpg' },
          ],
          page: 1,
          totalPages: 3,
          hasMore: true,
          nextPageUrl: 'https://board.example/threads/777-Multi/page2',
          paginationComplete: false,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        photos: [
          { id: 'v2', originalUrl: '', thumbnailUrl: 'https://thumb-cdn.example/thumbs/45/v2.jpg', pageUrl: 'https://viewer.example/show/45/v2.jpg' },
        ],
        page: 2,
        totalPages: 3,
        hasMore: true,
        nextPageUrl: 'https://board.example/threads/777-Multi/page3',
        paginationComplete: false,
      }),
    };
  };

  fx.useProfileTimelineStore.getState().openLightbox([], 0, 'Forum Multi', 'https://board.example/threads/777-Multi');
  await new Promise((r) => setTimeout(r, 30));

  let lb = fx.useProfileTimelineStore.getState().lightbox;
  assert.equal(lb.images.length, 1);
  assert.equal(lb.albumPage, 1);
  assert.equal(lb.albumTotalPages, 3);
  assert.equal(lb.albumHasMore, true);

  await fx.useProfileTimelineStore.getState().loadNextAlbumPage();
  lb = fx.useProfileTimelineStore.getState().lightbox;
  assert.equal(lb.images.length, 2);
  assert.equal(lb.albumPage, 2);
  assert.equal(calls[1].pageUrl, 'https://board.example/threads/777-Multi/page2');
});

test('PhotoLightboxModal renders Load Page CTA and loadTimelineCreatorProfile routes visual entities via /recent', async () => {
  fx.registerDynamicSources([
    {
      source_id: 'board_one',
      display_name: 'Board One',
      default_category: 'recent',
      categories: ['recent'],
      icon_kind: 'forum_board',
      origins: ['https://board.example'],
      capabilities: { archetype: 'forum_board' },
    },
  ]);
  const html = fx.renderLightbox();
  assert.match(html, /data-lightbox-load-next-page="true"/);
  assert.match(html, /2\s*(?:\/|de|of)\s*5/i);

  let calledEndpoint = '';
  global.fetch = async (url) => {
    calledEndpoint = String(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        profile_key: 'board_one:threads/123',
        source_url: 'https://board.example/threads/123-Model',
        name: 'Model Thread',
        entityKind: 'thread',
        profile_data: {
          name: 'Model Thread',
          handle: '@thread123',
          site: 'board_one',
          entityKind: 'thread',
          avatarUrl: '',
          stats: { albums: 1 },
        },
        canonical_albums: [
          { url: 'https://board.example/threads/123-Model', title: 'Model Thread', thumbnailUrl: 'https://thumb-cdn.example/thumbs/1/a.jpg' },
        ],
      }),
    };
  };

  const snap = await fx.loadTimelineCreatorProfile({
    url: 'https://board.example/threads/123-Model',
    existingPosts: [],
    signal: new AbortController().signal,
    unnamedLabel: 'Unnamed',
  });
  assert.match(calledEndpoint, /\/api\/profile-hub\/recent/);
  assert.equal(snap.creator.site, 'board_one');
  assert.equal(snap.creator.entityKind, 'thread');
});

test('Lightbox requiresProxy and error fallback prioritize proxied HD before thumbnail downgrade', () => {
  const hdUrl = 'https://cdn-b.example/i/2025/01/full.jpg';
  const thumbUrl = 'https://cdn-b.example/u/t/2025/01/thumb.jpg';
  const referer = 'https://cdn-b.example/i/abc';

  const initialProxied = fx.resolveLightboxDisplaySrc(hdUrl, referer, true);
  assert.match(initialProxied, /^\/api\/proxy-image\?url=/);
  assert.match(initialProxied, /full\.jpg/);

  // First error on direct HD URL must try /api/proxy-image on currentImage FIRST, NOT thumbUrl
  const step1 = fx.getNextLightboxErrorSrc(hdUrl, thumbUrl, referer, { proxied: '', fallbackThumb: '' });
  assert.equal(step1.kind, 'proxy');
  assert.match(step1.src, /^\/api\/proxy-image\?url=/);
  assert.match(step1.src, /full\.jpg/);

  // Second error after proxy already attempted degrades to fallbackThumb
  const step2 = fx.getNextLightboxErrorSrc(hdUrl, thumbUrl, referer, { proxied: '1', fallbackThumb: '' });
  assert.equal(step2.kind, 'thumb');
  assert.equal(step2.src, thumbUrl);
});
