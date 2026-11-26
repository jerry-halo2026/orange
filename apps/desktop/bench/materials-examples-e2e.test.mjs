// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 素材中心与示例的客户端 E2E：登录 → 示例列表 → 从示例建工程 → 素材中心公开目录能列出卡片。
 *
 * 硬断言（API）：`GET /api/examples` ≥1；`POST /api/examples/:id/start` 建出工程且 `/api/open` 200；
 * `GET /api/materials/list` 200 且 items ≥1（公司公开视图，无需绑定）。
 * 软证据（UI）：素材中心页出现 `[data-material-card]`，页面没有“素材服务未接通”；示例页截图。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { DESKTOP, prepare, signIn, withBenchAuth } from './app.mjs';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const screenshotDir = join(DESKTOP, '.dev', 'materials-e2e');

test('素材中心与示例：示例能建工程，公开素材目录能列出卡片', { timeout: 1_500_000 }, async (t) => {
  const auth = withBenchAuth(t);
  if (!auth) return;
  const dir = join(DESKTOP, '.dev', `materials-e2e-${Date.now()}`);
  prepare(dir);
  mkdirSync(screenshotDir, { recursive: true });
  /* Studio's index route reads this folder; the sweep below lands the index here.
     共享目录：构建一次（约几分钟），后续运行直接复用。 */
  const indexDir = join(DESKTOP, '.dev', 'material-index-e2e');
  const { PATH } = await loginShellEnvironment();
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: [DESKTOP], cwd: DESKTOP,
    env: {
      ...launcherEnvironment(process.env, PATH), ORANGE_DESKTOP_FLAVOR: 'bench', ORANGE_BENCH_DIR: dir,
      ORANGE_MATERIAL_INDEX_DIR: indexDir,
    },
  });
  /** @type {import('playwright-core').Page | null} */
  let page = null;
  const links = [];
  const link = async (name, work, basis = 'real') => {
    try {
      const said = await work();
      links.push({ name, ok: true, basis, said: said ?? '' });
      console.log(`  ok   ${name} (${basis})${said ? `: ${said}` : ''}`);
      return true;
    } catch (error) {
      links.push({ name, ok: false, basis, said: error?.message ?? String(error) });
      console.log(`  fail ${name} (${basis}): ${error?.message ?? error}`);
      if (page && !page.isClosed()) await page.screenshot({ path: join(screenshotDir, `failed-${name}.png`) }).catch(() => {});
      return false;
    }
  };
  try {
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
    await link('sign-in', async () => {
      await signIn(run, auth);
      const state = await call('/api/auth/state');
      assert.equal(state.body?.kind, 'active', `the session is ${state.body?.kind} (${state.body?.reason ?? 'no reason'})`);
      for (let attempt = 0; attempt < 600 && !page; attempt += 1) {
        page = app.context().pages().find((candidate) => candidate.url().startsWith(run.origin)) ?? null;
        if (!page) await sleep(100);
      }
      assert.ok(page, 'the app never showed Studio');
      return 'active';
    });

    let examples = [];
    await link('examples-api', async () => {
      const answer = await call('/api/examples');
      assert.equal(answer.status, 200, `HTTP ${answer.status} (${answer.body?.code ?? 'no code'})`);
      examples = Array.isArray(answer.body?.examples) ? answer.body.examples : [];
      assert.ok(examples.length >= 1, `the index lists ${examples.length} example(s)`);
      return `${examples.length} example(s): ${examples.map((item) => item.id).join(', ')}`;
    });

    await link('example-start', async () => {
      const first = examples[0];
      assert.ok(first?.id, 'no example to start');
      const started = await call(`/api/examples/${encodeURIComponent(first.id)}/start`, {});
      assert.equal(started.status, 200, `start: HTTP ${started.status} (${started.body?.code ?? 'no code'})`);
      const project = started.body?.project ?? started.body;
      assert.ok(project?.path, `start returned no project: ${JSON.stringify(started.body)?.slice(0, 200)}`);
      const opened = await call('/api/open', { path: project.path, fallback: 0 });
      assert.equal(opened.status, 200, `open: HTTP ${opened.status} (${opened.body?.code ?? 'no code'})`);
      return `${first.id} → ${project.id ?? project.path}`;
    });

    await link('materials-api', async () => {
      const list = await call('/api/materials/list?pageSize=3&pageNo=1');
      assert.equal(list.status, 200, `list: HTTP ${list.status} (${list.body?.code ?? 'no code'})`);
      const items = Array.isArray(list.body?.items) ? list.body.items : [];
      assert.ok(items.length >= 1, `the public catalogue listed ${items.length} item(s)`);
      const facets = await call('/api/materials/facets');
      assert.equal(facets.status, 200, `facets: HTTP ${facets.status} (${facets.body?.code ?? 'no code'})`);
      const index = await call('/api/materials/index');
      console.log(`  index: HTTP ${index.status} · schema=${index.body?.schema ?? index.body?.tree?.schema ?? 'none'} · keys=${Object.keys(index.body ?? {}).join(',')} · batches=${index.body?.tree?.batches?.length ?? 'none'}`);
      return `${items.length} item(s) on the first page`;
    });

    /* 素材中心目录来自本地索引：已有索引就直接用；没有才真的构建一次。 */
    await link('materials-index', async () => {
      const landed = join(indexDir, 'index.json');
      if (existsSync(landed)) return `index already landed (${readFileSync(landed).length} bytes)`;
      const started = Date.now();
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
          join(DESKTOP, '..', '..', 'packages', 'orangefilm', 'scripts', 'material-index-bootstrap.mjs'),
          '--wait', '--dir', indexDir, '--force',
        ], {
          cwd: join(DESKTOP, '..', '..'),
          env: { ...process.env, ORANGE_DEV_HOME: join(dir, 'home'), ORANGE_MATERIAL_INDEX_DIR: indexDir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += String(chunk); });
        child.stderr.on('data', (chunk) => { output += String(chunk); });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`index build timed out after ${Math.round((Date.now() - started) / 1000)}s`)); }, 15 * 60_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`index build exited ${code}: ${output.slice(-400)}`));
        });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
      });
      const builtFile = join(indexDir, 'index.json');
      assert.ok(existsSync(builtFile), `no index at ${builtFile}`);
      return `built in ${Math.round((Date.now() - started) / 1000)}s`;
    });

    /* UI：素材中心页（首页卡）应显示卡片，且不说“未接通”。 */
    await link('materials-ui', async () => {
      assert.ok(page, 'no Studio page');
      await page.evaluate(() => localStorage.setItem('orangefilm.language', 'zh-CN'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      const card = page.getByRole('button', { name: '素材中心', exact: true });
      await card.first().waitFor({ timeout: 60_000 });
      await card.first().click();
      /* 合集视图：批次卡就是素材中心的目录（缩略图 + 数量）；点进去还能看产品/分组。 */
      await page.locator('[data-collections]').first().waitFor({ timeout: 90_000 });
      const stale = page.locator('[data-note="index-stale"]');
      assert.equal(await stale.count(), 0, 'the index is fresh');
      const collections = await page.locator('[data-collection-card]').count();
      assert.ok(collections >= 1, `collection cards on screen: ${collections}`);
      await page.locator('[data-collection-card]').first().click();
      await page.waitForTimeout(800);
      const text = await page.locator('body').innerText();
      assert.equal(/素材服务未接通/.test(text), false, 'the page still says the material service is not connected');
      await page.screenshot({ path: join(screenshotDir, 'materials.png'), fullPage: false });
      return `${collections} collection cards`;
    }, 'real');

    /* UI：示例页应能打开并看到内容（截图）。 */
    await link('examples-ui', async () => {
      assert.ok(page, 'no Studio page');
      const home = page.locator('div[data-titlebar] button[aria-label="首页"]').first();
      if (await home.count()) await home.click();
      const tab = page.getByRole('tab', { name: '示例', exact: true });
      await tab.first().waitFor({ timeout: 30_000 });
      await tab.first().click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(screenshotDir, 'examples.png'), fullPage: false });
      return 'examples view on screen';
    }, 'best-effort');

    console.log(JSON.stringify({ links, screenshots: screenshotDir }, null, 2));
    assert.deepEqual(links.filter((entry) => !entry.ok && entry.basis !== 'best-effort'), [], 'every real link passes');
  } finally {
    /* 关窗口可能卡在 Studio 的退出握手：等 8 秒，然后收掉进程树。 */
    await Promise.race([app.close().catch(() => {}), sleep(8000)]);
    try { app.process().kill(); } catch { /* already gone */ }
  }
});
