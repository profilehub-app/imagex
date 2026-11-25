// Run: node --test scripts/test_community_support_unit.cjs
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
        export * from './src/services/communityConfig';
        export { SupportTriggerButton } from './src/components/common/SupportButton';
        export { SupportDialogContent } from './src/components/common/SupportDialog';
        export { React, renderToStaticMarkup };
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
  const mod = new Module('community-support-fixture');
  mod._compile(bundle.outputFiles[0].text, path.join(front, 'community-support-fixture.cjs'));
  return mod.exports;
}

test('normalizeGithubRepo defaults to profilehub-app/imagex and rejects invalid slugs', () => {
  const { DEFAULT_GITHUB_REPO, normalizeGithubRepo } = compileBundle();
  assert.equal(DEFAULT_GITHUB_REPO, 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo(undefined), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo(''), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo('  https://github.com/evil '), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo('../evil'), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo('owner/..'), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo('./.'), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo('owner/repo.git'), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo('profilehub/imagex-next'), 'profilehub/imagex-next');
  assert.equal(normalizeGithubRepo('ProfileHub/ImageX_2.0'), 'ProfileHub/ImageX_2.0');
});

test('validatePublicHttpsUrl accepts only valid https URLs and rejects unsafe/empty inputs', () => {
  const { validatePublicHttpsUrl } = compileBundle();
  assert.equal(validatePublicHttpsUrl(''), '');
  assert.equal(validatePublicHttpsUrl('   '), '');
  assert.equal(validatePublicHttpsUrl('#'), '');
  assert.equal(validatePublicHttpsUrl('http://ko-fi.com/imagex'), '');
  assert.equal(validatePublicHttpsUrl('javascript:alert(1)'), '');
  assert.equal(validatePublicHttpsUrl('data:text/html,hi'), '');
  assert.equal(validatePublicHttpsUrl('not a url'), '');
  assert.equal(
    validatePublicHttpsUrl('  https://ko-fi.com/imagex  '),
    'https://ko-fi.com/imagex'
  );
  assert.equal(
    validatePublicHttpsUrl('https://discord.gg/abc123XYZ'),
    'https://discord.gg/abc123XYZ'
  );
});

test('getCommunityConfig returns safe defaults when unconfigured and detects configured URLs', () => {
  const { getCommunityConfig } = compileBundle();
  const emptyCfg = getCommunityConfig({});
  assert.equal(emptyCfg.githubRepo, 'profilehub-app/imagex');
  assert.equal(emptyCfg.releasesUrl, 'https://github.com/profilehub-app/imagex/releases');
  assert.equal(emptyCfg.promoSiteUrl, '');
  assert.equal(emptyCfg.communityUrl, '');
  assert.equal(emptyCfg.donateUrl, '');
  assert.equal(emptyCfg.donateSecondaryUrl, '');
  assert.equal(emptyCfg.hasConfiguredChannels, false);

  const liveCfg = getCommunityConfig({
    VITE_GITHUB_REPO: 'profilehub-app/imagex',
    VITE_PROMO_SITE_URL: 'https://profilehub-app.github.io/imagex/',
    VITE_COMMUNITY_URL: 'https://discord.gg/imagex',
    VITE_DONATE_URL: 'https://ko-fi.com/imagex',
    VITE_DONATE_SECONDARY_URL: 'http://insecure.example/ignore',
  });
  assert.equal(liveCfg.promoSiteUrl, 'https://profilehub-app.github.io/imagex/');
  assert.equal(liveCfg.communityUrl, 'https://discord.gg/imagex');
  assert.equal(liveCfg.donateUrl, 'https://ko-fi.com/imagex');
  assert.equal(liveCfg.donateSecondaryUrl, '');
  assert.equal(liveCfg.hasConfiguredChannels, true);
});

test('SupportTriggerButton renders bilingual labels in full and compact modes', () => {
  const { React, renderToStaticMarkup, SupportTriggerButton } = compileBundle();
  const fullPt = renderToStaticMarkup(
    React.createElement(SupportTriggerButton, { lang: 'pt-BR', compact: false, onClick: () => {} })
  );
  assert.match(fullPt, /Comunidade &amp; Apoio/);

  const compactEn = renderToStaticMarkup(
    React.createElement(SupportTriggerButton, { lang: 'en-US', compact: true, onClick: () => {} })
  );
  assert.match(compactEn, /aria-label="Community &amp; Support"/);
  assert.doesNotMatch(compactEn, />Community &amp; Support</);
});

test('SupportDialogContent handles unconfigured links gracefully without dead hrefs', () => {
  const { React, renderToStaticMarkup, SupportDialogContent, getCommunityConfig } = compileBundle();
  const html = renderToStaticMarkup(
    React.createElement(SupportDialogContent, {
      lang: 'en-US',
      config: getCommunityConfig({}),
      onClose: () => {},
    })
  );
  assert.match(html, /Community &amp; Support/);
  assert.match(html, /https:\/\/github\.com\/profilehub-app\/imagex\/releases/);
  assert.match(html, /appear here once configured/);
  assert.doesNotMatch(html, /href="#"/);
  assert.doesNotMatch(html, /Join Community/);
  assert.doesNotMatch(html, /Support \/ Donate/);
});

test('SupportDialogContent renders configured https links safely in both languages', () => {
  const { React, renderToStaticMarkup, SupportDialogContent, getCommunityConfig } = compileBundle();
  const cfg = getCommunityConfig({
    VITE_PROMO_SITE_URL: 'https://profilehub-app.github.io/imagex/',
    VITE_COMMUNITY_URL: 'https://discord.gg/imagex',
    VITE_DONATE_URL: 'https://ko-fi.com/imagex',
    VITE_DONATE_SECONDARY_URL: 'https://github.com/sponsors/profilehub',
  });
  const htmlEn = renderToStaticMarkup(
    React.createElement(SupportDialogContent, { lang: 'en-US', config: cfg, onClose: () => {} })
  );
  assert.match(htmlEn, /href="https:\/\/discord\.gg\/imagex"/);
  assert.match(htmlEn, /href="https:\/\/ko-fi\.com\/imagex"/);
  assert.match(htmlEn, /href="https:\/\/github\.com\/sponsors\/profilehub"/);
  assert.match(htmlEn, /href="https:\/\/profilehub-app\.github\.io\/imagex\/"/);
  assert.match(htmlEn, /rel="noopener noreferrer"/);

  const htmlPt = renderToStaticMarkup(
    React.createElement(SupportDialogContent, { lang: 'pt-BR', config: cfg, onClose: () => {} })
  );
  assert.match(htmlPt, /Entrar na Comunidade/);
  assert.match(htmlPt, /Apoiar com Doação/);
  assert.match(htmlPt, /Página do Projeto/);
});
