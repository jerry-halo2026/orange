// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** Throwaway: MaterialCenter alone (cloudTab), with errors and the list answer printed. */
import { mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const openfilm = join(repo, 'packages', 'openfilm');
const ui = join(openfilm, 'studio', 'ui', 'src');
const require = createRequire(join(openfilm, 'package.json'));
const { chromium } = require('playwright-core');

const fixture = join(openfilm, '.dev', 'uiux-harness-probe');
const fixed = path => path.replaceAll('\\', '/');
try {
  await mkdir(fixture, { recursive: true });
  const css = (await readdir(join(openfilm, 'studio', 'ui', 'dist', 'assets'))).find(name => /^index-.*\.css$/.test(name));
  await writeFile(join(fixture, 'index.html'), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/@fs/${fixed(join(openfilm, 'studio', 'ui', 'dist', 'assets', css))}"><style>html,body{margin:0;background:var(--bg-app);color:var(--text)}</style></head><body><div id="root"></div><script type="module" src="/harness.tsx"></script></body></html>`);
  await writeFile(join(fixture, 'harness.tsx'), [
    "import React from 'react';",
    "import {createRoot} from 'react-dom/client';",
    `import {MaterialCenter} from '/@fs/${fixed(join(ui, 'components/MaterialCenter.tsx'))}';`,
    "function Harness(){return <div style={{display:'flex',flexDirection:'column',width:820,height:920,background:'var(--bg-app)',color:'var(--text)',padding:10,boxSizing:'border-box'}}>",
    "  <MaterialCenter compact cloudTab draft={[]} draftReady draftReason={null} onDraftOperation={async()=>true} onDraftRetry={async()=>true}/>",
    "</div>}",
    "createRoot(document.getElementById('root')!).render(<Harness/>);",
  ].join('\n'));
  const vite = (await import(pathToFileURL(require.resolve('vite')).href)).createServer;
  const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
  const server = await vite({ configFile: false, root: fixture, cacheDir: join(fixture, '.vite'), plugins: [react()], resolve: { alias: { '@': ui }, dedupe: ['react', 'react-dom'] }, server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [fixture, ui, repo] } }, appType: 'spa' });
  const http = createHttpServer(server.middlewares);
  await new Promise(done => http.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: 'zh-CN' });
  page.on('pageerror', error => console.log('PAGEERROR', error.message, '\nSTACK', error.stack?.slice(0, 1200)));
  const state = { bound: true };
  await page.route('**/api/materials/binding', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ binding: state.bound ? { account: 'orange-demo', accountKey: 'acct-demo', status: 'claimed' } : null }) }));
  const facets = { authorization: { layer: 'public', reason: 'demo' }, providerScope: 'company', videoType: 1, oneLevel: [{ id: 10, name: '城市', level: 1, children: [{ id: 101, name: '夜景', parentTypeId: 10, level: 2 }] }], twoLevel: [{ id: 101, name: '夜景', parentTypeId: 10, level: 2 }], states: [], publicLabels: [{ id: 1, name: '4K' }], labelTotal: 1 };
  await page.route('**/api/materials/facets**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(facets) }));
  const body = { authorization: facets.authorization, providerScope: 'company', pageNo: 1, pageSize: 20, items: [{ videoId: { value: '90001', sourceType: 1, source: 'demo' }, observation: { name: '城市夜景航拍 4K', coverUrl: '/covers/0.png', downloadCount: '120', collectCount: '20', accountName: '橙子影像', accountKey: 'acct-1', createTime: '2026-11-10 18:21:00', duration: 12, fileSize: 180000000, oneLevelVideoType: { id: 10, name: '城市' }, twoLevelVideoType: { id: 101, name: '夜景' }, videoLabels: [{ id: 1, name: '4K' }], videoState: { id: 1, name: '已审核', frontColor: '#fff', backgroundColor: '#2f9e44' }, videoType: 1 } }], total: 1, providerTotal: 1, totalIsProviderTotal: true, filtered: { inspected: 1, dropped: 0 }, grants: false };
  await page.route('**/api/materials/list**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.route('**/covers/*.png', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36"><rect width="64" height="36" fill="#555"/></svg>' }));
  await page.goto(`http://127.0.0.1:${http.address().port}/`);
  await page.waitForTimeout(3500);
  console.log('SELECTS', await page.locator('select[data-filter]').evaluateAll(nodes => nodes.map(node => [node.dataset.filter, node.value])));
  console.log('TEXT\n' + (await page.locator('#root').innerText()).slice(0, 1200));
  await page.screenshot({ path: join(here, 'debug-harness.png') });
  await browser.close();
  await server.close();
} finally {
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(0);
