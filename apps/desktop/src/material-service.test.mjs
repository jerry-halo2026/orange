// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The material service's start/stop contract, against a stand-in for `apps/api/src/main.ts` (the same
 * `[materials-api]` lines, the same stdin-EOF exit, and a `/health` of its own). No supplier, no credentials read,
 * no network beyond 127.0.0.1.
 *
 * One rule this file exists to remember: `MATERIALS_SMOKE_NO_NET=1` makes the service refuse to start unless
 * `globalThis.fetch` is **no longer the pristine function it captured when `main.ts` was imported**. So a smoke
 * stand-in must be installed *after* importing `main.ts` (see `.dev/smoke/service-entry.mjs`); a `--import` preload
 * runs before that capture and is therefore judged to be "no stand-in at all" (`refused:smoke-net-guard`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MaterialServiceError, materialBindingsPath, materialServiceEntry, materialServiceEnvironment, materialStagingPath,
  packagedMaterialRoot, reasonForRefusal, redact, startMaterialService,
} from './material-service.mjs';

/**
 * A stand-in for `apps/api/src/main.ts`: the same `[materials-api]` lines, the same stdin-EOF exit, and a `/health`
 * of its own. No supplier, no credentials read, no network beyond 127.0.0.1.
 */
const FAKE = `
import { createServer } from 'node:http';
const mode = process.argv[2] ?? 'serve';
const secret = process.env.MATERIALS_SECRET ?? '';
if (process.argv[3] === 'echo-secret') process.stdout.write('[materials-api] debug secret=' + secret + '\\n');
if (mode === 'refuse-port') { process.stdout.write('[materials-api] refusing: port-unavailable\\n'); process.exit(1); }
if (mode === 'refuse-credentials') { process.stderr.write('[materials-api] refusing: credentials-unreadable\\n'); process.exit(1); }
if (mode === 'refuse-bindings') { process.stderr.write('[materials-api] refusing: bindings-missing\\n'); process.exit(2); }
if (mode === 'refuse-staging') { process.stderr.write('[materials-api] refusing: staging-missing\\n'); process.exit(2); }
if (mode === 'exit-early') process.exit(3);
if (mode === 'never-ready' || mode === 'ready-no-health') {
  /* alive, said nothing (or said a bogus ready line), and leaves on EOF so a timeout's stop() really ends it */
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  if (mode === 'ready-no-health') process.stdout.write('[materials-api] ready service=materials bind=127.0.0.1 port=1 origins=0 endpoints=5\\n');
  setInterval(() => {}, 1000);
} else {
  const server = createServer((request, response) => {
    if (request.url === '/health') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, version: '0.0.0-test' })); }
    else { response.statusCode = 404; response.end('{}'); }
  });
  server.listen(Number(process.env.MATERIALS_PORT || 0), '127.0.0.1', () => {
    process.stdout.write('[materials-api] ready service=materials bind=127.0.0.1 port=' + server.address().port + ' origins=0 endpoints=5\\n');
  });
  const leave = () => server.close(() => process.exit(0));
  process.stdin.resume();
  process.stdin.on('end', leave);
  process.on('SIGTERM', leave);
}
`;

const dir = mkdtempSync(join(tmpdir(), 'orange-materials-'));
const fake = join(dir, 'fake-main.ts');
const credentials = join(dir, 'credentials.local.json');
writeFileSync(fake, FAKE);
writeFileSync(credentials, '{}\n');

const start = (mode, options = {}) => startMaterialService({
  /* the checkout stays the temporary directory, so a default staging path is made there and not in this repository */
  checkout: dir,
  entry: fake, credentials, command: process.execPath, args: [fake, mode, ...(options.echo ? ['echo-secret'] : [])],
  healthTimeoutMs: 4_000, healthPollMs: 20, stopTimeoutMs: 3_000, killTimeoutMs: 500,
  ...options,
});

/** Lines a failing start emitted, for the "no secret in any line" assertion. */
function collector() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

test('the child is spawned with exactly the environment the service reads, and a port that is never a constant', () => {
  const env = materialServiceEnvironment({ checkout: dir, credentials, secret: 'x'.repeat(64), origins: ['http://127.0.0.1:5173'] });
  assert.equal(env.MATERIALS_SECRET, 'x'.repeat(64));
  assert.equal(env.MATERIALS_CREDENTIALS, credentials);
  assert.equal(env.MATERIALS_SESSION_MODE, 'hmac');
  assert.equal(env.MATERIALS_ORIGINS, 'http://127.0.0.1:5173');
  assert.equal(env.MATERIALS_PORT, '0', 'the default is an ephemeral port: the bound one is read from the ready line');
  assert.notEqual(env.MATERIALS_PORT, '59600');
  const fixed = materialServiceEnvironment({ checkout: dir, credentials, secret: 'x'.repeat(64), port: 61234 });
  assert.equal(fixed.MATERIALS_PORT, '61234');
  assert.throws(() => materialServiceEnvironment({ checkout: dir, credentials, secret: 's', port: 70000 }), /端口不合法/);
});

test('a started service answers with its own origin, keeps the secret to itself, and stops on stdin EOF', async () => {
  const { lines, log } = collector();
  const service = await start('serve', { log, secret: 'a'.repeat(64) });
  assert.match(service.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(service.port, Number(service.origin.split(':').pop()));
  assert.equal(service.secret, 'a'.repeat(64));
  const health = await (await fetch(service.origin + '/health')).json();
  assert.deepEqual(health, { ok: true, version: '0.0.0-test' });
  const stopped = await service.stop();
  assert.equal(stopped.exited, true);
  assert.equal(stopped.code, 0, 'closing stdin is the service\'s own exit 0, not a kill');
  const again = await service.stop();
  assert.equal(again.exited, true, 'stop is idempotent');
  assert.equal(again.code, 0);
  for (const line of lines) assert(!line.includes('a'.repeat(64)), 'the secret never reaches a log line');
});

test('a service that exits while starting is reported as its exit code, not as a stack', async () => {
  await assert.rejects(start('exit-early'), (error) => {
    assert.ok(error instanceof MaterialServiceError);
    assert.equal(error.reason, 'exited:3');
    assert.equal(error.message, '素材服务启动时退出（exited:3）');
    return true;
  });
});

test('a port already in use is recognised from the service\'s own refusal line', async () => {
  await assert.rejects(start('refuse-port'), (error) => {
    assert.equal(error.reason, 'port-in-use');
    assert.match(error.message, /port-in-use/);
    return true;
  });
  assert.equal(reasonForRefusal('port-unavailable'), 'port-in-use');
  assert.equal(reasonForRefusal('credentials-unreadable'), 'refused:credentials-unreadable');
  await assert.rejects(start('refuse-credentials'), (error) => error.reason === 'refused:credentials-unreadable');
});

test('a ready line is not enough: a service that never answers /health times out, and is stopped', async () => {
  const { lines, log } = collector();
  /* The same clock covers the spawn and the health poll, so it has to be long enough for a node process to boot and
     say its line on a loaded machine: at 400 ms a busy machine reported `start-timeout` instead, which is a different
     failure. The fixture never answers /health, so the health timeout still fires — that is what is under test. */
  await assert.rejects(start('ready-no-health', { healthTimeoutMs: 2_500, log }), (error) => {
    assert.equal(error.reason, 'health-timeout');
    return true;
  });
  assert.ok(lines.some((line) => line.includes('[materials-api] ready')), 'the ready line was seen and still did not count');
});

test('a service that never says anything is a start timeout, and a command that cannot run is a spawn failure', async () => {
  await assert.rejects(start('never-ready', { healthTimeoutMs: 300 }), (error) => error.reason === 'start-timeout');
  await assert.rejects(start('serve', { command: join(dir, 'no-such-node.exe') }), (error) => error.reason === 'spawn-failed');
});

test('a missing credentials file stops the start before a process exists', async () => {
  await assert.rejects(startMaterialService({ entry: fake, credentials: join(dir, 'missing.json'), command: process.execPath, args: [fake] }), (error) => {
    assert.equal(error.reason, 'credentials-missing');
    assert.match(error.message, /credentials-missing|缺凭据/);
    return true;
  });
});

test('the window starts the service with its own origin, and stops it on every path that ends or restarts Studio', () => {
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /materials: \(\) => startMaterials\(\[\]\)/, 'the service starts before Studio, as a server-side call (no browser origin)');
  assert.match(main, /async function runStudio\(env\) \{\s*startedAt = Date\.now\(\);[\s\S]{0,240}await stopMaterials\(\);/, 'a Studio that starts again stops the last service first');
  assert.match(main, /app\.on\('before-quit', \(event\) => \{\s*if\(quitConfirmed\)return;[\s\S]{0,240}void stopMaterials\(\);/,
    'quitting stops it');
  assert.match(main, /process\.on\('exit', \(\) => \{ try \{ materials\?\.kill\(\); \}/, 'a main process that dies without quitting still kills it');
  assert.match(main, /MATERIAL_CREDENTIALS = join\(MATERIAL_CHECKOUT, '\.dev', 'zhishang', 'credentials\.local\.json'\)/, 'the credentials file is the ignored one, by path only');
  assert(!/MATERIALS_SECRET/.test(main), 'the window never names the secret: the service module mints and hands it over');
});

test('whatever the child prints, the secret is redacted line by line — in logs and in error messages', async () => {
  const secret = 'b'.repeat(64);
  const { lines, log } = collector();
  const service = await start('serve', { log, secret, echo: true });
  assert.equal(service.secret, secret);
  await service.stop();
  assert.ok(lines.length > 0, 'the child said something, and every line went through the log');
  for (const line of lines) assert(!line.includes(secret), 'child output carrying the secret must never be logged as it came');
  assert.equal(redact('hello ' + secret + ' bye', secret), 'hello [redacted] bye');
  assert.equal(redact('nothing here', secret), 'nothing here');
  /* a failing start redacts the same way: the refusal path logs the child's own lines */
  const failing = collector();
  await assert.rejects(start('refuse-port', { log: failing.log, secret, echo: true }), (error) => {
    assert(!String(error.message).includes(secret));
    assert(!String(error.detail ?? '').includes(secret));
    return true;
  });
  for (const line of failing.lines) assert(!line.includes(secret));
});

test('the binding file travels to the child as MATERIALS_BINDINGS, as a path and nothing more', () => {
  const bindings = join(dir, 'bindings.local.json');
  writeFileSync(bindings, '{"version":1,"bindings":{}}\n');
  const env = materialServiceEnvironment({ checkout: dir, credentials, bindings, secret: 'c'.repeat(64) });
  assert.equal(env.MATERIALS_BINDINGS, bindings, 'the value passed is the value the child reads');
  assert.equal(materialServiceEnvironment({ checkout: dir, credentials, secret: 'c'.repeat(64) }).MATERIALS_BINDINGS, materialBindingsPath(dir),
    'absent an explicit path, the default is derived from the checkout');
  assert.equal(materialBindingsPath(dir), join(dir, '.dev', 'zhishang', 'bindings.local.json'));
  assert.notEqual(env.MATERIALS_BINDINGS, env.MATERIALS_CREDENTIALS);
  /* nothing about the file's contents is read here: only the path goes over, and the file is not touched */
  assert.equal(env.MATERIALS_BINDINGS, bindings);
});

test('a missing binding file is the service\'s own refusal: one line, no bare stack, and the window keeps working', async () => {
  const { lines, log } = collector();
  const missing = join(dir, 'absent-bindings.local.json');
  const error = await start('refuse-bindings', { log, bindings: missing }).then(() => null, (failure) => failure);
  assert.ok(error instanceof MaterialServiceError);
  assert.equal(error.reason, 'refused:bindings-missing');
  assert.equal(error.message, '素材服务拒绝启动：refused:bindings-missing');
  assert(!/\n\s+at /.test(error.message), 'the report is one line, not a stack');
  assert.ok(lines.some((line) => line.includes('refusing: bindings-missing')), 'the child\'s own refusal line is what the log carries');
  /* the window's side of the same event: it records the reason and goes on */
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /catch \(error\) \{\s*materials = null;\s*log\(`material service did not start: \$\{error\?\.reason \?\? error\?\.code \?\? 'unknown'\}\\n`\);/,
    'one line: did not start: <reason>');
  assert(!/materials = null;\s*log\([^\n]*\);\s*throw/.test(main), 'a refused start is never rethrown into the window');
});

test('after a start that failed there is nothing to stop, and stopping twice never throws', async () => {
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /function stopMaterials\(\) \{\s*const current = materials;\s*materials = null;\s*if \(!current\) return materialStop;/,
    'the desktop stop path returns at once when no service ever started');
  await assert.rejects(start('refuse-bindings'), (error) => error.reason === 'refused:bindings-missing');
  const service = await start('serve');
  const first = await service.stop();
  const second = await service.stop();
  assert.deepEqual([first.exited, second.exited], [true, true], 'a stop after a failed start — and the second stop — resolves, never throws');
});

test('the packaged entry is spelled out from resourcesPath, never guessed from the working directory', () => {
  const resources = join(dir, 'fake-resources');
  const root = packagedMaterialRoot(resources);
  assert.equal(root, join(resources, 'app.asar.unpacked'));
  assert.equal(materialServiceEntry(root), join(resources, 'app.asar.unpacked', 'apps', 'api', 'src', 'main.ts'));
  assert.equal(materialServiceEntry(join(root, '.')), materialServiceEntry(root), 'the same root spelled two ways is the same entry');
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /app\.isPackaged \? packagedMaterialRoot\(process\.resourcesPath\) : here\('\.\.\/\.\.\/\.\.\/'\)/,
    'a packaged app derives the unpacked root explicitly, a development one from the checkout');
  assert.match(main, /bindings: MATERIAL_BINDINGS/, 'the start call hands the binding path over');
  assert.match(main, /materialBindingsPath\(MATERIAL_CHECKOUT\)/, 'and that path is derived from the checkout, not written out');
});

test('the staging directory travels to the child as MATERIALS_STAGING, as a path and nothing more', () => {
  const staging = join(dir, 'some-staging');
  const env = materialServiceEnvironment({ checkout: dir, credentials, staging, secret: 'd'.repeat(64) });
  assert.equal(env.MATERIALS_STAGING, staging, 'the value passed is the value the child reads');
  assert.equal(materialStagingPath(dir), join(dir, '.dev', 'staging'), 'the default is the ignored .dev/staging of the checkout');
  assert.equal(materialServiceEnvironment({ checkout: dir, credentials, secret: 'd'.repeat(64) }).MATERIALS_STAGING, materialStagingPath(dir),
    'absent an explicit path, the default is derived from the checkout');
  assert.notEqual(env.MATERIALS_STAGING, env.MATERIALS_CREDENTIALS);
});

test('a staging directory that does not exist yet is made before the service is asked to start', async () => {
  const staging = join(dir, 'made', 'for', 'the', 'run');
  assert.equal(existsSync(staging), false);
  const service = await start('serve', { staging });
  assert.equal(existsSync(staging), true, 'apps/api refuses to come up without it, so the parent makes it');
  await service.stop();
});

test('a file where the staging directory belongs is staging-unavailable: one line, no bare stack, window unaffected', async () => {
  const blocked = join(dir, 'staging-is-a-file');
  writeFileSync(blocked, 'not a directory\n');
  const { lines, log } = collector();
  const error = await start('serve', { staging: blocked, log }).then(() => null, (failure) => failure);
  assert.ok(error instanceof MaterialServiceError);
  assert.equal(error.reason, 'staging-unavailable');
  assert.match(error.message, /staging-unavailable/);
  assert(!/\n\s+at /.test(error.message), 'the report is one line, not a stack');
  assert.deepEqual(lines, [], 'nothing was even spawned: the refusal is decided before the child exists');
  /* the window's side: the catch in main.mjs logs one line and never rethrows */
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /log\(`material service did not start: \$\{error\?\.reason \?\? error\?\.code \?\? 'unknown'\}\\n`\)/);
  assert(!/materials = null;\s*log\([^\n]*\);\s*throw/.test(main));
});

test('a staging refusal from the service itself reaches the window as one line, on the same codes as the other refusals', async () => {
  const { lines, log } = collector();
  const error = await start('refuse-staging', { log }).then(() => null, (failure) => failure);
  assert.ok(error instanceof MaterialServiceError);
  assert.equal(error.reason, 'refused:staging-missing');
  assert.ok(lines.some((line) => line.includes('refusing: staging-missing')));
  /* the exact line the window would write, spelled out: did not start: refused:staging-missing */
  const windowLine = `material service did not start: ${error?.reason ?? error?.code ?? 'unknown'}\n`;
  assert.equal(windowLine, 'material service did not start: refused:staging-missing\n');
});
