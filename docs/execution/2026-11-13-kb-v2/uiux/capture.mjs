// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * UI/UX walkthrough capture for kb-v2: one scratch Studio, real Studio pages, mocked cloud-steward reads.
 *
 * Writes PNGs into this directory. The scratch Studio home/library, the Vite harness and its fixture live in the OS
 * temp directory and are removed at the end; the only workspace paths written are the PNGs here.
 *
 * The cloud-steward tab is captured twice: once as the real workspace reaches it (the rail entry, 08) and once from a
 * component harness (09–11), because in this build the workspace's assets pane does not render the cloud scope at all.
 *
 * Run: node docs/execution/2026-11-13-kb-v2/uiux/capture.mjs
 */
import { mkdir, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const openfilm = join(repo, 'packages', 'openfilm');
const ui = join(openfilm, 'studio', 'ui', 'src');
const require = createRequire(join(openfilm, 'package.json'));
const { chromium } = require('playwright-core');
const { startStudio } = await import(pathToFileURL(join(openfilm, 'studio/server/server.mjs')).href);
const { openProject } = await import(pathToFileURL(join(openfilm, 'studio/server/projects.mjs')).href);
const { filmHtml } = await import(pathToFileURL(join(openfilm, 'src/film-doc.mjs')).href);

const WIDTH = 1600, HEIGHT = 1000;
const SVGS = {
  a: ['#1f6feb', '开场'],
  b: ['#13b9b2', '街景'],
  c: ['#e8590c', '收尾'],
  d: ['#7048e8', '片头'],
};
const svgOf = ([color, text]) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${color}"/><text x="320" y="200" font-size="56" fill="#fff" text-anchor="middle" font-family="sans-serif">${text}</text></svg>`;

const editProfile = {
  mode: 'edit', tree: null, assets: true, layers: false, timeline: true, inspector: true, chat: false,
  libraryDock: 'left', chatSide: 'left', layersSide: 'left', inspectorSide: 'right', timelineEdge: 'bottom',
  assetsWidth: 430, libraryHeight: 280, layersWidth: 240, inspectorWidth: 360, timelineHeight: null, chatWidth: 420,
};
const canvasProfile = { ...editProfile, mode: 'canvas', assets: false, layers: false, timeline: false, inspector: false };
const profile = () => JSON.stringify({ version: 2, edit: editProfile, canvas: canvasProfile });

const NAMES = ['城市夜景航拍 4K', '雨夜街头慢镜头', '地铁站人流延时', '老城区巷口', '跨江大桥晨雾', '夜市摊位烟火气', '天台霓虹人像', '江面游船灯带'];
const ACCOUNTS = ['橙子影像', '老王拍城', '阿岚的镜头', '城市观察员'];
const cards = Array.from({ length: 8 }, (_, index) => ({
  videoId: { value: `9000${index}`, sourceType: 1, source: 'demo' },
  observation: {
    name: NAMES[index],
    coverUrl: `/covers/${index % 4}.png`,
    downloadCount: String(120 + index * 37), collectCount: String(20 + index * 5),
    accountName: ACCOUNTS[index % ACCOUNTS.length], accountKey: `acct-${index % ACCOUNTS.length}`,
    createTime: `2026-11-${String(10 - (index % 5)).padStart(2, '0')} 18:2${index % 6}:00`,
    duration: 12 + index * 7, fileSize: 180_000_000 + index * 30_000_000,
    oneLevelVideoType: { id: 10, name: '城市' },
    twoLevelVideoType: { id: 101 + (index % 3), name: ['夜景', '街景', '航拍'][index % 3] },
    videoLabels: [{ id: 1, name: '4K' }, { id: 2, name: '横屏' }].slice(0, 1 + (index % 2)),
    videoState: { id: 1, name: '已审核', frontColor: '#fff', backgroundColor: '#2f9e44' },
    videoType: 1,
  },
}));

const facets = {
  authorization: { layer: 'public', reason: 'demo' }, providerScope: 'company', videoType: 1,
  oneLevel: [
    { id: 10, name: '城市', level: 1, children: [
      { id: 101, name: '夜景', parentTypeId: 10, level: 2 },
      { id: 102, name: '街景', parentTypeId: 10, level: 2 },
      { id: 103, name: '航拍', parentTypeId: 10, level: 2 },
    ] },
    { id: 11, name: '人文', level: 1, children: [
      { id: 111, name: '市井', parentTypeId: 11, level: 2 },
      { id: 112, name: '人物', parentTypeId: 11, level: 2 },
    ] },
  ],
  twoLevel: [
    { id: 101, name: '夜景', parentTypeId: 10, level: 2 },
    { id: 102, name: '街景', parentTypeId: 10, level: 2 },
    { id: 103, name: '航拍', parentTypeId: 10, level: 2 },
    { id: 111, name: '市井', parentTypeId: 11, level: 2 },
    { id: 112, name: '人物', parentTypeId: 11, level: 2 },
  ],
  states: [{ id: 1, name: '已审核', frontColor: '#fff', backgroundColor: '#2f9e44' }],
  publicLabels: [{ id: 1, name: '4K' }, { id: 2, name: '横屏' }],
  labelTotal: 2,
};

const cover = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1f6feb"/><stop offset="1" stop-color="#e8590c"/></linearGradient></defs><rect width="640" height="360" fill="#343a40"/><rect width="640" height="360" fill="url(#g)" opacity=".55"/></svg>`;

/** The cloud-steward routes, mocked for one page: `state.bound` follows the claim. */
async function mockMaterials(page, state) {
  const binding = route => {
    const method = route.request().method();
    if (method === 'POST') state.bound = true;
    if (method === 'DELETE') state.bound = false;
    const value = state.bound ? { account: 'orange-demo', accountKey: 'acct-demo', status: 'claimed' } : null;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ binding: value }) });
  };
  await page.route('**/api/materials/binding', binding);
  await page.route('**/api/materials/facets**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(facets) }));
  await page.route('**/api/materials/labels**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authorization: facets.authorization, providerScope: 'company', pageNo: 1, pageSize: 20, labels: facets.publicLabels, total: 2 }) }));
  await page.route('**/api/materials/list**', route => {
    const group = new URL(route.request().url()).searchParams.get('twoLevelTypeIds');
    const items = group ? cards.filter((_, index) => String(101 + (index % 3)) === group) : cards;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      authorization: facets.authorization, providerScope: 'company', pageNo: 1, pageSize: 24,
      items, total: items.length, providerTotal: items.length, totalIsProviderTotal: true,
      filtered: { inspected: items.length, dropped: 0 }, grants: false,
    }) });
  });
  await page.route('**/covers/*.png', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: cover }));
}

const scratch = await mkdtemp(join(tmpdir(), 'orange-uiux-'));
for (const name of ['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS', 'TRASH_DIR']) process.env[`OPENFILM_${name}`] = join(scratch, name.toLowerCase());

let studio, browser, harness, harnessServer;
const shots = [];
try {
  /* one project with a few media files, a Saved library with two files, and a canvas board */
  const root = join(process.env.OPENFILM_LIBRARY, '演示项目');
  await mkdir(join(root, '.film'), { recursive: true });
  await mkdir(join(root, 'assets'), { recursive: true });
  for (const [name, value] of Object.entries(SVGS)) await writeFile(join(root, 'assets', `${name}.svg`), svgOf(value));
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 1280, h: 720 }, tracks: [{ clips: [
    { id: 'a', src: 'assets/a.svg', at: 0, time: [0, 3] },
    { id: 'b', src: 'assets/b.svg', at: 3, time: [0, 4] },
    { id: 'c', src: 'assets/c.svg', at: 7, time: [0, 3] },
  ] }] }));
  await writeFile(join(root, '.film', 'canvas.json'), JSON.stringify({ nodes: [
    { id: 'note', x: 0, y: 0, w: 380, h: 220, text: '第 1 场：开场镜头，城市苏醒' },
    { id: 'note-2', x: 430, y: 40, w: 380, h: 220, text: '第 2 场：街景，人流延时' },
    { id: 'note-3', x: 200, y: 300, w: 380, h: 220, text: '第 3 场：收尾，江面游船' },
  ], edges: [{ id: 'e1', source: 'note', target: 'note-2' }, { id: 'e2', source: 'note-2', target: 'note-3' }] }));
  const project = await openProject(root);
  await mkdir(process.env.OPENFILM_SAVED, { recursive: true });
  await writeFile(join(process.env.OPENFILM_SAVED, '品牌片头.svg'), svgOf(['#212529', '片头']));
  await writeFile(join(process.env.OPENFILM_SAVED, '片尾底板.svg'), svgOf(['#495057', '片尾']));

  studio = await startStudio({ port: 0, openBrowser: () => {} });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, locale: 'zh-CN', reducedMotion: 'reduce', deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const problems = [];
  page.on('pageerror', error => problems.push('pageerror: ' + error.message));
  await page.addInitScript(value => { try { localStorage.setItem('openfilm.workspace.current.v2', value); } catch { /* first run */ } }, profile());

  const shot = async (name, target = page, element = null) => {
    await (element ?? target).screenshot({ path: join(here, `${name}.png`) });
    shots.push(name);
    console.log('shot', `${name}.png`);
  };

  const state = { bound: false };
  await mockMaterials(page, state);
  await page.route('**/api/fission-local/jobs', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/fission-local/select', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    selectionId: 'selection_demo_01', role: 'video', name: '演示素材 第 01 批',
    groups: [{ name: '01 开场', count: 3 }, { name: '02 街景', count: 4 }, { name: '03 收尾', count: 3 }],
  }) }));

  /* ── 01 home / project library ── */
  await page.goto(`${studio.origin}/?key=${studio.key}`);
  await page.getByRole('heading', { name: '开始你的下一次创作' }).waitFor();
  await page.getByText('演示项目').first().waitFor();
  await shot('01-home-library');

  /* ── settings: theme + language (dark then light with the language menu open) ── */
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByText('外观', { exact: false }).first().waitFor();
  await shot('02-settings-theme-language');
  await page.getByRole('radio', { name: '浅色' }).click();
  await page.getByRole('button', { name: /^语言: / }).click();
  await page.getByRole('listbox').waitFor();
  await page.mouse.move(20, 20);
  await page.waitForTimeout(300);
  await shot('03-settings-light-language-menu');
  await page.evaluate(() => localStorage.setItem('openfilm.theme', 'dark'));

  /* ── workspace: edit and canvas ── */
  await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
  await page.locator('[data-work-mode="edit"]').waitFor();
  await page.waitForTimeout(1600);
  await page.mouse.move(20, 500);
  await shot('04-workspace-edit');
  await page.locator('[data-work-mode="edit"]').click();
  await page.locator('[data-work-mode="canvas"]').waitFor();
  await page.waitForTimeout(1600);
  await page.mouse.move(20, 500);
  await shot('05-workspace-canvas');

  /* ── the assets drawer: 导入 / 收藏, then the cloud rail entry as the real workspace answers it ── */
  await page.evaluate(value => {
    localStorage.setItem('openfilm.workspace.current.v2', value);
    for (const key of Object.keys(localStorage)) if (key.startsWith('openfilm.canvas.open')) localStorage.removeItem(key);
  }, profile());
  await page.reload();
  await page.locator('[data-work-mode="edit"]').waitFor();
  await page.getByRole('button', { name: '导入', exact: true }).waitFor();
  await page.waitForTimeout(1500);
  await page.mouse.move(20, 500);
  await shot('06-drawer-import');
  await page.getByRole('button', { name: '收藏', exact: true }).click();
  await page.waitForTimeout(900);
  await page.mouse.move(20, 500);
  await shot('07-drawer-saved');
  /* the rail entry sets the scope, but the pane beside it keeps drawing the project's own media */
  await page.getByRole('button', { name: '云管家', exact: true }).click();
  await page.waitForTimeout(1200);
  await page.mouse.move(20, 500);
  await shot('08-cloud-rail-dead');

  /* ── the cloud-steward tab itself, from a Vite harness: the same component the pane would mount ── */
  const fixture = join(openfilm, '.dev', 'uiux-harness');
  await mkdir(fixture, { recursive: true });
  const css = (await readdir(join(openfilm, 'studio', 'ui', 'dist', 'assets'))).find(name => /^index-.*\.css$/.test(name));
  const fixed = path => path.replaceAll('\\', '/');
  const harnessComponent = fixed(join(ui, 'components', 'material-center', 'CloudMaterialsTab.tsx'));
  const harnessCenter = fixed(join(ui, 'components', 'MaterialCenter.tsx'));
  const harnessClient = fixed(join(ui, 'lib', 'material-center', 'client.ts'));
  await writeFile(join(fixture, 'index.html'), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/@fs/${fixed(join(openfilm, 'studio', 'ui', 'dist', 'assets', css))}"><style>html,body{margin:0;background:var(--bg-app);color:var(--text)}</style></head><body><div id="root"></div><script type="module" src="/harness.tsx"></script></body></html>`);
  await writeFile(join(fixture, 'harness.tsx'), [
    "import React from 'react';",
    "import {createRoot} from 'react-dom/client';",
    `import {CloudMaterialsTab} from '/@fs/${harnessComponent}';`,
    `import {MaterialCenter} from '/@fs/${harnessCenter}';`,
    `import {createMaterialsClient} from '/@fs/${harnessClient}';`,
    "const client=createMaterialsClient();",
    "function Harness(){return <div style={{display:'flex',flexDirection:'column',width:820,height:920,background:'var(--bg-app)',color:'var(--text)',padding:10,boxSizing:'border-box'}}>",
    "  <CloudMaterialsTab client={client} renderLibrary={(group,onCount)=><MaterialCenter compact cloudTab group={group?{twoLevelId:group.id,oneLevelId:group.oneLevelId,name:group.name,scope:'company'}:null} draft={[]} draftReady draftReason={null} onDraftOperation={async()=>true} onDraftRetry={async()=>true} onGroupCount={onCount}/>} />",
    "</div>}",
    "createRoot(document.getElementById('root')!).render(<Harness/>);",
  ].join('\n'));
  const vite = (await import(pathToFileURL(require.resolve('vite')).href)).createServer;
  const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
  harness = await vite({ configFile: false, root: fixture, cacheDir: join(fixture, '.vite'), plugins: [react()], resolve: { alias: { '@': ui }, dedupe: ['react', 'react-dom'] }, server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [fixture, ui, repo] } }, appType: 'spa' });
  harnessServer = createHttpServer(harness.middlewares);
  await new Promise((done, fail) => { harnessServer.once('error', fail); harnessServer.listen(0, '127.0.0.1', done); });
  const harnessPage = await context.newPage();
  harnessPage.setDefaultTimeout(15000);
  harnessPage.on('response', response => {
    if (!response.url().includes('/api/materials')) return;
    console.log('HARNESS RESPONSE', response.status(), response.url().slice(0, 200));
  });
  harnessPage.on('requestfailed', request => {
    if (request.url().includes('/api/materials')) console.log('HARNESS FAILED', request.url().slice(0, 200), request.failure()?.errorText);
  });
  const harnessState = { bound: false };
  await mockMaterials(harnessPage, harnessState);
  await harnessPage.goto(`http://127.0.0.1:${harnessServer.address().port}/`);
  await harnessPage.locator('[data-state="unbound"]').waitFor();
  const harnessRoot = harnessPage.locator('#root > div');
  await harnessPage.waitForTimeout(600);
  await shot('09-cloud-unbound-harness', harnessPage, harnessRoot);
  await harnessPage.locator('[data-action="claim-binding"]').click();
  await harnessPage.locator('[data-field="binding-account"]').fill('orange-demo');
  await harnessPage.locator('[data-action="binding-submit"]').click();
  await harnessPage.locator('[data-state="bound"]').waitFor();
  await harnessPage.locator('[data-group-card]').first().waitFor();
  await harnessPage.waitForTimeout(900);
  await shot('10-cloud-bound-harness', harnessPage, harnessRoot);
  await harnessPage.locator('[data-group-card]').first().click();
  await harnessPage.locator('[data-filter="search"]').fill('夜景');
  await harnessPage.locator('[data-filter="duration"]').selectOption('under1m').catch(() => {});
  await harnessPage.waitForTimeout(1500);
  await shot('11-cloud-collection-search-filter-harness', harnessPage, harnessRoot);

  /* ── Fission wizard: three steps, the summary bar ── */
  await page.goto(`${studio.origin}/?key=${studio.key}`);
  await page.getByRole('heading', { name: '开始你的下一次创作' }).waitFor();
  await page.getByRole('button', { name: /超级混剪/ }).first().click();
  await page.getByText('① 选择素材').waitFor();
  await page.waitForTimeout(700);
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === '选择文件夹');
    return Boolean(button) && !button.disabled;
  });
  await page.getByRole('button', { name: '选择文件夹' }).first().click();
  try {
    await page.getByText('01 开场').waitFor({ timeout: 10000 });
  } catch (error) {
    console.log('FISSION DEBUG\n' + (await page.locator('main').innerText()).slice(0, 2500));
    await page.screenshot({ path: join(here, 'debug-fission.png') });
    throw error;
  }
  await page.waitForTimeout(600);
  await shot('12-fission-step1-materials');
  await page.getByRole('button', { name: '下一步：规则' }).click();
  await page.waitForTimeout(1200);
  await shot('13-fission-step2-rules');
  await page.getByRole('button', { name: '下一步：导出' }).click();
  await page.waitForTimeout(1200);
  await shot('14-fission-step3-export');
  await page.locator('main').evaluate(node => node.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(700);
  await shot('15-fission-summary');

  console.log('SHOTS', shots.length, shots.join(', '));
  console.log('PROBLEMS', [...new Set(problems)].slice(0, 12));
} finally {
  await browser?.close();
  await harness?.close();
  await harnessServer?.close?.();
  await studio?.close();
  await rm(join(openfilm, '.dev', 'uiux-harness'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
