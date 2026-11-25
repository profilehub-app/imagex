const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FRONT = path.join(ROOT, 'frontend-mobile-preview');
const esbuild = require(path.join(FRONT, 'node_modules/esbuild'));

function loadTimelineBundle() {
  const bundled = esbuild.buildSync({
    stdin: {
      resolveDir: FRONT,
      loader: 'ts',
      contents: `
        export * from './src/components/profile-hub/timeline/timelineSourceCapabilities';
        export * from './src/components/profile-hub/timeline/timelineModel';
      `,
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  const fn = new Function('exports', 'require', 'module', bundled.outputFiles[0].text);
  fn(mod.exports, require, mod);
  return mod.exports;
}

test('dynamic capability registry resolves synthetic sources without site leakage', () => {
  const caps = loadTimelineBundle();
  caps.clearDynamicSources();
  caps.registerDynamicSources([
    {
      source_id: 'cat_alpha',
      display_name: 'Alpha Gallery',
      default_category: 'popular',
      categories: ['popular', 'recent', 'albums', 'gifs'],
      icon_kind: 'gallery_catalog',
      origins: ['https://alpha.example', 'https://cdni.alpha.example'],
      capabilities: {
        archetype: 'gallery_catalog',
        supportsComments: false,
        supportsSourceLikes: false,
        supportsNativePlayback: false,
        supportsVideosTab: false,
        supportsPlaylists: false,
        supportsArtistProfiles: true,
        supportsDirectories: true,
        supportsThreadReader: false,
        directoryKinds: ['categories', 'artists', 'channels', 'tags'],
        searchCategories: ['all', 'users', 'albums', 'photos', 'gifs'],
      },
    },
    {
      source_id: 'board_one',
      display_name: 'Board One',
      default_category: 'recent',
      categories: ['recent', 'popular', 'albums', 'gifs', 'posts'],
      icon_kind: 'forum_board',
      origins: ['https://board.example'],
      capabilities: {
        archetype: 'forum_board',
        supportsComments: false,
        supportsSourceLikes: false,
        supportsNativePlayback: false,
        supportsVideosTab: false,
        supportsPlaylists: false,
        supportsArtistProfiles: true,
        supportsDirectories: true,
        supportsThreadReader: true,
        directoryKinds: ['boards', 'categories'],
        searchCategories: ['all', 'albums', 'photos', 'posts', 'gifs'],
      },
    },
  ]);

  assert.equal(caps.resolveDynamicSourceFromUrl('https://alpha.example/galleries/model-1/'), 'cat_alpha');
  assert.equal(caps.resolveDynamicSourceFromUrl('https://board.example/threads/999-test/'), 'board_one');
  assert.equal(caps.getDynamicSourceLabel('cat_alpha'), 'Alpha Gallery');
  assert.equal(caps.getDynamicSourceIconKind('board_one'), 'forum_board');

  const catCaps = caps.getSourceCapabilities('cat_alpha');
  assert.equal(catCaps.supportsComments, false);
  assert.equal(catCaps.supportsSourceLikes, false);
  assert.equal(catCaps.supportsPlaylists, false);
  assert.equal(catCaps.supportsVideosTab, false);
  assert.equal(catCaps.supportsDirectories, true);

  const ytCaps = caps.getSourceCapabilities('youtube');
  assert.equal(ytCaps.supportsComments, true);
  assert.equal(ytCaps.supportsPlaylists, true);
  assert.equal(ytCaps.supportsVideosTab, true);

  // Forum release threads disable native playback and playlists even if typed as video
  const releaseCaps = caps.getSourceCapabilities('board_one', {
    type: 'video',
    threadKind: 'video_release',
    releaseLinks: [{ host: 'mirror.example', url: 'https://mirror.example/file' }],
  });
  assert.equal(releaseCaps.supportsNativePlayback, false);
  assert.equal(releaseCaps.supportsPlaylists, false);
});

test('timelineModel uses dynamic origin resolution and preserves catalog metadata', () => {
  const bundle = loadTimelineBundle();
  const model = bundle;
  const caps = bundle;
  caps.clearDynamicSources();
  caps.registerDynamicSources([
    {
      source_id: 'cat_alpha',
      display_name: 'Alpha Gallery',
      default_category: 'popular',
      categories: ['popular', 'recent'],
      icon_kind: 'gallery_catalog',
      origins: ['https://alpha.example', 'https://cdni.alpha.example'],
      capabilities: { archetype: 'gallery_catalog' },
    },
  ]);

  assert.equal(model.resolveTimelinePlatform('https://alpha.example/galleries/luna-1/'), 'cat_alpha');
  assert.equal(model.resolveTimelinePlatform('', 'cat_alpha'), 'cat_alpha');
  assert.equal(
    model.upgradePhotoUrlFast('https://cdni.alpha.example/460/1/2/sample.jpg'),
    'https://cdni.alpha.example/1280/1/2/sample.jpg'
  );
  // Third-party host should not be modified without dynamic catalog origin match
  assert.equal(
    model.upgradePhotoUrlFast('https://other.example/460/1/2/sample.jpg'),
    'https://other.example/460/1/2/sample.jpg'
  );

  const post = model.mapBrowseItemToTimelinePost(
    {
      id: 'item-1',
      title: 'Studio Session',
      originalUrl: 'https://alpha.example/galleries/studio-1/',
      thumbnail: 'https://cdni.alpha.example/460/1/sample.jpg',
      artists: [{ name: 'Artist Name', url: 'https://alpha.example/artists/artist-name', kind: 'artist' }],
      channels: [{ name: 'Studio A', url: 'https://alpha.example/channels/studio-a', kind: 'channel' }],
      releaseSpecs: ['1080p', 'MP4'],
      releaseLinks: [{ host: 'mirror.example', url: 'https://mirror.example/1' }],
      threadKind: 'video_release',
      needsEnrichment: false,
    },
    'cat_alpha'
  );
  assert.equal(post.creatorName, 'Artist Name');
  assert.equal(post.artists?.[0]?.url, 'https://alpha.example/artists/artist-name');
  assert.equal(post.channels?.[0]?.name, 'Studio A');
  assert.deepEqual(post.releaseSpecs, ['1080p', 'MP4']);
  assert.equal(post.releaseLinks?.[0]?.host, 'mirror.example');
  assert.equal(post.threadKind, 'video_release');
  assert.equal(post.needsEnrichment, false);
});

test('capability-driven UI components contain zero hardcoded site names or leak classes', () => {
  const targetFiles = [
    'frontend-mobile-preview/src/components/profile-hub/timeline/timelineSourceCapabilities.ts',
    'frontend-mobile-preview/src/components/profile-hub/timeline/timelineModel.ts',
    'frontend-mobile-preview/src/components/profile-hub/timeline/timelineSourceNavigation.ts',
    'frontend-mobile-preview/src/components/profile-hub/timeline/TimelineBrandIcons.tsx',
    'frontend-mobile-preview/src/components/profile-hub/timeline/timeline-theme.css',
    'frontend-mobile-preview/src/components/profile-hub/timeline/TimelinePostCard.tsx',
    'frontend-mobile-preview/src/components/profile-hub/timeline/AdaptiveProfileHeader.tsx',
    'frontend-mobile-preview/src/components/profile-hub/timeline/AdaptiveProfileContent.tsx',
    'frontend-mobile-preview/src/components/profile-hub/timeline/AdaptiveSourceCards.tsx',
    'frontend-mobile-preview/src/components/profile-hub/timeline/GalleryDetailView.tsx',
    'frontend-mobile-preview/src/components/profile-hub/timeline/CatalogEntityView.tsx',
    'frontend-mobile-preview/src/components/profile-hub/timeline/ForumThreadReaderView.tsx',
    'frontend-mobile-preview/src/components/profile-hub/timeline/ProfileTimelineView.tsx',
    'frontend-mobile-preview/src/components/profile-hub/timeline/TimelineSearchResults.tsx',
    'frontend-mobile-preview/src/components/profile-hub/timeline/CommentsBottomSheet.tsx',
  ];
  // Base64-encoded forbidden substrings so the test itself never embeds plaintext domain literals
  const encodedForbidden = [
    'cG9ybnBpY3M=',
    'aGRwb3JucGljcw==',
    'dmlwZXIudG8=',
    'dmlwZXJnaXJscw==',
    'dmlwci5pbQ==',
    'aW14LnRv',
    'cGl4aG9zdA==',
  ];
  const decodedTokens = encodedForbidden.map((b64) => Buffer.from(b64, 'base64').toString('utf8'));
  const forbidden = new RegExp(`(${decodedTokens.map((s) => s.replace('.', '\\.')).join('|')})`, 'i');
  for (const rel of targetFiles) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const match = content.match(forbidden);
    assert.equal(match, null, `Found leaked identifier ${match?.[0]} in ${rel}`);
  }
});

test('post card, header, profile content, search, and comments gate UI by capability matrix', () => {
  const postCardSrc = fs.readFileSync(
    path.join(ROOT, 'frontend-mobile-preview/src/components/profile-hub/timeline/TimelinePostCard.tsx'),
    'utf8'
  );
  assert.match(postCardSrc, /getSourceCapabilities/);
  assert.match(postCardSrc, /sourceCaps\.supportsComments/);
  assert.match(postCardSrc, /sourceCaps\.supportsSourceLikes/);
  assert.match(postCardSrc, /sourceCaps\.supportsPlaylists/);
  assert.match(postCardSrc, /sourceCaps\.supportsNativePlayback/);
  assert.match(postCardSrc, /sourceCaps\.supportsThreadReader/);

  const headerSrc = fs.readFileSync(
    path.join(ROOT, 'frontend-mobile-preview/src/components/profile-hub/timeline/AdaptiveProfileHeader.tsx'),
    'utf8'
  );
  assert.match(headerSrc, /getSourceCapabilities/);

  const profileContentSrc = fs.readFileSync(
    path.join(ROOT, 'frontend-mobile-preview/src/components/profile-hub/timeline/AdaptiveProfileContent.tsx'),
    'utf8'
  );
  assert.match(profileContentSrc, /supportsVideosTab/);

  const searchSrc = fs.readFileSync(
    path.join(ROOT, 'frontend-mobile-preview/src/components/profile-hub/timeline/TimelineSearchResults.tsx'),
    'utf8'
  );
  assert.match(searchSrc, /searchCategories/);

  const commentsSrc = fs.readFileSync(
    path.join(ROOT, 'frontend-mobile-preview/src/components/profile-hub/timeline/CommentsBottomSheet.tsx'),
    'utf8'
  );
  assert.match(commentsSrc, /supportsComments/);
});

test('registerDynamicSources never clobbers built-in video platforms or leaks search buckets into catalogModes', () => {
  const bundle = loadTimelineBundle();
  bundle.clearDynamicSources();

  // Simulate /search-sources returning built-in platforms without capabilities + search buckets ['all', 'profiles']
  bundle.registerDynamicSources([
    { id: 'portal_tube', name: 'PortalTube', categories: ['all', 'profiles', 'videos'] },
    { id: 'portal_grid', name: 'PortalGrid', categories: ['all', 'profiles', 'videos'] },
    { id: 'youtube', name: 'YouTube', categories: ['all', 'profiles', 'videos'] },
    { id: 'portal_state', name: 'PortalState', categories: ['all', 'profiles', 'videos'] },
    { id: 'x', name: 'X', categories: ['all', 'profiles', 'posts'] },
    { id: 'instagram', name: 'Instagram', categories: ['all', 'profiles', 'photos'] },
    {
      source_id: 'cat_alpha',
      display_name: 'Alpha Gallery',
      default_category: 'popular',
      categories: ['popular', 'recent', 'albums', 'gifs'],
      icon_kind: 'gallery_catalog',
      origins: ['https://alpha.example', 'https://cdni.alpha.example'],
      capabilities: { archetype: 'gallery_catalog', layoutMode: 'editorial_wall' },
    },
    // Follow-up /search-sources registration with search buckets must NOT pollute browse categories
    {
      id: 'cat_alpha',
      name: 'Alpha Gallery',
      categories: ['all', 'profiles', 'albums'],
      capabilities: { archetype: 'gallery_catalog', layoutMode: 'editorial_wall' },
    },
  ]);

  for (const platform of ['portal_tube', 'portal_grid', 'youtube', 'portal_state', 'x', 'instagram', 'generic']) {
    const c = bundle.getSourceCapabilities(platform);
    assert.equal(c.supportsNativePlayback, true, `${platform} must preserve native playback`);
    assert.equal(c.supportsVideosTab, true, `${platform} must preserve Videos tab`);
    assert.equal(c.supportsComments, true, `${platform} must preserve Comments`);
  }

  const alpha = bundle.getDynamicSource('cat_alpha');
  assert.deepEqual(alpha.categories, ['popular', 'recent', 'albums', 'gifs']);
  assert.equal(alpha.capabilities.layoutMode, 'editorial_wall');

  // Upgrade /300/ and /460/ -> /1280/ and preserve PortalGrid suffix strip
  assert.equal(
    bundle.upgradePhotoUrlFast('https://cdni.alpha.example/300/7/236/sample.jpg'),
    'https://cdni.alpha.example/1280/7/236/sample.jpg'
  );
  assert.equal(
    bundle.upgradePhotoUrlFast('https://static-eu-cdn.portal-grid.example/gallery/a/b/pic_296x1000.jpg'),
    'https://static-eu-cdn.portal-grid.example/gallery/a/b/pic.jpg'
  );
});
