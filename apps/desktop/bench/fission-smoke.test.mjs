// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Fission's three-step wizard, end to end, in the bench's own app: sign in -> open a film (the studio's `/api/open`) ->
 * the entry that opens the batch workspace -> step 1 materials with its scene-group cards -> step 2 the presets ->
 * step 3 the export, and one batch sent from the page.
 *
 * Two facts shape what this test can assert, and it says both out loud rather than passing quietly:
 *
 *  - The batch workspace's folders come from the system's own dialog, opened by the Studio utility process
 *    (server/folder-picker.mjs) — a window nothing unattended can answer. So the folder *pick* and the batch it would
 *    start are answered at the page's edge (`page.route`), and the run reports which links rested on that stub. What is
 *    *not* stubbed: signing in, `/api/open`, the film on screen, the Fission entry, the pane's own service probe, and —
 *    at the end — the wizard's exact batch request replayed at the real route, which takes its shape (202) and then
 *    fails on the one thing the page invented: the folder selection id.
 *
 *  - Fission itself (dotnet, the CLI, ffmpeg, the engine folders) must be there for the pane to exist at all. Without a
 *    runnable runtime the whole test is skipped and says which piece is missing — never green.
 *
 * `.dev/bench-auth.env` holds the bench's own sign-in; `bench/fission-runtime.mjs` finds or derives the runtime
 * configuration (`ORANGE_FISSION_CONFIG_FILE`, the one switch the app's utility process reads) and explains absences.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { DESKTOP, prepare, signIn, withBenchAuth } from './app.mjs';
import { findFissionRuntime } from './fission-runtime.mjs';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The workspaces the wizard offers the film: its three steps, and the entry that opens them. */
const FISSION_CARD = '超级混剪';
const STEPS = ['nav[aria-label="混剪步骤"] button'];

test('the bench app signs in, opens a film, opens Fission, and the three-step wizard shows scene groups, a preset and an export, and sends a batch', { timeout: 600_000 }, async (t) => {
  const auth = withBenchAuth(t);
  if (!auth) return;
  /* The runtime Studio's Fission pane needs; without one the pane answers 503 and there is nothing to assert. */
  const runtime = findFissionRuntime({ desktop: DESKTOP, log: (line) => console.log(line) });
  if (!runtime.configFile) {
    console.log('Fission smoke skipped - no runnable local Fission runtime:');
    for (const problem of runtime.problems) console.log(`  - ${problem}`);
    t.skip(`local Fission runtime unavailable: ${runtime.problems.join(' | ')}`);
    return;
  }
  console.log(`Fission runtime: ${runtime.source} (${runtime.configFile})`);
  process.env.ORANGE_FISSION_CONFIG_FILE = runtime.configFile;

  const dir = join(DESKTOP, '.dev', `fission-smoke-${Date.now()}`);
  prepare(dir);
  const { PATH } = await loginShellEnvironment();
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: [DESKTOP], cwd: DESKTOP,
    env: { ...launcherEnvironment(process.env, PATH), OPENFILM_DESKTOP_FLAVOR: 'bench', OPENFILM_BENCH_DIR: dir },
  });
  let page = null;
  /** Each link of the chain, as it went: the run's own report, whatever the verdict turns out to be. */
  const links = [];
  /**
   * Run one link and record it. `basis` says what the link rested on: 'real' is the app and Studio as a person has
   * them, 'stub' is a request the page made answered here because the system's folder dialog cannot be answered.
   */
  const link = async (name, work, basis = 'real') => {
    try {
      const said = await work();
      links.push({ name, ok: true, basis, said: said ?? '' });
      console.log(`  ok   ${name} (${basis})${said ? `: ${said}` : ''}`);
      return true;
    } catch (error) {
      links.push({ name, ok: false, basis, said: error?.message ?? String(error) });
      console.log(`  fail ${name} (${basis}): ${error?.message ?? error}`);
      if (page && !page.isClosed()) await page.screenshot({ path: join(dir, `failed-${name.replace(/[^\w-]+/g, '-')}.png`) }).catch(() => {});
      return false;
    }
  };
  /** The page's stand-in for the two requests the native folder dialog sits in front of, and what it saw go past. */
  const stub = {
    selectionId: null, jobId: randomUUID(), batchRequest: null, draftRequested: false,
    completed: false, releaseDraft: () => {}, output: { index: 0, state: 'completed', title: '成片 1', durationSec: 12 },
  };
  try {
    let run = null;
    for (let attempt = 0; attempt < 600 && !run; attempt += 1) {
      if (existsSync(join(dir, 'home/run.json'))) run = JSON.parse(readFileSync(join(dir, 'home/run.json'), 'utf8'));
      else await sleep(100);
    }
    assert.ok(run, 'Studio never advertised itself');
    /** Studio's own window asks from its own origin; the launch key is the page's, as the app keeps it. */
    const call = async (path, body) => {
      const response = await fetch(`${run.origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-studio-key': run.key, origin: run.origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    /* 1. Sign in: the gate every route below passes (auth-gate.test.mjs proves it shut before this). */
    await link('sign-in', async () => {
      await signIn(run, auth);
      const state = await call('/api/auth/state');
      assert.equal(state.body?.kind, 'active', `the session is ${state.body?.kind} (${state.body?.reason ?? 'no reason'})`);
      return 'active';
    });

    /* 2. The window, in the bench's language, before anything is opened in it: the page has to be Studio's own (its
          home, not the sign-in gate) for the project the next link opens to reach a tab. */
    const windowed = await link('window', async () => {
      for (let attempt = 0; attempt < 600 && !page; attempt += 1) {
        page = app.context().pages().find((candidate) => candidate.url().startsWith(run.origin));
        if (!page) await sleep(100);
      }
      assert.ok(page, 'the app never showed Studio');
      const card = page.getByRole('button').filter({ has: page.getByRole('heading', { name: FISSION_CARD, exact: true }) });
      await card.first().waitFor({ timeout: 90_000 });
      await page.evaluate(() => localStorage.setItem('openfilm.language', 'zh-CN'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await card.first().waitFor({ timeout: 90_000 });
      return 'Studio home on screen, zh-CN';
    });

    /* 3. A film of this account's, opened in the app's own window (the studio's `/api/open`, as the projects list does). */
    let project = null;
    const opened = await link('open-film', async () => {
      if (!windowed) throw new Error('the window never showed Studio');
      const created = await call('/api/projects', { name: 'Fission smoke' });
      assert.equal(created.status, 200, `making the film: HTTP ${created.status} (${created.body?.code ?? 'no code'})`);
      project = created.body.project;
      const answer = await call('/api/open', { path: project.path, fallback: 0 });
      assert.equal(answer.status, 200, `opening the film: HTTP ${answer.status} (${answer.body?.code ?? 'no code'})`);
      return `${project.id} opened (HTTP 200)`;
    });
    const film = await link('film-on-screen', async () => {
      if (!opened) throw new Error('no film was opened');
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const candidate = app.context().pages().find((other) => other.url().includes('/projects/'));
        if (candidate) { page = candidate; break; }
        await sleep(100);
      }
      assert.ok(page.url().includes('/projects/'), `the window never showed the film: ${JSON.stringify(app.context().pages().map((other) => other.url()))}`);
      await page.waitForSelector('[data-timeline]', { timeout: 90_000 });
      return 'the film on screen';
    });

    /* 4. The entry: the home card 超级混剪 (homeCards.fission). It has no route of its own — App keeps a `workspace`
          state — so the card is the way in, from the film's own 首页. */
    const home = await link('fission-entry', async () => {
      if (!film) throw new Error('no film on screen');
      await page.locator('div[data-titlebar] button[aria-label="首页"]').first().click();
      const card = page.getByRole('button').filter({ has: page.getByRole('heading', { name: FISSION_CARD, exact: true }) });
      await card.first().waitFor({ timeout: 30_000 });
      await card.first().click();
      await page.getByRole('heading', { name: FISSION_CARD, exact: true }).first().waitFor({ timeout: 30_000 });
      return '首页「超级混剪」卡 -> 混剪工作区（App 的 workspace 状态，无独立 URL）';
    });

    /* 5. The pane's own probe of the local batch service. Only a 503 means the runtime the app was given is not one
          Studio can start, and only then is the whole test skipped, saying which piece is absent — a workspace that
          never opened, or any other answer, stays a failure. */
    let unavailable = null;
    const ready = await link('service', async () => {
      if (!home) throw new Error('no workspace');
      const answer = await call('/api/fission-local/jobs');
      if (answer.status !== 200) {
        unavailable = `GET /api/fission-local/jobs: HTTP ${answer.status} (${answer.body?.code ?? 'no code'})`;
        const said = (await page.getByRole('alert').first().textContent().catch(() => ''))?.trim() ?? '';
        throw new Error(`${unavailable} - the pane says "${said}"`);
      }
      assert.ok(Array.isArray(answer.body), `the batch list is not a list: ${JSON.stringify(answer.body)?.slice(0, 120)}`);
      await page.locator(STEPS[0]).first().waitFor({ timeout: 30_000 });
      return `ready, ${answer.body.length} batch(es)`;
    });
    if (!ready && unavailable) {
      console.log(`Fission smoke skipped - ${unavailable}; the runtime it found is not one Studio can start:`);
      for (const problem of runtime.problems) console.log(`  - ${problem}`);
      t.skip(`the app could not start the local Fission runtime: ${unavailable}`);
      return;
    }

    /* 6. What the wizard does from here needs a folder from the system dialog; answered at the page's edge (see the
          header). Everything the wizard then derives from that answer is its own. */
    await page.route('**/api/fission-local/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/^\/api\/fission-local\//, '');
      const method = request.method();
      const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (method === 'POST' && path === 'select') {
        const { role } = /** @type {{ role: string }} */ (request.postDataJSON());
        stub.selectionId = randomUUID();
        return json(200, { selectionId: stub.selectionId, role, name: 'fission-smoke-video', groups: [{ name: '1', count: 2 }, { name: '2', count: 3 }, { name: '3', count: 1 }] });
      }
      if (method === 'POST' && path === 'jobs') {
        stub.batchRequest = request.postDataJSON();
        return json(202, { jobId: stub.jobId, status: 'preparing', outputs: [], logs: ['素材已准备'] });
      }
      if (method === 'GET' && path === `jobs/${stub.jobId}`) {
        return json(200, stub.completed
          ? { jobId: stub.jobId, status: 'completed', outputs: [stub.output], logs: ['已完成'] }
          : { jobId: stub.jobId, status: 'preparing', outputs: [], logs: [] });
      }
      if (method === 'GET' && path === `jobs/${stub.jobId}/outputs/0/draft`) return json(200, { status: 'not-started' });
      if (method === 'POST' && path === `jobs/${stub.jobId}/outputs/0/draft`) {
        stub.draftRequested = true;
        await new Promise((done) => { stub.releaseDraft = () => done(); });
        return json(200, { status: 'ready', project: { id: randomUUID() }, blockingCapabilities: [], exportReady: true, equivalenceVerified: true });
      }
      if (method === 'GET' && path === 'jobs') return json(200, []);
      return route.continue();
    });

    /* Step 1, 素材: the folder row, then one card per scene group with the item count the selection reported. */
    const materials = await link('step-1-scene-groups', async () => {
      await page.getByRole('button', { name: '选择文件夹', exact: true }).first().click();
      const cards = page.locator('ul[aria-label="场景组"] > li');
      await cards.first().waitFor({ timeout: 30_000 });
      const names = await cards.evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
      assert.deepEqual(names, ['场景组 1', '场景组 2', '场景组 3'], `the cards are ${JSON.stringify(names)}`);
      const said = await cards.first().textContent();
      assert.match(String(said), /2 条素材/, `the first card reads "${said}"`);
      const rail = await page.locator(STEPS[0]).allTextContents();
      assert.equal(rail.length, 3, `the step rail is ${JSON.stringify(rail)}`);
      return `3 张场景组卡片（1:2 条 / 2:3 条 / 3:1 条），步骤栏 3 步`;
    }, 'stub: POST /api/fission-local/select');

    /** The summary bar's own reading: the term beside each figure. */
    const summary = () => page.locator('section[aria-label="配置摘要与预计产出"] dl > div').evaluateAll((rows) =>
      Object.fromEntries(rows.map((row) => [row.querySelector('dt')?.textContent?.trim() ?? '', row.querySelector('dd')?.textContent?.trim() ?? ''])));
    const railStep = (text) => page.locator(STEPS[0]).filter({ hasText: text });

    /* Step 2, 规则: the preset rail. 口播混剪 is the wizard's default, so 快节奏 changes the summary and picking 口播混剪
          again has to change it back — that is the "summary updates" this asserts, not a label that never moved. */
    const rules = await link('step-2-preset', async () => {
      if (!materials) throw new Error('no scene groups');
      await railStep('规则').click();
      assert.equal(await railStep('规则').getAttribute('aria-current'), 'step', 'the rules step is not the current one');
      await page.getByRole('heading', { name: '② 规则', exact: true }).waitFor({ timeout: 10_000 });
      const before = await summary();
      await page.getByRole('radio', { name: '快节奏', exact: true }).check();
      const fastCut = await summary();
      assert.equal(fastCut['预设'], '快节奏', `the summary's preset is ${fastCut['预设']}`);
      assert.equal(fastCut['数量'], '6 条', `快节奏 count is ${fastCut['数量']}`);
      await page.getByRole('radio', { name: '口播混剪', exact: true }).check();
      const after = await summary();
      assert.equal(after['预设'], '口播混剪', `the summary's preset is ${after['预设']}`);
      assert.equal(after['数量'], '3 条', `口播混剪 count is ${after['数量']}`);
      assert.equal(after['目标时长'], '12 秒', `口播混剪 target is ${after['目标时长']}`);
      assert.equal(after['并发'], '2', `口播混剪 concurrency is ${after['并发']}`);
      assert.match(String(after['素材']), /场景组 3\/3/, `the summary's materials read "${after['素材']}"`);
      return `摘要 ${before['预设']} ${before['数量']} -> 快节奏 ${fastCut['数量']} -> 口播混剪 ${after['数量']} · ${after['目标时长']} · 并发 ${after['并发']}`;
    }, 'stub: select');

    /* Step 3, 导出: count, length and concurrency on the panel, its estimate. */
    const exported = await link('step-3-export', async () => {
      if (!rules) throw new Error('no preset');
      await railStep('导出').click();
      await page.getByRole('heading', { name: '③ 导出', exact: true }).waitFor({ timeout: 10_000 });
      assert.equal(await page.getByLabel('生成数量', { exact: true }).inputValue(), '3', 'the count field');
      assert.equal(await page.getByLabel(/目标时长/).inputValue(), '12', 'the length field');
      assert.equal(await page.getByLabel('并发数', { exact: true }).inputValue(), '2', 'the concurrency field');
      const estimate = String(await page.locator('div[role="status"]').filter({ hasText: '预计成片' }).first().textContent());
      assert.match(estimate, /预计成片 3 条/, `the estimate reads "${estimate}"`);
      assert.match(estimate, /目标时长 12 秒/, `the estimate reads "${estimate}"`);
      assert.match(estimate, /并发 ×2/, `the estimate reads "${estimate}"`);
      return `数量 3 · 目标时长 12 秒 · 并发 2；估算「预计成片 3 条 · 目标时长 12 秒」`;
    }, 'stub: select');

    /* The batch itself: the page's own request, checked field by field, and the status it shows while it runs. */
    const started = await link('start-batch', async () => {
      if (!exported) throw new Error('no export step');
      await page.getByRole('button', { name: '开始批量出片', exact: true }).click();
      for (let attempt = 0; attempt < 100 && !stub.batchRequest; attempt += 1) await sleep(100);
      assert.ok(stub.batchRequest, 'the page sent no batch request');
      const { job, selections, requestId } = /** @type {any} */ (stub.batchRequest);
      assert.match(String(requestId), /^[0-9a-f-]{36}$/i, `the request id is ${requestId}`);
      assert.equal(selections.video, stub.selectionId, 'the batch does not name the selection it was given');
      assert.equal(job.Count, 3, `Count is ${job.Count}`);
      assert.equal(job.Threads, 2, `Threads is ${job.Threads}`);
      assert.equal(job.TargetDurationSec, 12, `TargetDurationSec is ${job.TargetDurationSec}`);
      assert.equal(job.SceneGroups?.length, 3, `SceneGroups is ${JSON.stringify(job.SceneGroups)?.slice(0, 120)}`);
      assert.equal(job.Naming, 'AudioFileName', `Naming is ${job.Naming}`);
      const status = page.locator('section').filter({ hasText: '执行与成片' }).getByRole('status').filter({ hasText: '状态' });
      await status.first().waitFor({ timeout: 60_000 });
      const said = String(await status.first().textContent());
      assert.match(said, /准备中/, `the batch status is "${said}"`);
      return `POST /api/fission-local/jobs 已发出（Count 3 · Threads 2 · Target 12 · SceneGroups 3）；状态「${said.trim()}」`;
    }, 'stub: POST /api/fission-local/jobs -> 202 preparing');

    /* The editable draft the wizard offers per finished video: shown once an output is completed, its request held open
       until the page says it is creating one. Only the request is asserted — a draft needs a real render to exist. */
    await link('draft-request', async () => {
      if (!started) throw new Error('no batch was started');
      stub.completed = true;
      const button = page.getByRole('button', { name: '生成可编辑草稿', exact: true });
      await button.waitFor({ timeout: 60_000 });
      await button.click();
      await page.getByRole('button', { name: '正在创建…', exact: true }).waitFor({ timeout: 30_000 });
      assert.ok(stub.draftRequested, 'the page never posted the draft request');
      stub.releaseDraft();
      await page.getByRole('button', { name: '打开草稿', exact: true }).waitFor({ timeout: 30_000 });
      return '「生成可编辑草稿」-> POST draft 发出 -> 正在创建… -> 打开草稿';
    }, 'stub: completed output, GET/POST .../outputs/0/draft');

    /* The one check the stub cannot make: does the real route accept what the page sends? Its shape yes — 202 and a
       batch the service took on — and then it fails on the only invented part, the folder selection id, which is no
       selection of this Studio's. */
    await link('real-route-payload', async () => {
      if (!stub.batchRequest) throw new Error('no batch request to replay');
      const accepted = await call('/api/fission-local/jobs', stub.batchRequest);
      assert.equal(accepted.status, 202, `the real route answered HTTP ${accepted.status} (${accepted.body?.code ?? 'no code'})`);
      const jobId = accepted.body?.jobId;
      assert.match(String(jobId), /^[0-9a-f-]{36}$/i, `the real batch id is ${jobId}`);
      let state = accepted.body;
      for (let attempt = 0; attempt < 100 && !['failed', 'needs-reconciliation'].includes(state?.status); attempt += 1) {
        await sleep(100);
        state = (await call(`/api/fission-local/jobs/${jobId}`)).body;
      }
      assert.equal(state?.status, 'failed', `the real batch is ${state?.status}`);
      assert.equal(state?.error, 'fission-selection-invalid', `the real batch failed with ${state?.error}`);
      return `真实路由回 202（${accepted.body?.status}）-> ${state.status}/${state.error}：只拒被页面编造的 selectionId`;
    });

    const broken = links.filter((entry) => !entry.ok);
    const stubbed = links.filter((entry) => entry.basis.startsWith('stub')).map((entry) => entry.name);
    console.log(`Fission smoke: ${links.length - broken.length}/${links.length} links ok, artifacts ${dir}`);
    console.log(`  real: ${links.filter((entry) => entry.basis === 'real').map((entry) => entry.name).join(', ')}`);
    if (stubbed.length) console.log(`  answered at the page's edge (system folder dialog cannot be answered): ${stubbed.join(', ')}`);
    console.log(`  入口: 首页「超级混剪」卡（homeCards.fission）-> StandaloneWorkspace(kind=fission) -> FissionWorkbench；无独立 URL 路由`);
    assert.deepEqual(broken, [], `links not passing: ${broken.map((entry) => `${entry.name} (${entry.said})`).join(' | ')}`);
  } finally {
    if (page && !page.isClosed() && links.some((entry) => !entry.ok)) await page.screenshot({ path: join(dir, 'failed.png') }).catch(() => {});
    /* The app asks its Studio to preserve before it goes, which under the load of these runs can outlast the run itself:
       the verdict is the links', so a quit that does not finish ends the app's whole process tree (an orphaned renderer
       keeps this process's pipes open, so the run would never end) instead of the test. */
    const quitting = app.close().catch(() => {});
    if (!(await Promise.race([quitting.then(() => true), sleep(30_000).then(() => false)]))) {
      const pid = app.process()?.pid;
      console.log(`  (the app did not quit within 30 s; ending its process tree${pid ? ` ${pid}` : ''})`);
      if (pid) {
        const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        try { execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { app.process()?.kill('SIGKILL'); } catch { /* already gone */ } }
      }
      await Promise.race([quitting, sleep(10_000)]);
    }
  }
});
