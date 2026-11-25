import { strict as assert } from 'node:assert';
import { isTimelineDataPayload, mapScanResponseToTimelinePosts, resolveTimelinePlatform } from '../src/components/profile-hub/timeline/timelineModel';
import type { TimelineCreator, TimelinePost } from '../src/components/profile-hub/timeline/timelineModel';

const creator: TimelineCreator = {id: 'app-creator-01', name: 'Lia', handle: '@lia', avatar: '', profileUrl: 'https://x.com/lia', verified: false, site: 'x', stats: {}};
const incoming: TimelinePost = {
  id: 'source-001', creatorId: 'provider-creator-01', creatorName: 'Lia', creatorHandle: '@lia', creatorAvatar: '',
  title: '', text: 'Este é um post de teste.', originalUrl: 'https://twitter.com/lia/status/17281931', type: 'text',
  relation: {kind: 'quote', post: {creatorName: 'Outra pessoa', text: 'Texto da citação'}},
  metrics: {likes: 0, replies: null}, comments: [], likes: null, date: '',
};
const [first] = mapScanResponseToTimelinePosts(creator, {canonical_posts: [incoming, {...incoming, originalUrl: 'https://x.com/i/status/17281931'}]});
assert.equal(mapScanResponseToTimelinePosts(creator, {canonical_posts: [incoming, {...incoming, originalUrl: 'https://x.com/i/status/17281931'}]}).length, 1);
assert.equal(first.creatorId, creator.id);
assert.equal(first.relation?.post?.creatorName, 'Outra pessoa');
assert.equal(first.likes, 0);
assert.equal(first.metrics?.replies, null);
const existing = {...first, id: 'existing-stable-id', liked: true, favorited: true};
const refreshed = mapScanResponseToTimelinePosts(creator, {canonical_posts: [{...incoming, text: 'Atualizado', originalUrl: 'https://x.com/i/status/17281931'}]}, [existing]);
assert.equal(refreshed.length,1);
assert.equal(refreshed[0].id,existing.id);
assert.equal(refreshed[0].liked,true);
assert.equal(refreshed[0].favorited,true);
assert.equal(refreshed[0].text,'Atualizado');
assert.deepEqual(mapScanResponseToTimelinePosts(creator, {}, [existing]),[existing]);
assert.equal(isTimelineDataPayload({creators: [], posts: [{...incoming, type: 'unknown'}]}), false);
assert.equal(mapScanResponseToTimelinePosts(creator, {canonical_posts: [{...incoming, likes: 12, metrics: {}}]})[0].likes, 12);
assert.equal(mapScanResponseToTimelinePosts(creator, {canonical_posts: [{...incoming, likes: 12, metrics: {likes: null}}]})[0].likes, null);
assert.equal(isTimelineDataPayload({creators: [], posts: [{...incoming, relation: {kind: 'unknown'}}]}), false);
assert.equal(isTimelineDataPayload({creators: [], posts: [{...incoming, metrics: {likes: -1}}]}), false);
assert.equal(mapScanResponseToTimelinePosts(creator, {canonical_posts: [{...incoming, originalUrl: 'file:///test'}]}).length, 0);
assert.equal(resolveTimelinePlatform('https://mobile.twitter.com/lia'), 'x');
assert.equal(resolveTimelinePlatform('https://www.instagram.com/lia'), 'instagram');
assert.equal(resolveTimelinePlatform('https://instagram.com.example.test/lia'), undefined);
console.log('social timeline model: normalized contract, aliases, partial refresh, metrics and validation passed');
