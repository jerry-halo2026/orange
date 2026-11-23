// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 批量出片的 HTTP 面：工程用 id 解析、页面不传路径、失败说人话。用假依赖跑，不起 Studio。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRenderBatchRoutes } from './fission-render-routes.mjs';

function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'render-routes-'));
  mkdirSync(join(project, '.film', 'plan'), { recursive: true });
  const plan = (id, text) => writeFileSync(join(project, '.film', 'plan', `${id}.json`), JSON.stringify({
    schema: 'orange/plan/1', id,
    segments: [{ id: 'S1', kind: 'speech', text, audioSec: 2, estimated: false, voice: { file: '', provider: 'qwen', voice: 'Cherry' } }],
    shots: [{ segmentId: 'S1', mediaId: 'm1', startSec: 0, endSec: 2.1, speed: 1, shownSec: 2.1 }],
    compliance: { mode: 'publish', blocking: 0 },
    bgm: { id: 'bgmA', volume: 0.3, startSec: 0 },
  }, null, 1));
  plan('p1', '开箱那一下');
  plan('p2', '过完年饭局多');

  const batches = new Map();
  return {
    project,
    deps: {
      auth: { assertActive: () => ({ owner: 'test' }) },
      dataDir: project,
      projectById: async (id) => (id === 'proj-1' ? { id, path: project } : null),
      plansOf: () => [{ id: 'p1' }, { id: 'p2' }],
      /* 真读盘上那份计划：路由只关心形状，不关心内容 */
      readPlanFile: (root, id) => JSON.parse(readFileSync(join(root, '.film', 'plan', id + '.json'), 'utf8')),
      resolveEnginePaths: () => ({ ok: true, paths: { AssetsRoot: join(project, 'assets'), WorkRoot: join(project, 'work') }, problems: [] }),
      startBatch: ({ plans, concurrency }) => {
        const batch = { id: 'b1', state: 'running', done: 0, total: plans.length, ok: 0, failed: 0, concurrency, plans: plans.map((plan) => plan.id) };
        batches.set('b1', batch);
        return { batch };
      },
      retryBatch: () => ({ batch: { id: 'b1-retry', state: 'running', done: 0, total: 1, ok: 0, failed: 0 }, retried: 1 }),
      readBatch: (root, id) => batches.get(id) ?? null,
      listBatches: () => [...batches.values()],
      progress: (batch) => `${batch.done ?? 0}/${batch.total ?? 0}`,
      /* 渲染前自查：假报告即可，路由只负责把它送回去 */
      checkPlans: () => ({ verdict: '1 对完全一样', canRender: false, duplicates: [{ a: 'p1', b: 'p2', signature: 'x' }], risky: [], pairs: 1 }),
      /* planset 展开：每个候选出一条，够验证形状与状态码 */
      expandPlanset: ({ planset, candidates }) => ({
        made: candidates.map((candidate, index) => ({ planId: `gen-00${index + 1}`, copyId: 'A', voiceId: 'v1', bgm: null, totalSec: 15, blocking: 0 })),
        expand: { made: candidates.length, wanted: planset.expand ?? candidates.length, takes: 1, shortages: [], materialUsage: {} },
        verdict: `${candidates.length} 条已生成`,
      }),
    },
    batches,
  };
}

/* readJson 需要真的请求对象；这里用一个最小的假 req/res。 */
const fakeReq = (method, url, body) => {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* iterate() { yield* chunks; },
  };
};
const fakeRes = () => ({
  statusCode: 0,
  body: null,
  setHeader() {},
  end(text) { this.body = text ? JSON.parse(String(text)) : null; },
  getHeader() { return ''; },
  writeHead(code, headers) { this.statusCode = code; Object.assign(this, { headers }); },
});

test('state：只给工程 id，服务端自己解析计划并列出最近批次', async () => {
  const { deps } = fixture();
  const routes = createRenderBatchRoutes({
    ...deps,
    readPlanFile: (root, id) => ({
      id,
      segments: [{ id: 'S1', kind: 'speech', text: id === 'p1' ? '开箱那一下' : '过完年饭局多', voice: { provider: 'qwen', voice: 'Cherry' } }],
      shots: [{ shownSec: 2.1 }, { shownSec: 2.4 }],
      compliance: { mode: 'publish', blocking: 0 },
      bgm: { id: 'bgmA' },
    }),
  });
  const res = fakeRes();
  const handled = await routes(fakeReq('GET', '/api/fission-render/state?project=proj-1'), res, ['fission-render', 'state']);
  assert.equal(handled, true);
  assert.equal(res.body.entries.length, 2);
  assert.equal(res.body.entries[0].copyPreview, '开箱那一下');
  assert.equal(res.body.entries[0].totalSec, 4.5);
  assert.equal(res.body.entries[0].shotCount, 2);
});

test('state：没有工程 id 就 400，不去猜目录', async () => {
  const { deps } = fixture();
  const routes = createRenderBatchRoutes(deps);
  await assert.rejects(
    () => routes(fakeReq('GET', '/api/fission-render/state'), fakeRes(), ['fission-render', 'state']),
    /project id|A project id/,
  );
});

test('start：引擎路径不全就 503 并说缺什么，不进队列', async () => {
  const { deps } = fixture();
  const routes = createRenderBatchRoutes({
    ...deps,
    resolveEnginePaths: () => ({ ok: false, paths: {}, problems: ['找不到 app 自带的 ffmpeg'] }),
  });
  const res = fakeRes();
  await routes(fakeReq('POST', '/api/fission-render/start', { project: 'proj-1' }), res, ['fission-render', 'start']);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.message, /渲染器还差配置：找不到 app 自带的 ffmpeg/);
});

test('start：正常起一批，202 返回 batchId', async () => {
  const { deps } = fixture();
  const routes = createRenderBatchRoutes({
    ...deps,
    readPlanFile: (root, id) => ({ id, segments: [], shots: [], compliance: { blocking: 0 } }),
  });
  const res = fakeRes();
  await routes(fakeReq('POST', '/api/fission-render/start', { project: 'proj-1', planIds: ['p1', 'p2'] }), res, ['fission-render', 'start']);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.batchId, 'b1');
  assert.equal(res.body.batch.total, 2);
});

test('status / retry：批次号就能问，重出只针对失败项', async () => {
  const { deps } = fixture();
  const routes = createRenderBatchRoutes(deps);
  const started = fakeRes();
  await routes(fakeReq('POST', '/api/fission-render/start', { project: 'proj-1' }), started, ['fission-render', 'start']);

  const status = fakeRes();
  await routes(fakeReq('GET', '/api/fission-render/status?project=proj-1&batchId=b1'), status, ['fission-render', 'status']);
  assert.equal(status.body.batch.id, 'b1');
  assert.equal(status.body.progress, '0/2');

  const retried = fakeRes();
  await routes(fakeReq('POST', '/api/fission-render/retry', { project: 'proj-1', batchId: 'b1' }), retried, ['fission-render', 'retry']);
  assert.equal(retried.statusCode, 202);
  assert.equal(retried.body.retried, 1);
  assert.equal(retried.body.batchId, 'b1-retry');
});

test('不认识的路径交给别人（返回 false）', async () => {
  const { deps } = fixture();
  const routes = createRenderBatchRoutes(deps);
  assert.equal(await routes(fakeReq('GET', '/api/materials/x'), fakeRes(), ['materials', 'x']), false);
});

test('dedupe：渲染前自查，界面在出片前就能看到"哪两条一样"', async () => {
  const { deps } = fixture();
  const routes = createRenderBatchRoutes(deps);
  const res = fakeRes();
  await routes(fakeReq('GET', '/api/fission-render/dedupe?project=proj-1'), res, ['fission-render', 'dedupe']);
  /* json() 只写 body，不设 statusCode（默认 200）——所以断言看 body */
  assert.ok(res.body, 'GET 直接 json');
  assert.equal(res.body.canRender, false);
  assert.equal(res.body.duplicates[0].a, 'p1');
});

test('expand：一句话 → N 条，返回生成了哪些计划', async () => {
  const { deps } = fixture();
  const routes = createRenderBatchRoutes(deps);
  const res = fakeRes();
  await routes(
    fakeReq('POST', '/api/fission-render/expand', {
      project: 'proj-1',
      planset: { id: 'x', expand: 2, copy: [{ id: 'A', lines: ['一'] }], voices: [{ id: 'v1' }], pools: [] },
      candidates: [{ id: 'm1', durationSec: 8 }, { id: 'm2', durationSec: 7 }],
      targetSec: 15,
    }),
    res,
    ['fission-render', 'expand'],
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.made.length, 2);
  assert.match(res.body.verdict, /2 条已生成/);
  assert.ok(res.body.dedupe, '生成后顺手跑一次自查');
});

test('expand：没有候选素材就 400，不生成空计划', async () => {
  const { deps } = fixture();
  const routes = createRenderBatchRoutes(deps);
  await assert.rejects(
    () => routes(fakeReq('POST', '/api/fission-render/expand', { project: 'proj-1', planset: { copy: [] }, candidates: [] }), fakeRes(), ['fission-render', 'expand']),
    /Candidates|候选/,
  );
});

/* ── 配方（画布混剪）那条路：dry-run 摆目录算 job，run=true 才跑引擎；两者都不碰 dotnet ── */

/** 一个能摆出 staging 的临时工程：素材 + 已合成的整条口播。 */
function mixProject() {
  const project = mkdtempSync(join(tmpdir(), 'render-recipe-'));
  mkdirSync(join(project, 'assets', 'video'), { recursive: true });
  for (const name of ['a.mp4', 'b.mp4']) writeFileSync(join(project, 'assets', 'video', name), 'x');
  mkdirSync(join(project, 'voices'), { recursive: true });
  const voices = ['v1.mp3', 'v2.mp3'].map((name, index) => {
    const file = join(project, 'voices', name);
    writeFileSync(file, 'v');
    return { file, text: `第${index + 1}条口播。` };
  });
  return { project, voices };
}

const mixRecipe = () => ({
  schema: 'orange/mix-recipe/1',
  groups: [{ name: '01-开场', refs: [{ kind: 'asset', path: 'assets/video/a.mp4' }, { kind: 'asset', path: 'assets/video/b.mp4' }] }],
  script: { provider: 'minimax', voice: 'female-shaonv', lines: ['第一条口播。', '第二条口播。'] },
  params: { count: 2, audioUses: 1, subtitle: true, subtitleFontFamily: 'Noto Sans SC' },
});

/** 只有 recipe 那条路要的依赖都是真的（recipe/runner 是纯的），runJob 与 attempt 名一律注入。 */
const recipeDeps = (project, over = {}) => ({
  auth: { assertActive: () => ({ owner: 'test' }) },
  dataDir: project,
  projectById: async (id) => (id === 'proj-1' ? { id, path: project } : null),
  plansOf: () => [],
  readPlanFile: () => null,
  resolveEnginePaths: () => ({
    ok: true,
    paths: {
      AssetsRoot: join(project, 'assets'),
      WorkRoot: join(project, '.film', 'fission', 'work'),
      OutRoot: join(project, '.film', 'fission', 'out'),
    },
    problems: [],
  }),
  startBatch: () => { throw new Error('配方这条路不走批次注册表'); },
  retryBatch: () => { throw new Error('配方这条路不走批次注册表'); },
  readBatch: () => null,
  listBatches: () => [],
  progress: () => '',
  checkPlans: () => ({ verdict: '', canRender: true, duplicates: [], risky: [], pairs: 0 }),
  expandPlanset: () => ({ made: [], verdict: '' }),
  newAttempt: () => 'mix-test',
  ...over,
});

test('recipe：dry-run 摆好目录、给出 job，不启动进程', async () => {
  const { project, voices } = mixProject();
  let calls = 0;
  const routes = createRenderBatchRoutes(recipeDeps(project, { runJob: async () => { calls += 1; return {}; } }));
  const res = fakeRes();
  const handled = await routes(
    fakeReq('POST', '/api/fission-render/recipe', { project: 'proj-1', recipe: mixRecipe(), voices }),
    res,
    ['fission-render', 'recipe'],
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.batchId, 'mix-test');
  assert.deepEqual(res.body.problems, []);
  assert.equal(res.body.job.Count, 2);
  assert.equal(res.body.job.SceneGroups[0].Name, '01-开场');
  assert.equal(res.body.job.SubtitleFontFamily, 'Noto Sans SC');
  assert.deepEqual(Object.keys(res.body.staged).sort(), ['audioDir', 'meta', 'videoDir']);
  assert.ok(res.body.staged.meta.file.endsWith('meta.json'));
  assert.deepEqual(res.body.staged.meta.items.map((item) => item.file), ['01.mp3', '02.mp3']);
  assert.ok(existsSync(join(res.body.staged.videoDir, '01-开场', '001.mp4')), '素材真的摆进去了');
  assert.ok(existsSync(res.body.staged.audioDir), 'audio 目录真的建了');
  assert.equal(calls, 0, 'dry-run 不该起 dotnet');
  assert.equal('render' in res.body, false);
});

test('recipe：配方有逐项问题时 ok=false 但照样回 job，不让面板白等', async () => {
  const { project, voices } = mixProject();
  const routes = createRenderBatchRoutes(recipeDeps(project));
  const res = fakeRes();
  const recipe = mixRecipe();
  recipe.groups[0].refs = [{ kind: 'asset', path: 'assets/video/nope.mp4' }];
  await routes(fakeReq('POST', '/api/fission-render/recipe', { project: 'proj-1', recipe, voices }), res, ['fission-render', 'recipe']);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.problems.some((line) => line.includes('nope.mp4')));
  assert.equal(res.body.job.SceneGroups[0].Name, '01-开场', 'job 还是要给（面板靠它显示"要跑什么"）');
});

test('recipe：run=true 把 runJob 的结果原样透传（成功）', async () => {
  const { project, voices } = mixProject();
  const asked = [];
  const routes = createRenderBatchRoutes(recipeDeps(project, {
    runJob: async (input) => {
      asked.push(input);
      return {
        code: 0, timedOut: false, attempt: input.attempt, outDir: join(project, '.film', 'fission', 'run', 'out'),
        stdout: '', stderr: '', message: '完成 2 条（countReached）',
        report: {
          jobDir: join(project, '.film', 'fission', 'run', 'job1'),
          succeeded: 2, failed: 0, stopReason: 'countReached',
          outputs: [{ index: 0, path: join(project, '.film', 'fission', 'run', 'job1', '001.mp4'), title: '001', durationSec: 12.5, editPlanPath: null }],
          failures: [],
        },
      };
    },
  }));
  const res = fakeRes();
  await routes(fakeReq('POST', '/api/fission-render/recipe', { project: 'proj-1', recipe: mixRecipe(), voices, run: true }), res, ['fission-render', 'recipe']);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.render.attempt, 'mix-test');
  assert.equal(res.body.render.code, 0);
  assert.equal(res.body.render.timedOut, false);
  assert.equal(res.body.render.report.succeeded, 2);
  assert.equal(res.body.render.report.outputs.length, 1);
  assert.equal(asked.length, 1, '只跑一次');
  assert.equal(asked[0].attempt, 'mix-test');
  assert.equal(asked[0].task, 't1');
  assert.equal(asked[0].job.Count, 2);
  assert.equal(asked[0].enginePaths.WorkRoot, join(project, '.film', 'fission', 'work'), 'enginePaths 由 resolveEnginePaths 解析');
  assert.equal(asked[0].root, join(project, '.film', 'fission', 'run'), '每次渲染一个全新 attempt 的根');
});

test('recipe：引擎跑失败也是结果（结构化成 ok:false），不是 500', async () => {
  const { project, voices } = mixProject();
  const failed = createRenderBatchRoutes(recipeDeps(project, {
    runJob: async (input) => ({
      code: 3, timedOut: false, attempt: input.attempt, outDir: null, stdout: '',
      stderr: '[Fission:SRC_MISSING] no footage', message: '3 条完成、0 条失败', report: null,
    }),
  }));
  const res = fakeRes();
  await failed(fakeReq('POST', '/api/fission-render/recipe', { project: 'proj-1', recipe: mixRecipe(), voices, run: true }), res, ['fission-render', 'recipe']);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.render.code, 3);
  assert.equal(res.body.render.report, null);
  assert.match(res.body.render.message, /3 条/);

  /* 前置检查抛错（attempt-not-fresh 之类）同样结构化 */
  const thrown = createRenderBatchRoutes(recipeDeps(project, {
    runJob: async () => { const error = new Error('workspace/t1/a1/out 已存在'); error.code = 'attempt-not-fresh'; throw error; },
  }));
  const bang = fakeRes();
  await thrown(fakeReq('POST', '/api/fission-render/recipe', { project: 'proj-1', recipe: mixRecipe(), voices, run: true }), bang, ['fission-render', 'recipe']);
  assert.equal(bang.statusCode, 200);
  assert.equal(bang.body.ok, false);
  assert.equal(bang.body.render.errorCode, 'attempt-not-fresh');
  assert.match(bang.body.render.message, /已存在/);
});

test('recipe：引擎路径不全就 503 并说缺什么；dry-run 不受影响', async () => {
  const { project, voices } = mixProject();
  const deps = recipeDeps(project, {
    resolveEnginePaths: () => ({
      ok: false,
      paths: { WorkRoot: join(project, '.film', 'fission', 'work') },
      problems: ['找不到 app 自带的 ffmpeg'],
    }),
  });
  const routes = createRenderBatchRoutes(deps);
  const dry = fakeRes();
  await routes(fakeReq('POST', '/api/fission-render/recipe', { project: 'proj-1', recipe: mixRecipe(), voices }), dry, ['fission-render', 'recipe']);
  assert.equal(dry.statusCode, 200, 'dry-run 不碰引擎，配置不全也能先摆目录');
  assert.equal(dry.body.ok, false);
  assert.ok(dry.body.problems.some((line) => line.includes('engine-paths')));

  const run = fakeRes();
  await routes(fakeReq('POST', '/api/fission-render/recipe', { project: 'proj-1', recipe: mixRecipe(), voices, run: true }), run, ['fission-render', 'recipe']);
  assert.equal(run.statusCode, 503);
  assert.equal(run.body.code, 'engine-paths');
  assert.match(run.body.message, /渲染器还差配置：找不到 app 自带的 ffmpeg/);
});

test('recipe：不是对象就 400 recipe-invalid，batchId 不合规也 400', async () => {
  const { project, voices } = mixProject();
  const routes = createRenderBatchRoutes(recipeDeps(project));
  const notObject = fakeRes();
  await routes(fakeReq('POST', '/api/fission-render/recipe', { project: 'proj-1', recipe: 'nope' }), notObject, ['fission-render', 'recipe']);
  assert.equal(notObject.statusCode, 400);
  assert.equal(notObject.body.code, 'recipe-invalid');
  assert.ok(Array.isArray(notObject.body.problems) && notObject.body.problems.length);

  await assert.rejects(
    () => routes(fakeReq('POST', '/api/fission-render/recipe', { project: 'proj-1', recipe: mixRecipe(), voices, batchId: 'Bad/Id' }), fakeRes(), ['fission-render', 'recipe']),
    (error) => error.status === 400 && error.extra?.code === 'batch-invalid',
  );
});
