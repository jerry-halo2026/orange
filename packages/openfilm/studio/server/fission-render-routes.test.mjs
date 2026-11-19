// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 批量出片的 HTTP 面：工程用 id 解析、页面不传路径、失败说人话。用假依赖跑，不起 Studio。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
