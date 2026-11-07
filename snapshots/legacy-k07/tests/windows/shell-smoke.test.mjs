import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const desktop = join(repository, 'apps', 'desktop');
const main = join(desktop, 'dist', 'main', 'index.js');
const requireDesktop = createRequire(join(desktop, 'package.json'));
const runFile = promisify(execFile);

function isInside(root, path) {
  const location = relative(root, path);
  return Boolean(location && !isAbsolute(location) && location.split(sep)[0] !== '..');
}

async function within(promise, ms, message) {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: timer.signal }).then(() => { throw new Error(message); }),
    ]);
  } finally {
    timer.abort();
  }
}

async function cleanUpProcess(child, diagnostic) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  // The only process eligible for forced cleanup is this launch's captured child.
  // On Windows, /T also stops its renderer/utility descendants.
  const exit = once(child, 'exit', { signal: AbortSignal.timeout(7_000) });
  const kill = runFile(join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
    ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000, windowsHide: true });
  const [killResult, exitResult] = await Promise.allSettled([kill, exit]);
  if (exitResult.status === 'rejected') {
    throw new Error('Could not stop this smoke test\'s Electron process in time', {
      cause: killResult.status === 'rejected' ? killResult.reason : exitResult.reason,
    });
  }
  diagnostic(killResult.status === 'fulfilled'
    ? 'Forced cleanup of this smoke test\'s Electron process tree'
    : 'Electron exited before forced cleanup completed');
}

test('Windows starts one isolated, unprivileged shell and never enters a workspace without a first-party session', {
  timeout: 90_000,
}, async (t) => {
  await assert.doesNotReject(access(main), 'Desktop shell entry has not been built; run pnpm run build:shell');
  assert.equal(process.platform, 'win32', 'This smoke suite requires Windows and its isolated desktop lease');

  const executable = join(dirname(requireDesktop.resolve('electron')), 'dist', 'electron.exe');
  await assert.doesNotReject(access(executable), 'Install the pinned Electron Windows binary before running the smoke suite');
  const { _electron } = requireDesktop('playwright-core');
  const scratchRoot = join(repository, '.orange-local', 'shell-smoke');
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, 'run-'));
  const tmp = join(scratch, 'tmp');
  const roaming = join(scratch, 'roaming');
  const local = join(scratch, 'local');
  const legacyPaths = [join(roaming, 'OrangeCreation2'), join(roaming, '橙子创作中心')];
  const sentinelName = 'legacy-sentinel.txt';
  const sentinelText = 'legacy-profile-must-stay-unchanged\n';
  let child;

  try {
    await Promise.all([mkdir(tmp), mkdir(local), ...legacyPaths.map((path) => mkdir(path, { recursive: true }))]);
    for (const path of legacyPaths) await writeFile(join(path, sentinelName), sentinelText, { flag: 'wx' });

    const env = { ...process.env, APPDATA: roaming, LOCALAPPDATA: local, TEMP: tmp, TMP: tmp };
    delete env.ELECTRON_RUN_AS_NODE;
    const application = await _electron.launch({
      args: ['--force-device-scale-factor=1', '--disable-background-networking', desktop],
      cwd: desktop,
      env,
      executablePath: executable,
      timeout: 25_000,
    });
    child = application.process();

    const page = await application.firstWindow({ timeout: 10_000 });
    page.setDefaultTimeout(10_000);
    await page.getByRole('heading', { name: '橙子创作中心' }).waitFor({ state: 'visible' });
    const observed = await application.evaluate(({ app, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const window = windows[0];
      const prefs = window.webContents.getLastWebPreferences();
      return {
        count: windows.length,
        profile: app.getPath('userData'),
        logs: app.getPath('logs'),
        crashDumps: app.getPath('crashDumps'),
        sessionPath: window.webContents.session.storagePath,
        bounds: window.getBounds(),
        settings: [prefs.contextIsolation, prefs.sandbox, prefs.nodeIntegration],
        runtime: process.versions.electron,
        sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'),
      };
    });
    assert.equal(observed.count, 1);
    assert.equal(observed.sandboxDisabled, false);
    assert.deepEqual(observed.settings, [true, true, false]);
    assert.deepEqual([observed.bounds.width, observed.bounds.height], [1100, 760]);
    assert.equal(await page.evaluate(() => window.devicePixelRatio), 1);
    const expectedRuntime = requireDesktop('./package.json').devDependencies.electron;
    assert.equal(observed.runtime, expectedRuntime, 'Launched Electron must match the manifest pin');
    assert.ok(isInside(tmp, observed.profile), 'Profile must be inside the smoke TEMP directory');
    assert.ok(isInside(observed.profile, observed.logs), 'Logs must be inside the isolated profile');
    assert.ok(isInside(observed.profile, observed.crashDumps), 'Crash dumps must be inside the isolated profile');
    assert.equal(observed.sessionPath, observed.profile, 'Browser storage must use the isolated userData directory');
    assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process]), ['undefined', 'undefined']);
    assert.equal(new URL(page.url()).protocol, 'file:');
    assert.equal(await page.title(), '橙子创作中心');

    const requireStartupGate = async () => {
      await page.getByRole('heading', { name: '橙子创作中心' }).waitFor({ state: 'visible' });
      await page.getByRole('status').waitFor({ state: 'visible' });
      assert.equal(await page.getByRole('navigation').count(), 0, 'no workspace navigation before authentication');
      assert.equal(await page.getByRole('heading', { name: '创作工作区' }).count(), 0);
    };

    await requireStartupGate();
    await application.context().setOffline(true);
    await page.evaluate(() => { location.hash = '/creation'; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    assert.equal(new URL(page.url()).hash, '#/creation');
    await requireStartupGate();
    assert.equal((await application.windows()).length, 1);
    console.log('Electron ' + observed.runtime + '; isolated profile; 1100x760; device scale 1');

    const exit = once(child, 'exit');
    const closeWindow = application.evaluate(({ BrowserWindow }) => {
      const [lastWindow] = BrowserWindow.getAllWindows();
      // Let the inspector acknowledge the request before closing its app.
      setImmediate(() => lastWindow.close());
    });
    const [result] = await within(Promise.all([exit, closeWindow]), 10_000,
      'Closing the last desktop window did not exit Electron');
    assert.deepEqual(result, [0, null], 'Closing the last desktop window must exit Electron cleanly');
    for (const path of legacyPaths) {
      assert.deepEqual(await readdir(path), [sentinelName]);
      assert.equal(await readFile(join(path, sentinelName), 'utf8'), sentinelText);
    }
  } finally {
    await cleanUpProcess(child, (message) => t.diagnostic(message));
    // Only delete the unique directory mkdtemp created below the task-local scratch root.
    if (dirname(scratch) === scratchRoot) {
      await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    }
  }
});

const diagnosticFlag = '--orange-diagnostics-fd3';
const diagnosticSentinel = 'ORANGE_K07_SYNTHETIC_PATH';
const tokenSentinel = 'K07_SYNTHETIC_TOKEN';
const controlWarning = 'ORANGE_K07_UNRELATED_CONTROL';
const sensitiveMarkers = [diagnosticSentinel, tokenSentinel];

function watchSentinel(stream, markers = sensitiveMarkers) {
  const overlap = Math.max(...markers.map((marker) => marker.length)) - 1;
  let tail = '';
  let found = false;
  stream.on('data', (bytes) => {
    const fragment = tail + bytes.toString('latin1');
    found ||= markers.some((marker) => fragment.includes(marker));
    tail = fragment.slice(-overlap);
  });
  return () => found;
}

async function collectStartup(child, binding, Stream, deadlineMs) {
  const channel = child.stdio[3];
  const leaked = watchSentinel(channel);
  const stream = new Stream({ ...binding, childId: String(child.pid) });
  return new Promise((resolve) => {
    let settled = false;
    let bytes = 0;
    let lines = 0;
    const settle = (result, eof) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!eof) channel.destroy();
      resolve({ result, eof, bytes, lines, leaked: leaked() });
    };
    const timer = setTimeout(() => settle(stream.complete('deadline'), false), deadlineMs);
    channel.on('data', (chunk) => {
      bytes += chunk.length;
      for (const byte of chunk) if (byte === 10) lines++;
      const error = stream.push(String(child.pid), chunk);
      if (error) settle({ ok: false, error }, false);
    });
    channel.once('end', () => settle(stream.complete('eof'), true));
    channel.once('error', () => settle(stream.complete('deadline'), false));
  });
}

async function wrapIsolatedBundle(mainPath, fault, invalidProfilePrefix, nativeSessionPath) {
  const audited = join(dirname(mainPath), 'audited-main.js');
  await rename(mainPath, audited);
  const shim = fault === 'renderer-failure' ? `
import { BrowserWindow } from 'electron';
for (const method of ['loadFile', 'loadURL']) {
  const original = BrowserWindow.prototype[method];
  BrowserWindow.prototype[method] = function (...args) {
    process.emitWarning('Failed to load URL: file:///C:/${controlWarning} with error: ERR_FILE_NOT_FOUND', 'electron');
    return original.apply(this, args);
  };
}
` : fault === 'early-profile' ? `
import { app } from 'electron';
// Give native startup its own existing session path while the audited
// entry's real profile creation fails on a regular file as parent.
app.setPath('sessionData', ${JSON.stringify(nativeSessionPath)});
const mkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, ...args) {
  return mkdtempSync.call(this, prefix.endsWith('orange-shell-') ? ${JSON.stringify(invalidProfilePrefix)} : prefix, ...args);
};
` : fault === 'missing-terminal' ? `
const write = fs.write;
fs.write = function (fd, buffer, offset, length, position, callback) {
  if (fd === 3 && buffer.includes('desktop.shell.start.finish')) {
    queueMicrotask(() => callback(null, length, buffer));
    return;
  }
  return write.call(this, fd, buffer, offset, length, position, callback);
};
` : `
import { BrowserWindow } from 'electron';
// Only the isolated test entry can receive this private shutdown request.
const command = Buffer.from('close-window');
const request = Buffer.alloc(command.length);
function readCommand(offset) {
  fs.read(0, request, offset, request.length - offset, null, (error, bytesRead) => {
    if (error || !bytesRead) return;
    if (offset + bytesRead < request.length) readCommand(offset + bytesRead);
    else if (request.equals(command)) BrowserWindow.getAllWindows()[0]?.close();
  });
}
readCommand(0);
const close = fs.close;
fs.close = function (fd, callback) {
  if (fd === 3) {
    queueMicrotask(() => callback(null));
    return;
  }
  return close.call(this, fd, callback);
};
`;
  await writeFile(mainPath, "import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\n" +
    shim + "\nsyncBuiltinESMExports();\nawait import('./audited-main.js');\n");
}

async function logHasSentinel(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && await logHasSentinel(path)) return true;
    if (entry.isFile() && entry.name.endsWith('.log')) {
      const file = await open(path);
      try {
        const limit = 262_144;
        const buffer = Buffer.alloc(limit + 1);
        const { bytesRead } = await file.read(buffer);
        assert.ok(bytesRead <= limit, 'isolated diagnostic log exceeds scan budget');
        if (sensitiveMarkers.some((marker) => buffer.subarray(0, bytesRead).includes(marker))) return true;
      } finally {
        await file.close();
      }
    }
  }
  return false;
}

const rendererFailureFolders = new Map([
  ['renderer-failure', 'app fixture'],
  ['renderer-failure-left-bracket', 'app fixture ['],
  ['renderer-failure-right-bracket', 'app fixture ]'],
  ['renderer-failure-percent', 'app fixture %'],
]);

for (const scenario of [...rendererFailureFolders.keys(), 'early-profile', 'visible-window', 'missing-terminal', 'missing-eof']) {
  const rendererFailure = rendererFailureFolders.has(scenario);
  test('K07 Electron fd3: ' + scenario, { timeout: 35_000 }, async (t) => {
    assert.equal(process.platform, 'win32', 'K07 acceptance uses actual Windows Electron');
    const { DesktopStartupDiagnosticStream, STARTUP_EOF_DEADLINE_MS } =
      await import('../../packages/contracts/src/validate.ts');
    const git = (args) => runFile('git', args, { cwd: repository, timeout: 5_000, windowsHide: true });
    const { stdout: revision } = await git(['rev-parse', 'HEAD']);
    const { stdout: trustedPackage } = await git(['show', 'HEAD:apps/desktop/package.json']);
    const binding = { appVersion: JSON.parse(trustedPackage).version, buildCommit: revision.trim() };
    assert.match(binding.buildCommit, /^[0-9a-f]{40}$/);
    const manifest = JSON.parse(await readFile(join(dirname(main), 'build-identity.json'), 'utf8'));
    const mainSha256 = createHash('sha256').update(await readFile(main)).digest('hex');
    assert.deepEqual(manifest, { ...binding, mainSha256 }, 'audited build manifest must match HEAD and the main artifact');
    const executable = join(dirname(requireDesktop.resolve('electron')), 'dist', 'electron.exe');
    await access(executable);
    const scratchRoot = join(repository, '.orange-local', 'shell-smoke');
    await mkdir(scratchRoot, { recursive: true });
    const scratch = await mkdtemp(join(scratchRoot, diagnosticSentinel + '-' + tokenSentinel + '-'));
    let child;
    try {
      const tmp = join(scratch, 'tmp');
      const roaming = join(scratch, 'roaming');
      const local = join(scratch, 'local');
      const folder = rendererFailureFolders.get(scenario) ?? (scenario === 'visible-window' ? 'app fixture [%]' : 'app fixture');
      const app = join(scratch, folder);
      await Promise.all([tmp, roaming, local, join(app, 'dist')].map((path) => mkdir(path, { recursive: true })));
      const badTmp = join(scratch, 'not-a-directory');
      if (scenario === 'early-profile') await writeFile(badTmp, 'synthetic file');
      await writeFile(join(app, 'package.json'), trustedPackage);
      for (const component of ['main', 'preload', 'renderer']) {
        if (component !== 'renderer' || !rendererFailure) {
          await cp(join(desktop, 'dist', component), join(app, 'dist', component), { recursive: true });
        }
      }
      const copiedMain = join(app, 'dist', 'main', 'index.js');
      assert.equal(createHash('sha256').update(await readFile(copiedMain)).digest('hex'), mainSha256);
      if (scenario.startsWith('missing-') || rendererFailure || scenario === 'early-profile') {
        await wrapIsolatedBundle(copiedMain, rendererFailure ? 'renderer-failure' : scenario,
          join(badTmp, 'orange-shell-'), tmp);
      }

      const env = Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'].includes(key.toUpperCase())));
      Object.assign(env, { APPDATA: roaming, LOCALAPPDATA: local, TEMP: tmp, TMP: tmp });
      child = spawn(executable, [app, diagnosticFlag, '--disable-background-networking',
        '--disable-component-update', '--no-first-run'], {
        // The verification app must actually show a window; Windows SW_HIDE
        // can suppress Electron's first explicit BrowserWindow.show().
        cwd: scratch, env, windowsHide: false,
        stdio: [scenario === 'missing-eof' ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe'],
      });
      const exit = once(child, 'close');
      // Install a rejection handler even for scenarios where the child is cleaned up in finally.
      void exit.catch(() => {});
      const stdoutLeaked = watchSentinel(child.stdout);
      const stderrLeaked = watchSentinel(child.stderr);
      const unrelatedWarning = watchSentinel(child.stderr, [controlWarning]);
      const nativeFatal = watchSentinel(child.stderr, ['FATAL:', 'Check failed:']);
      const nativeAcl = watchSentinel(child.stderr, ['Access is denied', 'ALL APPLICATION PACKAGES']);
      const observed = await collectStartup(child, binding, DesktopStartupDiagnosticStream, STARTUP_EOF_DEADLINE_MS);
      const failure = rendererFailure || scenario === 'early-profile';
      const failureExit = failure ? await within(exit, 5_000, 'failed Electron child did not exit') : undefined;
      const leaked = observed.leaked || stdoutLeaked() || stderrLeaked() ||
        await logHasSentinel(tmp) || await logHasSentinel(roaming) || await logHasSentinel(local);
      t.diagnostic('fd3 bytes=' + observed.bytes + ' lines=' + observed.lines +
        ' EOF=' + observed.eof + ' sentinel leaked=' + leaked + ' warning control=' + unrelatedWarning());
      if (failureExit) {
        t.diagnostic('Failure process exit=' + failureExit[0] + ' signal=' + failureExit[1] + ' native fatal=' + nativeFatal() + ' native ACL=' + nativeAcl());
        assert.deepEqual(failureExit, [1, null]);
      }
      if (rendererFailure) assert.equal(unrelatedWarning(), true, 'unrelated Electron warning must remain visible');

      if (scenario.startsWith('missing-')) {
        assert.equal(leaked, false, 'a synthetic path or token was disclosed by a startup output');
        assert.equal(observed.result.ok, false, 'collector must not accept incomplete startup evidence');
        assert.deepEqual(observed.result.error, { code: 'DIAGNOSTIC_INCOMPLETE', path: '$stream' });
        assert.equal(observed.lines, scenario === 'missing-terminal' ? 1 : 2);
        assert.equal(observed.eof, scenario === 'missing-terminal');
        if (scenario === 'missing-eof') {
          // First prove the collector rejected missing EOF. Only then ask the
          // real Electron window to close and wait for all child stdio to close.
          const sent = once(child.stdin, 'finish');
          child.stdin.end('close-window');
          const [closed] = await within(Promise.all([exit, sent]), 5_000, 'diagnostic window did not close gracefully');
          assert.deepEqual(closed, [0, null], 'diagnostic window must exit cleanly after the EOF rejection');
          t.diagnostic('Diagnostic window and child stdio closed normally after EOF rejection');
        }
        return;
      }
      assert.equal(observed.eof, true, 'fd3 must close after the terminal record');
      assert.equal(observed.result.ok, true, 'collector must observe a valid bound begin/finish pair');
      const { finish } = observed.result.value;
      assert.equal(finish.outcome, failure ? 'failed' : 'ok');
      if (failure) {
        assert.equal(finish.errorCode, rendererFailure ? 'SHELL_LOAD_FAILED' : 'SHELL_START_FAILED');
      } else {
        assert.equal(child.exitCode, null, 'successful startup leaves the window process open');
      }
      assert.equal(leaked, false, 'a synthetic path or token was disclosed by a startup output');
    } finally {
      await cleanUpProcess(child, (message) => t.diagnostic(message));
      if (dirname(scratch) === scratchRoot) {
        await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
      }
    }
  });
}
