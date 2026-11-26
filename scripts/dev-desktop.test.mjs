// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `pnpm dev:desktop`'s wiring: the bootstrap is spawned and forgotten, the app is spawned and waited for.
 *
 * The one claim worth a test is the ordering guarantee: whatever the index does — start, refuse to start, fail later —
 * the app is started anyway, and nothing the bootstrap does is awaited before the window opens. The spawns are injected,
 * so no window is opened and no Electron is started here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { BOOTSTRAP_SCRIPT, DESKTOP_ARGS, desktopCommand, startDesktop, startMaterialIndexBootstrap } from './dev-desktop.mjs';

/** A stand-in child: records the spawn and lets the test decide how it ends. */
function fakeChild(pid = 1000) {
  const child = new EventEmitter();
  Object.assign(child, { pid, killed: [], unrefCount: 0, unref() { this.unrefCount += 1; }, kill(signal) { this.killed.push(signal); return true; } });
  return child;
}

test('the bootstrap is spawned detached, with no stdio and unref\'d, and is not waited for', () => {
  const calls = [];
  const child = fakeChild(4242);
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };

  const started = startMaterialIndexBootstrap({ spawnFn, execPath: 'node.exe', script: BOOTSTRAP_SCRIPT, env: {} });

  assert.deepEqual(started, { spawned: true, pid: 4242 });
  assert.deepEqual(calls[0].args, [BOOTSTRAP_SCRIPT, '--detach', '--quiet']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore', 'nothing the bootstrap prints can reach the app\'s console');
  assert.equal(child.unrefCount, 1, 'the parent does not keep the process alive for it');
});

test('a bootstrap that cannot even be spawned is a line in the log, and nothing else', () => {
  const spawnFn = () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }); };
  const started = startMaterialIndexBootstrap({ spawnFn, script: '/x/bootstrap.mjs' });

  assert.equal(started.spawned, false);
  assert.match(String(started.error), /EACCES/);
});

test('the app is launched after the bootstrap, with the desktop package\'s own start', async () => {
  const calls = [];
  const child = fakeChild(5151);
  const spawnFn = (command, args, options) => {
    calls.push({ name: 'spawn', command, args, options });
    return child;
  };

  const boot = startMaterialIndexBootstrap({ spawnFn, execPath: 'node.exe', script: BOOTSTRAP_SCRIPT });
  const app = startDesktop({ spawnFn, env: {}, forwardSignals: false });

  assert.deepEqual(calls.map((call) => call.command), ['node.exe', 'pnpm']);
  assert.deepEqual(calls[1].args, [...DESKTOP_ARGS]);
  assert.equal(calls[1].options.stdio, 'inherit', 'the app\'s output is the session\'s output');

  assert.equal(boot.spawned, true);
  child.emit('exit', 0);
  assert.equal(await app, 0);
});

test('the app\'s exit code is the script\'s, and a signal exit is reported as a failure', async () => {
  const child = fakeChild();
  const coded = startDesktop({ spawnFn: () => child, env: { ORANGE_DESKTOP_START: 'electron.exe --dev' }, forwardSignals: false });
  child.emit('exit', 7);
  assert.equal(await coded, 7);

  const signalledChild = fakeChild();
  const signalled = startDesktop({ spawnFn: () => signalledChild, env: {}, forwardSignals: false });
  signalledChild.emit('exit', null, 'SIGKILL');
  assert.equal(await signalled, 1);
});

test('the app finishing is what ends the script: a failed bootstrap never reaches the exit code', async () => {
  const bootstrapChild = fakeChild();
  const appChild = fakeChild();
  const children = [bootstrapChild, appChild];
  const spawnFn = () => children.shift();
  startMaterialIndexBootstrap({ spawnFn, execPath: 'node.exe', script: BOOTSTRAP_SCRIPT });
  const app = startDesktop({ spawnFn, env: {}, forwardSignals: false });
  /* the bootstrap "failing" is invisible here: it is a separate process, and its exit is not awaited */
  bootstrapChild.emit('exit', 1);
  appChild.emit('exit', 0);
  assert.equal(await app, 0);
});

test('ORANGE_DESKTOP_START replaces the command line, and the default is the real one', () => {
  assert.deepEqual(desktopCommand({}), ['pnpm', ...DESKTOP_ARGS]);
  assert.deepEqual(desktopCommand({ ORANGE_DESKTOP_START: '  electron.exe  --dev ' }), ['electron.exe', '--dev']);
});
