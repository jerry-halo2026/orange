// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { filmHtml } from '../src/film-doc.mjs';
import { openProject } from './server/projects.mjs';
import { startStudio } from './server/server.mjs';

test('a marked timeline range can be cleared from the ruler menu, and Escape clears it with a clip selection', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'of-range-clear-'));
  const names = ['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS', 'TRASH_DIR'];
  const saved = new Map(names.map((name) => [`ORANGE_${name}`, process.env[`ORANGE_${name}`]]));
  for (const name of names) process.env[`ORANGE_${name}`] = join(scratch, name.toLowerCase());
  let studio, browser;
  try {
    const root = join(process.env.ORANGE_LIBRARY, 'Range');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'card.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#486b8e"/></svg>');
    const film = filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'card', src: 'assets/card.svg', time: [0, 4] }] }] });
    await writeFile(join(root, 'film.html'), film);
    const project = await openProject(root);
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => {
      window.openfilmHost = { version: 1, onSelection: (selection) => { window.lastSelection = selection; } };
    });
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    const block = page.locator('[data-block-id]').first();
    await block.waitFor({ state: 'visible' });
    const range = page.locator('[data-timeline-range]');
    await page.keyboard.press('i');
    await range.waitFor({ state: 'visible' });
    const ruler = page.locator('[data-timeline] [role="slider"]').first();
    await ruler.click({ button: 'right', position: { x: 40, y: 10 } });
    await page.getByRole('menu').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
    assert.equal(await range.count(), 1, 'the first Escape belongs to the open menu');
    /* Clearing a marked range is the ruler's own menu (timeline.menuClearRange, Timeline.tsx rulerItems): the 0.3.2 base
       moved it there from the toolbar button this test was written for. */
    await ruler.click({ button: 'right', position: { x: 40, y: 10 } });
    await page.getByRole('menuitem', { name: /Clear range/ }).click();
    await range.waitFor({ state: 'detached' });

    await block.click();
    await page.keyboard.press('i');
    await range.waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.lastSelection?.refs.some((ref) => ref.kind === 'clip'));
    await page.keyboard.press('Escape');
    await range.waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.lastSelection?.range === null && !window.lastSelection.refs.some((ref) => ref.kind === 'clip'));

    /* Clearing a viewing/editing range never writes the film. */
    assert.equal(await readFile(join(root, 'film.html'), 'utf8'), film);
  } finally {
    await browser?.close();
    await studio?.close();
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
