// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The three UI complaints of 2026-11-16, captured as evidence: the cloud tab's cards, the 合集 two-level list, and the
 * shell's 退出登录 corner.
 *
 * The cloud tab and the shell's corner are rendered from the real components (CloudMaterialsTab + the same MaterialCenter
 * the pane mounts; the shell's AccountExit with the shell's own shell.css) in one Vite harness, with the supplier's routes
 * mocked. The top bar behind the shell's corner is the real Studio workspace, in an iframe of the running Studio server, so
 * the 剪辑/画布 switch the old button covered is measured where it really is.
 *
 * Writes PNGs into this directory; the scratch Studio home, the project, the harness and its fixture live in the OS temp
 * directory and are removed at the end. Numbers are printed as one JSON line per shot.
 *
 * Run: node docs/execution/2026-11-13-kb-v2/uiux/capture-fixes.mjs
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
const shellDir = join(repo, 'apps', 'desktop', 'shell');
const require = createRequire(join(openfilm, 'package.json'));
const { chromium } = require('playwright-core');
const { startStudio } = await import(pathToFileURL(join(openfilm, 'studio/server/server.mjs')).href);
const { openProject } = await import(pathToFileURL(join(openfilm, 'studio/server/projects.mjs')).href);
const { filmHtml } = await import(pathToFileURL(join(openfilm, 'src/film-doc.mjs')).href);

const fixed = path => path.replaceAll('\\', '/');
const WIDTH = 1600;
const HEIGHT = 1000;

const svg = (color, text) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${color}"/><text x="320" y="200" font-size="56" fill="#fff" text-anchor="middle" font-family="sans-serif">${text}</text></svg>`;

const editProfile = {
  mode: 'edit', tree: null, assets: true, layers: false, timeline: true, inspector: true, chat: false,
  libraryDock: 'left', chatSide: 'left', layersSide: 'left', inspectorSide: 'right', timelineEdge: 'bottom',
  assetsWidth: 430, libraryHeight: 280, layersWidth: 240, inspectorWidth: 360, timelineHeight: null, chatWidth: 420,
};
const canvasProfile = { ...editProfile, mode: 'canvas', assets: false, layers: false, timeline: false, inspector: false };
const profile = () => JSON.stringify({ version: 2, edit: editProfile, canvas: canvasProfile });

/* ── the supplier's answers, mocked: two one-level categories, five 合集, twenty rows ── */
const NAMES = ['城市夜景航拍 4K', '雨夜街头慢镜头', '地铁站人流延时', '老城区巷口', '跨江大桥晨雾', '夜市摊位烟火气', '天台霓虹人像', '江面游船灯带',
  '清晨菜市场', '午后咖啡馆', '傍晚球场', '深夜便利店', '雨天公交站', '晴日天台', '雪后街角', '雾中高楼', '灯火写字楼', '河堤慢跑', '桥上烟火', '巷尾路灯'];
const ACCOUNTS = ['橙子影像', '老王拍城', '阿岚的镜头', '城市观察员'];
const cards = Array.from({ length: 20 }, (_, index) => ({
  videoId: { value: `9000${index}`, sourceType: 'string', source: 'demo' },
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
      { id: 111, name: '市井生活与街头纪实', parentTypeId: 11, level: 2 },
      { id: 112, name: '人物', parentTypeId: 11, level: 2 },
    ] },
    { id: 12, name: '自然', level: 1, children: [{ id: 121, name: '风光', parentTypeId: 12, level: 2 }] },
    { id: 13, name: '商业', level: 1, children: [{ id: 131, name: '产品', parentTypeId: 13, level: 2 }] },
  ],
  twoLevel: [
    { id: 101, name: '夜景', parentTypeId: 10, level: 2 },
    { id: 102, name: '街景', parentTypeId: 10, level: 2 },
    { id: 103, name: '航拍', parentTypeId: 10, level: 2 },
    { id: 111, name: '市井生活与街头纪实', parentTypeId: 11, level: 2 },
    { id: 112, name: '人物', parentTypeId: 11, level: 2 },
    { id: 121, name: '风光', parentTypeId: 12, level: 2 },
    { id: 131, name: '产品', parentTypeId: 13, level: 2 },
  ],
  states: [{ id: 1, name: '已审核', frontColor: '#fff', backgroundColor: '#2f9e44' }],
  publicLabels: [{ id: 1, name: '4K' }, { id: 2, name: '横屏' }],
  labelTotal: 2,
};

const cover = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1f6feb"/><stop offset="1" stop-color="#e8590c"/></linearGradient></defs><rect width="640" height="360" fill="#343a40"/><rect width="640" height="360" fill="url(#g)" opacity=".55"/></svg>`;

async function mockMaterials(page) {
  const state = { bound: false };
  await page.route('**/api/materials/binding', route => {
    const method = route.request().method();
    if (method === 'POST') state.bound = true;
    if (method === 'DELETE') state.bound = false;
    const value = state.bound ? { account: 'orange-demo', accountKey: 'acct-demo', status: 'claimed' } : null;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ binding: value }) });
  });
  await page.route('**/api/materials/facets**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(facets) }));
  await page.route('**/api/materials/labels**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authorization: facets.authorization, providerScope: 'company', pageNo: 1, pageSize: 20, labels: facets.publicLabels, total: 2 }) }));
  await page.route('**/api/materials/list**', route => {
    const group = new URL(route.request().url()).searchParams.get('twoLevelTypeIds');
    const items = group ? cards.filter((_, index) => String(101 + (index % 3)) === group) : cards;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      authorization: facets.authorization, providerScope: 'company', pageNo: 1, pageSize: 20,
      items, total: { sourceType: 'number', source: String(items.length) }, providerTotal: items.length, totalIsProviderTotal: true,
      filtered: { inspected: items.length, dropped: 0 }, grants: false,
    }) });
  });
  await page.route('**/covers/*.png', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: cover }));
  await page.route('**/api/auth/sign-out', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  return state;
}

const scratch = await mkdtemp(join(tmpdir(), 'orange-uiux-fixes-'));
for (const name of ['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS', 'TRASH_DIR']) process.env[`OPENFILM_${name}`] = join(scratch, name.toLowerCase());

let studio, browser, harness, harnessServer;
const measures = [];
const listCalls = [];
try {
  const root = join(process.env.OPENFILM_LIBRARY, '演示项目');
  await mkdir(join(root, '.film'), { recursive: true });
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets', 'a.svg'), svg('#1f6feb', '开场'));
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 1280, h: 720 }, tracks: [{ clips: [
    { id: 'a', src: 'assets/a.svg', at: 0, time: [0, 3] },
  ] }] }));
  const project = await openProject(root);

  studio = await startStudio({ port: 0, openBrowser: () => {} });

  /* ── the harness: the real cloud tab, the same library the pane mounts, the real shell corner ── */
  const fixture = join(openfilm, '.dev', 'uiux-harness-fixes');
  await mkdir(fixture, { recursive: true });
  const css = (await readdir(join(openfilm, 'studio', 'ui', 'dist', 'assets'))).find(name => /^index-.*\.css$/.test(name));
  const distCss = fixed(join(openfilm, 'studio', 'ui', 'dist', 'assets', css));
  const harnessComponent = fixed(join(ui, 'components', 'material-center', 'CloudMaterialsTab.tsx'));
  const harnessCenter = fixed(join(ui, 'components', 'MaterialCenter.tsx'));
  const harnessClient = fixed(join(ui, 'lib', 'material-center', 'client.ts'));
  const harnessAccount = fixed(join(shellDir, 'AccountExit.tsx'));

  await writeFile(join(fixture, 'cloud.html'), `<!doctype html><html data-theme="dark" lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/@fs/${distCss}"><style>html,body{margin:0;background:var(--bg-app);color:var(--text)}</style></head><body><div id="root"></div><script type="module" src="/cloud.tsx"></script></body></html>`);
  await writeFile(join(fixture, 'cloud.tsx'), [
    "import React from 'react';",
    "import {createRoot} from 'react-dom/client';",
    `import {CloudMaterialsTab} from '/@fs/${harnessComponent}';`,
    `import {MaterialCenter} from '/@fs/${harnessCenter}';`,
    `import {createMaterialsClient} from '/@fs/${harnessClient}';`,
    "const client=createMaterialsClient();",
    /* the pane's own mount: MediaPool mounts the same library, compact and on the cloud half, for the 合集 that is open */
    "function Harness(){return <div id='stage' style={{display:'flex',flexDirection:'column',width:820,height:920,background:'var(--bg-app)',color:'var(--text)',padding:10,boxSizing:'border-box'}}>",
    "  <CloudMaterialsTab client={client} renderLibrary={(group,onCount)=><MaterialCenter compact cloudTab group={group?{twoLevelId:group.id,oneLevelId:group.oneLevelId,name:group.name,scope:'company'}:null} draft={[]} draftReady draftReason={null} onDraftOperation={async()=>true} onDraftRetry={async()=>true} onGroupCount={onCount}/>} />",
    "</div>}",
    "createRoot(document.getElementById('root')!).render(<Harness/>);",
  ].join('\n'));

  await writeFile(join(fixture, 'shell.html'), `<!doctype html><html data-theme="dark" lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/@fs/${distCss}"><style>html,body{margin:0;height:100%;background:var(--bg-app);color:var(--text)}#frame{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body><iframe id="frame"></iframe><div id="root"></div><script type="module" src="/shell.tsx"></script></body></html>`);
  await writeFile(join(fixture, 'shell.tsx'), [
    "import React from 'react';",
    "import {createRoot} from 'react-dom/client';",
    `import {AccountExit} from '/@fs/${harnessAccount}';`,
    "import '/@fs/" + fixed(join(shellDir, 'shell.css')) + "';",
    `const params=new URLSearchParams(location.search);`,
    "const frame=document.getElementById('frame') as HTMLIFrameElement;",
    "frame.src=String(params.get('studio')??'about:blank');",
    "function Harness(){",
    "  const [said,setSaid]=React.useState(0);",
    "  React.useEffect(()=>{void fetch('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});},[said]);",
    "  return <><AccountExit onSignOut={()=>setSaid(n=>n+1)}/><span id='said' style={{position:'fixed',left:8,bottom:8,font:'12px system-ui',opacity:.6}}>{said?'已按退出登录（sign-out 已发出）':''}</span></>;",
    "}",
    "createRoot(document.getElementById('root')!).render(<Harness/>);",
  ].join('\n'));

  const vite = (await import(pathToFileURL(require.resolve('vite')).href)).createServer;
  const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
  const tailwind = (await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)).default;
  harness = await vite({
    configFile: false, root: fixture, cacheDir: join(fixture, '.vite'),
    plugins: [react(), tailwind()],
    resolve: { alias: [{ find: /^@\//, replacement: fixed(ui) + '/' }, { find: /^openfilm\/studio-ui/, replacement: fixed(join(openfilm, 'studio', 'ui', 'src')) }], dedupe: ['react', 'react-dom'] },
    server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [fixture, ui, repo] } },
    appType: 'spa',
  });
  harnessServer = createHttpServer(harness.middlewares);
  await new Promise((done, fail) => { harnessServer.once('error', fail); harnessServer.listen(0, '127.0.0.1', done); });
  const harnessOrigin = `http://127.0.0.1:${harnessServer.address().port}`;

  browser = await chromium.launch({ headless: true, ...(process.env.ORANGE_CHANNEL ? { channel: process.env.ORANGE_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, locale: 'zh-CN', reducedMotion: 'reduce', deviceScaleFactor: 1 });
  const problems = [];

  /* ── 1 + 2: the cloud tab: small cards, then the two-level 合集 list ── */
  const cloud = await context.newPage();
  cloud.setDefaultTimeout(15000);
  cloud.on('pageerror', error => problems.push('pageerror: ' + error.message));
  cloud.on('request', request => { if (request.url().includes('/api/materials/list')) listCalls.push(request.url().replace(/^https?:\/\/[^/]+/, '')); });
  cloud.on('response', async response => {
    if (!response.url().includes('/api/materials/list')) return;
    listCalls.push(response.status() + ' ' + (await response.text().catch(() => '')).slice(0, 120));
  });
  await mockMaterials(cloud);
  await cloud.goto(`${harnessOrigin}/cloud.html`);
  await cloud.locator('[data-action="claim-binding"]').click();
  await cloud.locator('[data-field="binding-account"]').fill('orange-demo');
  await cloud.locator('[data-action="binding-submit"]').click();
  await cloud.locator('[data-state="bound"]').waitFor();
  try {
    await cloud.locator('[data-material-card]').first().waitFor({ timeout: 20000 });
  } catch (error) {
    console.log('DEBUG bound text\n' + (await cloud.locator('[data-material-center]').innerText()).slice(-2500));
    console.log('DEBUG list calls ' + JSON.stringify(listCalls));
    await cloud.screenshot({ path: join(here, 'debug-cloud-fixes.png') });
    throw error;
  }
  await cloud.waitForTimeout(900);

  const grid = await cloud.locator('[data-view-pane="cards"]').first();
  /* one card under the pointer: its two actions are the only things it adds */
  await cloud.locator('[data-material-card]').first().hover();
  await cloud.waitForTimeout(300);
  const hoverActions = await cloud.locator('[data-material-card]').first().evaluate(node => [...node.querySelectorAll('[data-action]')].map(action => ({ action: action.getAttribute('data-action'), width: Math.round(action.getBoundingClientRect().width), opacity: getComputedStyle(action).opacity })));
  const cardBoxes = await cloud.locator('[data-material-card]').evaluateAll(nodes => {
    /* clipped by an ancestor (the card keeps the full card's words in an `sr-only` line): not drawn */
    const clipped = node => {
      for (let at = node; at; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.clipPath && style.clipPath !== 'none') return true;
        if (style.overflow === 'hidden' && at.getBoundingClientRect().width <= 1) return true;
      }
      return false;
    };
    return nodes.map(node => {
      const box = node.getBoundingClientRect();
      const drawn = [...node.querySelectorAll('[data-badge]')].filter(badge => {
        const style = getComputedStyle(badge);
        const rect = badge.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 1 && rect.height > 1 && !clipped(badge);
      });
      const meta = node.querySelector('[data-field="author"]');
      const metaShown = meta ? meta.getBoundingClientRect().width > 1 && !clipped(meta) : false;
      return {
        width: Math.round(box.width), height: Math.round(box.height), x: Math.round(box.x), y: Math.round(box.y),
        badgesDrawn: drawn.length, badgeNames: drawn.map(badge => badge.getAttribute('data-badge')),
        metaRowDrawn: metaShown, stateDot: Boolean(node.querySelector('[data-badge="state"]')),
      };
    });
  });
  const columns = new Set(cardBoxes.map(box => box.x)).size;
  const gridStyle = await grid.evaluate(node => {
    const style = getComputedStyle(node);
    return { columns: style.gridTemplateColumns, gap: style.gap, width: Math.round(node.getBoundingClientRect().width) };
  });
  measures.push({ shot: 'cloud-grid-compact.png', cards: cardBoxes.length, cardWidth: cardBoxes[0]?.width, columns, gridStyle, badgesDrawnPerCard: cardBoxes[0]?.badgesDrawn, badgeNames: cardBoxes[0]?.badgeNames, metaRowDrawn: cardBoxes[0]?.metaRowDrawn, cardHeight: cardBoxes[0]?.height, hoverActions });
  await grid.screenshot({ path: join(here, 'cloud-grid-compact.png') });

  /* one one-level row unfolded: the 合集 under it as rows, then the breadcrumb of the one opened */
  await cloud.locator('[data-group-toggle="10"]').click();
  await cloud.locator('[data-group-section="10"] [data-group-card]').first().waitFor();
  await cloud.waitForTimeout(400);
  const tree = await cloud.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-group-section], [data-group-card], [data-group-all]')].filter(node => node.getBoundingClientRect().height > 0);
    const of = node => {
      const box = node.getBoundingClientRect();
      return { top: Math.round(box.top), height: Math.round(box.height), left: Math.round(box.left), width: Math.round(box.width), text: (node.textContent ?? '').trim().slice(0, 40) };
    };
    const section = document.querySelector('[data-group-section="10"]');
    const sections = [...document.querySelectorAll('[data-group-toggle]')].map(of);
    const cards = [...document.querySelectorAll('[data-group-card]')].map(of);
    return {
      rows: rows.length, sections, cards,
      sectionRowHeight: sections[0]?.height, cardsIndent: (cards[0]?.left ?? 0) - (sections[0]?.left ?? 0),
      collections: document.querySelector('[data-collections]')?.getBoundingClientRect().height,
      sectionCountText: section?.querySelector('[data-group-sections-count]')?.textContent ?? null,
      pills: document.querySelectorAll('[data-collections] .rounded-full').length,
    };
  });
  measures.push({ shot: 'cloud-collections-tree.png', ...tree });

  /* the breadcrumb: open the 合集 under the unfolded category, then one crop holds the list and the crumb */
  await cloud.locator('[data-group-card]').first().click();
  await cloud.locator('[data-collections-crumb]').waitFor();
  await cloud.waitForTimeout(600);
  const crumb = await cloud.locator('[data-collections-crumb]').evaluate(node => node.textContent);
  measures.push({ crumb, dwelt: true });
  const band = await cloud.evaluate(() => {
    const list = document.querySelector('[data-collections]')?.getBoundingClientRect();
    const bar = document.querySelector('[data-collections-crumb]')?.getBoundingClientRect();
    if (!list || !bar) return null;
    return { x: Math.floor(list.x) - 2, y: Math.floor(list.y) - 2, width: Math.ceil(list.width) + 4, height: Math.ceil(bar.bottom - list.top) + 6 };
  });
  if (band) await cloud.screenshot({ path: join(here, 'cloud-collections-tree.png'), clip: band });
  await cloud.screenshot({ path: join(here, 'cloud-collections-tree-open.png') });

  /* ── 3: the shell corner over the real Studio top bar ── */
  const shell = await context.newPage();
  shell.setDefaultTimeout(20000);
  shell.on('pageerror', error => problems.push('pageerror(shell): ' + error.message));
  await shell.addInitScript(value => { try { localStorage.setItem('openfilm.workspace.current.v2', value); } catch { /* first run */ } }, profile());
  const studioUrl = `${studio.origin}/projects/${project.id}?key=${studio.key}`;
  await shell.goto(`${harnessOrigin}/shell.html?studio=${encodeURIComponent(studioUrl)}`);
  const frame = shell.frameLocator('#frame');
  await shell.locator('#frame').waitFor();
  const modeSwitch = frame.locator('[data-work-mode]');
  await modeSwitch.waitFor({ timeout: 30000 });
  /* The window's own controls sit in the top bar's last 138px on Windows (bridge.ts INSET_RIGHT, which
     applyStudioHost writes as --titlebar-right-x): a browser page has no host, so the harness sets what the app sets. */
  const studioFrame = shell.frames().find(entry => entry !== shell.mainFrame());
  await studioFrame?.evaluate(() => document.documentElement.style.setProperty('--titlebar-right-x', '138px'));
  await shell.waitForTimeout(2500);
  const trigger = shell.locator('.orange-account-trigger');
  const closed = await trigger.boundingBox();
  const modeBox = await modeSwitch.boundingBox();
  await trigger.click();
  await shell.locator('.orange-account-panel').waitFor();
  await shell.waitForTimeout(400);
  const panel = await shell.locator('.orange-account-panel').boundingBox();
  const exitButton = await shell.locator('.orange-account-exit').boundingBox();
  await shell.screenshot({ path: join(here, 'shell-exit-window.png') });
  /* the corner band: the 剪辑 switch, the gap, the 20px button and the 120px panel it opened */
  await shell.screenshot({ path: join(here, 'shell-exit-compact.png'), clip: { x: WIDTH - 420, y: 0, width: 420, height: 120 } });
  const corners = {
    viewport: await shell.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    trigger: closed, modeSwitch: modeBox, panel, exitButton,
    overlapWithModeSwitch: closed && modeBox ? !(closed.x + closed.width <= modeBox.x || modeBox.x + modeBox.width <= closed.x || closed.y + closed.height <= modeBox.y || modeBox.y + modeBox.height <= closed.y) : null,
    gapToModeSwitch: closed && modeBox ? Math.round(modeBox.x + modeBox.width - closed.x) : null,
  };
  /* the old button (right:150, its words ~62px wide) against the same switch: what the person reported */
  const oldBox = corners.viewport.width ? { x: corners.viewport.width - 150 - 62, width: 62, y: 6, height: 18 } : null;
  corners.oldButtonWouldOverlap = oldBox && modeBox
    ? !(oldBox.x + oldBox.width <= modeBox.x || modeBox.x + modeBox.width <= oldBox.x || oldBox.y + oldBox.height <= modeBox.y || modeBox.y + modeBox.height <= oldBox.y)
    : null;
  measures.push({ shot: 'shell-exit-compact.png', ...corners });
  /* the panel closes on a press elsewhere, and stays a 120px panel: the click that follows never reaches the switch */
  await shell.mouse.move(40, 600);
  await shell.mouse.click(40, 600);
  await shell.waitForTimeout(200);
  measures.push({ panelStillOpenAfterOutsidePress: await shell.locator('.orange-account-panel').count() });

  console.log('MEASURES ' + JSON.stringify(measures, null, 1));
  console.log('PROBLEMS ' + JSON.stringify([...new Set(problems)].slice(0, 10)));
} finally {
  await browser?.close();
  await harness?.close();
  await harnessServer?.close?.();
  await studio?.close();
  await rm(join(openfilm, '.dev', 'uiux-harness-fixes'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
