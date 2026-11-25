const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require(path.resolve(__dirname, '../frontend-mobile-preview/node_modules/esbuild'));

const FRONTEND_DIR = path.resolve(__dirname, '../frontend-mobile-preview/src');

function loadCombinedModules() {
  const res = esbuild.buildSync({
    stdin: {
      contents: `
        export * as caps from './components/profile-hub/timeline/timelineSourceCapabilities.ts';
        export * as model from './components/profile-hub/timeline/timelineModel.ts';
      `,
      resolveDir: FRONTEND_DIR,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    jsx: 'automatic',
  });
  const code = res.outputFiles[0].text;
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', code);
  fn(require, mod, mod.exports, __filename, __dirname);
  return mod.exports;
}

test('video_portal archetype registers urlHints, accentColor, and video_wall layout', () => {
  const { caps: capsMod } = loadCombinedModules();

  capsMod.registerDynamicSources([
    {
      id: 'vid_portal',
      displayName: 'Video Portal',
      iconKind: 'video_portal',
      accentColor: '#e11d48',
      origins: ['https://portal.example', 'https://m.portal.example'],
      urlHints: {
        videoPathRegex: '^/(?:video\\.[a-z0-9]+|embedframe/[a-z0-9]+)',
        playlistPathRegex: '^/favorite/[a-z0-9]+',
        entityPrefixes: ['/profiles/', '/channels/', '/models/', '/c/', '/tags/'],
      },
      capabilities: {
        archetype: 'video_portal',
        layoutMode: 'video_wall',
        supportsComments: true,
        supportsSourceLikes: true,
        supportsNativePlayback: true,
        supportsVideosTab: true,
        supportsPlaylists: true,
        supportsArtistProfiles: true,
        supportsDirectories: true,
        supportsThreadReader: false,
        directoryKinds: ['categories', 'channels', 'artists', 'tags'],
      },
    },
  ]);

  const caps = capsMod.getSourceCapabilities('vid_portal');
  assert.equal(caps.archetype, 'video_portal');
  assert.equal(caps.layoutMode, 'video_wall');
  assert.equal(caps.supportsComments, true);
  assert.equal(caps.supportsNativePlayback, true);
  assert.equal(caps.supportsPlaylists, true);
  assert.equal(capsMod.getDynamicSourceIconKind('vid_portal'), 'video_portal');
  assert.equal(capsMod.getDynamicSourceAccent('vid_portal'), '#e11d48');
  assert.equal(capsMod.resolveDynamicSourceFromUrl('https://m.portal.example/profiles/alice'), 'vid_portal');

  const hints = capsMod.getDynamicUrlHints('vid_portal');
  assert.ok(hints);
  assert.match(hints.videoPathRegex, /video/);
});

test('classifyTimelineDirectUrl routes video, playlist, entity, built-ins, and rejects plain queries', () => {
  const { caps: capsMod, model: modelMod } = loadCombinedModules();

  assert.equal(typeof modelMod.classifyTimelineDirectUrl, 'function');

  capsMod.registerDynamicSources([
    {
      id: 'vid_portal',
      displayName: 'Video Portal',
      iconKind: 'video_portal',
      origins: ['https://portal.example', 'https://m.portal.example'],
      urlHints: {
        videoPathRegex: '^/(?:video\\.[a-z0-9]+|embedframe/[a-z0-9]+)',
        playlistPathRegex: '^/favorite/[a-z0-9]+',
        entityPrefixes: ['/profiles/', '/channels/', '/models/', '/c/', '/tags/'],
      },
      capabilities: { archetype: 'video_portal', layoutMode: 'video_wall' },
    },
  ]);

  const vidRes = modelMod.classifyTimelineDirectUrl('https://portal.example/video.ab12cd/demo_clip');
  assert.deepEqual(vidRes.kind, 'video');
  assert.equal(vidRes.source, 'vid_portal');

  const plRes = modelMod.classifyTimelineDirectUrl('https://m.portal.example/favorite/f99/night-reels');
  assert.deepEqual(plRes.kind, 'playlist');
  assert.equal(plRes.source, 'vid_portal');

  for (const url of [
    'https://portal.example/profiles/alice-demo',
    'https://portal.example/channels/studio-alpha',
    'https://portal.example/c/cinema-hd',
    'https://portal.example/tags/4k-scenic',
    'https://portal.example/studio_root',
  ]) {
    const entRes = modelMod.classifyTimelineDirectUrl(url);
    assert.equal(entRes.kind, 'entity', `expected entity for ${url}`);
    assert.equal(entRes.source, 'vid_portal');
  }

  // Built-in platforms
  assert.equal(modelMod.classifyTimelineDirectUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').kind, 'video');
  assert.equal(modelMod.classifyTimelineDirectUrl('https://www.youtube.com/@demochannel').kind, 'entity');
  assert.equal(modelMod.classifyTimelineDirectUrl('https://x.com/demo/status/123456789').kind, 'video');
  assert.equal(modelMod.classifyTimelineDirectUrl('https://x.com/demo').kind, 'entity');

  // Plain search words must return null
  assert.equal(modelMod.classifyTimelineDirectUrl('sunset scenic 4k'), null);
  assert.equal(modelMod.classifyTimelineDirectUrl('https://portal.example/?k=sunset'), null);

  // Mapped browse item keeps previewVideoUrl & tags/categories
  const mapped = modelMod.mapBrowseItemToTimelinePost(
    {
      id: 'vp-1',
      title: 'Mountain Dawn',
      originalUrl: 'https://portal.example/video.ab12cd/demo_clip',
      previewVideoUrl: 'https://cdn.portal.example/p/1.mp4',
      thumbnail: 'https://cdn.portal.example/t/1.jpg',
      tags: ['HDR', 'Scenic'],
      tagEntities: [{ name: 'HDR', url: 'https://portal.example/tags/hdr' }],
      categories: [{ name: 'Cinema', url: 'https://portal.example/c/cinema' }],
      duration: '10:00',
    },
    'vid_portal'
  );
  assert.equal(mapped.previewVideoUrl, 'https://cdn.portal.example/p/1.mp4');
  assert.deepEqual(mapped.tags, ['HDR', 'Scenic']);
  assert.equal(mapped.categories[0].name, 'Cinema');

  // Metric formatting preserves percentages/compact tokens and shortens huge integers
  assert.equal(modelMod.formatPortalMetric(4214329803), '4.2B');
  assert.equal(modelMod.formatPortalMetric(791523), '791.5K');
  assert.equal(modelMod.formatPortalMetric('25.406.458.344'), '25.4B');
  assert.equal(modelMod.formatPortalMetric('100.0%'), '100.0%');
});

test('frontend timeline services and i18n keys exist cleanly', () => {
  const trSrc = fs.readFileSync(path.resolve(FRONTEND_DIR, 'i18n/translations.ts'), 'utf8');
  assert.ok(trSrc.includes('dirTags:'), 'translations should keep dirTags');
  assert.ok(trSrc.includes('directUrlOpening') || trSrc.includes('videoPortal'), 'new bilingual video portal keys should exist');
  for (const key of ['portalTabVideos', 'portalTabCast', 'portalTabChannels', 'portalTabAbout', 'quickUrlPlaceholderVideoPortal', 'watchShowMoreTags']) {
    assert.ok(trSrc.includes(`${key}:`), `translations must include ${key}`);
  }
});
