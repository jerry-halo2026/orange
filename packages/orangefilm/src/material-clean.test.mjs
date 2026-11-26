// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `material-clean.mjs` 的测试：每条规则一条，加三类边界（垃圾输入、不许误剥的真实名字、退化 entry）。
 *
 * 断言用的都是索引里的真名字（`docs/execution/2026-11-17-retrieval/clean-report.md` §C 的样本），
 * 所以规则改动会在这里留下痕迹，而不是等到上云之后在库里发现。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyEntry,
  cleanEntry,
  contentCounts,
  indexEntries,
  MATERIAL_EXTENSIONS,
  nameTextKey,
  normalizeName,
  normalizeNameDetailed,
  splitIdentity,
  SUBTITLE_EXTENSIONS,
  summarizeClean,
  TEXT_EXTENSIONS,
  toHalfWidth,
  trailingNameRule,
} from './material-clean.mjs';

/* ── 规则 1：normalizeName ─────────────────────────────────────────────────────────────────────────────────────── */

test('normalizeName: 全角 → 半角（含全角括号与全角空格）', () => {
  assert.equal(toHalfWidth('ＡＢＣ１２３'), 'ABC123');
  assert.equal(normalizeName('１２月１８日　茶含片（小尹）'), '12月18日 茶含片(小尹)');
  /* U+FF01–FF5E 里的全角标点是分隔符，统一成半角；不在这一段里的 `、` `。` 属于文字，不动 */
  assert.equal(normalizeName('茶干，原料、包装。'), '茶干,原料、包装。');
  assert.ok(normalizeNameDetailed('茶干，原料').issues.includes('fullwidth'));
});

test('normalizeName: 连续空白折叠成一个空格并去首尾', () => {
  assert.equal(normalizeName('12月18日 3  茶含片（小尹) 汪学蕊'), '12月18日 3 茶含片(小尹) 汪学蕊');
  assert.equal(normalizeName('  茶干   料子  '), '茶干 料子');
  assert.deepEqual(normalizeNameDetailed('  a  b  ').issues.includes('whitespace'), true);
});

test('normalizeName: 括号配对修复——缺右括号补末尾', () => {
  const out = normalizeNameDetailed('5月29日油弃乌龙茶1（隆');
  assert.equal(out.name, '5月29日油弃乌龙茶1(隆)');
  assert.ok(out.issues.includes('unbalanced-paren'));
  assert.equal(normalizeName('茶膏三姐妹14王雨5（改'), '茶膏三姐妹14王雨5(改)');
});

test('normalizeName: 括号配对修复——多余右括号就地删掉', () => {
  assert.equal(normalizeName('茶含片) 汪学蕊'), '茶含片 汪学蕊');
  assert.equal(normalizeName('外包装(大翔A款))'), '外包装(大翔A款)');
  /* 已经配对的括号一个字符都不动 */
  assert.equal(normalizeName('外包装(大翔A款)'), '外包装(大翔A款)');
  assert.equal(normalizeNameDetailed('外包装(大翔A款)').issues.includes('unbalanced-paren'), false);
  /* 修好括号之后，序号尾巴才认得出来（全角括号写的序号也是序号） */
  assert.equal(normalizeName('外包装（24）'), '外包装');
});

test('normalizeName: 去尾部 ` (n)`', () => {
  assert.equal(normalizeName('20261109-油弃乌龙茶-外包装 (24)'), '20261109-油弃乌龙茶-外包装');
  assert.equal(normalizeName('1224 一根人生茶 陈静 (3)'), '1224 一根人生茶 陈静');
  /* 全角括号写的序号也认 */
  assert.equal(normalizeName('外包装（12）'), '外包装');
  assert.ok(normalizeNameDetailed('外包装 (12)').issues.includes('trailing-sequence'));
});

test('normalizeName: 去尾部 `_n`，但采集原名不动', () => {
  assert.equal(normalizeName('素材-王鑫-3.18但哥茶膏_2'), '素材-王鑫-3.18但哥茶膏');
  assert.ok(normalizeNameDetailed('茶干_3').issues.includes('trailing-underline'));
  /* `IMG_2525` 的 2525 是它的身份，剥掉 923 行会塌成一条 */
  assert.equal(normalizeName('IMG_2525'), 'IMG_2525');
  assert.equal(normalizeName('mmexport1699300000000_1'), 'mmexport1699300000000_1');
  /* `1,2,3` 里的数字不是序号尾巴 */
  assert.equal(normalizeName('茶干1'), '茶干1');
});

test('normalizeName: 剥成空就退回原名（清洗不产生空名字）', () => {
  assert.equal(normalizeName('(12)'), '(12)');
  assert.equal(normalizeName('_3'), '_3');
  assert.ok(normalizeNameDetailed('(12)').issues.includes('name-kept'));
});

/* ── 规则 1b：尾部姓名段（剥 / 不剥，都要说理由） ──────────────────────────────────────────────────────────────── */

test('trailingNameRule: 与 author 相同 → 剥（trailing-author）', () => {
  const rule = trailingNameRule('25-7-27 洛神花陈皮茶 潘兴城', '潘兴城');
  assert.deepEqual([rule.strip, rule.reason, rule.rest], [true, 'trailing-author', '25-7-27 洛神花陈皮茶']);
});

test('trailingNameRule: 百家姓开头 → 剥（trailing-name）', () => {
  const rule = trailingNameRule('负离子吹风机 方宏彬');
  assert.deepEqual([rule.strip, rule.reason], [true, 'trailing-name']);
  assert.equal(trailingNameRule('12月18日 3 茶含片(小尹) 汪学蕊').strip, true);
});

test('trailingNameRule: 分组词 / 状态词一律保留（汤色首字是姓，不许误剥）', () => {
  for (const name of ['洛神花陈皮茶 汤色', '油弃乌龙茶 外包装', '茶膏 包装', '茶汤 加冰块', '茶干 原料展示']) {
    const rule = trailingNameRule(name);
    assert.deepEqual([rule.strip, rule.reason], [false, 'keep-word'], name);
  }
});

test('trailingNameRule: 太长 / 带数字 / 没空格 / 只剩这一段 → 保留', () => {
  assert.deepEqual([trailingNameRule('茶膏三姐妹 欧阳娜娜子').strip, trailingNameRule('茶膏三姐妹 欧阳娜娜子').reason], [false, 'not-a-name']);
  assert.equal(trailingNameRule('茶膏 王鑫3').strip, false);
  assert.deepEqual([trailingNameRule('茶膏王鑫').strip, trailingNameRule('茶膏王鑫').reason], [false, 'no-space']);
  assert.deepEqual([trailingNameRule(' 王鑫').strip, trailingNameRule(' 王鑫').reason], [false, 'no-space']);
});

test('trailingNameRule: 姓名段不在名字里出现时什么都不改', () => {
  const rule = trailingNameRule('20261109-油弃乌龙茶-外包装', '郑淏月');
  assert.deepEqual([rule.strip, rule.tail], [false, '']);
});

/* ── 规则 2：splitIdentity ───────────────────────────────────────────────────────────────────────────────────── */

test('splitIdentity: md5 非空 → 内容身份是 md5', () => {
  const id = splitIdentity({ videoId: '130113153', name: '甲', md5: 'ABC123' });
  assert.deepEqual([id.contentKey, id.md5, id.mediaKey], ['md5:abc123', 'ABC123', 'asset:130113153']);
  /* 同一个 md5、不同 videoId：内容身份必须相同 */
  assert.equal(splitIdentity({ videoId: '999', name: '乙', md5: 'abc123' }).contentKey, id.contentKey);
});

test('splitIdentity: md5 为空 → 退回 videoId（名字再像也不是身份）', () => {
  const a = splitIdentity({ videoId: '1', name: '茶干', md5: '' });
  const b = splitIdentity({ videoId: '2', name: '茶干', md5: '' });
  assert.deepEqual([a.contentKey, b.contentKey], ['vid:1', 'vid:2']);
  assert.notEqual(a.contentKey, b.contentKey);
  assert.equal(a.dupGroup, null);
});

test('splitIdentity: dupGroup 只在这一批里真的重复时给出', () => {
  const rows = [
    { videoId: '1', name: '甲', md5: 'aa' },
    { videoId: '2', name: '乙', md5: 'aa' },
    { videoId: '3', name: '丙', md5: '' },
  ];
  const counts = contentCounts(rows);
  assert.equal(counts.get('md5:aa'), 2);
  assert.equal(splitIdentity(rows[0], counts).dupGroup, 'md5:aa');
  assert.equal(splitIdentity(rows[2], counts).dupGroup, null);
  /* 传对象形状的 counts 也认 */
  assert.equal(splitIdentity(rows[1], { 'md5:aa': 2 }).dupGroup, 'md5:aa');
  assert.equal(contentCounts([]).size, 0);
});

test('splitIdentity: 什么都没有的身份是空字符串，不编一个', () => {
  const id = splitIdentity({ name: '' });
  assert.deepEqual([id.mediaKey, id.contentKey, id.dupGroup], ['', '', null]);
});

/* ── 规则 3：classifyEntry ──────────────────────────────────────────────────────────────────────────────────── */

test('classifyEntry: 字幕 / 文本永不进检索', () => {
  for (const ext of SUBTITLE_EXTENSIONS) assert.equal(classifyEntry({ name: `20261109-甲${ext}` }).kind, 'subtitle', ext);
  for (const ext of TEXT_EXTENSIONS) assert.equal(classifyEntry({ name: `20261109-甲${ext}` }).kind, 'text', ext);
});

test('classifyEntry: 明确素材扩展名 → material', () => {
  for (const ext of MATERIAL_EXTENSIONS) assert.equal(classifyEntry({ name: `甲${ext}` }).kind, 'material', ext);
  /* 大小写与"不是扩展名的点" */
  assert.equal(classifyEntry({ name: '甲.MP4' }).kind, 'material');
  assert.equal(classifyEntry({ name: '素材-王鑫-3.18但哥茶膏' }).kind, 'unknown');
});

test('classifyEntry: 没有扩展名时按 videoType / 卡片字段判，证不出来就是 unknown', () => {
  assert.deepEqual(classifyEntry({ name: '甲', videoType: 1 }), { kind: 'material', evidence: 'videoType:1' });
  assert.deepEqual(classifyEntry({ name: '甲', videoType: { sourceType: 'number', source: '0' } }), { kind: 'material', evidence: 'videoType:0' });
  assert.deepEqual(classifyEntry({ name: '甲', durationMs: 4000 }), { kind: 'material', evidence: 'card' });
  assert.deepEqual(classifyEntry({ name: '甲', coverUrl: 'https://x/y.png' }), { kind: 'material', evidence: 'card' });
  assert.deepEqual(classifyEntry({ name: '甲', labels: ['茶干'] }), { kind: 'material', evidence: 'card' });
  /* 只有名字：证不出是素材 */
  assert.deepEqual(classifyEntry({ name: '13432644904276398' }), { kind: 'unknown', evidence: 'name-only' });
  /* videoType 越界不当证据 */
  assert.equal(classifyEntry({ name: '甲', videoType: 9 }).kind, 'unknown');
});

/* ── 规则 4：cleanEntry ────────────────────────────────────────────────────────────────────────────────────── */

test('cleanEntry: 规范行的形状与 issues（空 md5 + 序号 + 标签归一）', () => {
  const row = cleanEntry({
    videoId: '130113153',
    name: ' 20261109-油弃乌龙茶-外包装 （24）',
    md5: '',
    labels: ['外包装', '外包装', '茶'],
    durationMs: 4000,
    author: '郑淏月',
    coverUrl: 'https://x/1.png',
    oneLevel: '油弃乌龙茶',
    twoLevel: '外包装',
  });
  assert.equal(row.mediaKey, 'asset:130113153');
  assert.equal(row.contentKey, 'vid:130113153');
  assert.equal(row.md5, '');
  assert.equal(row.dupGroup, null);
  assert.equal(row.name, '20261109-油弃乌龙茶-外包装');
  assert.equal(row.batch, '20261109');
  assert.equal(row.product, '油弃乌龙茶');
  assert.equal(row.group, '外包装');
  assert.deepEqual(row.labels, ['外包装', '茶']);
  assert.equal(row.durationMs, 4000);
  assert.equal(row.kind, 'material');
  for (const issue of ['fullwidth', 'whitespace', 'trailing-sequence', 'no-md5', 'labels-normalized']) {
    assert.ok(row.issues.includes(issue), issue);
  }
});

test('cleanEntry: 人名列尾（按 author 认）+ 双空格 + 全角括号', () => {
  const row = cleanEntry({ videoId: '26253171', name: '12月18日 3  茶含片（小尹) 汪学蕊', author: '汪学蕊', md5: 'ff' });
  assert.equal(row.name, '12月18日 3 茶含片(小尹)');
  assert.ok(row.issues.includes('trailing-author'));
  assert.ok(row.issues.includes('fullwidth'));
  /* `（小尹)` 是全角左 + 半角右：半角化之后本来就是配对的，不该报 unbalanced-paren */
  assert.equal(row.issues.includes('unbalanced-paren'), false);
  assert.equal(row.batch, '12月18日');
  assert.equal(row.kind, 'material');
});

test('cleanEntry: 没有批次形状时 product 空着、group 只取分组词表，并记 shape issue', () => {
  const row = cleanEntry({ videoId: '77', name: '素材-王鑫-3.18但哥茶膏_2', author: '王鑫', md5: '' });
  assert.equal(row.name, '素材-王鑫-3.18但哥茶膏');
  assert.deepEqual([row.batch, row.product, row.group], ['', '', '']);
  assert.ok(row.issues.includes('sequence-only'));
  assert.ok(row.issues.includes('trailing-underline'));
  const grouped = cleanEntry({ videoId: '78', name: '茶干/原料_3', md5: 'gg' });
  assert.deepEqual([grouped.group, grouped.issues.includes('trailing-underline')], ['茶干', true]);
  const shapeless = cleanEntry({ videoId: '79', name: '油弃乌龙中医科学院联名款', md5: 'hh' });
  assert.ok(shapeless.issues.includes('no-shape'));
});

test('cleanEntry: 同 md5 的两行都记 dup-md5', () => {
  const rows = [
    { videoId: '1', name: '甲', md5: 'aa', durationMs: 1000 },
    { videoId: '2', name: '乙', md5: 'aa', durationMs: 1000 },
  ];
  const counts = contentCounts(rows);
  assert.deepEqual(cleanEntry(rows[0], counts).issues.filter((i) => i.startsWith('dup-')), ['dup-md5']);
});

test('cleanEntry: 证不出素材的行记 kind-unknown + missing-card，名字仍然保留', () => {
  const row = cleanEntry({ videoId: '5', name: '0117.素人微剧情+屈屈一根人参茶。周佳', md5: '' });
  /* 无扩展名、无 videoType、无卡片 → 只能是 unknown，但名字一个字不丢 */
  assert.equal(row.kind, 'unknown');
  assert.ok(row.issues.includes('missing-card'));
  assert.equal(row.name, '0117.素人微剧情+屈屈一根人参茶。周佳');
});

/* ── 汇总：四个数字 ────────────────────────────────────────────────────────────────────────────────────────── */

test('summarizeClean: 保留 / 丢弃 / 修复 / 去重 四个数字', () => {
  const entries = [
    { videoId: '1', name: '20261109-甲-外包装 (1)', md5: 'aa', durationMs: 1000, author: '郑淏月' }, // 保留，md5 重复
    { videoId: '2', name: '20261109-甲-外包装 (2)', md5: 'aa', durationMs: 1000, author: '郑淏月' }, // 与 1 同内容 → 去重
    { videoId: '3', name: '茶干/原料_3', md5: '', durationMs: 2000 }, // 保留，要去 `_n`
    { videoId: '4', name: '说明.txt', md5: 'cc' }, // 丢弃：文本
    { videoId: '5', name: '外包装.vtt', md5: 'dd' }, // 丢弃：字幕
    { videoId: '6', name: '只有名字', md5: '' }, // 丢弃：证不出
  ];
  const summary = summarizeClean(entries);
  assert.equal(summary.total, 6);
  assert.equal(summary.kept, 3);
  assert.equal(summary.dropped, 3);
  assert.equal(summary.byKind.material, 3);
  assert.deepEqual([summary.byKind.text, summary.byKind.subtitle, summary.byKind.unknown], [1, 1, 1]);
  assert.equal(summary.dupGroups, 1);
  assert.equal(summary.dupRows, 2);
  assert.equal(summary.dupRemoved, 1);
  /* 去重后能上云的条数：3 条 material − 1 条重复 */
  assert.equal(summary.retrievable, 2);
  /* "修复"只数名字/标签真的被改的行（全 6 行里：1、2 各 1 个序号尾巴，3 去 `_n`，4/5/6 未改） */
  assert.equal(summary.repaired, 3);
  /* 带任何 issue 的行（诊断也算） */
  assert.ok(summary.touched >= summary.repaired);
  assert.equal(summary.withMd5, 4);
  /* 五级元数据一个都不全（没有 oneLevel/twoLevel）→ 6 行全是"元数据不全"，这条数字不为 0 才是对的 */
  assert.equal(summary.missingMeta, 6);
  assert.equal(summary.completeMeta, 0);
  assert.equal(summary.missingCard, 1);
  assert.equal(summary.rows.length, 6);
});

test('summarizeClean: 去重留哪一行是确定的——有 md5、卡片多的优先', () => {
  const entries = [
    { videoId: '2', name: '乙', md5: 'aa' },
    { videoId: '1', name: '甲', md5: 'AA', durationMs: 1000, author: '郑淏月', coverUrl: 'https://x/1.png' },
  ];
  const summary = summarizeClean(entries);
  assert.equal(summary.retrievable, 1);
  /* 两次跑结果一样 */
  assert.equal(summarizeClean(entries).retrievable, 1);
  assert.equal(summarizeClean([...entries].reverse()).retrievable, 1);
});

test('summarizeClean: 传空数组不炸', () => {
  const summary = summarizeClean([]);
  assert.deepEqual([summary.total, summary.kept, summary.dropped, summary.repaired, summary.retrievable], [0, 0, 0, 0, 0]);
  assert.equal(summary.md5Rate, 0);
});

/* ── 索引摊平 ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('indexEntries: 整份 index.json 与其中的 index 都能读，顺序固定', () => {
  const index = {
    batches: [{ id: '20261109', products: [{ id: '20261109-甲', groups: [{ id: 'g', entries: [{ videoId: '1', name: 'a' }] }] }] }],
    unclassified: [{ videoId: '2', name: 'b' }],
  };
  assert.deepEqual(indexEntries({ schema: 'x', index }).map((e) => e.videoId), ['1', '2']);
  assert.deepEqual(indexEntries(index).map((e) => e.videoId), ['1', '2']);
  assert.deepEqual(indexEntries(null), []);
  assert.deepEqual(indexEntries({ index: { batches: [] } }), []);
});

/* ── 边界一：垃圾输入（同一个纯函数不许抛） ───────────────────────────────────────────────────────────────────── */

test('边界: 垃圾输入不抛，也不编造值', () => {
  for (const bad of [null, undefined, 0, 42, NaN, [], {}, Symbol('x'), () => {}]) {
    assert.equal(typeof normalizeName(bad), 'string');
    assert.equal(typeof nameTextKey(bad), 'string');
    assert.equal(typeof trailingNameRule(bad).strip, 'boolean');
    assert.equal(typeof splitIdentity(bad).contentKey, 'string');
    assert.equal(typeof classifyEntry(bad).kind, 'string');
    const row = cleanEntry(bad);
    assert.equal(typeof row.name, 'string');
    assert.equal(row.kind, 'unknown');
    assert.ok(Array.isArray(row.issues));
  }
  assert.equal(cleanEntry({ name: null }).name, '');
  assert.equal(cleanEntry({ name: 12345 }).name, '');
});

/* ── 边界二：真实名字里不许被误剥的那几个 ─────────────────────────────────────────────────────────────────── */

test('边界: 真实名字保持原样（已经干净的行不该被改）', () => {
  const clean = [
    '20261109-油弃乌龙茶-外包装',
    '20250618-2024头采新会柑普茶250g罐-包装',
    '油弃乌龙中医科学院联名款60g/盒-茶干/原料',
    'IMG_2525',
    '13432644904276398',
  ];
  for (const name of clean) {
    const out = normalizeNameDetailed(name);
    assert.equal(out.name, name, name);
    assert.deepEqual(out.issues, [], name);
  }
});

/* ── 边界三：退化 entry（没有 id、没有 md5、没有名字；超长名字） ─────────────────────────────────────────────── */

test('边界: 退化 entry 不给假身份、不截断内容', () => {
  const nothing = cleanEntry({});
  assert.deepEqual([nothing.mediaKey, nothing.contentKey, nothing.kind], ['', '', 'unknown']);
  assert.ok(nothing.issues.includes('empty-name'));

  const long = `${'茶'.repeat(300)} 潘兴城`;
  const row = cleanEntry({ videoId: '9', name: long, md5: 'aa' });
  assert.equal(row.name, '茶'.repeat(300));
  assert.equal(row.issues.includes('trailing-author'), false); // author 不在这一行里，只有百家姓证据
  assert.equal(row.issues.includes('trailing-name'), true);
});
