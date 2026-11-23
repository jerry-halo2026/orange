// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  KILL_GRACE_MS, PATH_KEYS, assertFresh, canonicalPath, finishAttempt, freshAttempt, killTree, readJobReport, writeRunFiles,
} from './fission-runner.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'mix-runner-'));

test('writeRunFiles：paths 只有五个只读键，WorkRoot/OutRoot 绝不出现', () => {
  const root = temp();
  const enginePaths = {
    FFmpeg: 'D:/dev/7d/bin/ffmpeg.exe', FFprobe: 'D:/dev/7d/bin/ffprobe.exe',
    TransitionsDir: root, AssetsRoot: root, LocalAssetsRoot: root,
    WorkRoot: join(root, 'nope'), OutRoot: join(root, 'nope2'),
  };
  const { pathsFile, jobFile } = writeRunFiles(root, enginePaths, { Count: 1 });
  const parsed = JSON.parse(readFileSync(pathsFile, 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), [...PATH_KEYS].sort());
  assert.equal('WorkRoot' in parsed, false);
  assert.equal(JSON.parse(readFileSync(jobFile, 'utf8')).Count, 1);
});

test('assertFresh：work/out/cache 任一已存在就拒，并说是哪个', () => {
  const root = temp();
  const attempt = 'a1';
  mkdirSync(join(root, 'workspace', 't1', attempt, 'out'), { recursive: true });
  assert.throws(() => assertFresh(root, 't1', attempt), (error) => error.code === 'attempt-not-fresh' && /out/.test(error.message));
  const clean = temp();
  assert.equal(assertFresh(clean, 't1', 'a1'), join(clean, 'workspace', 't1', 'a1'));
});

test('freshAttempt：小写、字母数字与连字符、每次不同', () => {
  const one = freshAttempt('Batch-1');
  const two = freshAttempt('Batch-1');
  assert.match(one, /^(?!-)[a-z0-9-]{1,40}(?<!-)$/);
  assert.notEqual(one, two);
});

test('readJobReport：认 report.json 的 PascalCase，产物必须在输出目录内', () => {
  const out = temp();
  const job = join(out, 'job1');
  mkdirSync(job, { recursive: true });
  const mp4 = join(job, '001.mp4');
  writeFileSync(mp4, 'x');
  writeFileSync(join(job, 'report.json'), JSON.stringify({
    JobId: 'job1', Succeeded: 1, Failed: 0, StopReason: 'countReached',
    Outputs: [{ Index: 0, Path: mp4, Title: '001', DurationSec: 5.2, EditPlanPath: join(job, '001.edit-plan.json') }],
    Failures: [],
  }));
  const report = readJobReport(out);
  assert.equal(report.stopReason, 'countReached');
  assert.equal(report.outputs.length, 1);
  assert.equal(report.outputs[0].path, mp4);

  const bad = temp();
  const badJob = join(bad, 'job1');
  mkdirSync(badJob, { recursive: true });
  writeFileSync(join(badJob, 'report.json'), JSON.stringify({ Succeeded: 1, Outputs: [{ Index: 0, Path: 'C:/elsewhere/x.mp4' }] }));
  assert.throws(() => readJobReport(bad), (error) => error.code === 'report-invalid');
});

test('readJobReport：没有报告时说"没走到收尾"，不猜产物', () => {
  const out = temp();
  mkdirSync(join(out, 'job1'), { recursive: true });
  assert.throws(() => readJobReport(out), (error) => error.code === 'report-missing');
});

test('finishAttempt：失败改名留证据，成功可按需保留', () => {
  const root = temp();
  mkdirSync(join(root, 'workspace', 't1', 'a1', 'work'), { recursive: true });
  const trashed = finishAttempt(root, { attempt: 'a1' });
  assert.ok(trashed && trashed.includes('failed'));
  assert.equal(existsSync(join(root, 'workspace', 't1', 'a1')), false);

  const kept = temp();
  mkdirSync(join(kept, 'workspace', 't1', 'a2', 'out'), { recursive: true });
  assert.ok(finishAttempt(kept, { attempt: 'a2', keep: true })?.endsWith('a2'));
  assert.equal(existsSync(join(kept, 'workspace', 't1', 'a2', 'out')), true);
});

test('canonicalPath：解析得动就给原生长路径，解析不动就原样返回', () => {
  const root = temp();
  const resolved = canonicalPath(root);
  assert.equal(resolved, realpathSync.native(root));
  assert.equal(canonicalPath(join(root, 'nope', 'nope-xyz')), join(root, 'nope', 'nope-xyz'));
});

test('killTree（POSIX）：先给进程组 SIGTERM，宽限 3 秒后再 SIGKILL', () => {
  const calls = [];
  /** @type {{fn: () => void, ms: number}[]} */
  const timers = [];
  const child = { pid: 123, kill(/** @type {string} */ signal) { calls.push(['child', signal]); } };
  const timer = killTree(child, {
    platform: 'linux',
    kill: (pid, signal) => { calls.push([pid, signal]); },
    later: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
  });
  assert.deepEqual(calls, [[-123, 'SIGTERM']], '先礼：整组 TERM（-pid），不是单杀子进程');
  assert.equal(timers.length, 1, '宽限只有一个定时器');
  assert.equal(timers[0].ms, KILL_GRACE_MS);
  assert.equal(KILL_GRACE_MS, 3000);
  assert.ok(timer, '返回定时器，调用方可以不管');
  timers[0].fn();
  assert.deepEqual(calls, [[-123, 'SIGTERM'], [-123, 'SIGKILL']], '后兵：整组 KILL');
});

test('killTree（POSIX）：没有进程组可用时退化成单进程信号，仍按 TERM → KILL 走', () => {
  const calls = [];
  /** @type {{fn: () => void}[]} */
  const timers = [];
  const child = { pid: 42, kill(/** @type {string} */ signal) { calls.push(['child', signal]); } };
  killTree(child, {
    platform: 'darwin',
    kill: (pid, signal) => { calls.push([pid, signal]); throw new Error('ESRCH'); },
    later: (fn) => { timers.push({ fn }); return { unref() {} }; },
  });
  assert.deepEqual(calls, [[-42, 'SIGTERM'], ['child', 'SIGTERM']], '组没了就杀子进程');
  timers[0].fn();
  assert.deepEqual(calls.at(-1), ['child', 'SIGKILL']);
});

test('killTree（Windows）：taskkill /PID <pid> /T /F，不走 process.kill', () => {
  const spawned = [];
  killTree({ pid: 456, kill() { assert.fail('Windows 上不该用 child.kill'); } }, {
    platform: 'win32',
    spawnImpl: (command, args, options) => { spawned.push({ command, args, options }); return null; },
    kill: () => { assert.fail('Windows 上不该用 process.kill'); },
  });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'taskkill');
  assert.deepEqual(spawned[0].args, ['/PID', '456', '/T', '/F']);
});

test('killTree：没有 pid 就什么都不做', () => {
  const calls = [];
  assert.equal(killTree({}, { platform: 'linux', kill: (pid) => calls.push(pid) }), null);
  assert.deepEqual(calls, []);
});
