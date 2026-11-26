// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `pnpm dev:all` 的契约：每一步的退出码，以及「失败就不开窗」。
 *
 * 三条必须有的证据（任务验收）在这里被钉住，且全程只有注入的假件——不碰 docker、不写 `.dev/dev.pid`、不开窗：
 *   1. docker 未就绪 → 第 2 步退出 2，且没有派生应用；
 *   2. 已有实例 → 打印「已在运行：origin …」并退出 0，不第二个 Studio；
 *   3. 迁移失败 → 按 migrate 自己的码停下，不跑 verify、不开窗。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXIT, StepError, childEnvironment, clearDevPid, detectExistingInstance, devAll, ensureDependencyServices,
  indexStatus, pidAlive, probeStudio, readDevPid, resolveAuthRuntime, runVerify, watchStudioOrigin, writeDevPid,
} from './dev-all.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'orange-dev-all-'));

/** 九项全过的 verify 报告，与 infra/verify.mjs 的 `TOTAL = 9` 对齐。 */
const nineChecks = () => [
  '① vector 扩展版本', '② SET hnsw.iterative_scan', '③ 六张表齐全', '④ RLS 已启用',
  '⑤ 两租户互不可见', '⑥ sync_state', '⑦ material.deleted_at', '⑧ search_materials', '⑨ 向量分支',
].map((id) => ({ id, ok: true, detail: 'ok' }));

/** 一套全绿的注入依赖；测试只覆盖它关心的那一步。 */
function harness(overrides = {}) {
  const events = [];
  const logs = [];
  const errors = [];
  const warnings = [];
  const deps = {
    resolveAuth: () => ({
      source: 'file',
      file: 'D:/dev/orange/.dev/auth-runtime.json',
      environment: { environmentId: 'orange-test-desktop', authOrigin: 'https://example.supabase.co', publishableKey: 'not-printed' },
      note: null,
    }),
    childEnv: (base) => ({ ...base, ORANGE_AUTH_CONFIG_FILE: 'D:/dev/orange/.dev/auth-runtime.json', ORANGE_FISSION_CONFIG_FILE: 'D:/dev/orange/.dev/fission-runtime/runtime.repo.json' }),
    ensureServices: async () => { events.push('services'); return { ok: true, note: 'orange-w1-db 已在运行' }; },
    migrate: async () => { events.push('migrate'); return { code: 0 }; },
    verify: async () => { events.push('verify'); return { code: 0, report: { ok: true, checks: nineChecks(), notes: [] }, failed: [] }; },
    startIndex: () => { events.push('index'); return { spawned: true, pid: 999 }; },
    indexStatus: async () => { events.push('index-status'); return { code: 0, stdout: 'landed：1200 条素材，2 分钟前\n', stderr: '' }; },
    detectExisting: async () => { events.push('single'); return { running: false, cleaned: false }; },
    startApp: () => { events.push('spawn'); return { child: { pid: 4242 }, exit: Promise.resolve(0) }; },
    watchStudio: async () => { events.push('watch'); return { ok: true, origin: 'http://127.0.0.1:4757', filmOrigin: 'http://localhost:4758' }; },
    ...overrides,
  };
  return {
    deps, events, logs, errors, warnings,
    run: () => devAll({
      root: temp(), deps, log: (line) => logs.push(line), error: (line) => errors.push(line), warn: (line) => warnings.push(line),
    }),
  };
}

// ---------------------------------------------------------------------------
// 三条验收
// ---------------------------------------------------------------------------
test('docker 未就绪 → 第 2 步「依赖服务未就绪」，exit 2，且不派生窗口', async () => {
  const h = harness({
    ensureServices: async () => ({ ok: false, reason: 'Docker 引擎不可用（docker version 失败）：open //./pipe/docker_engine: Access is denied.' }),
  });
  const code = await h.run();

  assert.equal(code, EXIT.services, '依赖服务未就绪就是 2');
  assert.match(h.logs.join('\n'), /\[2\/7\] 依赖服务/, '失败步要打印出是第几步');
  assert.match(h.errors.join('\n'), /依赖服务未就绪：Docker 引擎不可用/);
  assert.deepEqual(h.events, [], '迁移、校验、索引、窗口一个都不该发生——不半启动');
});

test('已有实例：打印「已在运行：origin …」并 exit 0，不第二个 Studio', async () => {
  const h = harness({
    detectExisting: async () => ({ running: true, how: 'pid', origin: 'http://127.0.0.1:4757', pid: 49264, cleaned: false }),
  });
  const code = await h.run();

  assert.equal(code, EXIT.ok);
  assert.match(h.logs.join('\n'), /已在运行：origin http:\/\/127\.0\.0\.1:4757/);
  assert.ok(!h.events.includes('spawn'), '第二次运行不得再派生 pnpm dev:desktop');
  assert.ok(!h.events.includes('watch'));
});

test('迁移失败即停：传播 migrate 的退出码，不跑 verify、不开窗', async () => {
  const h = harness({ migrate: async () => { h.events.push('migrate'); return { code: 1 }; } });
  const code = await h.run();

  assert.equal(code, 1, '迁移自己的码原样传播');
  assert.match(h.errors.join('\n'), /迁移失败（exit 1）/);
  assert.deepEqual(h.events, ['services', 'migrate'], 'verify 之后的一切都不该发生');
});

test('迁移的环境错误（exit 2）同样原样传播', async () => {
  const h = harness({ migrate: async () => ({ code: 2 }) });
  assert.equal(await h.run(), 2);
  assert.ok(!h.events.includes('verify'));
});

test('verify 有 FAIL → exit 2，并点名失败的检查项', async () => {
  const checks = nineChecks();
  checks[4] = { id: '⑤ 两租户互不可见', ok: false, detail: 'A 看到 [verify-b]' };
  const h = harness({
    verify: async () => ({ code: 1, report: { ok: false, checks, notes: [] }, failed: [checks[4]] }),
  });
  const code = await h.run();

  assert.equal(code, EXIT.services);
  assert.match(h.logs.join('\n'), /verify 8\/9/);
  assert.match(h.errors.join('\n'), /FAIL ⑤ 两租户互不可见：A 看到 \[verify-b\]/);
  assert.ok(!h.events.includes('spawn'));
});

test('全绿：迁移、verify 9/9、索引状态、窗口 origin 依次打印，pid 文件写后清', async () => {
  const root = temp();
  const snapshots = [];
  const h = harness({
    watchStudio: async () => {
      h.events.push('watch');
      snapshots.push(readDevPid({ root }));
      return { ok: true, origin: 'http://127.0.0.1:4757', filmOrigin: 'http://localhost:4758' };
    },
  });
  const code = await devAll({
    root, deps: h.deps, log: (line) => h.logs.push(line), error: (line) => h.errors.push(line), warn: (line) => h.warnings.push(line),
  });

  assert.equal(code, 0);
  const all = h.logs.join('\n');
  assert.match(all, /\[3\/7\] 迁移/);
  assert.match(all, /verify 9\/9/);
  assert.match(all, /索引：landed：1200 条素材/);
  assert.match(all, /窗口：origin http:\/\/127\.0\.0\.1:4757 \/ film http:\/\/localhost:4758/);
  assert.equal(h.events.filter((e) => e === 'spawn').length, 1);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.record?.pid, 4242, '启动后立刻写 pid 文件');
  assert.equal(snapshots[0]?.record?.environmentId, 'orange-test-desktop');
  assert.equal(existsSync(join(root, '.dev', 'dev.pid')), false, '应用退出后 pid 文件要删掉');
});

test('环境文件缺失：用本地默认并提示，不打印 key', async () => {
  const root = temp();
  mkdirSync(join(root, '.dev'), { recursive: true });
  const auth = resolveAuthRuntime({ root, env: {} });
  assert.equal(auth.source, 'local-default');
  assert.equal(auth.environment.environmentId, 'orange-local-docker');
  assert.match(String(auth.note), /本地默认/);
});

test('环境文件不合法：第 1 步退出 1，且不进依赖检查', async () => {
  const root = temp();
  mkdirSync(join(root, '.dev'), { recursive: true });
  writeFileSync(join(root, '.dev', 'auth-runtime.json'), '{"environmentId":"x"}');
  const h = harness();
  delete h.deps.resolveAuth; // 让真的 resolveAuthRuntime 去读这个坏文件
  const code = await devAll({
    root, deps: h.deps, log: (line) => h.logs.push(line), error: (line) => h.errors.push(line), warn: () => {},
  });
  assert.equal(code, EXIT.config);
  assert.match(h.errors.join('\n'), /第 1 步（环境）失败：.*(authOrigin|publishableKey)/);
  assert.deepEqual(h.events, []);
});

// ---------------------------------------------------------------------------
// 单元：环境解析与子进程环境
// ---------------------------------------------------------------------------
test('resolveAuthRuntime 读三键，坏 JSON 与缺字段各有自己的 StepError', () => {
  const root = temp();
  mkdirSync(join(root, '.dev'), { recursive: true });
  const file = join(root, '.dev', 'auth-runtime.json');

  writeFileSync(file, JSON.stringify({ environmentId: 'orange-test-desktop', authOrigin: 'https://example.supabase.co', publishableKey: 'k' }));
  const ok = resolveAuthRuntime({ root, env: {} });
  assert.equal(ok.source, 'file');
  assert.equal(ok.environment.environmentId, 'orange-test-desktop');

  writeFileSync(file, '{not json');
  assert.throws(() => resolveAuthRuntime({ root, env: {} }), (error) => error instanceof StepError && error.code === 1 && /不是合法 JSON/.test(error.message));

  writeFileSync(file, JSON.stringify({ environmentId: 'x', authOrigin: 'http://h', publishableKey: '' }));
  assert.throws(() => resolveAuthRuntime({ root, env: {} }), (error) => error instanceof StepError && /publishableKey/.test(error.message));
});

test('childEnvironment 导出两个绝对路径；文件不在时不凭空造', () => {
  const root = temp();
  mkdirSync(join(root, '.dev', 'fission-runtime'), { recursive: true });
  writeFileSync(join(root, '.dev', 'fission-runtime', 'runtime.repo.json'), '{}');

  const without = childEnvironment({ KEEP: '1' }, { root });
  assert.equal(without.ORANGE_AUTH_CONFIG_FILE, undefined);
  assert.equal(without.ORANGE_FISSION_CONFIG_FILE, join(root, '.dev', 'fission-runtime', 'runtime.repo.json'));
  assert.equal(without.KEEP, '1');

  writeFileSync(join(root, '.dev', 'auth-runtime.json'), '{}');
  const withAuth = childEnvironment({}, { root });
  assert.equal(withAuth.ORANGE_AUTH_CONFIG_FILE, join(root, '.dev', 'auth-runtime.json'));
});

// ---------------------------------------------------------------------------
// 单元：依赖服务
// ---------------------------------------------------------------------------
test('ensureDependencyServices：docker 引擎不在 → 不可用，不尝试 compose', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(' '));
    return { code: 1, stdout: '', stderr: 'open //./pipe/docker_engine: Access is denied.' };
  };
  const result = await ensureDependencyServices({ run, log: () => {}, exists: () => true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Docker 引擎不可用/);
  assert.equal(calls.length, 1, 'docker version 失败就停，不再 compose');
});

test('ensureDependencyServices：容器已在答 select 1 → 直接通过', async () => {
  const run = async (command, args) => {
    if (args[0] === 'version') return { code: 0, stdout: '29.9.3\n', stderr: '' };
    if (args.includes('select 1')) return { code: 0, stdout: '1\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const result = await ensureDependencyServices({ run, probe: async () => true, log: () => {}, exists: () => true });
  assert.deepEqual(result.ok, true);
  assert.match(result.note, /已在运行/);
});

test('ensureDependencyServices：未就绪 → compose up -d，超时后给出可读原因', async () => {
  const calls = [];
  let clock = 0;
  const run = async (command, args) => {
    calls.push(args[0]);
    if (args[0] === 'version') return { code: 0, stdout: '29.9.3\n', stderr: '' };
    if (args[0] === 'inspect') return { code: 0, stdout: 'exited\n', stderr: '' };
    if (args.includes('up')) return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'service "db" is not running' };
  };
  const result = await ensureDependencyServices({
    run, probe: async () => true, log: () => {}, exists: () => true,
    timeoutMs: 60_000, sleep: async () => {}, now: () => (clock += 31_000),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /60s 内没有等到 orange-w1-db 应答 select 1/);
  assert.ok(calls.includes('inspect') && calls.includes('compose'), '先探状态，再 compose up -d');
});

test('ensureDependencyServices：compose 文件不存在 → 明确说没有编排可起', async () => {
  const run = async (command, args) => {
    if (args[0] === 'version') return { code: 0, stdout: '29.9.3\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'no such container: orange-w1-db' };
  };
  const result = await ensureDependencyServices({ run, probe: async () => false, log: () => {}, exists: () => false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /没有 .*docker-compose\.yml/);
});

// ---------------------------------------------------------------------------
// 单元：单例
// ---------------------------------------------------------------------------
test('detectExistingInstance：死 pid 被清理，随后以 Studio health 认领', async () => {
  const root = temp();
  writeDevPid({ root, pid: 111_111, origin: null });
  const cleared = [];
  const result = await detectExistingInstance({
    root, env: {},
    alive: () => false,
    runFile: () => ({ origin: 'http://127.0.0.1:4757', pid: 4321, file: 'run.json' }),
    probe: async (origin) => ({ ok: true, origin }),
    clear: ({ root: at }) => { cleared.push(at); clearDevPid({ root: at }); return true; },
    log: () => {},
  });
  assert.equal(result.running, true);
  assert.equal(result.how, 'studio');
  assert.equal(result.origin, 'http://127.0.0.1:4757');
  assert.equal(cleared.length, 1);
  assert.equal(existsSync(join(root, '.dev', 'dev.pid')), false, '死 pid 文件要被删掉');
});

test('detectExistingInstance：活 pid 但端口探不到 → 仍算已在运行（不另起）', async () => {
  const root = temp();
  writeDevPid({ root, pid: 2222, origin: 'http://127.0.0.1:4757' });
  const result = await detectExistingInstance({
    root, env: {}, alive: () => true,
    runFile: () => null, probe: async () => ({ ok: false, reason: '不可达：ECONNREFUSED' }), log: () => {},
  });
  assert.equal(result.running, true);
  assert.equal(result.how, 'pid-unreachable');
  assert.match(result.note, /ECONNREFUSED/);
});

test('detectExistingInstance：坏 pid 文件被清理，判定为未运行', async () => {
  const root = temp();
  mkdirSync(join(root, '.dev'), { recursive: true });
  writeFileSync(join(root, '.dev', 'dev.pid'), 'not json');
  const result = await detectExistingInstance({ root, env: {}, runFile: () => null, log: () => {} });
  assert.equal(result.running, false);
  assert.equal(result.cleaned, true);
  assert.equal(existsSync(join(root, '.dev', 'dev.pid')), false);
});

test('pidAlive：EPERM 算活着，ESRCH 算死', () => {
  assert.equal(pidAlive(1234, () => undefined), true);
  assert.equal(pidAlive(1234, () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); }), true);
  assert.equal(pidAlive(1234, () => { throw Object.assign(new Error('nope'), { code: 'ESRCH' }); }), false);
  assert.equal(pidAlive(0), false);
});

test('clearDevPid：只删自己那份', () => {
  const root = temp();
  writeDevPid({ root, pid: 777 });
  assert.equal(clearDevPid({ root, pid: 888 }), false);
  assert.equal(existsSync(join(root, '.dev', 'dev.pid')), true);
  assert.equal(clearDevPid({ root, pid: 777 }), true);
  assert.equal(existsSync(join(root, '.dev', 'dev.pid')), false);
});

test('probeStudio 只认 orangefilm-studio', async () => {
  const healthy = async () => ({ ok: true, json: async () => ({ product: 'orangefilm-studio', home: 'ab' }) });
  assert.equal((await probeStudio('http://127.0.0.1:4757/', { fetchImpl: healthy })).ok, true);

  const other = async () => ({ ok: true, json: async () => ({ product: 'vite' }) });
  const refused = await probeStudio('http://127.0.0.1:4757', { fetchImpl: other });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /不是 orangefilm-studio/);

  const down = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }); };
  assert.equal((await probeStudio('http://127.0.0.1:4757', { fetchImpl: down })).ok, false);
  assert.equal((await probeStudio('', { fetchImpl: healthy })).ok, false);
});

// ---------------------------------------------------------------------------
// 单元：窗口与索引
// ---------------------------------------------------------------------------
test('watchStudioOrigin：先没有 run.json，出现后靠 health 确认', async () => {
  const reads = [null, null, { origin: 'http://127.0.0.1:4757', filmOrigin: 'http://localhost:4758', pid: 5 }];
  let clock = 0;
  const result = await watchStudioOrigin({
    home: '/tmp/none', timeoutMs: 10_000, pollMs: 0, sleep: async () => {},
    now: () => (clock += 600),
    readRun: () => reads.shift() ?? null,
    probe: async (origin) => ({ ok: true, origin }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.origin, 'http://127.0.0.1:4757');
  assert.equal(result.filmOrigin, 'http://localhost:4758');
});

test('watchStudioOrigin：超时给可读原因', async () => {
  let clock = 0;
  const result = await watchStudioOrigin({
    home: '/tmp/none', timeoutMs: 1_000, pollMs: 0, sleep: async () => {},
    now: () => (clock += 600), readRun: () => null, probe: async () => ({ ok: false }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /1s 内没有等到/);
});

test('indexStatus 跑的是已提交的 bootstrap --status', async () => {
  const calls = [];
  const run = async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: 'absent\n', stderr: '' }; };
  await indexStatus({ root: 'D:/dev/orange', run });
  assert.match(calls[0].args[0], /material-index-bootstrap\.mjs$/);
  assert.deepEqual(calls[0].args.slice(1), ['--status']);
});

test('runVerify 解析 --json 的一行，并把 FAIL 项交出来', async () => {
  const report = { schema: 'verify/1', ok: false, checks: [{ id: '①', ok: true, detail: 'ok' }, { id: '②', ok: false, detail: 'boom' }], notes: [] };
  const run = async (command, args) => ({ code: 1, stdout: `${JSON.stringify(report)}\n`, stderr: 'FAIL ②: boom\n' });
  const result = await runVerify({ root: 'D:/dev/orange', run });
  assert.equal(result.code, 1);
  assert.equal(result.report.ok, false);
  assert.deepEqual(result.failed.map((f) => f.id), ['②']);
});
