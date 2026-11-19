// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The index is the one place that decides what a collection is, so these tests pin the shape of a name and the counts
 * observed from the real API: batch 20261106 holds 448 materials, its 柠檬宝藏茶200g罐 collection holds 221, and the
 * 外包装 group inside it holds 49.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMaterialIndex, classifyUnparsedName, derivedTotals, entryMetaOf, labelNames, materialIds, md5Of, parseMaterialName } from './material-index.mjs';

/**
 * The six card fields an entry always carries (`ENTRY_META_FIELDS`), empty when the row said nothing. Written as one
 * spread so a new field is added here once instead of in every `deepEqual`.
 */
const NO_CARD = Object.freeze({ labels: [], durationMs: null, author: '', coverUrl: '', oneLevel: '', twoLevel: '' });

test('a name names its batch, collection and group, and the sequence is not a count', () => {
  assert.deepEqual(parseMaterialName('20261106-柠檬宝藏茶200g罐-外包装 (46)'), {
    date: '20261106', product: '柠檬宝藏茶200g罐', group: '外包装', groupLabel: '外包装', sequence: 46,
    name: '20261106-柠檬宝藏茶200g罐-外包装 (46)',
  });
});

test('a product may carry a hyphen; the group is the segment after it', () => {
  const parsed = parseMaterialName('20261107-猴头菇丁香沙棘茶80g盒-茶干料子 (14)');
  assert.equal(parsed.product, '猴头菇丁香沙棘茶80g盒');
  assert.equal(parsed.groupLabel, '茶干料子');
  assert.equal(parsed.sequence, 14);
});

test('a name that does not follow the pattern is not claimed', () => {
  assert.equal(parseMaterialName('别的名字.mp4'), null);
  assert.equal(parseMaterialName('20261106-没有序号'), null);
  assert.equal(parseMaterialName(''), null);
});

test('counts add up: groups sum to the collection, collections to the batch, batch to the total', () => {
  const rows = [
    { videoId: 'a', name: '20261106-柠檬宝藏茶200g罐-外包装 (46)' },
    { videoId: 'b', name: '20261106-柠檬宝藏茶200g罐-外包装 (6)' },
    { videoId: 'c', name: '20261106-柠檬宝藏茶200g罐-茶干 (48)' },
    { videoId: 'd', name: '20261106-2024头采新会柑普茶250g罐-包装 (33)' },
    { videoId: 'e', name: '别的名字.mp4' },
  ];
  const index = buildMaterialIndex(rows, new Date('2026-11-16T00:00:00Z'));
  assert.deepEqual(index.totals, { videos: 5, parsed: 4, unclassified: 1 });
  const batch = index.batches[0];
  assert.equal(batch.id, '20261106');
  assert.equal(batch.count, 4);
  const tea = batch.products.find((product) => product.name === '柠檬宝藏茶200g罐');
  assert.equal(tea.count, 3);
  assert.deepEqual(tea.groups.map((group) => [group.name, group.count]), [['外包装', 2], ['茶干', 1]]);
  assert.deepEqual(materialIds(index, tea.id), ['a', 'b', 'c']);
  assert.deepEqual(materialIds(index, tea.id, '外包装'), ['a', 'b']);
  assert.deepEqual(materialIds(index, tea.id, '茶干'), ['c']);
  assert.deepEqual(index.unclassified, [{ videoId: 'e', name: '别的名字.mp4', md5: '', ...NO_CARD }]);
});

test('the same video twice is one material, and the tree is ordered by count', () => {
  const rows = [
    { videoId: 'a', name: '20261106-柠檬宝藏茶200g罐-外包装 (1)' },
    { videoId: 'a', name: '20261106-柠檬宝藏茶200g罐-外包装 (1)' },
    { videoId: 'b', name: '20261105-油弃乌龙茶-茶干 (3)' },
    { videoId: 'c', name: '20261105-油弃乌龙茶-茶干 (4)' },
  ];
  const index = buildMaterialIndex(rows);
  assert.equal(index.totals.videos, 3);
  assert.deepEqual(index.batches.map((batch) => batch.id), ['20261105', '20261106']);
});

test('an empty input is an empty index, not an error', () => {
  const index = buildMaterialIndex([]);
  assert.deepEqual(index.totals, { videos: 0, parsed: 0, unclassified: 0 });
  assert.deepEqual(index.batches, []);
});

/* ── the derived layer: what a name that is not a batch still says ──────────────────────────────────────────────────
 *
 * The samples below are the shapes the real account carries (78 604 unclassified names,
 * `docs/execution/2026-11-16-auth-unify/material-index-run.md` §6), one per rule. The layer must (a) put each of them in
 * its own bucket, (b) never let a derived bucket leak into `batches`, and (c) lose none of them.
 */

/** One name per rule, in the order the layer applies them. */
const LAYERED = [
  ['12.13_柠檬红茶1-冰心', 'batch', '12.13'],
  ['0123-茶含片(小尹)邢洁2', 'batch', '0123'],
  ['12月18日 3 茶含片（小尹) 汪学蕊', 'batch', '12月18日'],
  ['20250422-4 张芳源', 'batch', '20250422'],
  ['茶干/原料_1', 'group', '茶干'],
  ['包装_7', 'group', '包装'],
  ['2024头采新会柑普茶250g罐-茶干料子', 'group', '茶干料子'],
  ['陈莉莉_1.22柠檬红茶_3', 'sequence', '其他（只有序号）'],
  ['IMG_2525', 'none', ''],
  ['mmexport1714896000000', 'none', ''],
  ['芽尖莓茶1wq', 'none', ''],
];

test('every rule of the layer is one function, and each sample lands in the bucket it belongs to', () => {
  for (const [name, kind, word] of LAYERED) {
    assert.equal(parseMaterialName(name), null, `${name}: the strict pattern does not claim it`);
    const classified = classifyUnparsedName(name);
    assert.equal(classified.kind, kind, name);
    if (kind === 'batch') assert.equal(classified.token, word, name);
    if (kind === 'group') assert.equal(classified.word, word, name);
  }
});

test('the three buckets hold every unclassified name once: batches, 未归档 groups, and the count of nothing', () => {
  const rows = LAYERED.map(([name], at) => ({ videoId: 'v' + at, name }));
  rows.push({ videoId: 'named', name: '20261106-柠檬宝藏茶200g罐-外包装 (46)' });
  const index = buildMaterialIndex(rows, new Date('2026-11-16T00:00:00Z'));

  /* (a) the real tree is what it was: a derived name never becomes a batch or a collection */
  assert.deepEqual(index.batches.map((batch) => batch.id), ['20261106']);
  assert.deepEqual(index.totals, { videos: rows.length, parsed: 1, unclassified: LAYERED.length });

  /* (b) the pseudo-batches: the numeric date / number the name opens with, marked derived, ids kept apart from dates */
  assert.deepEqual(index.derived.batches.map((batch) => batch.name).sort(),
    ['0123', '12.13', '12月18日', '20250422'].sort());
  assert.deepEqual(index.derived.batches.map((batch) => batch.count), [1, 1, 1, 1]);
  for (const batch of index.derived.batches) {
    assert.equal(batch.derived, true, 'a pseudo-batch says it is derived');
    assert.match(batch.id, /^derived:/, 'and its id cannot collide with a batch date');
  }

  /* (c) 未归档 is one pseudo-collection, bucketed by the group word — or by the bare `_n` sequence */
  const unfiled = index.derived.groups;
  assert.equal(unfiled.name, '未归档');
  assert.deepEqual(unfiled.groups.map((group) => group.name).sort(), ['茶干', '包装', '茶干料子', '其他（只有序号）'].sort());
  assert.equal(unfiled.count, unfiled.groups.reduce((total, group) => total + group.count, 0), 'Σ groups = 未归档 count');

  /* (d) and the rest is a count, with no group invented for it */
  assert.equal(index.derived.unassigned, 3, 'IMG_2525, mmexport… and 芽尖莓茶1wq');
  assert.equal(index.unclassified.length, index.totals.unclassified, 'the flat list is still every unparsed row');
});

test('the layers add up to the flat count: derived + unfiled + unassigned = unclassified', () => {
  const rows = LAYERED.map(([name], at) => ({ videoId: 'v' + at, name }));
  const index = buildMaterialIndex(rows);
  const derived = derivedTotals(index);
  assert.deepEqual(derived, { batches: 4, grouped: 4, unassigned: 3, total: 11 });
  assert.equal(derived.total, index.totals.unclassified, 'no row is lost between the layers');
  assert.equal(index.derived.count, index.totals.unclassified);
});

test('a derived bucket keeps the ids it holds, so a view can count what it shows without the names', () => {
  const index = buildMaterialIndex([
    { videoId: 'a', name: '12.13_柠檬红茶1-冰心' },
    { videoId: 'b', name: '12.13_柠檬红茶2-冰心' },
    { videoId: 'c', name: '包装_7' },
  ]);
  const [batch] = index.derived.batches;
  assert.deepEqual([batch.name, batch.count, batch.videoIds], ['12.13', 2, ['a', 'b']]);
  assert.deepEqual(index.derived.groups.groups[0].videoIds, ['c']);
});

test('a name that is a batch already is not also a derived one, and 2024 as a product word is not a date', () => {
  const index = buildMaterialIndex([
    { videoId: 'a', name: '20261106-柠檬宝藏茶200g罐-外包装 (46)' },
    { videoId: 'b', name: '2024头采新会柑普茶250g罐' },
  ]);
  assert.deepEqual(index.derived.batches, [], 'the parsed batch is in batches, and 2024 with no separator is not a date');
  assert.deepEqual(index.derived.groups.groups, [], 'and 2024头采… carries no group word either');
  assert.equal(index.derived.unassigned, 1);
});

/* ── the digest a material already carries ────────────────────────────────────────────────────────────────────────────
 *
 * `rawMd5` is in every supplier row the Studio serves; it is kept beside the name (`entries`) and on the flat
 * `unclassified` list, and it changes no count. A row without one says `''` rather than a made-up digest.
 */

test('an entry carries the row\'s rawMd5, whichever name the row uses, and an absent one stays empty', () => {
  const index = buildMaterialIndex([
    { videoId: 'a', name: '20261106-柠檬宝藏茶200g罐-外包装 (46)', rawMd5: 'aa11' },
    { videoId: 'b', name: '20261106-柠檬宝藏茶200g罐-外包装 (6)', md5: 'bb22' },
    { videoId: 'c', name: '20261106-柠檬宝藏茶200g罐-外包装 (7)' },
    { videoId: 'd', name: '随便.mp4', rawMd5: 'dd44' },
    { videoId: 'e', name: '随便2.mp4' },
  ]);
  const group = index.batches[0].products[0].groups[0];

  assert.deepEqual(group.entries, [
    { videoId: 'a', name: '20261106-柠檬宝藏茶200g罐-外包装 (46)', md5: 'aa11', ...NO_CARD },
    { videoId: 'b', name: '20261106-柠檬宝藏茶200g罐-外包装 (6)', md5: 'bb22', ...NO_CARD },
    { videoId: 'c', name: '20261106-柠檬宝藏茶200g罐-外包装 (7)', md5: '', ...NO_CARD },
  ]);
  assert.deepEqual(group.videoIds, ['a', 'b', 'c'], 'videoIds is still ids only (materialIds returns them)');
  assert.deepEqual(index.unclassified.map((row) => [row.videoId, row.md5]), [['d', 'dd44'], ['e', '']]);
  assert.deepEqual(index.totals, { videos: 5, parsed: 3, unclassified: 2 }, 'the counts are what they were');
  assert.deepEqual(materialIds(index, '20261106-柠檬宝藏茶200g罐', '外包装'), ['a', 'b', 'c']);
});

test('md5Of reads rawMd5 / md5 / a wrapped literal, and says nothing for anything else', () => {
  assert.equal(md5Of({ rawMd5: 'aa' }), 'aa');
  assert.equal(md5Of({ md5: 'bb' }), 'bb');
  assert.equal(md5Of({ rawMd5: { sourceType: 'string', source: 'cc' } }), 'cc');
  assert.equal(md5Of({ rawMd5: '  dd  ' }), 'dd', 'surrounding space is not part of a digest');
  assert.equal(md5Of({}), '');
  assert.equal(md5Of({ rawMd5: '' }), '');
  assert.equal(md5Of({ rawMd5: 0 }), '');
  assert.equal(md5Of(null), '');
});

test('the supplier\'s claim travels on the tree when the builder is told it', () => {  const rows = [{ videoId: 'a', name: '20261106-柠檬宝藏茶200g罐-外包装 (46)' }];
  assert.equal('reach' in buildMaterialIndex(rows), false, 'a tree built from rows alone claims nothing about the feed');
  const index = buildMaterialIndex(rows, new Date('2026-11-16T00:00:00Z'), { sourceTotal: 230030, pageable: 79099, unreachable: 150931 });
  assert.deepEqual(index.reach, { sourceTotal: 230030, pageable: 79099, unreachable: 150931 });
});

/* ── the six card fields (`ENTRY_META_FIELDS`) ────────────────────────────────────────────────────────────────────────
 *
 * These are what `mediaDocText` needs to say *which* material a card is: `外包装` alone is a token every tea shares, and
 * `茉莉花茶类` / `柠檬宝藏茶200g罐` (the two classification levels) never reached a document while the harvest dropped
 * them here. They are additive — no count, order or id moves.
 */

test('an entry keeps the supplier\'s labels, duration (seconds → ms), author, cover and both categories', () => {
  const index = buildMaterialIndex([
    {
      videoId: 'a',
      name: '20261106-柠檬宝藏茶200g罐-外包装 (46)',
      videoLabels: [
        { id: { sourceType: 'number', source: '192073' }, name: '首发素材' },
        { id: { sourceType: 'number', source: '204335' }, name: '屈屈' },
        '',
      ],
      duration: { sourceType: 'number', source: '23' },
      accountName: '周佳',
      coverUrl: 'https://example.test/cover.png',
      oneLevelVideoType: { id: { sourceType: 'number', source: '98418' }, name: '花草养生茶' },
      twoLevelVideoType: { name: '一根人参茶' },
    },
    { videoId: 'b', name: '20261106-柠檬宝藏茶200g罐-外包装 (7)' },
  ], new Date('2026-11-16T00:00:00Z'));
  const [first, second] = index.batches[0].products[0].groups[0].entries;

  assert.deepEqual(first.labels, ['首发素材', '屈屈'], 'the wire names, in order, blank dropped (dedupe/sort is the doc layer\'s)');
  assert.equal(first.durationMs, 23000, 'the supplier counts seconds (`durationSeconds`); the entry counts milliseconds');
  assert.equal(first.author, '周佳');
  assert.equal(first.coverUrl, 'https://example.test/cover.png');
  assert.deepEqual([first.oneLevel, first.twoLevel], ['花草养生茶', '一根人参茶']);
  assert.deepEqual(second, {
    videoId: 'b', name: '20261106-柠檬宝藏茶200g罐-外包装 (7)', md5: '', ...NO_CARD,
  }, 'a row that said nothing keeps empty fields — never undefined, never an invented value');
  assert.deepEqual(index.totals, { videos: 2, parsed: 2, unclassified: 0 }, 'the card fields change no count');
});

test('an index written before these fields existed still reads: what is absent is empty, not an error', () => {
  const old = { videoId: 'a', name: '20261106-柠檬宝藏茶200g罐-外包装 (46)', md5: 'aa' };
  assert.deepEqual(entryMetaOf(old), { ...NO_CARD });
  assert.deepEqual(entryMetaOf(null), { ...NO_CARD });
  assert.deepEqual(entryMetaOf(undefined), { ...NO_CARD });

  /* An entry that already speaks the normalized names is read as is (`durationMs` is not multiplied twice). */
  assert.deepEqual(entryMetaOf({ durationMs: 1234, labels: ['茶'], oneLevel: '花草养生茶' }), {
    labels: ['茶'], durationMs: 1234, author: '', coverUrl: '', oneLevel: '花草养生茶', twoLevel: '',
  });
  assert.equal(entryMetaOf({ durationSeconds: 3 }).durationMs, 3000);
  assert.deepEqual(labelNames(['茶', '', '  ', { name: '屈屈' }, { sourceType: 'string', source: '牌' }]), ['茶', '屈屈', '牌']);
});

