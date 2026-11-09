import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveIsolationProfile, isolationEnvironment } from '../../src/development-isolation.mjs';

const scratch = process.env.TEMP;
for (const key of ['TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.equal(process.env[key], scratch);
assert.match(scratch, /[\\/]\.dev[\\/]studio-request-drain[\\/]runs[\\/]attempt-\d+-\d+[\\/]scratch$/);
let sequence = 0;
function profile() {
  const baseRoot = resolve('.dev/studio-request-drain/profiles');
  const value = resolveIsolationProfile({ baseRoot, instanceId: 'studio-request', taskId: 'T02_SERVER_REQUEST', attemptId: 'a-' + process.pid + '-' + Date.now() + '-' + sequence++, ports: { studio: 18483, film: 18484 } }, { approvedBaseRoot: baseRoot });
  for (const p of Object.values(value.paths)) mkdirSync(p, { recursive: true });
  for (const [key, text] of Object.entries(isolationEnvironment(value))) if (key.startsWith('OPENFILM_')) process.env[key] = text;
  return value;
}
profile();
const { createProjectControlGuard } = await import('./project-control-guard.mjs');
const { withProjectControlGuard, createProject } = await import('./projects.mjs');
const { filmHtml } = await import('../../src/film-doc.mjs');
const { settleProjectFilm, readProjectFilm } = await import('./film.mjs');
const personEdits = await import('./person-edits.mjs');
const { keepAside: nativeHistoryKeep } = await import('./history.mjs');
const { startStudio } = await import('./server.mjs');
const { HttpError } = await import('./http.mjs');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function within(promise, name) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(name + ' did not retire')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function pending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'close must retain the actual entered native HTTP/FS tail');
}
const terminal = promise => promise.then(() => ({ rejected: false }), reason => ({ rejected: true, reason }));
function listening(port) {
  return new Promise(resolve => {
    let connected = false;
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { connected = true; socket.destroy(); });
    socket.once('error', () => socket.destroy());
    socket.once('close', () => resolve(connected));
  });
}
async function portsGone() {
  for (let i = 0; i < 500; i++) {
    if (!(await listening(18483)) && !(await listening(18484))) return;
    await delay(5);
  }
  assert.fail('owned native HTTP origins did not stop listening');
}
function client(studio, path, { method = 'GET', body } = {}) {
  let finish, closed;
  const result = new Promise(resolve => { finish = resolve; });
  const completion = new Promise(resolve => { closed = resolve; });
  const url = new URL(path, studio.origin); assert.equal(url.hostname, '127.0.0.1');
  const req = request(url, { method, agent: false, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
    const chunks = [];
    res.on('data', value => chunks.push(value));
    res.once('error', error => finish({ error }));
    res.once('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.once('error', error => finish({ error }));
  req.once('close', closed);
  req.setTimeout(5000, () => req.destroy(Error('owned fixture request deadline')));
  req.end(body);
  return { result, completion, abort() { req.destroy(); } };
}
function fixture() {
  const p = profile(), guard = createProjectControlGuard({ coordinationRoot: join(p.root, 'coord') });
  return { profile: p, run: fn => withProjectControlGuard(guard, fn) };
}
const options = { port: 18483, key: 'synthetic-request-fixture-key', isolation: true, advertise: false, openBrowser: () => assert.fail('no browser in this request consumer') };

// This is the original documented native keep test provider, not a substitute route,
// project or merge. It writes the real passed bytes; native Git history is NOT run.
test('entered original HTTP stage merges remain owned through real keep IO and native replacement after sockets close', async () => {
  const f = fixture(), entries = [], clients = [];
  let studio, closing, providerFailure = false, providerError;
  await f.run(async () => {
    try {
      for (const label of ['A', 'B']) {
        const project = await createProject('Request ' + label);
        assert(project.path.startsWith(f.profile.paths.projects));
        const original = { stage: { w: 1920, h: 1080 }, tracks: [] };
        const ours = { stage: { w: 1000, h: 1080 }, tracks: [] };
        const theirs = { stage: { w: 1920, h: 720 }, tracks: [] };
        const oursText = filmHtml(ours), theirsText = filmHtml(theirs);
        await fs.writeFile(join(project.path, 'film.html'), oursText);
        personEdits.filmWritten(project.path, original, ours, createHash('sha256').update(oursText).digest('hex').slice(0, 16));
        await fs.writeFile(join(project.path, 'film.html'), theirsText);
        entries.push({ project, ours, theirsText, entered: gate(), held: gate(), writes: [] });
      }
      studio = await startStudio(options);
      personEdits.configure({ keep: async (root, files) => {
        try {
          const entry = entries.find(x => x.project.path === root);
          assert(entry, 'only an owned native project is kept');
          assert.equal(entry.writes.length, 0, 'one original settle per owned project');
          const evidence = join(root, '.evidence'); await fs.mkdir(evidence);
          for (const [name, bytes] of Object.entries(files)) {
            assert.equal(name, basename(name));
            assert.ok(['agent.html', 'merged.html'].includes(name));
            await fs.writeFile(join(evidence, name), bytes, { flag: 'wx' });
            assert.deepEqual(await fs.readFile(join(evidence, name)), Buffer.from(bytes));
            entry.writes.push(name);
          }
          assert.deepEqual([...entry.writes].sort(), ['agent.html', 'merged.html']);
          entry.entered.release(); await entry.held.promise;
        } catch (error) { providerFailure = true; providerError = error; for (const e of entries) e.entered.release(); throw error; }
      } });
      for (const entry of entries) clients.push(client(studio, '/api/projects/' + encodeURIComponent(entry.project.id)));
      await within(Promise.all(entries.map(x => x.entered.promise)), 'real native keep acquisition');
      assert.equal(providerFailure, false, String(providerError));
      for (const entry of entries) assert.equal(await fs.readFile(join(entry.project.path, 'film.html'), 'utf8'), entry.theirsText);
      closing = studio.close(); assert.equal(studio.close(), closing);
      await within(Promise.all(clients.map(x => x.completion)), 'owned HTTP clients');
      await portsGone();
      await pending(closing);
      const refused = client(studio, '/api/projects');
      clients.push(refused);
      const refusal = await within(refused.result, 'terminal admission');
      await within(refused.completion, 'terminal client close');
      assert(refusal.error || refusal.status === 503);
      entries[0].held.release();
      await within(settleProjectFilm(entries[0].project.path), 'first native film serial tail');
      await pending(closing);
      entries[1].held.release(); await within(closing, 'all original request tails');
      assert.equal(providerFailure, false, String(providerError));
      for (const entry of entries) {
        assert.deepEqual((await readProjectFilm(entry.project.path)).value.stage, entry.ours.stage);
        assert(! (await fs.readdir(entry.project.path)).some(name => name.endsWith('.tmp')));
      }
    } finally {
      for (const entry of entries) entry.held.release();
      for (const entry of entries) await within(settleProjectFilm(entry.project.path), 'fixture actual film cleanup');
      for (const value of clients) { value.abort(); await within(value.result, 'client result cleanup'); await within(value.completion, 'client actual close cleanup'); }
      if (studio) await within(studio.close(), 'native Studio cleanup');
      for (const entry of entries) personEdits.forget(entry.project.path);
      personEdits.configure({ keep: nativeHistoryKeep });
    }
  });
  await portsGone();
});

for (const kind of ['error', 'null']) {
  test('entered native HTTP callback ' + kind + ' failure reentered during close remains visible', async () => {
    const f = fixture(), entered = gate();
    const expected = kind === 'null' ? null : Error('owned native request callback failed');
    let studio, requestClient, closing, outcome, calls = 0;
    await f.run(async () => {
      try {
        const project = await createProject('Callback ' + kind);
        assert(project.path.startsWith(f.profile.paths.projects));
        studio = await startStudio({ ...options, working() {
          calls++;
          closing = studio.close(); assert.equal(studio.close(), closing);
          outcome = terminal(closing); entered.release();
          throw expected;
        } });
        requestClient = client(studio, '/api/projects');
        await within(entered.promise, 'original working callback');
        const result = await within(outcome, 'entered request failure completion');
        assert.equal(result.rejected, true, 'close must not turn an entered handler failure into success');
        assert.equal(result.reason, expected, 'falsey thrown reasons remain rejected, not successful');
        assert.equal(calls, 1); assert.equal(studio.close(), closing);
        await portsGone();
      } finally {
        if (requestClient) { requestClient.abort(); await within(requestClient.result, 'error client result'); await within(requestClient.completion, 'error client actual close'); }
        if (studio) await within(terminal(studio.close()), 'error Studio actual retirement');
        personEdits.configure({ keep: nativeHistoryKeep });
      }
    });
    await portsGone();
  });
}

// Compatibility coverage: these are first-GREEN boundaries, not defect RED claims.
test('an explicitly handled native HttpError 503 is not reclassified as failed retirement', async () => {
  const f = fixture(), entered = gate();
  let studio, requestClient, closing, outcome, calls = 0;
  await f.run(async () => {
    try {
      const project = await createProject('Handled denial');
      assert(project.path.startsWith(f.profile.paths.projects));
      studio = await startStudio({ ...options, working() {
        calls++; closing = studio.close(); outcome = terminal(closing); entered.release();
        throw new HttpError(503, 'Synthetic isolated capability refusal.', { code: 'isolation-capability-unavailable' });
      } });
      requestClient = client(studio, '/api/projects');
      await within(entered.promise, 'explicit native HTTP denial');
      const result = await within(outcome, 'handled denial retirement');
      assert.equal(result.rejected, false);
      assert.equal(calls, 1); assert.equal(studio.close(), closing);
      await portsGone();
    } finally {
      if (requestClient) { requestClient.abort(); await within(requestClient.result, 'denial client result'); await within(requestClient.completion, 'denial client actual close'); }
      if (studio) await within(terminal(studio.close()), 'denial Studio retirement');
      personEdits.configure({ keep: nativeHistoryKeep });
    }
  });
  await portsGone();
});

test('original native quit finishes its own route before deferred close without self-wait', async () => {
  const f = fixture(), called = gate();
  let studio, requestClient, closing, outcome, quits = 0;
  await f.run(async () => {
    try {
      studio = await startStudio({ ...options, onQuit() {
        quits++; closing = studio.close(); outcome = terminal(closing); called.release();
      } });
      requestClient = client(studio, '/api/quit', { method: 'POST', body: '{}' });
      const reply = await within(requestClient.result, 'native quit reply');
      assert.equal(reply.status, 200); assert.equal(JSON.parse(reply.body).pages, 0);
      await within(called.promise, 'deferred native onQuit');
      const result = await within(outcome, 'quit without self-deadlock');
      assert.equal(result.rejected, false); assert.equal(quits, 1);
      assert.equal(studio.close(), closing);
      await within(requestClient.completion, 'quit client actual close');
      await portsGone();
    } finally {
      if (requestClient) { requestClient.abort(); await within(requestClient.result, 'quit result cleanup'); await within(requestClient.completion, 'quit client cleanup'); }
      if (studio) await within(terminal(studio.close()), 'quit Studio retirement');
      personEdits.configure({ keep: nativeHistoryKeep });
    }
  });
  await portsGone();
});


test('default native quit observes delegated stop rejection but preserves the stable rejected close', async () => {
  const f = fixture(), nativeStopped = gate();
  const expected = Error('owned native stop reported failure after actual retirement');
  const { createAutoVersions } = await import('./auto-versions.mjs');
  let studio, requestClient, reportedStop, actualNativeStopped = false, stopCalls = 0;
  await f.run(async () => {
    try {
      studio = await startStudio({ ...options, autoVersionsFactory(configuration) {
        const native = createAutoVersions(configuration);
        return { ...native, stop() {
          stopCalls++;
          reportedStop ??= native.stop().then(() => {
            actualNativeStopped = true; nativeStopped.release();
            throw expected;
          });
          return reportedStop;
        } };
      } });
      // No custom onQuit and no test-level unhandledRejection listener: the real
      // node:test harness detects the formerly unobserved default closing rejection.
      requestClient = client(studio, '/api/quit', { method: 'POST', body: '{}' });
      const reply = await within(requestClient.result, 'default native quit reply');
      assert.equal(reply.status, 200);
      await within(nativeStopped.promise, 'actual delegated native stop');
      await portsGone();
      // Let the normal rejection-reporting turn run; resource completion above is
      // proven by native stop and owned sockets, not by this event-loop observation.
      await new Promise(resolve => setImmediate(resolve));
      const closing = studio.close(); assert.equal(studio.close(), closing);
      const result = await within(terminal(closing), 'default rejected close observation');
      assert.equal(result.rejected, true); assert.equal(result.reason, expected);
      assert.equal(actualNativeStopped, true); assert.equal(stopCalls, 1);
      await within(requestClient.completion, 'default quit client actual close');
    } finally {
      if (requestClient) { requestClient.abort(); await within(requestClient.result, 'default quit result cleanup'); await within(requestClient.completion, 'default quit client cleanup'); }
      if (studio) await within(terminal(studio.close()), 'default quit actual Studio retirement');
      personEdits.configure({ keep: nativeHistoryKeep });
    }
  });
  await portsGone();
});
