// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A clip dropped onto a track, while its file is coming.
 *
 * The material centre's cards are draggable (`MaterialCard`), and a drop of one is a download before a clip
 * (ProjectView's `dropMaterial`): the state lives in `lib/clip-download`, and the clip says it with `ClipDownloadBadge` —
 * the very component the timeline draws over each block, with the same `data-state` the timeline puts on the block.
 *
 *  ④ downloading → ready: the placeholder drawn where the clip will land shows the cover it already had, a turning ring
 *    and 「正在下载」; once the file is in the project the placeholder is replaced by the written clip, which says it
 *    landed (`data-state="ready"`) with its own first frame behind it, and the word then goes;
 *  ⑤ failed: the badge stays visible with a short reason — never a clip that turns forever.
 *
 * The screenshot this batch is reviewed on is written at the end: downloading and landed side by side, plus a failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { chromium } from 'playwright-core';

const UI = fileURLToPath(new URL('../', import.meta.url));
const WORKSPACE = resolve(UI, '../../../../..');
const SHOTS = join(WORKSPACE, 'docs/execution/2026-11-17-ui-batch');
const as_url = (path: string) => path.replaceAll('\\', '/');

const BADGE = as_url(join(UI, 'components/ClipDownloadBadge.tsx'));
const STORE = as_url(join(UI, 'lib/clip-download.ts'));
const I18N = as_url(join(UI, 'i18n/index.ts'));

/** A 1 × 1 PNG: what the cover route answers, so the badge's cover really loads. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Three clips of the kind the timeline draws: a picture band, and the badge over it. */
const harness = [
  "import React from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import './harness.css';",
  `import { ClipDownloadBadge, useClipDownloads } from '/@fs/${BADGE}';`,
  `import { beginDownload, downloadsOf, failDownload, resetDownloads, settleDownload, subscribeDownloads } from '/@fs/${STORE}';`,
  `import { setLanguageChoice } from '/@fs/${I18N}';`,
  "setLanguageChoice('zh-CN');",
  "/* what this page's store went through, one entry per change: what a run is meant to read, in order */",
  "const seen = []; window.__seen = seen;",
  "subscribeDownloads(() => seen.push([...downloadsOf().values()].map((d) => d.state).join('|')));",
  "window.__begin = (src, cover) => beginDownload(src, cover ? {cover} : {});",
  "window.__settle = (from, to) => settleDownload(from, to ?? from);",
  "window.__fail = (src, reason) => failDownload(src, reason);",
  "window.__reset = () => resetDownloads();",
  "/* the placeholder (its stand-in name), the clip really written after it, and one that failed */",
  "const CLIPS = [",
  "  {src: 'assets/materials/one.mp4', title: '拖入 · 正在下载'},",
  "  {src: 'assets/one.mp4', title: '拖入 · 已下载'},",
  "  {src: 'assets/materials/three.mp4', title: '拖入 · 下载失败'},",
  "];",
  "function Clip({src, title}) {",
  "  const downloads = useClipDownloads();",
  "  return <div data-fixture-clip={src} style={{width: 260}}>",
  "    <div className=\"relative overflow-hidden rounded-[4px] bg-[#2b3a4a]\" style={{height: 56}}>",
  "      {/* the clip's own picture, as the timeline's thumbnails / first frame are: what the badge gives way to */}",
  "      <div data-clip-frame=\"\" style={{position: 'absolute', inset: 0, background: 'linear-gradient(120deg, #3f6f52, #7ba36b 60%, #d8d2a8)'}} />",
  "      <ClipDownloadBadge download={downloads.get(src)} wide top={0} />",
  "    </div>",
  "    <p className=\"mt-1 truncate text-[12px]\">{title}</p>",
  "  </div>;",
  "}",
  "createRoot(document.getElementById('root')!).render(",
  "  <div className=\"flex gap-4 bg-[var(--bg-app)] p-4 text-[var(--text)]\">{CLIPS.map((clip) => <Clip key={clip.src} {...clip} />)}</div>,",
  ");",
].join('\n');

const harnessCss = `@import '@/globals.css';\n@source '${as_url(UI)}';\n`;

async function withPage(run: (page: import('playwright-core').Page) => Promise<void>) {
  const root = fileURLToPath(new URL('../../../../.dev/ui-batch-clip-download/', import.meta.url));
  await mkdir(root, { recursive: true });
  const fixture = await mkdtemp(join(root, 'attempt-'));
  await writeFile(join(fixture, 'index.html'), '<div id="root"></div><script type="module" src="/harness.tsx"></script>');
  await writeFile(join(fixture, 'harness.css'), harnessCss);
  await writeFile(join(fixture, 'harness.tsx'), harness);
  const vite = await createServer({
    configFile: false, root: fixture, cacheDir: join(fixture, '.vite-cache'),
    plugins: [react(), tailwind()],
    resolve: { alias: { '@': UI }, dedupe: ['react', 'react-dom'] },
    server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [fixture, UI, WORKSPACE] } },
    appType: 'spa',
  });
  const http = createHttpServer((request, response) => {
    if ((request.url ?? '').startsWith('/api/materials/cover')) {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      response.end(PIXEL);
      return;
    }
    vite.middlewares(request, response);
  });
  let browser;
  try {
    await new Promise<void>((done, fail) => { http.once('error', fail); http.listen(0, '127.0.0.1', () => done()); });
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORANGE_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 200 } });
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    await page.goto(`${origin}/`);
    await page.locator('[data-fixture-clip]').first().waitFor({ state: 'visible' });
    await run(page);
  } finally {
    await browser?.close();
    if (http.listening) await new Promise(done => http.close(done));
    await vite.close();
  }
}

const PLACE = '[data-fixture-clip="assets/materials/one.mp4"]';
const WRITTEN = '[data-fixture-clip="assets/one.mp4"]';
const BROKEN = '[data-fixture-clip="assets/materials/three.mp4"]';

/** ④ the clip says 正在下载 with the cover it had, then the clip that was written says it landed. */
test('④ a dropped clip goes downloading → ready', { timeout: 120000 }, async () => {
  await withPage(async (page) => {
    assert.equal(await page.locator('[data-clip-download]').count(), 0, 'a clip with nothing behind it says nothing');

    await page.evaluate(() => {
      const w = window as unknown as {__begin: (src: string, cover?: string) => void};
      w.__begin('assets/materials/one.mp4', '/api/materials/cover?url=%2Fupload%2Fone.jpg');
    });
    const badge = page.locator(PLACE + ' [data-clip-download]');
    await badge.waitFor({ state: 'visible' });
    assert.equal(await badge.getAttribute('data-state'), 'downloading', 'the clip says it is downloading');
    assert.equal(await badge.locator('[data-clip-spinner]').count(), 1, 'a turning ring, so it does not look stuck');
    assert.equal(await badge.locator('[data-clip-cover]').count(), 1, 'and the cover it already had, not a grey box');
    assert.match(await badge.innerText(), /正在下载/, 'with the word for it');

    /* the file lands: the placeholder goes, and the clip that was really written says so, with its own frame behind it */
    await page.evaluate(() => {
      const w = window as unknown as {__settle: (from: string, to?: string) => void};
      w.__settle('assets/materials/one.mp4', 'assets/one.mp4');
    });
    const landed = page.locator(WRITTEN + ' [data-clip-download]');
    await landed.waitFor({ state: 'visible' });
    assert.equal(await landed.getAttribute('data-state'), 'ready', 'downloading → ready, on the clip it became');
    assert.equal(await landed.locator('[data-clip-spinner]').count(), 0, 'the ring is gone: nothing is still coming');
    assert.equal(await landed.locator('[data-clip-cover]').count(), 0, 'and the supplier cover is gone too');
    assert.equal(await page.locator(PLACE + ' [data-clip-download]').count(), 0, 'the placeholder stopped saying it as well');
    assert.equal(await page.locator(WRITTEN + ' [data-clip-frame]').count(), 1, 'the clip\'s own first frame is what shows');
    assert.deepEqual(await page.evaluate(() => (window as unknown as {__seen: string[]}).__seen), ['downloading', 'ready'],
      'a run reads the two states, in that order');
  });
});

/** ⑤ a failed download is visible, says why, and does not turn forever. */
test('⑤ a failed download keeps a reason on the clip', { timeout: 120000 }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      const w = window as unknown as {__begin: (src: string) => void; __fail: (src: string, reason: string) => void};
      w.__begin('assets/materials/three.mp4');
      w.__fail('assets/materials/three.mp4', '无权下载');
    });
    const badge = page.locator(BROKEN + ' [data-clip-download]');
    await badge.waitFor({ state: 'visible' });
    assert.equal(await badge.getAttribute('data-state'), 'failed', 'the clip says it failed');
    assert.equal(await badge.getAttribute('role'), 'alert', 'and says it as a failure, not as a status');
    assert.equal(await badge.locator('[data-clip-spinner]').count(), 0, 'a failed clip does not keep turning');
    const text = await badge.innerText();
    assert.match(text, /下载失败/, 'it says what happened: ' + text);
    assert.match(text, /无权下载/, 'and why: ' + text);
  });
});

/** The screenshot: downloading, landed and failed, on three clips at once. */
test('the drop\'s three states, as one picture', { timeout: 120000 }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      const w = window as unknown as {
        __begin: (src: string, cover?: string) => void;
        __settle: (from: string, to?: string) => void;
        __fail: (src: string, reason: string) => void;
      };
      w.__begin('assets/materials/one.mp4', '/api/materials/cover?url=%2Fupload%2Fone.jpg');
      w.__begin('assets/two.mp4');
      w.__settle('assets/two.mp4');
      /* the written clip of the first one, too: it is where the ready state ends up */
      w.__begin('assets/one.mp4');
      w.__settle('assets/one.mp4');
      w.__begin('assets/materials/three.mp4');
      w.__fail('assets/materials/three.mp4', '无权下载');
    });
    await page.locator('[data-clip-download][data-state="downloading"]').first().waitFor({ state: 'visible' });
    await page.locator('[data-clip-download][data-state="ready"]').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, '03-clip-download-states.png') });
  });
});

/** The wiring in the two files a browser test cannot mount cheaply: the timeline draws it, the drop starts it. */
test('the timeline draws the state and the drop is what starts it', () => {
  const timeline = readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8');
  assert.match(timeline, /<ClipDownloadBadge download=\{download\} wide=\{width > 64\} top=\{INFO_H\} \/>/,
    'every block draws the badge for its own src');
  assert.match(timeline, /data-state=\{download\?\.state\}/, 'and the block carries the state in its own right');
  assert.match(timeline, /useClipDownloads\(\)/, 'one subscription for the whole timeline');
  assert.match(timeline, /\$\{download\?\.state \?\? ''\}/, 'a change of state rebuilds that clip (it is part of its pose)');

  const drop = readFileSync(new URL('./ProjectView.tsx', import.meta.url), 'utf8');
  assert.match(drop, /if \(file\.material\) return dropMaterial\(/, 'a material dragged onto a track takes the download path');
  assert.match(drop, /beginDownload\(key, /, 'downloading from the moment it is dropped');
  assert.match(drop, /settleDownload\(key, landed\)/, 'ready on the clip that was really written');
  assert.match(drop, /failDownload\(key, reason\)/, 'failed with a reason, never a spinner that runs forever');
  assert.match(drop, /await api\.takeSaved\(projectId, taken\.landed\)/, 'the file is taken into the project before the clip is written');
});
