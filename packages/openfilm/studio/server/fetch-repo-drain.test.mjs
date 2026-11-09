import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = process.env.TEMP;
for (const key of ['TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.equal(process.env[key], scratch);
assert.match(scratch, /[\\/]\.dev[\\/]fetch-drain[\\/].+[\\/]scratch$/);
const { remoteRefs, cloneInto, fetchFilm, parseRepoUrl, createFetches } = await import('./fetch-repo.mjs');
const gitPath = 'C:/Program Files/Git/cmd/git.exe';
const sha = 'b'.repeat(40);
const hosts = { api: 'http://127.0.0.1:18482', raw: 'http://127.0.0.1:18482' };

function capturedSpawn(records, fixture = false) {
  return (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args.slice(0, 4), ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never']);
    assert.notEqual(options.shell, true);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options.env.GCM_INTERACTIVE, 'never');
    assert.ok(args.some(x => x.startsWith('file:')));
    const child = fixture
      ? spawn(process.execPath, ['-e', "process.stderr.write('owned hook contract\\n');process.exitCode=9"], options)
      : spawn(gitPath, args, options);
    const record = { args, child, closed: false, code: null };
    records.push(record);
    child.once('close', code => { record.closed = true; record.code = code; });
    return child;
  };
}

test('phase A remoteRefs optional trusted spawn owns real read-only local Git failure and actual close', async () => {
  const root = await mkdtemp(join(scratch, 'refs-'));
  const url = pathToFileURL(join(root, 'absent.git')).href;
  const records = [];
  await assert.rejects(remoteRefs(url, undefined, { trustedNode: { spawn: capturedSpawn(records) } }));
  assert.equal(records.length, 1);
  assert.equal(records[0].closed, true);
  assert.notEqual(records[0].code, 0);
  assert.deepEqual(records[0].args.slice(4), ['ls-remote', '--heads', '--tags', '--', url]);
  console.log('PHASE_A_DIRECT_GIT_RESOURCE=' + JSON.stringify({ command: gitPath, args: records[0].args, pid: records[0].child.pid, closeCode: records[0].code, closed: records[0].closed, helperDescendantsQualified: false }));
});

test('phase A remoteRefs trusted spawn returns real fixture Node failure without faking Git success', async () => {
  const root = await mkdtemp(join(scratch, 'clone-contract-'));
  const records = [];
  await assert.rejects(remoteRefs(pathToFileURL(join(root, 'absent.git')).href, undefined, { trustedNode: { spawn: capturedSpawn(records, true) } }), /owned hook contract/);
  assert.equal(records.length, 1);
  assert.equal(records[0].closed, true);
  assert.equal(records[0].code, 9);
  console.log('PHASE_A_FIXTURE_NODE_RESOURCE=' + JSON.stringify({ command: process.execPath, nativeGitArgsObserved: records[0].args, pid: records[0].child.pid, closeCode: records[0].code, closed: records[0].closed, noDescendantsSpawnedByFixture: true }));
});

test('phase A lower fetchFilm forwards fetch mkdir rename rm through actual loopback Response and real filesystem', async () => {
  const root = await mkdtemp(join(scratch, 'film-'));
  const seen = [], made = [], renamed = [], removed = [];
  const server = createServer((req, res) => {
    if (req.url.includes('/commits/')) res.end(sha);
    else if (req.url.includes('/git/trees/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: 13 }] })); }
    else res.end('<p>native</p>');
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(18482, '127.0.0.1', yes); });
  try {
    const to = await fetchFilm(parseRepoUrl('https://github.com/fixture/film'), { library: root, hosts, trustedNode: {
      fetch: (url, options) => { assert.equal(new URL(url).origin, hosts.api); seen.push(url); return fetch(url, options); },
      fs: {
        mkdir: (...args) => { made.push(args[0]); return mkdir(...args); },
        rename: (...args) => { renamed.push(args); return rename(...args); },
        rm: (...args) => { removed.push(args[0]); return rm(...args); },
      },
    } });
    assert.equal(await readFile(join(to, 'film.html'), 'utf8'), '<p>native</p>');
    assert.equal(to, join(root, 'film'));
    assert.equal(seen.length, 3);
    assert.ok(made.includes(root));
    assert.equal(renamed.length, 1);
    assert.equal(renamed[0][1], to);
    assert.equal(removed.length, 1);
  } finally {
    await new Promise((yes, no) => server.close(e => e ? no(e) : yes()));
    console.log('PHASE_A_REPO_SERVER_CLOSED=18482');
  }
});

test('phase A native entry points reject invalid capabilities before acquiring library network or Git', async () => {
  let getterReads = 0;
  const invalid = Object.defineProperty({}, 'spawn', { get() { getterReads++; throw Error('must not read'); } });
  for (const trustedNode of [null, invalid, { fs: { writeFile() {} } }, { spawn: 'git' }]) {
    const signal = AbortSignal.abort();
    await assert.rejects(remoteRefs(pathToFileURL(join(scratch, 'absent.git')).href, signal, { trustedNode }), TypeError);
    await assert.rejects(cloneInto({ cloneUrl: pathToFileURL(join(scratch, 'absent.git')).href, ref: null, folder: [], dir: scratch, signal, trustedNode }), TypeError);
    await assert.rejects(fetchFilm(parseRepoUrl('https://github.com/fixture/film'), { library: scratch, hosts, signal, trustedNode }), TypeError);
    assert.throws(() => createFetches({ library() { throw Error('not entered'); }, open() { throw Error('not entered'); }, trustedNode }), TypeError);
  }
  assert.equal(getterReads, 0);
});

test('phase A synchronous library failure preserves actual caller error with no external acquisition', () => {
  const expected = Error('owned library unavailable');
  let acquisitions = 0;
  const manager = createFetches({ library() { throw expected; }, open() { throw Error('must not open'); }, trustedNode: { fetch() { acquisitions++; throw Error('must not fetch'); }, spawn() { acquisitions++; throw Error('must not spawn'); } } });
  assert.throws(() => manager.start('https://github.com/fixture/film'), e => e === expected);
  manager.stopAll();
  assert.equal(acquisitions, 0);
});

test('phase A preaborted remoteRefs acquires no child while preserving original stopped outcome', async () => {
  let acquisitions = 0;
  await assert.rejects(remoteRefs(pathToFileURL(join(scratch, 'absent.git')).href, AbortSignal.abort(), { trustedNode: { spawn() { acquisitions++; throw Error('must not spawn'); } } }), /stopped/);
  assert.equal(acquisitions, 0);
});



test('phase A repo capability validation rejects top nested and revoked Proxies without running traps', async () => {
  const signal = AbortSignal.abort();
  for (const entry of [
    value => remoteRefs(pathToFileURL(join(scratch, 'absent.git')).href, signal, { trustedNode: value }),
    value => cloneInto({ cloneUrl: pathToFileURL(join(scratch, 'absent.git')).href, ref: null, folder: [], dir: scratch, signal, trustedNode: value }),
    value => fetchFilm(parseRepoUrl('https://github.com/fixture/film'), { library: scratch, hosts, signal, trustedNode: value }),
    value => createFetches({ library() { throw Error('must not enter'); }, open() { throw Error('must not enter'); }, trustedNode: value }),
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
      await assert.rejects(async () => entry(nested ? { fs: revoked.proxy } : revoked.proxy), TypeError);
    }
  }
});

test('phase A repo capability snapshots do not inherit poisoned prototype function slots', () => {
  for (const name of ['spawn', 'fetch', 'mkdir']) {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
    let inheritedCalls = 0;
    const poison = () => { inheritedCalls++; throw Error('inherited capability must not run'); };
    let error;
    try {
      Object.defineProperty(Object.prototype, name, { value: poison, writable: false, configurable: true });
      const trustedNode = name === 'mkdir' ? { fs: { mkdir } } : { [name]: () => { throw Error('own capability must not run during construction'); } };
      try { createFetches({ library() { throw Error('must not enter'); }, open() { throw Error('must not enter'); }, trustedNode }); } catch (e) { error = e; }
    } finally {
      if (previous) Object.defineProperty(Object.prototype, name, previous);
      else delete Object.prototype[name];
    }
    assert.equal(inheritedCalls, 0);
    assert.equal(error, undefined, 'own capabilities must remain constructible despite prototype poisoning');
  }
});

test('phase B preaborted fetchFilm does not create its real library or acquire transport', async () => {
  const parent = await mkdtemp(join(scratch, 'preaborted-film-'));
  const library = join(parent, 'not-created');
  let mkdirCalls = 0, transportCalls = 0;
  await assert.rejects(fetchFilm(parseRepoUrl('https://github.com/fixture/film'), {
    library, signal: AbortSignal.abort(), hosts,
    trustedNode: {
      fetch() { transportCalls++; throw Error('unexpected preaborted transport'); },
      spawn() { transportCalls++; throw Error('unexpected preaborted Git'); },
      fs: { mkdir(...args) { mkdirCalls++; return mkdir(...args); } },
    },
  }), error => error instanceof Error && error.code === 'cancelled');
  await assert.rejects(readFile(library), { code: 'ENOENT' });
  assert.equal(mkdirCalls, 0, 'cancellation must fence before the first real mkdir');
  assert.equal(transportCalls, 0, 'preaborted operation acquires no transport');
});


test('phase B initial real mkdir failure removes its acquired abort listener', async () => {
  const parent = await mkdtemp(join(scratch, 'mkdir-failure-'));
  const blocker = join(parent, 'ordinary-file');
  await writeFile(blocker, 'owned ordinary fixture');
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, 'abort').length;
  let transports = 0;
  try {
    await assert.rejects(fetchFilm(parseRepoUrl('https://github.com/fixture/film'), {
      library: join(blocker, 'library'), signal: controller.signal, hosts, timeoutMs: 30,
      trustedNode: {
        fetch() { transports++; throw Error('unexpected transport after mkdir failure'); },
        spawn() { transports++; throw Error('unexpected Git after mkdir failure'); },
      },
    }));
    assert.equal(getEventListeners(controller.signal, 'abort').length, before, 'startup failure must retire its actual signal listener');
    assert.equal(transports, 0);
  } finally {
    controller.abort();
    // Bound the known baseline's leaked30ms timer; never leave an old RED operation alive.
    await new Promise(resolve => setTimeout(resolve, 60));
  }
});

test('phase B cancellation during initial real mkdir prevents later progress and transport', async () => {
  const parent = await mkdtemp(join(scratch, 'mkdir-cancel-'));
  const library = join(parent, 'library');
  const controller = new AbortController();
  let release, enter;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  let progress = 0, transports = 0;
  const operation = fetchFilm(parseRepoUrl('https://github.com/fixture/film'), {
    library, signal: controller.signal, hosts,
    onProgress() { progress++; },
    trustedNode: {
      fs: { async mkdir(...args) { await mkdir(...args); enter(); await held; } },
      fetch() { transports++; throw Error('cancelled startup reached transport'); },
      spawn() { transports++; throw Error('cancelled startup reached Git'); },
    },
  });
  const refused = assert.rejects(operation, error => error instanceof Error && error.code === 'cancelled');
  try {
    await entered;
    controller.abort();
  } finally { release(); }
  await refused;
  assert.equal(progress, 0, 'an entered mkdir may finish but cancelled startup must not notify');
  assert.equal(transports, 0, 'no new transport may start after startup cancellation');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('phase B manager stop publishes one terminal promise and rejects admission before library callbacks', async () => {
  let libraries = 0, acquisitions = 0;
  const manager = createFetches({
    library() { libraries++; return scratch; },
    open() { throw Error('closed manager must not open'); },
    trustedNode: {
      fetch() { acquisitions++; throw Error('closed manager must not fetch'); },
      spawn() { acquisitions++; throw Error('closed manager must not spawn'); },
    },
  });
  const first = manager.stopAll();
  assert.ok(first instanceof Promise, 'stopAll must expose actual asynchronous retirement');
  assert.equal(manager.stopAll(), first);
  assert.throws(() => manager.start('https://github.com/fixture/film'), error => error instanceof Error && error.code === 'cancelled');
  await first;
  assert.equal(libraries, 0);
  assert.equal(acquisitions, 0);
});

test('phase B manager stop waits for an entered real mkdir and retains the failed job result', async () => {
  const parent = await mkdtemp(join(scratch, 'manager-mkdir-'));
  let release, enter;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  let opens = 0, transports = 0;
  const manager = createFetches({
    library() { return join(parent, 'library'); },
    open() { opens++; throw Error('cancelled setup must not open'); },
    trustedNode: {
      fs: { async mkdir(...args) { await mkdir(...args); enter(); await held; } },
      fetch() { transports++; throw Error('cancelled setup must not fetch'); },
      spawn() { transports++; throw Error('cancelled setup must not spawn'); },
    },
  });
  const job = manager.start('https://github.com/fixture/film');
  await entered;
  const stopping = manager.stopAll();
  let settled = false;
  const completion = Promise.resolve(stopping).then(() => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(settled, false, 'stop cannot finish before the acquired filesystem operation');
    assert.equal(manager.stopAll(), stopping);
  } finally {
    release();
    const limit = Date.now() + 2000;
    while (manager.get(job.id).state === 'running' && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 5));
    await completion;
    manager.stopAll();
  }
  assert.equal(manager.get(job.id).state, 'failed');
  assert.equal(manager.get(job.id).code, 'cancelled');
  assert.equal(opens, 0);
  assert.equal(transports, 0);
});

test('phase B cancellation in real copy-progress callback refuses final publication', async () => {
  const library = await mkdtemp(join(scratch, 'copy-cancel-'));
  const controller = new AbortController();
  let cancelledAtCopy = false;
  const server = createServer((req, res) => {
    if (req.url.includes('/commits/')) res.end(sha);
    else if (req.url.includes('/git/trees/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: 13 }] })); }
    else res.end('<p>native</p>');
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(18482, '127.0.0.1', yes); });
  try {
    await assert.rejects(fetchFilm(parseRepoUrl('https://github.com/fixture/film'), {
      library, signal: controller.signal, hosts,
      onProgress(progress) { if (progress.phase === 'copy') { cancelledAtCopy = true; controller.abort(); } },
      trustedNode: { fetch(url, options) { assert.equal(new URL(url).origin, hosts.api); return fetch(url, options); } },
    }), error => error instanceof Error && error.code === 'cancelled');
    assert.equal(cancelledAtCopy, true);
    await assert.rejects(readFile(join(library, 'film', 'film.html')), { code: 'ENOENT' });
  } finally { await new Promise((yes, no) => server.close(error => error ? no(error) : yes())); }
});

test('phase B manager waits for entered native openProject and keeps its actual persisted id after stop', async () => {
  const { resolveIsolationProfile, isolationEnvironment } = await import('../../src/development-isolation.mjs');
  const { filmHtml } = await import('../../src/film-doc.mjs');
  const baseRoot = join(scratch, 'native-open-profiles');
  await mkdir(baseRoot, { recursive: true });
  const profile = resolveIsolationProfile({ baseRoot, instanceId: 'root-test', taskId: 'T02', attemptId: `open-${Date.now()}-${process.pid}`, ports: { studio: 18481, film: 18482 } }, { approvedBaseRoot: baseRoot });
  const values = Object.entries(isolationEnvironment(profile)).filter(([key]) => key.startsWith('OPENFILM_'));
  const prior = new Map(values.map(([key]) => [key, process.env[key]]));
  for (const [key, value] of values) process.env[key] = value;
  let manager, release;
  let server;
  try {
    for (const location of Object.values(profile.paths)) await mkdir(location, { recursive: true });
    const projects = await import('./projects.mjs');
    const { createProjectControlGuard } = await import('./project-control-guard.mjs');
    const guard = createProjectControlGuard({ coordinationRoot: join(profile.root, 'coord') });
    const document = filmHtml({ stage: { w: 320, h: 180 }, tracks: [] });
    server = createServer((req, res) => {
      if (req.url.includes('/commits/')) res.end(sha);
      else if (req.url.includes('/git/trees/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: Buffer.byteLength(document) }] })); }
      else res.end(document);
    });
    await new Promise((yes, no) => { server.once('error', no); server.listen(18482, '127.0.0.1', yes); });
    let enter, nativeProject, openedFolder;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    manager = createFetches({
      library() { return profile.paths.projects; },
      async open(folder) {
        openedFolder = folder;
        enter();
        await held;
        nativeProject = await projects.withProjectControlGuard(guard, () => projects.openProject(folder));
        return nativeProject;
      },
      trustedNode: { fetch(url, options) {
        const source = new URL(url);
        assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(source.origin));
        return fetch(new URL(source.pathname + source.search, hosts.api), options);
      } },
    });
    const job = manager.start('https://github.com/fixture/film');
    let timer;
    try { await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('native open was not entered')), 3000); })]); }
    finally { clearTimeout(timer); }
    const stopping = manager.stopAll();
    let settled = false;
    stopping.then(() => { settled = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(settled, false, 'an entered original project mutation must finish before stop');
      assert.equal(manager.stopAll(), stopping);
    } finally { release(); await stopping; }
    assert.ok(nativeProject && typeof nativeProject.id === 'string' && nativeProject.id.length > 0);
    assert.equal(nativeProject.path, openedFolder);
    assert.equal(await readFile(join(openedFolder, '.film', 'id'), 'utf8').then(x => x.trim()), nativeProject.id);
    const listed = await projects.withProjectControlGuard(guard, () => projects.readState());
    assert.equal(listed.recent.some(item => item.id === nativeProject.id && item.path === openedFolder), true);
    assert.equal(manager.get(job.id).state, 'done');
    assert.equal(manager.get(job.id).project.id, nativeProject.id);
    assert.equal(await readFile(join(openedFolder, 'film.html'), 'utf8'), document);
  } finally {
    release?.();
    if (manager) await manager.stopAll();
    if (server?.listening) await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
    for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

// Per-owned-child observation only. Delay delivery of a close that Node actually emitted;
// never create an EventEmitter or synthesize an error/exit/close event.
function holdOwnedClose(child) {
  const nativeEmit = child.emit;
  let enter, closeArgs;
  let observed = 0, delivered = 0;
  const actualClose = new Promise(resolve => { enter = resolve; });
  child.emit = function(event, ...args) {
    if (event === 'close') {
      observed++;
      closeArgs = args;
      enter();
      return true;
    }
    return Reflect.apply(nativeEmit, this, [event, ...args]);
  };
  return {
    actualClose,
    release() {
      child.emit = nativeEmit;
      if (closeArgs && !delivered) { delivered++; Reflect.apply(nativeEmit, child, ['close', ...closeArgs]); }
    },
    counters: () => ({ observed, delivered }),
  };
}

test('phase B real asynchronous Git spawn error does not retire before its actual close is delivered', async () => {
  const root = await mkdtemp(join(scratch, 'git-spawn-error-'));
  let child, observation, settled = false;
  const outcome = remoteRefs(pathToFileURL(join(root, 'absent.git')).href, undefined, { trustedNode: {
    spawn(command, args, options) {
      assert.equal(command, 'git');
      child = spawn(join(root, 'deliberately-absent-executable.exe'), args, options);
      observation = holdOwnedClose(child);
      return child;
    },
  } }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    await observation.actualClose;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(child.pid, undefined, 'no process was successfully started');
    assert.equal(settled, false, 'spawn error alone is not the acquired ChildProcess close boundary');
  } finally { observation.release(); await outcome; }
  const result = await outcome;
  assert.equal(result.error.code, 'git');
  assert.deepEqual(observation.counters(), { observed: 1, delivered: 1 });
});


test('phase B synchronous stdin setup failure still waits for the owned real child close', async () => {
  const root = await mkdtemp(join(scratch, 'git-stdin-throw-'));
  const expected = Error('owned stdin setup failed');
  let child, observation, settled = false;
  const outcome = remoteRefs(pathToFileURL(join(root, 'absent.git')).href, undefined, { trustedNode: {
    spawn(command, args, options) {
      assert.equal(command, 'git');
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], options);
      observation = holdOwnedClose(child);
      const nativeEnd = child.stdin.end;
      child.stdin.end = function(...values) { Reflect.apply(nativeEnd, this, values); throw expected; };
      return child;
    },
  } }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    await observation.actualClose;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false, 'a synchronous pipe failure must not relinquish an acquired child');
  } finally { observation.release(); await outcome; }
  assert.equal((await outcome).error, expected);
  assert.equal(child.killed, true, 'only the freshly captured fixture child is stopped');
  assert.deepEqual(observation.counters(), { observed: 1, delivered: 1 });
});

test('phase B abort reentered by stdin setup is observed before any pipe callback', async () => {
  const root = await mkdtemp(join(scratch, 'git-stdin-abort-'));
  const controller = new AbortController();
  let child, observation;
  const outcome = remoteRefs(pathToFileURL(join(root, 'absent.git')).href, controller.signal, { trustedNode: {
    spawn(command, args, options) {
      assert.equal(command, 'git');
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], options);
      observation = holdOwnedClose(child);
      const nativeEnd = child.stdin.end;
      child.stdin.end = function(...values) { controller.abort(); return Reflect.apply(nativeEnd, this, values); };
      return child;
    },
  } }).then(value => ({ value }), error => ({ error }));
  try { await observation.actualClose; }
  finally { observation.release(); await outcome; }
  assert.equal(child.killed, true, 'abort ownership must precede stdin setup reentry');
  assert.ok((await outcome).error instanceof Error);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(observation.counters(), { observed: 1, delivered: 1 });
});


test('phase B throwing progress callback is contained until the real owned child close', async () => {
  const root = await mkdtemp(join(scratch, 'git-progress-throw-'));
  const controller = new AbortController();
  const expected = Error('owned progress callback failed');
  let child, observation, calls = 0, settled = false;
  const outcome = cloneInto({
    cloneUrl: pathToFileURL(join(root, 'absent.git')).href, ref: null, folder: [], dir: join(root, 'clone'), signal: controller.signal,
    onLine() { calls++; controller.abort(); throw expected; },
    trustedNode: { spawn(command, args, options) {
      assert.equal(command, 'git');
      child = spawn(process.execPath, ['-e', "process.stderr.write('owned progress\\n');setTimeout(() => {}, 100)"], options);
      observation = holdOwnedClose(child);
      return child;
    } },
  }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    await observation.actualClose;
    assert.equal(calls, 1);
    assert.equal(settled, false, 'the callback cannot retire the acquired child before close');
  } finally { observation.release(); await outcome; }
  assert.equal((await outcome).error, expected);
  assert.equal(child.killed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(observation.counters(), { observed: 1, delivered: 1 });
});


// Git fixture mutations are restricted to freshly created scratch repositories.
async function createOwnedGitFixture(label, nested = false) {
  const root = await mkdtemp(join(scratch, label));
  const source = join(root, 'source');
  await mkdir(source);
  const commands = [];
  async function run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(gitPath, ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', ...args], { cwd: source, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let error, stderr = '';
      child.stdout.resume(); child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
      child.on('error', failure => { error = failure; });
      child.on('close', code => {
        commands.push({ args, pid: child.pid, closeCode: code, actualClose: true });
        if (error || code !== 0) reject(error ?? Error(stderr)); else resolve();
      });
    });
  }
  await run(['init', '--initial-branch=main']);
  const { filmHtml } = await import('../../src/film-doc.mjs');
  const document = filmHtml({ stage: { w: 320, h: 180 }, tracks: [] });
  const filmRoot = nested ? join(source, 'scene') : source;
  await mkdir(filmRoot, { recursive: true });
  await writeFile(join(filmRoot, 'film.html'), document);
  if (nested) await writeFile(join(source, 'outside.txt'), 'not selected');
  await run(['add', '--', '.']);
  await run(['-c', 'user.name=OrangeFixture', '-c', 'user.email=fixture@orange.local', 'commit', '-m', 'owned native fetch fixture']);
  console.log('PHASE_B_OWNED_GIT_FIXTURE=' + JSON.stringify({ root, commands, noExternalRemotes: true }));
  return { root, source, document };
}

test('phase B periodic real Git size scan remains singly owned through cancellation', async () => {
  const fixture = await createOwnedGitFixture('git-measure-');
  const controller = new AbortController();
  const source = { ...parseRepoUrl('https://gitlab.com/fixture/film'), cloneUrl: pathToFileURL(fixture.source).href };
  let child, observation, enterChild, enterScan, releaseScan, scans = 0, settled = false;
  const childEntered = new Promise(resolve => { enterChild = resolve; });
  const scanEntered = new Promise(resolve => { enterScan = resolve; });
  const scanHeld = new Promise(resolve => { releaseScan = resolve; });
  const outcome = fetchFilm(source, { library: join(fixture.root, 'library'), signal: controller.signal, trustedNode: {
    spawn(command, args, options) {
      assert.equal(command, 'git'); assert.equal(args.at(-2), source.cloneUrl);
      child = spawn(gitPath, args, options); observation = holdOwnedClose(child); enterChild(); return child;
    },
    fs: { async readdir(...args) {
      const entries = await readdir(...args);
      if (String(args[0]).endsWith('.git')) { scans++; enterScan(); await scanHeld; }
      return entries;
    } },
  } }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  let timer;
  try {
    await Promise.race([Promise.all([childEntered, scanEntered]), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('owned Git scan did not enter')), 5000); })]);
    clearTimeout(timer);
    await observation.actualClose;
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(scans, 1, 'a pending real scan must prevent the next periodic scan');
    controller.abort(); observation.release();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(settled, false, 'cancelled fetch must retain ownership of entered filesystem scan');
  } finally {
    clearTimeout(timer); controller.abort(); observation?.release(); releaseScan(); await outcome;
  }
  assert.equal((await outcome).error.code, 'cancelled');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(observation.counters(), { observed: 1, delivered: 1 });
});


test('phase B size-scan progress callback failure belongs to the real Git fetch completion', async () => {
  const fixture = await createOwnedGitFixture('git-measure-callback-');
  const source = { ...parseRepoUrl('https://gitlab.com/fixture/film'), cloneUrl: pathToFileURL(fixture.source).href };
  const expected = Error('owned size progress failed');
  let observation, enterProgress, timer, calls = 0;
  const entered = new Promise(resolve => { enterProgress = resolve; });
  const outcome = fetchFilm(source, { library: join(fixture.root, 'library'), onProgress(progress) {
    if (progress.bytes > 0) { calls++; enterProgress(); throw expected; }
  }, trustedNode: { spawn(command, args, options) {
    assert.equal(command, 'git'); const child = spawn(gitPath, args, options); observation = holdOwnedClose(child); return child;
  } } }).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('size progress not entered')), 5000); })]);
    clearTimeout(timer);
    await observation.actualClose;
  } finally { clearTimeout(timer); observation?.release(); await outcome; }
  const result = await outcome;
  assert.equal(calls, 1);
  assert.equal(result.error?.code, 'failed');
  assert.match(result.error.message, /owned size progress failed/);
  assert.deepEqual(await readdir(join(fixture.root, 'library')), []);
  assert.deepEqual(observation.counters(), { observed: 1, delivered: 1 });
});


for (const mode of ['normal', 'sparse', 'size-limit']) {
  test('phase B real owned local Git ' + mode + ' preserves original fetch semantics', async () => {
    const fixture = await createOwnedGitFixture('git-' + mode + '-', mode === 'sparse');
    const source = { ...parseRepoUrl('https://gitlab.com/fixture/film'), cloneUrl: pathToFileURL(fixture.source).href, ...(mode === 'sparse' ? { tree: ['main', 'scene'] } : {}) };
    const library = join(fixture.root, 'library');
    const records = [], progress = [];
    const options = { library, onProgress(value) { progress.push(value); }, ...(mode === 'size-limit' ? { maxBytes: 1 } : {}), trustedNode: { spawn(command, args, options) {
      assert.equal(command, 'git');
      assert.deepEqual(args.slice(0, 4), ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never']);
      if (args.includes(source.cloneUrl)) assert.ok(['clone', 'ls-remote'].some(action => args.includes(action)));
      else assert.ok(options.cwd.startsWith(library), 'subsequent Git commands use only the owned temporary clone');
      const child = spawn(gitPath, args, options);
      const record = { args, pid: child.pid, actualClose: false, closeCode: undefined };
      child.once('close', code => { record.actualClose = true; record.closeCode = code; });
      records.push(record); return child;
    } } };
    if (mode === 'size-limit') {
      await assert.rejects(fetchFilm(source, options), error => error.code === 'too-big');
      assert.deepEqual(await readdir(library), []);
    } else {
      const destination = await fetchFilm(source, options);
      assert.equal(destination, join(library, mode === 'sparse' ? 'scene' : 'film'));
      assert.equal(await readFile(join(destination, 'film.html'), 'utf8'), fixture.document);
      await assert.rejects(readFile(join(destination, '.git', 'config')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(destination, 'outside.txt')), { code: 'ENOENT' });
      assert.deepEqual(await readdir(library), [mode === 'sparse' ? 'scene' : 'film']);
      assert.equal(progress.at(-1).phase, 'copy');
      assert.ok(progress.some(value => value.bytes > 0));
    }
    assert.equal(records.length, mode === 'sparse' ? 6 : 1);
    assert.equal(records.every(record => record.actualClose && record.closeCode === 0), true);
    console.log('PHASE_B_REAL_GIT_FETCH=' + JSON.stringify({ mode, records, descendantsQualified: false }));
  });
}


for (const mode of ['async', 'sync']) {
  test('phase B ' + mode + ' cleanup failure survives cancellation and keeps the actual committed film', async () => {
    const library = await mkdtemp(join(scratch, 'commit-cleanup-' + mode + '-'));
    const { filmHtml } = await import('../../src/film-doc.mjs');
    const document = filmHtml({ stage: { w: 320, h: 180 }, tracks: [] });
    const expected = Error('owned cleanup denied at ' + library);
    let enter, release, cleanupCalls = 0, opens = 0;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const server = createServer((req, res) => {
      if (req.url.includes('/commits/')) res.end(sha);
      else if (req.url.includes('/git/trees/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: Buffer.byteLength(document) }] })); }
      else res.end(document);
    });
    await new Promise((yes, no) => { server.once('error', no); server.listen(18482, '127.0.0.1', yes); });
    const manager = createFetches({ library: () => library, open() { opens++; throw Error('cleanup-failed fetch must not open'); }, trustedNode: {
      fetch(url, options) { const source = new URL(url); assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(source.origin)); return fetch(new URL(source.pathname + source.search, hosts.api), options); },
      fs: { rm(location) {
        assert.ok(String(location).startsWith(library)); assert.match(String(location).split(/[\\/]/).at(-1), /^\.fetching-/);
        cleanupCalls++; enter();
        if (mode === 'sync') throw expected;
        return held.then(() => { throw expected; });
      } },
    } });
    let stopping, timer;
    const job = manager.start('https://github.com/fixture/film');
    try {
      await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cleanup not entered')), 3000); })]);
      clearTimeout(timer);
      if (mode === 'sync') {
        const deadline = Date.now() + 2000;
        while (manager.get(job.id).state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      }
      const terminal = manager.stopAll(); assert.equal(manager.stopAll(), terminal);
      stopping = terminal.then(() => ({ rejected: false }), error => ({ rejected: true, error }));
      if (mode === 'async') {
        let settled = false; stopping.then(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(settled, false, 'stop waits for the acquired cleanup operation');
      }
      release();
      const result = await stopping;
      assert.equal(result.rejected, true, 'cleanup failure must reject terminal drain, not become success or cancellation');
      assert.equal(result.error instanceof AggregateError, true);
      assert.equal(manager.get(job.id).state, 'failed');
      assert.equal(manager.get(job.id).code, 'failed');
      assert.equal(manager.get(job.id).error.includes(library), false);
      assert.equal(result.error.errors.some(error => error.message.includes(library)), false);
      assert.equal(await readFile(join(library, 'film', 'film.html'), 'utf8'), document);
      assert.equal((await readdir(library)).some(name => name.startsWith('.fetching-')), true, 'unknown cleanup keeps owned recovery directory');
      assert.equal(cleanupCalls, 1); assert.equal(opens, 0);
    } finally {
      clearTimeout(timer); release();
      if (stopping) await stopping; else await manager.stopAll().catch(() => {});
      await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
    }
  });
}


for (const stage of ['commit', 'listing', 'download']) {
  test('phase B ' + stage + ' Response cancellation rejection remains fatal across native modules', async () => {
    const library = await mkdtemp(join(scratch, 'body-cleanup-' + stage + '-'));
    const expected = Error('owned response cleanup denied at ' + library);
    let enter, release, cancellations = 0, requests = 0, opens = 0, timer, stopping;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const body = new ReadableStream({ cancel() { cancellations++; enter(); return held.then(() => { throw expected; }); } });
    const response = new Response(body, { status: stage === 'commit' ? 401 : 404 });
    const manager = createFetches({ library: () => library, open() { opens++; throw Error('cleanup-failed operation must not open'); }, trustedNode: { async fetch(url) {
      const source = new URL(url); assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(source.origin)); requests++;
      if (source.pathname.includes('/commits/')) return stage === 'commit' ? response : new Response(sha);
      if (source.pathname.includes('/git/trees/')) return stage === 'listing' ? response : Response.json({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: 1 }] });
      return response;
    } } });
    const job = manager.start('https://github.com/fixture/film');
    try {
      await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('body cancellation not entered')), 3000); })]);
      clearTimeout(timer);
      const terminal = manager.stopAll(); assert.equal(manager.stopAll(), terminal);
      let settled = false;
      stopping = terminal.then(() => { settled = true; return { rejected: false }; }, error => { settled = true; return { rejected: true, error }; });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(settled, false, 'terminal drain must await actual body cancellation');
      release(); const result = await stopping;
      assert.equal(result.rejected, true, 'a cancellation error cannot be masked by a later ordinary cancel');
      assert.equal(result.error instanceof AggregateError, true);
      assert.equal(manager.get(job.id).code, 'failed');
      assert.equal(manager.get(job.id).error.includes(library), false);
      assert.equal(result.error.errors.some(error => error.message.includes(library)), false);
      assert.equal(Object.keys(manager.get(job.id)).some(key => ['committedPath', 'cleanupFailures', 'operationFailure'].includes(key)), false);
      assert.equal(cancellations, 1); assert.equal(opens, 0);
      assert.equal(requests, stage === 'commit' ? 1 : stage === 'listing' ? 2 : 3);
      assert.deepEqual(await readdir(library), []);
    } finally { clearTimeout(timer); release(); if (stopping) await stopping; else await manager.stopAll().catch(() => {}); }
  });
}


test('phase B an entered download pipeline cancellation rejection remains fatal after real file close', async () => {
  const library = await mkdtemp(join(scratch, 'pipeline-cleanup-'));
  const expected = Error('owned pipeline cleanup denied at ' + library);
  let enterWriter, enterCancel, release, stream, timer, stopping, cancellations = 0;
  const writerEntered = new Promise(resolve => { enterWriter = resolve; });
  const cancelEntered = new Promise(resolve => { enterCancel = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const response = new Response(new ReadableStream({ cancel() { cancellations++; enterCancel(); return held.then(() => { throw expected; }); } }));
  const manager = createFetches({ library: () => library, open() { throw Error('cancelled pipeline must not open'); }, trustedNode: {
    async fetch(url) {
      const source = new URL(url); assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(source.origin));
      if (source.pathname.includes('/commits/')) return new Response(sha);
      if (source.pathname.includes('/git/trees/')) return Response.json({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: 1 }] });
      return response;
    },
    createWriteStream(...args) { stream = createWriteStream(...args); enterWriter(); return stream; },
  } });
  const job = manager.start('https://github.com/fixture/film');
  try {
    await Promise.race([writerEntered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('writer not acquired')), 3000); })]);
    clearTimeout(timer);
    const terminal = manager.stopAll();
    let settled = false; stopping = terminal.then(() => { settled = true; return { rejected: false }; }, error => { settled = true; return { rejected: true, error }; });
    await Promise.race([cancelEntered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('pipeline cancel not entered')), 3000); })]);
    clearTimeout(timer); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false);
    release(); const result = await stopping;
    assert.equal(result.rejected, true, 'pipeline body cleanup rejection is not ordinary successful cancellation');
    assert.equal(result.error instanceof AggregateError, true);
    assert.equal(stream.closed, true);
    assert.equal(cancellations, 1);
    assert.equal(manager.get(job.id).code, 'failed');
    assert.equal(manager.get(job.id).error.includes(library), false);
    assert.deepEqual(await readdir(library), []);
  } finally { clearTimeout(timer); release(); if (stopping) await stopping; else await manager.stopAll().catch(() => {}); }
});


test('phase B an already errored body plus reentrant cancel is not a forged cleanup failure', async () => {
  const library = await mkdtemp(join(scratch, 'read-error-cancel-'));
  const expected = Error('owned ordinary read failure');
  let bodyControl, stream, enter, timer;
  const writerEntered = new Promise(resolve => { enter = resolve; });
  const response = new Response(new ReadableStream({ start(control) { bodyControl = control; } }));
  let job;
  const manager = createFetches({ library: () => library, open() { throw Error('cancelled read must not open'); }, trustedNode: {
    async fetch(url) {
      const source = new URL(url); assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(source.origin));
      if (source.pathname.includes('/commits/')) return new Response(sha);
      if (source.pathname.includes('/git/trees/')) return Response.json({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: 1 }] });
      return response;
    },
    createWriteStream(...args) { stream = createWriteStream(...args); bodyControl.error(expected); manager.cancel(job.id); enter(); return stream; },
  } });
  job = manager.start('https://github.com/fixture/film');
  try {
    await Promise.race([writerEntered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('writer not entered')), 3000); })]);
    clearTimeout(timer);
    const result = await manager.stopAll().then(() => ({ rejected: false }), error => ({ rejected: true, error }));
    assert.equal(result.rejected, false, 'known read failure is not a rejected underlying cleanup');
    assert.equal(manager.get(job.id).code, 'cancelled');
    assert.equal(stream.closed, true);
    assert.equal(response.body.locked, false);
    assert.deepEqual(await readdir(library), []);
  } finally { clearTimeout(timer); await manager.stopAll().catch(() => {}); }
});


for (const mode of ['return', 'throw']) {
  test('phase B library callback reentrant stop with ' + mode + ' retires its pre-registered task', async () => {
    const root = await mkdtemp(join(scratch, 'reentrant-library-'));
    const expected = Error('owned reentrant library failure');
    let manager, terminal, acquisitions = 0, libraryCalls = 0, job;
    manager = createFetches({ library() {
      libraryCalls++; terminal = manager.stopAll();
      assert.equal(manager.stopAll(), terminal);
      assert.throws(() => manager.start('https://github.com/fixture/film'), error => error.code === 'cancelled');
      if (mode === 'throw') throw expected;
      return join(root, 'not-acquired');
    }, open() { acquisitions++; throw Error('terminal callback must not open'); }, trustedNode: {
      fetch() { acquisitions++; throw Error('terminal callback must not fetch'); }, spawn() { acquisitions++; throw Error('terminal callback must not spawn'); }, fs: { mkdir() { acquisitions++; throw Error('terminal callback must not acquire filesystem'); } },
    } });
    if (mode === 'throw') assert.throws(() => manager.start('https://github.com/fixture/film'), error => error === expected);
    else job = manager.start('https://github.com/fixture/film');
    await terminal;
    assert.equal(manager.stopAll(), terminal);
    assert.equal(acquisitions, 0); assert.equal(libraryCalls, 1);
    if (job) { assert.equal(manager.get(job.id).state, 'failed'); assert.equal(manager.get(job.id).code, 'cancelled'); }
    await assert.rejects(readFile(join(root, 'not-acquired')), { code: 'ENOENT' });
  });
}

test('phase B real HTTP bytes exceeding an underreported listing stop before publication and close the writer', async () => {
  const library = await mkdtemp(join(scratch, 'streamed-limit-'));
  const { filmHtml } = await import('../../src/film-doc.mjs');
  const document = filmHtml({ stage: { w: 320, h: 180 }, tracks: [] });
  const streams = [], progress = [];
  const server = createServer((req, res) => {
    if (req.url.includes('/commits/')) res.end(sha);
    else if (req.url.includes('/git/trees/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: 1 }] })); }
    else res.end(document);
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(18482, '127.0.0.1', yes); });
  try {
    await assert.rejects(fetchFilm(parseRepoUrl('https://github.com/fixture/film'), { library, hosts, maxBytes: 10, onProgress(value) { progress.push(value); }, trustedNode: {
      createWriteStream(...args) { const stream = createWriteStream(...args), record = { stream, closes: 0 }; stream.once('close', () => { record.closes++; }); streams.push(record); return stream; },
    } }), error => error.code === 'too-big');
    assert.equal(progress.some(value => value.bytes > 10), true);
    assert.equal(streams.length, 1); assert.equal(streams[0].stream.closed, true); assert.equal(streams[0].closes, 1);
    assert.deepEqual(await readdir(library), []);
  } finally { await new Promise((yes, no) => server.close(error => error ? no(error) : yes())); }
});

test('phase B cancellation after actual rename preserves complete film and refuses new open', async () => {
  const library = await mkdtemp(join(scratch, 'post-rename-cancel-'));
  const { filmHtml } = await import('../../src/film-doc.mjs');
  const document = filmHtml({ stage: { w: 320, h: 180 }, tracks: [] });
  let manager, job, enter, timer, destination, opens = 0, renames = 0;
  const published = new Promise(resolve => { enter = resolve; });
  const server = createServer((req, res) => {
    if (req.url.includes('/commits/')) res.end(sha);
    else if (req.url.includes('/git/trees/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: Buffer.byteLength(document) }] })); }
    else res.end(document);
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(18482, '127.0.0.1', yes); });
  manager = createFetches({ library: () => library, open() { opens++; throw Error('late-cancelled publication must not open'); }, trustedNode: {
    fetch(url, options) { const source = new URL(url); assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(source.origin)); return fetch(new URL(source.pathname + source.search, hosts.api), options); },
    fs: { async rename(...args) { await rename(...args); renames++; destination = args[1]; manager.cancel(job.id); enter(); } },
  } });
  job = manager.start('https://github.com/fixture/film');
  try {
    await Promise.race([published, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('actual publication not reached')), 3000); })]);
    clearTimeout(timer);
    const deadline = Date.now() + 2000;
    while (manager.get(job.id).state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(manager.get(job.id).state, 'failed'); assert.equal(manager.get(job.id).code, 'cancelled');
    assert.equal(opens, 0); assert.equal(renames, 1);
    assert.equal(destination, join(library, 'film'));
    assert.equal(await readFile(join(destination, 'film.html'), 'utf8'), document);
    assert.deepEqual(await readdir(library), ['film']);
    await manager.stopAll();
  } finally { clearTimeout(timer); await manager.stopAll().catch(() => {}); await new Promise((yes, no) => server.close(error => error ? no(error) : yes())); }
});

for (const mode of ['pipeline', 'error-body', 'writer-setup']) {
  test('forward F01 ' + mode + ' late sibling cleanup failure survives the first ordinary failure', async () => {
    const library = await mkdtemp(join(scratch, 'f01-' + mode + '-'));
    const privateCause = Error('owned late cleanup denied at ' + library);
    const requested = [], responses = [], writers = [];
    let enterFour, enterReady, enterCancels, enterAbort, release, timer, cancellations = 0, opens = 0;
    const four = new Promise(resolve => { enterFour = resolve; });
    const ready = new Promise(resolve => { enterReady = resolve; });
    const cancelled = new Promise(resolve => { enterCancels = resolve; });
    const aborted = new Promise(resolve => { enterAbort = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const files = ['film.html', 'a.txt', 'b.txt', 'c.txt', 'not-admitted.txt'].map((path, i) => ({ type: 'blob', mode: '100644', path, size: 100 - i }));
    const manager = createFetches({ library: () => library, open() { opens++; throw Error('failed fetch must not open'); }, trustedNode: {
      async fetch(url, options) {
        const at = new URL(url); assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(at.origin));
        if (at.pathname.includes('/commits/')) return new Response(sha);
        if (at.pathname.includes('/git/trees/')) return Response.json({ tree: files });
        const name = at.pathname.split('/').at(-1); requested.push(name);
        const response = name === 'film.html' ? new Response('missing', { status: 404 }) : new Response(new ReadableStream({
          cancel() { cancellations++; if (cancellations === 3) { enterCancels(); if (mode !== 'pipeline') enterReady(); } return held.then(() => { if (name === 'a.txt') throw privateCause; }); },
        }), { status: mode === 'error-body' ? 404 : 200 });
        responses.push(response); if (responses.length === 4) enterFour();
        if (name === 'film.html') {
          options.signal.addEventListener('abort', enterAbort, { once: true });
          await four; await ready;
        }
        return response;
      },
      createWriteStream(...args) {
        if (mode === 'writer-setup') throw Error('owned writer setup failed');
        const stream = createWriteStream(...args), record = { stream, closes: 0 };
        stream.once('close', () => { record.closes++; }); writers.push(record);
        if (writers.length === 3) enterReady(); return stream;
      },
    } });
    const job = manager.start('https://github.com/fixture/film');
    let stopping;
    try {
      await Promise.race([Promise.all([four, ready, cancelled, aborted]), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('four acquired responses and late cancellation barrier not reached')), 3000); })]);
      clearTimeout(timer);
      assert.equal(responses.length, 4); assert.equal(cancellations, 3);
      assert.equal(writers.length, mode === 'pipeline' ? 3 : 0);
      let settled = false;
      stopping = manager.stopAll().then(() => { settled = true; return { rejected: false }; }, error => { settled = true; return { rejected: true, error }; });
      await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false);
      release(); const result = await stopping;
      assert.equal(result.rejected, true, 'later real cleanup rejection cannot disappear behind ordinary first failure');
      assert.equal(result.error instanceof AggregateError, true);
      const { hasIncompleteCleanup } = await import('./fetch-github.mjs');
      assert.equal(result.error.errors.some(hasIncompleteCleanup), true, 'safe cleanup brand must reach native manager retirement');
      assert.equal(manager.get(job.id).code, 'failed');
      assert.equal(JSON.stringify(manager.get(job.id)).includes(library), false);
      assert.equal(result.error.errors.some(error => error.message.includes(library)), false);
      assert.deepEqual([...requested].sort(), ['a.txt', 'b.txt', 'c.txt', 'film.html']);
      assert.equal(writers.every(x => x.stream.closed && x.closes === 1), true);
      assert.equal(responses.every(x => !x.body.locked), true);
      assert.deepEqual(await readdir(library), []); assert.equal(opens, 0);
    } finally { clearTimeout(timer); release(); enterFour(); enterReady(); if (stopping) await stopping; else await manager.stopAll().catch(() => {}); }
  });
}

test('forward F02 URL coercion reentrant stop refuses start before library and resource acquisition', async () => {
  let manager, terminal, coercions = 0, libraryCalls = 0, acquisitions = 0, result;
  const url = { toString() { coercions++; terminal = manager.stopAll(); return 'https://github.com/fixture/film'; } };
  manager = createFetches({ library() { libraryCalls++; return scratch; }, open() { acquisitions++; throw Error('terminal coercion must not open'); }, trustedNode: {
    fetch() { acquisitions++; throw Error('terminal coercion must not fetch'); }, spawn() { acquisitions++; throw Error('terminal coercion must not spawn'); }, fs: { mkdir() { acquisitions++; throw Error('terminal coercion must not mkdir'); } },
  } });
  try { result = manager.start(url); } catch (error) { result = error; }
  await manager.stopAll();
  assert.equal(libraryCalls, 0, 'external URL preparation stopped the manager before library admission');
  assert.equal(acquisitions, 0); assert.equal(coercions, 1);
  assert.equal(result instanceof Error, true); assert.equal(result.code, 'cancelled');
  assert.equal(manager.stopAll(), terminal);
});

test('forward F02 external URL preparation coerces once and retains the same primitive URL', async () => {
  let manager, terminal, coercions = 0, acquisitions = 0;
  const url = { toString() { coercions++; return '  https://github.com/fixture/film  '; } };
  manager = createFetches({ library() { terminal = manager.stopAll(); return scratch; }, open() { acquisitions++; throw Error('terminal library must not open'); }, trustedNode: {
    fetch() { acquisitions++; throw Error('terminal library must not fetch'); }, spawn() { acquisitions++; throw Error('terminal library must not spawn'); }, fs: { mkdir() { acquisitions++; throw Error('terminal library must not mkdir'); } },
  } });
  const job = manager.start(url); await terminal;
  assert.equal(coercions, 1, 'one external value must not execute two coercion callbacks');
  assert.equal(job.url, 'https://github.com/fixture/film');
  assert.equal(acquisitions, 0); assert.equal(manager.get(job.id).code, 'cancelled');
});

test('forward F04 manager ordinary unused errored body drains without a forged cleanup failure', async () => {
  const library = await mkdtemp(join(scratch, 'f04-read-error-'));
  let cancellations = 0, opens = 0;
  const response = new Response(new ReadableStream({ start(control) { control.error(Error('known ordinary body failure at ' + library)); }, cancel() { cancellations++; } }), { status: 404 });
  const manager = createFetches({ library: () => library, open() { opens++; throw Error('failed body must not open'); }, trustedNode: { async fetch(url) {
    const at = new URL(url); assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(at.origin));
    if (at.pathname.includes('/commits/')) return new Response(sha);
    if (at.pathname.includes('/git/trees/')) return Response.json({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: 1 }] });
    return response;
  } } });
  const job = manager.start('https://github.com/fixture/film');
  try {
    const deadline = Date.now() + 3000;
    while (manager.get(job.id).state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(manager.get(job.id).state, 'failed');
    const result = await manager.stopAll().then(() => ({ rejected: false }), error => ({ rejected: true, error }));
    assert.equal(result.rejected, false, 'known ordinary read error must not make a completed drain fail');
    assert.equal(manager.get(job.id).code, 'failed'); assert.equal(cancellations, 0); assert.equal(opens, 0);
    assert.equal(response.body.locked, false); assert.deepEqual(await readdir(library), []);
    assert.equal(JSON.stringify(manager.get(job.id)).includes(library), false);
  } finally { await manager.stopAll().catch(() => {}); }
});

test('forward F04 queued unused-body read error does not poison manager retirement', async () => {
  const library = await mkdtemp(join(scratch, 'f04-queued-read-'));
  let control, injected = false, ticks = 0, cancellations = 0;
  const response = new Response(new ReadableStream({ start(value) { control = value; }, cancel() { cancellations++; } }), { status: 404 });
  const manager = createFetches({ library: () => library, open() { throw Error('failed read must not open'); }, trustedNode: { async fetch(url) {
    const at = new URL(url); assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(at.origin));
    if (at.pathname.includes('/commits/')) return new Response(sha);
    if (at.pathname.includes('/git/trees/')) return Response.json({ tree: [{ type: 'blob', mode: '100644', path: 'film.html', size: 1 }] });
    const produce = () => {
      ticks++;
      if (response.body.locked) { injected = true; control.error(Error('queued private read failure at ' + library)); }
      else if (ticks < 64) queueMicrotask(produce);
    };
    queueMicrotask(produce); return response;
  } } });
  const job = manager.start('https://github.com/fixture/film');
  try {
    const deadline = Date.now() + 3000;
    while (manager.get(job.id).state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(manager.get(job.id).state, 'failed'); assert.equal(injected, true); assert.equal(cancellations, 0);
    const result = await manager.stopAll().then(() => ({ rejected: false }), error => ({ rejected: true, error }));
    assert.equal(result.rejected, false, 'queued ordinary read error cannot become a fatal cleanup failure');
    assert.equal(response.body.locked, false); assert.equal(manager.get(job.id).code, 'failed');
    assert.deepEqual(await readdir(library), []); assert.equal(JSON.stringify(manager.get(job.id)).includes(library), false);
  } finally { await manager.stopAll().catch(() => {}); }
});
