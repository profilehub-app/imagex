import React from 'react';
import { createRoot } from 'react-dom/client';
import { TimelinePreviewView } from '../src/components/views/TimelinePreviewView';
import { PersistentPlayerHost } from '../src/components/video-player/engine/PersistentPlayerHost';
import { isTimelineDataPayload, type TimelineCreator, type TimelinePost } from '../src/components/profile-hub/timeline/timelineModel';
import { useAppStore } from '../src/store/useAppStore';
import { useProfileTimelineStore } from '../src/store/useProfileTimelineStore';
import { useProfileHubLibraryStore } from '../src/store/useProfileHubLibraryStore';
import '../src/index.css';
import '../src/components/profile-hub/timeline/timeline-theme.css';
import '../src/components/video-player/ui/universal-player.css';

const en = new URLSearchParams(location.search).get('lang') === 'en-US';
const origin = location.origin;
const creator: TimelineCreator = {
  id: 'fixture-social', name: 'Ana Fixture', handle: 'anafixture', avatar: '',
  site: 'x', profileUrl: 'https://x.com/anafixture', verified: false, stats: {},
};
const instagram: TimelineCreator = {
  id: 'fixture-instagram', name: 'Instagram Fixture', handle: 'igfixture', avatar: '',
  site: 'instagram', profileUrl: 'https://www.instagram.com/igfixture/', verified: false, stats: {},
};
const legacy: TimelineCreator = {
  id: 'fixture-native', name: 'Native Fixture', handle: 'nativefixture', avatar: '',
  site: 'generic', profileUrl: origin + '/native-fixture', verified: false, stats: {},
};
const asset = (name: string) => `${origin}/test-fixtures/timeline-asset-${name}`;
const post = (owner: TimelineCreator, id: string, type: TimelinePost['type'], extra: Partial<TimelinePost> = {}): TimelinePost => ({
  id, type, source: owner.site, creatorId: owner.id, creatorName: owner.name,
  creatorHandle: owner.handle, creatorAvatar: owner.avatar, comments: [], likes: null,
  title: id, date: '2026-07-19', ...extra,
});
const video = post(legacy, 'fixture-video', 'video', {
  title: 'Local motion-free video', videoUrl: asset('video.mp4'), originalUrl: asset('video.mp4'),
  thumbnail: asset('video.svg'), date: '2026-07-16',
});
const photo = post(legacy, 'fixture-photo', 'photo_grid', {
  title: 'Native two images', photos: [asset('first.svg'), asset('second.svg')],
  originalUrl: asset('photos'), date: '2026-07-15',
});
const album = post(legacy, 'fixture-album', 'album', {
  title: 'Native album', photos: [asset('third.svg'), asset('fourth.svg')],
  date: '2026-07-14',
});
const gif = post(legacy, 'fixture-gif', 'gif', {
  title: 'Native GIF', thumbnail: asset('gif.svg'), videoUrl: asset('video.mp4'), date: '2026-07-13',
});
const playlist = post(legacy, 'fixture-playlist', 'playlist', {
  title: 'Native playlist', playlistUrl: asset('playlist'), playlistVideos: [video],
  thumbnail: asset('playlist.svg'), videoCount: 1, date: '2026-07-12',
});
const creators = [creator, instagram, legacy];
const sources = [
  post(creator, 'fixture-text', 'text', {
    title: '', date: '2026-07-19',
    text: 'Distinctive text-only fixture. No fake image.', metrics: {likes: null, reposts: null, quotes: 0},
  }),
  post(creator, 'fixture-quote', 'text', {
    title: '', date: '2026-07-18',
    text: 'Words from the quoting author.', relation: {kind: 'quote', post: {
      text: 'Words from the quoted writer.', creatorName: 'Quoted Fixture', creatorHandle: 'quotedfixture',
    }},
  }),
  post(creator, 'fixture-repost', 'text', {
    title: '', date: '2026-07-17',
    relation: {kind: 'repost', post: {text: 'Words shared by the repost.', creatorName: 'Original Fixture'}},
  }),
  post(creator, 'fixture-carousel', 'photo_grid', {
    title: '', date: '2026-07-17', text: 'Ordered photos fixture.',
    photos: [asset('first.svg'), asset('second.svg'), asset('third.svg')],
  }),
];
const igPhotos = post(instagram, 'fixture-ig-carousel', 'photo_grid', {
  date: '2026-07-17', text: 'Instagram ordered photos fixture.',
  photos: [asset('first.svg'), asset('second.svg'), asset('third.svg')],
});
const igVideo = post(instagram, 'fixture-ig-video', 'video', {
  title: 'Local Instagram video fixture', date: '2026-07-11', text: 'Instagram text before the player.',
  videoUrl: asset('video.mp4'), originalUrl: asset('video.mp4'),
  thumbnail: asset('video.svg'),
});
const posts = [...sources, igPhotos, video, photo, album, gif, playlist, igVideo];
const empty = async () => {};
useAppStore.setState(state => ({
  currentView: 'timeline-preview',
  settings: {...state.settings, language: en ? 'en-US' : 'pt-BR', disableAllAnimations: true },
  syncVideos: empty,
}));
useProfileHubLibraryStore.setState({ hydrateLibrary: empty });
useProfileTimelineStore.setState({
  creators, creatorProfiles: Object.fromEntries(creators.map(c => [c.id, c])), posts,
  isLoading: false, error: null, refreshTimeline: empty, refreshMissingCreators: empty,
  discoverCreatorCatalog: empty, isGlobalMuted: true,
});
document.documentElement.lang = en ? 'en-US' : 'pt-BR';
document.documentElement.dataset.validFixture = String(isTimelineDataPayload({creators, posts}));
document.documentElement.dataset.rejectsMalformedRelation = String(!isTimelineDataPayload({
  creators, posts: [{...sources[1], relation: {kind: 'unrecognized', post: {text: 123}}}],
}));
document.documentElement.dataset.rejectsUnknownType = String(!isTimelineDataPayload({
  creators, posts: [{...video, type: 'unrecognized'}],
}));
createRoot(document.getElementById('root')!).render(
  <>
    <main className="timeline-scroll-surface overflow-y-auto overflow-x-clip" style={{ height: '100dvh' }}>
      <TimelinePreviewView />
    </main>
    <PersistentPlayerHost />
  </>,
);
