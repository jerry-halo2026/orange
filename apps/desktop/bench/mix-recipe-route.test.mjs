// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * agent 的「检索 → 配方」链路：`POST /api/materials/mix-recipe` 用本地索引拼出 10 条 9:16 配方，
 * 再交给 `POST /api/fission-render/recipe`（`run:false`）做一次 dry-run，确认引擎认这份配方。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { DESKTOP, prepare, signIn, withBenchAuth } from './app.mjs';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('素材检索拼配方：10 条 9:16，引擎 dry-run 接受', { timeout: 600_000 }, async (t) => {
  const auth = withBenchAuth(t);
  if (!auth) return;
  const dir = join(DESKTOP, '.dev', `mix-recipe-route-${Date.now()}`);
  prepare(dir);
  const indexDir = join(DESKTOP, '.dev', 'material-index-e2e');
  if (!existsSync(join(indexDir, 'index.json'))) {
    t.skip('no landed material index; run materials-examples-e2e first');
    return;
  }
  const { PATH } = await loginShellEnvironment();
  console.log('step: launch');
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: [DESKTOP], cwd: DESKTOP,
    env: { ...launcherEnvironment(process.env, PATH), OPENFILM_DESKTOP_FLAVOR: 'bench', OPENFILM_BENCH_DIR: dir, OPENFILM_MATERIAL_INDEX_DIR: indexDir },
  });
  try {
    let run = null;
    for (let attempt = 0; attempt < 600 && !run; attempt += 1) {
      if (existsSync(join(dir, 'home/run.json'))) run = JSON.parse(readFileSync(join(dir, 'home/run.json'), 'utf8'));
      else await sleep(100);
    }
    assert.ok(run, 'Studio never advertised itself');
    const call = async (path, body) => {
      const response = await fetch(`${run.origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-studio-key': run.key, origin: run.origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    await signIn(run, auth);
    console.log('step: signed in');
    const built = await call('/api/materials/mix-recipe', { query: '茶', count: 10, line: '一杯好茶' });
    console.log('step: built', built.status, built.body?.matched);
    assert.equal(built.status, 200, `mix-recipe: HTTP ${built.status} (${built.body?.code ?? ''})`);
    assert.ok(built.body?.matched >= 1, `matched ${built.body?.matched}: ${JSON.stringify(built.body?.problems)}`);
    assert.equal(built.body.recipe.params.aspect, '9:16');
    assert.equal(built.body.recipe.params.count, 10);
    assert.equal(built.body.recipe.groups[0].refs[0].kind, 'cloud');
    const created = await call('/api/projects', { name: 'Mix recipe e2e' });
    const project = created.body?.project ?? created.body;
    console.log('step: project', created.status, project?.path);
    const dry = await call('/api/fission-render/recipe', { project: project.id, recipe: built.body.recipe, voices: [], run: false });
    assert.equal(dry.status, 200, `dry-run: HTTP ${dry.status} (${dry.body?.code ?? ''} ${JSON.stringify(dry.body?.problems ?? [])})`);
    assert.equal(dry.body?.job?.Count, 10, `job Count ${dry.body?.job?.Count}`);
    assert.equal(dry.body?.job?.SubtitleEnabled, true);
    console.log(`mix recipe ok: matched=${built.body.matched} group=${built.body.groupName} count=${dry.body.job.Count}`);
  } catch (error) {
    console.log('ERROR', error?.message ?? error);
    throw error;
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(8000)]);
    try { app.process().kill(); } catch { /* gone */ }
  }
});
