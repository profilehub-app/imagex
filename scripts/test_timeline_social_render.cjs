// Run: node --test scripts/test_timeline_social_render.cjs
// Real component rendering with synthetic data; no browser or network required.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');

const front = path.resolve(__dirname, '../frontend-mobile-preview');
const esbuild = require(path.join(front, 'node_modules/esbuild'));
const bundle = esbuild.buildSync({
  stdin: { resolveDir: front, loader: 'tsx', contents: `
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {TimelinePostCard} from './src/components/profile-hub/timeline/TimelinePostCard';
    import {isTimelineDataPayload} from './src/components/profile-hub/timeline/timelineModel';
    import {AdaptiveProfileContent} from './src/components/profile-hub/timeline/AdaptiveProfileContent';
    const noop = () => {};
    const main = {
      id:'test-creator', name:'Offline Creator', avatar:'', handle:'offline',
      profileUrl:'https://x.com/offline', site:'x', verified:false, stats:{},
    };
    const base = {
      id:'test-post', creatorId:main.id, creatorName:main.name, creatorHandle:main.handle,
      creatorAvatar:main.avatar, title:'Fixture native title', date:'2026-01-01',
      likes:null, comments:[],
    };
    export function render(type, props={}, cardProps={}) {
      return renderToStaticMarkup(<TimelinePostCard post={{...base, type, ...props}}
        onOpenProfile={noop} onOpenComments={noop} onOpenLightbox={noop} suspended {...cardProps} />);
    }
    export function renderWithoutProfile(type, props={}) {
      return renderToStaticMarkup(<TimelinePostCard post={{...base, type, ...props}}
        onOpenComments={noop} onOpenLightbox={noop} suspended />);
    }
    export function renderWithPlaylist(props={}) {
      return renderToStaticMarkup(<TimelinePostCard post={{...base, type:'playlist', originalUrl:'https://www.youtube.com/playlist?list=PL1', ...props}}
        onOpenProfile={noop} onOpenComments={noop} onOpenLightbox={noop} onOpenPlaylist={noop} suspended />);
    }
    export function profile(site, type, props={}) {
      return renderToStaticMarkup(<AdaptiveProfileContent creator={{...main, site,
        profileUrl: site === 'x' ? main.profileUrl : 'https://local.test/offline'}}
        posts={[{...base, type, ...props}]} onOpenProfile={noop} onOpenComments={noop}
        onOpenLightbox={noop} suspended />);
    }
    export function valid(type, props={}) {
      return isTimelineDataPayload({creators:[main],posts:[{...base, type, ...props}]});
    }
  ` },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  loader: {'.css': 'empty'},
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  logLevel: 'silent',
});
const runner = new Module('timeline-render-fixture');
runner._compile(bundle.outputFiles[0].text, path.join(front, 'timeline-render-fixture.cjs'));
const {render, renderWithoutProfile, renderWithPlaylist, profile, valid} = runner.exports;

test('text only: real card shows text and neither video nor media preview', () => {
  assert.ok(valid('text', {text:'Text fixture'}));
  const html = render('text', {source:'x', text:'Text fixture'});
  assert.match(html, /data-social-body/);
  assert.match(html, /Text fixture/);
  assert.doesNotMatch(html, /data-video-container|data-social-carousel|<(video|iframe)\b/);
});

test('social relationship authors and unknown/read values stay distinct', () => {
  const html = render('text', {source:'x', text:'New words', relation:{kind:'quote',post:{
    text:'Old words', creatorName:'Referenced Author',
  }}, metrics:{reposts:null,quotes:0}});
  assert.match(html, /data-social-relation="quote"/);
  for (const value of ['New words','Old words','Referenced Author','—','>0<']) assert.ok(html.includes(value), value);
  assert.equal(valid('text', {relation:{kind:'invalid',post:{text:12}}}), false);
  assert.equal(valid('invalid'), false);
});

test('Instagram photos choose ordered carousel while five legacy kinds stay native', () => {
  const pics = ['/first.svg','/second.svg','/third.svg'];
  const social = render('photo_grid', {source:'instagram', text:'Photo post', photos:pics});
  assert.match(social, /data-social-carousel/);
  assert.match(social, /src="\/first.svg"/);
  assert.doesNotMatch(social, /src="\/second.svg"|data-video-container/);
  for (const type of ['video','photo_grid','album','gif','playlist']) {
    assert.ok(valid(type));
    const html = render(type, {source:'generic', photos:pics, videoUrl:'/fixture.mp4'});
    assert.match(html, new RegExp(`data-media-type="${type}"`));
    assert.doesNotMatch(html, /data-social-(body|carousel)/);
    if (type === 'video') assert.match(html, /data-video-container/);
  }
});

test('X creator uses shared renderer and hides empty video tab without changing native behavior', () => {
  const social = profile('x', 'text', {source:'x', text:'Profile fixture'});
  assert.match(social, /data-social-body/);
  assert.match(social, /Profile fixture/);
  assert.doesNotMatch(social, /data-profile-tab="videos"/);
  assert.match(profile('generic', 'album', {source:'generic'}), /data-profile-tab="videos"/);
});

test('Instagram and YouTube profiles expose sections based on source formats', () => {
  const reel = profile('instagram', 'video', {source: 'instagram', originalUrl: 'https://www.instagram.com/reel/demo/'});
  assert.match(reel, /data-profile-tab="reels"/);
  assert.doesNotMatch(reel, /data-profile-tab="videos"/);
  const shorts = profile('youtube', 'video', {source: 'youtube', originalUrl: 'https://www.youtube.com/shorts/demo'});
  assert.match(shorts, /data-profile-tab="shorts"/);
  assert.doesNotMatch(shorts, /data-profile-tab="reels"/);
  const community = profile('youtube', 'text', {source: 'youtube', originalUrl: 'https://www.youtube.com/post/demo'});
  assert.match(community, /data-profile-tab="community"/);
});


test('playlist card with onOpenPlaylist renders in-app trigger button instead of external card overlay', () => {
  const withInApp = renderWithPlaylist({ source: 'youtube', title: 'Luna Mix' });
  assert.match(withInApp, /data-playlist-open-inapp="true"/);
  assert.doesNotMatch(withInApp, /<a[^>]+class="absolute inset-0 z-10"/);

  const legacy = render('playlist', { source: 'generic', originalUrl: 'https://local.test/pl/1', title: 'Legacy Playlist' });
  assert.match(legacy, /data-media-type="playlist"/);
  assert.match(legacy, /target="_blank"/);
});

test('neutral attribution post without resolvable profile omits creator button and option menu action', () => {
  const html = renderWithoutProfile('album', {
    source: 'imgur',
    creatorId: 'imgur:imgur',
    creatorName: 'Imgur',
    creatorHandle: '@imgur',
    originalUrl: 'https://imgur.com/a/abc123',
  });
  assert.doesNotMatch(html, /data-post-creator-id/);
  assert.match(html, /tl-post-author/);
});
