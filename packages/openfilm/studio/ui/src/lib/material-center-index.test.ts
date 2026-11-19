// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The 批次 → 合集 → 子合集 tree the two hosts read, and the read-only function that builds it.
 *
 * The anchors are the ones measured on the real provider: batch `20261106` = 448, its product
 * `20261106-柠檬宝藏茶200g罐` = 221, and `外包装` under it = 49. Nothing here is a fuzzy grouping: the names are parsed,
 * and a name that does not parse is not part of the tree.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  INDEX_ROOT, countsAgree, createMaterialIndexReader, crumbsOf, groupsSum, indexTree, selectedVideoIds,
  selectionAtCrumb, selectionOf, tagPathOf, videoIdsOf, type IndexBatch, type MaterialIndexRow, type MaterialIndexTree,
} from './material-center/index-tree.ts';
import {readIndexRows, readIndexWalk} from './material-center/index-rows.ts';
import {landedIndexOf} from './material-center/index-landed.ts';
import {DEFAULT_MATERIAL_VIEW, MATERIAL_VIEW_KEY, parseViewMode, readViewMode, writeViewMode} from './material-center/view-pref.ts';
import {
  collectionsStages, derivedCounts, stageCounts,
} from './material-center/index-tree.ts';

const rows = (): MaterialIndexRow[] => {
  const out: MaterialIndexRow[] = [];
  const push = (name: string) => out.push({videoId: 'v' + out.length, name});
  for (let n = 1; n <= 49; n += 1) push(`20261106-柠檬宝藏茶200g罐-外包装 (${n})`);
  for (let n = 1; n <= 172; n += 1) push(`20261106-柠檬宝藏茶200g罐-茶干 (${n})`);
  for (let n = 1; n <= 227; n += 1) push(`20261106-陈皮白茶250g罐-包装 (${n})`);
  push('别的名字.mp4');
  return out;
};

const tree = (): MaterialIndexTree => indexTree(rows(), new Date('2026-11-16T00:00:00Z'));

test('the three levels are the name\'s own: batch 448, product 221, 外包装 49', () => {
  const index = tree();
  assert.equal(index.schema, 'orange/material-index/1');
  assert.equal(index.batches.length, 1);
  const batch: IndexBatch = index.batches[0]!;
  assert.equal(batch.id, '20261106');
  assert.equal(batch.count, 448, 'the batch has every material of that date');
  assert.equal(batch.products.length, 2);
  const tea = batch.products.find(collection => collection.name === '柠檬宝藏茶200g罐')!;
  assert.equal(tea.count, 221, 'the collection is the date + the product');
  assert.equal(tea.groups.length, 2);
  assert.equal(tea.groups.find(group => group.name === '外包装')!.count, 49);
  assert.equal(videoIdsOf(index, tea.id, '外包装').length, 49, 'the group\'s ids are exactly its rows');
  assert.equal(videoIdsOf(index, tea.id).length, 221, 'a collection is every group under it');
  assert.equal(index.totals.unclassified, 1, 'a name that does not parse is not claimed by any batch');
  assert.equal(index.unclassified[0]!.name, '别的名字.mp4');
});

test('the groups of a collection add up to the collection: 49 + 172 = 221', () => {
  const index = tree();
  for (const batch of index.batches) {
    for (const collection of batch.products) {
      assert.equal(groupsSum(collection), collection.count, collection.name + ': the 子合集 counts sum to the 合集 count');
      assert.equal(countsAgree(collection), true);
      assert.equal(collection.groups.length > 0, true, 'a collection with no group is not drawn as one');
    }
    assert.equal(batch.products.reduce((total, collection) => total + collection.count, 0), batch.count,
      'the 合集 counts sum to the batch count');
  }
});

test('a crumb trail names each level and goes back one step at a time', () => {
  const index = tree();
  const collection = index.batches[0]!.products.find(row => row.name === '柠檬宝藏茶200g罐')!;
  const group = collection.groups.find(row => row.name === '外包装')!;
  const selection = selectionOf('20261106', collection.id, group.id);
  const crumbs = crumbsOf(index, selection, '全部');
  assert.deepEqual(crumbs.map(crumb => crumb.name), ['全部', '20261106', '柠檬宝藏茶200g罐', '外包装']);
  assert.deepEqual(crumbs.map(crumb => crumb.level), ['root', 'batch', 'collection', 'group']);
  assert.deepEqual(selectionAtCrumb(selection, 'collection', collection.id), selectionOf('20261106', collection.id));
  assert.deepEqual(selectionAtCrumb(selection, 'batch', '20261106'), selectionOf('20261106'));
  assert.deepEqual(selectionAtCrumb(selection, 'root', null), INDEX_ROOT);
  assert.deepEqual(crumbsOf(index, INDEX_ROOT, '全部').map(crumb => crumb.name), ['全部']);
  assert.equal(selectedVideoIds(index, selection).length, 49, 'the deepest step shows that group only');
  assert.equal(selectedVideoIds(index, selectionOf('20261106')).length, 448, 'a batch shows every collection in it');
});

test('the tag path of one material is its own name, and nothing is invented when the name has no pattern', () => {
  assert.deepEqual(tagPathOf('20261106-柠檬宝藏茶200g罐-外包装 (46)'), ['20261106', '柠檬宝藏茶200g罐', '外包装']);
  assert.deepEqual(tagPathOf('20261030-2024头采新会柑普茶250g罐-包装 (33)'), ['20261030', '2024头采新会柑普茶250g罐', '包装']);
  assert.equal(tagPathOf('别的名字.mp4'), null);
  assert.equal(tagPathOf(''), null);
});

test('the index reader says pending, then built or failed — and never fills in a guess', async () => {
  const reader = createMaterialIndexReader({rows: async () => rows(), now: () => new Date('2026-11-16T00:00:00Z')});
  assert.deepEqual(reader.getState(), {state: 'pending'}, 'nothing is claimed before the rows arrive');
  const seen: string[] = [];
  const unsubscribe = reader.subscribe(state => seen.push(state.state));
  await reader.load();
  assert.equal(reader.getState().state, 'ready');
  assert.deepEqual(seen, ['ready'], 'one read, one state');
  const ready = reader.getState();
  assert.equal(ready.state === 'ready' && ready.index.batches[0]!.count, 448);
  unsubscribe();
  reader.destroy();

  const failing = createMaterialIndexReader({rows: async () => { throw Object.assign(new Error('nope'), {code: 'material-service-unavailable'}); }});
  await failing.load();
  assert.deepEqual(failing.getState(), {state: 'failed', code: 'material-service-unavailable'}, 'a source that fails is said, not guessed');
});

test('the rows come from the read-only list, page by page, and stop at the short page', async () => {
  const asked: number[] = [];
  const pageOf = (from: number, items: number, size: number) => ({
    authorization: {layer: 'self' as const, reason: 's'},
    providerScope: 's', pageNo: 1, pageSize: size, total: null, providerTotal: null, totalIsProviderTotal: true as const,
    filtered: {inspected: items, dropped: 0}, grants: false as const,
    items: Array.from({length: items}, (_, at) => ({
      videoId: {value: 'id' + (from + at), sourceType: 'string' as const, source: 'id' + (from + at)},
      observation: {name: '20261106-柠檬宝藏茶200g罐-外包装 (' + (from + at) + ')'},
    })),
  });
  const read = readIndexRows(async (pageNo, pageSize) => {
    asked.push(pageNo);
    /* two full pages, then a page that overlaps the second, then a short one */
    if (pageNo === 1) return pageOf(0, 3, 3);
    if (pageNo === 2) return pageOf(3, 3, 3);
    return pageOf(6, 2, 3);
  }, {pageSize: 3, maxPages: 5});
  const readRows = await read;
  assert.deepEqual(asked, [1, 2, 3], 'the walk stops when a page is shorter than asked for');
  assert.equal(readRows.length, 8, 'every row is kept once');
  assert.equal(readRows[0]!.name, '20261106-柠檬宝藏茶200g罐-外包装 (0)');
  assert.equal(readRows[7]!.name, '20261106-柠檬宝藏茶200g罐-外包装 (7)');

  /* A repeated id across pages is one material, not two: the counts the tree draws never double. */
  const overlapping = await readIndexRows(async pageNo => pageOf(0, 3, 3), {pageSize: 3, maxPages: 2});
  assert.equal(overlapping.length, 3, 'the same id twice is the same material');
});

test('the view the pane opens on is 合集, and nothing but the two modes is a view', () => {
  const memory = new Map<string, string>();
  const storage = {getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }};
  assert.equal(DEFAULT_MATERIAL_VIEW, 'collections', 'the first time the pane opens, it is the 合集 tree');
  assert.equal(readViewMode(storage), 'collections', 'nothing stored is the 合集 tree, never the wall of every video');
  assert.equal(readViewMode(null), 'collections', 'and without storage at all, the same');
  writeViewMode('videos', storage);
  assert.equal(memory.get(MATERIAL_VIEW_KEY), 'videos');
  assert.equal(readViewMode(storage), 'videos', 'a person who switched to 视频 finds 视频');
  assert.equal(parseViewMode('collections'), 'collections');
  assert.equal(parseViewMode('list'), null);
  assert.equal(parseViewMode(null), null);
  memory.set(MATERIAL_VIEW_KEY, 'something-else');
  assert.equal(readViewMode(storage), 'videos', 'junk from another build is not a view: the last real choice stands');
  writeViewMode('collections', storage);
  assert.equal(readViewMode(storage), 'collections', 'and a switch back is remembered too');
});

/* ── the derived layer, and the three stages the 合集 view draws ─────────────────────────────────────────────────────
 *
 * 390 of the account's 78 994 names carry a batch / collection / group. The rest is drawn under the real batches: pseudo
 * batches (the date or number a name opens with), the 「未归档」 buckets (a group word, or a bare `_n`), and a count for
 * the names that say nothing. The three stages must account for every row the tree did not claim.
 */

/** One row per rule, plus two parsed rows: the shape the account actually produces. */
const layeredRows = (): MaterialIndexRow[] => {
  const out: MaterialIndexRow[] = [];
  const push = (name: string) => out.push({videoId: 'v' + out.length, name});
  push('20261106-柠檬宝藏茶200g罐-外包装 (46)');
  push('20261106-柠檬宝藏茶200g罐-茶干 (48)');
  push('12.13_柠檬红茶1-冰心');
  push('20250422-4 张芳源');
  push('茶干/原料_1');
  push('汤色_2');
  push('陈莉莉_1.22柠檬红茶_3');
  push('IMG_2525');
  push('芽尖莓茶1wq');
  return out;
};

const layeredTree = (): MaterialIndexTree => indexTree(layeredRows(), new Date('2026-11-16T00:00:00Z'));

test('the view has three stages, and each draws the count the model says', () => {
  const index = layeredTree();
  const stages = collectionsStages(index);
  assert.deepEqual(stageCounts(stages), {
    realBatches: 1, realCollections: 1, derivedBatches: 2, unfiledGroups: 3, unassigned: 2, total: 9,
  });
  assert.deepEqual(stages.real.map(batch => batch.id), ['20261106'], 'a derived name never becomes a batch');
  assert.deepEqual(stages.derived.map(batch => batch.name).sort(), ['12.13', '20250422']);
  assert.equal(stages.unfiled?.name, '未归档');
  assert.deepEqual(stages.unfiled?.groups.map(group => group.name).sort(), ['其他（只有序号）', '汤色', '茶干'].sort());
  assert.equal(stages.unfiled?.count, 3, 'Σ groups = 未归档 count');
});

test('the stages add up to everything the parsed tree did not claim', () => {
  const index = layeredTree();
  const stages = collectionsStages(index);
  const counts = derivedCounts(index);
  assert.deepEqual(counts, {batches: 2, grouped: 3, unassigned: 2, total: 7});
  assert.equal(counts.total, index.totals.unclassified, 'no name is lost between the layers');
  assert.equal(stageCounts(stages).total, index.totals.videos, 'and no row is counted twice');
  assert.equal(index.totals.parsed, 2);
  assert.equal(index.derived?.batches.every(batch => batch.derived === true), true);
});

test('the three stages are drawn, the third one collapsed and with no card wall', () => {
  const view = readFileSync(new URL('../components/material-center/CollectionsView.tsx', import.meta.url), 'utf8');
  assert.match(view, /data-stage="batches"/, 'stage 1: the real batches');
  assert.match(view, /data-stage="derived"/, 'stage 2a: the pseudo-batches');
  assert.match(view, /data-derived-batch=\{row\.id\} data-derived-count=\{row\.count\}/, 'each with its own count');
  assert.match(view, /data-stage="unfiled" data-unfiled-count=\{stages\.unfiled\.count\}/, 'stage 2b: 未归档, with its count');
  assert.match(view, /data-derived-group=\{row\.id\}/, 'bucketed by group word or sequence');
  assert.match(view, /<details data-stage="unassigned" data-unassigned=\{stages\.unassigned\}/, 'stage 3: collapsed, a count');
  assert.match(view, /<summary[^>]*>\{copy\.unassignedCount\(stages\.unassigned\)\}/, 'whose one line is the count');
  assert.equal(/data-stage="unassigned"[\s\S]{0,600}renderVideos/.test(view), false, 'stage 3 draws no cards');
  assert.match(view, /copy\.derivedMore\(stages\.derived\.length, derivedShown\.length\)/, 'and a long pseudo-batch list says how many there are and how many are shown');
  /* The three lines that explained the read instead of the material are gone from the top of the view (the supplier's
     pageable/claimed arithmetic, and where the index came from): they were read past, never read. */
  assert.equal(/data-note="index-reach"/.test(view), false, 'the supplier\'s arithmetic is not drawn');
  assert.equal(/copy\.indexReach\(/.test(view), false, 'not even a shortened form of it');
  assert.equal(/data-note="index-scope"/.test(view), false, 'and neither is the covered-rows line that stood in its place');
});

test('the supplier\'s claim travels from the page walk to the view, and a walk without one claims nothing', async () => {
  const reading = createMaterialIndexReader({
    rows: async () => ({rows: layeredRows(), reach: {pageable: 79099, sourceTotal: 230030}}),
    now: () => new Date('2026-11-16T00:00:00Z'),
  });
  await reading.load();
  const ready = reading.getState();
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.state === 'ready' ? ready.index.reach : null,
    {pageable: 79099, sourceTotal: 230030, unreachable: 150931}, 'the gap is computed once, not by the view');

  const plain = createMaterialIndexReader({rows: async () => layeredRows()});
  await plain.load();
  const built = plain.getState();
  assert.equal(built.state === 'ready' ? 'reach' in built.index : true, false, 'rows alone make no claim about the feed');
});

test('the page walk reports what it could page beside what the supplier claims', async () => {
  const page = (pageNo: number, items: number, size: number, providerTotal: number | null) => ({
    authorization: {layer: 'self' as const, reason: 's'},
    providerScope: 's', pageNo, pageSize: size, total: providerTotal, providerTotal, totalIsProviderTotal: true as const,
    filtered: {inspected: items, dropped: 0}, grants: false as const,
    items: Array.from({length: items}, (_, at) => ({
      videoId: {value: 'id' + (pageNo * 100 + at), sourceType: 'string' as const, source: 'id' + (pageNo * 100 + at)},
      observation: {name: '12.13_柠檬红茶' + (pageNo * 100 + at)},
    })),
  });
  const walk = await readIndexWalk(async (pageNo, size) => (pageNo === 1 ? page(1, size, size, 179831) : page(pageNo, 2, size, 179831)),
    {pageSize: 4, maxPages: 4});
  assert.equal(walk.rows.length, 6, 'two pages: four rows, then two');
  assert.deepEqual(walk.reach, {pageable: 6, sourceTotal: 179831}, 'what this walk could page, and what was claimed');

  const noClaim = await readIndexWalk(async () => page(1, 1, 4, null), {pageSize: 4, maxPages: 1});
  assert.deepEqual(noClaim.reach, {pageable: 1, sourceTotal: null}, 'a page that claims nothing is not given a claim');
});

test('the page has the toggle, the tree and the detail, and none of the four deleted decorations', () => {
  const page = readFileSync(new URL('../components/material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /data-view-toggle=\{viewMode\}/, 'the toggle\'s state is the view');
  assert.match(page, /MATERIAL_VIEW_MODES\.map\(mode => <button/, 'two icon buttons, one per view');
  assert.match(page, /writeViewMode\(mode\)/, 'a press is remembered in the preferences');
  assert.match(page, /<CollectionsView copy=\{copy\} index=\{index\}/, 'the collections view is drawn from the index');
  assert.match(page, /<MaterialDetail entry=\{detail\}/, 'a material opens the detail sheet');
  assert.match(page, /onOpen: \(id: string\) => setDetailFor/, 'the card asks, the page opens');
  assert.match(page, /<MaterialWiki|onClose=\{\(\) => setDetailFor\(null\)\}/, 'and the sheet closes itself');
  assert.equal(/data-note="provider-total"/.test(page), false, 'the provider-total row is deleted');
  assert.equal(/role="toolbar"/.test(page), false, 'the whole toolbar is deleted');
  assert.equal(/data-action="select-page"|data-action="hide-unauthorized"|data-count="selected"/.test(page), false,
    'select-this-page, hide-unauthorized and the selected count went with it');
  assert.equal(/data-action="open-wiki-entities"/.test(page), false, 'and the entity entry');
  assert.equal(/data-view=\{pane\}|copy\.cards : copy\.list/.test(page), false, 'and the cards/list switch');
  assert.equal(/data-note="spend"/.test(page), false, 'the spend row is deleted');
  assert.equal(/data-action="import-local"|data-action="refresh"/.test(page), false, 'the title row\'s buttons are deleted');
});

/* ── the landed index ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The 合集 view used to be built from an 8 × 100 page walk, so it drew at most 800 of 78 874 materials and looked almost
 * empty. The index `material-index-build.mjs` landed already holds the tree (7 real batches, 1 726 derived ones); the
 * reader takes it from `GET /api/materials/index` and walks the pages only when there is nothing landed to read.
 */

/** The landed route's answer for the account the last real build measured, cut to what the view draws. */
const landedBody = (over: Record<string, unknown> = {}) => ({
  schema: 'orange/material-index-build/1',
  generatedAt: '2026-11-16T11:06:46.134Z',
  staleAfterMs: 86_400_000,
  videos: 78_874, parsed: 390, unclassified: 78_484,
  pageable: 79_099, claimed: 230_030, unreachable: 150_931,
  totals: {videos: 78_874, parsed: 390, unclassified: 78_484},
  batches: Array.from({length: 7}, (_, at) => ({
    id: '2026110' + at, name: '2026110' + at, count: 1,
    products: [{id: 'c' + at, name: 'c' + at, count: 1, groups: [{id: 'g' + at, name: '外包装', count: 1, videoIds: ['v' + at], entries: [{videoId: 'v' + at, name: 'n (' + at + ')', md5: ''}]}]}],
  })),
  derived: {
    count: 78_484,
    batches: Array.from({length: 1726}, (_, at) => ({id: 'd' + at, name: 'd' + at, count: 1, videoIds: [], derived: true})),
    groups: {id: 'derived:unfiled', name: '未归档', count: 26_160, derived: true, groups: []},
    unassigned: 25_597,
  },
  index: {reach: {pageable: 79_099, sourceTotal: 230_030, unreachable: 150_931}},
  stale: false,
  ...over,
});

test('the 合集 view reads the landed index: 7 batches, 1 726 derived ones, and no page walk at all', async () => {
  let walked = 0;
  const reader = createMaterialIndexReader({
    rows: async () => { walked += 1; return layeredRows(); },
    landed: async () => landedIndexOf(landedBody()),
    now: () => new Date('2026-11-16T12:00:00Z'),
  });
  await reader.load();
  const ready = reader.getState();
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') return;
  assert.equal(ready.source, 'landed', 'the landed file is what the view drew');
  assert.equal(ready.index.batches.length, 7, 'the real batches');
  assert.equal(ready.index.derived?.batches.length, 1726, 'the derived layer');
  assert.equal(ready.index.totals.videos, 78_874, 'the whole account, not 800 rows of it');
  assert.equal(ready.rows, 78_874, 'and the count the view prints is that one');
  assert.equal(ready.generatedAt, '2026-11-16T11:06:46.134Z');
  assert.equal(ready.stale, false);
  assert.equal(walked, 0, 'a landed index is not re-read from the supplier at all');
  assert.deepEqual(ready.index.reach, {pageable: 79_099, sourceTotal: 230_030, unreachable: 150_931},
    'the claim travels with the landed tree, so the top line is the supplier\'s own arithmetic');
  assert.deepEqual(stageCounts(collectionsStages(ready.index)).realBatches, 7);
});

test('a landed index past its own window is drawn, and says it is stale', async () => {
  const reader = createMaterialIndexReader({
    rows: async () => { throw new Error('must not be walked'); },
    landed: async () => landedIndexOf(landedBody({stale: true})),
  });
  await reader.load();
  const ready = reader.getState();
  assert.equal(ready.state === 'ready' && ready.stale, true, 'stale is said, not hidden');
  assert.equal(ready.state === 'ready' && ready.index.batches.length, 7, 'and the data is still there: no silent downgrade to 800 rows');
});

test('nothing landed (404 index-missing) falls back to the page walk, and the state says which one it drew', async () => {
  let walked = 0;
  const reader = createMaterialIndexReader({
    landed: async () => { throw Object.assign(new Error('no index'), {code: 'index-missing'}); },
    rows: async () => { walked += 1; return layeredRows(); },
  });
  await reader.load();
  const ready = reader.getState();
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') return;
  assert.equal(ready.source, 'probing', 'the smaller read says so');
  assert.equal(ready.generatedAt, null, 'a walk was built just now: it has no index build time');
  assert.equal(ready.stale, false);
  assert.equal(walked, 1, 'the walk is the fallback, and it ran once');
  assert.equal(ready.rows, ready.index.totals.videos);

  /* A body that is not the index is the same fallback, not an empty tree. */
  const refused = createMaterialIndexReader({landed: async () => landedIndexOf({}), rows: async () => layeredRows()});
  await refused.load();
  const fallback = refused.getState();
  assert.equal(fallback.state === 'ready' ? fallback.source : '', 'probing', 'an unusable body never becomes a tree');
  assert.equal(fallback.state === 'ready' ? fallback.index.totals.videos : 0, layeredRows().length, 'the walk stands in for it');
});

test('a subtitle or a text file never becomes a batch or a 合集', () => {
  const rows: MaterialIndexRow[] = [
    {videoId: 'v1', name: '20261106-柠檬宝藏茶200g罐-外包装 (1)'},
    {videoId: 's1', name: '20261106-柠檬宝藏茶200g罐-外包装 (1).vtt'},
    {videoId: 't1', name: '素材清单.txt'},
  ];
  const index = indexTree(rows, new Date('2026-11-16T00:00:00Z'));
  assert.equal(index.totals.videos, 1, 'only the material row is in the tree');
  assert.equal(index.batches.length, 1);
  assert.equal(index.unclassified.some(row => row.videoId === 's1' || row.videoId === 't1'), false, 'the subtitle and the text are nowhere in it');
});

test('the view no longer prints where the index came from, and a stale one is still said', () => {
  const view = readFileSync(new URL('../components/material-center/CollectionsView.tsx', import.meta.url), 'utf8');
  assert.equal(/data-note="index-source"/.test(view), false, 'the source line (索引来源：已落盘…) is not drawn');
  assert.equal(/copy\.indexSource\(/.test(view), false, 'nor any other form of it');
  assert.match(view, /data-note="index-stale"/, 'a stale landed index says so instead of being dropped');
  assert.match(view, /copy\.indexStale/, 'in its own words');
  const copy = readFileSync(new URL('../lib/material-center/copy.ts', import.meta.url), 'utf8');
  assert.match(copy, /索引来源：已落盘/, 'zh still knows the sentence 已落盘 (kept, not drawn)');
  assert.match(copy, /索引来源：现抓/, 'zh says 现抓 for the fallback');
  assert.match(copy, /Index source: landed/, 'en says landed');
  assert.match(copy, /Index source: probed live/, 'en says probed live');
  assert.match(copy, /索引已过期，可重建/, 'and the stale sentence is the one the operator asked for');
});
