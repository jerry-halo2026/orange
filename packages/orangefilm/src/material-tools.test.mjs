// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The three read-only material tools, and the five-slot budget they were bought with.
 *
 * The index is built and landed by `material-index-build.mjs`; these tests write one to a temporary directory and read
 * it the way an MCP server would, so no home directory and no network is touched. `material.search` is the one handler
 * that leaves this computer, so it is given a function instead of a database — the same seam the MCP server uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMaterialIndexFromApi, writeMaterialIndex } from './material-index-build.mjs';
import {
  MATERIAL_BUDGET_SURFACE, MATERIAL_TOOL_CAPS, MATERIAL_TOOL_CAPS_CONTRACT, MATERIAL_TOOL_DEFINITIONS,
  MATERIAL_TOOL_NAMES, TOOL_BUDGET, callMaterialTool, createMaterialTools, planMaterialToolSurface,
} from './material-tools.mjs';
import { MATERIAL_SEARCH_CAPS, MATERIAL_SEARCH_CAPS_CONTRACT } from './material-search.mjs';

const ROWS = [
  { videoId: 'a', name: '20261106-柠檬宝藏茶200g罐-外包装 (1)' },
  { videoId: 'b', name: '20261106-柠檬宝藏茶200g罐-外包装 (2)' },
  { videoId: 'c', name: '20261106-柠檬宝藏茶200g罐-茶干 (48)' },
  { videoId: 'd', name: '20261105-油弃乌龙茶-茶干 (3)' },
  { videoId: 'e', name: '随便.mp4' },
];

/** Build and land one index, then return its directory. */
async function landedIndex() {
  const dir = join(mkdtempSync(join(tmpdir(), 'material-tools-')), 'material-index');
  const result = await buildMaterialIndexFromApi({
    fetchPage: async () => ({ items: ROWS, total: ROWS.length }),
    pageSize: 10,
    videoTypes: [1],
    now: new Date('2026-11-16T00:00:00Z'),
  });
  await writeMaterialIndex(dir, result);
  return dir;
}

test('the surface stays inside five tools, and the plan says which slots the three cost', () => {
  const plan = planMaterialToolSurface();

  assert.equal(TOOL_BUDGET, 5);
  assert.equal(MATERIAL_TOOL_NAMES.length, 3);
  assert.equal(plan.count, plan.after.length);
  assert.ok(plan.count <= TOOL_BUDGET, `surface is ${plan.count}`);
  assert.equal(plan.fits, true);
  assert.deepEqual(plan.after, [...MATERIAL_BUDGET_SURFACE], 'the plan returns the order the server serves');
  assert.deepEqual(plan.after.slice(0, 3), [...MATERIAL_TOOL_NAMES]);
  assert.ok(plan.after.includes('materials.take') && plan.after.includes('timeline.insert_clip'), 'the write verbs stay');
  assert.equal(plan.after.includes('materials.search'), false, 'absorbed into material.search');
  assert.equal(plan.after.includes('material.batches'), false, 'its one fact is material.collections({batch})’s answer');
  assert.equal(plan.after.includes('orangefilm.look'), false, 'retired: it draws a PNG for a person');
  assert.deepEqual(plan.merged, [{ from: ['wiki.video', 'wiki.timeline', 'wiki.shot'], to: 'wiki.read', why: plan.merged[0].why }]);
  assert.deepEqual(plan.retired, ['wiki.read', 'orangefilm.look']);
  assert.deepEqual(plan.absorbed.map((entry) => [entry.tool, entry.into]), [['materials.search', 'material.search']]);
  assert.deepEqual(plan.replaced.map((entry) => [entry.tool, entry.by]), [['material.batches', 'material.collections']]);
  assert.deepEqual(plan.slots, { before: 7, merged: 2, absorbed: 1, retired: 2, added: 3, after: 5, balanced: true });

  const keepWiki = planMaterialToolSurface(undefined, { retire: ['orangefilm.look'] });
  assert.equal(keepWiki.fits, false, 'keeping the wiki read needs the documented fold, not a sixth slot');
  assert.equal(keepWiki.slots.after, 6);
  assert.equal(keepWiki.slots.balanced, true);
});

test('every tool is defined once, read-only, with the arguments it documents', () => {
  assert.deepEqual(MATERIAL_TOOL_DEFINITIONS.map((tool) => tool.name), [...MATERIAL_TOOL_NAMES]);
  for (const tool of MATERIAL_TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.match(tool.description, /Read-only/);
  }
  assert.deepEqual(MATERIAL_TOOL_DEFINITIONS[0].inputSchema.required, ['query']);
  assert.deepEqual(MATERIAL_TOOL_DEFINITIONS[2].inputSchema.required, ['collection']);
  assert.deepEqual(Object.keys(MATERIAL_TOOL_DEFINITIONS[0].inputSchema.properties), ['query', 'batch', 'product', 'group', 'durationMaxMs', 'limit']);
  assert.equal(MATERIAL_TOOL_CAPS.search, MATERIAL_SEARCH_CAPS.limit);
  assert.equal(MATERIAL_TOOL_CAPS.searchDefault, MATERIAL_SEARCH_CAPS.defaultLimit);
  assert.deepEqual(MATERIAL_TOOL_CAPS_CONTRACT.searchRows, MATERIAL_SEARCH_CAPS_CONTRACT.rows);
  assert.deepEqual(
    [MATERIAL_TOOL_CAPS.search, MATERIAL_TOOL_CAPS.searchDefault, MATERIAL_TOOL_CAPS.collections, MATERIAL_TOOL_CAPS.groupsPerCollection, MATERIAL_TOOL_CAPS.items, MATERIAL_TOOL_CAPS.itemsDefault],
    [50, 10, 50, 200, 200, 50],
  );
});

test('material.search says the two things it needs: a query, and a machine that can search', async () => {
  /* no search configured: a state with the setting's name, not an error and not an empty library */
  const unconfigured = createMaterialTools({ dir: join(tmpdir(), 'material-tools-absent') });
  const refused = await unconfigured['material.search']({ query: '柠檬宝藏茶' });
  assert.equal(refused.structuredContent.ok, false);
  assert.equal(refused.structuredContent.code, 'not-configured');
  assert.match(refused.structuredContent.message, /ORANGE_MEDIA_TENANT/);
  assert.equal(refused.isError, undefined, 'a state, not a crash');

  const blank = await unconfigured['material.search']({ query: '   ' });
  assert.equal(blank.structuredContent.code, 'invalid-arguments');
});

test('material.search asks the search with the RPC’s filter names and the contract’s limit', async () => {
  /** @type {any[]} */
  const asked = [];
  const search = async (request) => {
    asked.push(request);
    return {
      mode: 'vector', query: request.query, count: 1,
      items: [{ mediaKey: 'v1', videoId: 'v1', name: 'n', batch: '20261106', product: null, gname: '外包装', durationMs: null, score: 0.9, matchKind: 'vector', availability: { local: false } }],
    };
  };
  const tools = createMaterialTools({ search });

  const answered = await tools['material.search']({ query: ' 柠檬宝藏茶 ', batch: '20261106', group: '外包装', durationMaxMs: 9000, limit: 3 });
  assert.deepEqual(asked, [{ query: '柠檬宝藏茶', filters: { batch: '20261106', gname: '外包装', durationMaxMs: 9000 }, limit: 3 }]);
  const payload = answered.structuredContent;
  assert.equal(payload.ok, true);
  assert.equal(payload.tool, 'material.search');
  assert.equal(payload.mode, 'vector');
  assert.equal(payload.count, 1);
  assert.deepEqual(payload.items[0].availability, { local: false });

  await tools['material.search']({ query: '茶' });
  assert.equal(asked[1].limit, MATERIAL_SEARCH_CAPS.defaultLimit, 'ten rows unless asked');
  await tools['material.search']({ query: '茶', limit: 10_000 });
  assert.equal(asked[2].limit, MATERIAL_SEARCH_CAPS.limit, 'never more than fifty');
  await tools['material.search']({ query: '茶', limit: 0 });
  assert.equal(asked[3].limit, MATERIAL_SEARCH_CAPS.defaultLimit, 'zero is not a row count');

  /* a search that fails is a named failure, and the code is the search's own */
  const failing = createMaterialTools({ search: async () => { throw Object.assign(new Error('psql is not installed'), { code: 'media-search-failed' }); } });
  const failed = await failing['material.search']({ query: '茶' });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.code, 'media-search-failed');
  assert.match(failed.structuredContent.message, /psql/);
});

test('material.search needs no landed index: the RPC is the answer', async () => {
  const tools = createMaterialTools({
    dir: join(tmpdir(), 'material-tools-no-index-at-all'),
    search: async ({ query }) => ({ mode: 'lexical', query, count: 0, items: [] }),
  });
  const answered = await tools['material.search']({ query: '茶' });
  assert.equal(answered.structuredContent.ok, true);
  assert.equal(answered.structuredContent.code, undefined, 'no index-missing: this tool never reads index.json');
  assert.deepEqual(answered.structuredContent.items, [], 'an empty answer is an empty list, said as such');
});

test('material.collections names the collections of one batch, or of all', async () => {
  const tools = createMaterialTools({ dir: await landedIndex() });

  const all = await tools['material.collections']({});
  assert.deepEqual(all.structuredContent.collections.map((collection) => [collection.id, collection.count]), [
    ['20261106-柠檬宝藏茶200g罐', 3], ['20261105-油弃乌龙茶', 1],
  ]);
  assert.deepEqual(all.structuredContent.collections[0].groups.map((group) => [group.name, group.count]), [
    ['外包装', 2], ['茶干', 1],
  ]);

  const one = await tools['material.collections']({ batch: '20261105' });
  assert.deepEqual(one.structuredContent.collections.map((collection) => collection.id), ['20261105-油弃乌龙茶']);

  const unknown = await tools['material.collections']({ batch: '20990101' });
  assert.equal(unknown.structuredContent.ok, false);
  assert.equal(unknown.structuredContent.code, 'batch-unknown');
  assert.deepEqual(unknown.structuredContent.batches, ['20261106', '20261105']);
});

test('material.items answers with ids and names, narrowed by group and capped by limit', async () => {
  const tools = createMaterialTools({ dir: await landedIndex() });

  const whole = await tools['material.items']({ collection: '20261106-柠檬宝藏茶200g罐' });
  assert.equal(whole.structuredContent.ok, true);
  assert.equal(whole.structuredContent.total, 3);
  assert.deepEqual(whole.structuredContent.items.map((item) => item.videoId), ['a', 'b', 'c']);
  assert.equal(whole.structuredContent.items[0].name, '20261106-柠檬宝藏茶200g罐-外包装 (1)');

  const byName = await tools['material.items']({ collection: '柠檬宝藏茶200g罐' });
  assert.deepEqual(byName.structuredContent.items.map((item) => item.videoId), ['a', 'b', 'c'], 'a name is as good as an id');

  const group = await tools['material.items']({ collection: '20261106-柠檬宝藏茶200g罐', group: '外包装' });
  assert.deepEqual(group.structuredContent.items.map((item) => item.videoId), ['a', 'b']);

  const capped = await tools['material.items']({ collection: '20261106-柠檬宝藏茶200g罐', limit: 2 });
  assert.equal(capped.structuredContent.items.length, 2);
  assert.equal(capped.structuredContent.truncated, true);
  assert.equal(capped.structuredContent.total, 3);

  const overLimit = await tools['material.items']({ collection: '20261106-柠檬宝藏茶200g罐', limit: 10_000 });
  assert.ok(overLimit.structuredContent.items.length <= MATERIAL_TOOL_CAPS.items);
});

test('a collection or group the index does not know is a named refusal, not an empty list', async () => {
  const tools = createMaterialTools({ dir: await landedIndex() });

  const collection = await tools['material.items']({ collection: '不存在的合集' });
  assert.equal(collection.structuredContent.code, 'collection-unknown');
  assert.ok(collection.structuredContent.collections.includes('20261106-柠檬宝藏茶200g罐'));

  const group = await tools['material.items']({ collection: '20261106-柠檬宝藏茶200g罐', group: '封面' });
  assert.equal(group.structuredContent.code, 'group-unknown');
  assert.deepEqual(group.structuredContent.groups, ['外包装', '茶干']);

  const arguments_ = await tools['material.items']({});
  assert.equal(arguments_.structuredContent.code, 'invalid-arguments');
});

test('no index yet is said as index-missing, with the command that makes one', async () => {
  const tools = createMaterialTools({ dir: join(tmpdir(), 'material-tools-absent') });

  for (const name of ['material.collections', 'material.items']) {
    const answered = await tools[name](name === 'material.items' ? { collection: 'x' } : {});
    assert.equal(answered.structuredContent.ok, false, name);
    assert.equal(answered.structuredContent.code, 'index-missing', name);
    assert.match(answered.structuredContent.message, /material-index-build\.mjs/);
    assert.equal(answered.isError, undefined, 'a state, not a crash');
  }
});

test('callMaterialTool dispatches by name and reports one it does not have', async () => {
  const dir = await landedIndex();

  const hit = await callMaterialTool('material.collections', {}, { dir });
  assert.equal(hit.structuredContent.ok, true);

  const searched = await callMaterialTool('material.search', { query: '茶' }, {
    dir,
    search: async ({ query }) => ({ mode: 'index', query, count: 0, items: [] }),
  });
  assert.equal(searched.structuredContent.ok, true);
  assert.equal(searched.structuredContent.mode, 'index');

  const miss = await callMaterialTool('material.nope', {}, { dir });
  assert.equal(miss.structuredContent.code, 'unknown-tool');
  assert.deepEqual(miss.structuredContent.tools, [...MATERIAL_TOOL_NAMES]);
});
