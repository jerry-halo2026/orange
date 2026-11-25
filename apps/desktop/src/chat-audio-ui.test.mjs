// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from 'orangefilm/studio';
import shellConfig from '../shell/vite.config.ts';

function wav(size) {
  const bytes = Buffer.alloc(44, 0);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(size + 36, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34); bytes.write('data', 36); bytes.writeUInt32LE(size, 40);
  return bytes;
}

/**
 * A project call made while the project-control lock is free. Every project read and write passes through that lock,
 * and the lock is one file for every Studio on the machine (`%USERPROFILE%\.orangefilm-control-coordination` when no
 * isolated profile is set): a suite running beside this one, or a Studio someone left open, holds it for a few
 * milliseconds and the guard answers 409 `control-busy`. Waiting it out is what the app itself does
 * (`project-control-guard.mjs` retries with `Atomics.wait`) — only the setup waits here, every assertion below is
 * unchanged, and one that is never satisfied still fails. `Atomics.wait`, not a timer, so a retry cannot outlive the
 * turn that asked for it.
 */
async function projectCall(studio, path, init = {}) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${studio.origin}${path}`, { ...init, headers: { 'x-studio-key': studio.key, ...init.headers } });
    const body = await response.text();
    /* 400 × 25 ms: the guard's own hold is a single write, so this is a margin against a busy machine, not a wait for work */
    if (response.status !== 409 || !body.includes('control-busy') || attempt >= 400) return { response, body };
    Atomics.wait(pause, 0, 0, 25);
  }
}

test('chat audio uses Studio file URLs: playback, ranges, large files and project boundaries', { timeout: 60_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orangefilm-markdown-audio-'));
  const names = ['ORANGE_HOME', 'ORANGE_LIBRARY', 'ORANGE_TRASH_DIR', 'ORANGE_SHARED_HOME'];
  const env = new Map(names.map(name => [name, process.env[name]]));
  process.env.ORANGE_HOME = join(dir, 'home');
  process.env.ORANGE_LIBRARY = join(dir, 'library');
  process.env.ORANGE_TRASH_DIR = join(dir, 'trash');
  delete process.env.ORANGE_SHARED_HOME;
  let studio, server, browser;
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    /* The project-control lock is one file for every Studio on this machine, so a sibling test process holding it for a
       few milliseconds is not a failure of this page: the setup waits it out (as the guard itself does), while every
       assertion below is unchanged and still fails if the project is never made. */
    const made = await projectCall(studio, '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Audio' }) });
    assert.equal(made.response.status, 200, made.body);
    const { project } = JSON.parse(made.body);
    const assets = join(project.path, 'assets'); mkdirSync(assets, { recursive: true });
    const voice = Buffer.concat([wav(8000), Buffer.alloc(8000, 128)]);
    writeFileSync(join(assets, '声音 A.wav'), voice);
    writeFileSync(join(dir, 'outside.wav'), voice);
    const largeSize = 36 * 1024 * 1024;
    writeFileSync(join(assets, 'large.wav'), wav(largeSize));
    truncateSync(join(assets, 'large.wav'), largeSize + 44);
    let linked = true;
    try { symlinkSync(join(dir, 'outside.wav'), join(assets, 'link.wav')); }
    catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) linked = false; else throw error; }
    /* The same lock is taken by this read, and a refusal here used to leave `folder` undefined and fail the assertion
       below with no reason given. */
    const details = await projectCall(studio, `/api/projects/${project.id}`);
    assert.equal(details.response.status, 200, details.body);
    const metadata = JSON.parse(details.body);
    const folder = metadata.folder;
    assert.ok(folder && new URL(folder).pathname.startsWith('/p/'));
    server = await createServer({
      ...shellConfig, configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: studio.origin, changeOrigin: true, headers: { 'x-studio-key': studio.key } } } },
      logLevel: 'error',
      plugins: [...shellConfig.plugins, {
        name: 'markdown-audio-fixture',
        configureServer(app) {
          app.middlewares.use('/markdown-audio', (_req, res, next) => {
            res.setHeader('content-type', 'text/html');
            void app.transformIndexHtml('/markdown-audio', '<!doctype html><html><body><div id="root"></div><script type="module" src="/bench/markdown-audio.tsx"></script></body></html>')
              .then(html => res.end(html), next);
          });
        },
      }],
    });
    await server.listen();
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      const why = String(error?.message ?? error);
      // A missing downloaded browser is a machine prerequisite, not a result:
      // report it as an explicit skip naming what is missing.
      if (/Executable doesn't exist|playwright install|Looks like Playwright was just installed/i.test(why)) {
        t.skip(`missing prerequisite: Playwright browser is not installed (${why.split('\n').find(line => /Executable doesn't exist/.test(line)) ?? 'run: pnpm exec playwright install'})`);
        return;
      }
      throw error;
    }
    /* Every wait here is "the page's own app has run", and the page comes from a cold vite dev server that transforms
       React and Lexical module by module on the first request. Eight seconds was measured against a warm cache and on
       an idle machine; with the rest of the suite running beside it the same waits timed out and reported a browser
       error instead of a result. The test's own timeout stays the outer bound. */
    const page = await browser.newPage(); page.setDefaultTimeout(30_000);
    await page.addInitScript(project => {
      window.audioProject = project; window.audioCalls = [];
      window.orangefilmDesktop = { chat: { audio: async (_project, href) => { window.audioCalls.push(href); throw new Error('Audio must use Studio, never a native file-reading IPC'); } } };
    }, project);
    let popups = 0;
    const errors = [], mediaRequests = [];
    /* What the page's own API calls did: when the wait below times out, this is the difference between "the page never
       ran" and "the project read was refused", and the failure message has to say which. */
    const apiCalls = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/')) apiCalls.push(`${response.status()} ${url.pathname}${url.search}`);
    });
    page.on('requestfailed', (request) => apiCalls.push(`failed ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ''}`));
    page.on('popup', () => { popups++; }); page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (new URL(req.url()).pathname.endsWith('.wav')) mediaRequests.push(req.url()); });
    /* The first request makes vite build the shell and its imports, which an 8 s element-wait budget does not cover on
       a machine that is already running other suites: the load then failed as a timeout instead of a result. The
       navigation gets a deadline of its own; every wait after it keeps the page's shorter one. */
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/markdown-audio`, { timeout: 30_000 });
    /* The page sets `window.audioFolder` once it has read the project from the Studio API; a refusal there leaves it
       unset forever, so the timeout says what the API calls and the page's own errors were. */
    try {
      await page.waitForFunction(() => window.audioFolder);
    } catch (error) {
      throw new Error(`${error.message}\napi: ${JSON.stringify(apiCalls)}\npage errors: ${JSON.stringify(errors)}`);
    }
    assert.equal(await page.evaluate(() => window.audioFolder), folder, 'the real project API supplies the folder');
    await page.getByRole('button', { name: 'Voice A', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '声音 A.wav' });
    await dialog.waitFor();
    const audio = dialog.locator('audio');
    assert.equal(await audio.getAttribute('src'), new URL('assets/%E5%A3%B0%E9%9F%B3%20A.wav', folder).href, 'stream directly from the project folder, never native bytes or a blob');
    await audio.evaluate(async el => { await el.play(); });
    assert.equal(await audio.evaluate(el => el.paused), false);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.evaluate(() => document.querySelectorAll('audio').length), 0, 'closing unmounts the player');
    await t.test('range requests and files larger than the removed IPC limit', async () => {
      const response = await fetch(new URL('assets/large.wav', folder), { headers: { Range: 'bytes=0-43' } });
      assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 44);
      assert.equal(response.headers.get('content-range'), `bytes 0-43/${largeSize + 44}`);
      await page.getByRole('button', { name: 'Large', exact: true }).click();
      const large = page.getByRole('dialog', { name: 'large.wav' });
      await large.waitFor();
      await large.locator('audio').evaluate(el => new Promise((done, fail) => { if (el.readyState >= 1) return done(); el.addEventListener('loadedmetadata', done, { once: true }); el.addEventListener('error', fail, { once: true }); }));
      assert.equal(await large.locator('audio').evaluate(el => el.duration), largeSize / 8000);
      await large.getByRole('button', { name: 'Close', exact: true }).click();
    });
    await t.test('parent and encoded-parent links never request another project or the Studio shell', async () => {
      for (const name of ['Parent', 'Encoded parent']) {
        const before = mediaRequests.length;
        await page.getByRole('button', { name, exact: true }).click();
        await page.getByRole('alert').last().waitFor();
        assert.equal(mediaRequests.length, before);
        assert.equal(await page.getByRole('dialog').count(), 0);
      }
    });
    const failedPreview = async (label, name) => {
      await page.getByRole('button', { name: label, exact: true }).click();
      const dialog = page.getByRole('dialog', { name }); await dialog.waitFor();
      await dialog.getByText('This file could not be read', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    };
    await t.test('missing audio shows the existing player error', () => failedPreview('Missing', 'missing.wav'));
    await t.test('unapproved symlinks cannot disclose bytes outside the project', { skip: !linked && 'Windows requires symlink permission' }, async () => {
      const response = await fetch(new URL('assets/link.wav', folder)); assert.equal(response.status, 404);
      assert.notDeepEqual(Buffer.from(await response.arrayBuffer()), voice);
      await failedPreview('Link', 'link.wav');
    });
    assert.deepEqual(await page.evaluate(() => window.audioCalls), [], 'no audio-reading IPC is called');
    assert.equal(popups, 0); assert.deepEqual(errors, []);
    assert.ok(mediaRequests.every(url => url.startsWith(folder)), 'every audio request stays under this project token');
    assert.equal(await page.getByRole('link', { name: 'Website', exact: true }).getAttribute('href'), 'https://example.com/');
  } finally {
    await browser?.close(); await server?.close(); await studio?.close();
    for (const [name, value] of env) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
});
