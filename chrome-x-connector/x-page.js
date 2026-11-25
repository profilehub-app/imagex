const profileLink = '[data-testid="AppTabBar_Profile_Link"]';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tabNames = {
  recommended: /^(For you|Para você|Para ti)$/i,
  following: /^(Following|Seguindo|Siguiendo)$/i,
};

async function waitFor(read, timeout) {
  const end = Date.now() + timeout;
  do {
    const value = read();
    if (value) return value;
    await sleep(150);
  } while (Date.now() < end);
  return null;
}

function signInPage() {
  return location.pathname.startsWith('/i/flow/login') || location.pathname === '/login' ||
    document.querySelector('input[autocomplete="username"], a[href="/login"]');
}

const seenByScope = new Map();
async function batch({ scope, handle, postId, searchQuery = '', searchTab = 'top', advance, expectAccounts }) {
  const path = location.pathname.toLowerCase().replace(/\/$/, '');
  if (expectAccounts && !signInPage() && path !== `/${handle.toLowerCase()}/following`) {
    return { error: 'waiting_for_accounts' };
  }
  const ready = await waitFor(() => document.querySelector(profileLink) || signInPage(), 8000);
  const profile = document.querySelector(profileLink);
  if (!profile) {
    return ready ? { status: 'login_required', items: [] } : { error: 'source_timeout' };
  }
  if ((tabNames[scope] && path !== '/home') ||
      (scope === 'explore' && !path.startsWith('/explore')) ||
      (scope === 'search' && path !== '/search') ||
      (scope === 'profile' && path !== `/${handle.toLowerCase()}`) ||
      (scope === 'post' && !path.includes(`/status/${String(postId || '').toLowerCase()}`))) {
    return { error: 'cursor_expired' };
  }
  if (scope === 'accounts' && !location.pathname.endsWith('/following')) {
    return { followingHandle: profile.getAttribute('href')?.replace(/^\/|\/$/g, '') };
  }
  if (tabNames[scope]) {
    const tab = await waitFor(() => [...document.querySelectorAll('[role="tab"]')]
      .find(element => tabNames[scope].test(element.innerText.trim())), 5000);
    if (!tab) return { error: 'source_unavailable' };
    if (tab.getAttribute('aria-selected') !== 'true') {
      tab.click();
      await waitFor(() => tab.getAttribute('aria-selected') === 'true', 3000);
    }
  }
  const isSearchPeople = scope === 'search' && searchTab === 'people';
  const accounts = scope === 'accounts' || isSearchPeople;
  const selector = accounts
    ? '[data-testid="UserCell"]'
    : scope === 'explore'
      ? '[data-testid="trend"], article[data-testid="tweet"]'
      : scope === 'search' && searchTab === 'top'
        ? 'article[data-testid="tweet"], [data-testid="UserCell"]'
        : 'article[data-testid="tweet"]';
  await waitFor(() => document.querySelector(selector), scope === 'explore' ? 8500 : 6500);
  if (scope === 'profile' && !advance) {
    // Wait briefly so X finishes mounting Following/Followers counts and banner before initial read.
    await waitFor(
      () => document.querySelector('a[href$="/following" i], a[href$="/followers" i], a[href$="/verified_followers" i]'),
      2500,
    );
  }
  const scopeKey = scope === 'search'
    ? `search:${searchTab}:${String(searchQuery || '').toLowerCase()}`
    : scope === 'post'
      ? `post:${postId}`
      : scope === 'profile'
        ? `profile:${(handle || '').toLowerCase()}`
        : scope;
  const seen = advance ? (seenByScope.get(scopeKey) || new Set()) : new Set();
  const collected = new Map();
  let latestProfile = null;
  const trendMap = new Map();
  const relevantMap = new Map();

  const harvest = () => {
    const snapshot = readImageXTimeline();
    if (snapshot.profile) {
      latestProfile = {
        ...(latestProfile || {}),
        ...snapshot.profile,
        banner: snapshot.profile.banner || latestProfile?.banner,
        avatar: snapshot.profile.avatar || latestProfile?.avatar,
        bio: snapshot.profile.bio || latestProfile?.bio,
        following: snapshot.profile.following ?? latestProfile?.following,
        followers: snapshot.profile.followers ?? latestProfile?.followers,
        postsCount: snapshot.profile.postsCount ?? latestProfile?.postsCount,
      };
    }
    for (const tr of snapshot.trends || []) {
      if (tr?.topic && !trendMap.has(tr.topic.toLowerCase())) trendMap.set(tr.topic.toLowerCase(), tr);
    }
    for (const rp of snapshot.relevantPeople || []) {
      const h = (rp?.handle || '').toLowerCase();
      if (h && !relevantMap.has(h)) relevantMap.set(h, rp);
    }
    if (scope === 'search' && searchTab === 'top') {
      for (const rp of snapshot.accounts || []) {
        const h = (rp?.handle || '').toLowerCase();
        if (h && !relevantMap.has(h)) relevantMap.set(h, rp);
      }
    }
    let added = 0;
    for (const rawItem of accounts ? snapshot.accounts : snapshot.posts) {
      const item = scope === 'following' || accounts
        ? { ...rawItem, isFollowing: rawItem.isFollowing ?? true }
        : rawItem;
      const id = accounts ? item.handle.toLowerCase() : item.id;
      if (!seen.has(id) && !collected.has(id)) {
        collected.set(id, item);
        added += 1;
      }
    }
    return added;
  };

  // Always capture initial viewport first (so focal tweet / top trends are never virtualized away).
  harvest();

  if (scope === 'post' && !advance) {
    // Scroll down to trigger X's TweetDetail reply hydration below tall focal media.
    for (let step = 0; step < 4; step++) {
      window.scrollBy(0, step === 0 ? 760 : 900);
      await waitFor(() => {
        const added = harvest();
        return added > 0 && collected.size > 1;
      }, step === 0 ? 4800 : 1500);
      harvest();
      if (collected.size >= 10) break;
    }
  } else if (scope === 'explore' && !advance) {
    // Capture both top trending topics and live Explore posts below them.
    for (let step = 0; step < 3; step++) {
      window.scrollBy(0, 950);
      await waitFor(() => harvest() > 0, 1200);
      harvest();
      if (collected.size >= 6 && trendMap.size >= 3) break;
    }
  } else if (advance) {
    const scrollDelta = Math.max(window.innerHeight || 900, 950);
    for (let step = 1; step <= 6; step++) {
      window.scrollBy(0, scrollDelta);
      await waitFor(() => harvest() > 0, 1600);
      harvest();
      if (collected.size >= 3 || (step >= 2 && collected.size > 0)) break;
    }
  }

  for (const id of collected.keys()) seen.add(id);
  seenByScope.set(scopeKey, seen);
  const latestTrends = [...trendMap.values()];
  const latestRelevant = [...relevantMap.values()];
  return {
    status: 'ready',
    items: [...collected.values()],
    ...(latestProfile ? { profile: latestProfile } : {}),
    ...(latestTrends.length ? { trends: latestTrends } : {}),
    ...(latestRelevant.length ? { relevantPeople: latestRelevant } : {}),
  };
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id || request?.type !== 'imagex-x-read') return;
  batch(request).then(respond, () => respond({ error: 'source_unavailable' }));
  return true;
});
