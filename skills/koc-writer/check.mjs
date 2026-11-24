#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// KOC 文案体检：draft（只标注）与 publish（阻断）两档，外加场景标签与改写方向。
//
//   node check.mjs --mode draft "喝了一个月，裤腰就松了"
//   node check.mjs --mode publish --text "小青柑，三年陈，一颗一泡"
//   node check.mjs --file script.txt            # 一行一句，逐行体检
//   echo "文案" | node check.mjs
//
// 这个文件在仓库里时直接用仓库的 `claim-check.mjs`；装到 `~/.orangefilm/skills/koc-copy/` 之后
// 用安装时复制到本目录的 `claim-check.mjs`（install.mjs 会做这件事），所以两种情况都能跑。
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 依次找体检模块：本目录（安装后的副本）→ 仓库 `packages/orangefilm/src/`。 */
async function loadChecker() {
  const candidates = [
    join(here, 'claim-check.mjs'),
    join(here, '..', '..', 'packages', 'orangefilm', 'src', 'claim-check.mjs'),
  ];
  for (const file of candidates) {
    if (existsSync(file)) return import(pathToFileURL(file).href);
  }
  throw new Error('找不到 claim-check.mjs：请把本技能整个目录复制走（或在本仓库内运行），或先跑 install.mjs');
}

const argv = process.argv.slice(2);
const arg = (/** @type {string} */ name) => {
  const at = argv.indexOf(`--${name}`);
  if (at !== -1) return argv[at + 1] ?? '';
  const eq = argv.find((item) => item.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : '';
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node check.mjs [--mode draft|publish] [--text 文案] [--file 文案.txt] [--json] [--rewrite] [--scene 场景] [--detail 细节]');
  console.log('  --rewrite  命中之后给出三式候选句（并列 / 转述 / 场景），并检查是否保留锚点');
  process.exit(0);
}

const mode = arg('mode') === 'draft' ? 'draft' : 'publish';
const asJson = argv.includes('--json');
const fromFile = arg('file');

/** 待体检的行：`--file`（一行一句）→ `--text` → 位置参数 → stdin。 */
async function readLines() {
  if (fromFile) {
    const { readFileSync } = await import('node:fs');
    return readFileSync(fromFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  }
  const text = arg('text');
  if (text) return [text];
  const positional = argv.filter((item, index) => !item.startsWith('--') && !(index > 0 && argv[index - 1]?.startsWith('--')));
  if (positional.length) return [positional.join(' ')];
  /** @type {string} */
  let stdin = '';
  try {
    for await (const chunk of process.stdin) stdin += chunk;
  } catch { /* 没有 stdin */ }
  return stdin.split('\n').map((line) => line.trim()).filter(Boolean);
}

const { checkClaims, sceneTags } = await loadChecker();
const wantRewrite = argv.includes('--rewrite');
const sceneArg = arg('scene');
const detailArg = arg('detail');

/** 依次找改写模块：安装后的副本 → 仓库 packages/orangefilm/src/。 */
async function loadRewrite() {
  const candidates = [join(here, 'copy-rewrite.mjs'), join(here, '..', '..', 'packages', 'orangefilm', 'src', 'copy-rewrite.mjs')];
  for (const file of candidates) {
    if (existsSync(file)) return import(pathToFileURL(file).href);
  }
  return null;
}
const rewriter = wantRewrite ? await loadRewrite() : null;
const lines = await readLines();
if (!lines.length) {
  console.error('没有要体检的文案：给 --text / --file / 位置参数，或者把文案从 stdin 传进来');
  process.exit(2);
}

/** @type {any[]} */
const results = [];
for (const line of lines) {
  const result = checkClaims(line, { mode });
  /** 命中才需要改写建议；没命中就不打扰 */
  const rewrite = rewriter && result.hits.length
    ? (() => {
      const candidates = rewriter.rewriteSuggestions(line, result.hits.map((hit) => ({ category: hit.category })), {
        ...(sceneArg ? { scene: sceneArg } : {}),
        ...(detailArg ? { detail: detailArg } : {}),
      });
      return { candidates, verdict: rewriter.rewriteVerdict(candidates) };
    })()
    : null;
  results.push({ text: line, ...result, scenes: sceneTags(line), ...(rewrite ? { rewrite } : {}) });
}

if (asJson) {
  console.log(JSON.stringify({ mode, results }, null, 2));
  process.exit(mode === 'publish' && results.some((r) => !r.ok) ? 1 : 0);
}

const level = { block: '⛔', warn: '⚠️ ', hint: '· ' };
for (const result of results) {
  const verdict = result.ok ? (result.needsRewrite ? '可发（待改）' : '可发') : '不可发';
  console.log(`\n【${mode}】${verdict}  「${result.text}」`);
  if (result.scenes.length) console.log(`  场景：${result.scenes.join('、')}`);
  if (!result.hits.length) { console.log('  无命中'); continue; }
  for (const hit of result.hits) {
    console.log(`  ${level[hit.severity] ?? ''} ${hit.category}（${hit.match}）`);
    console.log(`     ${hit.context}`);
    console.log(`     平台原因：${hit.why}`);
    console.log(`     改法：${hit.rewrite}`);
  }
  if (result.rewrite) {
    console.log(`  改写候选（${result.rewrite.verdict}）：`);
    for (const candidate of result.rewrite.candidates) {
      console.log(`    ${candidate.keepsAnchor ? '✅' : '⚠️ '} ${candidate.label}：${candidate.text}`);
    }
  }
}
const blocking = results.reduce((sum, r) => sum + (r.blocking ?? 0), 0);
const warns = results.reduce((sum, r) => sum + r.hits.filter((/** @type {any} */ h) => h.severity === 'warn').length, 0);
console.log(`\n合计 ${results.length} 句：block ${blocking} · warn ${warns} · ${mode === 'publish' ? (blocking ? '不许发' : '可发') : '草稿（只标注）'}`);
process.exit(mode === 'publish' && blocking > 0 ? 1 : 0);
