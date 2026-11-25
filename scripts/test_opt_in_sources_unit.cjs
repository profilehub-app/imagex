// Run: node --test scripts/test_opt_in_sources_unit.cjs
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');

const front = path.resolve(__dirname, '../frontend-mobile-preview');
const esbuild = require(path.join(front, 'node_modules/esbuild'));

function loadModules() {
  const bundle = esbuild.buildSync({
    stdin: {
      resolveDir: front,
      loader: 'ts',
      contents: `
        export * from './src/components/profile-hub/timeline/timelineOptIn';
        export { createSearchCoordinator } from './src/services/timelineSearch';
      `,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logLevel: 'silent',
  });
  const mod = new Module('opt-in-fixture');
  mod._compile(bundle.outputFiles[0].text, path.join(front, 'opt-in-fixture.cjs'));
  return mod.exports;
}

test('cold start derives ONLY all without hardcoded x/instagram/youtube pills', () => {
  const { deriveActiveTimelineSources } = loadModules();
  const active = deriveActiveTimelineSources({
    integratedSources: [],
    integratedSourcesStatus: 'loaded',
    browseCapabilities: {},
    creatorSites: [],
    postSources: [],
    activeSource: 'all',
  });
  assert.deepEqual([...active], ['all']);
});

test('unavailable backend fallback preserves mocked browseCapabilities for static E2E tests', () => {
  const { deriveActiveTimelineSources } = loadModules();
  const active = deriveActiveTimelineSources({
    integratedSources: [],
    integratedSourcesStatus: 'unavailable',
    browseCapabilities: {
      vid_portal: { source_id: 'vid_portal', display_name: 'Video Portal', default_category: 'recent', categories: ['recent'], subfilters: [], supports_quick_url_open: true },
    },
    creatorSites: [],
    postSources: [],
    activeSource: 'all',
  });
  assert.equal(active.has('vid_portal'), true);
  assert.equal(active.has('youtube'), false);
  assert.equal(active.has('x'), false);
});

test('loaded state honors explicit integratedSources + creatorSites + invalidateSources', async () => {
  const { deriveActiveTimelineSources, createSearchCoordinator } = loadModules();
  const active = deriveActiveTimelineSources({
    integratedSources: [
      { id: 'youtube', displayName: 'YouTube', originUrl: 'https://youtube.com', domains: ['youtube.com'], kind: 'builtin', addedVia: 'https://youtube.com/@NASA', integratedAt: '2026-11-24T00:00:00Z' },
    ],
    integratedSourcesStatus: 'loaded',
    browseCapabilities: {},
    creatorSites: ['x'],
    postSources: [],
    activeSource: 'all',
  });
  assert.equal(active.has('youtube'), true);
  assert.equal(active.has('x'), true);
  assert.equal(active.has('instagram'), false);

  let liveXCalls = 0;
  let sourceFetchCount = 0;
  const coordinator = createSearchCoordinator({
    fetchSources: async () => {
      sourceFetchCount += 1;
      if (sourceFetchCount === 1) {
        return [{ id: 'youtube', name: 'YouTube', categories: ['videos'], supportsLiveConnector: false }];
      }
      return [
        { id: 'youtube', name: 'YouTube', categories: ['videos'], supportsLiveConnector: false },
        { id: 'x', name: 'X', categories: ['profiles', 'posts'], supportsLiveConnector: true },
      ];
    },
    postOmniSearch: async () => ({
      ok: true,
      query: 'nasa',
      posts: [],
      creators: [],
      sections: { profiles: [], playlists: [], videos: [], shorts: [], albums: [], gifs: [], posts: [] },
      cursors: {},
      sourceStatus: {},
      hasMore: false,
    }),
    readLiveXSearch: async () => {
      liveXCalls += 1;
      return { status: 'ok', items: [], relevantPeople: [] };
    },
  });

  await coordinator.search('nasa', 'all');
  assert.equal(liveXCalls, 0, 'Must NOT run live X search until x is integrated');

  coordinator.invalidateSources();
  await coordinator.search('nasa', 'all');
  assert.ok(liveXCalls > 0, 'Must run live X search once x is integrated');
});
