// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 计划物的存放：`<project>/.film/plan/<id>.json`。
 *
 * 为什么放项目里而不是 Studio 的 home：plan 是这条片子的**内容**（用哪条素材、从第几秒裁、字幕写什么），
 * 它必须跟项目一起被复制、被版本管理、被同事打开时看见。Studio 的 home 放的是"这台机器的状态"，不是内容。
 *
 * 写入用「临时文件 + rename」：中途崩掉不会留下半个 JSON —— 半个 plan 比没有 plan 更糟，
 * 因为它会被当成"已有计划"直接拿去渲染。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalisePlan } from './plan-schema.mjs';

/** 计划目录。 @param {string} project */
export const planDir = (project) => join(project, '.film', 'plan');

/** 一个 id 是否安全（防止 `../` 之类的路径穿越把文件写到项目外）。 @param {string} id */
export const safePlanId = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id) && !id.startsWith('.');

/**
 * 一个 plan 的文件路径；id 不合法就抛，不静默改写成别的名字。
 * @param {string} project @param {string} id
 */
export function planFile(project, id) {
  if (!safePlanId(id)) throw new Error(`plan id 不合法：${id}（只允许字母数字 . _ -，且不以 . 开头）`);
  return join(planDir(project), `${id}.json`);
}

/**
 * 读一个 plan；文件不存在或坏掉就是 null（调用方据此说"还没有计划"，而不是拿到半个对象）。
 * @param {string} project @param {string} id
 */
export function readPlan(project, id) {
  try {
    const raw = JSON.parse(readFileSync(planFile(project, id), 'utf8'));
    return normalisePlan(raw, { id });
  } catch {
    return null;
  }
}

/**
 * 写一个 plan（原子）：先规范，再写临时文件，再 rename。
 * @param {string} project @param {any} plan
 * @returns {{ id: string, file: string, plan: any }}
 */
export function writePlan(project, plan) {
  const normalised = normalisePlan(plan);
  const file = planFile(project, normalised.id);
  mkdirSync(planDir(project), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(normalised, null, 1)}\n`, 'utf8');
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { id: normalised.id, file, plan: normalised };
}

/**
 * 一个项目里有哪些计划（按文件名排序，坏的跳过）。
 * @param {string} project
 * @returns {{ id: string, bytes: number, modified: number }[]}
 */
export function listPlans(project) {
  const dir = planDir(project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = join(dir, name);
      try {
        const info = statSync(file);
        return { id: name.slice(0, -5), bytes: info.size, modified: info.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => b.modified - a.modified);
}

/**
 * 删一个 plan（不存在也算成功）。
 * @param {string} project @param {string} id
 */
export function deletePlan(project, id) {
  rmSync(planFile(project, id), { force: true });
}
