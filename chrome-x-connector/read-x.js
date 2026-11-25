// Keep the DOM reader identical to READ_TIMELINE in src/server/social_timeline.py.
const readImageXTimeline = () => {
  const main = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main');
  if (!main) return {posts: [], accounts: [], profile: null, trends: []};
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible';
  const value = (node, selector) => node.querySelector(selector)?.innerText?.trim();
  const unique = values => [...new Set(values.filter(Boolean))];
  const https = (raw, hosts) => {
    try {
      const url = new URL(raw, location.origin);
      return url.protocol === 'https:' && !url.port && !url.username && !url.password
        && hosts.includes(url.hostname) ? url : null;
    } catch { return null; }
  };
  const handleFor = raw => https(raw, ['x.com', 'twitter.com'])?.pathname.match(/^\/([\w]{1,15})\/?$/)?.[1];
  const cdn = (raw, hosts = ['pbs.twimg.com', 'abs.twimg.com']) => raw && https(raw, hosts)?.href;
  const bgUrl = (node, selector) => {
    for (const el of node.querySelectorAll(selector)) {
      const bg = el.style?.backgroundImage || getComputedStyle(el).backgroundImage || '';
      const match = bg.match(/url\(["']?(https:\/\/[^"')]+)["']?\)/i);
      if (match && cdn(match[1])) return cdn(match[1]);
    }
    return undefined;
  };
  const hiResAvatar = url => url ? url.replace(/_(normal|bigger|mini|200x200)\.(jpe?g|png|webp|gif)/i, '_400x400.$2') : undefined;
  const extractAvatar = root => {
    const img = root.querySelector(
      '[data-testid="Tweet-User-Avatar"] img, [data-testid*="User-Avatar"] img, [data-testid*="UserAvatar"] img, a[href$="/photo"] img, img[src*="profile_images"], img[src*="default_profile_images"]'
    );
    const direct = cdn(img?.currentSrc || img?.src);
    if (direct) return hiResAvatar(direct);
    return hiResAvatar(bgUrl(root, '[data-testid="Tweet-User-Avatar"] [style*="background-image"], [data-testid*="UserAvatar"] [style*="background-image"], a[href$="/photo"] [style*="background-image"]'));
  };
  const textWithEmoji = root => {
    if (!root) return undefined;
    let out = '';
    const walk = node => {
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
      } else if (node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === 'IMG') {
          out += node.getAttribute('alt') || '';
        } else if (tag === 'BR') {
          out += '\n';
        } else {
          for (const child of node.childNodes) walk(child);
        }
      }
    };
    walk(root);
    return (out.trim() || root.innerText?.trim() || undefined);
  };
  const parseCompact = raw => {
    if (!raw) return null;
    const clean = String(raw).replace(/\u00a0/g, ' ').trim();
    const match = clean.match(/(\d+(?:[.,]\d+)?)\s*([KMB]|mil|mi|bi)?/i);
    if (!match) return null;
    const suffix = (match[2] || '').toLowerCase();
    const factor = {k: 1e3, mil: 1e3, m: 1e6, mi: 1e6, b: 1e9, bi: 1e9}[suffix];
    if (factor) return Math.round(Number(match[1].replace(',', '.')) * factor);
    const digits = match[1].replace(/[.,]/g, '');
    return /^\d+$/.test(digits) ? Number(digits) : null;
  };
  const author = (node, handle) => {
    const name = node.querySelector('[data-testid="User-Name"], [data-testid="UserName"]') || node;
    const parts = name.innerText?.split('\n').map(part => part.trim()).filter(Boolean) || [];
    const verified = Boolean(name.querySelector('[data-testid="icon-verified"], svg[aria-label*="Verified"], svg[aria-label*="Verificado"]'));
    return {
      handle,
      name: parts.find(part => !part.startsWith('@') && part !== '·') || handle,
      avatar: extractAvatar(node),
      verified,
    };
  };
  const status = raw => {
    const match = https(raw, ['x.com', 'twitter.com'])?.pathname.match(/^\/([\w]{1,15})\/status\/(\d+)(?:\/|$)/);
    return match && {id: match[2], handle: match[1], url: `https://x.com/${match[1]}/status/${match[2]}`};
  };
  const count = (node, testId, excluded = null) => {
    const els = [...node.querySelectorAll(`[data-testid="${testId}"]`)].filter(el => !excluded?.contains(el));
    const el = els[0];
    if (!el) return null;
    const raw = el.innerText?.trim();
    if (raw) return parseCompact(raw);
    const aria = el.getAttribute('aria-label') || '';
    const m = aria.match(/(\d+(?:[.,]\d+)?\s*(?:[KMB]|mil|mi|bi)?)/i);
    if (m) return parseCompact(m[1]);
    return 0;
  };
  const extractViews = (node, excluded = null) => {
    const analytics = [...node.querySelectorAll('a[href$="/analytics"]')].find(el => !excluded?.contains(el));
    if (analytics) {
      const parsed = parseCompact(analytics.innerText?.trim() || analytics.getAttribute('aria-label') || '');
      if (parsed != null) return parsed;
    }
    for (const span of node.querySelectorAll('span')) {
      if (excluded?.contains(span)) continue;
      const txt = span.innerText?.trim() || '';
      if (txt.length > 0 && txt.length < 32 && /\b(?:views|visualiza(?:ç|c)[õo]es)\b/i.test(txt)) {
        const parsed = parseCompact(txt);
        if (parsed != null) return parsed;
      }
    }
    return null;
  };
  const pageStatus = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
  const read = (node, excluded = null, allowPageFallback = false) => {
    const owned = selector => [...node.querySelectorAll(selector)].filter(child => !excluded?.contains(child));
    const stamp = node.querySelector('time[datetime]');
    let source = status(stamp?.closest('a[href]')?.href)
      || Array.from(node.querySelectorAll('a[href*="/status/"]'), a => status(a.href)).find(Boolean);
    if (!source && allowPageFallback && pageStatus) {
      source = {id: pageStatus[2], handle: pageStatus[1], url: `https://x.com/${pageStatus[1]}/status/${pageStatus[2]}`};
    }
    if (!source) return null;
    const sensitive = [...node.querySelectorAll('[role="button"], button')].some(button =>
      /^(show|view)\s+(this\s+)?(sensitive\s+)?(content|media)|^(exibir|mostrar|ver)\s+(o\s+)?(conteúdo|mídia)/i.test(button.innerText?.trim()));
    const mediaImgs = sensitive ? [] : owned('[data-testid="tweetPhoto"] img, [data-testid*="card.layout"] img')
      .map(img => cdn(img.currentSrc || img.src || img.getAttribute('src')));
    const mediaBgs = sensitive ? [] : owned('[data-testid="tweetPhoto"] [style*="background-image"]')
      .map(el => {
        const bg = el.style?.backgroundImage || getComputedStyle(el).backgroundImage || '';
        const m = bg.match(/url\(["']?(https:\/\/[^"')]+)["']?\)/i);
        return m ? cdn(m[1]) : undefined;
      });
    const media = [...mediaImgs, ...mediaBgs];
    const video = sensitive ? null : owned('video')[0];
    return {
      ...source,
      ...author(node, source.handle),
      text: textWithEmoji(owned('[data-testid="tweetText"]')[0]),
      date: stamp?.dateTime || '',
      photos: unique(media),
      video: cdn(video?.currentSrc || video?.src || video?.getAttribute('src'), ['video.twimg.com'])
        || cdn(video?.querySelector('source')?.src || video?.querySelector('source')?.getAttribute('src'), ['video.twimg.com']),
      poster: sensitive ? undefined : cdn(video?.poster || owned('[data-testid="videoPlayer"] img')[0]?.src || owned('[data-testid="videoPlayer"] img')[0]?.getAttribute('src')),
      hasVideo: !sensitive && owned('video, [data-testid="videoPlayer"]').length > 0,
    };
  };
  const articleNodes = [...main.querySelectorAll('article[data-testid="tweet"]')].filter(visible);
  const posts = articleNodes.flatMap((node, idx) => {
    const outerTime = node.querySelector('time');
    const embedded = [...node.querySelectorAll('[role="link"]')].filter(visible).find(link =>
      !link.contains(outerTime) && link.querySelector('[data-testid="tweetText"], [data-testid="tweetPhoto"]')
        && link.querySelector('[data-testid="User-Name"], a[href*="/status/"]'));
    const post = read(node, embedded, Boolean(pageStatus && idx === 0));
    if (!post) return [];
    const quoted = embedded && read(embedded);
    const social = value(node, '[data-testid="socialContext"]');
    if (quoted && quoted.id !== post.id) {
      post.relation = {kind: 'quote', post: {
        text: quoted.text, creatorName: quoted.name, creatorHandle: '@' + quoted.handle,
        originalUrl: quoted.url, photos: quoted.photos, thumbnailUrl: quoted.poster,
      }};
    } else if (social && /repost|retweet|republic/i.test(social)) {
      post.relation = {kind: 'repost'};
    }
    const views = extractViews(node, embedded);
    const bookmarks = count(node, 'bookmark', embedded) ?? count(node, 'removeBookmark', embedded);
    post.metrics = {
      likes: count(node, 'like', embedded) ?? count(node, 'unlike', embedded),
      reposts: count(node, 'retweet', embedded) ?? count(node, 'unretweet', embedded),
      replies: count(node, 'reply', embedded),
      ...(views != null ? {views} : {}),
      ...(bookmarks != null ? {bookmarks} : {}),
    };
    return [post];
  });
  const readUserCells = root => !root ? [] : [...root.querySelectorAll('[data-testid="UserCell"]')].filter(visible).flatMap(node => {
    const handle = [...node.querySelectorAll('a[href]')].map(a => handleFor(a.href)).find(Boolean);
    if (!handle) return [];
    const isFollowing = Boolean(node.querySelector('[data-testid$="-unfollow"]'));
    return [{...author(node, handle), bio: value(node, '[data-testid="UserDescription"]'), isFollowing}];
  });
  const accounts = readUserCells(main);
  const sidebar = document.querySelector('[data-testid="sidebarColumn"]');
  const relevantPeople = readUserCells(sidebar);
  const readTrends = root => !root ? [] : [...root.querySelectorAll('[data-testid="trend"]')].filter(visible).flatMap(node => {
    const lines = (node.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return [];
    const topic = lines.find(l => l.startsWith('#')) || (lines.length >= 2 ? lines[1] : lines[0]);
    const category = lines[0] !== topic ? lines[0] : '';
    const postCount = lines.find(l => /\b(?:posts?|tweets?|publica)/i.test(l)) || '';
    return topic ? [{topic, category, postCount}] : [];
  });
  const seenTrends = new Set();
  const trends = [...readTrends(main), ...readTrends(sidebar)].filter(t => {
    const k = t.topic.toLowerCase();
    if (seenTrends.has(k)) return false;
    seenTrends.add(k);
    return true;
  });
  let profile = null;
  const userNameNode = main.querySelector('[data-testid="UserName"]');
  const pathHandle = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1];
  if (userNameNode || pathHandle) {
    const nameParts = userNameNode?.innerText?.split('\n').map(p => p.trim()).filter(Boolean) || [];
    const handlePart = nameParts.find(p => p.startsWith('@'))?.slice(1) || pathHandle || '';
    const displayName = nameParts.find(p => !p.startsWith('@')) || handlePart;
    const bannerImg = main.querySelector('a[href$="/header_photo" i] img, img[src*="profile_banners"]');
    const bannerUrl = cdn(bannerImg?.currentSrc || bannerImg?.src || bannerImg?.getAttribute('src'))
      || bgUrl(main, 'a[href$="/header_photo" i] [style*="background-image"], [style*="profile_banners"]');
    const avatarUrl = extractAvatar(main);
    const verified = Boolean(userNameNode?.querySelector('[data-testid="icon-verified"], svg[aria-label*="Verified"], svg[aria-label*="Verificado"]'));
    const followingText = value(main, 'a[href$="/following" i]');
    const followersText = value(main, 'a[href$="/verified_followers" i], a[href$="/followers" i]');
    const headerBlock = main.querySelector('h2[role="heading"]')?.parentElement?.innerText || '';
    const postsMatch = headerBlock.match(/(\d+(?:[.,]\d+)?\s*(?:[KMB]|mil|mi|bi)?)\s*(?:posts?|tweets?|publica)/i);
    const isFollowing = Boolean(main.querySelector('[data-testid$="-unfollow"]'));
    profile = {
      handle: handlePart,
      name: displayName,
      avatar: avatarUrl,
      banner: bannerUrl,
      verified,
      isFollowing,
      bio: value(main, '[data-testid="UserDescription"]'),
      location: value(main, '[data-testid="UserLocation"]'),
      website: value(main, '[data-testid="UserUrl"]'),
      joined: value(main, '[data-testid="UserJoinDate"]'),
      following: parseCompact(followingText),
      followers: parseCompact(followersText),
      ...(postsMatch ? {postsCount: parseCompact(postsMatch[1])} : {}),
    };
  }
  return {posts, accounts, profile, trends, relevantPeople};
};
