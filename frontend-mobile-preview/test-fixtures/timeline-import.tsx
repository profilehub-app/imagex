import React from 'react';
import { createRoot } from 'react-dom/client';
import { TimelineLocalImport } from '../src/components/profile-hub/timeline/TimelineLocalImport';
import { ProfileTimelineView } from '../src/components/profile-hub/timeline/ProfileTimelineView';
import { useProfileTimelineStore } from '../src/store/useProfileTimelineStore';
import { useProfileHubLibraryStore } from '../src/store/useProfileHubLibraryStore';
import { parseTimelineExport } from '../src/services/timelineImport';
import { useAppStore } from '../src/store/useAppStore';
import '../src/index.css';
import '../src/components/profile-hub/timeline/timeline-theme.css';

useAppStore.setState(state => ({settings: {...state.settings, language: 'pt-BR'}}));
const native = parseTimelineExport(JSON.stringify({
  creators: [{id:'fixture', name:'Fixture Native Creator', profileUrl:'https://x.com/nativefixture'}],
  posts: [{creatorId:'fixture', originalUrl:'https://x.com/fixture/status/101', caption:'Native authoritative post', date:'2026-11-22'}],
}));
useProfileHubLibraryStore.setState({hydrateLibrary: async () => {}});
useAppStore.setState({syncVideos: async () => {}});
useProfileTimelineStore.setState({
  creators: [...native.creators], posts: native.posts.map(({importProvenance: _omit, ...post}) => ({...post, id:'native-101'})),
  refreshTimeline: async () => {}, refreshMissingCreators: async () => {},
});
createRoot(document.getElementById('root')!).render(<main className="tl-themed h-screen overflow-y-auto bg-[var(--tl-bg)] p-4 text-[var(--tl-text-primary)]">
  <TimelineLocalImport />
  <ProfileTimelineView />
</main>);
