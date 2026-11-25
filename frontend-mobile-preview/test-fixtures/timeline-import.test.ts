import { strict as assert } from 'node:assert';
import { isTimelineDataPayload, type TimelineDataPayload } from '../src/components/profile-hub/timeline/timelineModel';
import { mergeTimelineExportPages, parseTimelineExport, TimelineExportError } from '../src/services/timelineImport';
const empty: TimelineDataPayload = {creators: [], posts: []};
const labCreator = { id: 'x-source-json', name: 'Fixture writer', handle: '@fixture', avatar: 'https://assets.example/avatar.jpg',
  site: 'x', profileUrl: 'https://x.com/fixture', verified: false, stats: {}, bio: 'not in the offline projection' };
const labPost = (link: string, caption: string, when = '2026-11-22T17:00:00Z') => ({
  id: 'id-present-only-in-lab', creatorId: labCreator.id, type: 'photo_grid', source: 'x', experimentalTextOnly: true,
  originalUrl: link, albumUrl: null, videoUrl: null, publicationDateRaw: null, caption, thumbnail: '',
  photos: ['https://assets.example/original.jpg?token=not-returned'],
  comments: [{text: 'not imported', avatar: 'https://assets.example/avatar.jpg'}],
  date: '2026-11-22', dateObservedAt: when, engagementMetrics: { likes: 0, reposts: null },
});
const j = (posts: object[], creators: object[] = [labCreator]) => JSON.stringify({creators, posts});
const first = parseTimelineExport(j([
  labPost('https://x.com/fixture/status/301', 'First'),
  labPost('https://x.com/fixture/status/302', 'Second'),
]));
assert.ok(isTimelineDataPayload(first));
assert.equal(first.posts[0].type, 'text');
assert.equal(first.posts[0].likes, 0);
assert.equal(first.posts[0].metrics?.reposts, null);
assert.equal(first.completeness, 'unknown');
assert.ok(!JSON.stringify(first).includes('not-returned'));
assert.ok(!JSON.stringify(first).includes('assets.example'));
assert.deepEqual(first.posts[0].comments, []);

const second = parseTimelineExport(j([
  {...labPost('https://twitter.com/a-new-handle/status/301', 'Rev', '2026-11-22T18:00:00Z'), engagementMetrics:{likes: null, replies: 3}},
  labPost('https://x.com/fixture/status/303', 'Third'),
], [{...labCreator, profileUrl:'https://twitter.com/fixture/'}]));
const merged = mergeTimelineExportPages(empty,[first,second]);
assert.equal(merged.posts.length, 3);
assert.equal(merged.creators.length, 1);
assert.equal(merged.updated, 1);
assert.equal(merged.duplicates, 1);
assert.equal(merged.added, 3);
assert.equal(merged.posts.find(p=>p.id===first.posts[0].id)?.text, 'Rev');
assert.equal(merged.posts.find(p=>p.id===first.posts[0].id)?.likes, 0, 'missing count does not destroy observed zero');
assert.equal(merged.posts.find(p=>p.id===first.posts[0].id)?.metrics?.replies, 3);
assert.ok(merged.posts.some(p=>p.text==='Second'), 'older unseen pages are kept');
assert.deepEqual(empty, {creators: [], posts: []}, 'input catalog is not mutated');

const native = {...first.posts[0], id:'live-id', importProvenance:undefined, type:'video' as const, videoUrl:'https://verified.example/own-asset.mp4', liked:true};
const existing: TimelineDataPayload = {creators:[...first.creators], posts:[native], comments:{'live-id':[]}};
const withExisting = mergeTimelineExportPages(existing,[first,second]);
assert.equal(withExisting.posts.length, 3);
assert.equal(withExisting.posts.find(p=>p.id==='live-id'), native);
assert.equal(withExisting.comments, existing.comments);
assert.equal(mergeTimelineExportPages(merged,[first,second]).updated, 0);
assert.equal(mergeTimelineExportPages(merged,[first,second]).added, 0);

const genericCreator = {...labCreator, site:'generic', profileUrl:'https://source.example/my-profile'};
const general = parseTimelineExport(j([labPost('https://source.example/posts/1', 'Generic')],[genericCreator]));
assert.equal(general.posts[0].source, 'generic');
assert.equal(mergeTimelineExportPages(empty,[general,general]).posts.length,1);
assert.throws(()=>parseTimelineExport('not json'), (e: Error) => e instanceof TimelineExportError && e.code==='invalid_format');
assert.equal(parseTimelineExport(j([
  labPost('file:///hidden', 'blocked'), labPost('https://127.0.0.1/private', 'blocked'),
  labPost('https://u:p@safe.example/posts/1', 'blocked'), labPost('https://safe.example/posts/1?token=excluded', 'blocked'),
])).skipped, 4);
assert.equal(parseTimelineExport(j([
  {...labPost('https://safe.example/posts/1','invalid date'), date:'2026-02-31'},
])).posts[0].date, '');
console.log('PASS local export projection, alias identity, repeated batches, preservation and validation.');
