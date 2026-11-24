#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 把 KOC 文案技能装到本机技能目录，并把依赖模块一起带过去（装完之后不依赖仓库路径）。
//
//   node skills/koc-writer/install.mjs                  # 通用层 → ~/.orangefilm/skills/koc-writer
//   node skills/koc-writer/install.mjs --layer tea      # 只装茶饮层
//   node skills/koc-writer/install.mjs --layer both     # 两层一起（各自一个目录）
//   node skills/koc-writer/install.mjs --to DIR         # 装到别处
//   node skills/koc-writer/install.mjs --dry-run
//
// 为什么不放进客户端首版：它是给 operator 自己用的方法论（写法 + 合规改写 + 品类红线），
// 不是产品功能。装到"我的技能"层即可，Studio 的 agent 能看到，客户端发布包里没有它。
//
// 两层为什么分开：通用层（koc-writer）与品类无关，换个品类只换品类层（如 koc-tea），
// 写法与检查器不动。旧入口 koc-copy 仍然可用，等价于 --layer both。
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (/** @type {string} */ name) => argv.includes(`--${name}`);
const value = (/** @type {string} */ name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? '' : argv[at + 1] ?? '';
};

/* 技能根：本文件在 skills/koc-writer/，所以上一级就是 skills/ */
const skillsRoot = resolve(here, '..');
const layer = (value('layer') || 'writer').toLowerCase();
if (!['writer', 'tea', 'both'].includes(layer)) {
  console.error(`--layer 只能是 writer / tea / both（收到：${layer}）`);
  process.exit(2);
}
const wanted = layer === 'both' ? ['koc-writer', 'koc-tea'] : [layer === 'tea' ? 'koc-tea' : 'koc-writer'];

const skillsHome = process.env.ORANGE_HOME || join(homedir(), '.orangefilm');
const baseTarget = value('to') || join(skillsHome, 'skills');
const dryRun = flag('dry-run');

const deps = {
  'claim-check.mjs': resolve(here, '..', '..', 'packages', 'orangefilm', 'src', 'claim-check.mjs'),
  'copy-rewrite.mjs': resolve(here, '..', '..', 'packages', 'orangefilm', 'src', 'copy-rewrite.mjs'),
};
for (const [name, file] of Object.entries(deps)) {
  if (!existsSync(file)) throw new Error(`找不到依赖模块 ${name}：${file}`);
}

/** 递归列出要复制的东西（SKILL.md、references、examples、check.mjs）。 */
const walk = (/** @type {string} */ dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  if (name === 'install.mjs' || name === 'claim-check.mjs' || name === 'copy-rewrite.mjs') return [];
  return statSync(full).isDirectory() ? walk(full).map((inner) => join(name, inner)) : [name];
});

/** @type {{ from: string, to: string }[]} */
const plan = [];
for (const skill of wanted) {
  const source = join(skillsRoot, skill);
  if (!existsSync(source)) throw new Error(`找不到技能目录：${source}`);
  const target = value('to') ? join(baseTarget, skill) : join(baseTarget, skill);
  for (const rel of walk(source)) plan.push({ from: join(source, rel), to: join(target, rel) });
  /* 依赖按技能各带一份：装完之后互不依赖仓库，也互不依赖对方目录 */
  for (const [name, file] of Object.entries(deps)) plan.push({ from: file, to: join(target, name) });
}

console.log(`安装 ${wanted.join(' + ')} 到 ${baseTarget}：${plan.length} 个文件${dryRun ? '（dry-run，不写）' : ''}`);
for (const item of plan) console.log(`  ${item.from.replace(skillsRoot, '.')} → ${item.to.replace(baseTarget, '.')}`);
if (!dryRun) {
  for (const item of plan) {
    mkdirSync(dirname(item.to), { recursive: true });
    copyFileSync(item.from, item.to);
  }
  const entry = wanted.includes('koc-writer') ? 'koc-writer' : 'koc-tea';
  console.log(`\n完成。用法：`);
  console.log(`  node "${join(baseTarget, entry, 'check.mjs')}" --mode draft --rewrite "你的文案"`);
  console.log('Studio → 技能 里应该能看到（它们在"我的技能"层，不进客户端发布包）。');
}
