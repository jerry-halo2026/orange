import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, cp, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const desktop = join(repository, 'apps', 'desktop');
const dist = join(desktop, 'dist');
const main = join(dist, 'main', 'index.js');
const studio = join(dist, 'studio');
const manifest = 'studio-build.json';
// Trusted test-controller pins, independent of the receipt read from dist.
const manifestSha256 = '4af97d4dc6f3c2bcfb4c43a163326dfba98cde25ecbd4cfd10f2b5c194e41016';
const electronSha256 = '15e815a2d04aed1a01787354b93cd2cab425f339b3beaef4f9e4193647f5399b';
const sourcePin = '2e18a4bdf54647b2ece3c0975a6f9573720c7821';
const requireDesktop = createRequire(join(desktop, 'package.json'));
const runFile = promisify(execFile);
const sha = (data) => createHash('sha256').update(data).digest('hex');

async function scratchDirectory(prefix) {
  const root = join(repository, '.orange-local', 'studio-smoke');
  await mkdir(root, { recursive: true });
  assert.equal(await realpath(root), resolve(root));
  const path = await mkdtemp(join(root, prefix));
  return {
    path,
    async close() {
      assert.equal(dirname(path), root);
      assert.equal(await realpath(path), resolve(path));
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('Studio Node adapter rejects untrusted, malformed, modified, extra and linked build inputs', async () => {
  const bytes = await readFile(join(studio, manifest));
  assert.equal(sha(bytes), manifestSha256, 'actual fixed Studio build is required first');
  const receipt = JSON.parse(bytes);
  const { getStudioSourceVersion, readStudioAssets } = await import('../../packages/film-adapter/src/node.ts')
    .catch((error) => {
      if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('verified build exists but the Studio Node adapter is absent');
      throw error;
    });
  assert.equal(getStudioSourceVersion(), sourcePin);
  const assets = readStudioAssets(studio, manifestSha256);
  assert.equal(assets.size, 10);
  assert.equal(assets.has('/' + manifest), false);
  assert.equal(sha(assets.get('/index.html').bytes), receipt.artifacts.find((x) => x.name === 'index.html').sha256);
  assert.throws(() => readStudioAssets(studio, '0'.repeat(64)), /Studio fixture build/);
  const temp = await scratchDirectory('assets-');
  try {
    const root = join(temp.path, 'studio');
    await cp(studio, root, { recursive: true });
    const cert = join(root, manifest);
    const html = join(root, 'index.html');
    const original = await readFile(html);
    for (const invalid of [
      Buffer.from('{'),
      Buffer.from(JSON.stringify({ ...receipt, source: { ...receipt.source, pin: '0'.repeat(40) } })),
      Buffer.from(JSON.stringify({ ...receipt, artifacts: receipt.artifacts.map((x, i) => i ? x : { ...x, name: '../index.html' }) })),
      Buffer.from(JSON.stringify({ ...receipt, artifacts: receipt.artifacts.map((x, i) => i ? x : receipt.artifacts[1]) })),
      Buffer.from(JSON.stringify({ ...receipt, artifacts: receipt.artifacts.map((x, i) => i ? x : { ...x, bytes: 1 }) })),
    ]) {
      await writeFile(cert, invalid);
      assert.throws(() => readStudioAssets(root, sha(invalid)), /Studio fixture build/);
    }
    await writeFile(cert, bytes);
    await writeFile(html, Buffer.alloc(original.length, 0x61));
    assert.throws(() => readStudioAssets(root, manifestSha256), /Studio fixture build/);
    await writeFile(html, original);
    const checked = readStudioAssets(root, manifestSha256);
    await writeFile(html, 'changed after verification');
    assert.deepEqual(checked.get('/index.html').bytes, original);
    await writeFile(html, original);
    await rm(html);
    assert.throws(() => readStudioAssets(root, manifestSha256), /Studio fixture build/);
    const hardlinkTarget = join(temp.path, 'html-target');
    await writeFile(hardlinkTarget, original);
    await link(hardlinkTarget, html);
    try {
      assert.throws(() => readStudioAssets(root, manifestSha256), /Studio fixture build/);
    } finally {
      await rm(html);
    }
    await writeFile(html, original);
    for (const path of [join(root, 'extra.txt'), join(root, 'assets', 'extra.woff2')]) {
      await writeFile(path, 'synthetic extra');
      assert.throws(() => readStudioAssets(root, manifestSha256), /Studio fixture build/);
      await rm(path);
    }
    const linked = join(temp.path, 'linked');
    await symlink(root, linked, 'junction');
    assert.throws(() => readStudioAssets(linked, manifestSha256), /Studio fixture build/);
    await rm(linked);
  } finally {
    await temp.close();
  }
});

// Executed as a different OS process, with no Chromium session or native capability.
async function rawProbe(studioOrigin, previewOrigin, outside) {
  const http = require('node:http');
  const { randomBytes } = require('node:crypto');
  if (outside) {
    return new Promise((resolve, reject) => {
      const req = http.get(outside + '/native-positive-control', { timeout: 1500 }, (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
        res.once('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('timeout', () => req.destroy(Error('outside positive control timed out')));
      req.on('error', reject);
    });
  }
  function request(origin, path, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request(origin, { path, headers, method, timeout: 1500 }, (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode));
      });
      req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
      req.on('timeout', () => req.destroy(Error('raw probe timed out')));
      req.on('error', (error) => error.code === 'ECONNREFUSED' ? resolve(error.code) : reject(error));
      req.end();
    });
  }
  const headers = { Origin: studioOrigin, 'Sec-Fetch-Site': 'same-origin' };
  const ws = { ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64') };
  return Promise.all([
    request(studioOrigin, '/api/projects', headers),
    request(studioOrigin, '/api/events?visible=0', ws),
    request(studioOrigin, '/', { 'Sec-Fetch-Site': 'none' }),
    request(previewOrigin, '/film.html?load=1&film-missing=skip&film-dpr=1', headers),
    request(studioOrigin, '/api/projects', { ...headers, Host: 'localhost:1' }),
    request(studioOrigin, '/api/projects', { ...headers, 'X-Orange-Studio-Access': 'f'.repeat(64) }),
    request(studioOrigin, '/api/projects/fixture-project/opened', headers, 'POST'),
  ]);
}

// This runs in the native test bootstrap, not the shell or Studio renderer.
async function nativeProbe({ mainUrl, manifestSha256, baseline, node, rawFile, fileCanaryUrl, expectedRuntime }) {
  const { app, BrowserWindow, session } = require('electron');
  console.log('STUDIO_STAGE native bootstrap entered');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const assert = require('node:assert/strict');
  const http = require('node:http');
  const { readFile } = require('node:fs/promises');
  const { fileURLToPath } = require('node:url');
  const { setTimeout: delay } = require('node:timers/promises');
  const run = promisify(execFile);
  const until = async (check, label, ms = 7500) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() >= end) throw Error(label);
      await delay(40);
    }
  };
  const raw = async (origins) => JSON.parse((await run(node, [rawFile, ...origins], {
    windowsHide: true, timeout: 5500,
  })).stdout);
  const gated = (wc) => wc.executeJavaScript(`({
    title: document.title, path: location.pathname, hash: location.hash, status: Boolean(document.querySelector('[role=status]')),
    workspace: Boolean(document.querySelector('nav')), studio: Boolean(document.querySelector('iframe'))
  })`);
  const gate = async (wc) => until(async () => {
    const state = await gated(wc);
    return state.title === '橙子创作中心' && state.status && !state.workspace && !state.studio && state;
  }, 'real Orange Auth gate not loaded');
  const stamp = (label) => console.log('STUDIO_STAGE ' + label);

  // Only RED needs to suppress the existing entry's unconditional show call.
  // Do not substitute its window, renderer, startup, or app identity.
  if (baseline) app.on('browser-window-created', (_event, window) => {
    let called = false;
    window.show = () => { called = true; };
    window.isVisible = () => called;
  });
  let control;
  globalThis[Symbol.for('orange.desktop.studio-smoke')] = (native) => { control = native; };
  await import(mainUrl);
  await app.whenReady();
  const shell = await until(() => BrowserWindow.getAllWindows()[0], 'real Orange BrowserWindow not created');
  const shellBefore = await gate(shell.webContents);
  const shellUrl = shell.webContents.getURL();
  assert.equal(new URL(shellUrl).protocol, 'file:');
  assert.equal(process.versions.electron, expectedRuntime);
  assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  stamp('compiled Orange shell and unverified Auth gate loaded');
  assert.ok(control?.open, 'real shell loaded but the native Studio fixture control is absent');
  assert.equal(shell.isVisible(), false);
  const initialChildren = [...shell.contentView.children];
  await assert.rejects(() => control.open('0'.repeat(64)), /Studio fixture build/);
  assert.deepEqual(shell.contentView.children, initialChildren, 'invalid receipt must not add a view');

  const first = await control.open(manifestSha256);
  stamp('native Studio view loaded verified document');
  const wc = first.view.webContents;
  const [studioOrigin, previewOrigin] = first.origins;
  assert.match(studioOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(previewOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(studioOrigin, previewOrigin);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.ok(shell.contentView.children.includes(first.view));
  assert.equal(wc.session.storagePath, null, 'Studio browser partition must be nonpersistent');
  assert.notEqual(wc.session, shell.webContents.session);
  const prefs = wc.getLastWebPreferences();
  assert.deepEqual([prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration, prefs.webSecurity,
    prefs.webviewTag, Boolean(prefs.preload)], [true, true, false, true, false, false], 'Studio browser capabilities');
  const page = () => wc.executeJavaScript(`({
    path: location.pathname, search: location.search, hash: location.hash, text: document.body.innerText,
    preview: document.querySelector('iframe')?.src, node: typeof require, proc: typeof process,
    electron: typeof window.electron, orange: typeof window.orangeAuth
  })`);
  const editor = await until(async () => {
    const observed = await page();
    return observed.path === '/projects/fixture-project' &&
      observed.text.includes('Orange local fixture project') && observed.preview &&
      !/正在绘制第一帧|drawing the first frame/i.test(observed.text) && observed;
  }, 'actual Studio editor and first drawn preview not observed');
  assert.deepEqual([editor.search, editor.hash, editor.node, editor.proc, editor.electron, editor.orange],
    ['', '', 'undefined', 'undefined', 'undefined', 'undefined']);
  const preview = await until(() => wc.mainFrame.frames.find((f) => f.url === editor.preview), 'preview native frame absent');
  const previewURL = new URL(preview.url);
  assert.equal(previewURL.origin, previewOrigin);
  assert.match(previewURL.pathname + previewURL.search, /^\/film\.html\?load=\d+&film-missing=skip(?:&film-dpr=[\d.]+)?$/);
  const bridge = await preview.executeJavaScript(`window.__orangeFixtureFirstSeek`);
  assert.ok(bridge?.source === 'openfilm-film' && bridge.type === 'seeked' && bridge.t === 0 &&
    Number.isSafeInteger(bridge.seq) && bridge.seq > 0,
    'actual App seek must be acknowledged by the preview');
  stamp('real App project and first seek/seeked');

  const fileMarker = 'orange-studio-existing-file-control';
  assert.equal(await readFile(fileURLToPath(fileCanaryUrl), 'utf8'), fileMarker);
  let canaryRequests = 0;
  const canary = http.createServer((_req, res) => {
    canaryRequests++;
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('outside-loopback-control');
  });
  canary.on('upgrade', (_req, socket) => { canaryRequests++; socket.destroy(); });
  canary.setTimeout(1500, (socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    canary.once('error', reject);
    canary.listen(0, '127.0.0.1', resolve);
  });
  const outside = 'http://127.0.0.1:' + canary.address().port;
  try {
    assert.ok(!first.origins.includes(outside));
    const positive = await raw([...first.origins, outside]);
    assert.deepEqual(positive, { status: 200, body: 'outside-loopback-control' });
    assert.equal(canaryRequests, 1, 'the independent third-origin canary must be reachable');
    await verifyBoundary();
  } finally {
    await new Promise((resolve) => {
      canary.close(resolve);
      canary.closeAllConnections();
    });
  }

  async function verifyBoundary() {
    const blockers = await preview.executeJavaScript(`(async () => {
      let dom = false, api = false, ws = false, popup = false, file = false, external = false, outsideWs = false, clipboard = false;
      try { dom = Boolean(parent.document.body); } catch {}
      try { api = (await fetch(${JSON.stringify(studioOrigin + '/api/projects')}, {
        headers: { 'X-Orange-Studio-Access': 'f'.repeat(64) }
      })).ok; } catch {}
      try {
        const result = await fetch(${JSON.stringify(fileCanaryUrl)});
        file = result.ok || (await result.text()).includes(${JSON.stringify(fileMarker)});
      } catch {}
      try { external = (await fetch(${JSON.stringify(outside + '/preview-fetch')})).ok; } catch {}
      try { popup = !!open(${JSON.stringify(studioOrigin)}, '_blank'); } catch {}
      try { clipboard = typeof (await navigator.clipboard.readText()) === 'string'; } catch {}
      const connect = (url) => new Promise((resolve) => {
        const socket = new WebSocket(url);
        const done = (value) => { socket.close(); resolve(value); };
        socket.onopen = () => done(true); socket.onerror = () => done(false);
        setTimeout(() => done(false), 600);
      });
      try { ws = await connect(${JSON.stringify(studioOrigin.replace('http:', 'ws:') + '/api/events?visible=0')}); } catch {}
      try { outsideWs = await connect(${JSON.stringify(outside.replace('http:', 'ws:') + '/preview-ws')}); } catch {}
      return { dom, api, ws, popup, file, external, outsideWs, clipboard, node: typeof require, electron: typeof window.electron,
        orange: typeof window.orangeAuth };
    })()`);
    assert.deepEqual(blockers, { dom: false, api: false, ws: false, popup: false, file: false, external: false, outsideWs: false,
      clipboard: false, node: 'undefined', electron: 'undefined', orange: 'undefined' });
    const attacks = await wc.executeJavaScript(`(async () => {
      const canRead = async (url, init) => { try { return (await fetch(url, init)).ok; } catch { return false; } };
      const request = new Request('/api/projects', { headers: { 'x-oRaNgE-sTuDiO-aCcEsS': 'fake-browser-header' } });
      const response = await fetch(request);
      const original = request.headers.get('x-orange-studio-access');
      const reflected = response.headers.get('x-orange-studio-access');
      const health = await (await fetch('/api/health')).text();
      const cookie = document.cookie;
      let popup = false;
      try { popup = !!open(${JSON.stringify(outside + '/popup')}, '_blank'); } catch {}
      const canUpgrade = (path) => new Promise((resolve) => {
        const socket = new WebSocket(path.startsWith('/') ? 'ws://' + location.host + path : path);
        const done = (value) => { socket.close(); resolve(value); };
        socket.onopen = () => done(true); socket.onerror = () => done(false);
        setTimeout(() => done(false), 800);
      });
      return { allowed: response.ok, original, reflected, health, cookie, popup, denied: await Promise.all([
        canRead('/api/projects?key=synthetic'), canRead('/api/projects?unknown=1'),
        canRead('/api/projects', { method: 'HEAD' }), canRead('/api/projects', { method: 'POST' }),
        canRead('/api/projects/fixture-project/opened', { method: 'POST', body: 'unexpected-write' }),
        canRead('/api/projects/fixture-project/captions'), canRead('/studio-build.json'),
        canRead('/api/projects/not-the-fixture'), canRead(${JSON.stringify(fileCanaryUrl)}),
        canRead(${JSON.stringify(outside + '/studio-fetch')}),
      ]), upgrades: await Promise.all([
        canUpgrade('/api/events?visible=1'), canUpgrade('/api/projects/fixture-project/events'),
        canUpgrade('/api/events?visible=2'), canUpgrade('/api/events?visible=1&key=synthetic'),
        canUpgrade('/api/projects/not-the-fixture/events'),
        canUpgrade(${JSON.stringify(outside.replace('http:', 'ws:') + '/studio-ws')}),
      ]) };
    })()`);
    assert.equal(attacks.allowed, true, 'renderer-supplied value is stripped and replaced only for exact native caller');
    assert.equal(attacks.original, 'fake-browser-header', 'native authority must not be visible to renderer');
    assert.equal(attacks.reflected, null, 'server must not reflect native authority');
    assert.equal(attacks.popup, false);
    assert.equal(attacks.cookie, '');
    assert.deepEqual(JSON.parse(attacks.health), { version: '0.0.0' });
    assert.ok(attacks.denied.every((x) => x === false));
    assert.deepEqual(attacks.upgrades, [true, true, false, false, false, false], 'exact WS allowlist');
    assert.deepEqual(await raw(first.origins), Array(7).fill(403), 'other-process spoofed headers, routes and upgrade');
    stamp('native ingress, raw spoof 403/403, no URL or cookie authority');

    // Passive test-only observers: a correct ready increases the real seek
    // sequence and produces its matching seeked; a wrong tuple must not.
    await wc.executeJavaScript(`(() => {
      const iframe = document.querySelector('iframe');
      const origin = new URL(iframe.src).origin;
      const acks = [];
      addEventListener('message', (e) => {
        if (e.source === iframe.contentWindow && e.origin === origin &&
            e.data?.source === 'openfilm-film' && e.data.type === 'seeked') acks.push([e.data.t, e.data.seq]);
      });
      Object.defineProperty(window, '__studioSmokeAcks', { value: acks });
    })()`);
    await preview.executeJavaScript(`(() => {
      const seeks = [];
      addEventListener('message', (e) => {
        if (e.source === parent && e.origin === ${JSON.stringify(studioOrigin)} &&
            e.data?.source === 'openfilm-studio' && e.data.type === 'seek') seeks.push([e.data.t, e.data.seq]);
      });
      Object.defineProperty(window, '__studioSmokeSeeks', { value: seeks });
    })()`);
    const history = async () => Promise.all([
      preview.executeJavaScript('window.__studioSmokeSeeks'), wc.executeJavaScript('window.__studioSmokeAcks'),
    ]);
    const ready = { source: 'openfilm-film', type: 'ready', duration: 0, width: 640, height: 360,
      sounds: [], spans: [], origin: await preview.executeJavaScript('performance.timeOrigin') };
    const proveSeek = async (count, previousSeq) => {
      const [seeks, acks] = await until(async () => {
        const events = await history();
        return events[0].length >= count && events[1].length >= count && events;
      }, 'a valid ready did not produce a new real seek/seeked pair');
      assert.equal(seeks.length, count);
      assert.deepEqual(seeks, acks);
      const [t, seq] = seeks[count - 1];
      assert.equal(t, bridge.t);
      assert.ok(Number.isSafeInteger(seq) && seq > previousSeq);
      return seq;
    };
    await preview.executeJavaScript(`parent.postMessage(${JSON.stringify(ready)}, ${JSON.stringify(studioOrigin)}); void 0`);
    const initialSeq = await proveSeek(1, bridge.seq);
    const tuple = (rightOrigin, rightSource) => wc.executeJavaScript(`(() => {
      const iframe = document.querySelector('iframe');
      dispatchEvent(new MessageEvent('message', {
        source: ${rightSource ? 'iframe.contentWindow' : 'window'},
        origin: ${JSON.stringify(rightOrigin ? previewOrigin : studioOrigin)}, data: ${JSON.stringify(ready)},
      }));
    })()`);
    await tuple(false, true);
    await delay(150);
    assert.deepEqual(await history(), [[[bridge.t, initialSeq]], [[bridge.t, initialSeq]]], 'wrong origin caused an extra seek');
    await tuple(true, false);
    await delay(150);
    assert.deepEqual(await history(), [[[bridge.t, initialSeq]], [[bridge.t, initialSeq]]], 'wrong source caused an extra seek');
    // A correct tuple through the identical injection must also be detected.
    await tuple(true, true);
    await proveSeek(2, initialSeq);
    stamp('live seek/seeked oracle detects both positive controls and rejects each wrong tuple');
    const externalCommits = [];
    const frameTreeNodeId = preview.frameTreeNodeId;
    wc.on('did-frame-navigate', (_event, url) => {
      if (url.startsWith(outside + '/')) externalCommits.push(url);
    });
    await preview.executeJavaScript(`location.href=${JSON.stringify(outside + '/frame')}; void 0`);
    await wc.executeJavaScript(`location.href=${JSON.stringify(outside + '/top')}; void 0`);
    await delay(120);
    assert.equal(wc.getURL(), studioOrigin + '/projects/fixture-project', 'external top-level navigation must not commit');
    assert.equal(externalCommits.length, 0, 'external subframe navigation must not commit');
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'blocked popups must not create a second window');
    assert.equal((await page()).preview, editor.preview, 'editor preview element must not be replaced by navigation');
    // Chromium's blocked error document can still expose the attempted URL
    // through WebFrameMain.url. Inspect the live document's security origin.
    const activePreview = wc.mainFrame.frames.find((f) => f.frameTreeNodeId === frameTreeNodeId);
    const securityOrigin = activePreview && await activePreview.executeJavaScript('globalThis.origin').catch(() => undefined);
    assert.ok(securityOrigin === previewOrigin || securityOrigin === 'null' || securityOrigin === undefined,
      'blocked preview must not obtain the external security origin');
    assert.equal(canaryRequests, 1, 'no renderer network, navigation, or popup reached the accessible third origin');
    stamp('top/frame navigation blocked; preview frame state=' +
      (securityOrigin === previewOrigin ? 'unchanged' : securityOrigin === 'null' ? 'opaque-error' : 'unavailable'));
    stamp('third-origin canary: controller 200, renderer hits=0; existing local file not readable');
  }

  const sameSite = { url: studioOrigin, name: 'studio-scope', value: 'own-synthetic-cookie' };
  await wc.session.cookies.set(sameSite);
  const separate = session.fromPartition('orange-studio-smoke-control');
  await separate.cookies.set({ ...sameSite, value: 'other-synthetic-cookie' });
  assert.equal((await wc.session.cookies.get({ url: studioOrigin }))[0].value, sameSite.value);
  assert.equal((await separate.cookies.get({ url: studioOrigin }))[0].value, 'other-synthetic-cookie');
  assert.deepEqual(await shell.webContents.session.cookies.get({ url: studioOrigin }), []);
  first.showProjects();
  await until(async () => {
    const observed = await page();
    return observed.path === '/' && !observed.preview && /我的项目|my projects/i.test(observed.text) &&
      /新建项目|new project/i.test(observed.text) && !/无法加载|failed to load/i.test(observed.text);
  }, 'actual App healthy project list did not return');
  stamp('healthy real projects list; same-origin cookies isolated');
  await first.close();
  await until(() => wc.isDestroyed(), 'explicit close did not destroy Studio contents');
  assert.deepEqual(shell.contentView.children, initialChildren, 'close removes only Studio view');
  assert.equal(shell.webContents.getURL(), shellUrl);
  assert.deepEqual(await gate(shell.webContents), shellBefore);
  assert.deepEqual(await raw(first.origins), Array(7).fill('ECONNREFUSED'));

  const second = await control.open(manifestSha256);
  assert.ok(second.origins.every((origin) => !first.origins.includes(origin)), 'reopen reuses no prior endpoint');
  assert.equal((await second.view.webContents.session.cookies.get({ url: second.origins[0] })).length, 0);
  // Exercise automatic close when the Studio renderer goes away.
  const secondContents = second.view.webContents;
  secondContents.forcefullyCrashRenderer();
  await until(() => secondContents.isDestroyed(), 'Studio renderer failure did not destroy its contents');
  await second.close(); // idempotent: wait for already-triggered cleanup
  assert.deepEqual(await raw(second.origins), Array(7).fill('ECONNREFUSED'));
  assert.deepEqual(await gate(shell.webContents), shellBefore);
  stamp('explicit close and renderer-error close both ports; Orange shell unchanged');
}

test('Windows real compiled Orange hosts Studio only in the native fixture; network and teardown are fail-closed', {
  skip: process.env.ORANGE_STUDIO_SMOKE_NODE_ONLY === '1',
  timeout: 48_000,
}, async (t) => {
  assert.equal(process.platform, 'win32');
  const baseline = process.env.ORANGE_STUDIO_SMOKE_BASELINE === '1';
  const exe = process.env.ORANGE_STUDIO_SMOKE_ELECTRON ||
    join(dirname(requireDesktop.resolve('electron')), 'dist', 'electron.exe');
  await assert.doesNotReject(access(exe), 'pin the actual Windows Electron runtime before running native smoke');
  assert.equal(sha(await readFile(exe)), electronSha256);
  assert.equal(sha(await readFile(join(studio, manifest))), manifestSha256);
  const build = JSON.parse(await readFile(join(dirname(main), 'build-identity.json')));
  const { stdout: head } = await runFile('git', ['rev-parse', 'HEAD'], { cwd: repository, windowsHide: true });
  assert.deepEqual(build, { appVersion: '0.0.0', buildCommit: head.trim(), mainSha256: sha(await readFile(main)) });
  const temp = await scratchDirectory('native-');
  let child;
  try {
    const scratch = temp.path;
    const tmp = join(scratch, 'tmp'), roaming = join(scratch, 'roaming'), local = join(scratch, 'local'), home = join(scratch, 'home');
    await Promise.all([tmp, roaming, local, home].map((path) => mkdir(path)));
    const rawFile = join(scratch, 'raw.cjs');
    await writeFile(rawFile, '(' + rawProbe + ')(...process.argv.slice(2)).then(x=>console.log(JSON.stringify(x)),()=>process.exit(1));');
    const fileCanary = join(scratch, 'existing-file-control.txt');
    await writeFile(fileCanary, 'orange-studio-existing-file-control', { flag: 'wx' });
    const entry = join(scratch, 'native.cjs');
    const args = { mainUrl: pathToFileURL(main).href, manifestSha256, baseline, node: process.execPath, rawFile,
      fileCanaryUrl: pathToFileURL(fileCanary).href,
      expectedRuntime: requireDesktop('./package.json').devDependencies.electron };
    await writeFile(entry, '(' + nativeProbe + ')(' + JSON.stringify(args) + ').then(()=>require("electron").app.exit(0),'
      + 'error=>{const at=String(error?.stack).match(/native\\.cjs:(\\d+)/)?.[1];'
      + 'console.error("STUDIO_ASSERT line="+at+" "+String(error?.message||"failed").split(/\\r?\\n/)[0]);'
      + 'require("electron").app.exit(1);});');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_.*|ORANGE_SUPABASE_.*|TEMP|TMP|APPDATA|LOCALAPPDATA|HOME|USERPROFILE)$/i.test(name)));
    Object.assign(env, { TEMP: tmp, TMP: tmp, APPDATA: roaming, LOCALAPPDATA: local, HOME: home, USERPROFILE: home });
    child = spawn(exe, ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--enable-logging=stderr',
      '--proxy-server=direct://', entry], { cwd: scratch, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8').on('data', (text) => { output = (output + text).slice(-8192); });
    child.stderr.setEncoding('utf8').on('data', (text) => { errors = (errors + text).slice(-8192); });
    const ended = await once(child, 'close', { signal: AbortSignal.timeout(41_000) });
    t.diagnostic('Electron child pid=' + child.pid + ' exit=' + ended[0] + ' signal=' + ended[1]);
    t.diagnostic('native indicators: fatal=' + /FATAL:|Check failed:/i.test(errors) +
      ' sandbox=' + /sandbox/i.test(errors) + ' ACL=' + /access is denied|ALL APPLICATION PACKAGES/i.test(errors));
    for (const line of (output + '\n' + errors).split(/\r?\n/)) {
      if (line.startsWith('STUDIO_STAGE ') || line.startsWith('STUDIO_ASSERT ')) t.diagnostic(line);
    }
    assert.deepEqual(ended, [0, null], 'compiled native Studio smoke did not complete');
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit', { signal: AbortSignal.timeout(3000) });
      const kill = runFile(join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { timeout: 2500, windowsHide: true });
      const [, result] = await Promise.allSettled([kill, done]);
      if (result.status === 'rejected') throw Error('Could not stop the captured Studio smoke process');
    }
    await temp.close();
  }
});
