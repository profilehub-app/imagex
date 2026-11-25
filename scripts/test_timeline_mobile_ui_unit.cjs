// Run: node --test scripts/test_timeline_mobile_ui_unit.cjs
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');

const front = path.resolve(__dirname, '../frontend-mobile-preview');
const esbuild = require(path.join(front, 'node_modules/esbuild'));

function compileBundle() {
  const bundle = esbuild.buildSync({
    stdin: {
      resolveDir: front,
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        export { ImagexAppMark } from './src/components/profile-hub/timeline/ImagexAppMark';
        export { TimelineMobileHeader } from './src/components/profile-hub/timeline/TimelineMobileHeader';
        export { TimelineSourceBar } from './src/components/profile-hub/timeline/TimelineSourceBar';
        export { TimelineSourcesSheetBody } from './src/components/profile-hub/timeline/TimelineSourcesSheet';
        export {
          computeMobileChromeCollapsed,
          computeBottomSheetDismiss,
        } from './src/components/profile-hub/timeline/timelineOptIn';
        export { renderToStaticMarkup };
        export { React };
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
  const mod = new Module('mobile-ui-fixture');
  mod._compile(bundle.outputFiles[0].text, path.join(front, 'mobile-ui-fixture.cjs'));
  return mod.exports;
}

test('computeMobileChromeCollapsed handles downward collapse, upward reveal, and lock state', () => {
  const { computeMobileChromeCollapsed } = compileBundle();
  assert.equal(computeMobileChromeCollapsed(false, 80, 50, false), true);
  assert.equal(computeMobileChromeCollapsed(true, 100, 120, false), false);
  assert.equal(computeMobileChromeCollapsed(true, 10, 15, false), false);
  assert.equal(computeMobileChromeCollapsed(true, 160, 100, true), false);
});

test('computeBottomSheetDismiss respects inner scroll and flick/distance thresholds', () => {
  const { computeBottomSheetDismiss } = compileBundle();
  assert.deepEqual(computeBottomSheetDismiss(140, 0.9, 12), { activeDragY: 0, shouldDismiss: false });
  assert.deepEqual(computeBottomSheetDismiss(40, 0.1, 0), { activeDragY: 40, shouldDismiss: false });
  assert.deepEqual(computeBottomSheetDismiss(96, 0.1, 0), { activeDragY: 96, shouldDismiss: true });
  assert.deepEqual(computeBottomSheetDismiss(35, 0.6, 0), { activeDragY: 35, shouldDismiss: true });
});

test('TimelineMobileHeader renders Profile Hub, IMAGEX app mark, single Sources button, and 44px controls', () => {
  const { React, renderToStaticMarkup, TimelineMobileHeader } = compileBundle();
  const html = renderToStaticMarkup(
    React.createElement(TimelineMobileHeader, {
      sourcesCount: 2,
      searchOpen: false,
      collapsed: true,
      onToggleSearch: () => {},
      onOpenSourcesSheet: () => {},
      onOpenMobileMenu: () => {},
    })
  );
  assert.match(html, />Profile Hub</);
  assert.doesNotMatch(html, />Timeline</);
  assert.match(html, /data-imagex-app-mark="true"/);
  assert.match(html, /data-open-sources-sheet="true"/);
  assert.match(html, /Fontes \(2\)|Sources \(2\)/);
  assert.match(html, /tl-mobile-header--collapsed/);
  assert.match(html, /min-h-\[44px\]/);
});

test('TimelineSourceBar shows zero pre-installed platforms on clean start and omits mobile select dropdown', () => {
  const { React, renderToStaticMarkup, TimelineSourceBar } = compileBundle();
  const coldHtml = renderToStaticMarkup(
    React.createElement(TimelineSourceBar, {
      source: 'all',
      available: new Set(['all']),
      isEn: false,
      isMobile: true,
      onChange: () => {},
    })
  );
  assert.match(coldHtml, /data-source-pill="all"/);
  assert.doesNotMatch(coldHtml, /data-source-pill="(x|youtube|instagram)"/);
  assert.doesNotMatch(coldHtml, /<select/);

  const populatedMobile = renderToStaticMarkup(
    React.createElement(TimelineSourceBar, {
      source: 'youtube',
      available: new Set(['all', 'youtube', 'x', 'portal_grid', 'portal_tube', 'imgur']),
      isEn: false,
      isMobile: true,
      onChange: () => {},
    })
  );
  assert.match(populatedMobile, /data-source-pill="youtube"/);
  assert.match(populatedMobile, /data-source-pill="imgur"/);
  assert.doesNotMatch(populatedMobile, /<select/);
  assert.match(populatedMobile, /tl-pressable/);
});

test('TimelineSourcesSheetBody renders Option A form, Integrated Networks, and Saved Creators with >=44px targets', () => {
  const { React, renderToStaticMarkup, TimelineSourcesSheetBody } = compileBundle();
  const html = renderToStaticMarkup(
    React.createElement(TimelineSourcesSheetBody, {
      isEn: false,
      activeSource: 'all',
      integratedSources: [
        { id: 'youtube', displayName: 'YouTube', originUrl: 'https://youtube.com', domains: ['youtube.com'], kind: 'builtin', addedVia: 'https://youtube.com/@NASA', integratedAt: '2026-11-24T00:00:00Z' },
      ],
      creatorEntries: [{ id: 'c1', name: 'NASA', handle: '@NASA', avatar: '', profileUrl: 'https://youtube.com/@NASA', site: 'youtube', postCount: 12 }],
      creatorSearch: '',
      integrating: false,
      lastIntegrationResult: { ok: true, matched: true, supported: true, sources: [], integration: { ok: true, matched: true, supported: true, sourceId: 'youtube', displayName: 'YouTube', level: 'profile', suggestedHandle: '@NASA' } },
      onCreatorSearchChange: () => {},
      onSelectSource: () => {},
      onSelectCreator: () => {},
      onIntegrateUrl: async () => {},
      onRemoveSource: async () => {},
      onResetSources: async () => {},
    })
  );
  assert.match(html, /type="url"/);
  assert.match(html, /min-h-\[44px\]/);
  assert.match(html, /YouTube/);
  assert.match(html, /@NASA/);
});
