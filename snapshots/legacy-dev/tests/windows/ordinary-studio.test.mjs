// Focused actual-App behavior harness. Not a DOM, account, network, or native integration test.
// Finite hooks/JSX and bridge doubles isolate the renderer's own decisions; no production login bypass.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const localRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
let ts;
try { ts = localRequire('typescript'); }
catch {
  assert.ok(process.env.ORANGE_UI_TYPESCRIPT_PACKAGE, 'Set ORANGE_UI_TYPESCRIPT_PACKAGE to an existing pinned desktop package.json when dependencies are not installed here');
  ts = createRequire(process.env.ORANGE_UI_TYPESCRIPT_PACKAGE)('typescript');
}
assert.equal(ts.version, '5.9.3', 'Use the pinned compiler, not an installed replacement');
const appPath = fileURLToPath(new URL('../../apps/desktop/renderer/App.tsx', import.meta.url));
const source = await readFile(appPath, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const closed = () => ({ kind: 'closed', error: null });
const opened = () => ({ kind: 'open', error: null });

function harness({ authKind = 'signed-in', studio = {} } = {}) {
  const hooks = []; let cursor = 0; let dirty = true; let tree; const effects = [];
  const intervals = new Map(); const timeouts = new Map(); const listeners = new Map(); let timerId = 0;
  const calls = { open: [], close: [], state: [], logout: 0 }; let actualAuth = authKind;
  const bridge = studio === null ? undefined : {
    getState: async (...args) => { calls.state.push(args); return studio.getState ? studio.getState() : opened(); },
    open: async (...args) => { calls.open.push(args); return studio.open ? studio.open() : opened(); },
    close: async (...args) => { calls.close.push(args); return studio.close ? studio.close() : closed(); },
  };
  const window = {
    orangeAuth: { getState: async () => ({ kind: actualAuth }), signOut: async () => {
      ++calls.logout; actualAuth = 'signed-out'; return { kind: actualAuth };
    } },
    orangeStudio: bridge, location: { hash: '#/workspace' },
    setInterval: (fn, ms) => { intervals.set(++timerId, { fn, ms }); return timerId; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { timeouts.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timeouts.delete(id),
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
  };
  const react = {
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; dirty = true; }]; },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useEffect(effect, deps) { const index = cursor++; const old = hooks[index];
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        hooks[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); hooks[index].cleanup = effect(); });
      }
    },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const module = { exports: {} };
  const require = name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    return localRequire(name.startsWith('.') ? fileURLToPath(new URL(name, new URL('../../apps/desktop/renderer/App.tsx', import.meta.url))) : name);
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, require, window, console, setTimeout, clearTimeout }, { filename: appPath });
  function render() { if (!dirty) return; dirty = false; cursor = 0; tree = module.exports.App(); while (effects.length) effects.shift()(); }
  async function drain() { for (let i = 0; i < 20; ++i) { render(); await Promise.resolve(); } render(); }
  function nodes(node) { if (node == null || typeof node === 'boolean') return []; if (Array.isArray(node)) return node.flatMap(nodes);
    if (typeof node !== 'object') return []; return [node, ...nodes(node.props.children)]; }
  function text(node) { if (node == null || typeof node === 'boolean') return ''; if (Array.isArray(node)) return node.map(text).join('');
    return typeof node === 'object' ? text(node.props.children) : String(node); }
  function button(label) { return nodes(tree).find(node => node.type === 'button' && text(node).includes(label)); }
  async function click(label) { const node = button(label); assert.ok(node, `Missing button: ${label}`); assert.ok(!node.props.disabled, `${label} is disabled`);
    node.props.onClick?.({ preventDefault() {} }); await drain(); }
  async function tick() { for (const { fn } of [...intervals.values()]) fn(); await drain(); }
  async function navigate(hash) { window.location.hash = hash; for (const fn of listeners.get('hashchange') ?? []) fn(); await drain(); }
  async function expireTimeouts() { for (const [id, { fn }] of [...timeouts]) { timeouts.delete(id); fn(); } await drain(); }
  return { drain, text: () => text(tree), button, click, tick, navigate, expireTimeouts, calls, window,
    expireAuth: () => { actualAuth = 'signed-out'; },
    unmount: () => { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

test('verified workspace offers a real launch; signed-out workspace hides Studio actions and data', async () => {
  const app = harness(); await app.drain(); assert.ok(app.button('打开 Studio'));
  const guest = harness({ authKind: 'signed-out' }); await guest.drain();
  assert.match(guest.text(), /尚未验证会话/); assert.doesNotMatch(guest.text(), /Studio|演示工程/);
});

test('launch is no-argument and single-flight; only a validated response displays native open status', async () => {
  const open = deferred(); const app = harness({ studio: { open: () => open.promise } }); await app.drain();
  await app.click('打开 Studio'); assert.match(app.text(), /正在打开/); assert.ok(app.button('返回工作区'));
  assert.ok(!app.button('重试') || app.button('重试').props.disabled); assert.deepEqual(app.calls.open, [[]]);
  await app.navigate('#/studio'); assert.equal(app.calls.open.length, 1);
  open.resolve(opened()); await app.drain(); assert.match(app.text(), /Studio 已打开/);
  assert.match(app.text(), /演示工程 · 仅本次打开 · 关闭丢弃/);
});

for (const [label, studio] of [
  ['absent bridge', null], ['exception', { open: () => { throw Error('private native detail'); } }],
  ['malformed response', { open: () => ({ kind: 'open', error: null, path: 'private' }) }],
  ['host denial', { open: () => ({ kind: 'closed', error: 'auth-required' }) }],
]) test(`${label} never claims open and offers an honest retry/return`, async () => {
  const app = harness({ studio }); await app.drain(); await app.click('打开 Studio');
  assert.doesNotMatch(app.text(), /Studio 已打开|private/); assert.ok(app.button('重试')); assert.ok(app.button('返回工作区'));
});

test('return requests close before workspace and ignores late open success', async () => {
  const open = deferred(); const close = deferred(); const app = harness({ studio: { open: () => open.promise, close: () => close.promise } });
  await app.drain(); await app.click('打开 Studio'); await app.click('返回工作区'); assert.deepEqual(app.calls.close, [[]]);
  assert.match(app.text(), /正在关闭/); close.resolve(closed()); await app.drain(); assert.ok(app.button('打开 Studio'));
  open.resolve(opened()); await app.drain(); assert.ok(app.button('打开 Studio')); assert.doesNotMatch(app.text(), /Studio 已打开/);
});

test('logout does not wait for an indefinite native close and cannot be undone by late open', async () => {
  const open = deferred(); const close = deferred(); const app = harness({ studio: { open: () => open.promise, close: () => close.promise } });
  await app.drain(); await app.click('打开 Studio'); await app.click('退出登录');
  assert.equal(app.calls.logout, 1); assert.ok(app.calls.close.length >= 1); assert.match(app.text(), /尚未验证会话/);
  open.resolve(opened()); await app.drain(); assert.doesNotMatch(app.text(), /Studio|演示工程/);
});

test('native failure during polling replaces open status with recoverable failure', async () => {
  let native = opened(); const app = harness({ studio: { getState: () => native } }); await app.drain(); await app.click('打开 Studio');
  native = { kind: 'closed', error: 'failed' }; await app.tick(); assert.doesNotMatch(app.text(), /Studio 已打开/); assert.ok(app.button('重试'));
  assert.deepEqual(app.calls.state, [[]]);
});

test('auth expiry resets displayed Studio immediately and closes its native host', async () => {
  const app = harness(); await app.drain(); await app.click('打开 Studio'); app.expireAuth(); await app.tick();
  assert.match(app.text(), /尚未验证会话/); assert.doesNotMatch(app.text(), /Studio|演示工程/); assert.ok(app.calls.close.length >= 1);
});

test('workspace hash navigation closes Studio and a failed close keeps a recoverable return control', async () => {
  let fail = true; const app = harness({ studio: { close: () => fail ? { kind: 'closed', error: 'failed' } : closed() } });
  await app.drain(); await app.navigate('#/studio'); assert.match(app.text(), /Studio 已打开/);
  await app.navigate('#/workspace'); assert.ok(app.button('返回工作区')); assert.doesNotMatch(app.text(), /Studio 已打开/);
  fail = false; await app.click('返回工作区'); assert.ok(app.button('打开 Studio'));
});

test('malformed polling and an indefinite open never leave a false-success status', async () => {
  const app = harness({ studio: { getState: () => ({ kind: 'open', error: 'failed' }) } });
  await app.drain(); await app.click('打开 Studio'); await app.tick(); assert.doesNotMatch(app.text(), /Studio 已打开/); assert.ok(app.button('重试'));
  const waiting = harness({ studio: { open: () => new Promise(() => {}) } }); await waiting.drain(); await waiting.click('打开 Studio');
  await waiting.expireTimeouts(); assert.doesNotMatch(waiting.text(), /正在打开|Studio 已打开/); assert.ok(waiting.button('重试'));
});

// Catches a stale hash-listener closure reopening an already-open native editor.
test('revisiting the current Studio hash does not issue a second native open', async () => {
  const app = harness(); await app.drain(); await app.click('打开 Studio');
  await app.navigate('#/studio'); assert.equal(app.calls.open.length, 1);
});

test('the programmatic hash correction after close failure does not reopen without retry', async () => {
  const app = harness({ studio: { close: () => ({ kind: 'closed', error: 'failed' }) } });
  await app.drain(); await app.click('打开 Studio'); await app.navigate('#/workspace');
  await app.navigate(app.window.location.hash); assert.equal(app.calls.open.length, 1); assert.ok(app.button('重试'));
});
