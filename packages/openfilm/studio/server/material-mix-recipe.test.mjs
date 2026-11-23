// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import { indexRowsForMix, matchRows, mixRecipeFromIndex } from './material-mix-recipe.mjs';

const INDEX = {
  batches: [
    {
      id: '20261020', name: '20261020',
      products: [
        { id: 'p1', name: '油弃乌龙茶200g罐', groups: [{ id: 'g1', name: '冲泡', videoIds: ['101', '102', '103'] }] },
        { id: 'p2', name: '柠檬宝藏茶', groups: [{ id: 'g2', name: '规格', videoIds: ['201', '202'] }] },
      ],
    },
  ],
};

test('索引摊平：每条视频带批次/产品/分组', () => {
  const rows = indexRowsForMix(INDEX);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { videoId: '101', batch: '20261020', product: '油弃乌龙茶200g罐', group: '冲泡' });
});

test('查询优先命中产品，其次分组，最后批次', () => {
  const rows = indexRowsForMix(INDEX);
  assert.deepEqual(matchRows(rows, '乌龙茶').map((r) => r.videoId), ['101', '102', '103']);
  assert.deepEqual(matchRows(rows, '冲泡').map((r) => r.videoId), ['101', '102', '103']);
  assert.deepEqual(matchRows(rows, '20261020').length, 5);
  assert.deepEqual(matchRows(rows, '不存在'), []);
});

test('按查询拼出 10 条 9:16 的配方，refs 去重且是云端素材', () => {
  const built = mixRecipeFromIndex({ index: INDEX, query: '油弃乌龙茶', count: 10, line: '冲泡三分钟就好' });
  assert.deepEqual(built.problems, []);
  assert.equal(built.matched, 3);
  assert.equal(built.recipe.groups[0].name, '油弃乌龙茶200g罐');
  assert.deepEqual(built.recipe.groups[0].refs, [
    { kind: 'cloud', videoId: '101' }, { kind: 'cloud', videoId: '102' }, { kind: 'cloud', videoId: '103' },
  ]);
  assert.deepEqual(built.recipe.script, { provider: 'minimax', voice: 'female-shaonv', lines: ['冲泡三分钟就好'] });
  assert.equal(built.recipe.params.count, 10);
  assert.equal(built.recipe.params.audioUses, 10);
  assert.equal(built.recipe.params.aspect, '9:16');
  assert.equal(built.recipe.params.subtitle, true);
  assert.equal(built.recipe.params.subtitleFontFamily, 'Microsoft YaHei');
  assert.equal(mixRecipeFromIndex({ index: INDEX, query: '油弃乌龙茶', platform: 'darwin' }).recipe.params.subtitleFontFamily, 'Noto Sans CJK SC');
});

test('没有命中或没有索引：problems 说清楚，不编素材', () => {
  const none = mixRecipeFromIndex({ index: INDEX, query: '不存在', count: 5 });
  assert.ok(none.problems.some((line) => line.startsWith('query:')));
  assert.deepEqual(none.recipe.groups[0].refs, []);
  const empty = mixRecipeFromIndex({ index: { batches: [] }, query: '乌龙茶' });
  assert.ok(empty.problems.some((line) => line.startsWith('index:')));
});

test('给了 BGM 就带进 bgm，没给就是空数组', () => {
  const withBgm = mixRecipeFromIndex({ index: INDEX, query: '乌龙茶', bgmPath: 'assets/bgm/light.mp3' });
  assert.deepEqual(withBgm.recipe.bgm, [{ kind: 'asset', path: 'assets/bgm/light.mp3' }]);
  assert.deepEqual(mixRecipeFromIndex({ index: INDEX, query: '乌龙茶' }).recipe.bgm, []);
});
