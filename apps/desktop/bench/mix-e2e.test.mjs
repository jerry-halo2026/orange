// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * One real mix, end to end, in the bench's own app — no stub anywhere in the chain:
 *
 *   sign in → a project of this account's → two scene-group folders of real clips (ffmpeg, testsrc2) → two real voice
 *   takes (ffmpeg, sine) → `POST /api/fission-render/recipe` dry-run (staging + job) → the same request with `run:
 *   true` (the engine actually renders) → the report's own outputs on disk → Studio's window photographed on the
 *   film's page and on the home card that opens 超级混剪.
 *
 * The route and the contract it is judged by: docs/execution/2026-11-19-mix-contract.md (recipe → staging → job →
 * `report.json`), `packages/orangefilm/studio/server/fission-render-routes.mjs` (`POST /recipe`, dry-run unless
 * `run: true`), `fission-recipe.mjs` (who becomes what field) and `fission-runner.mjs` (the only executor).
 *
 * Three things have to be on the machine, and each absence is a skip that names the piece — never a quiet pass:
 *
 *   1. `.dev/bench-auth.env` — the bench's own sign-in (through `withBenchAuth`, app.mjs).
 *   2. a folder with `ffmpeg.exe` and `ffprobe.exe` for this test's own clips and voices: `ORANGE_FISSION_FFMPEG_DIR`,
 *      else `apps/desktop/.dev/ffmpeg` (a link to the app's pinned build is enough).
 *   3. a runnable Fission runtime — `dotnet`, `Fission.Cli.dll` and the media tools — as `fission-runtime.mjs` derives
 *      it (`dotnet` on the PATH, `workers/fission` built, an ffmpeg folder).
 *
 * Two environment facts this file arranges on purpose, both inside the run's own throwaway folder:
 *
 *   · The route resolves its engine paths through `fission-engine-paths.mjs` (`resolveEnginePaths`), which looks for
 *     `<dataDir>/runtime/ffmpeg-<version>/` — the same shape `apps/desktop/src/ffmpeg-runtime.mjs` installs into. The
 *     bench's data and Studio home are two folders (`dir/data`, `dir/home`), so both get a junction to the runtime this
 *     test found. Without one the route answers 503 `engine-paths` and nothing is rendered.
 *   · `FISSION_CLI_DLL` names the CLI for `fission-runner.mjs` (its default is a Debug net10.0 path under the current
 *     directory); it is handed to the app so the utility process's spawn finds the runtime that was verified here.
 *
 * What is asserted is the contract's own success criterion (§4): `code===0`, `Succeeded>=1`, every `Outputs[].Path`
 * inside the out folder and on disk with bytes in it — plus the job fields the recipe promised (§2: `Pick / Align /
 * Naming` are the engine's real names) and `StopReason`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { DESKTOP, buildShell, prepare, signIn, withBenchAuth } from './app.mjs';
import { findFissionRuntime, readConfiguration } from './fission-runtime.mjs';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The checkout this bench sits in (`apps/desktop/bench` → the repository). */
const REPO = join(DESKTOP, '..', '..');

/** The two scene groups, literally: the name is the folder under `video/` and `SceneGroups[].Name` (§1, §2). */
const GROUP_A = '01-开场';
const GROUP_B = '02-卖点';
/** The card that opens the mix workspace (homeCards.fission). */
const FISSION_CARD = '超级混剪';

/** Where a person's pinned ffmpeg may be: what they named, else the bench's own link (`apps/desktop/.dev/ffmpeg`). */
function mediaFolder() {
  const candidates = [String(process.env.ORANGE_FISSION_FFMPEG_DIR ?? '').trim(), join(DESKTOP, '.dev', 'ffmpeg')].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'ffmpeg.exe')) && existsSync(join(dir, 'ffprobe.exe'))) return { dir, candidates };
  }
  return { dir: null, candidates };
}

/**
 * `resolveEnginePaths` wants `<dataDir>/runtime/ffmpeg-<version>/`; give both folders the route may use as its data
 * folder a junction to the build this run verified. Inside the run's throwaway bench folder only.
 * @param {string} dir the bench folder @param {string} ffmpegExe the ffmpeg this run uses
 * @returns {string[]} the links made
 */
function linkEngineMedia(dir, ffmpegExe) {
  const source = dirname(ffmpegExe);
  const name = /^ffmpeg-\d/.test(basename(source)) ? basename(source) : 'ffmpeg-9.0.2';
  const made = [];
  for (const base of [join(dir, 'home', 'runtime'), join(dir, 'data', 'runtime')]) {
    mkdirSync(base, { recursive: true });
    const link = join(base, name);
    if (existsSync(link)) continue;
    try { symlinkSync(source, link, 'junction'); made.push(link); } catch { /* a run that already made it */ }
  }
  return made;
}

test('mix e2e: a recipe dry-runs into its job, the engine renders from it, and Studio shows the film', { timeout: 600_000 }, async (t) => {
  const started = Date.now();
  const auth = withBenchAuth(t);
  if (!auth) return;

  /* The clips and voices this run makes, and the runtime that renders them: the same pair. */
  const media = mediaFolder();
  if (!media.dir) {
    const said = `no ffmpeg/ffprobe folder for the mix — set ORANGE_FISSION_FFMPEG_DIR or place one at apps/desktop/.dev/ffmpeg (looked at: ${media.candidates.join(', ')})`;
    console.log(`Mix e2e skipped - ${said}`);
    t.skip(said);
    return;
  }
  const { PATH } = await loginShellEnvironment();
  const pathWithMedia = [media.dir, PATH].filter(Boolean).join(delimiter);
  const runtime = findFissionRuntime({ desktop: DESKTOP, environment: { ...process.env, PATH: pathWithMedia }, log: (line) => console.log(line) });
  if (!runtime.configFile) {
    console.log('Mix e2e skipped - no runnable local Fission runtime:');
    for (const problem of runtime.problems) console.log(`  - ${problem}`);
    t.skip(`local Fission runtime unavailable: ${runtime.problems.join(' | ')}`);
    return;
  }
  const { config, problems: configProblems } = readConfiguration(runtime.configFile);
  if (!config || configProblems.length) {
    const said = `the Fission runtime configuration is not usable: ${configProblems.join(' | ')}`;
    console.log(`Mix e2e skipped - ${said}`);
    t.skip(said);
    return;
  }
  console.log(`Mix e2e runtime: ${runtime.source} (${runtime.configFile})`);
  console.log(`  media tools: ${config.paths.FFmpeg} · cli: ${config.cli} · dotnet: ${config.dotnet}`);

  /* The run's own folders: everything it makes, plus one throwaway bench app. */
  const stamp = `${Date.now()}`;
  const batchId = `mix-e2e-${stamp.toString(36)}`;
  const dir = join(DESKTOP, '.dev', `mix-e2e-run-${stamp}`);
  const shots = join(DESKTOP, '.dev', 'mix-e2e');
  mkdirSync(shots, { recursive: true });
  prepare(dir);
  const engineMedia = linkEngineMedia(dir, config.paths.FFmpeg);

  /* The window's page is the built shell (`apps/desktop/shell/dist`); a checkout without a build has none to serve. */
  if (!existsSync(join(DESKTOP, 'shell', 'dist', 'index.html'))) buildShell();

  /* `ORANGE_FISSION_CONFIG_FILE` is the switch the app's utility process reads (fission-runtime.mjs); the app's own
     engine-path resolution is left to its own folders, so a media variable in this shell is not passed on. */
  process.env.ORANGE_FISSION_CONFIG_FILE = runtime.configFile;

  const launchEnv = { ...launcherEnvironment(process.env, pathWithMedia), ORANGE_DESKTOP_FLAVOR: 'bench', ORANGE_BENCH_DIR: dir, FISSION_CLI_DLL: config.cli };
  delete launchEnv.ORANGE_FISSION_FFMPEG_DIR;

  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: [DESKTOP], cwd: DESKTOP, env: launchEnv,
  });
  let page = null;
  /** Each link of the chain, as it went: the report, whatever the verdict turns out to be. */
  const links = [];
  /**
   * Run one link and record it. `basis` says what the link rested on: 'real' is the app, Studio and the engine as a
   * person has them; 'best-effort' is a step whose absence is reported but does not decide the verdict (a screenshot).
   */
  const link = async (name, work, basis = 'real') => {
    try {
      const said = await work();
      links.push({ name, ok: true, basis, said: said ?? '' });
      console.log(`  ok   ${name} (${basis})${said ? `: ${said}` : ''}`);
      return true;
    } catch (error) {
      links.push({ name, ok: false, basis, said: error?.message ?? String(error) });
      console.log(`  fail ${name} (${basis}): ${error?.message ?? error}`);
      if (page && !page.isClosed()) await page.screenshot({ path: join(dir, `failed-${name.replace(/[^\w-]+/g, '-')}.png`) }).catch(() => {});
      return false;
    }
  };

  /* The run's report: what it opened, what the job promised, what the engine did, what is on disk, what it shot. */
  const summary = {
    test: 'mix-e2e',
    ok: false,
    batchId,
    project: null,
    runtime: { source: runtime.source, configFile: runtime.configFile, ffmpeg: config.paths.FFmpeg, ffprobe: config.paths.FFprobe, cli: config.cli },
    studio: null,
    engineMediaLinks: engineMedia,
    job: null,
    staged: null,
    render: null,
    blocked: null,
    diagnostic: null,
    outputs: [],
    screenshots: [],
    links,
    timings: null,
  };

  /** A screenshot into `.dev/mix-e2e/<stamp>-<name>.png`, kept in the summary. */
  const shoot = async (name, target = page) => {
    const path = join(shots, `${stamp}-${name}.png`);
    await target.screenshot({ path });
    const size = statSync(path).size;
    summary.screenshots.push({ name, path, bytes: size });
    return `${path} (${size} B)`;
  };

  try {
    let run = null;
    for (let attempt = 0; attempt < 600 && !run; attempt += 1) {
      if (existsSync(join(dir, 'home/run.json'))) run = JSON.parse(readFileSync(join(dir, 'home/run.json'), 'utf8'));
      else await sleep(100);
    }
    assert.ok(run, 'Studio never advertised itself');
    summary.studio = { origin: run.origin };

    /** Studio's own window asks from its own origin; the launch key is the page's, as the app keeps it. */
    const call = async (path, body) => {
      const response = await fetch(`${run.origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-studio-key': run.key, origin: run.origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    /* 1. Sign in: the gate every route below passes. */
    await link('sign-in', async () => {
      await signIn(run, auth);
      const state = await call('/api/auth/state');
      assert.equal(state.body?.kind, 'active', `the session is ${state.body?.kind} (${state.body?.reason ?? 'no reason'})`);
      return 'active';
    });

    /* 2. The window, in the bench's language, on Studio's own home. */
    const windowed = await link('window', async () => {
      for (let attempt = 0; attempt < 600 && !page; attempt += 1) {
        page = app.context().pages().find((candidate) => candidate.url().startsWith(run.origin));
        if (!page) await sleep(100);
      }
      assert.ok(page, 'the app never showed Studio');
      const card = page.getByRole('button').filter({ has: page.getByRole('heading', { name: FISSION_CARD, exact: true }) });
      await card.first().waitFor({ timeout: 90_000 });
      await page.evaluate(() => localStorage.setItem('orangefilm.language', 'zh-CN'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await card.first().waitFor({ timeout: 90_000 });
      return 'Studio home on screen, zh-CN';
    });

    /* 3. This account's film: made, then opened in the app's own window (the projects list's own two calls). */
    let project = null;
    const created = await link('create-project', async () => {
      const answer = await call('/api/projects', { name: 'Mix e2e' });
      assert.equal(answer.status, 200, `making the film: HTTP ${answer.status} (${answer.body?.code ?? 'no code'})`);
      project = answer.body.project;
      assert.ok(project?.id && project?.path, `the film is ${JSON.stringify(answer.body)?.slice(0, 160)}`);
      summary.project = { id: project.id, path: project.path };
      return `${project.id} at ${project.path}`;
    });
    const opened = await link('open-project', async () => {
      if (!created) throw new Error('no film to open');
      const answer = await call('/api/open', { path: project.path, fallback: 0 });
      assert.equal(answer.status, 200, `opening the film: HTTP ${answer.status} (${answer.body?.code ?? 'no code'})`);
      return 'opened (HTTP 200)';
    });
    let film = null;
    film = await link('project-page', async () => {
      if (!opened) throw new Error('no film was opened');
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const candidate = app.context().pages().find((other) => other.url().includes('/projects/'));
        if (candidate) { page = candidate; break; }
        await sleep(100);
      }
      assert.ok(page.url().includes('/projects/'), `the window never showed the film: ${JSON.stringify(app.context().pages().map((other) => other.url()))}`);
      await page.waitForSelector('[data-timeline]', { timeout: 90_000 });
      return 'the film on screen';
    });

    /* 4. The material, made with the runtime's own ffmpeg: two clips per scene group (2 s, 640×360, 25 fps) and two
          voice takes (5 s, sine) — one file per voice, one complete line of speech each (§1, §3). */
    const lines = ['开场先说清楚这一条要讲的事。', '接着把两个卖点讲完，一条成片配一条口播。'];
    const clips = {
      [GROUP_A]: ['01.mp4', '02.mp4'],
      [GROUP_B]: ['01.mp4', '02.mp4'],
    };
    const voices = [
      { file: join(project?.path ?? '', 'voices', '01.mp3'), text: lines[0] },
      { file: join(project?.path ?? '', 'voices', '02.mp3'), text: lines[1] },
    ];
    const made = await link('media', async () => {
      if (!created) throw new Error('no film to fill');
      const ffmpeg = (...args) => execFileSync(config.paths.FFmpeg, ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      for (const group of [GROUP_A, GROUP_B]) {
        const at = join(project.path, 'assets', 'video', group);
        mkdirSync(at, { recursive: true });
        for (const name of clips[group]) {
          ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', join(at, name));
        }
      }
      mkdirSync(join(project.path, 'voices'), { recursive: true });
      ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'libmp3lame', '-b:a', '128k', voices[0].file);
      ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=660:duration=5', '-c:a', 'libmp3lame', '-b:a', '128k', voices[1].file);
      for (const path of [...Object.entries(clips).flatMap(([group, names]) => names.map((name) => join(project.path, 'assets', 'video', group, name))), voices[0].file, voices[1].file]) {
        assert.ok(statSync(path).size > 1024, `${path} is ${statSync(path).size} bytes`);
      }
      return `4 clips (2 s, 640×360, 25 fps) + 2 takes (5 s mp3) in ${project.path}`;
    });

    /* The recipe, as the contract writes it (§1): the group names are the folders, one line per finished video. */
    const recipe = {
      schema: 'orange/mix-recipe/1',
      groups: [GROUP_A, GROUP_B].map((name) => ({
        name, enabled: true, rule: 'random', takePerOutput: 0, speed: 1, useThenDelete: false, allowReuse: false,
        refs: clips[name].map((file) => ({ kind: 'asset', path: `assets/video/${name}/${file}` })),
      })),
      script: { provider: 'minimax', voice: 'female-shaonv', lines },
      params: { count: 4, audioUses: 2, threads: 2, subtitle: true, aspect: '9:16', pick: 'sceneOrder', split: 'scene' },
    };
    const request = { project: project?.id, recipe, voices };

    /* 5. The dry-run: staging laid out, the job computed, nothing started. Every field the contract names, read back. */
    /** Set when the route cannot see the project it was given: the one refusal that is the route's, not the media's. */
    let routeBlocked = null;
    const dry = await link('recipe-dry-run', async () => {
      if (!made) throw new Error('no material to mix');
      const answer = await call('/api/fission-render/recipe', { ...request, batchId });
      if (answer.status === 404 && answer.body?.code === 'project-required') {
        /* The project was made and opened through this Studio (links above), so a 404 here means the render route's own
           `projectById` could not read it: `render-batch-bridge.mjs` calls `projects.mjs`'s guarded entries outside
           `desktopAuth.runNative`, which is the only context the desktop app's project control admits. */
        routeBlocked = `POST /api/fission-render/recipe { project: "${project.id}" } -> HTTP 404 ${answer.body.code}: the render route cannot resolve a project this Studio made and opened`;
      }
      assert.equal(answer.status, 200, `the dry-run: HTTP ${answer.status} (${answer.body?.code ?? 'no code'})${routeBlocked ? ` — ${routeBlocked}` : ''}`);
      const body = answer.body;
      assert.equal(body?.ok, true, `the recipe has problems: ${JSON.stringify(body?.problems)} (notes ${JSON.stringify(body?.notes)})`);
      const job = body.job;
      assert.ok(job, 'the dry-run computed no job');
      assert.equal(job.Pick, 'SceneOrderRandomWithin', `Pick is ${job.Pick}`);
      assert.equal(job.Align, 1, `Align is ${job.Align}`);
      assert.equal(job.Naming, 'AudioFileName', `Naming is ${job.Naming}`);
      /* 两个平台的随包 ffmpeg 都带 libass（macOS 9.0.2 / Windows 9.0.2）；字幕应当开着。 */
      assert.equal(job.SubtitleEnabled, true, `SubtitleEnabled is ${job.SubtitleEnabled} (notes ${JSON.stringify(body.notes)})`);
      assert.deepEqual(job.SceneGroups.map((group) => group.Name), [GROUP_A, GROUP_B], `SceneGroups is ${JSON.stringify(job.SceneGroups)}`);
      /* The names are the folders, literally: what the job says is what staging wrote. */
      assert.deepEqual(readdirSync(body.staged.videoDir).sort(), [GROUP_A, GROUP_B].sort(), `video/ holds ${JSON.stringify(readdirSync(body.staged.videoDir))}`);
      assert.deepEqual((body.staged.meta.items ?? []).map((item) => item.text), lines, `meta items are ${JSON.stringify(body.staged.meta.items)}`);
      summary.job = {
        Count: job.Count, AudioUses: job.AudioUses, Threads: job.Threads, Pick: job.Pick, Align: job.Align, Naming: job.Naming,
        SplitMode: job.SplitMode, SceneThreshold: job.SceneThreshold, SubtitleEnabled: job.SubtitleEnabled,
        OutWidth: job.OutWidth, OutHeight: job.OutHeight, OutFps: job.OutFps, RandomHFlip: job.RandomHFlip,
        SceneGroups: job.SceneGroups.map((group) => group.Name),
      };
      summary.staged = { videoDir: body.staged.videoDir, audioDir: body.staged.audioDir, items: body.staged.meta.items, notes: body.notes };
      return `job ${job.Count} 条 · Pick ${job.Pick} · Align ${job.Align} · Naming ${job.Naming} · 字幕 ${job.SubtitleEnabled} · ${job.OutWidth}×${job.OutHeight}`;
    });

    /* 5b. A diagnostic, never a verdict: with the route refusing the project, which half is broken? The same recipe,
           the same two modules the route uses (`fission-recipe.mjs` → `fission-runner.mjs`) and the same engine paths
           (`fission-engine-paths.mjs` over this run's data folder) are driven here — so the report says whether the
           media, the engine and the job mapping are fine and only the route's project lookup is not. */
    if (routeBlocked) {
      await link('engine-fallback', async () => {
        const modules = join(REPO, 'packages', 'orangefilm', 'studio', 'server');
        const { normalizeRecipe, prepareRecipeRun } = await import(pathToFileURL(join(modules, 'fission-recipe.mjs')).href);
        const { resolveEnginePaths } = await import(pathToFileURL(join(modules, 'fission-engine-paths.mjs')).href);
        const { runFissionJob } = await import(pathToFileURL(join(modules, 'fission-runner.mjs')).href);
        const normalized = normalizeRecipe(recipe);
        assert.deepEqual(normalized.problems, [], `the recipe has problems: ${JSON.stringify(normalized.problems)}`);
        const engine = resolveEnginePaths({ dataDir: join(dir, 'home'), project: project.path });
        assert.equal(engine.ok, true, `the engine paths: ${JSON.stringify(engine.problems)}`);
        const prepared = prepareRecipeRun({ recipe: normalized.recipe, project: project.path, workRoot: engine.paths.WorkRoot, batchId: `${batchId}-d`, voices });
        assert.deepEqual(prepared.problems, [], `staging: ${JSON.stringify(prepared.problems)}`);
        assert.equal(prepared.job.Pick, 'SceneOrderRandomWithin', `Pick is ${prepared.job.Pick}`);
        assert.deepEqual(prepared.job.SceneGroups.map((group) => group.Name), [GROUP_A, GROUP_B], `SceneGroups is ${JSON.stringify(prepared.job.SceneGroups)}`);
        const result = await runFissionJob({
          job: prepared.job, enginePaths: engine.paths, root: join(project.path, '.film', 'fission', 'run'), task: 't1',
          attempt: `mix-d-${Date.now().toString(36)}`, dotnet: config.dotnet, dll: config.cli, timeoutMs: 480_000,
        });
        const outputs = (result.report?.outputs ?? []).map((output) => ({ path: output.path, bytes: (() => { try { return statSync(output.path).size; } catch { return 0; } })() }));
        summary.diagnostic = { attempt: result.attempt, code: result.code, message: result.message, succeeded: result.report?.succeeded ?? 0, failed: result.report?.failed ?? 0, stopReason: result.report?.stopReason ?? null, outputs, enginePaths: engine.paths };
        assert.equal(result.code, 0, `the engine exited ${result.code}: ${result.message}`);
        assert.ok((result.report?.succeeded ?? 0) >= 2, `${result.message}`);
        /* 组合空间小的池子会以 materialShort 收尾（组合用尽不算失败，见引擎的 MAT_COMBINATION_DUP 处理）。 */
        assert.ok(['countReached', 'materialShort'].includes(result.report?.stopReason ?? ''), `the report stopped at ${result.report?.stopReason}: ${JSON.stringify(result.report?.failures)}`);
        assert.equal(result.report?.failed ?? 0, 0, `组合用尽不是失败：${JSON.stringify(result.report?.failures)}`);
        for (const output of outputs) assert.ok(output.bytes > 1024, `${output.path} is ${output.bytes} bytes`);
        return `the same recipe renders without the route: code 0 · ${result.report.succeeded} 条 · ${result.report.stopReason} · ${outputs.length} files`;
      }, 'diagnostic');
    }

    /* 6. The same request, run: the engine renders; the report is the verdict (§4). */
    /** @type {any} */
    let renderedBody = null;
    const rendered = await link('render', async () => {
      if (!dry) throw new Error('the dry-run did not pass; not sending it to the engine');
      const answer = await call('/api/fission-render/recipe', { ...request, run: true, batchId });
      renderedBody = answer.body;
      assert.equal(answer.status, 200, `the render: HTTP ${answer.status} (${answer.body?.code ?? 'no code'}; ${answer.body?.message ?? ''})`);
      const body = answer.body;
      const render = body?.render;
      assert.ok(render, `the answer has no render: ${JSON.stringify(body)?.slice(0, 240)}`);
      summary.render = {
        attempt: render.attempt, code: render.code, timedOut: render.timedOut, outDir: render.outDir, message: render.message,
        errorCode: render.errorCode ?? null,
        report: render.report ? { succeeded: render.report.succeeded, failed: render.report.failed, stopReason: render.report.stopReason, failures: render.report.failures ?? [] } : null,
        problems: body.problems ?? [],
      };
      assert.equal(render.code, 0, `the engine exited ${render.code}: ${render.message}`);
      assert.ok(Number(render.report?.succeeded ?? 0) >= 2, `the report succeeded ${render.report?.succeeded} of ${render.report?.succeeded + render.report?.failed} (${render.report?.stopReason})`);
      /* 小池子会以 materialShort 收尾（组合用尽不是失败）；正常池子是 countReached。 */
      assert.ok(['countReached', 'materialShort'].includes(render.report?.stopReason ?? ''), `the report stopped at ${render.report?.stopReason}: ${JSON.stringify(render.report?.failures)}`);
      assert.equal(render.report?.failed ?? 0, 0, `组合用尽不是失败：${JSON.stringify(render.report?.failures)}`);
      return `code 0 · ${render.report.succeeded} 条 · ${render.report.stopReason}${render.report.failed ? ` · 失败 ${render.report.failed}` : ''}`;
    });
    /* The report names its own files: each one is on disk, inside the attempt's out folder, with bytes in it. */
    await link('outputs-on-disk', async () => {
      if (!rendered) throw new Error('nothing was rendered');
      const report = renderedBody?.render?.report;
      const outputs = Array.isArray(report?.outputs) ? report.outputs : [];
      assert.ok(outputs.length >= 2, `the report lists ${outputs.length} output(s): ${JSON.stringify(report)?.slice(0, 240)}`);
      const outDir = renderedBody.render.outDir;
      for (const output of outputs) {
        assert.ok(typeof output?.path === 'string' && output.path, `an output has no path: ${JSON.stringify(output)}`);        const stat = statSync(output.path);
        assert.ok(stat.size > 1024, `${output.path} is ${stat.size} bytes`);
        if (outDir) assert.ok(output.path.startsWith(outDir), `${output.path} is not inside ${outDir}`);
        summary.outputs.push({ index: output.index, title: output.title, durationSec: output.durationSec, path: output.path, bytes: stat.size, editPlanPath: output.editPlanPath ?? null });
      }
      /* 字幕真烧进去了：任一产物的 edit-plan 说 subtitles.outcome=applied。 */
      const planFile = summary.outputs.map((output) => output.editPlanPath).find(Boolean);
      if (planFile) {
        const plan = JSON.parse(readFileSync(planFile, 'utf8'));
        assert.equal(plan.subtitles?.outcome, 'applied', `subtitles did not apply: ${JSON.stringify(plan.subtitles)?.slice(0, 240)}`);
      }
      return `${outputs.length} files, ${summary.outputs.reduce((sum, output) => sum + output.bytes, 0)} bytes, all under ${outDir}`;
    });

    /* 7. Studio's window, photographed: the film's own page, then the card that opens 超级混剪 (best effort: entering
          the workspace asks the local batch service, and a screenshot is not what this lane decides). */
    await link('studio-screenshot', async () => {
      if (!film) throw new Error('the film is not on screen');
      assert.ok(page.url().includes('/projects/'), `the window is on ${page.url()}`);
      await page.waitForSelector('[data-timeline]', { timeout: 30_000 });
      return shoot('studio');
    });
    await link('fission-entry-screenshot', async () => {
      await page.locator('div[data-titlebar] button[aria-label="首页"]').first().click();
      const card = page.getByRole('button').filter({ has: page.getByRole('heading', { name: FISSION_CARD, exact: true }) });
      await card.first().waitFor({ timeout: 30_000 });
      const entry = await shoot('fission-entry');
      await card.first().click();
      await page.getByRole('heading', { name: FISSION_CARD, exact: true }).first().waitFor({ timeout: 60_000 });
      const workspace = await shoot('fission-workspace');
      return `入口 ${entry} · 工作区 ${workspace}`;
    }, 'best-effort');

    const broken = links.filter((entry) => !entry.ok && entry.basis !== 'best-effort' && entry.basis !== 'diagnostic');
    summary.ok = broken.length === 0;
    summary.blocked = routeBlocked;
    summary.timings = { startedAt: new Date(started).toISOString(), totalMs: Date.now() - started, links: Object.fromEntries(links.map((entry) => [entry.name, entry.ok])) };
    console.log(JSON.stringify(summary, null, 1));
    assert.deepEqual(broken, [], `links not passing: ${broken.map((entry) => `${entry.name} (${entry.said})`).join(' | ')}`);
  } finally {
    if (page && !page.isClosed() && links.some((entry) => !entry.ok)) await page.screenshot({ path: join(dir, 'failed.png') }).catch(() => {});
    const quitting = app.close().catch(() => {});
    if (!(await Promise.race([quitting.then(() => true), sleep(30_000).then(() => false)]))) {
      const pid = app.process()?.pid;
      console.log(`  (the app did not quit within 30 s; ending its process tree${pid ? ` ${pid}` : ''})`);
      if (pid) {
        const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        try { execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { app.process()?.kill('SIGKILL'); } catch { /* already gone */ } }
      }
      await Promise.race([quitting, sleep(10_000)]);
    }
  }
});
