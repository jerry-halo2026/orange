// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The drawer's filter bar at the drawer's own width, measured in a browser.
 *
 * A width is a layout fact, not a class list: this test renders the real page in a real 268px column with the app's
 * real stylesheet, and reads the boxes back. What it holds: the bar is the drawer's own shape — one `h-7` line whose
 * search box takes every pixel the icon buttons do not (it used to be ≈0px wide, with the author's fixed 200px eating
 * the row), the search really takes typing, the author is a 28px icon button on that same line (it was a full-width
 * select on a line of its own), and the line never folds. The same page is then measured at full width, so the shape is
 * not a narrow-only special case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { chromium } from 'playwright-core';

const UI = fileURLToPath(new URL('../', import.meta.url));
const WORKSPACE = resolve(UI, '../../../../..');
const as_url = (path: string) => path.replaceAll('\\', '/');

const PAGE = as_url(join(UI, 'components/material-center/MaterialCenterPage.tsx'));
const CONTROLLER = as_url(join(UI, 'lib/material-center/controller.ts'));
const CLIENT = as_url(join(UI, 'lib/material-center/client.ts'));
const COPY = as_url(join(UI, 'lib/material-center/copy.ts'));

/** A page the read-only client accepts: three rows, the way the supplier sends them. */
const pageBody = {
  authorization: { layer: 'self', reason: 'own-account-key' }, providerScope: 's', pageNo: 1, pageSize: 20,
  items: [1, 2, 3].map(index => ({
    videoId: { value: 'video_' + index, sourceType: 'string', source: 'video_' + index },
    observation: { name: '产品视频 ' + index, coverUrl: '/cover-' + index + '.jpg', durationSec: 12 },
  })),
  total: { sourceType: 'number', source: '178391' }, providerTotal: 178391, totalIsProviderTotal: true,
  filtered: { inspected: 20, dropped: 0 }, grants: false,
};
const facetsBody = {
  authorization: { layer: 'self', reason: 'own-account-key' }, providerScope: 's', videoType: 1,
  oneLevel: [], twoLevel: [], states: [], publicLabels: [], labelTotal: null,
};

/** The harness: the real page, in a box whose width this test sets; the app's own stylesheet, so the reading is real. */
const harness = [
  "import React from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import './harness.css';",
  `import { MaterialCenterPage } from '/@fs/${PAGE}';`,
  `import { createMaterialCenterController } from '/@fs/${CONTROLLER}';`,
  `import { createMaterialsClient } from '/@fs/${CLIENT}';`,
  `import { copyFor } from '/@fs/${COPY}';`,
  `const pageBody = ${JSON.stringify(pageBody)};`,
  `const facetsBody = ${JSON.stringify(facetsBody)};`,
  "const fetcher = async (url: string) => new Response(JSON.stringify(String(url).includes('/facets') ? facetsBody : pageBody), {status: 200, headers: {'content-type': 'application/json; charset=utf-8'}});",
  "const client = createMaterialsClient({fetch: fetcher});",
  "const controller = createMaterialCenterController({client});",
  "const width = Number(new URLSearchParams(location.search).get('w') ?? 268);",
  "function Drawer() {",
  "  return <div id=\"outside\" className=\"bg-neutral-200 p-0\"><div id=\"drawer\" style={{width}} className=\"bg-[var(--bg-app)] text-[var(--text)]\">",
  "    <MaterialCenterPage controller={controller} copy={copyFor('zh-CN')} list={client.list} binding={null} bindingKnown draft={[]} draftReady={false} onDraftOperation={async () => true} />",
  "  </div></div>;",
  "}",
  "createRoot(document.getElementById('root')!).render(<Drawer />);",
].join('\n');

/** The app's stylesheet, plus the component tree Tailwind would not find from a fixture outside `studio/ui`. */
const harnessCss = `@import '@/globals.css';\n@source '${as_url(UI)}';\n`;

test('at the drawer\'s 268px the search box has a real width on one h-7 line, with the author beside it', { timeout: 120000 }, async () => {
  const root = fileURLToPath(new URL('../../../../.dev/drawer-width-ui/', import.meta.url));
  await mkdir(root, { recursive: true });
  const fixture = await mkdtemp(join(root, 'attempt-'));
  await writeFile(join(fixture, 'index.html'), '<div id="root" class="bg-neutral-200"></div><script type="module" src="/harness.tsx"></script>');
  await writeFile(join(fixture, 'harness.css'), harnessCss);
  await writeFile(join(fixture, 'harness.tsx'), harness);
  const vite = await createServer({
    configFile: false, root: fixture, cacheDir: join(fixture, '.vite-cache'),
    plugins: [react(), tailwind()],
    resolve: { alias: { '@': UI }, dedupe: ['react', 'react-dom'] },
    server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [fixture, UI, WORKSPACE] } },
    appType: 'spa',
  });
  const http = createHttpServer(vite.middlewares);
  let browser;
  try {
    await new Promise<void>((done, fail) => { http.once('error', fail); http.listen(0, '127.0.0.1', () => done()); });
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORANGE_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

    await page.goto(`${origin}/?w=268`);
    const search = page.locator('input[data-filter="search"]');
    await search.waitFor({ state: 'visible' });
    const author = page.locator('[data-filter="author"]');
    await author.waitFor({ state: 'visible' });

    /* ① the search is a box with a width, inside the drawer, and it really takes what is typed into it. */
    const box = await search.boundingBox();
    assert.ok(box, 'the search box is laid out');
    assert.ok(box.width > 100, `the search box has a usable width at 268px (${box.width}px, it was ≈0 before)`);
    assert.ok(box.x + box.width <= 268.5, `it stays inside the 268px column (right edge ${box.x + box.width}px)`);
    await search.fill('风景');
    assert.equal(await search.inputValue(), '风景', 'typing lands in the search box');

    /* ② one line: the bar is h-7, the author is a 28px icon button on the same row, to the right of the field. */
    const bar = await page.locator('[data-filter-bar]').boundingBox();
    assert.ok(bar && bar.height >= 24 && bar.height <= 32, `the bar is one h-7 line (${bar?.height ?? 0}px)`);
    const button = await author.boundingBox();
    assert.ok(button && button.height >= 24 && button.height <= 32, `the author is one icon button (${button?.height ?? 0}px)`);
    assert.ok(Math.abs((button!.y + button!.height / 2) - (box.y + box.height / 2)) < 6, 'the two sit on the same line');
    assert.ok(button!.x >= box.x + box.width, 'the author is beside the search, not over it');
    /* and nothing folds: the bar's one line is its whole height (no second row of wrapped controls) */
    const folded = await page.locator('[data-filter-bar]').evaluate(bar => bar.scrollHeight - bar.clientHeight);
    assert.ok(folded <= 1, `the bar does not wrap (${folded}px of overflow)`);

    /* ③ the scope is a menu of the two choices, and "mine" is not offered before a claim exists. */
    await author.click();
    await page.locator('[data-author-menu]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-author-option="cloud:own"]').isDisabled(), true, '"mine" needs a claimed account');
    assert.equal(await page.locator('[data-author-option]').count(), 2, 'company and mine, nothing else');
    await page.locator('[data-author-option="cloud:company"]').click();
    assert.equal(await page.locator('[data-author-menu]').count(), 0, 'a pick closes the menu');

    /* ④ the same page at full width: the search grows, nothing is a narrow-only special case. */
    await page.goto(`${origin}/?w=900`);
    const wideSearch = page.locator('input[data-filter="search"]');
    await wideSearch.waitFor({ state: 'visible' });
    const wide = await wideSearch.boundingBox();
    assert.ok(wide && wide.width > box.width, `the search uses the room it has at 900px (${wide?.width ?? 0}px)`);
    await wideSearch.fill('产品');
    assert.equal(await wideSearch.inputValue(), '产品', 'and it takes typing there too');
  } finally {
    await browser?.close();
    if (http.listening) await new Promise(done => http.close(done));
    await vite.close();
  }
});
