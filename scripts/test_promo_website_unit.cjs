// Run: node --test scripts/test_promo_website_unit.cjs
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const websiteDir = path.join(root, 'website');

async function loadLib() {
  const libPath = path.join(websiteDir, 'lib.mjs');
  return import(pathToFileURL(libPath).href);
}

test('sanitizeExternalUrl only permits valid https URLs', async () => {
  const { sanitizeExternalUrl } = await loadLib();
  assert.equal(sanitizeExternalUrl(''), '');
  assert.equal(sanitizeExternalUrl('#'), '');
  assert.equal(sanitizeExternalUrl('http://example.com'), '');
  assert.equal(sanitizeExternalUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeExternalUrl('https://discord.gg/imagex'), 'https://discord.gg/imagex');
  assert.equal(sanitizeExternalUrl('https://ko-fi.com/imagex'), 'https://ko-fi.com/imagex');
});

test('selectReleaseAsset prioritizes IMAGEX-Windows.zip and gracefully falls back', async () => {
  const { selectReleaseAsset } = await loadLib();
  const payload = {
    tag_name: 'v5.8.1',
    html_url: 'https://github.com/profilehub-app/imagex/releases/tag/v5.8.1',
    assets: [
      { name: 'IMAGEX.exe', browser_download_url: 'https://github.com/profilehub-app/imagex/releases/download/v5.8.1/IMAGEX.exe', size: 80000000 },
      { name: 'IMAGEX-Windows.zip', browser_download_url: 'https://github.com/profilehub-app/imagex/releases/download/v5.8.1/IMAGEX-Windows.zip', size: 65000000 },
    ],
  };
  const zipChoice = selectReleaseAsset(payload, 'profilehub-app/imagex');
  assert.equal(zipChoice.version, 'v5.8.1');
  assert.equal(zipChoice.downloadUrl, 'https://github.com/profilehub-app/imagex/releases/download/v5.8.1/IMAGEX-Windows.zip');
  assert.equal(zipChoice.assetName, 'IMAGEX-Windows.zip');
  assert.equal(zipChoice.sizeBytes, 65000000);

  const fallback = selectReleaseAsset(null, 'profilehub-app/imagex');
  assert.equal(fallback.version, null);
  assert.equal(fallback.downloadUrl, 'https://github.com/profilehub-app/imagex/releases/latest');
});

test('resolveLanguage defaults to en and supports pt-BR overrides', async () => {
  const { resolveLanguage } = await loadLib();
  assert.equal(resolveLanguage({ search: '', stored: '' }), 'en');
  assert.equal(resolveLanguage({ search: '?lang=pt', stored: '' }), 'pt-BR');
  assert.equal(resolveLanguage({ search: '?lang=pt-BR', stored: '' }), 'pt-BR');
  assert.equal(resolveLanguage({ search: '', stored: 'pt-BR' }), 'pt-BR');
  assert.equal(resolveLanguage({ search: '?lang=en', stored: 'pt-BR' }), 'en');
});

test('website copy has 100% EN / PT-BR key parity and zero legacy -AI tokens', async () => {
  const { COPY } = await loadLib();
  const enKeys = Object.keys(COPY.en).sort();
  const ptKeys = Object.keys(COPY['pt-BR']).sort();
  assert.deepEqual(enKeys, ptKeys);

  const serialized = JSON.stringify(COPY);
  assert.doesNotMatch(serialized, /imagex[-_. ]?ai/i);
  assert.doesNotMatch(serialized, /jardieljw/i);
});

test('normalizeGithubRepo rejects dot segments and .git suffixes', async () => {
  const { normalizeGithubRepo } = await loadLib();
  assert.equal(normalizeGithubRepo('../evil'), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo('owner/..'), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo('./.'), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo('owner/repo.git'), 'profilehub-app/imagex');
  assert.equal(normalizeGithubRepo('profilehub-app/imagex'), 'profilehub-app/imagex');
});

test('website HTML and CSS satisfy modern-web-guidance and structural contracts', () => {
  const html = fs.readFileSync(path.join(websiteDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(websiteDir, 'styles.css'), 'utf8');
  const configJs = fs.readFileSync(path.join(websiteDir, 'config.js'), 'utf8');

  assert.match(html, /<meta\s+name="color-scheme"\s+content="dark">/i);
  assert.equal((html.match(/<h1\b/g) || []).length, 1, 'Expected exactly one <h1>');
  assert.match(html, /<header\b/);
  assert.match(html, /<main\b/);
  assert.match(html, /<footer\b/);
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 4);
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 4);
  assert.equal((html.match(/role="tabpanel"[^>]*hidden/g) || []).length, 3);
  assert.match(html, /id="ci-build-link"[^>]*class="inline-link"[^>]*data-i18n="step2BuildLogs"/);
  assert.doesNotMatch(html, /href="#"/);
  assert.doesNotMatch(html + css + configJs, /imagex[-_. ]?ai/i);
  assert.doesNotMatch(html + css + configJs, /jardieljw/i);
  assert.match(css, /color-scheme:\s*dark;/);
  assert.match(css, /\[hidden\]:not\(\[hidden="until-found"\]\)\s*\{\s*display:\s*none;/);
  assert.match(css, /\.hero-grid\s*>\s*\*\s*\{[^}]*min-width:\s*0;/);
  assert.match(css, /\.preview-shell\s*\{[^}]*min-width:\s*0;/);
  assert.match(css, /\.inline-link\s*\{/);
  assert.match(css, /\[role="tab"\][\s\S]*?font-size:\s*0\.78rem;/);
  assert.match(css, /@media\s*\(min-width:\s*1024px\)/);
  assert.match(css, /\[aria-selected="true"\]::after/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
