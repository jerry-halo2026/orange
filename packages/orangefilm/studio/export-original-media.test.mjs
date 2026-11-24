// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { filmHtml } from '../src/film-doc.mjs';
import { openProject } from './server/projects.mjs';
import { startStudio } from './server/server.mjs';

test('editing-project exports keep effects automatically and always copy complete media', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'of-export-original-'));
  const names = ['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS', 'TRASH_DIR'];
  const saved = new Map(names.map((name) => [`ORANGE_${name}`, process.env[`ORANGE_${name}`]]));
  for (const name of names) process.env[`ORANGE_${name}`] = join(scratch, name.toLowerCase());
  let studio, browser;
  try {
    const root = join(process.env.ORANGE_LIBRARY, 'Originals');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'card.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#486b8e"/></svg>');
    await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'card', src: 'assets/card.svg', time: [0, 4] }] }] }));
    const project = await openProject(root);
    studio = await startStudio({ port: 0, openBrowser: () => {}, editorDir: process.env.ORANGE_TEST_EDITOR_DIR });
    browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    await page.addInitScript(() => {
      localStorage.setItem('orangefilm.exportCenter.v1', JSON.stringify({ dest: 'nle', nle: { app: 'premiere', footage: 'source', media: 'invalid' } }));
    });
    const queued = [];
    await page.route(`**/api/projects/${project.id}/exports`, async (route) => {
      if (route.request().method() !== 'POST') {
        const response = await route.fetch();
        return route.fulfill({ json: { ...await response.json(), drafts: { jianying: false, capcut: false } } });
      }
      queued.push(route.request().postDataJSON().jobs[0]);
      /* UI contract only: actual file generation is covered by server/nle-source.test.mjs. */
      await route.fulfill({ json: { exports: [] } });
    });
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    await page.locator('[data-block-id]').first().waitFor({ state: 'visible' });
    const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
    const open = async () => { await page.getByRole('button', { name: 'Export', exact: true }).click(); await dialog.waitFor({ state: 'visible' }); };
    /* Whether to link originals or copy them was a choice of the 0.3.1 dialog. The 0.3.2 base keeps effects always and
       writes the media it needs into the export folder, so there is nothing to choose (ExportCenter builds `media:
       'copy'` with no `footage`): the seed above is a browser that still has the old keys, and they must not come back. */
    const mediaChoice = () => dialog.getByRole('button', { name: /Link original files|Copy complete media|Keep original media/ }).count();
    for (const [app, format] of [['Premiere Pro', 'xml'], ['DaVinci Resolve', 'xml'], ['Final Cut Pro', 'fcpxml'], ['CapCut', 'capcut']]) {
      await open();
      await dialog.getByRole('button', { name: app, exact: true }).click();
      assert.equal(await dialog.getByRole('button', { name: /Keep original media|Keep effects automatically|Keep rendered effects/ }).count(), 0);
      assert.equal(await mediaChoice(), 0, 'the export no longer offers link or copy');
      await dialog.getByRole('button', { name: 'Export', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(queued.at(-1).format, format);
      assert.equal(Object.hasOwn(queued.at(-1), 'footage'), false);
      assert.equal(queued.at(-1).media, 'copy');
    }
    /* what the dialog does remember still comes back; what it no longer offers is not written */
    await open();
    assert.equal(await mediaChoice(), 0, 'reopening does not bring the choice back');
    assert.equal(await dialog.getByRole('button', { name: 'CapCut', exact: true }).getAttribute('aria-pressed'), 'true', 'the app exported last is remembered');
    /* The seed survives in the browser's storage as inert text (loadSettings spreads what it read), and nothing reads it:
       every job above was built with `media: 'copy'` and no `footage` while the seed said `footage: 'source'` and
       `media: 'invalid'`. So the check is that the dialog offers no such choice and that the seed is not turned into one. */
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('orangefilm.exportCenter.v1')).nle);
    assert.equal(stored.media, 'invalid', 'the leftover choice is left as it was, and nothing applies it');
  } finally {
    await browser?.close();
    await studio?.close();
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
