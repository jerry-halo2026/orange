// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 把批量出片的**依赖**接到路由上：谁来解析工程、谁读计划、谁算引擎路径、谁跑批次。
 *
 * 这一层存在的理由只有一个：`fission-render-routes.mjs` 自己不 import 任何仓库模块，
 * 于是它可以用假依赖单测（不起 Studio、不跑 dotnet），而真实接线只在这一处。
 */
import { projectById, listProjects } from './projects.mjs';
import { listPlans, readPlan, writePlan } from '../../src/plan-store.mjs';
import { resolveEnginePaths, resolveEnginePathsFromConfig } from './fission-engine-paths.mjs';
import { batchProgress, listBatches, readBatch, retryBatch, startBatch } from './fission-batch-jobs.mjs';
import { studioHomeDir } from '../../src/locations.mjs';
import { expandPlans, variantToBrief } from '../../src/planset.mjs';
import { createPlanFromBrief, paceToTarget } from '../../src/plan-tools.mjs';
import { planSimilarity } from '../../src/dedupe-check.mjs';

/** 计划里参与自查的那几项（不同调用方给的形状不一样，这里统一成自查器认的那份）。 */
const planForCheck = (/** @type {any} */ plan) => ({
  id: plan.id,
  lines: (plan.segments ?? []).filter((/** @type {any} */ segment) => segment.kind === 'speech').map((/** @type {any} */ segment) => segment.text),
  shots: plan.shots ?? [],
  voices: (plan.segments ?? []).filter((/** @type {any} */ segment) => segment.kind === 'speech').map((/** @type {any} */ segment) => segment.voice?.file ?? null),
  bgm: plan.bgm?.id ?? null,
  spec: plan.spec,
});

/**
 * 渲染前自查：把工程里的计划两两比一遍（文本 / 节奏 / 画面 / 配音 / 首帧）。
 * @param {string} project
 */
export function checkPlans(project) {
  const plans = listPlans(project).map((entry) => readPlan(project, entry.id)).filter(Boolean);
  return planSimilarity(plans.map(planForCheck));
}

/**
 * planset 展开：界面上的"一句话 → N 条"。
 * @param {{ project: string, planset: any, candidates: any[], targetSec?: number }} options
 */
export function expandPlanset({ project, planset, candidates, targetSec }) {
  const { variants, report } = expandPlans(planset);
  /** @type {any[]} */
  const made = [];
  for (const variant of variants) {
    const brief = variantToBrief(variant, { candidates, spec: { ...(targetSec ? { targetSec } : {}) } });
    const built = createPlanFromBrief(brief);
    const paced = paceToTarget(built.plan);
    const written = writePlan(project, paced.plan);
    made.push({
      planId: written.id,
      copyId: variant.copyId,
      voiceId: variant.voiceId,
      bgm: variant.bgm,
      totalSec: Number((written.plan.shots ?? []).reduce((sum, shot) => sum + Number(shot.shownSec ?? 0), 0).toFixed(2)),
      blocking: written.plan.compliance?.blocking ?? 0,
    });
  }
  return {
    made,
    expand: report,
    verdict: `${made.length} 条已生成（可发 ${made.filter((entry) => entry.blocking === 0).length} 条）`,
  };
}

/**
 * 计划侧：读工程里有哪些计划、以及一份计划的内容。
 * @param {string} project
 */
export function createPlanStoreBridge(project) {
  return {
    plansOf: (root) => listPlans(root ?? project).map((entry) => ({ id: entry.id })),
    readPlanFile: (root, id) => readPlan(root ?? project, id),
  };
}

/**
 * 路由要的全部依赖。
 *
 * 工程读取必须跑在桌面的 native 授权上下文里（`desktopAuth.runNative`）：`projects.mjs` 的
 * `projectById/listProjects` 在没有授权上下文时抛 `control-required`，而这里的 catch 会把它吞成
 * “没有这个工程”，于是 `/api/fission-render/*` 在安装后的应用里永远是 404（批量出片页也永远空）。
 *
 * @param {{ auth?: any, home?: () => string, dataDir?: string, projects?: { projectById: Function, listProjects: Function } }} [options]
 */
export function createRenderBatchBridge({
  auth = null, home = studioHomeDir, dataDir = '',
  projects = { projectById, listProjects },
} = {}) {
  /** 在授权上下文里跑；没有 runNative（单测/无桌面宿主）时原样执行。 */
  const native = (/** @type {() => Promise<any>} */ work) =>
    typeof auth?.runNative === 'function' ? auth.runNative(work) : work();
  return {
    auth,
    dataDir: dataDir || process.env.ORANGE_DATA_DIR || '',
    projectById: async (/** @type {string} */ id) => {
      /* 依次尝试：按 id 取（Studio 自己的项目库）→ 直接当成目录（桌面端把工程目录传进来时的形态） */
      try {
        const found = await native(() => projects.projectById(id));
        if (found?.path) return found;
      } catch { /* 落到下面 */ }
      try {
        const all = await native(() => projects.listProjects());
        const hit = all?.find((entry) => entry?.id === id || entry?.name === id);
        if (hit?.path) return hit;
      } catch { /* 落到下面 */ }
      return null;
    },
    plansOf: (/** @type {string} */ project) => listPlans(project).map((entry) => ({ id: entry.id })),
    readPlanFile: (/** @type {string} */ project, /** @type {string} */ id) => readPlan(project, id),
    /* 安装后的应用把随包的 ffmpeg/fission 路径写在 `ORANGE_FISSION_CONFIG_FILE` 指向的配置里：
       先用它，缺了再退回 `<dataDir>/runtime/ffmpeg-<ver>` 的推导（开发检出）。 */
    resolveEnginePaths: (/** @type {{ dataDir: string, project: string }} */ options) =>
      resolveEnginePathsFromConfig({ project: options.project })
      ?? resolveEnginePaths({ dataDir: options.dataDir || home(), project: options.project }),
    checkPlans,
    expandPlanset,
    startBatch,
    retryBatch,
    readBatch,
    listBatches,
    progress: batchProgress,
  };
}
