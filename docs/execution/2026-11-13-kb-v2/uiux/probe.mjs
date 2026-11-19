// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** Throwaway probe: start a scratch Studio, render home and a project, report what is on screen. */
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const openfilm = join(repo, 'packages', 'openfilm');
const require = createRequire(join(openfilm, 'package.json'));
const { chromium } = require('playwright-core');
const { startStudio } = await import(pathToFileURL(join(openfilm, 'studio/server/server.mjs')).href);
const { openProject } = await import(pathToFileURL(join(openfilm, 'studio/server/projects.mjs')).href);
const { filmHtml } = await import(pathToFileURL(join(openfilm, 'src/film-doc.mjs')).href);

const scratch = await mkdtemp(join(tmpdir(), 'uiux-probe-'));
const envNames = ['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS', 'TRASH_DIR'];
for (const name of envNames) process.env[`OPENFILM_${name}`] = join(scratch, name.toLowerCase());
let studio; let browser;
try {
  const root = join(process.env.OPENFILM_LIBRARY, '演示项目');
  await mkdir(join(root, '.film'), { recursive: true });
  await mkdir(join(root, 'assets'), { recursive: true });
  const svg = (color, text) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${color}"/><text x="320" y="190" font-size="42" fill="#fff" text-anchor="middle" font-family="sans-serif">${text}</text></svg>`;
  for (const [name, color, text] of [['a', '#1f6feb', '开场'], ['b', '#13b9b2', '街景'], ['c', '#e8590c', '收尾']]) await writeFile(join(root, 'assets', `${name}.svg`), svg(color, text));
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 1280, h: 720 }, tracks: [{ clips: [
    { id: 'a', src: 'assets/a.svg', time: [0, 3] },
    { id: 'b', src: 'assets/b.svg', time: [3, 7] },
    { id: 'c', src: 'assets/c.svg', time: [7, 10] },
  ] }] }));
  const project = await openProject(root);
  studio = await startStudio({ port: 0, openBrowser: () => {} });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
  await page.goto(`${studio.origin}/?key=${studio.key}`);
  await page.waitForTimeout(2500);
  console.log('HOME URL', page.url());
  console.log('HOME TEXT\n' + (await page.locator('body').innerText()).slice(0, 1500));
  await page.screenshot({ path: join(here, 'debug-home.png') });
  await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
  await page.waitForTimeout(3500);
  console.log('PROJECT TEXT\n' + (await page.locator('body').innerText()).slice(0, 1500));
  await page.screenshot({ path: join(here, 'debug-project.png') });
  console.log('ERRORS', errors.slice(0, 10));
} finally {
  await browser?.close();
  await studio?.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
