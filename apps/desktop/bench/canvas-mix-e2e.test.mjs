// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 画布混剪的点击级 E2E（渲染路由在页面边界打桩）：
 * 切到画布 → 添加「批量混剪」节点 → 添加场景组文件夹（选择器打桩）→ 写口播 → 选 MiniMax 音色 →
 * 设数量 → 开始混剪 → 断言发出去的 recipe（组/文案/音色/数量）与面板回显（批次、已出片）。
 *
 * 引擎本身由 `mix-e2e.test.mjs` 真渲染证明；这里证明画布面板真的写出了配方并调用了同一条路由。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { DESKTOP, prepare, signIn, withBenchAuth } from './app.mjs';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('画布混剪：面板写出的配方能发到渲染路由，并回显批次与结果', { timeout: 600_000 }, async (t) => {
  const auth = withBenchAuth(t);
  if (!auth) return;
  const dir = join(DESKTOP, '.dev', `canvas-mix-e2e-${Date.now()}`);
  prepare(dir);
  const groupDir = join(dir, 'group-a');
  mkdirSync(groupDir, { recursive: true });
  writeFileSync(join(groupDir, '001.mp4'), 'fixture');
  const bgmFile = join(dir, 'bgm.wav');
  const samples = Buffer.alloc(1600);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  writeFileSync(bgmFile, Buffer.concat([header, samples]));
  const shots = join(DESKTOP, '.dev', 'canvas-mix-e2e');
  mkdirSync(shots, { recursive: true });
  const { PATH } = await loginShellEnvironment();
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: [DESKTOP], cwd: DESKTOP,
    env: { ...launcherEnvironment(process.env, PATH), OPENFILM_DESKTOP_FLAVOR: 'bench', OPENFILM_BENCH_DIR: dir },
  });
  /** @type {import('playwright-core').Page | null} */
  let page = null;
  let posted = null;
  try {
    console.log('step: launch');
    let run = null;
    for (let attempt = 0; attempt < 600 && !run; attempt += 1) {
      if (existsSync(join(dir, 'home/run.json'))) run = JSON.parse(readFileSync(join(dir, 'home/run.json'), 'utf8'));
      else await sleep(100);
    }
    assert.ok(run, 'Studio never advertised itself');
    const call = async (path, body) => {
      const response = await fetch(`${run.origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-studio-key': run.key, origin: run.origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    await signIn(run, auth);
    console.log('step: signed in');
    const created = await call('/api/projects', { name: 'Canvas mix e2e' });
    console.log('step: project create', created.status, JSON.stringify(created.body)?.slice(0, 160));
    assert.equal(created.status, 200, `create: HTTP ${created.status} (${created.body?.code ?? ''})`);
    const project = created.body?.project ?? created.body;
    assert.ok(project?.path, `created no project: ${JSON.stringify(created.body)?.slice(0, 200)}`);
    const opened = await call('/api/open', { path: project.path, fallback: 0 });
    console.log('step: opened', opened.status);
    assert.equal(opened.status, 200, `open: HTTP ${opened.status}`);
    for (let attempt = 0; attempt < 600 && !page; attempt += 1) {
      page = app.context().pages().find((candidate) => candidate.url().startsWith(run.origin)) ?? null;
      if (!page) await sleep(100);
    }
    assert.ok(page, 'the project never opened in the window');
    console.log('step: page', page.url());
    /* 有些平台（macOS bench）窗口停在首页：直接到工程页，key 就是 run.json 里的那个。 */
    if (!page.url().includes('/projects/')) {
      await page.goto(`${run.origin}/projects/${project.id}?key=${run.key}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
    }

    const mode = page.locator('button[data-work-mode]').first();
    await mode.waitFor({ timeout: 60_000 });
    if ((await mode.getAttribute('data-work-mode')) === 'edit') await mode.click();
    await page.locator('[data-canvas-ready="1"]').first().waitFor({ timeout: 60_000 });
    console.log('step: canvas ready');
    await page.screenshot({ path: join(shots, '01-canvas.png') });

    /* 选择器与渲染路由都在页面边界回答，不碰系统对话框与引擎 */
    await page.route('**/api/pick-folder', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: groupDir }) }));
    await page.route('**/api/fission-render/recipe', async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, batchId: 'canvas-b1', render: { code: 0, message: 'ok', report: { succeeded: 1, failed: 0, stopReason: 'countReached', failures: [] } } }) });
    });

    await page.locator('button[aria-label="添加节点"]').first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(shots, '02-menu.png') });
    console.log('menu:', (await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '));
    await page.getByText('批量混剪', { exact: true }).first().click();
    const panel = page.locator('.react-flow__node-mix').first();
    await panel.waitFor({ timeout: 30_000 });
    console.log('step: mix node added');
    await page.screenshot({ path: join(shots, '02-mix-node.png') });

    await page.getByRole('button', { name: '添加文件夹' }).first().click();
    await page.getByText('group-a', { exact: false }).first().waitFor({ timeout: 15_000 });
    console.log('step: group added');

    const lines = page.locator('textarea').first();
    await lines.fill('测试口播：画布混剪能用');
    await page.locator('select').first().selectOption('minimax');
    /* 换服务时面板自动选该服务的第一个音色（female-shaonv），不必再打开音色弹层 */
    await page.locator('input[type="number"]').first().fill('1');
    await page.locator('label').filter({ hasText: '上传 BGM' }).locator('input[type="file"]').setInputFiles(bgmFile);
    await page.getByText('bgm.wav', { exact: false }).first().waitFor({ timeout: 30_000 });
    console.log('step: recipe filled');

    await page.getByRole('button', { name: '开始混剪' }).first().click();
    await page.getByText('已出片', { exact: false }).first().waitFor({ timeout: 20_000 });
    await page.getByText(/canvas-b1/).first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(shots, '03-run.png') });

    assert.ok(posted, 'the recipe route was never called');
    assert.equal(posted.run, true, 'the canvas run asks the route to render');
    assert.equal(posted.recipe.groups[0].name, 'group-a');
    assert.deepEqual(posted.recipe.script.lines, ['测试口播：画布混剪能用']);
    assert.equal(posted.recipe.script.provider, 'minimax');
    assert.ok(posted.recipe.script.voice, 'a voice was chosen');
    assert.equal(posted.recipe.params.count, 1);
    assert.ok(posted.recipe.bgm?.[0]?.path?.includes('bgm.wav'), `bgm is ${JSON.stringify(posted.recipe.bgm)}`);
    console.log(`canvas mix ok: ${JSON.stringify({ group: posted.recipe.groups[0].name, voice: posted.recipe.script.voice, count: posted.recipe.params.count })}`);
  } catch (error) {
    console.log('ERROR', error?.message ?? error);
    throw error;
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(8000)]);
    try { app.process().kill(); } catch { /* gone */ }
  }
});
