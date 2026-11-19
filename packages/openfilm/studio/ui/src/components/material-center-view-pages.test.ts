// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The material centre as a person meets it, measured in a browser: what the pane opens on, what it no longer says, and
 * where the supplier's pager is.
 *
 *  ① 合集 first — the pane opens on the 批次 → 合集 → 子合集 tree, with no press, and 视频 is the toggle's other side (a
 *    press switches to the wall and is remembered);
 *  ② the three lines that explained the read instead of the material are not on screen (the supplier's pageable/claimed
 *    arithmetic, 索引来源：已落盘…, and 只读素材列表：…), while the two notes that carry information a person acts on stay
 *    (共 N 个派生批次… and the collapsed 未归类 line);
 *  ③ the pager is the video wall's, at the foot of the wall: the 合集 view has no pager at all (it is the whole index, not
 *    a page of it), and the video view's is a row of its own under the wall, saying where the page is and nothing internal.
 *
 * It also writes the two screenshots this batch is reviewed on: the default 合集 view, and a 子合集 with its 加载更多 at
 * the foot of its wall.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

const PAGE = as_url(join(UI, 'components/material-center/MaterialCenterPage.tsx'));
const CONTROLLER = as_url(join(UI, 'lib/material-center/controller.ts'));
const CLIENT = as_url(join(UI, 'lib/material-center/client.ts'));
const COPY = as_url(join(UI, 'lib/material-center/copy.ts'));

/** A 1 × 1 PNG: the cover route's answer, so a `img` really loads and `data-cover` can be read. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** 45 derived batches: more than the stage lists, so its 「共 N 个派生批次…」 note is on screen. */
const DERIVED = Array.from({length: 45}, (_, at) => ({id: 'derived:d' + at, name: '12.' + String(at + 1).padStart(2, '0'), count: 1, videoIds: ['d' + at], derived: true}));

/** The tree the view is handed: one real batch with two 子合集, 45 派生批次, one 未归档 bucket, one unassigned name. */
const readyIndex = {
  state: 'ready', source: 'probing', generatedAt: null, stale: false, rows: 57,
  index: {
    schema: 'material-index@1',
    generatedAt: '2026-11-16T00:00:00.000Z',
    totals: {videos: 57, parsed: 6, unclassified: 51},
    batches: [{
      id: '20261106', name: '20261106', count: 6,
      products: [{
        id: '20261106-柠檬宝藏茶200g罐', name: '柠檬宝藏茶200g罐', count: 6,
        groups: [
          {id: '20261106-柠檬宝藏茶200g罐-外包装', name: '外包装', count: 4, videoIds: ['c1', 'c2', 'c3', 'c4']},
          {id: '20261106-柠檬宝藏茶200g罐-茶干', name: '茶干', count: 2, videoIds: ['c5', 'c6']},
        ],
      }],
    }],
    unclassified: [{videoId: 'x1', name: 'IMG_2525'}],
    derived: {
      count: 51,
      batches: DERIVED,
      groups: {
        id: 'derived:unfiled', name: '未归档', count: 1, derived: true,
        groups: [{id: 'derived:unfiled:汤色', name: '汤色', count: 1, videoIds: ['u1'], derived: true}],
      },
      unassigned: 5,
    },
  },
};

const facetsBody = {
  authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', videoType: 1,
  oneLevel: [], twoLevel: [], states: [], publicLabels: [], labelTotal: null,
};

/** The page the harness draws; the fetcher answers per `name=` so a prefix read and a plain read are told apart. */
const harness = [
  "import React from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import './harness.css';",
  `import { MaterialCenterPage } from '/@fs/${PAGE}';`,
  `import { createMaterialCenterController } from '/@fs/${CONTROLLER}';`,
  `import { createMaterialsClient } from '/@fs/${CLIENT}';`,
  `import { copyFor } from '/@fs/${COPY}';`,
  `const index = ${JSON.stringify(readyIndex)};`,
  `const facetsBody = ${JSON.stringify(facetsBody)};`,
  "const asked = []; window.__asked = asked;",
  "const json = (body) => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json; charset=utf-8'}});",
  "const rowsOf = (name, count) => Array.from({length: count}, (_, at) => ({",
  "  videoId: {value: (name ? 'c' : 'p') + at, sourceType: 'string', source: (name ? 'c' : 'p') + at},",
  "  observation: {name: (name ? name + ' (' + (at + 1) + ')' : '产品视频 ' + (at + 1)), coverUrl: '/upload/' + (name ? encodeURIComponent(name) : 'pool') + '-' + at + '.jpg', durationSec: 12},",
  "}));",
  "const fetcher = async (url) => {",
  "  asked.push(String(url));",
  "  const where = new URL(String(url), location.origin);",
  "  if (where.pathname.endsWith('/facets')) return json(facetsBody);",
  "  const name = where.searchParams.get('name');",
  "  const size = Number(where.searchParams.get('pageSize') ?? 20);",
  "  /* the list has more behind it (24 rows, one page shown); a group has 108 rows, read 100 at a time */",
  "  const rows = rowsOf(name, name ? size : Math.min(size, 20));",
  "  const total = name ? 108 : 24;",
  "  return json({authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', pageNo: 1, pageSize: size,",
  "    items: rows, total: {sourceType: 'number', source: String(total)}, providerTotal: total, totalIsProviderTotal: true,",
  "    filtered: {inspected: rows.length, dropped: 0}, grants: false});",
  "};",
  "const client = createMaterialsClient({fetch: fetcher});",
  "const controller = createMaterialCenterController({client});",
  "const width = Number(new URLSearchParams(location.search).get('w') ?? 900);",
  "function Drawer() {",
  "  return <div id=\"outside\" className=\"bg-neutral-200 p-0\"><div id=\"drawer\" style={{width}} className=\"bg-[var(--bg-app)] text-[var(--text)]\">",
  "    <MaterialCenterPage controller={controller} copy={copyFor('zh-CN')} index={index} list={client.list} binding={null} bindingKnown",
  "      draft={[]} draftReady={false} onDraftOperation={async () => true} />",
  "  </div></div>;",
  "}",
  "createRoot(document.getElementById('root')!).render(<Drawer />);",
].join('\n');

/** The app's stylesheet, plus the component tree Tailwind would not find from a fixture outside `studio/ui`. */
const harnessCss = `@import '@/globals.css';\n@source '${as_url(UI)}';\n`;

/** The real page in a box of the width this test sets, with a cover route that answers an image. */
async function withPage(run: (page: import('playwright-core').Page, url: (query: string) => string) => Promise<void>) {
  const root = fileURLToPath(new URL('../../../../.dev/ui-batch-view/', import.meta.url));
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
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 1000 } });
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    await run(page, (query: string) => `${origin}/?${query}`);
  } finally {
    await browser?.close();
    if (http.listening) await new Promise(done => http.close(done));
    await vite.close();
  }
}

const COLLECTION = '[data-collection-card="20261106-柠檬宝藏茶200g罐"]';
const GROUP = '[data-group-card="20261106-柠檬宝藏茶200g罐-外包装"]';

/** ① the pane opens on 合集: no press, no stored choice, and 视频 is the toggle's other side. */
test('① the material centre opens on 合集, and 视频 is one press away', { timeout: 120000 }, async () => {
  await withPage(async (page, url) => {
    await page.goto(url('w=900'));
    await page.locator('[data-collections]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-collections]').count(), 1, 'the tree is what the pane opens on');
    assert.equal(await page.locator('[data-view-pane="cards"]').count(), 0, 'the wall of every video is not drawn first');

    const toggle = page.locator('[data-view-toggle]');
    assert.equal(await toggle.getAttribute('data-view-toggle'), 'collections', 'the toggle says which view is on');
    assert.equal(await page.locator('[data-view-mode="collections"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-view-mode="videos"]').getAttribute('aria-pressed'), 'false', '视频 kept as the other side');

    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, '01-default-collections.png') });

    /* the press is the switch, and it is remembered for the visit */
    await page.locator('[data-view-mode="videos"]').click();
    await page.locator('[data-view-pane="cards"]').first().waitFor({ state: 'visible' });
    assert.equal(await toggle.getAttribute('data-view-toggle'), 'videos', 'the toggle follows the press');
    await page.locator('[data-view-mode="collections"]').click();
    await page.locator('[data-collections]').waitFor({ state: 'visible' });
  });
});

/** ② the three explanatory lines are gone; the two that carry something to act on stay. */
test('② 合集 draws no index-reach / index-source / 只读素材列表 line, and keeps derived-more and 未归类', { timeout: 120000 }, async () => {
  await withPage(async (page, url) => {
    await page.goto(url('w=900'));
    await page.locator('[data-collections]').waitFor({ state: 'visible' });
    for (const note of ['index-reach', 'index-source', 'index-scope']) {
      assert.equal(await page.locator(`[data-note="${note}"]`).count(), 0, `no ${note} line anywhere in the view`);
    }
    const text = await page.locator('[data-material-center]').innerText();
    assert.equal(text.includes('只读素材列表'), false, 'the 只读素材列表 paragraph is not drawn');
    assert.equal(text.includes('正在下载一次到本地'), false, 'nor its second half');
    assert.equal(text.includes('索引来源'), false, 'nor 索引来源：已落盘…');
    assert.equal(text.includes('可翻页'), false, 'nor 可翻页 … 声称 …');
    assert.equal(text.includes('声称'), false, 'not even the claim on its own');

    /* what a person acts on is still there */
    assert.equal(await page.locator('[data-note="derived-more"]').count(), 1, '共 N 个派生批次… is necessary: the list is cut');
    const derivedMore = await page.locator('[data-note="derived-more"]').innerText();
    assert.match(derivedMore, /共 45 个派生批次/, 'and it says how many there are: ' + derivedMore);
    assert.equal(await page.locator('details[data-stage="unassigned"]').count(), 1, 'the collapsed 未归类 count stays');
    assert.match(await page.locator('[data-unassigned-summary]').innerText(), /未归类/, 'which is the one thing about the names that say nothing');
  });
});

/** ③ the pager is the video wall's, at the foot of the wall; 合集 has none. */
test('③ 合集 has no pager; the video view\'s is a row under its wall, in short words', { timeout: 120000 }, async () => {
  await withPage(async (page, url) => {
    await page.goto(url('w=900'));
    await page.locator('[data-collections]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-page-block]').count(), 0, 'the whole index is not paged: no pager in 合集');
    assert.equal(await page.locator('[data-action="previous"]').count(), 0, 'no 上一页 in 合集');
    assert.equal(await page.locator('[data-action="next"]').count(), 0, 'no 下一页 either');
    assert.equal(await page.locator('[aria-label^="第 "]').count(), 0, 'and no 第 1 页 block');

    await page.locator('[data-view-mode="videos"]').click();
    const pager = page.locator('[data-page-block]');
    await pager.waitFor({ state: 'visible' });
    const wall = (await page.locator('[data-view-pane="cards"]').first().boundingBox())!;
    const box = (await pager.boundingBox())!;
    assert.ok(box.y >= wall.y + wall.height, `the pager is under the wall (wall ends ${Math.round(wall.y + wall.height)}, pager starts ${Math.round(box.y)})`);
    assert.match(await pager.innerText(), /上一页[\s\S]*第 1 页[\s\S]*下一页/, 'it says where the page is');
    assert.equal((await pager.innerText()).includes('短页'), false, 'and nothing about short pages: that is our business, not the person\'s');
    assert.equal((await pager.innerText()).includes('自动续取'), false, 'nor any other internal note');
    /* it is not the filter bar: the bar is above the wall, the pager below it */
    const bar = (await page.locator('[data-filter-bar]').boundingBox())!;
    assert.ok(box.y > bar.y + bar.height, 'the pager never overlaps the toolbar');
  });
});

/** The 子合集's own wall, with its 加载更多 at the foot: the screenshot this batch is reviewed on. */
test('③b a 子合集 keeps its 加载更多 at the foot of its own wall', { timeout: 120000 }, async () => {
  await withPage(async (page, url) => {
    await page.goto(url('w=900'));
    await page.locator(COLLECTION).waitFor({ state: 'visible' });
    await page.locator(COLLECTION).click();
    await page.locator(GROUP).waitFor({ state: 'visible' });
    await page.locator(GROUP).click();
    const more = page.locator('[data-group-page] [data-action="load-more"]');
    await more.waitFor({ state: 'visible' });
    const card = (await page.locator('[data-material-card]').first().boundingBox())!;
    const box = (await more.boundingBox())!;
    assert.ok(box.y > card.y, 'the button is under the group\'s cards, not over them');
    assert.equal(await more.innerText(), '加载更多', 'one press, one page');

    await page.locator('[data-drawer], #drawer').first().waitFor({ state: 'visible' });
    /* the wall is long: the button is at its foot, and that is the thing to look at (scrolled by hand: the wall keeps
       settling while covers land, so Playwright's "wait until stable" would wait for the end of the visit) */
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, '02-group-load-more.png'), fullPage: false });
  });
});
