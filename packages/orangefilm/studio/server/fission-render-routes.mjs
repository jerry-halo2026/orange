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
 *   POST /api/fission-render/recipe                  { project, recipe, voices?, run?, batchId? }
 *
 * `recipe` 是画布混剪那条路（`fission-recipe.mjs` → `fission-runner.mjs`）：默认 dry-run，只摆目录、算 job、
 * 把逐项问题回给面板；`run: true` 才真的跑一次引擎。渲染失败也是一种结果（`ok: false` + 结构化摘要），
 * 不当成 500 抛出去 —— 面板要能显示"哪一条、为什么"。
 */
import { join, isAbsolute } from 'node:path';
import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs';

import { HttpError, json, readJson } from './http.mjs';
import { normalizeRecipe, prepareRecipeRun } from './fission-recipe.mjs';
import { transcribeVoice } from './voice-transcribe.mjs';
import { freshAttempt, runFissionJob } from './fission-runner.mjs';

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
 *   runJob?: (options: any) => Promise<any>,
 *   newAttempt?: (label?: string) => string,
 *   auth?: any,
 *   dataDir?: string,
 * }} deps
 */
export function createRenderBatchRoutes(deps) {
  const {
    projectById, plansOf, readPlanFile, resolveEnginePaths,
    startBatch, retryBatch, readBatch, listBatches, progress, auth, dataDir = '',
    checkPlans, expandPlanset,
    /* 真跑引擎的那一步：默认就是 `fission-runner.mjs`；测试注入假实现，绝不碰 dotnet。 */
    runJob = runFissionJob,
    newAttempt = freshAttempt,
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
        const engine = resolveEnginePaths({ dataDir: dataDir || '', project });
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
        const engine = resolveEnginePaths({ dataDir: dataDir || '', project });
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

      /* 素材目录扫描：一级子目录=场景组，给面板显示组名与视频/图片数（不改任何文件）。 */
    if (parts.length === 2 && parts[1] === 'scan-folder' && req.method === 'POST') {
      owner();
      const body = /** @type {{ path?: unknown }} */ (await readJson(req) ?? {});
      const at = typeof body.path === 'string' ? body.path.trim() : '';
      if (!at || !isAbsolute(at) || !existsSync(at) || !statSync(at).isDirectory()) {
        throw new HttpError(422, 'A folder path is required.', { code: 'invalid-query' });
      }
      const video = /\.(mp4|mov|m4v|mkv|avi|webm|flv|wmv)$/i;
      const image = /\.(jpe?g|png|webp|gif|bmp)$/i;
      const groups = [];
      let rootFiles = 0;
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const path = join(at, entry.name);
        if (entry.isDirectory()) {
          let videos = 0; let images = 0;
          for (const file of readdirSync(path, { withFileTypes: true })) {
            if (!file.isFile()) continue;
            if (video.test(file.name)) videos += 1;
            else if (image.test(file.name)) images += 1;
          }
          groups.push({ name: entry.name, videos, images });
        } else if (entry.isFile() && (video.test(entry.name) || image.test(entry.name))) rootFiles += 1;
      }
      groups.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      return json(res, 200, { ok: true, path: at, groups, rootFiles });
    }

    if (parts.length === 2 && parts[1] === 'recipe' && req.method === 'POST') {
        const body = await readJson(req, 256 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');
        const payload = /** @type {any} */ (body);
        const id = String(payload.project ?? '');
        if (!isId(id)) throw new HttpError(400, 'A project id is required.', { code: 'project-required' });
        const project = await root(id);
        /* batchId 会逐字成为目录名：只收 `stageRecipe` 认的那套字符，给了不合规的就直说，不悄悄改 */
        if (payload.batchId !== undefined && !/^[a-z0-9-]{1,40}$/.test(String(payload.batchId))) {
          throw new HttpError(400, 'A batch id is lowercase letters, digits and hyphens (at most 40).', { code: 'batch-invalid' });
        }
        const batchId = payload.batchId === undefined ? newAttempt('mix') : String(payload.batchId);
        /* 粗预览：1 条、前 5 秒、单线程；不改变正式配方。 */
        const preview = payload.preview === true;
        const askedRecipe = preview && payload.recipe && typeof payload.recipe === 'object'
          ? { ...payload.recipe, params: { ...(payload.recipe.params ?? {}), count: 1, targetSec: 5, threads: 1, preview: true } }
          : payload.recipe;
        const normalized = normalizeRecipe(askedRecipe);
        if (!normalized.recipe) {
          json(res, 400, { ok: false, code: 'recipe-invalid', problems: normalized.problems, notes: [], job: null, staged: null });
          return true;
        }
        const voices = (Array.isArray(payload.voices) ? payload.voices : [])
          .filter((/** @type {any} */ voice) => voice && typeof voice.file === 'string' && voice.file)
          .map((/** @type {any} */ voice) => ({ file: isAbsolute(String(voice.file)) ? String(voice.file) : join(project, String(voice.file)), text: String(voice.text ?? ''), cues: Array.isArray(voice.cues) ? voice.cues : [] }));
        /* 配音放在 recipe.voiceFiles 里时（画布上传），同样送进 staging。 */
        if (!voices.length && Array.isArray(normalized.recipe.voiceFiles)) {
          for (const row of normalized.recipe.voiceFiles) {
            const file = isAbsolute(row.path) ? row.path : join(project, row.path);
            voices.push({ file, text: String(row.text ?? ''), cues: Array.isArray(row.cues) ? row.cues : [] });
          }
        }

        const engine = resolveEnginePaths({ dataDir: dataDir || '', project });
        /* 上传的配音没有文案/时间戳时，用本地 Whisper 生成逐句时间戳，字幕不再按句长猜。 */
        if (engine.paths?.FFmpeg) {
          for (const voice of voices) {
            if (voice.cues?.length || String(voice.text ?? '').trim()) continue;
            try {
              const heard = await transcribeVoice(voice.file, engine.paths.FFmpeg);
              voice.text = heard.text;
              voice.cues = heard.cues;
            } catch { /* 识别失败就不带字幕，不阻断出片 */ }
          }
        }
        const workRoot = engine.paths?.WorkRoot || join(project, '.film', 'fission', 'work');
        /** @type {{ staged: any, job: any, problems: string[], notes: string[] }} */
        let prepared;
        try {
          prepared = prepareRecipeRun({ recipe: normalized.recipe, project, workRoot, batchId, voices });
        } catch (error) {
          /* 摆目录只会在输入本身不合规时抛（batchId / 路径策略）：当成逐项问题回，不变成 500 */
          json(res, 400, {
            ok: false, code: 'recipe-invalid', notes: [], job: null, staged: null,
            problems: [...normalized.problems, String(/** @type {any} */ (error)?.message ?? error)],
          });
          return true;
        }
        const problems = [...normalized.problems, ...prepared.problems];
        if (!engine.ok) problems.push(...engine.problems.map((line) => `engine-paths: ${line}`));
        const summary = {
          batchId,
          problems,
          notes: prepared.notes,
          job: prepared.job,
          staged: {
            videoDir: prepared.staged.videoDir,
            audioDir: prepared.staged.audioDir,
            meta: { file: join(prepared.staged.root, 'meta.json'), items: prepared.staged.items },
          },
        };

        /* 默认 dry-run：目录摆了、job 算了、进程没起。面板先看这个再决定要不要真跑。 */
        if (payload.run !== true) {
          json(res, 200, { ok: problems.length === 0, ...summary });
          return true;
        }

        if (!engine.ok) {
          json(res, 503, {
            ok: false, code: 'engine-paths', ...summary,
            message: `渲染器还差配置：${engine.problems.slice(0, 2).join('；')}`,
          });
          return true;
        }

        const attempt = newAttempt(batchId);
        /* 每次渲染一个全新的 attempt（引擎要求 work/out/cache 全空），放工程的 `.film/fission/run/` 下 */
        const runRoot = join(project, '.film', 'fission', 'run');
        /** @type {any} */
        let result;
        try {
          result = await runJob({ job: prepared.job, enginePaths: engine.paths, root: runRoot, task: 't1', attempt });
        } catch (error) {
          /* 前置检查（attempt-not-fresh / engine-paths / identity）也是结果：结构化回，不 500 */
          result = {
            attempt, code: -1, timedOut: false, outDir: null, stdout: '', stderr: '', report: null,
            errorCode: /** @type {any} */ (error)?.code ?? null,
            message: String(/** @type {any} */ (error)?.message ?? error),
          };
        }
        const rendered = result.code === 0 && Number(result.report?.succeeded ?? 0) > 0;
        const report = result.report;
        /* 预览片复制进工程 assets/previews，页面用普通媒体地址播放。 */
        let previewPath = null;
        const firstPath = report?.outputs?.[0]?.path ?? report?.outputs?.[0]?.Path;
        if (preview && rendered && firstPath && existsSync(firstPath)) {
          const into = join(project, 'assets', 'previews');
          mkdirSync(into, { recursive: true });
          const name = `preview-${batchId}.mp4`;
          copyFileSync(firstPath, join(into, name));
          previewPath = `assets/previews/${name}`;
        }
        json(res, 200, {
          ok: rendered && problems.length === 0,
          ...summary,
          ...(previewPath ? { previewPath } : {}),
          render: {
            attempt: result.attempt ?? attempt,
            code: result.code,
            timedOut: result.timedOut === true,
            outDir: result.outDir ?? null,
            message: result.message,
            ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            report: report ? {
              jobDir: report.jobDir,
              succeeded: report.succeeded,
              failed: report.failed,
              stopReason: report.stopReason,
              outputs: report.outputs,
              failures: report.failures,
            } : null,
          },
        });
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
