import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mergeWrite } from './person-merge.mjs';

// Observe actual Node Workers, never substitute a worker or a merge implementation.
// Gates delay only delivery of real events or invocation of the real terminate method.
const require = createRequire(import.meta.url);
const threads = require('node:worker_threads');
const NativeWorker = threads.Worker;
const scratch = resolve(process.env.TEMP ?? '');
const ownedRoot = fileURLToPath(new URL('../../../../.dev/merge-worker-lifecycle/', import.meta.url));
assert.ok(relative(ownedRoot, scratch) && !relative(ownedRoot, scratch).startsWith('..') && !relative(ownedRoot, scratch).includes(':'), 'run with a new directory below this checkout lifecycle prefix');
for (const key of ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.equal(process.env[key], scratch, `explicit owned ${key}`);
mkdirSync(scratch, { recursive: true });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise((r) => setImmediate(r));
const within = async (promise, label = 'owned event') => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`missing ${label}`)), 5000); })]); }
  finally { clearTimeout(timer); }
};
const owned = [];
let options = {}, live = 0, peak = 0, sequence = 0;
class ObservedWorker extends NativeWorker {
  constructor(...args) {
    super(...args);
    this.observation = { ...options, worker: this, messages: [], events: [], held: [], reply: deferred(), error: deferred(), exit: deferred(), terminated: deferred(), alive: true, id: this.threadId };
    options = {};
    owned.push(this.observation);
    live++; peak = Math.max(peak, live);
    assert.ok(live <= 4, 'at most four actual owned threads');
    this.observation.onConstruct?.(this);
  }
  emit(event, ...args) {
    const o = this.observation;
    if (o && ['message', 'error', 'exit'].includes(event)) {
      o.events.push(event);
      if (event === 'exit') { o.alive = false; live--; o.exit.resolve(args); }
      if (event === 'message') o.reply.resolve(args[0]);
      if (event === 'error') o.error.resolve(args[0]);
      if (o[`hold${event}`]) {
        // Node removes all Worker listeners after emitting exit. Preserve the real delivery recipients now,
        // otherwise a delayed exit/error would be lost by this observation tool, not by production code.
        const listeners = this.rawListeners(event);
        o.held.push(() => { for (const listener of listeners) listener.apply(this, args); });
        return true;
      }
    }
    return super.emit(event, ...args);
  }
  postMessage(message, ...args) {
    const o = this.observation;
    o.messages.push(message);
    o.onPost?.(message);
    if (o.failPost) { o.failPost = false; throw new Error('owned synchronous post failure'); }
    return super.postMessage(message, ...args);
  }
  terminate() {
    const o = this.observation;
    o.terminateCalls = (o.terminateCalls ?? 0) + 1;
    o.terminated.resolve();
    o.onTerminate?.();
    if (o.rejectTerminate) return Promise.reject(new Error('owned termination rejection'));
    if (o.holdTerminate) {
      o.termination ??= deferred();
      return o.termination.promise.then(() => super.terminate());
    }
    return super.terminate();
  }
}
threads.Worker = ObservedWorker;
syncBuiltinESMExports();
const release = (o) => { o.holdmessage = o.holderror = o.holdexit = false; for (const deliver of o.held.splice(0)) deliver(); o.termination?.resolve(); };
const pending = async (promise) => {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await turn();
  assert.equal(settled, false, 'completion must remain pending behind the actual work/exit gate');
};
const native = new URL('./person-merge-worker.mjs', import.meta.url);
const film = (count = 1100) => ({ stage: { w: 1920, h: 1080 }, tracks: Array.from({ length: Math.ceil(count / 100) }, (_, t) => ({ clips: Array.from({ length: Math.min(100, count - t * 100) }, (_, i) => ({ id: `t${t}c${i}`, src: `p${i}.html`, at: i * 2, box: { x: 0, y: 0, w: 640, h: 360 } })) })) });
const changed = (value, edit) => { const out = structuredClone(value); edit(out); return out; };
async function setup(api, name, count = 1100) {
  const root = join(scratch, name);
  const base = film(count);
  await api.mergeFilmWrite(root, { rev: 'base', value: base });
  const ours = changed(base, (f) => { f.tracks[0].clips[0].at = 7; });
  api.filmWritten(root, base, ours, 'ours');
  const theirs = changed(base, (f) => { f.stage.w = 1234; });
  return { root, base, ours, theirs, call: (rev = 'theirs', value = theirs) => api.mergeFilmWrite(root, { rev, value }).then((out) => { if (out) api.filmMerged(root, out.value, rev, out.kept); return out; }) };
}
function merged(out, width = 1234) {
  assert.ok(out);
  assert.equal(out.value.stage.w, width);
  assert.equal(out.value.tracks[0].clips[0].at, 7);
  assert.ok(out.kept.some((k) => k.key === 'field\0t0c0\0at'));
}
function fault(name, body) {
  const file = join(scratch, `fault-${name}.mjs`);
  assert.ok(!relative(scratch, file).startsWith('..'));
  writeFileSync(file, `import { parentPort } from 'node:worker_threads';\nparentPort.on('message', (m) => { ${body} });\n`);
  return pathToFileURL(file);
}
async function scenario(run) {
  const start = owned.length;
  const api = await import(`./person-edits.mjs?lifecycle=${++sequence}`);
  try { await run(api, () => owned.at(-1)); }
  finally {
    options = {};
    for (const o of owned.slice(start)) release(o);
    await Promise.all(owned.slice(start).map(async (o) => {
      if (o.alive) await NativeWorker.prototype.terminate.call(o.worker);
      await o.exit.promise;
      release(o);
    }));
    // This is cleanup evidence from actual exit, not unref/process shutdown.
    assert.equal(owned.slice(start).filter((o) => o.alive).length, 0);
  }
}
after(() => {
  threads.Worker = NativeWorker; syncBuiltinESMExports();
  assert.equal(live, 0);
  writeFileSync(join(scratch, 'owned-worker-evidence.json'), JSON.stringify({ created: owned.length, actualExits: owned.filter((o) => !o.alive).length, peak, finalAlive: live, threads: owned.map((o) => ({ threadId: o.id, events: o.events, requests: o.messages.length, terminateCalls: o.terminateCalls ?? 0, actualExited: !o.alive })) }, null, 2));
  console.log(`owned Worker evidence: created=${owned.length}, actual exits=${owned.filter((o) => !o.alive).length}, peak=${peak}, final alive=${live}`);
});

// Removing real termination, or treating unref as exit, fails this test.
test('default native worker merges two roots incrementally; stop waits for idle actual exit and restart is cold', async () => scenario(async (api, latest) => {
  const a = await setup(api, 'native-a'), b = await setup(api, 'native-b');
  merged(await a.call());
  const first = latest();
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].tracks.length, 12);
  merged(await b.call());
  const next = changed(a.theirs, (f) => { f.tracks[2].clips[2].class = 'second'; });
  merged(await a.call('second', next));
  assert.ok(first.messages[2].tracks.length < first.messages[0].tracks.length, 'same generation sends incremental tracks');
  assert.equal(first.messages[2].root, a.root);
  const history = api.keptVersions(a.root);
  const last = api.lastMerge(a.root);
  first.holdTerminate = true;
  let reentrant;
  first.onTerminate = () => { reentrant = api.stopMergeWorker(); };
  const stopped = api.stopMergeWorker();
  assert.equal(api.stopMergeWorker(), stopped);
  assert.equal(api.startMergeWorker(), false);
  await within(first.terminated.promise, 'idle terminate invocation');
  assert.equal(reentrant, stopped);
  await pending(stopped);
  api.configure({ worker: native });
  assert.equal(api.startMergeWorker(), false);
  release(first);
  await within(stopped, 'stop completion');
  assert.equal(first.alive, false);
  assert.deepEqual(api.keptVersions(a.root), history);
  assert.deepEqual(api.lastMerge(a.root), last);
  assert.equal(api.startMergeWorker(), true);
  assert.equal(api.startMergeWorker(), true);
  assert.equal(owned.at(-1), first, 'restart is lazy');
  merged(await a.call('cold', a.theirs));
  const second = latest();
  assert.notEqual(second, first);
  assert.equal(second.messages[0].tracks.length, new Set(second.messages[0].versions.flatMap((v) => v.tracks)).size);
  await api.stopMergeWorker();
  assert.equal(second.alive, false);
}));

// Stop must reject before destructuring/getters, without clearing history or running merge.
test('stopped admission rejects before getters, state and configured computation', async () => scenario(async (api) => {
  await api.stopMergeWorker();
  let touched = 0;
  const current = { get rev() { touched++; return 'x'; }, get value() { touched++; return film(1); } };
  api.configure({ merge: () => { touched++; throw new Error('must not run'); }, worker: native });
  await assert.rejects(api.mergeFilmWrite(join(scratch, 'denied'), current), /stopp/i);
  assert.equal(touched, 0);
  assert.equal(api.personFilm(join(scratch, 'denied')), null);
  assert.equal(api.keptVersions(join(scratch, 'denied')).count, 0);
}));

// Full-call registration must precede a rev getter; original small-film work starts synchronously.
test('getter stop reentry retains the admitted full call and same-turn native merge', async () => scenario(async (api) => {
  const a = await setup(api, 'getter', 1);
  let stopped, computed = 0, insideStart;
  api.configure({ merge: (input) => { computed++; assert.equal(api.stopMergeWorker(), stopped); return mergeWrite(input); } });
  const call = api.mergeFilmWrite(a.root, { get rev() { stopped = api.stopMergeWorker(); insideStart = api.startMergeWorker(); return 'getter'; }, value: a.theirs });
  assert.equal(computed, 1, 'admitted original work remains in this turn');
  assert.equal(insideStart, false);
  merged(await call);
  await within(stopped, 'stop completion');
  assert.equal(api.filmToMerge(a.root, 'getter'), false, 'full bookkeeping completed');
  assert.equal(api.startMergeWorker(), true);
}));

// Native response and native thread exit are distinct obligations.
test('stop waits for a real reply, full continuation and separately gated actual exit delivery', async () => scenario(async (api, latest) => {
  const a = await setup(api, 'reply');
  options = { holdmessage: true, holdexit: true };
  const call = a.call();
  const w = latest();
  const stopped = api.stopMergeWorker();
  await within(w.reply.promise, 'actual reply');
  await pending(call); await pending(stopped);
  assert.equal(api.startMergeWorker(), false);
  w.holdmessage = false;
  for (const deliver of w.held.splice(0)) deliver();
  merged(await call);
  assert.equal(api.filmToMerge(a.root, 'theirs'), false);
  await within(w.exit.promise, 'actual exit');
  await pending(stopped);
  release(w);
  await within(stopped, 'stop completion');
}));

// Old generation events must never reject B or erase its cache.
test('configure detaches A before B is created; A late error and exit cannot fail B', async () => scenario(async (api, latest) => {
  const a = await setup(api, 'old-a'), b = await setup(api, 'new-b');
  api.configure({ worker: fault('late-error', "throw new Error('owned late error');") });
  options = { holderror: true, holdexit: true };
  const ca = a.call(); const wa = latest();
  await within(wa.error.promise, 'A actual error');
  api.configure({ worker: native });
  options = { holdmessage: true };
  const cb = b.call(); const wb = latest();
  assert.notEqual(wa, wb, 'replacement is synchronous, not waiting for old exit');
  await within(wb.reply.promise, 'B actual reply');
  release(wa);
  merged(await ca);
  await pending(cb);
  release(wb);
  merged(await cb);
  merged(await b.call('next', changed(b.theirs, (f) => { f.stage.h = 720; })));
  assert.ok(wb.messages[1].tracks.length < wb.messages[0].tracks.length);
  await api.stopMergeWorker();
}));

// Clearing a current pointer cannot forget earlier, still-owned threads.
test('stop waits for current and two retired actual threads, one exit at a time', async () => scenario(async (api, latest) => {
  const a = await setup(api, 'retired');
  const workers = [];
  for (let i = 0; i < 3; i++) {
    merged(await a.call(`v${i}`));
    const w = latest(); w.holdTerminate = true; workers.push(w);
    if (i < 2) api.configure({ worker: native });
  }
  assert.equal(new Set(workers).size, 3);
  const stopped = api.stopMergeWorker();
  for (const w of workers) await within(w.terminated.promise, 'terminate invocation');
  for (const w of workers.slice(0, 2)) { release(w); await within(w.exit.promise, 'actual exit'); await pending(stopped); }
  release(workers[2]);
  await within(stopped, 'stop completion');
  assert.ok(workers.every((w) => !w.alive));
}));

for (const [name, body] of [
  ['reply-error', "parentPort.postMessage({ id: m.id, error: 'owned reply failure' });"],
  ['abnormal-exit', 'process.exit(3);'],
  ['error-event', "throw new Error('owned worker failure');"],
]) test(`${name} uses the original ordinary merge fallback and drains its real thread`, async () => scenario(async (api, latest) => {
  const a = await setup(api, name);
  api.configure({ worker: fault(name, body) });
  let fallbacks = 0, stopped;
  api.configure({ merge: (input) => { fallbacks++; stopped = api.stopMergeWorker(); assert.equal(api.startMergeWorker(), false); return mergeWrite(input); } });
  merged(await a.call());
  assert.equal(fallbacks, 1);
  assert.equal(api.filmToMerge(a.root, 'theirs'), false);
  await within(stopped, 'stop completion');
  assert.equal(latest().alive, false);
}));

test('timeout keeps the whole person film, skips ordinary fallback, and still waits for actual exit', async () => scenario(async (api, latest) => {
  const a = await setup(api, 'timeout');
  let fallbackCount = 0;
  api.configure({ worker: fault('timeout', ''), mergeMs: 100, merge: (input) => { fallbackCount++; return mergeWrite(input); } });
  options = { holdTerminate: true };
  const call = a.call(); const w = latest();
  const out = await call;
  const stopped = api.stopMergeWorker();
  await pending(stopped);
  assert.equal(api.startMergeWorker(), false);
  release(w); await within(stopped, 'stop completion');
  assert.equal(w.alive, false);
  assert.equal(fallbackCount, 0, 'timeout must not invoke the ordinary merge fallback');
  merged({ ...out, kept: [{ key: 'field\0t0c0\0at' }] }, 1920);
  assert.deepEqual(out.kept.map((k) => k.key), ['film']);
}));

test('synchronous post failure falls back without leaving a timer or an unowned thread', async () => scenario(async (api, latest) => {
  const a = await setup(api, 'post');
  let stopped, fallback = 0;
  api.configure({ mergeMs: 100, merge: (input) => { fallback++; return mergeWrite(input); } });
  options = { failPost: true, onPost: () => { stopped = api.stopMergeWorker(); assert.equal(api.startMergeWorker(), false); } };
  merged(await a.call());
  await within(stopped, 'stop completion');
  assert.equal(fallback, 1);
  assert.equal(latest().alive, false);
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(fallback, 1);
}));

// Characterization, not feature RED: the native constructor throws before inWorker returns a Promise.
test('native constructor failure preserves whole-person-film fallback and finishes bookkeeping', async () => scenario(async (api) => {
  const a = await setup(api, 'ctor');
  api.configure({ worker: new URL('https://invalid.test/owned-worker.mjs') });
  let fallback = 0;
  api.configure({ merge: (input) => { fallback++; return mergeWrite(input); } });
  const out = await a.call();
  assert.equal(out.value.stage.w, 1920);
  assert.equal(out.value.tracks[0].clips[0].at, 7);
  assert.deepEqual(out.kept.map((k) => k.key), ['film']);
  assert.equal(fallback, 0);
  await api.stopMergeWorker();
  assert.equal(api.filmToMerge(a.root, 'theirs'), false);
}));

test('stop reentered from real Worker construction cannot lose the newly owned thread', async () => scenario(async (api, latest) => {
  const a = await setup(api, 'construct-reentry');
  let stopped;
  options = { onConstruct: () => { stopped = api.stopMergeWorker(); assert.equal(api.startMergeWorker(), false); } };
  merged(await a.call());
  await within(stopped, 'stop completion');
  assert.equal(latest().alive, false);
}));

test('a rejected termination is not quiescence and cannot permit restart before real exit', async () => scenario(async (api, latest) => {
  const a = await setup(api, 'reject-terminate');
  merged(await a.call());
  const w = latest(); w.rejectTerminate = true;
  const stopped = api.stopMergeWorker();
  // Both a rejected stop and a still-pending stop are fail-closed, never proof of exit.
  stopped.catch(() => {});
  assert.equal(api.startMergeWorker(), false);
  await within(w.terminated.promise, 'terminate invocation'); await turn();
  assert.equal(w.alive, true);
  assert.equal(api.startMergeWorker(), false);
  assert.equal(api.stopMergeWorker(), stopped);
  w.rejectTerminate = false;
  await NativeWorker.prototype.terminate.call(w.worker);
  await within(w.exit.promise, 'actual exit');
  await stopped.catch(() => {});
}));

// Moving admission registration below external getters lets stop terminate this already-entered request early.
test('a large merge admitted before a stopping getter still waits for its real native reply', async () => scenario(async (api, latest) => {
  const a = await setup(api, 'large-getter');
  let stopped;
  options = { holdmessage: true };
  const call = api.mergeFilmWrite(a.root, { get rev() { stopped = api.stopMergeWorker(); return 'getter'; }, value: a.theirs });
  const w = latest();
  await within(w.reply.promise, 'getter-admitted native reply');
  await pending(call); await pending(stopped);
  assert.equal(api.startMergeWorker(), false);
  release(w);
  merged(await call);
  await within(stopped, 'getter-admitted stop');
  assert.equal(w.alive, false);
  assert.equal(api.filmToMerge(a.root, 'getter'), false);
}));

test('configure during real construction retains the retired thread and starts a cold replacement', async () => scenario(async (api, latest) => {
  const a = await setup(api, 'construct-configure');
  options = { onConstruct: () => api.configure({ worker: native }), holdTerminate: true };
  merged(await a.call());
  const retired = latest();
  assert.equal(retired.messages.length, 0);
  assert.equal(retired.alive, true);
  merged(await a.call('replacement'));
  const current = latest();
  assert.notEqual(current, retired);
  assert.equal(current.messages[0].tracks.length, new Set(current.messages[0].versions.flatMap((v) => v.tracks)).size);
  const stopped = api.stopMergeWorker();
  await within(current.exit.promise, 'replacement exit');
  await pending(stopped);
  release(retired);
  await within(stopped, 'construction retirement');
  assert.equal(retired.alive, false);
}));

test('a throwing admitted getter rejects its call without poisoning stop or reopening admission', async () => scenario(async (api) => {
  let stopped;
  const call = api.mergeFilmWrite(join(scratch, 'throwing-getter'), { get rev() { stopped = api.stopMergeWorker(); throw new Error('owned getter error'); }, get value() { assert.fail('value must not be read'); } });
  await assert.rejects(call, /owned getter error/);
  await within(stopped, 'failed getter bookkeeping');
  await assert.rejects(api.mergeFilmWrite(join(scratch, 'still-stopped'), { rev: 'x', value: film(1) }), /stopp/i);
  assert.equal(api.startMergeWorker(), true);
  assert.equal(await api.mergeFilmWrite(join(scratch, 'reopened'), { rev: 'x', value: film(1) }), null);
  await api.stopMergeWorker();
}));

test('stop and restart preserve the pending note, person edits, versions and last merge history', async () => scenario(async (api) => {
  const a = await setup(api, 'history', 2);
  merged(await a.call());
  const note = api.noteFor(a.root, 'pid:owned-history');
  assert.ok(note);
  const versions = api.keptVersions(a.root), last = api.lastMerge(a.root), person = api.personFilm(a.root);
  await api.stopMergeWorker();
  assert.equal(api.startMergeWorker(), true);
  assert.deepEqual(api.keptVersions(a.root), versions);
  assert.deepEqual(api.lastMerge(a.root), last);
  assert.deepEqual(api.personFilm(a.root), person);
  assert.equal(api.noteSaid(note.id), true, 'the original pending note survives thread lifetime');
  assert.equal(api.noteFor(a.root, 'pid:owned-history'), null);
  const told = await a.call('after-note', changed(person, (f) => { f.tracks[0].clips[0].at = 9; }));
  assert.equal(told, null, 'the acknowledged new edit is taken by the native history algorithm');
  assert.equal(api.personFilm(a.root).tracks[0].clips[0].at, 9);
  await api.stopMergeWorker();
}));
