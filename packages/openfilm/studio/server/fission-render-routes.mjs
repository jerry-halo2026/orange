// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 批量出片的 HTTP 面：人和 agent 之外的第三条入口 —— **界面**。
 *
 * 与 MCP 的 `plan.render` 走同一个批次注册表（`fission-batch-jobs.mjs`），所以：
 * 界面里看到的进度，就是 agent 那份；关掉窗口再回来还在。
 *
 * # 为什么工程用 id 而不是路径
 *
 * 页面永远不传文件系统路径（那是攻击面），只传工程 id，由服务端解析成它自己认的那个目录。
 * 这条规矩和 `fission-local-routes.mjs` 一致：路径只从服务端来。
 *
 * # 四个动作
 *
 *   GET  /api/fission-render/state?project=<id>      列计划 + 最近批次（页面首屏就靠它）
 *   POST /api/fission-render/start                   { project, planIds?, concurrency? }
 *   GET  /api/fission-render/status?project=<id>&batchId=<id>
 *   POST /api/fission-render/retry                   { project, batchId }
 */
import { HttpError, json, readJson } from './http.mjs';

/** @param {unknown} value */
const isId = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value);

/**
 * @param {{
 *   projectById: (id: string) => Promise<any>,
 *   plansOf: (project: string) => { id: string }[],
 *   readPlanFile: (project: string, id: string) => any,
 *   checkPlans: (project: string) => { verdict: string, canRender: boolean, duplicates: any[], risky: any[], pairs: number },
 *   expandPlanset: (options: { project: string, planset: any, candidates: any[], targetSec?: number }) => { made: any[], verdict: string },
 *   resolveEnginePaths: (options: { dataDir: string, project: string }) => { ok: boolean, paths: Record<string, string>, problems: string[] },
 *   startBatch: (options: any) => { batch: any },
 *   retryBatch: (options: any) => { batch: any, retried: number },
 *   readBatch: (project: string, batchId: string) => any,
 *   listBatches: (project: string) => any[],
 *   progress: (batch: any) => string,
 *   auth?: any,
 *   dataDir?: string,
 * }} deps
 */
export function createRenderBatchRoutes(deps) {
  const {
    projectById, plansOf, readPlanFile, resolveEnginePaths,
    startBatch, retryBatch, readBatch, listBatches, progress, auth, dataDir = '',
    checkPlans, expandPlanset,
  } = deps;

  const owner = () => {
    if (!auth || typeof auth.assertActive !== 'function') throw new HttpError(403, 'Sign in is required.', { code: 'authentication-required' });
    try { return auth.assertActive(); } catch { throw new HttpError(403, 'Sign in is required.', { code: 'authentication-required' }); }
  };

  /** 工程 id → 可信目录；不存在就 404，不猜。 @param {string} id */
  const root = async (id) => {
    const project = await projectById(id);
    if (!project?.path) throw new HttpError(404, 'No such project.', { code: 'project-required' });
    return project.path;
  };

  /** 页面要的条目形状：计划本身 + 最近一批的结果。 @param {string} project */
  const entriesOf = (project) => plansOf(project).map((entry) => {
    const plan = readPlanFile(project, entry.id);
    const speech = plan?.segments?.filter((segment) => segment.kind === 'speech') ?? [];
    return {
      planId: entry.id,
      copyPreview: speech[0]?.text ?? '',
      totalSec: Number((plan?.shots ?? []).reduce((sum, shot) => sum + Number(shot.shownSec ?? 0), 0).toFixed(2)),
      shotCount: plan?.shots?.length ?? 0,
      blocking: plan?.compliance?.blocking ?? 0,
      canFilm: (plan?.compliance?.blocking ?? 0) === 0,
      voiceId: speech[0]?.voice?.voice ?? speech[0]?.voice?.provider ?? '',
      bgm: plan?.bgm?.id ?? null,
    };
  });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string[]} parts
   */
  return async (req, res, parts) => {
    if (parts[0] !== 'fission-render') return false;
    owner();
    try {
      if (parts.length === 2 && parts[1] === 'state' && req.method === 'GET') {
        const url = new URL(String(req.url ?? ''), 'http://127.0.0.1');
        const id = url.searchParams.get('project') ?? '';
        if (!isId(id)) throw new HttpError(400, 'A project id is required.', { code: 'project-required' });
        const project = await root(id);
        json(res, 200, {
          project: id,
          entries: entriesOf(project),
          batches: listBatches(project).slice(0, 10),
        });
        return true;
      }

      if (parts.length === 2 && parts[1] === 'status' && req.method === 'GET') {
        const url = new URL(String(req.url ?? ''), 'http://127.0.0.1');
        const id = url.searchParams.get('project') ?? '';
        const batchId = url.searchParams.get('batchId') ?? '';
        if (!isId(id) || !isId(batchId)) throw new HttpError(400, 'A batch id is required.', { code: 'batch-required' });
        const project = await root(id);
        const batch = readBatch(project, batchId);
        if (!batch) throw new HttpError(404, 'No such batch.', { code: 'batch-not-found' });
        json(res, 200, { batch, progress: progress(batch) });
        return true;
      }

      if (parts.length === 2 && parts[1] === 'start' && req.method === 'POST') {
        const body = await readJson(req, 64 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');
        const id = String(/** @type {any} */ (body).project ?? '');
        if (!isId(id)) throw new HttpError(400, 'A project id is required.', { code: 'project-required' });
        const project = await root(id);
        const engine = resolveEnginePaths({ dataDir: dataDir || project, project });
        if (!engine.ok) {
          json(res, 503, { ok: false, code: 'engine-paths', message: `渲染器还差配置：${engine.problems.slice(0, 2).join('；')}`, problems: engine.problems });
          return true;
        }
        const wanted = Array.isArray(/** @type {any} */ (body).planIds) ? /** @type {any} */ (body).planIds.map(String) : plansOf(project).map((entry) => entry.id);
        const plans = wanted.map((planId) => readPlanFile(project, planId)).filter(Boolean);
        if (!plans.length) throw new HttpError(400, 'This project has no plans yet.', { code: 'no-plans' });
        const concurrency = Math.min(4, Math.max(1, Math.trunc(Number(/** @type {any} */ (body).concurrency ?? 2))));
        const { batch } = startBatch({
          project, plans, enginePaths: engine.paths,
          assetsRoot: engine.paths.AssetsRoot, workRoot: engine.paths.WorkRoot, concurrency,
        });
        json(res, 202, { ok: true, batchId: batch.id, batch, progress: progress(batch) });
        return true;
      }

      if (parts.length === 2 && parts[1] === 'retry' && req.method === 'POST') {
        const body = await readJson(req, 64 * 1024);
        const id = String(/** @type {any} */ (body)?.project ?? '');
        const batchId = String(/** @type {any} */ (body)?.batchId ?? '');
        if (!isId(id) || !isId(batchId)) throw new HttpError(400, 'A batch id is required.', { code: 'batch-required' });
        const project = await root(id);
        const engine = resolveEnginePaths({ dataDir: dataDir || project, project });
        if (!engine.ok) throw new HttpError(503, `渲染器还差配置：${engine.problems.slice(0, 2).join('；')}`, { code: 'engine-paths' });
        const plans = plansOf(project).map((entry) => readPlanFile(project, entry.id)).filter(Boolean);
        const retried = retryBatch({
          project, batchId, plans, enginePaths: engine.paths,
          assetsRoot: engine.paths.AssetsRoot, workRoot: engine.paths.WorkRoot,
        });
        json(res, 202, { ok: true, batchId: retried.batch.id, retried: retried.retried, batch: retried.batch, progress: progress(retried.batch) });
        return true;
      }

      if (parts.length === 2 && parts[1] === 'dedupe' && req.method === 'GET') {
        const url = new URL(String(req.url ?? ''), 'http://127.0.0.1');
        const id = url.searchParams.get('project') ?? '';
        if (!isId(id)) throw new HttpError(400, 'A project id is required.', { code: 'project-required' });
        const project = await root(id);
        const report = checkPlans(project);
        json(res, 200, { project: id, ...report });
        return true;
      }

      if (parts.length === 2 && parts[1] === 'expand' && req.method === 'POST') {
        const body = await readJson(req, 256 * 1024);
        const id = String(/** @type {any} */ (body)?.project ?? '');
        if (!isId(id)) throw new HttpError(400, 'A project id is required.', { code: 'project-required' });
        const project = await root(id);
        const planset = /** @type {any} */ (body)?.planset;
        const candidates = /** @type {any} */ (body)?.candidates;
        if (!planset || typeof planset !== 'object') throw new HttpError(400, 'A planset is required.', { code: 'planset-required' });
        if (!Array.isArray(candidates) || !candidates.length) throw new HttpError(400, 'Candidates are required.', { code: 'candidates-required' });
        const made = expandPlanset({ project, planset, candidates, targetSec: /** @type {any} */ (body)?.targetSec });
        json(res, 201, { project: id, ...made, dedupe: checkPlans(project) });
        return true;
      }

      throw new HttpError(404, 'Unknown render route.', { code: 'not-found' });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, String(/** @type {any} */ (error)?.message ?? error) || 'Render request failed.', { code: 'render-failed' });
    }
  };
}
