// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `scripts/media-doc-levels.mjs` —— 分类回填。不连真库。
 *
 * 钉两件事：**空值不写**（把 NULL 改成空串没有意义，还会让 `is distinct from` 永远成立、每批都"更新"）
 * 和 **幂等**（同一批跑第二次必须是 0 次更新）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { batchSql, defaultOptions, levelMap, parseArgs } from './media-doc-levels.mjs';

test('levelMap：只收至少有一个分类的条目，空串算空', () => {
  const map = levelMap([
    { videoId: 'v1', oneLevel: '花草养生茶', twoLevel: '莓茶' },
    { videoId: 'v2', oneLevel: '  ', twoLevel: '柠檬红茶' },      // 一级是空白 → 只写二级
    { videoId: 'v3', oneLevel: '', twoLevel: '' },                 // 两边都空 → 不收
    { videoId: '', oneLevel: '茶膏', twoLevel: '茶膏' },             // 没有身份 → 不收
    { videoId: 'v4', oneLevelVideoType: '陈皮柑普', twoLevelVideoType: '小青柑' }, // 另一套键名
  ]);

  assert.deepEqual([...map.keys()], ['v1', 'v2', 'v4']);
  assert.deepEqual(map.get('v1'), { oneLevel: '花草养生茶', twoLevel: '莓茶' });
  assert.deepEqual(map.get('v2'), { oneLevel: null, twoLevel: '柠檬红茶' }, '空白的一级要落成 NULL，不是空串');
  assert.deepEqual(map.get('v4'), { oneLevel: '陈皮柑普', twoLevel: '小青柑' });
});

test('batchSql：一条 update 带一批 values，且只在值真的变了时才写', () => {
  const sql = batchSql('tenant-a', 'card-meta-2', [
    ['v1', { oneLevel: '花草养生茶', twoLevel: "莓茶's" }],
    ['v2', { oneLevel: null, twoLevel: '柠檬红茶' }],
  ]);

  assert.match(sql, /^set app\.company_key = 'tenant-a';/);
  assert.match(sql, /update public\.media_doc d/);
  assert.match(sql, /set one_level = v\.one_level, two_level = v\.two_level/);
  assert.match(sql, /from \(values\n {4}\('v1', '花草养生茶', '莓茶''s'\),\n {4}\('v2', NULL, '柠檬红茶'\)/,
    '单引号要转义，缺值要写 NULL');
  assert.match(sql, /d\.one_level is distinct from v\.one_level/, '值没变就不写 —— 幂等的依据');
  assert.match(sql, /d\.analyzer_ver = 'card-meta-2'/);
  assert.match(sql, /d\.superseded_at is null/, '只改存活行，历史版本不动');
});

test('parseArgs：--batch 必须正整数，--help 返回 null', () => {
  assert.equal(parseArgs(['--help']), null);
  assert.throws(() => parseArgs(['--batch', '0']), /--batch/);
  const parsed = parseArgs(['--batch', '250', '--dry-run']);
  assert.equal(parsed.batch, 250);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.analyzerVer, defaultOptions().analyzerVer);
});
