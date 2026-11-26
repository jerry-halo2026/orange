// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The main chain, end to end, in the bench's own app: sign in → open a film → the material drawer's cloud-steward tab →
 * a still from the pane onto the timeline → an export, queued in the title bar. Needs `.dev/bench-auth.env` (the
 * bench's own account); without it the test is skipped rather than run signed out, where every call is 403.
 *
 * Every step is reported, and the ones after a broken step still run: a smoke run says which link of the chain is
 * open, not only that one is. The film is made here rather than taken from bench/fixture — 3 seconds of one still is
 * short enough to export in one breath and needs no footage encoded with ffmpeg first. The still is written here too
 * (png below), so the run needs no ffmpeg of its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { filmHtml } from 'orangefilm/film-doc';
import { DESKTOP, prepare, signIn, withBenchAuth } from './app.mjs';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* A PNG of one flat colour: the pane's still, written without ffmpeg (this test runs on any machine). */
const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();
const crc32 = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const at = y * (width * 3 + 1) + 1 + x * 3; raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
    const body = Buffer.concat([head, data]);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([body, tail]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('the bench app signs in, opens a film, the cloud-steward tab answers, a still goes onto the timeline and an export is queued in the title bar', { timeout: 600_000 }, async (t) => {
  const auth = withBenchAuth(t);
  if (!auth) return;
  const dir = join(DESKTOP, '.dev', `orange-smoke-${Date.now()}`);
  prepare(dir);
  const { PATH } = await loginShellEnvironment();
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: [DESKTOP], cwd: DESKTOP,
    env: { ...launcherEnvironment(process.env, PATH), ORANGE_DESKTOP_FLAVOR: 'bench', ORANGE_BENCH_DIR: dir },
  });
  let page;
  /** Each link of the chain, as it went: the run's own report, whatever the verdict turns out to be. */
  const links = [];
  const link = async (name, work) => {
    try {
      const said = await work();
      links.push({ name, ok: true, said: said ?? '' });
      console.log(`  ok   ${name}${said ? `: ${said}` : ''}`);
      return true;
    } catch (error) {
      links.push({ name, ok: false, said: error?.message ?? String(error) });
      console.log(`  fail ${name}: ${error?.message ?? error}`);
      if (page && !page.isClosed()) await page.screenshot({ path: join(dir, `failed-${name.replace(/[^\w-]+/g, '-')}.png`) }).catch(() => {});
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
    /** Studio's own window asks from its own origin; the launch key is the page's, as the app keeps it. */
    const call = async (path, body) => {
      const response = await fetch(`${run.origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-studio-key': run.key, origin: run.origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    /** Every clip of the film as Studio has it, read back from the route the editor uses. */
    const clipsOf = async () => {
      const answer = await call(`/api/projects/${project.id}`);
      assert.equal(answer.status, 200, `reading the film: HTTP ${answer.status}`);
      return (answer.body?.value?.tracks ?? []).flatMap((track) => track.clips ?? []);
    };
    let project = null;

    /* 1. Sign in: the gate every route below passes (auth-gate.test.mjs proves it shut before this). */
    await link('sign-in', async () => {
      await signIn(run, auth);
      const state = await call('/api/auth/state');
      assert.equal(state.body?.kind, 'active', `the session is ${state.body?.kind} (${state.body?.reason ?? 'no reason'})`);
      return 'active';
    });

    /* 2. A short film of this account's, made here: 3 seconds of one still. */
    const made = await link('open-film', async () => {
      const created = await call('/api/projects', { name: 'Orange smoke' });
      assert.equal(created.status, 200, `making the film: HTTP ${created.status} (${created.body?.code ?? 'no code'})`);
      project = created.body.project;
      mkdirSync(join(project.path, 'assets'), { recursive: true });
      writeFileSync(join(project.path, 'assets', 'still.png'), png(320, 180, [220, 90, 60]));
      writeFileSync(join(project.path, 'film.html'), filmHtml({
        stage: { w: 1920, h: 1080 },
        tracks: [{ clips: [{ src: 'assets/still.png', id: 'still', at: 0, time: [0, 3], box: { x: 0, y: 0, w: 1920, h: 1080 } }] }],
      }));
      const opened = await call('/api/open', { path: project.path, fallback: 0 });
      assert.equal(opened.status, 200, `opening the film: HTTP ${opened.status} (${opened.body?.code ?? 'no code'})`);
      return project.id;
    });

    /* 3. The window on that film, in the bench's language. */
    const windowed = await link('window', async () => {
      if (!made) throw new Error('no film was opened');
      for (let attempt = 0; attempt < 300 && !page; attempt += 1) {
        page = app.context().pages().find((candidate) => candidate.url().includes('/projects/'));
        if (!page) await sleep(100);
      }
      assert.ok(page, 'the film never opened in the window');
      await page.waitForSelector('[data-timeline]', { timeout: 90_000 });
      await page.evaluate(() => localStorage.setItem('orangefilm.language', 'zh-CN'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-timeline]', { timeout: 90_000 });
      return 'the film on screen';
    });

    /* 4. The material drawer, on the cloud steward's tab: unbound, the card that asks for an account; bound, the
        合集 with the same library (search and filters) under them. */
    const drawer = await link('material-drawer', async () => {
      if (!windowed) throw new Error('no window');
      await page.getByRole('button', { name: '素材', exact: true }).click();
      await page.locator('[data-media-path], [data-state]').first().waitFor({ timeout: 30_000 });
      return 'open';
    });
    const steward = await link('cloud-tab', async () => {
      if (!drawer) throw new Error('no drawer');
      const paneTab = page.locator('[data-scope-tab="cloud"]');
      if (await paneTab.count()) await paneTab.first().click();
      else await page.getByRole('button', { name: '云管家', exact: true }).click();
      const state = page.locator('[data-state="unbound"], [data-state="bound"]');
      const seen = await state.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      assert.ok(seen, 'the cloud steward did not answer: the drawer\'s 云管家 left the project\'s own media showing (ProjectView\'s drawer pool has no cloud scope)');
      if (await page.locator('[data-state="unbound"]').count()) {
        await page.locator('[data-card="binding"]').waitFor({ timeout: 10_000 });
        assert.equal(await page.locator('[data-action="claim-binding"]').count(), 1, 'the unbound card asks for an account');
        return 'unbound, the binding card';
      }
      await page.locator('[data-collections]').waitFor({ timeout: 10_000 });
      assert.equal(await page.locator('[data-filter="search"]').count(), 1, 'the cloud list has the library\'s search');
      assert.ok((await page.locator('[data-filter="category"]').count()) >= 1, 'the cloud list has the library\'s filters');
      return 'bound, collections + search + filters';
    });

    /* 5. A still from the pane onto the timeline: picked, then Enter (the pane's own "put it on the timeline", as its
        + does), landing as one more clip of the film. */
    const inserted = await link('insert-still', async () => {
      if (!windowed) throw new Error('no window');
      // The still lives in the project's own media, so go back to the import tab first; whether the
      // cloud tab is bound (or still loading its binding) must not decide which pane this step looks at.
      await page.getByRole('button', { name: '导入', exact: true }).click();
      const card = page.locator('[data-media-path="assets/still.png"]').first();
      await card.waitFor({ timeout: 30_000 });
      const before = await clipsOf();
      await card.click();
      await page.keyboard.press('Enter');
      let after = before;
      for (let attempt = 0; attempt < 100 && after.length <= before.length; attempt += 1) {
        await sleep(100);
        after = await clipsOf();
      }
      assert.ok(after.length > before.length, `the still did not reach the timeline: ${before.length} clip(s) before, ${after.length} after`);
      return `${before.length} → ${after.length} clips`;
    });

    /* 6. An export of this short film at 720p, and its job in the title bar's queue. */
    await link('export-queued', async () => {
      if (!windowed) throw new Error('no window');
      await page.getByRole('button', { name: '导出', exact: true }).first().click();
      const dialog = page.getByRole('dialog', { name: '导出', exact: true });
      await dialog.waitFor({ timeout: 30_000 });
      await dialog.getByRole('button', { name: /^720p/ }).first().click();
      await dialog.getByRole('button', { name: '导出', exact: true }).last().click();
      const queue = page.locator('[data-export-queue-trigger]');
      const queued = await queue.first().waitFor({ timeout: 60_000 }).then(() => true, () => false);
      assert.ok(queued, 'the title bar showed no export queue');
      const headline = String(await queue.first().getAttribute('aria-label'));
      await queue.first().click();
      await page.locator('[data-export-queue]').waitFor({ timeout: 10_000 });
      const jobs = await page.locator('[data-export-queue] li').allTextContents();
      assert.ok(jobs.length >= 1, 'the queue listed no job');
      return `${jobs.length} job queued, the title bar says "${headline}"`;
    });

    const broken = links.filter((entry) => !entry.ok);
    console.log(`Orange smoke: ${links.length - broken.length}/${links.length} links ok, artifacts ${dir}`);
    assert.deepEqual(broken, [], `links not passing: ${broken.map((entry) => `${entry.name} (${entry.said})`).join(' | ')}`);
  } finally {
    if (page && !page.isClosed() && links.some((entry) => !entry.ok)) await page.screenshot({ path: join(dir, 'failed.png') }).catch(() => {});
    /* The app asks its Studio to preserve before it goes, which under this load can outlast the run itself: the
       verdict is the links', so a quit that does not finish inside ten seconds ends the whole process tree instead
       of leaving the test to hang until the runner's own timeout. */
    const pid = app.process()?.pid;
    await Promise.race([app.close().catch(() => {}), new Promise((done) => setTimeout(done, 10_000))]);
    if (pid) {
      const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      try { execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { app.process()?.kill('SIGKILL'); } catch { /* already gone */ } }
    }
  }
});
