// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The wiki's data layer: lazy per material, cached per session, with the three failures told apart.
 *
 * The list page itself reads nothing: a material's notes are asked for when its panel opens (once per session), the
 * entity list when the entity view first opens, and an arbitration writes the server's answer back into both.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  ARBITRATION_CHOICES, WIKI_KINDS, arbitratedStatus, createWikiCache, createWikiClient, groupEntities,
  wikiFailureKindOf, type WikiClient, type WikiEntity, type VideoWiki,
} from './material-center/wiki.ts';
import {wikiCopyFor, wikiFailureCopy} from './material-center/wiki-copy.ts';

const zh = wikiCopyFor('zh-CN');

const wikiOf = (videoId: string): VideoWiki => ({
  videoId, oneLine: '一句话', scenes: [{startMs: 0, endMs: 1500, desc: '开场'}], bestClip: {startMs: 0, endMs: 1500, why: '最完整'},
  tags: {product: ['杯子'], person: [], scene: ['厨房'], style: []}, production: 'live', confidence: 0.82, risks: ['无声'], status: 'trusted',
});

const entityOf = (entityId: string, kind: WikiEntity['kind'], status: WikiEntity['status'] = 'active'): WikiEntity => ({
  entityId, kind, slug: 's-' + entityId, title: '实体 ' + entityId, bodyMd: '# 标题\n\n正文', tags: ['t'], sources: ['v1', 'v2'], confidence: 0.6, status,
});

function countingWiki() {
  const calls = {video: [] as string[], entities: 0, entity: 0, arbitrate: [] as string[]};
  const client: WikiClient = {
    routes: [],
    async video(videoId) { calls.video.push(videoId); return wikiOf(videoId); },
    async entities() { calls.entities += 1; return [entityOf('e1', 'product'), entityOf('e2', 'hook'), entityOf('e3', 'selling_point'), entityOf('e4', 'scene', 'disputed')]; },
    async entity() { calls.entity += 1; return entityOf('e1', 'product'); },
    async arbitrate(entityId, choice) { calls.arbitrate.push(entityId + ':' + choice); return {...entityOf(entityId, 'scene'), status: arbitratedStatus(choice)}; },
  };
  return {calls, client};
}

test('the list page reads nothing; the first open reads once, the second is the session', async () => {
  const {calls, client} = countingWiki();
  const cache = createWikiCache(client);
  /* What drawing a page does: the cards are already in hand; the wiki is not touched. */
  assert.deepEqual(calls, {video: [], entities: 0, entity: 0, arbitrate: []});
  const first = await cache.video('v1');
  assert.equal(first.oneLine, '一句话');
  assert.deepEqual(calls.video, ['v1'], 'one read, on the open');
  await cache.video('v1');
  assert.deepEqual(calls.video, ['v1'], 'a second open is a memory read');
  assert.equal(cache.peekVideo('v1')?.videoId, 'v1');
});

test('a material opened twice at once is one request (single flight)', async () => {
  let reads = 0;
  const client: WikiClient = {routes: [], async video(id) { reads += 1; return wikiOf(id); }, async entities() { return []; }, async entity() { throw new Error('no'); }, async arbitrate() { throw new Error('no'); }};
  const cache = createWikiCache(client);
  await Promise.all([cache.video('v1'), cache.video('v1'), cache.video('v1')]);
  assert.equal(reads, 1);
});

test('the entity view reads once per session and groups by kind, hooks and selling points included', async () => {
  const {calls, client} = countingWiki();
  const cache = createWikiCache(client);
  const entities = await cache.entities();
  assert.equal(calls.entities, 1);
  await cache.entities();
  assert.equal(calls.entities, 1, 'the second open is a memory read');
  const groups = groupEntities(entities);
  assert.deepEqual(groups.map(group => group.kind), ['product', 'scene', 'hook', 'selling_point'], 'hooks and selling points are sections of their own');
  assert.ok(WIKI_KINDS.includes('hook') && WIKI_KINDS.includes('selling_point'));
});

test('a disputed entity offers three decisions, each one call, and the answer is written back', async () => {
  const {calls, client} = countingWiki();
  const cache = createWikiCache(client);
  const listed = await cache.entities();
  const disputed = listed.find(entity => entity.status === 'disputed')!;
  for (const choice of ARBITRATION_CHOICES) {
    const updated = await cache.arbitrate(disputed.entityId, choice);
    assert.equal(updated.status, arbitratedStatus(choice), choice);
  }
  assert.deepEqual(calls.arbitrate, ['e4:a', 'e4:b', 'e4:keep'], 'one call per decision');
  const again = await cache.entities();
  assert.equal((again.find(entity => entity.entityId === 'e4')!).status, 'disputed', 'the keep decision leaves it disputed in the list');
  assert.equal(calls.entities, 1, 'and the list is not re-read to show it');
});

test('the three failures are told apart, and an empty answer is not one', async () => {
  assert.equal(wikiFailureKindOf(404, 'not-found'), 'not-connected');
  assert.equal(wikiFailureKindOf(501, 'wiki-service-unavailable'), 'not-connected');
  assert.equal(wikiFailureKindOf(429, 'provider-rate-limited'), 'limited');
  assert.equal(wikiFailureKindOf(500, 'internal-error'), 'failed');
  assert.equal(wikiFailureCopy(zh, 'not-connected'), zh.notConnected);
  assert.equal(wikiFailureCopy(zh, 'limited'), zh.limited);
  assert.notEqual(zh.notConnected, zh.limited);

  /* 200 with nothing in it: an empty list, no failure sentence. */
  const client: WikiClient = {routes: [], async video(id) { return wikiOf(id); }, async entities() { return []; }, async entity() { throw new Error('no'); }, async arbitrate() { throw new Error('no'); }};
  const cache = createWikiCache(client);
  assert.deepEqual(await cache.entities(), []);
  assert.deepEqual(groupEntities([]), []);
});

test('the client hits the frozen routes and reads a 429 as limited', async () => {
  const seen: {url: string; method: string}[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({url, method: init?.method ?? 'GET'});
    if (url.endsWith('/video/v1')) return new Response(JSON.stringify(wikiOf('v1')), {status: 200});
    if (url.endsWith('/entities')) return new Response(JSON.stringify([entityOf('e1', 'product')]), {status: 200});
    if (url.endsWith('/arbitrate')) return new Response(JSON.stringify(entityOf('e4', 'scene')), {status: 200});
    return new Response(JSON.stringify({code: 'provider-rate-limited'}), {status: 429});
  };
  const client = createWikiClient({fetch: fetcher});
  assert.equal((await client.video('v1')).videoId, 'v1');
  assert.equal((await client.entities()).length, 1);
  await assert.rejects(() => client.entity('nope'), (error: {kind?: string; status?: number}) => error.kind === 'limited' && error.status === 429);
  assert.ok(seen.some(call => call.method === 'GET' && call.url.includes('/video/v1')));
});

test('the panel and the entity view are rendered with the copy they were given, and their own attributes', () => {
  const panel = readFileSync(new URL('../components/material-center/WikiPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /data-wiki="panel"/);
  assert.match(panel, /data-production=\{wiki\.production\}/, 'the production badge');
  assert.match(panel, /data-wiki-scenes/, 'the scene timeline');
  assert.match(panel, /data-action="use-best-clip"/, 'the best clip can be used');
  assert.match(panel, /data-wiki-risks/);
  assert.match(panel, /data-wiki-confidence/);
  assert.match(panel, /copy\.production\[wiki\.production\]/);
  const entities = readFileSync(new URL('../components/material-center/WikiEntities.tsx', import.meta.url), 'utf8');
  for (const action of ['arbitrate-a', 'arbitrate-b', 'arbitrate-keep']) assert.match(entities, new RegExp('data-action="' + action + '"'), action);
  assert.match(entities, /data-entity-disputed/);
  assert.match(entities, /cache\.arbitrate\(/, 'the decision goes to the client');
  assert.match(entities, /groupEntities\(load\.entities\)/, 'grouped by kind');
  assert.match(entities, /data-source=\{source\}/, 'sources are links to material');
});
