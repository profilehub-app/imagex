"""Read the X interface in a local browser and page through its rendered content."""

import asyncio
import ipaddress
import os
import re
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from urllib.parse import quote_plus, urlsplit
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response
from playwright.async_api import Error, Page, TimeoutError, async_playwright
from pydantic import BaseModel, Field


X_HOME = "https://x.com/home"
X_EXPLORE = "https://x.com/explore"
X_PROFILE_LINK = '[data-testid="AppTabBar_Profile_Link"]'
X_READY = f'{X_PROFILE_LINK}, input[autocomplete="username"], a[href="/login"]'
HANDLE = re.compile(r"[A-Za-z0-9_]{1,15}", re.ASCII)
POST_ID = re.compile(r"\d{5,22}", re.ASCII)
Scope = Literal["recommended", "following", "explore", "accounts", "profile", "post", "search"]
SearchTab = Literal["top", "people", "videos", "latest", "photos"]

READ_TIMELINE = r"""() => {
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
}"""


class TimelineRequest(BaseModel):
    cursor: UUID
    scope: Scope
    handle: str = Field(default="", max_length=16)
    postId: str = Field(default="", max_length=22)
    searchQuery: str = Field(default="", max_length=200)
    searchTab: SearchTab = "top"
    backgroundOnly: bool = False
    advance: bool = False


@dataclass
class Feed:
    page: Page
    scope: Scope
    handle: str
    post_id: str = ""
    search_query: str = ""
    search_tab: SearchTab = "top"
    background_only: bool = False
    ready: bool = False
    seen: set[str] = field(default_factory=set)
    # Keep the last batch for idempotent retries of a request that reached the browser.
    offset: int = 0
    batch: dict | None = None


def _search_url(query: str, tab: SearchTab) -> str:
    base = f"https://x.com/search?q={quote_plus(query.strip())}&src=typed_query"
    suffix = {
        "top": "",
        "people": "&f=user",
        "videos": "&f=video",
        "latest": "&f=live",
        "photos": "&f=image",
    }.get(tab, "")
    return base + suffix


class SocialTimeline:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.driver = None
        self.context = None
        self.feeds: OrderedDict[UUID, Feed] = OrderedDict()

    async def close(self):
        async with self.lock:
            try:
                if self.context:
                    await self.context.close()
            finally:
                self.disconnected()
                if self.driver:
                    await self.driver.stop()
                    self.driver = None

    async def browser_context(self):
        if self.context:
            return self.context
        if self.driver:
            await self.driver.stop()
        self.driver = await async_playwright().start()
        try:
            settings = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share")
            self.context = await self.driver.chromium.launch_persistent_context(
                settings / "IMAGEX" / "social-browser", headless=False,
            )
            self.context.on("close", lambda _: self.disconnected())
        except Error:
            await self.driver.stop()
            self.driver = None
            raise
        return self.context

    def disconnected(self):
        self.context = None
        self.feeds.clear()

    async def open_feed(self, feed: Feed):
        page = feed.page
        if feed.scope == "post":
            await page.goto(
                f"https://x.com/{feed.handle}/status/{feed.post_id}",
                wait_until="domcontentloaded",
                timeout=15000,
            )
        elif feed.scope == "profile":
            await page.goto(f"https://x.com/{feed.handle}", wait_until="domcontentloaded", timeout=15000)
        elif feed.scope == "explore":
            await page.goto(X_EXPLORE, wait_until="domcontentloaded", timeout=15000)
        elif feed.scope == "search":
            await page.goto(_search_url(feed.search_query, feed.search_tab), wait_until="domcontentloaded", timeout=15000)
        else:
            await page.goto(X_HOME, wait_until="domcontentloaded", timeout=15000)
        await page.locator(X_READY).first.wait_for(state="visible", timeout=10000)
        profile = page.locator(X_PROFILE_LINK)
        if not await profile.count():
            return False
        if feed.scope == "accounts":
            own_href = await profile.get_attribute("href")
            own_handle = (own_href or "").strip("/")
            if not HANDLE.fullmatch(own_handle):
                raise HTTPException(502, "account_unavailable")
            await page.goto(f"https://x.com/{own_handle}/following", wait_until="domcontentloaded", timeout=15000)
        elif feed.scope in ("recommended", "following"):
            names = r"^(For you|Para você|Para ti)$" if feed.scope == "recommended" else r"^(Following|Seguindo|Siguiendo)$"
            tab = page.get_by_role("tab", name=re.compile(names, re.IGNORECASE))
            await tab.wait_for(state="visible", timeout=10000)
            if await tab.get_attribute("aria-selected") != "true":
                await tab.click(timeout=5000)
                await tab.and_(page.locator('[aria-selected="true"]')).wait_for(timeout=5000)
        feed.ready = True
        return True

    async def read_batch(self, feed: Feed, advance: bool):
        page = feed.page
        is_search_people = feed.scope == "search" and feed.search_tab == "people"
        items_key = "accounts" if (feed.scope == "accounts" or is_search_people) else "posts"
        selector = (
            '[data-testid="UserCell"]'
            if items_key == "accounts"
            else (
                '[data-testid="trend"], article[data-testid="tweet"]'
                if feed.scope == "explore"
                else (
                    'article[data-testid="tweet"], [data-testid="UserCell"]'
                    if (feed.scope == "search" and feed.search_tab == "top")
                    else 'article[data-testid="tweet"]'
                )
            )
        )
        try:
            await page.locator(f'main {selector}').first.wait_for(timeout=8500 if feed.scope == "explore" else 6500)
        except TimeoutError:
            pass
        if feed.scope == "profile" and not advance:
            try:
                await page.locator('a[href$="/following" i], a[href$="/followers" i], a[href$="/verified_followers" i]').first.wait_for(timeout=2500)
            except TimeoutError:
                pass
        collected = []
        found = set()
        last_profile = None
        trend_map: dict[str, dict] = {}
        relevant_map: dict[str, dict] = {}

        async def harvest():
            nonlocal last_profile
            source = urlsplit(page.url)
            if source.scheme != "https" or source.hostname != "x.com":
                raise HTTPException(502, "source_unavailable")
            if source.path.startswith(("/i/flow/login", "/login")):
                feed.ready = False
                return "login_required", 0
            snapshot = await page.evaluate(READ_TIMELINE)
            if snapshot.get("profile"):
                prof = snapshot["profile"]
                if last_profile:
                    last_profile = {
                        **last_profile,
                        **{k: v for k, v in prof.items() if v not in (None, "")},
                    }
                else:
                    last_profile = prof
            for tr in snapshot.get("trends") or []:
                topic = (tr or {}).get("topic")
                if topic and topic.lower() not in trend_map:
                    trend_map[topic.lower()] = tr
            for rp in snapshot.get("relevantPeople") or []:
                h = ((rp or {}).get("handle") or "").lower()
                if h and h not in relevant_map:
                    relevant_map[h] = rp
            if feed.scope == "search" and feed.search_tab == "top":
                for rp in snapshot.get("accounts") or []:
                    h = ((rp or {}).get("handle") or "").lower()
                    if h and h not in relevant_map:
                        relevant_map[h] = rp
            added = 0
            for raw_item in snapshot[items_key]:
                item = (
                    {**raw_item, "isFollowing": raw_item.get("isFollowing", True)}
                    if feed.scope in ("following", "accounts")
                    else raw_item
                )
                identity = item["handle"].lower() if items_key == "accounts" else item["id"]
                if identity not in feed.seen and identity not in found:
                    found.add(identity)
                    collected.append(item)
                    added += 1
            return "ok", added

        # Always capture the initial viewport first (so focal tweet / top trends are never dropped).
        status, _ = await harvest()
        if status == "login_required":
            return {"status": "login_required", "items": []}

        if feed.scope == "post" and not advance:
            for step in range(4):
                delta = 760 if step == 0 else 900
                await page.evaluate(f"window.scrollBy(0, {delta})")
                await page.mouse.wheel(0, delta)
                deadline = asyncio.get_running_loop().time() + (4.8 if step == 0 else 1.5)
                while asyncio.get_running_loop().time() < deadline:
                    status, added = await harvest()
                    if status == "login_required":
                        return {"status": "login_required", "items": []}
                    if added > 0 and len(collected) > 1:
                        break
                    await asyncio.sleep(0.2)
                if len(collected) >= 10:
                    break
        elif feed.scope == "explore" and not advance:
            for _ in range(3):
                await page.evaluate("window.scrollBy(0, 950)")
                await page.mouse.wheel(0, 950)
                await asyncio.sleep(1.0)
                status, _ = await harvest()
                if status == "login_required":
                    return {"status": "login_required", "items": []}
                if len(collected) >= 6 and len(trend_map) >= 3:
                    break
        elif advance:
            for step in range(1, 7):
                await page.evaluate("window.scrollBy(0, Math.max(window.innerHeight || 900, 950))")
                await page.mouse.wheel(0, 1050)
                deadline = asyncio.get_running_loop().time() + 1.6
                while asyncio.get_running_loop().time() < deadline:
                    status, added = await harvest()
                    if status == "login_required":
                        return {"status": "login_required", "items": []}
                    if added > 0:
                        break
                    await asyncio.sleep(0.2)
                if len(collected) >= 3 or (step >= 2 and collected):
                    break

        feed.seen.update(found)
        out = {"status": "ready", "items": collected}
        if feed.scope == "profile" and last_profile:
            out["profile"] = last_profile
        if trend_map:
            out["trends"] = list(trend_map.values())
        if relevant_map:
            out["relevantPeople"] = list(relevant_map.values())
        return out

    async def batch(self, query: TimelineRequest, offset: int):
        async with self.lock:
            context = await self.browser_context()
            feed = self.feeds.get(query.cursor)
            if feed and feed.page.is_closed():
                self.feeds.pop(query.cursor)
                feed = None
            if feed and (
                feed.scope != query.scope
                or feed.handle != query.handle
                or feed.post_id != query.postId
                or feed.search_query != query.searchQuery
                or feed.search_tab != query.searchTab
            ):
                raise HTTPException(409, "cursor_mismatch")
            if feed and feed.batch is not None and offset == feed.offset:
                return feed.batch
            if not feed:
                if offset:
                    raise HTTPException(409, "cursor_expired")
                while len(self.feeds) >= 10:
                    search_key = next((k for k, existing in self.feeds.items() if existing.scope == "search"), None)
                    evict_key = search_key if search_key is not None else next(iter(self.feeds))
                    previous = self.feeds.pop(evict_key)
                    await previous.page.close()
                page = await context.new_page()
                feed = Feed(
                    page,
                    query.scope,
                    query.handle,
                    query.postId,
                    search_query=query.searchQuery,
                    search_tab=query.searchTab,
                    background_only=bool(query.backgroundOnly or query.scope == "search"),
                )
                self.feeds[query.cursor] = feed
            if feed.batch is not None and offset != feed.offset + 1:
                raise HTTPException(409, "cursor_mismatch")
            self.feeds.move_to_end(query.cursor)
            if not feed.ready:
                if not await self.open_feed(feed):
                    if feed.background_only or query.backgroundOnly:
                        self.feeds.pop(query.cursor, None)
                        await feed.page.close()
                    else:
                        await feed.page.bring_to_front()
                    return {"status": "login_required", "items": []}
            batch = await self.read_batch(feed, query.advance)
            if batch["status"] == "ready":
                feed.offset, feed.batch = offset, batch
            elif batch.get("status") == "login_required" and (feed.background_only or query.backgroundOnly):
                self.feeds.pop(query.cursor, None)
                await feed.page.close()
            return batch


def social_timeline_router(service: SocialTimeline) -> APIRouter:
    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            await service.close()

    router = APIRouter(prefix="/api/social-timeline/x", lifespan=lifespan)

    @router.get("/status")
    async def status():
        return {"connected": bool(service.context is not None)}

    @router.post("/batch/{offset}")
    async def batch(query: TimelineRequest, offset: int, request: Request, response: Response):
        # The browser session is private. LAN access relies on the application's Basic Auth.
        peer = request.client.host if request.client else ""
        try:
            address = ipaddress.ip_address(peer)
            is_local = (getattr(address, "ipv4_mapped", None) or address).is_loopback
        except ValueError:
            is_local = False
        host = request.headers.get("host", "")
        if is_local and urlsplit(f"//{host}").hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise HTTPException(403, "private_session")
        if not is_local and not os.getenv("AUTH_PASSWORD"):
            raise HTTPException(403, "private_session")
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != host:
            raise HTTPException(403, "private_session")
        if offset < 0 or query.advance != (offset > 0):
            raise HTTPException(422, "invalid_offset")
        if query.handle:
            query.handle = query.handle.strip().lstrip("@")
        if query.scope == "profile" and not HANDLE.fullmatch(query.handle):
            raise HTTPException(422, "invalid_profile")
        if query.scope == "post" and (not HANDLE.fullmatch(query.handle) or not POST_ID.fullmatch(query.postId)):
            raise HTTPException(422, "invalid_post")
        if query.scope == "search":
            query.searchQuery = query.searchQuery.strip()
            if not query.searchQuery:
                raise HTTPException(422, "invalid_search")
        response.headers["Cache-Control"] = "no-store"
        try:
            return await service.batch(query, offset)
        except TimeoutError as exc:
            raise HTTPException(504, "source_timeout") from exc
        except Error as exc:
            raise HTTPException(502, "browser_unavailable") from exc

    return router
