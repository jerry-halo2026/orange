#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 把 koc-copy 技能装到本机技能目录，并把体检模块一起带过去（装完之后不依赖仓库路径）。
//
//   node skills/koc-copy/install.mjs              # 装到 ~/.orangefilm/skills/koc-copy
//   node skills/koc-copy/install.mjs --to DIR     # 装到别处（比如另一个技能根）
//   node skills/koc-copy/install.mjs --dry-run
//
// 为什么不放进客户端首版：它是**给 operator 自己用的方法论**（价值罗盘 + 合规改写 + 场景库），
// 不是产品功能。装到"我的技能"层即可，Studio 的 agent 能看到，客户端发布包里没有它。
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

const target = value('to') || join(process.env.ORANGE_HOME || join(homedir(), '.orangefilm'), 'skills', 'koc-copy');
const dryRun = flag('dry-run');
const checker = resolve(here, '..', '..', 'packages', 'orangefilm', 'src', 'claim-check.mjs');
if (!existsSync(checker)) throw new Error(`找不到体检模块：${checker}`);

/** 递归列出要复制的东西（SKILL.md、references、examples、check.mjs）。 */
const walk = (/** @type {string} */ dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  if (name === 'install.mjs' || name === 'claim-check.mjs') return [];
  return statSync(full).isDirectory() ? walk(full).map((inner) => join(name, inner)) : [name];
});

const files = walk(here);
const plan = files.map((rel) => ({ from: join(here, rel), to: join(target, rel) }));
plan.push({ from: checker, to: join(target, 'claim-check.mjs') });

console.log(`安装到 ${target}：${plan.length} 个文件${dryRun ? '（dry-run，不写）' : ''}`);
for (const item of plan) console.log(`  ${item.from.replace(here, '.')} → ${item.to.replace(target, '.')}`);
if (!dryRun) {
  for (const item of plan) {
    mkdirSync(dirname(item.to), { recursive: true });
    copyFileSync(item.from, item.to);
  }
  console.log(`\n完成。用法：\n  node "${join(target, 'check.mjs')}" --mode draft "你的文案"`);
  console.log('Studio → 技能 里应该能看到 koc-copy（它在"我的技能"层，不进客户端发布包）。');
}
