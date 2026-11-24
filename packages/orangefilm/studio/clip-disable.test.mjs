// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { filmHtml, readFilmFile } from '../src/film-doc.mjs';
import { openProject } from './server/projects.mjs';
import { startStudio } from './server/server.mjs';

/*
 * The 0.3.0 UI turned a selected clip off with Shift+E or the clip's menu and marked it `data-block-disabled`; the
 * 0.3.2 base this repository is on dropped that from Studio (no `toggle-clip` in lib/keymap.ts, no Enable/Disable clip
 * item, no `data-block-disabled` in Timeline.tsx) while the film format kept `disabled`: film-doc still writes and reads
 * it, and the film runtime honours it (server/timeline.mjs skips disabled clips; server/nle-source.test.mjs covers the
 * editing-project export keeping them). This test states that as it is now, instead of asking for a control that is gone.
 */
test('the film format carries disabled clips and the runtime leaves them out, while the UI offers no way to set one', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'of-clip-disable-'));
  const names = ['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS'];
  const saved = new Map(names.map((name) => [`ORANGE_${name}`, process.env[`ORANGE_${name}`]]));
  for (const name of names) process.env[`ORANGE_${name}`] = join(scratch, name.toLowerCase());
  let studio, browser;
  try {
    const root = join(process.env.ORANGE_LIBRARY, 'Disable');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'card.html'), '<!doctype html><body style="margin:0;background:red"><script>window.film={duration:2,width:320,height:180,frame(){}}</script>');
    const film = filmHtml({ stage: { w: 320, h: 180 }, tracks: [
      { clips: [{ id: 'first', src: 'card.html', time: [0, 2], disabled: true }, { id: 'second', src: 'card.html', at: 2, time: [0, 2] }] },
    ] });
    await writeFile(join(root, 'film.html'), film);
    /* the format carries the flag: read back and written as it was */
    const read = readFilmFile(film).doc;
    assert.equal(read.tracks[0].clips[0].disabled, true, 'a disabled clip is part of the film, not dropped');
    assert.equal(read.tracks[0].clips[1].disabled, undefined, 'and a clip it does not name is not disabled');
    assert.match(film, /disabled/, 'the file says so where it says the clip');
    const project = await openProject(root);
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US', reducedMotion: 'reduce' });
    let edits = 0;
    await page.route(`**/api/projects/${project.id}/edit`, (route) => { edits += 1; return route.continue(); });
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    const blocks = page.locator('[data-block-id][data-block-kind="mg"]');
    await blocks.nth(1).waitFor({ state: 'visible' });
    assert.equal(await blocks.count(), 2, 'both clips are in the film, so both are on the timeline');

    /* the runtime the preview plays through leaves the disabled clip out and keeps the other */
    const runtime = page.frameLocator('[data-viewer-picture] iframe[title="film"]');
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-viewer-picture] iframe[title="film"]');
      return Boolean(frame);
    });
    for (let i = 0; i < 100; i++) {
      const cuts = await runtime.locator('body').evaluate(() => /** @type {any} */ (window).__filmCuts?.() ?? null).catch(() => null);
      if (Array.isArray(cuts) && cuts.length) {
        assert.deepEqual(cuts, [{ id: 'second', src: 'card.html', at: 2, end: 4 }], 'the runtime plays the clip that is not disabled');
        break;
      }
      assert.ok(i < 99, 'the film runtime says which cuts it plays');
      await page.waitForTimeout(100);
    }

    /* Studio offers no control for it: no mark, no menu item, and Shift+E (the 0.3.0 key) writes nothing */
    assert.equal(await page.locator('[data-block-disabled]').count(), 0, 'no clip carries a disabled mark');
    await blocks.nth(0).click({ position: { x: 20, y: 10 } });
    await blocks.nth(0).click({ button: 'right', position: { x: 20, y: 10 } });
    await page.getByRole('menu').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('menuitem', { name: /(Enable|Disable) clip/ }).count(), 0, 'the clip menu has no such item');
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
    await blocks.nth(0).click({ position: { x: 20, y: 10 } });
    await page.keyboard.press('Shift+E');
    /* a write would come at once; this window is only here to let one arrive if there were one */
    await page.waitForTimeout(800);
    assert.equal(edits, 0, 'Shift+E changes nothing, so nothing is written');
    assert.equal(await readFile(join(root, 'film.html'), 'utf8'), film, 'the film is as it was written');
    assert.equal((await blocks.count()), 2, 'and both clips are still there');
  } finally {
    await browser?.close();
    await studio?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
