// Run: node --test scripts/test_timeline_new_sources_unit.cjs
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
      import {
        resolveTimelinePlatform,
        upgradePhotoUrlFast,
        mapBrowseItemToTimelinePost,
      } from './src/components/profile-hub/timeline/timelineModel';
      import {
        registerDynamicSources,
        clearDynamicSources,
      } from './src/components/profile-hub/timeline/timelineSourceCapabilities';
      import {
        TIMELINE_SOURCES,
        getTimelineSourceDisplayName,
        catalogModes,
        matchesCatalogMode,
      } from './src/components/profile-hub/timeline/timelineSourceNavigation';
      import { renderBrandPlatformIcon } from './src/components/profile-hub/timeline/TimelineBrandIcons';
      import { TimelinePostCard } from './src/components/profile-hub/timeline/TimelinePostCard';
      import { AdaptiveProfileHeader } from './src/components/profile-hub/timeline/AdaptiveProfileHeader';

      export {
        resolveTimelinePlatform,
        upgradePhotoUrlFast,
        mapBrowseItemToTimelinePost,
        registerDynamicSources,
        clearDynamicSources,
        TIMELINE_SOURCES,
        getTimelineSourceDisplayName,
        catalogModes,
        matchesCatalogMode,
        renderBrandPlatformIcon,
      };

      const noop = () => {};
      export function renderCard(postOverrides) {
        const post = {
          id: 'p1',
          creatorId: 'cat_alpha:luna',
          creatorName: 'Luna Star',
          creatorHandle: '@luna',
          creatorAvatar: '',
          type: 'album',
          title: 'Gallery Title',
          date: '2026-11-23',
          likes: null,
          comments: [],
          ...postOverrides,
        };
        return renderToStaticMarkup(
          <TimelinePostCard
            post={post}
            onOpenProfile={noop}
            onOpenComments={noop}
            onOpenLightbox={noop}
            suspended
          />
        );
      }

      export function renderProfileHeader(creatorOverrides) {
        const creator = {
          id: 'board_one:t1',
          name: 'Model Thread',
          handle: '@thread1',
          avatar: '',
          site: 'board_one',
          entityKind: 'thread',
          profileUrl: 'https://board.example/threads/12345-Model',
          verified: false,
          stats: { albums: 12 },
          ...creatorOverrides,
        };
        return renderToStaticMarkup(
          <AdaptiveProfileHeader creator={creator} onBack={noop} />
        );
      }
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

const mod = new Module('timeline-new-sources-unit');
mod._compile(bundle.outputFiles[0].text, path.join(front, 'timeline-new-sources-unit.cjs'));
const fx = mod.exports;

function seedSyntheticSources() {
  fx.clearDynamicSources();
  fx.registerDynamicSources([
    {
      source_id: 'cat_alpha',
      display_name: 'Catalog Alpha',
      default_category: 'popular',
      categories: ['popular', 'recent', 'albums', 'gifs'],
      icon_kind: 'gallery_catalog',
      origins: ['https://alpha.example', 'https://cdni.alpha.example'],
      capabilities: { archetype: 'gallery_catalog' },
    },
    {
      source_id: 'cat_hd',
      display_name: 'Catalog HD',
      default_category: 'recent',
      categories: ['recent', 'albums', 'photos'],
      icon_kind: 'gallery_hd',
      origins: ['https://cat-hd.example', 'https://cdni.cat-hd.example'],
      capabilities: { archetype: 'gallery_catalog' },
    },
    {
      source_id: 'board_one',
      display_name: 'Board One',
      default_category: 'recent',
      categories: ['recent', 'popular', 'albums', 'gifs', 'posts'],
      icon_kind: 'forum_board',
      origins: ['https://board.example'],
      capabilities: { archetype: 'forum_board', supportsThreadReader: true },
    },
  ]);
}

test('resolveTimelinePlatform and upgradePhotoUrlFast handle dynamic visual sources safely', () => {
  seedSyntheticSources();
  assert.equal(fx.resolveTimelinePlatform('https://www.alpha.example/galleries/luna-1/'), 'cat_alpha');
  assert.equal(fx.resolveTimelinePlatform('https://cat-hd.example/pics/aria-1/'), 'cat_hd');
  assert.equal(fx.resolveTimelinePlatform('https://board.example/threads/12345-Model'), 'board_one');

  assert.equal(
    fx.upgradePhotoUrlFast('https://cdni.alpha.example/460/1/2/pic.jpg'),
    'https://cdni.alpha.example/1280/1/2/pic.jpg'
  );
  assert.equal(
    fx.upgradePhotoUrlFast('https://cdni.cat-hd.example/460/3/4/hq.jpg'),
    'https://cdni.cat-hd.example/1280/3/4/hq.jpg'
  );

  // Never blindly rewrite unknown third-party HTML viewers or thumbnails
  assert.equal(
    fx.upgradePhotoUrlFast('https://img-host.example/show/45/350.jpg'),
    'https://img-host.example/show/45/350.jpg'
  );
});

test('getTimelineSourceDisplayName and catalogModes expose registered sources cleanly', () => {
  seedSyntheticSources();
  assert.equal(fx.getTimelineSourceDisplayName('cat_alpha', 'en'), 'Catalog Alpha');
  assert.equal(fx.getTimelineSourceDisplayName('cat_hd', 'en'), 'Catalog HD');
  assert.equal(fx.getTimelineSourceDisplayName('board_one', 'en'), 'Board One');

  assert.deepEqual([...fx.catalogModes('cat_alpha')], ['popular', 'recent', 'albums', 'gifs']);
  assert.deepEqual([...fx.catalogModes('cat_hd')], ['recent', 'albums', 'photos']);
  assert.deepEqual([...fx.catalogModes('board_one')], ['recent', 'popular', 'albums', 'gifs', 'posts']);

  assert.equal(fx.matchesCatalogMode({ type: 'gif' }, 'gifs'), true);
  assert.equal(fx.matchesCatalogMode({ type: 'album', mediaType: 'photo' }, 'photos'), true);
});

test('mapBrowseItemToTimelinePost normalizes browse items into visual gallery/GIF cards', () => {
  seedSyntheticSources();
  const mapped = fx.mapBrowseItemToTimelinePost(
    {
      id: 'pp_1001',
      title: 'Luna Studio Set',
      originalUrl: 'https://www.alpha.example/galleries/luna-studio-1/',
      albumUrl: 'https://www.alpha.example/galleries/luna-studio-1/',
      thumbnail: 'https://cdni.alpha.example/460/1/2/luna.jpg',
      previewHdUrl: 'https://cdni.alpha.example/1280/1/2/luna.jpg',
      type: 'album',
      source: 'cat_alpha',
      tags: ['lingerie', 'brunette'],
      photoCount: 18,
    },
    'cat_alpha'
  );
  assert.equal(mapped.source, 'cat_alpha');
  assert.equal(mapped.type, 'album');
  assert.equal(mapped.thumbnail, 'https://cdni.alpha.example/460/1/2/luna.jpg');
  assert.deepEqual(mapped.tags, ['lingerie', 'brunette']);
  assert.equal(mapped.photoCount, 18);
});

test('TimelinePostCard renders visual album badges, forum host card, image-only GIF, and AdaptiveProfileHeader hides Hub review button', () => {
  seedSyntheticSources();
  const albumHtml = fx.renderCard({
    source: 'cat_alpha',
    type: 'album',
    photos: ['https://cdni.alpha.example/460/1/2/a.jpg'],
    photoCount: 24,
    tags: ['lingerie'],
  });
  assert.match(albumHtml, /24/);
  assert.match(albumHtml, /lingerie/i);

  const forumFallbackHtml = fx.renderCard({
    source: 'board_one',
    type: 'album',
    originalUrl: 'https://board.example/threads/999-Test',
    albumUrl: 'https://board.example/threads/999-Test',
    hosts: ['mirror-a.example', 'mirror-b.example'],
    totalPages: 12,
    photos: [],
  });
  assert.match(forumFallbackHtml, /mirror-a\.example/);
  assert.match(forumFallbackHtml, /mirror-b\.example/);
  assert.doesNotMatch(forumFallbackHtml, /aspect-video rounded-2xl bg-black/);

  const gifImgHtml = fx.renderCard({
    source: 'cat_alpha',
    type: 'gif',
    thumbnail: 'https://cdni.alpha.example/460/9/9/loop.gif',
    originalUrl: 'https://www.alpha.example/galleries/loop-1/',
  });
  assert.match(gifImgHtml, /GIF/);
  assert.doesNotMatch(gifImgHtml, /<video\b/);

  const hdrHtml = fx.renderProfileHeader();
  assert.doesNotMatch(hdrHtml, /data-action="open-profile-in-hub"/);
  assert.match(hdrHtml, /Thread|Tópico|Fórum/i);
});
