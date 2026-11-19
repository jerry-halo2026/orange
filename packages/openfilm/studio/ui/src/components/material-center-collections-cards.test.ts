// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The 合集 view at the drawer's width, measured in a browser: 合集 / 子合集 / 派生批次 / 未归档 are **folder cards**
 * (a 2 × 2 collage of the set's first four covers, a count badge, a name), the compact toolbar's search box has a real
 * width at 268px, and a card's covers are requested from this origin's cover route — four of them, once.
 *
 * What this holds, and why each one is a fact about the page rather than about a class list:
 *
 *  ① a 合集 card draws four covers, each `data-cover="shown"`, each an `img` on `/api/materials/cover?url=` — the
 *    collage is the point of the card, and a card with `暂无封面` in it was the thing being replaced;
 *  ② at 268px the search box is a box you can type into (it was a full-width select's row before), the bar is one `h-7`
 *    line, and the author is a 28px menu button on that same line;
 *  ③ a 派生批次 and a 未归档 bucket are `<button>` cards with a collage, not the 28px text rows they used to be.
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

/** A 1 × 1 PNG: the cover route's answer, so an `img` really loads and `data-cover` can be read. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** The tree the view is handed: one real batch with two 子合集, one 派生批次, one 未归档 bucket, one unassigned name. */
const readyIndex = {
  state: 'ready', source: 'probing', generatedAt: null, stale: false, rows: 9,
  index: {
    schema: 'material-index@1',
    generatedAt: '2026-11-16T00:00:00.000Z',
    totals: {videos: 10, parsed: 6, unclassified: 4},
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
      count: 4,
      batches: [{id: 'derived:12.13', name: '12.13', count: 2, videoIds: ['d1', 'd2'], derived: true}],
      groups: {
        id: 'derived:unfiled', name: '未归档', count: 1, derived: true,
        groups: [{id: 'derived:unfiled:汤色', name: '汤色', count: 1, videoIds: ['u1'], derived: true}],
      },
      unassigned: 1,
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
  "  const rows = rowsOf(name, name ? Math.min(size, 4) : 3);",
  "  return json({authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', pageNo: 1, pageSize: size,",
  "    items: rows, total: {sourceType: 'number', source: String(rows.length)}, providerTotal: rows.length, totalIsProviderTotal: true,",
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

/** The real page in a box of the width this test sets, with a cover route that answers an image (or, when a case asks
 * for it, the 204 the route now gives for a supplier host it cannot reach). */
async function withPage(
  run: (page: import('playwright-core').Page, url: (query: string) => string, covers: string[]) => Promise<void>,
  { coverStatus = 200 }: { coverStatus?: number } = {},
) {
  const root = fileURLToPath(new URL('../../../../.dev/collections-cards-ui/', import.meta.url));
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
  /** The cover route: `GET /api/materials/cover?url=…` answers a pixel, so a cell can reach `shown` and stay there. */
  const covers: string[] = [];
  const http = createHttpServer((request, response) => {
    if ((request.url ?? '').startsWith('/api/materials/cover')) {
      covers.push(request.url ?? '');
      /* 204: this url has no image (a supplier host the server cannot reach), and that is not a failure. */
      if (coverStatus === 204) { response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return; }
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
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    await run(page, (query: string) => `${origin}/?${query}`, covers);
  } finally {
    await browser?.close();
    if (http.listening) await new Promise(done => http.close(done));
    await vite.close();
  }
}

const COLLECTION = '[data-collection-card="20261106-柠檬宝藏茶200g罐"]';
const PREFIX = '20261106-柠檬宝藏茶200g罐';

/** The 合集 view is the stored view's second choice: the toggle is pressed, as a person would. */
async function openCollections(page: import('playwright-core').Page) {
  await page.locator('[data-view-mode="collections"]').click();
  await page.locator('[data-collections]').waitFor({ state: 'visible' });
}

test('① a 合集 card draws four covers, each requested from the cover route, and asks for its rows once', { timeout: 120000 }, async () => {
  await withPage(async (page, url, covers) => {
    await page.goto(url('w=900'));
    await openCollections(page);
    const card = page.locator(COLLECTION);
    await card.waitFor({ state: 'visible' });
    /* The collage: four cells that reached `shown`, which is "the image is in the document and asked for". */
    await page.waitForFunction((selector: string) => document.querySelectorAll(selector + ' [data-cover="shown"]').length === 4, COLLECTION);
    assert.equal(await card.locator('[data-cover="shown"]').count(), 4, 'the card draws four covers, not a "暂无封面"');
    assert.equal(await card.locator('[data-collage]').count(), 1, 'the four are one collage');

    /* Each picture came from this origin's route — the page named no supplier host — and no url was read twice. */
    assert.equal(await card.locator('img').count(), 4, 'four images, one per cell');
    const cells = await card.locator('[data-cover="shown"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-cover-url') ?? ''));
    assert.equal(cells.length, 4);
    for (const source of cells) assert.match(source, /^\/upload\//, 'each cell holds the supplier url it was given: ' + source);
    assert.equal(new Set(cells).size, 4, 'four different covers, not one drawn four times');
    const coverReads = covers.filter(href => href.startsWith('/api/materials/cover?url='));
    assert.ok(coverReads.length >= 4, 'the pictures were read from the route: ' + covers.join(', '));
    assert.equal(coverReads.length, new Set(coverReads).size, 'each cover url is read once, never retried');

    /* The four rows are read once, for this prefix, four at a time — and leaving the view and coming back is not a read. */
    const asked = await page.evaluate(() => (window as unknown as {__asked: string[]}).__asked);
    const prefixReads = asked.filter(href => href.includes('name=' + encodeURIComponent(PREFIX)) && href.includes('pageSize=4'));
    assert.equal(prefixReads.length, 1, 'one page of four for the whole visit: ' + prefixReads.join(', '));
    await page.locator('[data-view-mode="videos"]').click();
    await page.locator('[data-view-pane="cards"]').waitFor({ state: 'visible' });
    await openCollections(page);
    await page.locator(COLLECTION).waitFor({ state: 'visible' });
    const again = await page.evaluate(() => (window as unknown as {__asked: string[]}).__asked);
    assert.equal(again.filter(href => href.includes('name=' + encodeURIComponent(PREFIX))).length, 1, 'and a second look is not a second read');
  });
});

test('③ 派生批次 and 未归档 are cards with a collage, not 28px text rows', { timeout: 120000 }, async () => {
  await withPage(async (page, url) => {
    await page.goto(url('w=900'));
    await openCollections(page);
    await page.locator(COLLECTION).waitFor({ state: 'visible' });

    const derived = page.locator('[data-derived-batch="derived:12.13"]');
    await derived.waitFor({ state: 'visible' });
    assert.equal(await derived.evaluate(node => node.tagName), 'BUTTON', 'a 派生批次 is a card a person can read as a set');
    assert.equal(await derived.locator('[data-collage]').count(), 1, 'with the same collage as a 合集 card');
    assert.ok((await derived.boundingBox())!.height > 40, 'a card, not the 28px line it was');
    assert.equal(await page.locator('div[data-derived-batch]').count(), 0, 'the text row is gone');

    const unfiled = page.locator('[data-derived-group="derived:unfiled:汤色"]');
    await unfiled.waitFor({ state: 'visible' });
    assert.equal(await unfiled.evaluate(node => node.tagName), 'BUTTON', '「未归档」 buckets are cards too');
    assert.equal(await unfiled.locator('[data-collage]').count(), 1);
    assert.ok((await unfiled.boundingBox())!.height > 40, 'and not a row either');
    assert.equal(await page.locator('div[data-derived-group]').count(), 0, 'no text row is left behind');

    /* The two stages are foldable sections, and 未归类 is still the one collapsed line (no card wall). */
    assert.equal(await page.locator('details[data-stage="derived"]').count(), 1);
    assert.equal(await page.locator('details[data-stage="unfiled"]').count(), 1);
    assert.equal(await page.locator('details[data-stage="unassigned"]').count(), 1);

    /* Step in: the 子合集 cards are cards, and one more press is a group's video cards. */
    await page.locator(COLLECTION).click();
    const group = page.locator('[data-group-card="20261106-柠檬宝藏茶200g罐-外包装"]');
    await group.waitFor({ state: 'visible' });
    assert.equal(await group.evaluate(node => node.tagName), 'BUTTON');
    assert.equal(await group.locator('[data-collage]').count(), 1, 'a 子合集 card has its own four covers');
    assert.ok((await group.boundingBox())!.height > 40);
    await group.click();
    await page.locator('[data-material-card]').first().waitFor({ state: 'visible' });
    assert.ok(await page.locator('[data-group-page]').count() === 1, 'the group is read by its prefix, and its videos are the wall');
  });
});

test('④ a 批次 heading is its name alone — no "108 条" badge — while the cards under it keep their counts', { timeout: 120000 }, async () => {
  await withPage(async (page, url) => {
    await page.goto(url('w=900'));
    await openCollections(page);
    const summary = page.locator('details[data-batch="20261106"] > summary');
    await summary.waitFor({ state: 'visible' });
    /* The batch line is the date and nothing else: the wall under it is what says how much is in it. */
    assert.equal(await summary.locator('[data-batch-count]').count(), 0, 'the batch heading carries no count badge');
    assert.equal(await page.locator('[data-batch-count]').count(), 0, 'and no other batch does either');
    assert.equal((await summary.innerText()).trim(), '20261106', 'what is left is the batch name, unchanged');

    /* The counts that stay: a 合集 card's collage badge, and a 派生批次 card's own count. */
    const card = page.locator(COLLECTION);
    assert.equal(await card.getAttribute('data-collection-count'), '6', 'a 合集 card still says how many materials it holds');
    assert.equal((await card.locator('[data-collection-badge] .tabular-nums').innerText()).trim(), '6', 'and its cover still prints it');
    assert.equal(await page.locator('[data-derived-batch="derived:12.13"]').getAttribute('data-derived-count'), '2', 'a 派生批次 card keeps its count');
    assert.equal(await page.locator('[data-derived-group="derived:unfiled:汤色"]').getAttribute('data-derived-group-count'), '1', 'a 未归档 card keeps its count');
  });
});

test('⑤ a cover the route answers 204 for is a placeholder — not a failure, not a broken image, not a retry', { timeout: 120000 }, async () => {
  /* A supplier host that cannot be reached at all (it accepts the connection and then drops the TLS handshake) has no
     cover. The route says 204 rather than 502: the card draws its placeholder, and a grid of cards shows no red. */
  await withPage(async (page, url, covers) => {
    await page.goto(url('w=900'));
    await openCollections(page);
    const card = page.locator(COLLECTION);
    await card.waitFor({ state: 'visible' });
    await page.waitForFunction((selector: string) => document.querySelectorAll(selector + ' [data-cover="none"][data-cover-url]').length === 4, COLLECTION);
    assert.equal(await card.locator('[data-cover="none"][data-cover-url]').count(), 4, 'four urls, four 204s: four placeholders');
    assert.equal(await card.locator('[data-cover="failed"]').count(), 0, 'a 204 is `none`, never `failed`');
    assert.equal(await card.locator('img').count(), 0, 'nothing is drawn for an image that does not exist');
    /* And no retry: each url was read once, which is the whole point of the store's remembered minute. */
    assert.ok(covers.length >= 4, 'each cell asked once: ' + covers.join(', '));
    assert.equal(covers.length, new Set(covers).size, 'a 204 was not asked for again: ' + covers.join(', '));
  }, { coverStatus: 204 });
});

test('② at 268px the search box has a width on one h-7 line, and the author is a menu button beside it', { timeout: 120000 }, async () => {
  await withPage(async (page, url) => {
    await page.goto(url('w=268'));
    const search = page.locator('input[data-filter="search"]');
    await search.waitFor({ state: 'visible' });
    const box = (await search.boundingBox())!;
    assert.ok(box.width > 60, `the search box keeps a width at 268px (${box.width}px)`);
    assert.ok(box.x >= 0 && box.x + box.width <= 268.5, 'and it stays inside the 268px column');
    await search.fill('风景');
    assert.equal(await search.inputValue(), '风景', 'typing lands in it');

    const bar = (await page.locator('[data-filter-bar]').boundingBox())!;
    assert.ok(bar.height >= 24 && bar.height <= 32, `the bar is one h-7 line (${bar.height}px)`);
    const author = page.locator('[data-filter="author"]');
    const button = (await author.boundingBox())!;
    assert.ok(button.height >= 24 && button.height <= 32, `the author is a 28px icon button (${button.height}px)`);
    assert.ok(Math.abs(button.y + button.height / 2 - (box.y + box.height / 2)) < 6, 'the two sit on the same line');
    assert.ok(button.x >= box.x + box.width, 'the author sits to the right of the search, not over it');

    /* The scope is a menu of the two choices; "mine" is not offered before a claim exists. */
    await author.click();
    await page.locator('[data-author-menu]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-author-option]').count(), 2, 'company and mine, nothing else');
    assert.equal(await page.locator('[data-author-option="cloud:own"]').isDisabled(), true, '"mine" needs a claimed account');
    await page.locator('[data-author-option="cloud:company"]').click();
    assert.equal(await page.locator('[data-author-menu]').count(), 0, 'a pick closes the menu');
    assert.equal(await author.getAttribute('data-author-value'), 'cloud:company', 'and the button says which scope it is');

    /* The same bar at full width: the search grows, nothing is a narrow-only special case. */
    await page.goto(url('w=900'));
    const wide = page.locator('input[data-filter="search"]');
    await wide.waitFor({ state: 'visible' });
    assert.ok((await wide.boundingBox())!.width > box.width, 'the search uses the room it has at 900px');
  });
});
