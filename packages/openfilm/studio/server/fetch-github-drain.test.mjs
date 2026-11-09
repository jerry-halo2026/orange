import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getEventListeners } from 'node:events';
import { mkdir, readFile, mkdtemp, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

// Missing trusted forwarding must fail locally, never by reaching a public default host.
const scratch = process.env.TEMP;
for (const key of ['TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.equal(process.env[key], scratch);
assert.match(scratch, /[\\/]\.dev[\\/]fetch-drain[\\/].+[\\/]scratch$/);
const { resolveCommit, listFiles, downloadFiles } = await import('./fetch-github.mjs');
const at = { owner: 'fixture', repo: 'film' };
const sha = 'a'.repeat(40);
const hosts = { api: 'http://127.0.0.1:18482', raw: 'http://127.0.0.1:18482' };
describe('phase A GitHub seams', () => {
let server;
let requests = [];
before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url.includes('/commits/')) res.end(sha);
    else if (req.url.includes('/git/trees/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: 12 }] })); }
    else res.end('<p>owned</p>');
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(18482, '127.0.0.1', yes); });
});
after(async () => { await new Promise((yes, no) => server.close(e => e ? no(e) : yes())); console.log('PHASE_A_GITHUB_SERVER_CLOSED=18482'); });

function realFetch(calls) {
  return async (url, options) => {
    assert.equal(new URL(url).origin, hosts.api);
    calls.push({ url, accept: options.headers.accept });
    const response = await fetch(url, options);
    assert.ok(response instanceof Response);
    return response;
  };
}

test('phase A resolveCommit uses trusted real fetch and retains native HEAD resolution', async () => {
  const calls = [];
  assert.deepEqual(await resolveCommit(at, null, false, { hosts, trustedNode: { fetch: realFetch(calls) } }), { commit: sha, folder: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accept, 'application/vnd.github.sha');
  assert.ok(calls[0].url.endsWith('/commits/HEAD'));
});

test('phase A listFiles uses trusted real fetch without replacing native listing validation', async () => {
  const calls = [];
  assert.deepEqual(await listFiles(at, sha, [], { hosts, trustedNode: { fetch: realFetch(calls) } }), [{ path: 'film.html', size: 12 }]);
  assert.equal(calls.length, 1);
});

test('phase A downloadFiles forwards real mkdir and WriteStream and preserves downloaded bytes', async () => {
  const dir = await mkdtemp(join(scratch, 'github-'));
  const calls = [], made = [], streams = [];
  await downloadFiles(at, sha, [], [{ path: 'nested/film.html', size: 12 }], { dir, hosts, trustedNode: {
    fetch: realFetch(calls),
    fs: { mkdir: (...args) => { made.push(args[0]); return mkdir(...args); } },
    createWriteStream: (...args) => { const stream = createWriteStream(...args); streams.push(stream); return stream; },
  } });
  assert.equal(await readFile(join(dir, 'nested/film.html'), 'utf8'), '<p>owned</p>');
  assert.deepEqual(made, [join(dir, 'nested')]);
  assert.equal(calls.length, 1);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].closed, true);
});

test('phase A omitted trustedNode keeps original fetch and filesystem defaults', async () => {
  const dir = await mkdtemp(join(scratch, 'defaults-'));
  assert.equal((await resolveCommit(at, null, false, { hosts })).commit, sha);
  const files = await listFiles(at, sha, [], { hosts });
  await downloadFiles(at, sha, [], files, { dir, hosts });
  assert.equal(await readFile(join(dir, 'film.html'), 'utf8'), '<p>owned</p>');
});

test('phase A GitHub capabilities reject unknown nonfunction inherited and accessor entries without reading getters', async () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'fetch', { get() { reads++; throw Error('getter must not run'); } });
  const nested = { fs: Object.defineProperty({}, 'mkdir', { get() { reads++; throw Error('nested getter must not run'); } }) };
  const bad = [null, { unknown: () => {} }, { fetch: 1 }, accessor, nested, { fs: { stat: () => {} } }, { fs: { mkdir: 1 } }, Object.create({ fetch() {} }), { [Symbol('hidden')]: () => {} }];
  const signal = AbortSignal.abort();
  const before = requests.length;
  for (const trustedNode of bad) {
    await assert.rejects(resolveCommit(at, null, false, { signal, hosts, trustedNode }), TypeError);
    await assert.rejects(listFiles(at, sha, [], { signal, hosts, trustedNode }), TypeError);
    await assert.rejects(downloadFiles(at, sha, [], [], { dir: scratch, signal, hosts, trustedNode }), TypeError);
  }
  assert.equal(reads, 0);
  assert.equal(requests.length, before);
});

test('phase A preaborted empty download acquires no real file or request', async () => {
  const dir = await mkdtemp(join(scratch, 'aborted-'));
  const before = requests.length;
  await downloadFiles(at, sha, [], [{ path: 'film.html', size: 12 }], { dir, hosts, signal: AbortSignal.abort() });
  assert.deepEqual(await readdir(dir), []);
  assert.equal(requests.length, before);
});

});


test('phase A GitHub capability validation rejects top nested and revoked Proxies without running traps', async () => {
  const signal = AbortSignal.abort();
  for (const entry of [
    value => resolveCommit(at, null, false, { hosts, signal, trustedNode: value }),
    value => listFiles(at, sha, [], { hosts, signal, trustedNode: value }),
    value => downloadFiles(at, sha, [], [], { dir: scratch, hosts, signal, trustedNode: value }),
  ]) {
    for (const nested of [false, true]) {
      let traps = 0;
      const proxy = new Proxy({ unknown: () => {} }, {
        getPrototypeOf(target) { traps++; return Reflect.getPrototypeOf(target); },
        ownKeys(target) { traps++; return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) { traps++; return Reflect.getOwnPropertyDescriptor(target, key); },
      });
      let error;
      try { await entry(nested ? { fs: proxy } : proxy); } catch (e) { error = e; }
      assert.equal(traps, 0, 'validation must reject before any Proxy reflection');
      assert.ok(error instanceof TypeError);
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      await assert.rejects(entry(nested ? { fs: revoked.proxy } : revoked.proxy), TypeError);
    }
  }
});

test('phase A GitHub default and empty snapshots ignore poisoned prototype fetch capability', async () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'fetch');
  let inheritedCalls = 0;
  const errors = [];
  try {
    Object.defineProperty(Object.prototype, 'fetch', { configurable: true, value: () => { inheritedCalls++; throw Error('inherited capability must not run'); } });
    for (const trustedNode of [undefined, {}, { fs: {} }]) {
      try { await resolveCommit(at, null, false, { hosts, signal: AbortSignal.abort(), trustedNode }); } catch (e) { errors.push(e); }
    }
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'fetch', previous);
    else delete Object.prototype.fetch;
  }
  assert.equal(inheritedCalls, 0, 'default and empty capabilities must select the original builtin');
  assert.equal(errors.length, 3);
  for (const error of errors) assert.equal(error.name, 'AbortError');
});

async function verifyErrorBodyRetirement(invoke, status, wantedCode) {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const cancelled = new Promise(resolve => { entered = resolve; });
  let cancellations = 0, settled = false;
  const body = new ReadableStream({ cancel() { cancellations++; entered(); return held; } });
  const response = new Response(body, { status });
  const result = invoke(response).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    const first = await Promise.race([cancelled.then(() => 'cancel'), result.then(() => 'returned'), new Promise(resolve => setTimeout(() => resolve('deadline'), 1000))]);
    assert.equal(first, 'cancel', 'the acquired real Response body must be retired before error/fallback');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false, 'body.cancel was entered but its actual completion is still held');
  } finally {
    release();
    if (!cancellations) await response.body.cancel();
    await result;
  }
  const outcome = await result;
  assert.equal(cancellations, 1);
  assert.ok(outcome.error instanceof Error);
  assert.equal(outcome.error.code, wantedCode);
  const reader = response.body.getReader();
  await reader.closed;
  reader.releaseLock();
}

test('phase B commit lookup waits for acquired 401 response body cancellation before use-git', async () => {
  await verifyErrorBodyRetirement(response => resolveCommit(at, null, false, { hosts, trustedNode: { fetch: async url => { assert.equal(new URL(url).origin, hosts.api); return response; } } }), 401, 'use-git');
});

test('phase B listing waits for acquired 404 response body cancellation before no-folder', async () => {
  await verifyErrorBodyRetirement(response => listFiles(at, sha, [], { hosts, trustedNode: { fetch: async url => { assert.equal(new URL(url).origin, hosts.api); return response; } } }), 404, 'no-folder');
});

test('phase B download waits for acquired permanent-error body cancellation before settling workers', async () => {
  const dir = await mkdtemp(join(scratch, 'error-body-'));
  await verifyErrorBodyRetirement(response => downloadFiles(at, sha, [], [{ path: 'ordinary.txt', size: 1 }], { dir, hosts, trustedNode: { fetch: async url => { assert.equal(new URL(url).origin, hosts.raw); return response; } } }), 404, 'failed');
  assert.deepEqual(await readdir(dir), []);
});


test('phase B successful retry removes its real abort listener after the native backoff timer', async () => {
  const controller = new AbortController();
  let calls = 0;
  try {
    const resolved = await resolveCommit(at, null, false, { hosts, signal: controller.signal, trustedNode: {
      async fetch(url) {
        assert.equal(new URL(url).origin, hosts.api);
        calls++;
        if (calls === 1) throw Error('controlled connection failure before Response acquisition');
        return new Response(sha);
      },
    } });
    assert.equal(resolved.commit, sha);
    assert.equal(calls, 2);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'a completed backoff must not retain its signal listener');
  } finally { controller.abort(); }
});

test('phase B cancellation during native backoff prevents another fetch acquisition', async () => {
  const controller = new AbortController();
  const reason = Error('owned cancellation during backoff');
  let calls = 0;
  const result = resolveCommit(at, null, false, { hosts, signal: controller.signal, trustedNode: {
    async fetch(url) { assert.equal(new URL(url).origin, hosts.api); calls++; throw Error('controlled transient connection failure'); },
  } }).then(value => ({ value }), error => ({ error }));
  try {
    const limit = Date.now() + 1000;
    while (getEventListeners(controller.signal, 'abort').length === 0 && Date.now() < limit) await new Promise(resolve => setImmediate(resolve));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1, 'real retry pause must have acquired its listener');
    controller.abort(reason);
    const outcome = await result;
    assert.equal(calls, 1, 'cancelled pause must not acquire the next fetch');
    assert.equal(outcome.error, reason);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { controller.abort(reason); await result; }
});


test('phase B onBytes failure rejects with its original error after the actual file stream closes', async () => {
  const dir = await mkdtemp(join(scratch, 'bytes-callback-'));
  const controller = new AbortController();
  const expected = Error('owned byte callback failed');
  const streams = [];
  let requests = 0, calls = 0, fallbackFired = false;
  // Only a RED safety deadline: no global error handler, and never a green-path cancellation.
  const timer = setTimeout(() => { fallbackFired = true; controller.abort(); }, 2000);
  let result;
  try {
    result = await downloadFiles(at, sha, [], [{ path: 'ordinary.txt', size: 9 }], {
      dir, hosts, signal: controller.signal,
      onBytes() { calls++; throw expected; },
      trustedNode: {
        async fetch(url) { assert.equal(new URL(url).origin, hosts.raw); requests++; return new Response('own bytes'); },
        createWriteStream(...args) { const stream = createWriteStream(...args); const record = { stream, closes: 0 }; stream.once('close', () => { record.closes++; }); streams.push(record); return stream; },
      },
    }).then(value => ({ value }), error => ({ error }));
  } finally { clearTimeout(timer); controller.abort(); }
  assert.equal(result.error === expected, true, 'the actual callback error must survive pipeline completion');
  assert.equal(calls, 1);
  assert.equal(requests, 1, 'a consumer callback failure is not a retryable network failure');
  assert.equal(fallbackFired, false, 'native owned completion must not depend on the safety deadline');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].stream.closed, true);
  assert.equal(streams[0].closes, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});


test('phase B a null callback rejection remains a failure after all actual streams retire', async () => {
  const dir = await mkdtemp(join(scratch, 'bytes-null-'));
  let stream, calls = 0;
  const result = await downloadFiles(at, sha, [], [{ path: 'ordinary.txt', size: 9 }], {
    dir, hosts, onBytes() { calls++; throw null; },
    trustedNode: { async fetch(url) { assert.equal(new URL(url).origin, hosts.raw); return new Response('own bytes'); }, createWriteStream(...args) { stream = createWriteStream(...args); return stream; } },
  }).then(() => ({ rejected: false }), error => ({ rejected: true, error }));
  assert.equal(result.rejected, true, 'a falsey thrown value must not be mistaken for success');
  assert.equal(result.error, null);
  assert.equal(calls, 1);
  assert.equal(stream.closed, true);
});


test('phase B synchronous file-stream factory failure retires the acquired Response before rejection', async () => {
  const dir = await mkdtemp(join(scratch, 'writer-setup-'));
  const controller = new AbortController();
  const expected = Error('owned writer setup failed');
  let enter, release, bodyControl, cancelled = 0, requests = 0, settled = false, timer;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const response = new Response(new ReadableStream({ start(control) { bodyControl = control; }, cancel() { cancelled++; enter(); return held; } }));
  const outcome = downloadFiles(at, sha, [], [{ path: 'ordinary.txt', size: 1 }], { dir, hosts, signal: controller.signal, trustedNode: {
    async fetch(url) { assert.equal(new URL(url).origin, hosts.raw); requests++; return response; },
    createWriteStream() { throw expected; },
  } }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    const first = await Promise.race([entered.then(() => 'cancel'), outcome.then(() => 'returned'), new Promise(resolve => { timer = setTimeout(() => resolve('deadline'), 300); })]);
    assert.equal(first, 'cancel', 'setup failure still owns the unused actual Response body');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false, 'body cancellation completion must be awaited');
  } finally {
    clearTimeout(timer); release();
    // Abort only the broken RED cleanup path; GREEN proves natural rejection without
    // using caller cancellation to suppress retry or remove a leaked signal listener.
    if (!cancelled) { controller.abort(); try { bodyControl.close(); } catch {} }
    await outcome;
  }
  assert.equal((await outcome).error === expected, true);
  assert.equal(cancelled, 1);
  assert.equal(requests, 1, 'a synchronous local setup failure is not retried as network loss');
  assert.deepEqual(await readdir(dir), []);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});


test('phase B one permanent failure waits for three acquired sibling body cancellations and file closes', async () => {
  const dir = await mkdtemp(join(scratch, 'sibling-drain-'));
  const controller = new AbortController();
  let enterFour, enterCancelled, release, timer, settled = false, cancellations = 0;
  const four = new Promise(resolve => { enterFour = resolve; });
  const cancelled = new Promise(resolve => { enterCancelled = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const requested = [], streams = [];
  const files = [{ path: 'bad.txt', size: 100 }, { path: 'a.txt', size: 90 }, { path: 'b.txt', size: 80 }, { path: 'c.txt', size: 70 }, { path: 'not-admitted.txt', size: 60 }];
  const outcome = downloadFiles(at, sha, [], files, { dir, hosts, signal: controller.signal, trustedNode: {
    async fetch(url) {
      assert.equal(new URL(url).origin, hosts.raw);
      const name = new URL(url).pathname.split('/').at(-1); requested.push(name);
      if (requested.length === 4) enterFour();
      if (name === 'bad.txt') { await four; return new Response('missing', { status: 404 }); }
      return new Response(new ReadableStream({ cancel() { cancellations++; if (cancellations === 3) enterCancelled(); return held; } }));
    },
    createWriteStream(...args) { const stream = createWriteStream(...args), record = { stream, closes: 0 }; stream.once('close', () => { record.closes++; }); streams.push(record); return stream; },
  } }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    await Promise.race([cancelled, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('sibling cancellation not entered')), 3000); })]);
    clearTimeout(timer);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(settled, false, 'all acquired response cancellations belong to the failed transfer');
    assert.deepEqual([...requested].sort(), ['a.txt', 'b.txt', 'bad.txt', 'c.txt']);
  } finally { clearTimeout(timer); if (cancellations !== 3) { controller.abort(); enterFour(); } release(); await outcome; }
  assert.equal((await outcome).error.code, 'failed');
  assert.equal(cancellations, 3);
  assert.equal(streams.length, 3);
  assert.equal(streams.every(record => record.stream.closed && record.closes === 1), true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});


test('phase B internal cleanup brand rejects forged fields and Proxies without invoking traps', async () => {
  const { hasIncompleteCleanup } = await import('./fetch-github.mjs');
  const { FetchError } = await import('./fetch-error.mjs');
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw Error('no property read'); }, getPrototypeOf() { traps++; throw Error('no prototype read'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [null, undefined, 0, false, 'failed', Error('The response could not finish closing.'), new FetchError('The response could not finish closing.', 500, 'failed'), { status: 500, code: 'failed' }, proxy, revoked.proxy]) assert.equal(hasIncompleteCleanup(value), false);
  assert.equal(traps, 0);
  const cause = Error('owned private original cleanup error');
  const response = new Response(new ReadableStream({ cancel() { throw cause; } }), { status: 401 });
  const result = await resolveCommit(at, null, false, { hosts, trustedNode: { async fetch(url) { assert.equal(new URL(url).origin, hosts.api); return response; } } }).then(value => ({ value }), error => ({ error }));
  assert.equal(hasIncompleteCleanup(result.error), true);
  assert.equal(result.error instanceof FetchError, true);
  assert.equal(JSON.stringify(result.error).includes(cause.message), false);
  assert.equal(Object.hasOwn(result.error, 'cleanupFailures'), false);
});

test('phase B actual streamed byte values and totals survive owned reader retirement', async () => {
  const dir = await mkdtemp(join(scratch, 'owned-reader-bytes-'));
  const chunks = [new Uint8Array([0, 1, 2]), new Uint8Array([255, 195, 169])];
  const response = new Response(new ReadableStream({ pull(control) { if (chunks.length) control.enqueue(chunks.shift()); else control.close(); } }));
  let counted = 0, stream;
  await downloadFiles(at, sha, [], [{ path: 'bytes.bin', size: 6 }], { dir, hosts, onBytes(bytes) { counted += bytes; }, trustedNode: {
    async fetch(url) { assert.equal(new URL(url).origin, hosts.raw); return response; },
    createWriteStream(...args) { stream = createWriteStream(...args); return stream; },
  } });
  assert.deepEqual(await readFile(join(dir, 'bytes.bin')), Buffer.from([0, 1, 2, 255, 195, 169]));
  assert.equal(counted, 6);
  assert.equal(stream.closed, true);
  assert.equal(response.body.locked, false);
});

test('forward F04 an already errored unused 404 body is an ordinary listing failure', async () => {
  const { hasIncompleteCleanup } = await import('./fetch-github.mjs');
  let cancellations = 0;
  const response = new Response(new ReadableStream({ start(control) { control.error(Error('known body read failure')); }, cancel() { cancellations++; } }), { status: 404 });
  const result = await listFiles(at, sha, [], { hosts, trustedNode: { async fetch(url) { assert.equal(new URL(url).origin, hosts.api); return response; } } }).then(value => ({ value }), error => ({ error }));
  assert.equal(hasIncompleteCleanup(result.error), false, 'repeating an already-known read error is not a failed underlying cancel');
  assert.equal(result.error.code, 'no-folder'); assert.equal(cancellations, 0);
  assert.equal(response.body.locked, false);
});

test('forward F04 foreign reader ownership is not stolen or reported as a successful retirement', async () => {
  const { hasIncompleteCleanup } = await import('./fetch-github.mjs');
  let cancellations = 0;
  const response = new Response(new ReadableStream({ cancel() { cancellations++; } }), { status: 404 });
  const foreign = response.body.getReader();
  try {
    const result = await listFiles(at, sha, [], { hosts, trustedNode: { async fetch(url) { assert.equal(new URL(url).origin, hosts.api); return response; } } }).then(value => ({ value }), error => ({ error }));
    assert.equal(hasIncompleteCleanup(result.error), true);
    assert.equal(response.body.locked, true); assert.equal(cancellations, 0);
  } finally { await foreign.cancel(); foreign.releaseLock(); }
  assert.equal(cancellations, 1); assert.equal(response.body.locked, false);
});

test('forward F04 queued producer error after reader acquisition is not a cancellation failure', async () => {
  const { hasIncompleteCleanup } = await import('./fetch-github.mjs');
  let control, injected = false, ticks = 0, cancellations = 0;
  const response = new Response(new ReadableStream({ start(value) { control = value; }, cancel() { cancellations++; } }), { status: 404 });
  const result = await listFiles(at, sha, [], { hosts, trustedNode: { async fetch(url) {
    assert.equal(new URL(url).origin, hosts.api);
    const produce = () => {
      ticks++;
      if (response.body.locked) { injected = true; control.error(Error('queued known read failure')); }
      else if (ticks < 64) queueMicrotask(produce);
    };
    queueMicrotask(produce); return response;
  } } }).then(value => ({ value }), error => ({ error }));
  assert.equal(injected, true, 'the bounded real producer must enter after actual reader acquisition');
  assert.equal(cancellations, 0, 'the native cancel only repeats an existing read error in this schedule');
  assert.equal(hasIncompleteCleanup(result.error), false, 'reader.closed observation must catch up before cleanup classification');
  assert.equal(result.error.code, 'no-folder'); assert.equal(response.body.locked, false);
});
