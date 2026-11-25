import {
  COPY,
  formatBytes,
  normalizeGithubRepo,
  resolveLanguage,
  sanitizeExternalUrl,
  selectReleaseAsset,
} from './lib.mjs';

const rawConfig = (typeof window !== 'undefined' && window.IMAGEX_SITE_CONFIG) || {};
const githubRepo = normalizeGithubRepo(rawConfig.githubRepo);
const communityUrl = sanitizeExternalUrl(rawConfig.communityUrl);
const donatePrimaryUrl = sanitizeExternalUrl(rawConfig.donatePrimaryUrl);
const donateSecondaryUrl = sanitizeExternalUrl(rawConfig.donateSecondaryUrl);
const repoUrl = `https://github.com/${githubRepo}`;
const defaultReleasesUrl = `${repoUrl}/releases/latest`;

let currentLang = 'en';
let latestReleaseInfo = selectReleaseAsset(null, githubRepo);

function safeGetStoredLang() {
  try {
    return localStorage.getItem('imagex_site_lang') || '';
  } catch {
    return '';
  }
}

function safeStoreLang(lang) {
  try {
    localStorage.setItem('imagex_site_lang', lang);
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

function setHrefOrHide(el, url) {
  if (!el) return;
  if (url) {
    el.href = url;
    el.hidden = false;
  } else {
    el.removeAttribute('href');
    el.hidden = true;
  }
}

function applyTranslations(lang) {
  currentLang = lang === 'pt-BR' ? 'pt-BR' : 'en';
  const dict = COPY[currentLang];
  document.documentElement.lang = currentLang === 'pt-BR' ? 'pt-BR' : 'en';
  document.title = dict.pageTitle;

  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    if (key && Object.hasOwn(dict, key)) {
      node.textContent = dict[key];
    }
  }

  for (const btn of document.querySelectorAll('[data-lang-btn]')) {
    const active = btn.getAttribute('data-lang-btn') === currentLang;
    btn.setAttribute('aria-pressed', String(active));
  }

  renderReleaseMetadata();
}

function renderReleaseMetadata() {
  const dict = COPY[currentLang];
  const versionBadge = document.getElementById('release-version-pill');
  const metaText = document.getElementById('download-meta-text');
  const primaryDownload = document.getElementById('hero-download-btn');
  const headerDownload = document.getElementById('header-download-btn');

  if (primaryDownload) primaryDownload.href = latestReleaseInfo.downloadUrl || defaultReleasesUrl;
  if (headerDownload) headerDownload.href = latestReleaseInfo.downloadUrl || defaultReleasesUrl;

  if (versionBadge) {
    versionBadge.textContent = latestReleaseInfo.version || 'v5.8+';
  }

  if (metaText) {
    if (latestReleaseInfo.version) {
      const sizeStr = formatBytes(latestReleaseInfo.sizeBytes);
      const sizePart = sizeStr ? ` • ${sizeStr}` : '';
      metaText.textContent = `${latestReleaseInfo.version} • ${latestReleaseInfo.assetName}${sizePart}`;
    } else {
      metaText.textContent = dict.ctaDownloadMetaFallback;
    }
  }
}

function wireExternalLinks() {
  const sourceBtn = document.getElementById('hero-source-btn');
  const footerRepo = document.getElementById('footer-repo-link');
  const ciBuildLink = document.getElementById('ci-build-link');
  if (sourceBtn) sourceBtn.href = repoUrl;
  if (footerRepo) footerRepo.href = repoUrl;
  if (ciBuildLink) ciBuildLink.href = `${repoUrl}/actions`;

  setHrefOrHide(document.getElementById('hero-community-btn'), communityUrl);
  setHrefOrHide(document.getElementById('section-community-btn'), communityUrl);
  setHrefOrHide(document.getElementById('hero-donate-btn'), donatePrimaryUrl);
  setHrefOrHide(document.getElementById('section-donate-btn'), donatePrimaryUrl);
  setHrefOrHide(document.getElementById('section-donate-secondary-btn'), donateSecondaryUrl);

  const pendingNote = document.getElementById('community-pending-note');
  if (pendingNote) {
    pendingNote.hidden = Boolean(communityUrl || donatePrimaryUrl || donateSecondaryUrl);
  }
}

function wireTabs() {
  const tablist = document.querySelector('[role="tablist"]');
  if (!tablist) return;
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));

  const selectTab = (targetTab, moveFocus = false) => {
    for (const tab of tabs) {
      const selected = tab === targetTab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.toggleAttribute('focusgroupstart', selected);
    }
    for (const panel of panels) {
      const owns = panel.getAttribute('aria-labelledby') === targetTab.id;
      if (owns) {
        panel.removeAttribute('hidden');
      } else {
        panel.setAttribute('hidden', 'until-found');
      }
    }
    targetTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (moveFocus) targetTab.focus();
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab));
  }

  tablist.addEventListener('keydown', (event) => {
    const idx = tabs.indexOf(document.activeElement);
    if (idx === -1) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      selectTab(tabs[(idx + 1) % tabs.length], true);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      selectTab(tabs[(idx - 1 + tabs.length) % tabs.length], true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectTab(tabs[0], true);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectTab(tabs[tabs.length - 1], true);
    }
  });

  for (const panel of panels) {
    panel.addEventListener('beforematch', () => {
      const tabId = panel.getAttribute('aria-labelledby');
      const ownerTab = tabs.find((t) => t.id === tabId);
      if (ownerTab) selectTab(ownerTab);
    });
  }
}

async function fetchLatestRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    latestReleaseInfo = selectReleaseAsset(data, githubRepo);
    renderReleaseMetadata();
  } catch {
    // Keep graceful GitHub releases/latest fallback when offline or rate-limited.
  }
}

function init() {
  wireExternalLinks();
  wireTabs();

  for (const btn of document.querySelectorAll('[data-lang-btn]')) {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-lang-btn') || 'en';
      safeStoreLang(next);
      applyTranslations(next);
    });
  }

  const initialLang = resolveLanguage({
    search: window.location.search,
    stored: safeGetStoredLang(),
  });
  applyTranslations(initialLang);
  void fetchLatestRelease();
}

init();
