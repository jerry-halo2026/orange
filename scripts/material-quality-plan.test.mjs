// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `scripts/material-quality-plan.mjs` —— 语料质量计划（隔离集 + 同文组），不连真库。
 *
 * 这一层要钉死的是**口径**，不是"函数跑通了"：
 *   1. 隔离集的判定 SQL **不许**在旧版本那一侧按 `superseded_at` 过滤 —— 一过滤，隔离行被取代之后
 *      清单就变空了，而 `--exclude-file` 每次都是重新生成再传进去的，等于闸自己消失；
 *   2. 同文组留谁：`media_key` 字典序最小的那行（确定性），其余落 `drop`；
 *   3. 落盘失败或自检不过时，旧清单不能被半份 JSON 顶掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildPlan, defaultOptions, indexOverlap, parseArgs, readRows, writePlan } from './material-quality-plan.mjs';

const OPTIONS = { ...defaultOptions(), tenant: 'tenant-a', canonical: 'card-meta-2', stale: 'card-meta-1' };

test('buildPlan 把 q/c/d 三类行拆成隔离集、计数与同文组', () => {
  const plan = buildPlan([
    'q|v3',
    'q|v9',
    'c|67156|64352|78874|67156',
    'd|0123abcd|3|v1|v1,v10,v11',
    'd|4567ef01|2|v2|v2,v20',
  ], OPTIONS);

  assert.deepEqual(plan.quarantined, ['v3', 'v9']);
  assert.deepEqual(plan.totals, {
    canonicalRows: 67156,
    distinctText: 64352,
    duplicateTextRows: 5,
    duplicateTextGroups: 2,
    staleRows: 78874,
    liveRows: 67156,
    quarantined: 2,
    searchable: 67156,
  });
  /* 留字典序最小的那行，其余才是 drop —— 顺序不能反，反了就是把要留的那行从检索里摘掉。 */
  assert.deepEqual(plan.duplicateTexts[0], { digest: '0123abcd', rows: 3, keep: 'v1', drop: ['v10', 'v11'] });
  assert.equal(plan.schema, 'orange/material-quality-plan/1');
  assert.equal(plan.tenant, 'tenant-a');
});

test('buildPlan 对空输出给的是零，不是 NaN（库是空的也得能出计划）', () => {
  const plan = buildPlan([], OPTIONS);
  assert.equal(plan.totals.canonicalRows, 0);
  assert.equal(plan.totals.quarantined, 0);
  assert.deepEqual(plan.quarantined, []);
  assert.deepEqual(plan.duplicateTexts, []);
});

test('隔离集的 SQL 两侧口径不对称：旧版本不看 superseded_at，规范版本只看存活行', async () => {
  const scripts = [];
  const psql = async (script) => { scripts.push(script); return { code: 0, stdout: '', stderr: '' }; };
  await readRows(psql, OPTIONS);
  const sql = scripts[0];

  assert.match(sql, /^set app\.company_key = 'tenant-a';/, 'RPC 不从参数取租户；RLS 是 FORCE 的');
  const [staleSide, canonicalSide] = sql.split(' except ');
  assert.match(staleSide, /analyzer_ver = 'card-meta-1'/, '旧版本这一侧要出现');
  assert.equal(/superseded_at/.test(staleSide), false,
    '旧版本这一侧一旦按 superseded_at 过滤，隔离行被取代后清单就空了，闸会自己消失');
  assert.match(canonicalSide, /analyzer_ver = 'card-meta-2'/);
  assert.match(canonicalSide, /superseded_at is null/, '规范版本这一侧要的正是"现在还能被检索到"');
});

test('readRows 的会话失败会抛，且把 psql 的第一行 ERROR 带出来', async () => {
  await assert.rejects(
    () => readRows(async () => ({ code: 1, stdout: '', stderr: 'ERROR:  42501 permission denied\n' }), OPTIONS),
    /读取语料质量数据失败.*42501/,
  );
});

test('writePlan 落盘后自检能读回，且不留 .tmp', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orange-plan-'));
  const file = path.join(dir, 'quality-plan.json');
  const plan = { ...buildPlan(['q|v3', 'c|10|9|12|10'], OPTIONS) };
  const bytes = writePlan(file, plan);

  assert.ok(bytes > 0);
  assert.equal(existsSync(`${file}.tmp`), false);
  const readBack = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(readBack.quarantined, ['v3']);
  assert.equal(readBack.totals.canonicalRows, 10);
});

test('indexOverlap 按 videoId 对上索引，两份形状（批次树 / unclassified）都算', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orange-index-'));
  const file = path.join(dir, 'index.json');
  writeFileSync(file, JSON.stringify({
    index: {
      batches: [{ products: [{ groups: [{ entries: [{ videoId: 'v1' }, { videoId: 'v2' }] }] }] }],
      unclassified: [{ videoId: 'v3' }, { videoId: 'v4' }],
    },
  }));

  const overlap = indexOverlap(file, ['v1', 'v3', 'zz']);
  assert.equal(overlap.entries, 4);
  assert.equal(overlap.overlap, 2, 'v1/v3 在索引里，zz 不在');
  assert.equal(indexOverlap(file, []).overlap, 0);
  assert.equal(indexOverlap(null, ['v1']), null, '没给索引就别假装对过账');
  assert.match(indexOverlap(path.join(dir, 'nope.json'), ['v1']).error, /索引不存在/);
});

test('parseArgs 认 --canonical/--stale/--out，--help 返回 null（调用方据此不跑）', () => {
  const parsed = parseArgs(['--canonical', 'card-meta-3', '--stale=card-meta-2', '--out', 'x.json', '--tenant', 't9']);
  assert.equal(parsed.canonical, 'card-meta-3');
  assert.equal(parsed.stale, 'card-meta-2');
  assert.equal(parsed.out, 'x.json');
  assert.equal(parsed.tenant, 't9');
  assert.equal(parseArgs(['--help']), null);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});
