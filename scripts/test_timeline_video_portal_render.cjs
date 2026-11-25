const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const front = path.resolve(__dirname, '../frontend-mobile-preview');
const esbuild = require(path.join(front, 'node_modules/esbuild'));

const bundle = esbuild.buildSync({
  stdin: {
    resolveDir: front,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { registerDynamicSources } from './src/components/profile-hub/timeline/timelineSourceCapabilities';
      import { renderBrandPlatformIcon } from './src/components/profile-hub/timeline/TimelineBrandIcons';
      import { TimelinePostCard } from './src/components/profile-hub/timeline/TimelinePostCard';
      import { AdaptiveProfileHeader } from './src/components/profile-hub/timeline/AdaptiveProfileHeader';
      import { AdaptiveProfileContent } from './src/components/profile-hub/timeline/AdaptiveProfileContent';
      import { VideoPortalProfileView } from './src/components/profile-hub/timeline/VideoPortalProfileView';
      import { VisualDirectoryExplorer } from './src/components/profile-hub/timeline/AdaptiveSourceCards';
      import { TimelineSearchResults } from './src/components/profile-hub/timeline/TimelineSearchResults';

      registerDynamicSources([
        {
          id: 'vid_portal',
          displayName: 'Video Portal',
          iconKind: 'video_portal',
          accentColor: '#e11d48',
          origins: ['https://portal.example'],
          urlHints: {
            videoPathRegex: '^/video\\\\.[a-z0-9]+',
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
            directoryKinds: ['categories', 'channels', 'artists', 'tags'],
          },
        },
      ]);

      const noop = () => {};
      const creator = {
        id: 'https://portal.example/channels/alpine-films',
        name: 'Alpine Films',
        handle: '@alpine',
        avatar: 'https://cdn.portal.example/a.jpg',
        profileUrl: 'https://portal.example/channels/alpine-films',
        site: 'vid_portal',
        entityKind: 'channel',
        verified: true,
        profileHasMore: true,
        stats: { videos: 42, subscribers: 88000, shorts: 3, playlists: 2 },
        relatedEntities: [{ name: 'Sister Studio', url: 'https://portal.example/channels/sister-studio', kind: 'channel' }],
      };

      const post = {
        id: 'vp-post-1',
        creatorId: creator.id,
        creatorName: creator.name,
        creatorHandle: creator.handle,
        creatorAvatar: creator.avatar,
        type: 'video',
        source: 'vid_portal',
        originalUrl: 'https://portal.example/video.ab12cd/mountain_dawn',
        previewVideoUrl: 'https://cdn.portal.example/p/1.mp4',
        thumbnail: 'https://cdn.portal.example/t/1.jpg',
        title: 'Mountain Dawn 4K',
        duration: '12:00',
        resolution: '1440p',
        views: '548k',
        tags: ['HDR Scenic'],
        tagEntities: [{ name: 'HDR Scenic', url: 'https://portal.example/tags/hdr-scenic', kind: 'tag' }],
        categories: [{ name: 'Cinema HD', url: 'https://portal.example/c/cinema-hd', kind: 'category' }],
        comments: [],
        likes: 120,
        date: '2026-06-01',
      };

      export function renderIcon() {
        return renderToStaticMarkup(<div>{renderBrandPlatformIcon('vid_portal', 16)}</div>);
      }
      export function renderPostCard() {
        return renderToStaticMarkup(
          <TimelinePostCard
            post={post}
            onOpenProfile={noop}
            onOpenEntity={noop}
            onOpenComments={noop}
            onOpenLightbox={noop}
            suspended
          />
        );
      }
      export function renderProfile() {
        const shortPost = { ...post, id: 'vp-short-1', isShort: true, title: 'Quick Clip' };
        return renderToStaticMarkup(
          <div>
            <AdaptiveProfileHeader creator={creator} onBack={noop} />
            <AdaptiveProfileContent
              creator={creator}
              posts={[post, shortPost]}
              activeTab="videos"
              onOpenProfile={noop}
              onOpenComments={noop}
              onOpenLightbox={noop}
              onOpenEntity={noop}
              onLoadMoreProfile={noop}
              suspended
            />
          </div>
        );
      }
      export function renderDedicatedPortalProfile() {
        const shortPost = { ...post, id: 'vp-short-1', isShort: true, title: 'Quick Clip' };
        const richCreator = {
          ...creator,
          banner: 'https://cdn.portal.example/banner.jpg',
          stats: { videos: 5011, subscribers: '791523', views: '4214329803', rating: '100.0%', shorts: 120 },
          supportsSort: ['best', 'new'],
          activeSort: 'best',
          portalInfo: {
            country: 'US',
            languages: 'English',
            website: 'https://alpine.example/',
            joinedAt: '2014-01-31',
            profileHits: '101,407,817',
          },
          featuredPerformers: Array.from({ length: 12 }, (_, idx) => ({
            name: 'Performer ' + (idx + 1),
            url: 'https://portal.example/models/perf-' + (idx + 1),
            kind: 'creator',
            count: 20 + idx,
          })),
          affiliatedChannels: [
            { name: 'Sister Studio', url: 'https://portal.example/channels/sister-studio', kind: 'channel' },
          ],
          interests: [{ name: 'Cinema 4K', url: 'https://portal.example/tags/cinema-4k', kind: 'tag' }],
        };
        return renderToStaticMarkup(
          <div>
            <VideoPortalProfileView
              creator={richCreator}
              posts={[post, shortPost]}
              isEn={true}
              onBack={noop}
              onOpenVideo={noop}
              onOpenEntity={noop}
              onOpenLightbox={noop}
              onLoadMore={noop}
              onChangeSort={noop}
            />
          </div>
        );
      }
      export function renderDirectory() {
        return renderToStaticMarkup(
          <VisualDirectoryExplorer
            kind="artists"
            items={[
              {
                id: 'elena',
                name: 'Elena Nova',
                url: 'https://portal.example/models/elena-nova',
                kind: 'creator',
                thumbnailUrl: 'https://cdn.portal.example/p1.jpg',
                verified: true,
                rank: 4,
                subscribersText: '85 videos',
              },
            ]}
            isEn={false}
            hasMore={true}
            onLoadMore={noop}
            onSelectItem={noop}
          />
        );
      }
      export function renderSearch() {
        return renderToStaticMarkup(
          <TimelineSearchResults
            query="alpine"
            activeSource="vid_portal"
            activeCategory="all"
            xPostsMode="top"
            availableSources={[{ id: 'vid_portal', name: 'Video Portal', categories: ['profiles', 'videos', 'playlists'], supportsLiveConnector: true, iconKind: 'video_portal' }]}
            snapshot={{
              query: 'alpine',
              sections: { profiles: [creator], playlists: [], videos: [post], shorts: [], albums: [], gifs: [], posts: [] },
              profiles: [creator],
              playlists: [],
              videos: [post],
              shorts: [],
              albums: [],
              gifs: [],
              posts: [post],
              cursors: {},
              sourceStatus: {},
              hasMore: false,
              fetchedSources: ['vid_portal'],
              loadingSources: [],
            }}
            localMatches={{ creators: [], posts: [], playlists: [] }}
            knownCreatorIds={new Set()}
            isEn={false}
            isLoadingInitial={false}
            isLoadingMore={false}
            onSelectSource={noop}
            onSelectCategory={noop}
            onChangeXPostsMode={noop}
            onLoadMore={noop}
            onOpenProfile={noop}
            onOpenXProfile={noop}
            onOpenXPostDetail={noop}
            onOpenVideo={noop}
            onOpenLightbox={noop}
            onOpenComments={noop}
            onOpenPlaylist={noop}
          />
        );
      }
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

const runner = new Module('video-portal-render-fixture');
runner._compile(bundle.outputFiles[0].text, path.join(front, 'video-portal-render-fixture.cjs'));
const { renderIcon, renderPostCard, renderProfile, renderDedicatedPortalProfile, renderDirectory, renderSearch } = runner.exports;

test('renders dedicated video_portal SVG icon without hardcoding brand', () => {
  const html = renderIcon();
  assert.ok(html.includes('data-icon-kind="video_portal"'), 'VideoPortalBrandIcon should render data-icon-kind="video_portal"');
});

test('TimelinePostCard renders clickable category chips and video_portal archetype', () => {
  const html = renderPostCard();
  assert.ok(html.includes('data-archetype="video_portal"'), 'Post card should expose data-archetype="video_portal"');
  assert.ok(html.includes('data-category-chip'), 'Post card should render clickable category chips');
  assert.ok(html.includes('Cinema HD'), 'Category name should render on card');
  assert.ok(html.includes('HDR Scenic'), 'Tag name should render on card');
});

test('AdaptiveProfileHeader & Content render entityKind, related entities, shorts tab, and load more', () => {
  const html = renderProfile();
  assert.ok(html.includes('Sister Studio'), 'Related channel link should render');
  assert.ok(html.includes('Shorts'), 'Shorts tab should render when shorts items exist for video_portal');
  assert.ok(html.includes('data-load-more-profile-albums'), 'Load more button should render when profileHasMore is true');
});

test('VisualDirectoryExplorer renders rank badge, verified badge, thumbnailUrl fallback, and load-more button', () => {
  const html = renderDirectory();
  assert.ok(html.includes('https://cdn.portal.example/p1.jpg'), 'Directory card should render thumbnailUrl fallback');
  assert.ok(html.includes('#4'), 'Directory card should render rank badge');
  assert.ok(html.includes('85 videos'), 'Directory card should render subscribers/count text');
  assert.ok(html.includes('data-directory-load-more'), 'Directory explorer should render remote load-more button');
});

test('TimelineSearchResults renders entityKind pill on profile cards', () => {
  const html = renderSearch();
  assert.ok(html.includes('data-entity-kind="channel"'), 'Search profile card should render data-entity-kind pill');
});

test('timeline-theme.css defines video_portal and tl-video-wall-grid rules & WatchView supports clickable categories/tags', () => {
  const css = fs.readFileSync(path.join(front, 'src/components/profile-hub/timeline/timeline-theme.css'), 'utf8');
  assert.ok(css.includes('[data-archetype="video_portal"]'), 'CSS should style video_portal archetype');
  assert.ok(css.includes('.tl-video-wall-grid'), 'CSS should define .tl-video-wall-grid');

  const watchSrc = fs.readFileSync(path.join(front, 'src/components/profile-hub/timeline/TimelineWatchView.tsx'), 'utf8');
  assert.ok(watchSrc.includes('data-watch-category') && watchSrc.includes('data-watch-tag'), 'WatchView should render clickable category and tag chips');
  assert.ok(watchSrc.includes('data-watch-stats-bar') && watchSrc.includes('data-watch-tags-toggle'), 'WatchView should render stats bar and collapsible tags toggle');
  assert.ok(css.includes('.tl-vp-hero') && css.includes('.tl-watch-stats-bar'), 'CSS should style VideoPortalProfileView and Watch stats bar');

  const portalHtml = renderDedicatedPortalProfile();
  assert.ok(portalHtml.includes('data-video-portal-profile="vid_portal"'), 'Dedicated portal profile root should render');
  assert.ok(portalHtml.includes('https://cdn.portal.example/banner.jpg'), 'Portal hero banner should render');
  assert.ok(portalHtml.includes('791.5K') && portalHtml.includes('4.2B') && portalHtml.includes('100.0%'), 'Formatted KPI metrics should render');
  assert.ok(portalHtml.includes('data-vp-sort="best"') && portalHtml.includes('data-vp-sort="new"'), 'Sort toggle pills should render');
  assert.ok(portalHtml.includes('+4 more'), 'Hero cast strip should cap pills and show overflow button');
  assert.ok(portalHtml.includes('data-load-more-profile-albums="true"'), 'Portal videos load-more CTA should render');
});
