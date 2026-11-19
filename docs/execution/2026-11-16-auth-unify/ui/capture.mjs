// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The evidence for the material centre's views: 合集 (batches + collection cards), 子合集 (with their counts) and one
 * material's detail — captured from the real Studio page (home → 素材中心) with a stubbed read-only material route.
 *
 *   node docs/execution/2026-11-16-auth-unify/ui/capture.mjs
 *
 * It writes view-collections.png, view-subcollections.png and detail.png beside itself, and prints the assertions the
 * acceptance asks for: the deleted elements are gone (count 0) and the 子合集 counts add up to the 合集 count.
 */
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '../../../../packages/openfilm/node_modules/playwright-core/index.mjs';
import {startStudio} from '../../../../packages/openfilm/studio/server/server.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SHOTS = ['view-collections.png', 'view-subcollections.png', 'detail.png'];

/* The provider's own names: 批次 (date) → 合集 (date + product) → 子合集 (group), with the counts the index is measured
   against (20261106 = 448, 柠檬宝藏茶200g罐 = 221, 外包装 = 49). */
function materialRows() {
  const groups = [
    {label: '20261106-柠檬宝藏茶200g罐-外包装', count: 49},
    {label: '20261106-柠檬宝藏茶200g罐-茶干', count: 172},
    {label: '20261106-陈皮白茶250g罐-包装', count: 227},
    {label: '20261105-桂花乌龙茶150g罐-包装', count: 180},
  ];
  const rows = [];
  /* The first five of every group are pushed first (and are the newest), so the page in hand — 20 rows — holds material
     of every group: a 合集's representative cover and a 子合集's own wall are checked against rows actually loaded. */
  const push = (label, at, newest) => rows.push({
    videoId: {value: 'v' + rows.length, sourceType: 'string', source: 'v' + rows.length},
    observation: {
      name: `${label} (${at})`,
      coverUrl: '/api/materials/cover/' + (rows.length % 8) + '.svg',
      createTime: '2026-11-06 ' + (newest ? '22' : '09') + ':' + String(at % 60).padStart(2, '0') + ':00',
      duration: 1800 + (rows.length % 900),
      fileSize: 40_000_000 + rows.length * 1000,
      accountName: '李雪妮',
      downloadCount: rows.length % 7,
      collectCount: rows.length % 5,
      oneLevelVideoType: {id: 11, name: '口播'},
      twoLevelVideoType: {id: 21, name: '茶饮'},
      videoState: {id: 1, name: '已通过', frontColor: '#dfe9e6', backgroundColor: '#1f3d38'},
      videoLabels: [{id: 5, name: '外包装'}],
      videoType: 1,
    },
  });
  for (let n = 1; n <= 5; n += 1) for (const group of groups) push(group.label, n, true);
  for (const group of groups) for (let n = 6; n <= group.count; n += 1) push(group.label, n, false);
  return rows;
}

const ROWS = materialRows();

const FACETS = {
  authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', videoType: 1,
  oneLevel: [{id: 11, name: '口播', level: 1, children: [{id: 21, name: '茶饮', parentTypeId: 11, level: 2}]}],
  twoLevel: [{id: 21, name: '茶饮', parentTypeId: 11, level: 2}],
  states: [{id: 1, name: '已通过', frontColor: '#dfe9e6', backgroundColor: '#1f3d38'}],
  publicLabels: [{id: 5, name: '外包装'}], labelTotal: null,
};

const PALETTE = ['#1f3d38', '#2b4a44', '#3c5b53', '#274a52', '#2d4a3e', '#3a4a2d', '#4a3a2d', '#2d3a4a'];
const COVER = (index) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${PALETTE[index % PALETTE.length]}"/><text x="16" y="106" fill="#dfe9e6" font-family="sans-serif" font-size="36">${index + 1}</text></svg>`;

const answers = {};
async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'of-material-views-'));
  const names = ['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS', 'TRASH_DIR'];
  const saved = new Map(names.map(name => [`OPENFILM_${name}`, process.env[`OPENFILM_${name}`]]));
  for (const name of names) process.env[`OPENFILM_${name}`] = join(scratch, name.toLowerCase());
  await mkdir(HERE, {recursive: true});
  await mkdir(process.env.OPENFILM_LIBRARY, {recursive: true});
  await mkdir(process.env.OPENFILM_SAVED, {recursive: true});

  let studio, browser;
  try {
    studio = await startStudio({port: 0, openBrowser: () => {}});
    browser = await chromium.launch({headless: true, args: ['--use-angle=swiftshader']});
    const page = await browser.newPage({viewport: {width: 1800, height: 1100}, locale: 'zh-CN', reducedMotion: 'reduce'});
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.route('**/api/materials/binding', route => route.fulfill({json: {binding: {account: '演示账号', accountKey: 'demo-key', status: 'claimed'}}}));
    await page.route('**/api/materials/facets**', route => route.fulfill({json: FACETS}));
    await page.route('**/api/materials/labels**', route => route.fulfill({json: {authorization: {layer: 'self', reason: 's'}, providerScope: 's', pageNo: 1, pageSize: 50, labels: [], total: null}}));
    await page.route('**/api/materials/cover/**', route => route.fulfill({status: 200, contentType: 'image/svg+xml', body: COVER(Number(route.request().url().split('/').pop().replace('.svg', '')) || 0)}));
    await page.route('**/api/materials/list**', route => {
      const url = new URL(route.request().url());
      const pageNo = Number(url.searchParams.get('pageNo') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      const from = (pageNo - 1) * pageSize;
      return route.fulfill({json: {
        authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', pageNo, pageSize,
        items: ROWS.slice(from, from + pageSize),
        total: {sourceType: 'number', source: String(ROWS.length)}, providerTotal: ROWS.length, totalIsProviderTotal: true,
        filtered: {inspected: ROWS.length, dropped: 0}, grants: false,
      }});
    });
    await page.route('**/api/saved**', route => route.fulfill({json: {files: []}}));

    await page.goto(`${studio.origin}/?key=${studio.key}`);
    /* Home → 素材中心: the host's own entry to the same library the cloud tab shows. */
    await page.locator('button:has(h2:text-is("素材中心"))').click();
    await page.locator('[data-material-center]').waitFor();
    await page.locator('[data-filter="source"]').selectOption('cloud');
    await page.locator('[data-view-mode="collections"]').click();
    await page.locator('[data-collection-card]').first().waitFor();

    /* 1. 批次 (sticky headings) + 合集 cards. */
    await page.screenshot({path: join(HERE, SHOTS[0])});
    answers.batches = await page.locator('[data-batch]').count();
    answers.collectionCards = await page.locator('[data-collection-card]').count();
    answers.indexScope = (await page.locator('[data-note="index-scope"]').textContent())?.trim();

    /* 2. One 合集's 子合集, with their counts. */
    const firstCard = page.locator('[data-collection-card]').first();
    const collectionName = await firstCard.locator('span[title]').first().getAttribute('title');
    const collectionCount = Number(await firstCard.getAttribute('data-collection-count'));
    await firstCard.click();
    await page.locator('[data-group-card]').first().waitFor();
    await page.screenshot({path: join(HERE, SHOTS[1])});
    const groupCounts = await page.locator('[data-group-card]').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-group-count'))));
    answers.collection = collectionName;
    answers.collectionCount = collectionCount;
    answers.groupCounts = groupCounts;
    answers.groupSum = groupCounts.reduce((total, count) => total + count, 0);
    answers.groupSumMatchesCollection = answers.groupSum === collectionCount;

    /* 3. A group's materials, then one material's detail. */
    await page.locator('[data-group-card]').first().click();
    await page.waitForTimeout(500);
    answers.groupStep = {
      crumb: await page.locator('[data-crumb]').allTextContents(),
      window: await page.locator('[data-note="group-window"]').allTextContents(),
      cards: await page.locator('[data-material-card]').count(),
      openDetail: await page.locator('[data-action="open-detail"]').count(),
      groupCount: await page.locator('[data-group-count]').allTextContents(),
    };
    await page.locator('[data-action="open-detail"]').first().click();
    await page.locator('[data-material-detail]').waitFor();
    await page.screenshot({path: join(HERE, SHOTS[2])});
    answers.detail = {
      id: await page.locator('[data-material-detail]').getAttribute('data-material-detail'),
      tagPath: (await page.locator('[data-field="detail-tag-path"]').textContent())?.trim(),
      author: (await page.locator('[data-field="detail-author"]').textContent())?.trim(),
      duration: (await page.locator('[data-field="detail-duration"]').textContent())?.trim(),
      size: (await page.locator('[data-field="detail-size"]').textContent())?.trim(),
    };

    /* Esc closes it: the sheet is not a page. */
    await page.keyboard.press('Escape');
    await page.locator('[data-material-detail]').waitFor({state: 'detached'});
    answers.escCloses = true;

    /* The four deleted decorations: count 0 in the live DOM. */
    answers.removed = {
      providerTotal: await page.locator('[data-note="provider-total"]').count(),
      toolbar: await page.locator('[data-material-center] [role="toolbar"]').count(),
      spend: await page.locator('[data-note="spend"]').count(),
      titleRowButtons: await page.locator('[data-material-center] [data-action="import-local"], [data-material-center] [data-action="refresh"], [data-material-center] [data-action="select-page"], [data-material-center] [data-action="hide-unauthorized"], [data-material-center] [data-view="cards"], [data-material-center] [data-view="list"]').count(),
    };
    answers.pageErrors = errors;
    console.log(JSON.stringify(answers, null, 2));
  } finally {
    await browser?.close().catch(() => {});
    await studio?.close?.().catch(() => {});
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(scratch, {recursive: true, force: true}).catch(() => {});
  }
}

await main();
