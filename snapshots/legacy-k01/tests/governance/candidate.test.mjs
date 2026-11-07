import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  g2DotnetEnvironment, g2ReportRunner, verifyG2Control, verifyG2Execution, verifyG2Lease, verifyG2Outputs, verifyG2Tap, verifyG2Trx,
  materializeG3Database, readG3NativeLock, readG3Report, runG3OSV, verifyG3Control, verifyG3OSVReport, verifyG3Tool,
} from '../../tools/ci/check-candidate.mjs';
import { readTree, runRendererGraph } from '../../tools/ci/check-imports.mjs';

const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'orange-gate-test-'));
after(() => {
  assert.equal(realpathSync.native(root), root);
  rmSync(root, { recursive: true, force: true });
});
const repo = path.join(root, 'repo');
const tree = path.join(root, 'candidate');
const cardPath = path.join(root, 'card.json');
const indexPath = path.join(root, 'index.json');
const gate = fileURLToPath(new URL('../../tools/ci/check-candidate.mjs', import.meta.url));
const g4Module = new URL('../../tools/ci/check-candidate.mjs', import.meta.url);

const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=Gate Test Fixture', '-c', 'user.email=gate-test@example.invalid',
  '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', '-C', cwd, ...args,
], { encoding: 'utf8', windowsHide: true }).trim();
function save(cwd, relative, text) {
  const file = path.join(cwd, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function commit(...args) {
  git(tree, 'add', '--', ...args);
  git(tree, 'commit', '-qm', 'candidate fixture');
  return git(tree, 'rev-parse', 'HEAD');
}
mkdirSync(repo);
git(repo, 'init', '-q');
save(repo, 'seed.txt', 'base\n');
save(repo, '.gitignore', 'ignored/\n');
git(repo, 'add', '--', 'seed.txt', '.gitignore');
git(repo, 'commit', '-qm', 'base fixture');
const base = git(repo, 'rev-parse', 'HEAD');
git(repo, 'worktree', 'add', '-qb', 'candidate-fixture', tree, base);
save(tree, 'allowed/first.txt', 'first\n');
const first = commit('allowed/first.txt');
save(tree, 'allowed/second.txt', 'second\n');
const head = commit('allowed/second.txt');

const approved = {
  taskId: 'T01.fixture',
  assignmentRevision: 2,
  baselineCommit: base,
  workingBaselineCommit: base,
  headCommit: head,
  worktree: tree,
  branch: 'candidate-fixture',
  writeSet: ['allowed/first.txt', 'allowed/second.txt'],
  dependencies: [],
  contracts: [],
  resources: [],
};
function run(card = approved, options = {}) {
  writeFileSync(cardPath, JSON.stringify(card));
  writeFileSync(indexPath, JSON.stringify({
    schemaVersion: 1,
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    cards: [options.approval ?? approved],
    ...options.index,
  }));
  const result = spawnSync(process.execPath, [
    gate, '--base', options.base ?? base, '--head', options.head ?? head, '--card', cardPath,
    ...(options.compiler ? ['--trusted-typescript', options.compiler] : []),
    ...(options.graph ?? []),
    ...(options.g2 ? ['--trusted-g2-plan', options.g2] : []),
    ...(options.g3 ? ['--trusted-g3-plan', options.g3] : []),
    ...(options.review ? ['--trusted-review', options.review] : []),
  ], { cwd: tree, encoding: 'utf8', windowsHide: true });
  assert.ok(result.stdout, 'candidate gate must report a decision: ' + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 1, 'no fixture is eligible for integration');
  assert.equal(report.admitted, false);
  return report;
}
function approvalFor(card) {
  return { approval: card, head: card.headCommit, base: card.workingBaselineCommit };
}

test('G2 refuses unregistered external plans, and never treats a plan as reported evidence', () => {
  const g2 = path.join(root, 'g2-plan.json');
  const data = JSON.stringify({ command: 'forged', formatTypes: 'passed', windows: 'passed', contracts: 'passed' });
  writeFileSync(g2, data);
  const g2PlanSha256 = createHash('sha256').update(data).digest('hex');
  assert.equal(run(approved, { g2 }).code, 'G2_PLAN_UNTRUSTED');
  assert.equal(run(approved, { g2, index: { g2PlanSha256: '0'.repeat(64) } }).code, 'G2_PLAN_UNTRUSTED');
  const result = run(approved, { g2, index: { g2PlanSha256 } });
  assert.equal(result.code, 'G2_PLAN_INVALID');
  assert.equal(result.checks.find(({ id }) => id === 'windows').exitCode, null);
});

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function g4Fixture(name, mutate = () => {}, mutatePin = () => {}) {
  const review = path.join(root, name + '-review.json');
  const evidencePath = path.join(root, name + '-evidence.md');
  const evidence = 'Separate fixture specs and quality decisions.\n';
  writeFileSync(evidencePath, evidence);
  const subject = { taskId: approved.taskId, assignmentRevision: approved.assignmentRevision, branch: approved.branch, base, head,
    tree: git(tree, 'rev-parse', 'HEAD^{tree}'), scopeKind: 'integration',
    scopeSha256: hash(JSON.stringify(['integration', [...approved.writeSet].sort(), [...approved.writeSet].sort()])),
    inputsSha256: hash('fixture only') };
  const record = { schemaVersion: 1, subject, reviewerId: '/root/reviewer', specs: 'approved',
    quality: 'approved', evidenceSha256: hash(evidence) };
  mutate(record);
  const bytes = JSON.stringify(record);
  writeFileSync(review, bytes);
  const reviewApproval = { sha256: hash(bytes), scopeKind: 'integration', reviewerId: '/root/reviewer',
    authors: ['/root/author', '/root/integrator'], evidencePath, evidenceSha256: hash(evidence) };
  mutatePin(reviewApproval);
  return { review, index: { reviewApproval }, evidencePath, subject };
}

test('G4 actual candidate refuses unpinned, pending, stale, drifting and author review records', () => {
  const valid = g4Fixture('g4-valid');
  assert.equal(run(approved, { review: valid.review }).code, 'G4_REVIEW_UNTRUSTED');
  assert.equal(run(approved, valid).code, 'REQUIRED_CHECK_UNAVAILABLE');
  const negatives = [
    ['pending', (r) => { r.quality = 'pending'; }, null, 'G4_REVIEW_NOT_APPROVED'],
    ['missing-specs', (r) => { delete r.specs; }, null, 'G4_REVIEW_INVALID'],
    ['same-tree-other-head', (r) => { r.subject.head = git(tree, 'commit-tree', r.subject.tree, '-m', 'other head'); }, null, 'G4_REVIEW_STALE'],
    ['revision', (r) => { r.subject.assignmentRevision++; }, null, 'G4_REVIEW_STALE'],
    ['other-ref', (r) => { r.subject.branch = 'different-review-ref'; }, null, 'G4_REVIEW_STALE'],
    ['scope', (r) => { r.subject.scopeSha256 = hash('other scope'); }, null, 'G4_REVIEW_STALE'],
    ['base', (r) => { r.subject.base = first; }, null, 'G4_REVIEW_STALE'],
    ['author', null, (pin) => { pin.authors.push('/root/reviewer'); }, 'G4_REVIEW_IDENTITY'],
    ['role', (r) => { r.reviewerId = '/root/author'; }, null, 'G4_REVIEW_IDENTITY'],
    ['evidence', (r) => { r.evidenceSha256 = hash('other evidence'); }, null, 'G4_REVIEW_EVIDENCE'],
    ['arbitrary-command', (r) => { r.command = 'echo approved'; }, null, 'G4_REVIEW_INVALID'],
  ];
  for (const [name, mutation, pinMutation, code] of negatives) {
    assert.equal(run(approved, g4Fixture(name, mutation ?? undefined, pinMutation ?? undefined)).code, code, name);
  }
  writeFileSync(valid.evidencePath, 'mutated after review');
  assert.equal(run(approved, valid).code, 'G4_REVIEW_EVIDENCE');
});

test('G4 typed success predicate requires exact current review inputs and every technical check', async () => {
  const { g4DecideCandidate } = await import(g4Module);
  const ids = ['write-set', 'imports', 'format-types', 'dependency-audit', 'secret-scan',
    'import-build-graph', 'windows', 'contracts', 'independent-review'];
  const checks = ids.map((id) => ({ id, exitCode: 0, status: 'passed' }));
  const inputs = hash('current inputs');
  assert.equal(g4DecideCandidate(checks, inputs, inputs), true);
  assert.equal(g4DecideCandidate(checks, inputs, hash('other inputs')), false);
  assert.equal(g4DecideCandidate(checks.slice(1), inputs, inputs), false);
  assert.equal(g4DecideCandidate([...checks.slice(0, -1), checks[0]], inputs, inputs), false);
  assert.equal(g4DecideCandidate(checks.map((c) => c.id === 'windows' ? { ...c, status: 'unavailable' } : c), inputs, inputs), false);
  assert.equal(g4DecideCandidate(checks, undefined, undefined), false);
});
test('G3 requires the current protected pin and refuses reported green or arbitrary scanner arguments', () => {
  const g3 = path.join(root, 'g3-plan.json');
  const forged = JSON.stringify({ admitted: true, secretScan: 'passed', dependencyAudit: 'passed', command: 'echo forged' });
  writeFileSync(g3, forged);
  assert.equal(run(approved, { g3 }).code, 'G3_PLAN_UNTRUSTED');
  const report = run(approved, { g3, index: { g3PlanSha256: hash(forged) } });
  assert.equal(report.code, 'G3_PLAN_INVALID');
  assert.equal(report.checks.find(({ id }) => id === 'dependency-audit').exitCode, null);
});

const g3Tooling = process.env.ORANGE_TEST_G3_TOOLING;
const g3ToolRefs = (directory) => ({
  gitleaks: { path: path.join(directory, 'gitleaks.exe'), sha256: '17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c' },
  osv: { path: path.join(directory, 'osv-scanner_windows_amd64.exe'), sha256: '9964ed64ec9a387391eb4cc006ad5c531154821aef29b793e02c448de4686438' },
});
const g3DatabaseRef = (directory) => ({
  path: path.join(directory, 'database-manifest.json'), sha256: 'a08114a4143f6de37691b7e983f4b80ca09d658e3c4889f6c48088d7669b3dfd',
  cacheRoot: path.join(directory, 'db'),
});
function g3FixturePlan(card, output, directory) {
  return {
    schemaVersion: 1, taskId: card.taskId, assignmentRevision: card.assignmentRevision,
    base: card.workingBaselineCommit, head: card.headCommit, tree: git(repo, 'rev-parse', card.headCommit + '^{tree}'),
    validUntil: new Date(Date.now() + 120_000).toISOString(), outputRoot: output,
    tools: g3ToolRefs(directory), database: g3DatabaseRef(directory),
    pnpmInventory: { path: path.join(root, 'unused-inventory.json'), sha256: '1'.repeat(64) },
  };
}
function g3Run(plan, card = approved) {
  const g3 = path.join(root, 'g3-plan.json');
  const bytes = JSON.stringify(plan);
  writeFileSync(g3, bytes);
  return run(card, { ...approvalFor(card), g3, index: {
    g3PlanSha256: hash(bytes), validUntil: new Date(Date.now() + 180_000).toISOString(),
  } });
}
test('G3 rejects stale tree and plan, unsafe output, and a changed tool before it can run', () => {
  const output = mkdtempSync(path.join(root, 'g3-output-'));
  const fake = path.join(root, 'g3-untrusted-tools');
  save(fake, 'gitleaks.exe', 'this is not the pinned executable');
  const plan = g3FixturePlan(approved, output, fake);
  assert.equal(g3Run({ ...plan, tree: '2'.repeat(40) }).code, 'G3_PLAN_STALE');
  assert.equal(g3Run({ ...plan, validUntil: '2000-01-01T00:00:00.000Z' }).code, 'G3_PLAN_EXPIRED');
  assert.equal(g3Run({ ...plan, outputRoot: tree }).code, 'G3_OUTPUT_UNSAFE');
  assert.equal(g3Run(plan).code, 'G3_TOOL_UNTRUSTED');
  assert.deepEqual(readdirSync(output), []);
});

test('G3 protected control fails on plan raw bytes and live index revocation', () => {
  const output = mkdtempSync(path.join(root, 'g3-output-'));
  const control = mkdtempSync(path.join(root, 'g3-controls-'));
  const plan = g3FixturePlan(approved, output, root);
  const bytes = JSON.stringify(plan);
  const index = { schemaVersion: 1, validUntil: plan.validUntil, cards: [approved], g3PlanSha256: hash(bytes) };
  for (const [name, value] of [['card.json', JSON.stringify(approved)], ['index.json', JSON.stringify(index)], ['plan.json', bytes]]) {
    writeFileSync(path.join(control, name), value);
  }
  const context = { planFile: path.join(control, 'plan.json'), cardFile: path.join(control, 'card.json'),
    indexFile: path.join(control, 'index.json'), card: approved, index, protectedRoots: [tree, output] };
  assert.ok(verifyG3Control(context) > 0);
  writeFileSync(context.planFile, bytes + '\n');
  assert.throws(() => verifyG3Control(context), { gateCode: 'G3_CONTROL_CHANGED' });
  writeFileSync(context.planFile, bytes);
  writeFileSync(context.indexFile, JSON.stringify({ ...index, g3PlanSha256: undefined }));
  assert.throws(() => verifyG3Control(context), { gateCode: 'G3_CONTROL_CHANGED' });
});

test('G3 native report rejects absent, malformed and stale files', () => {
  const file = path.join(root, 'g3-native-report.json');
  const started = Date.now();
  const time = { started, ended: started + 10_000 };
  assert.throws(() => readG3Report(file, time), { gateCode: 'G3_REPORT_INVALID' });
  writeFileSync(file, '[[');
  assert.throws(() => readG3Report(file, time), { gateCode: 'G3_REPORT_INVALID' });
  writeFileSync(file, '[]\n');
  assert.deepEqual(readG3Report(file, time), { native: [], reportSha256: hash('[]\n') });
  const old = new Date(started - 60_000);
  utimesSync(file, old, old);
  assert.throws(() => readG3Report(file, time), { gateCode: 'G3_REPORT_INVALID' });
});

test('G3 OSV rejects complete-looking no-DB exit 127, wrong identity/source, duplicates and reported skips', () => {
  const file = path.join(root, 'package-lock.json');
  const locks = [{ file, ecosystem: 'npm', packages: [{ name: 'fixture', version: '1.2.3' }] }];
  const source = { path: file.split(path.sep).join('/'), type: 'lockfile' };
  const row = { package: { ecosystem: 'npm', name: 'fixture', version: '1.2.3', purl: 'pkg:npm/fixture@1.2.3' } };
  const report = { results: [{ source, packages: [row] }], experimental_config: {} };
  assert.equal(verifyG3OSVReport(report, locks, 0).sources[0].count, 1);
  assert.throws(() => verifyG3OSVReport(report, locks, 127), { gateCode: 'G3_OSV_INVALID' });
  for (const candidate of [
    { ...report, warnings: ['some extract skipped'] },
    { ...report, results: [{ source, packages: [row, row] }] },
    { ...report, results: [{ source: { ...source, path: path.join(root, 'wrong', 'package-lock.json') }, packages: [row] }] },
    { ...report, results: [{ source, packages: [{ package: { ...row.package, version: '1.2.4' } }] }] },
  ]) assert.throws(() => verifyG3OSVReport(candidate, locks, 0), { gateCode: 'G3_OSV_INVALID' });
});

test('G3 native dependency handoff binds same-run G2, project, exact lock location and bytes', () => {
  const exec = path.join(root, 'g3-execution-fixture');
  const out = mkdtempSync(path.join(root, 'g3-native-lock-'));
  const project = path.join(exec, 'tests/contracts/dotnet/Orange.Contracts.Tests.csproj');
  const file = path.join(out, 'packages.lock.json');
  const packages = Object.fromEntries(Array.from({ length: 13 }, (_, n) => ['Fixture.' + n,
    { type: 'Direct', resolved: '1.2.3', contentHash: Buffer.alloc(64).toString('base64') }]));
  const bytes = JSON.stringify({ version: 1, dependencies: { 'net10.0': packages } });
  writeFileSync(file, bytes);
  const binding = { base, head, tree: git(repo, 'rev-parse', head + '^{tree}'), assignmentRevision: approved.assignmentRevision };
  const g2 = { ...binding, outputRoot: out, executionRoot: exec, contracts: { pack: 'K07',
    restoreLock: { file, sha256: hash(bytes), packages: 13 } }, commands: [
    { id: 'contracts-dotnet-restore', exitCode: 0, args: ['restore', project, '-p:NuGetLockFilePath=' + file] },
    { id: 'contracts-dotnet-test', exitCode: 0, args: ['test', project, '--filter', 'Pack=K07'] },
  ] };
  assert.equal(readG3NativeLock(g2, binding).packages.length, 13);
  assert.throws(() => readG3NativeLock(undefined, binding), { gateCode: 'G3_NUGET_HANDOFF' });
  assert.throws(() => readG3NativeLock({ ...g2, head: base }, binding), { gateCode: 'G3_NUGET_HANDOFF' });
  assert.throws(() => readG3NativeLock({ ...g2, commands: [] }, binding), { gateCode: 'G3_NUGET_HANDOFF' });
  writeFileSync(file, bytes + '\n');
  assert.throws(() => readG3NativeLock(g2, binding), { gateCode: 'G3_NUGET_HANDOFF' });
});

test('G3 live direct-file scanner covers clean tracked blobs and defeats a matching tracked ignore',
  { skip: !g3Tooling && 'requires the approved offline G3 scanner bundle' }, (t) => {
    const output = mkdtempSync(path.join(root, 'g3-secret-positive-'));
    const clean = g3Run(g3FixturePlan(approved, output, g3Tooling));
    assert.equal(clean.code, 'REQUIRED_CHECK_UNAVAILABLE');
    assert.equal(clean.checks.find(({ id }) => id === 'secret-scan').exitCode, 0);
    assert.equal(clean.checks.find(({ id }) => id === 'dependency-audit').exitCode, null);
    assert.equal(clean.g3.secret.files, 4);
    assert.equal(clean.g3.secret.unscanned, 0);
    assert.equal(clean.g3.secret.receipts.length, 4);
    assert.ok(clean.g3.secret.receipts.every((item) => item.findings.length === 0
      && item.scans.length === 2 && item.scans.every((scan) => scan.exitCode === 0
        && scan.findings.length === 0 && scan.reportSha256 && scan.inputSha256 === item.sha256)));
    assert.equal(existsSync(path.join(output, 'snapshot')), false);
    t.diagnostic(JSON.stringify({ phase: 'clean-direct', files: clean.g3.secret.files,
      receipts: clean.g3.secret.receipts.map(({ path, scans }) => ({ path,
        reports: scans.map(({ mode, reportSha256 }) => ({ mode, reportSha256 })) })) }));

    const challenged = mkdtempSync(path.join(root, 'g3-secret-negative-'));
    const name = '.hidden/sample.txt';
    const snapshot = path.join(challenged, 'snapshot');
    const absolute = path.join(snapshot, name).split(path.sep).join('/');
    const token = 'gh' + 'p_' + createHash('sha256').update('scanner fixture only; not a credential')
      .digest('base64').replace(/[+/=]/g, 'Z').slice(0, 36);
    const tracked = ['.gitleaksignore', '.gitleaks.toml', name];
    try {
      save(tree, tracked[0], absolute + ':github-pat:1\n');
      save(tree, tracked[1], 'invalid candidate TOML, never executed\n');
      save(tree, name, token + ' # gitleaks:allow\n');
      const fixtureHead = commit(...tracked);
      const card = { ...approved, headCommit: fixtureHead, writeSet: [...approved.writeSet, ...tracked] };
      const plan = g3FixturePlan(card, challenged, g3Tooling);
      const result = g3Run(plan, card);
      assert.equal(result.code, 'G3_SECRET_FOUND');
      assert.ok(result.g3.secret.unscanned > 0);
      assert.deepEqual(result.g3.secret.receipts.at(-1).findings, [{ path: name, rule: 'github-pat', line: 1 }]);
      assert.deepEqual(result.g3.secret.receipts.at(-1).scans.map(({ mode, exitCode }) => [mode, exitCode]), [
        ['original-path', 1], ['neutral-content', 1],
      ]);
      assert.equal(JSON.stringify(result).includes(token), false);
      assert.equal(readdirSync(challenged).some((file) => /^gitleaks-\d+-(?:path|content)\.json$/.test(file)), false);
      assert.equal(existsSync(path.join(challenged, 'g3-content.txt')), false);
      assert.equal(existsSync(snapshot), false);
      t.diagnostic(JSON.stringify({ phase: 'matching-ignore-direct', code: result.code,
        receipt: result.g3.secret.receipts.at(-1), unscanned: result.g3.secret.unscanned }));

      // Contrast only: this exact fixture's canonical fingerprint defeats directory mode.
      const tool = verifyG3Tool('gitleaks', plan.tools.gitleaks, [tree, challenged]);
      const control = path.join(challenged, 'test-only-directory-result.json');
      const windows = realpathSync.native('C:/Windows');
      const contrast = path.join(challenged, 'directory-contrast');
      save(contrast, tracked[0], path.join(contrast, name).split(path.sep).join('/') + ':github-pat:1\n');
      save(contrast, tracked[1], 'invalid candidate TOML, never executed\n');
      save(contrast, name, token + ' # gitleaks:allow\n');
      const dir = spawnSync(tool, ['dir', contrast, '--config', path.join(challenged, 'gitleaks.toml'),
        '--gitleaks-ignore-path', path.join(challenged, 'empty-ignore'), '--ignore-gitleaks-allow', '--redact=100',
        '--no-banner', '--no-color', '--log-level', 'error', '--report-format', 'json', '--report-path', control],
      { cwd: challenged, env: { SystemRoot: windows, WINDIR: windows }, windowsHide: true, timeout: 15_000 });
      assert.equal(dir.status, 0);
      assert.deepEqual(JSON.parse(readFileSync(control, 'utf8')), []);
      t.diagnostic(JSON.stringify({ phase: 'matching-ignore-directory-contrast', exitCode: 0, findings: 0 }));

      const unsupported = 'archive.zip';
      save(tree, unsupported, Buffer.from([0, 255, 1, 2]));
      const binaryHead = commit(unsupported);
      const binaryCard = { ...card, headCommit: binaryHead, writeSet: [...card.writeSet, unsupported] };
      const binaryOutput = mkdtempSync(path.join(root, 'g3-secret-binary-'));
      assert.equal(g3Run(g3FixturePlan(binaryCard, binaryOutput, g3Tooling), binaryCard).code, 'G3_SCOPE_UNSUPPORTED');
      assert.equal(existsSync(path.join(binaryOutput, 'snapshot')), false);
    } finally {
      git(tree, 'checkout', '-q', head);
      git(tree, 'branch', '-f', 'candidate-fixture', head);
      git(tree, 'checkout', '-q', 'candidate-fixture');
    }
  });

test('G3 live offline OSV proves exact dual-lock clean inputs and flags known lodash, never the missing cache',
  { skip: !g3Tooling && 'requires the approved offline G3 scanner and databases' }, (t) => {
    const output = mkdtempSync(path.join(root, 'g3-osv-'));
    const db = path.join(output, 'db');
    const bad = path.join(output, 'legacy-layout');
    mkdirSync(path.join(bad, 'osv-scanner', 'npm'), { recursive: true });
    const ref = g3DatabaseRef(g3Tooling);
    assert.throws(() => materializeG3Database({ ...ref, sha256: '1'.repeat(64) }, db, [output]),
      { gateCode: 'G3_DATABASE_UNTRUSTED' });
    // A legacy/missing donor fails before starting an OSV process.
    assert.throws(() => materializeG3Database({ ...ref, cacheRoot: bad }, db, []), { gateCode: 'G3_DATABASE_UNTRUSTED' });
    const database = materializeG3Database(ref, db, [tree, output]);
    assert.deepEqual(database.archives.map(({ ecosystem }) => ecosystem), ['npm', 'NuGet']);
    const tool = verifyG3Tool('osv', g3ToolRefs(g3Tooling).osv, [tree, output]);
    const config = path.join(output, 'osv.toml');
    writeFileSync(config, '');
    const windows = realpathSync.native('C:/Windows');
    const env = { SystemRoot: windows, WINDIR: windows, TEMP: output, TMP: output, HOME: output, USERPROFILE: output };
    function npm(name, version) {
      const file = path.join(output, 'package-lock.json');
      writeFileSync(file, JSON.stringify({ name: 'g3-synthetic', version: '1.0.0', lockfileVersion: 3,
        packages: { '': { name: 'g3-synthetic', version: '1.0.0', dependencies: { [name]: version } },
          ['node_modules/' + name]: { version, resolved: 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + version + '.tgz' } } }));
      return { file, ecosystem: 'npm', packages: [{ name, version }] };
    }
    const nuget = path.join(output, 'packages.lock.json');
    writeFileSync(nuget, JSON.stringify({ version: 1, dependencies: { 'net10.0': {
      xunit: { type: 'Direct', requested: '[2.9.3, )', resolved: '2.9.3', contentHash: Buffer.alloc(64).toString('base64') },
    } } }));
    let checks = 0;
    const call = (locks, name, cache = db) => runG3OSV({ tool, locks, config, cwd: output, env, db: cache,
      checkControl: () => { checks++; return 120_000; }, file: path.join(output, name + '.json') });
    const clean = call([npm('is-number', '7.0.0'), { file: nuget, ecosystem: 'NuGet',
      packages: [{ name: 'xunit', version: '2.9.3' }] }], 'clean');
    assert.equal(clean.exitCode, 0);
    assert.deepEqual(clean.sources.map(({ count }) => count), [1, 1]);
    assert.equal(checks, 2);
    t.diagnostic(JSON.stringify({ phase: 'offline-clean', exitCode: clean.exitCode, sources: clean.sources, reportSha256: clean.reportSha256 }));
    const vulnerable = npm('lodash', '4.17.20');
    const rejected = call([vulnerable], 'vulnerable');
    assert.equal(rejected.exitCode, 1);
    assert.deepEqual(rejected.findings.map(({ id }) => id).sort(), [
      'GHSA-29mw-wpgm-hmr9', 'GHSA-35jh-r3h4-6jhm', 'GHSA-r5fr-rjxr-66jc', 'GHSA-xxjr-mmjv-4gpg',
    ]);
    t.diagnostic(JSON.stringify({ phase: 'offline-known-vulnerable', exitCode: rejected.exitCode,
      findings: rejected.findings, reportSha256: rejected.reportSha256 }));
    assert.throws(() => call([vulnerable], 'missing', bad), { gateCode: 'G3_SCANNER_FAILED', scannerExitCode: 127 });
    t.diagnostic(JSON.stringify({ phase: 'offline-missing-db', exitCode: 127, gateCode: 'G3_SCANNER_FAILED' }));
    assert.ok(['clean', 'vulnerable', 'missing'].every((name) => !existsSync(path.join(output, name + '.json'))));
  });

test('G3 live identical content is not hidden by a scanner-default SVG or pnpm lock path exemption',
  { skip: !g3Tooling && 'requires the approved offline G3 scanner bundle' }, (t) => {
    const token = 'gh' + 'p_' + createHash('sha256').update('deterministic independent G3 fixture synthetic only')
      .digest('base64url').replaceAll('-', 'a').replaceAll('_', 'Z').slice(0, 36);
    const payload = '<!-- fixture ' + token + ' -->\n';
    const payloadSha256 = hash(payload);
    for (const [name, originalExit] of [['docs/icon.svg', 0], ['pnpm-lock.yaml', 0], ['docs/control.txt', 1]]) {
      const output = mkdtempSync(path.join(root, 'g3-default-path-'));
      try {
        save(tree, name, payload);
        const fixtureHead = commit(name);
        const card = { ...approved, headCommit: fixtureHead, writeSet: [...approved.writeSet, name] };
        const result = g3Run(g3FixturePlan(card, output, g3Tooling), card);
        assert.equal(result.code, 'G3_SECRET_FOUND', name);
        const receipt = result.g3.secret.receipts.find((item) => item.path === name);
        assert.equal(receipt.sha256, payloadSha256);
        assert.deepEqual(receipt.findings, [{ path: name, rule: 'github-pat', line: 1 }]);
        assert.deepEqual(receipt.scans.map(({ mode, inputSha256, exitCode }) => [mode, inputSha256, exitCode]), [
          ['original-path', payloadSha256, originalExit], ['neutral-content', payloadSha256, 1],
        ]);
        assert.ok(receipt.scans.every(({ reportSha256 }) => /^[0-9a-f]{64}$/.test(reportSha256)));
        assert.equal(JSON.stringify(result).includes(token), false);
        assert.equal(existsSync(path.join(output, 'snapshot')), false);
        assert.equal(existsSync(path.join(output, 'g3-content.txt')), false);
        t.diagnostic(JSON.stringify({ path: name, payloadSha256, scans: receipt.scans, unscanned: result.g3.secret.unscanned }));
      } finally {
        git(tree, 'checkout', '-q', head);
        git(tree, 'branch', '-f', 'candidate-fixture', head);
        git(tree, 'checkout', '-q', 'candidate-fixture');
      }
    }
  });
function g2FixturePlan(executionRoot, card = approved) {
  const outputRoot = mkdtempSync(path.join(root, 'g2-out-'));
  const invalid = { path: path.join(root, 'missing-tool-or-input'), sha256: '1'.repeat(64) };
  return {
    schemaVersion: 1, taskId: card.taskId, assignmentRevision: card.assignmentRevision,
    base: card.workingBaselineCommit, head: card.headCommit, tree: git(repo, 'rev-parse', card.headCommit + '^{tree}'),
    executionRoot, outputRoot, validUntil: new Date(Date.now() + 220_000).toISOString(),
    desktopLease: { id: 'fixture-desktop', holder: card.taskId, validUntil: new Date(Date.now() + 210_000).toISOString() },
    executableInputs: invalid, installedPackages: { ...invalid, sourceRoot: path.join(root, 'unused') },
    nugetFeed: { path: path.join(root, 'unused'), files: [] },
    tools: Object.fromEntries(['node', 'git', 'dotnet', 'csc', 'cmd', 'taskkill'].map((role) => [role, invalid])),
  };
}
function g2Run(plan, card = approved) {
  const g2 = path.join(root, 'g2-plan.json');
  const bytes = JSON.stringify(plan);
  writeFileSync(g2, bytes);
  return run(card, { ...approvalFor(card), g2, index: {
    g2PlanSha256: hash(bytes), validUntil: new Date(Date.now() + 240_000).toISOString(),
  } });
}
test('G2 binds the exact plan and rejects source, stale and dirty execution checkouts', () => {
  const execution = path.join(root, 'g2-detached');
  git(repo, 'worktree', 'add', '-q', '--detach', execution, head);
  const plan = g2FixturePlan(execution);
  const common = realpathSync.native(path.join(repo, '.git'));
  assert.equal(verifyG2Execution(execution, tree, common, head, plan.tree), execution);
  assert.equal(g2Run({ ...plan, executionRoot: tree }).code, 'G2_EXECUTION_MISMATCH');
  assert.equal(g2Run({ ...plan, outputRoot: execution }).code, 'G2_OUTPUT_UNSAFE');
  assert.equal(g2Run({ ...plan, tree: '2'.repeat(40) }).code, 'G2_PLAN_STALE');
  assert.equal(g2Run({ ...plan, assignmentRevision: approved.assignmentRevision - 1 }).code, 'G2_PLAN_STALE');
  assert.equal(g2Run({ ...plan, validUntil: '2000-01-01T00:00:00.000Z' }).code, 'G2_PLAN_EXPIRED');
  const other = path.join(root, 'g2-other');
  mkdirSync(other);
  git(other, 'init', '-q');
  const foreign = path.join(root, 'g2-foreign');
  git(other, 'fetch', '-q', repo, head);
  git(other, 'worktree', 'add', '-q', '--detach', foreign, head);
  assert.equal(g2Run({ ...plan, executionRoot: foreign }).code, 'G2_EXECUTION_MISMATCH');
  save(execution, 'ignored/extra.txt', 'ignored but not clean');
  assert.equal(g2Run(plan).code, 'WORKTREE_DIRTY');
  unlinkSync(path.join(execution, 'ignored/extra.txt'));
  rmdirSync(path.join(execution, 'ignored'));
  assert.equal(g2Run(plan).code, 'G2_INPUT_UNTRUSTED');
});

test('G2 rejects changed executable inputs, host bytes and unsolicited candidate config before launching any commands', () => {
  const execution = path.join(root, 'g2-input-fixture');
  const names = [
    'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json',
    ...['package.json', 'tsconfig.json', 'vite.config.ts', 'main/index.ts', 'preload/index.ts',
      'renderer/index.html', 'renderer/main.tsx', 'renderer/App.tsx'].map((name) => 'apps/desktop/' + name),
    ...['package.json', 'freeze-registry.json', 'schemas/K07/v1.schema.json', 'src/validate.ts',
      'generated/ts/K07.ts', 'generated/dotnet/K07.g.cs'].map((name) => 'packages/contracts/' + name),
    ...['fixtures/K07/cases.json', 'ts/contracts.test.ts', 'dotnet/Orange.Contracts.Tests.csproj',
      'dotnet/ContractCases.cs'].map((name) => 'tests/contracts/' + name),
    'tests/windows/shell-smoke.test.mjs', 'tools/contracts/generate.mjs',
  ];
  const entries = names.map((name) => {
    const bytes = name.endsWith('/cases.json') ? JSON.stringify({ pack: 'K07', slice: 'K07.desktop-startup.v1',
      cases: Array.from({ length: 114 }, (_, index) => ({ id: 'fixture-' + index, kind: 'object' })) }) : '\n';
    save(tree, name, bytes);
    return { path: name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) };
  });
  try {
    const newHead = commit(...names);
    const card = { ...approved, headCommit: newHead, writeSet: [...approved.writeSet, ...names] };
    git(repo, 'worktree', 'add', '-q', '--detach', execution, newHead);
    const input = path.join(root, 'g2-inputs.json');
    const node = path.join(root, 'node.exe');
    writeFileSync(node, 'not an executable');
    const plan = g2FixturePlan(execution, card);
    plan.tools.node = { path: node, sha256: hash('different node bytes') };
    const manifest = (candidate, entries) => {
      const bytes = JSON.stringify({ type: 'controller-reviewed-G2-executable-inputs', schemaVersion: 1,
        approvedSource: head, candidate, entries });
      writeFileSync(input, bytes);
      return { path: input, sha256: hash(bytes) };
    };
    const check = (plan, card, code) => {
      const report = g2Run(plan, card);
      assert.equal(report.code, code);
      assert.deepEqual(report.g2.commands, []);
    };
    const modified = [{ ...entries[0], sha256: hash('incorrect bytes') }, ...entries.slice(1)];
    check({ ...plan, executableInputs: manifest(newHead, modified) }, card, 'G2_INPUT_MISMATCH');
    check({ ...plan, executableInputs: manifest(newHead, entries) }, card, 'G2_TOOL_UNTRUSTED');
    save(root, 'Directory.Build.targets', '<Project/>');
    try {
      check({ ...plan, executableInputs: manifest(newHead, entries) }, card, 'G2_ANCESTOR_CONFIG');
    } finally {
      unlinkSync(path.join(root, 'Directory.Build.targets'));
    }
    const extra = 'apps/desktop/.env.renderer';
    save(tree, extra, 'UNAPPROVED=1\n');
    const configHead = commit(extra);
    git(execution, 'checkout', '-q', '--detach', configHead);
    const configCard = { ...card, headCommit: configHead, writeSet: [...card.writeSet, extra] };
    const configPlan = g2FixturePlan(execution, configCard);
    check({ ...configPlan, executableInputs: manifest(configHead, entries) }, configCard, 'G2_INPUT_UNREVIEWED');
  } finally {
    git(tree, 'checkout', '-q', head);
    git(tree, 'branch', '-f', 'candidate-fixture', head);
    git(tree, 'checkout', '-q', 'candidate-fixture');
  }
});

test('G2 checks desktop lease expiry, revocation, case-alias conflict and exact holder', () => {
  const plan = g2FixturePlan(path.join(root, 'unused-execution'));
  const lease = { kind: 'desktop', id: plan.desktopLease.id, holder: approved.taskId };
  const index = { resourceLeases: [lease], cards: [approved] };
  assert.doesNotThrow(() => verifyG2Lease(plan, index));
  for (const resourceLeases of [[], [{ ...lease, holder: 'another' }], [lease, { ...lease, id: lease.id.toUpperCase() }],
    [lease, { ...lease, id: 'another-label-for-desktop' }]]) {
    assert.throws(() => verifyG2Lease(plan, { ...index, resourceLeases }), { gateCode: 'G2_LEASE_UNAVAILABLE' });
  }
  assert.throws(() => verifyG2Lease(plan, { ...index, cards: [...index.cards,
    { taskId: 'other', resources: [{ kind: 'desktop', id: lease.id.toUpperCase() }] }] }), { gateCode: 'G2_LEASE_UNAVAILABLE' });
  assert.throws(() => verifyG2Lease({ ...plan, desktopLease: { ...plan.desktopLease, validUntil: '2000-01-01T00:00:00.000Z' } },
    index), { gateCode: 'G2_LEASE_EXPIRED' });
});

test('G2 rechecks protected control on both sides of each real subprocess, before any next spawn', () => {
  const output = mkdtempSync(path.join(root, 'g2-commands-'));
  const control = mkdtempSync(path.join(root, 'g2-control-'));
  const planFile = path.join(control, 'plan.json');
  const cardFile = path.join(control, 'card.json');
  const indexFile = path.join(control, 'index.json');
  const plan = g2FixturePlan(path.join(root, 'unused-execution'));
  const planBytes = JSON.stringify(plan);
  const lease = { kind: 'desktop', id: plan.desktopLease.id, holder: approved.taskId };
  const index = { schemaVersion: 1, validUntil: plan.validUntil, cards: [approved],
    g2PlanSha256: hash(planBytes), resourceLeases: [lease] };
  const controls = { planFile, cardFile, indexFile, card: approved, index, protectedRoots: [tree, output] };
  const changes = [
    ['pin', indexFile, JSON.stringify({ ...index, g2PlanSha256: undefined }), 'G2_CONTROL_CHANGED', false],
    ['card', cardFile, JSON.stringify({ ...approved, assignmentRevision: approved.assignmentRevision + 1 }), 'CARD_STALE', false],
    ['plan-bytes', planFile, planBytes + '\n', 'G2_CONTROL_CHANGED', false],
    ['lease', indexFile, JSON.stringify({ ...index, resourceLeases: [] }), 'G2_CONTROL_CHANGED', true],
  ];
  for (const [label, file, changed, code, desktop] of changes) {
    writeFileSync(cardFile, JSON.stringify(approved));
    writeFileSync(indexFile, JSON.stringify(index));
    writeFileSync(planFile, planBytes);
    const commands = [];
    const run = g2ReportRunner(output, { node: process.execPath }, process.env,
      () => verifyG2Control(controls, desktop), commands);
    const first = label + '-already-started';
    const next = label + '-must-not-start';
    const sentinel = path.join(output, next + '.marker');
    const script = "require('node:fs').writeFileSync(process.argv[1], process.argv[2]);";
    assert.throws(() => run(first, 'node', ['-e', script, file, changed], root), { gateCode: code });
    assert.deepEqual(commands.map(({ id, exitCode }) => [id, exitCode]), [[first, 0]]);
    assert.ok(existsSync(path.join(output, first + '.stdout')), 'preserve the completed subprocess evidence');
    assert.throws(() => run(next, 'node', ['-e', script, sentinel, 'unexpected'], root), { gateCode: code });
    assert.equal(existsSync(sentinel), false);
    assert.equal(existsSync(path.join(output, next + '.stdout')), false);
    assert.equal(commands.length, 1);
  }
});

test('G2 dotnet environment is fixed to verified Windows roots and never widens the Node or Electron environment',
  { skip: (process.platform !== 'win32' || process.arch !== 'x64') && 'approved Windows x64 host layout only' }, () => {
    const cmd = realpathSync.native('C:/Windows/System32/cmd.exe');
    const drive = path.parse(cmd).root;
    const programFiles = realpathSync.native(path.join(drive, 'Program Files'));
    const programFilesX86 = realpathSync.native(path.join(drive, 'Program Files (x86)'));
    const programData = realpathSync.native(path.join(drive, 'ProgramData'));
    const tools = { cmd, dotnet: path.join(programFiles, 'dotnet', 'dotnet.exe'),
      git: path.join(drive, 'fixture-pinned-git', 'git.exe'), node: process.execPath };
    const hostKeys = { ProgramFiles: programFiles, 'ProgramFiles(x86)': programFilesX86,
      ProgramW6432: programFiles, ProgramData: programData, ALLUSERSPROFILE: programData };
    const commonPath = [path.dirname(tools.git), path.dirname(tools.node), path.dirname(cmd)].join(path.delimiter);
    const base = Object.freeze({ PATH: commonPath, NUGET_PACKAGES: path.join(root, 'isolated-packages') });
    const polluted = ['PATH', ...Object.keys(hostKeys), 'DOTNET_STARTUP_HOOKS', 'MSBuildSDKsPath'];
    const original = Object.fromEntries(polluted.map((key) => [key, process.env[key]]));
    try {
      for (const key of polluted) process.env[key] = path.join(root, 'untrusted-host-environment');
      const dotnet = g2DotnetEnvironment(base, tools);
      assert.deepEqual(dotnet, {
        ...base, ...hostKeys,
        PATH: [path.dirname(tools.git), path.dirname(tools.node), path.dirname(tools.dotnet), path.dirname(cmd)].join(path.delimiter),
      });
      assert.deepEqual(base, { PATH: commonPath, NUGET_PACKAGES: path.join(root, 'isolated-packages') });
      assert.throws(() => g2DotnetEnvironment(base, { ...tools, dotnet: path.join(drive, 'unapproved', 'dotnet.exe') }),
        { gateCode: 'G2_TOOL_UNTRUSTED' });
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

test('G2 detects changed tracked bytes, modified approved outputs and unknown ignored outputs after execution', () => {
  const execution = path.join(root, 'g2-output-fixture');
  git(repo, 'worktree', 'add', '-q', '--detach', execution, head);
  const tracked = readTree(execution, head);
  const deps = { files: new Map(), links: new Map() };
  const name = 'apps/desktop/dist/main/index.js';
  save(execution, name, 'compiled bytes fixture');
  const outputs = new Map([[name, hash('compiled bytes fixture')]]);
  assert.doesNotThrow(() => verifyG2Outputs(execution, tracked, deps, outputs, false));
  save(execution, 'ignored/unapproved', 'not a sanctioned output');
  assert.throws(() => verifyG2Outputs(execution, tracked, deps, outputs, false), { gateCode: 'WORKTREE_DIRTY' });
  unlinkSync(path.join(execution, 'ignored/unapproved'));
  rmdirSync(path.join(execution, 'ignored'));
  save(execution, 'seed.txt', 'other\n');
  assert.throws(() => verifyG2Outputs(execution, tracked, deps, outputs, false), { gateCode: 'WORKTREE_DIRTY' });
  save(execution, 'seed.txt', 'base\n');
  save(execution, name, 'changed generated bytes');
  assert.throws(() => verifyG2Outputs(execution, tracked, deps, outputs, false), { gateCode: 'G2_OUTPUT_MUTATED' });
});

test('G2 checks real Node TAP, and rejects a skip, a wrong name, truncation and duplicate totals', () => {
  const fixture = path.join(root, 'g2-tap-fixture.cjs');
  writeFileSync(fixture, "require('node:test').test('fixture only', () => {});");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', fixture], { env, windowsHide: true });
  const expected = ['fixture only'];
  assert.deepEqual(verifyG2Tap(output, expected), { count: 1, sha256: hash(output) });
  const source = output.toString();
  for (const variant of [source.replace('ok 1 - fixture only', 'ok 1 - fixture only # SKIP not executed'),
    source.replace('# skipped 0', '# skipped 1'), source.replaceAll('fixture only', 'different'),
    source.split(/\r?\n/).slice(0, -3).join('\n'), source + '# pass 1\n']) {
    assert.throws(() => verifyG2Tap(Buffer.from(variant), expected), { gateCode: 'G2_TAP_INVALID' });
  }
});

test('Auth G2 selects only a current actual G1 Auth graph and the exact 29-file closure', async () => {
  const { g2InputNamesFor, verifyG2InputSet } = await import('../../tools/ci/check-candidate.mjs');
  const additions = ['apps/desktop/auth-contract.ts', 'apps/desktop/main/auth-ipc.ts', 'apps/desktop/main/auth.ts',
    'apps/desktop/renderer/startup.css', 'tests/windows/auth-service.test.mjs'];
  const entry = { mode: '100644', oid: 'a'.repeat(40) };
  const tree = new Map(additions.map((name) => [name, entry]));
  const profileSha256 = '3eb5101fe2a5deeb03df4c7c7f69399f990eec9263d045bdd494ac7805ae8c20';
  const graph = { base, head, profileSha256, stylesheets: 1, reactRoots: { react: 1, 'react-dom': 1 } };
  const legacy = g2InputNamesFor(new Map(), undefined, base, head, repo);
  const names = g2InputNamesFor(tree, graph, base, head, repo);
  assert.equal(legacy.size, 24);
  assert.equal(names.size, 29);
  assert.deepEqual([...names].filter((name) => !legacy.has(name)), additions);
  for (const stale of [undefined, { ...graph, base: first }, { ...graph, head: first },
    { ...graph, stylesheets: 0 }, { ...graph, profileSha256: '0'.repeat(64) }]) {
    assert.throws(() => g2InputNamesFor(tree, stale, base, head, repo), { gateCode: 'G2_AUTH_PROFILE_REQUIRED' });
  }
  assert.throws(() => g2InputNamesFor(new Map(additions.slice(1).map((name) => [name, entry])), graph, base, head, repo),
    { gateCode: 'G2_AUTH_PROFILE_REQUIRED' });
  const all = new Map([...names].map((name) => [name, entry]));
  const manifest = [...names].map((path) => ({ path, bytes: 1, sha256: 'b'.repeat(64) }));
  assert.doesNotThrow(() => verifyG2InputSet(all, manifest, names));
  for (const entries of [manifest.slice(1), [...manifest, manifest[0]],
    [...manifest.slice(1), { ...manifest[0], path: 'apps/desktop/unreviewed.ts' }]]) {
    assert.throws(() => verifyG2InputSet(all, entries, names), { gateCode: 'G2_INPUT_UNTRUSTED' });
  }
  assert.throws(() => verifyG2InputSet(new Map([...all, ['apps/desktop/unreviewed.ts', entry]]), manifest, names),
    { gateCode: 'G2_INPUT_UNREVIEWED' });
});

const authObjects = process.env.ORANGE_TEST_G5_OBJECTS;
test('Auth G2 cannot downgrade a real rollback descendant to the legacy input and Windows sets', {
  skip: !authObjects && 'requires the approved local Auth and pre-Auth Git objects',
}, async () => {
  const { g2InputNamesFor, g2WindowsStages } = await import('../../tools/ci/check-candidate.mjs');
  const scratchRepo = path.join(root, 'auth-history');
  const introducedOid = '1fc7f7675f426714bbe49c519269c4d9782f99ce';
  const legacyOid = 'c5f9d91a17dd30576d8a22873508d5bd825eea62';
  const approvedG2 = '139a73cfcfe5b158a7d3113a94b4aba066ba33b0';
  mkdirSync(scratchRepo);
  git(scratchRepo, 'init', '-q');
  writeFileSync(path.join(scratchRepo, '.git/objects/info/alternates'), realpathSync.native(authObjects).replaceAll('\\', '/') + '\n');
  const linked = path.join(root, 'auth-rollback');
  git(scratchRepo, 'worktree', 'add', '-qb', 'rollback-fixture', linked, approvedG2);
  const removed = ['apps/desktop/auth-contract.ts', 'apps/desktop/main/auth-ipc.ts', 'apps/desktop/main/auth.ts',
    'apps/desktop/renderer/startup.css', 'tests/windows/auth-service.test.mjs'];
  const restored = ['apps/desktop/main/index.ts', 'apps/desktop/preload/index.ts', 'apps/desktop/renderer/App.tsx',
    'apps/desktop/renderer/main.tsx', 'tests/windows/shell-smoke.test.mjs'];
  git(linked, 'rm', '--', ...removed);
  git(linked, 'restore', '--source=' + legacyOid, '--staged', '--worktree', '--', ...restored);
  git(linked, 'commit', '-qm', 'synthetic Auth rollback, keeping real reviewed ancestry');
  const rollback = git(linked, 'rev-parse', 'HEAD');
  assert.equal(git(linked, 'rev-parse', rollback + '^'), approvedG2);
  git(linked, 'merge-base', '--is-ancestor', introducedOid, rollback);
  const rolledTree = readTree(linked, rollback);
  assert.ok(removed.every((name) => !rolledTree.has(name)));
  const legacyGraph = { profileSha256: '383b1b1f94eefbc3d8c2c21e35e4bca57d227edd2eb5a4180b7a9574337782dc',
    reactRoots: { react: 1, 'react-dom': 1 } };
  const legacy = g2InputNamesFor(readTree(linked, legacyOid), { ...legacyGraph, base: legacyOid, head: legacyOid }, legacyOid, legacyOid, linked);
  assert.equal(legacy.size, 24);
  assert.deepEqual(g2WindowsStages(false).map(({ id }) => id), ['windows-tap']);
  for (const candidateBase of [legacyOid, introducedOid, approvedG2]) {
    assert.throws(() => g2InputNamesFor(rolledTree, { ...legacyGraph, base: candidateBase, head: rollback },
      candidateBase, rollback, linked), { gateCode: 'G2_AUTH_PROFILE_REQUIRED' }, candidateBase);
  }
  git(scratchRepo, 'replace', rollback, legacyOid);
  assert.throws(() => g2InputNamesFor(rolledTree, { ...legacyGraph, base: approvedG2, head: rollback },
    approvedG2, rollback, linked), { gateCode: 'G2_AUTH_PROFILE_REQUIRED' });
  assert.throws(() => g2InputNamesFor(new Map(), undefined, legacyOid, 'f'.repeat(40), linked),
    { gateCode: 'G2_AUTH_PROVENANCE_UNAVAILABLE' });
  const common = path.join(scratchRepo, '.git');
  for (const [file, bytes] of [['shallow', rollback + '\n'], ['info/grafts', rollback + ' ' + legacyOid + '\n']]) {
    const artifact = path.join(common, file);
    writeFileSync(artifact, bytes, { flag: 'wx' });
    try {
      assert.throws(() => g2InputNamesFor(rolledTree, { ...legacyGraph, base: introducedOid, head: rollback },
        introducedOid, rollback, linked), { gateCode: 'G2_AUTH_PROVENANCE_UNAVAILABLE' }, file);
    } finally {
      unlinkSync(artifact);
    }
  }
});

test('Auth G2 requires one JS and one CSS with the complete exact HTML binding', async () => {
  const { g2BuildOutputs } = await import('../../tools/ci/check-candidate.mjs');
  const worktree = path.join(root, 'g2-auth-output');
  const dist = 'apps/desktop/dist/';
  const js = 'index-pinned123.js', css = 'index-pin456.css';
  const html = [
    '<!doctype html>', '<html lang="zh-CN">', '  <head>', '    <meta charset="UTF-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    '    <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; base-uri \'none\'; form-action \'none\'">',
    '    <title>橙子创作中心</title>', '    <script type="module" crossorigin src="./assets/' + js + '"></script>',
    '    <link rel="stylesheet" crossorigin href="./assets/' + css + '">', '  </head>', '  <body>',
    '    <div id="root"></div>', '  </body>', '</html>', '',
  ].join('\n');
  save(worktree, 'apps/desktop/package.json', '{"version":"0.0.0"}');
  save(worktree, dist + 'main/index.js', 'main');
  save(worktree, dist + 'main/build-identity.json', JSON.stringify({ appVersion: '0.0.0', buildCommit: head, mainSha256: hash('main') }));
  save(worktree, dist + 'preload/index.cjs', 'preload');
  save(worktree, dist + 'renderer/assets/' + js, 'js');
  save(worktree, dist + 'renderer/index.html', html);
  assert.doesNotThrow(() => g2BuildOutputs(worktree, head, false));
  assert.throws(() => g2BuildOutputs(worktree, head, true), { gateCode: 'G2_BUILD_OUTPUT_INVALID' });
  save(worktree, dist + 'renderer/assets/' + css, 'css');
  assert.equal(g2BuildOutputs(worktree, head, true).outputs.get(dist + 'renderer/assets/' + css), hash('css'));
  assert.throws(() => g2BuildOutputs(worktree, head, false), { gateCode: 'G2_BUILD_OUTPUT_INVALID' });
  for (const bad of [html.replace(css, css.toUpperCase()), html.replace('./assets/' + js, 'https://example.invalid/' + js),
    html.replace('</head>', '<link rel="stylesheet" href="./assets/' + css + '">\n  </head>'),
    html.replace('</body>', '<img src="https://example.invalid/x"></body>')]) {
    save(worktree, dist + 'renderer/index.html', bad);
    assert.throws(() => g2BuildOutputs(worktree, head, true), { gateCode: 'G2_BUILD_OUTPUT_INVALID' });
  }
  save(worktree, dist + 'renderer/index.html', html);
  save(worktree, dist + 'renderer/assets/extra.svg', '<svg/>');
  assert.throws(() => g2BuildOutputs(worktree, head, true), { gateCode: 'G2_BUILD_OUTPUT_INVALID' });
});

test('Auth G2 schedules fixed native 9/1/8 tests and rejects a no-match TAP false green', async () => {
  const { g2WindowsStages } = await import('../../tools/ci/check-candidate.mjs');
  const stages = g2WindowsStages(true);
  assert.deepEqual(stages.map(({ expected }) => expected.length), [9, 1, 8]);
  assert.equal(stages[1].expected[0], 'Windows Auth fixture: rejects anonymous and wrong password, verifies user, and signs out without network');
  assert.deepEqual(stages.map(({ args }) => args.at(-1)), [
    'tests/windows/shell-smoke.test.mjs', 'tests/windows/shell-smoke.test.mjs', 'tests/windows/auth-service.test.mjs',
  ]);
  assert.equal(stages[0].expected.some((name) => new RegExp(stages[1].args.at(-2).slice('--test-name-pattern='.length)).test(name)), false);
  assert.equal(g2WindowsStages(false).length, 1);
  const fixture = path.join(root, 'g2-auth-missing-fixture.cjs');
  writeFileSync(fixture, "require('node:test').test('wrong name', () => {});");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));
  const output = execFileSync(process.execPath, [...stages[1].args.slice(0, -1), fixture], { env, windowsHide: true });
  assert.throws(() => verifyG2Tap(output, stages[1].expected), { gateCode: 'G2_TAP_INVALID' });
});

test('G2 restricted TRX checks fresh times, shared IDs and totals, rejects XML with a DTD or malformed tree', () => {
  const start = '2026-11-05T00:00:01.000Z';
  const finish = '2026-11-05T00:00:02.000Z';
  const id = '11111111-1111-1111-1111-111111111111';
  const zero = ['failed', 'error', 'timeout', 'aborted', 'inconclusive', 'passedButRunAborted', 'notRunnable',
    'notExecuted', 'disconnected', 'warning', 'completed', 'inProgress', 'pending'].map((name) => name + '="0"').join(' ');
  const result = '<UnitTestResult testName="Orange.Contracts.Tests.ContractCases.SharedGoldenCase(id: &quot;shared-fixture&quot;)" '
    + 'outcome="Passed" testId="' + id + '" executionId="' + id + '" startTime="' + start + '" endTime="' + finish + '" />';
  const source = '<?xml version="1.0" encoding="utf-8"?>\n<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010" id="'
    + id + '"><Times start="' + start + '" finish="' + finish + '" /><Results>' + result
    + '</Results><ResultSummary outcome="Completed"><Counters total="1" executed="1" passed="1" ' + zero
    + ' /></ResultSummary></TestRun>';
  const check = (value, at = Date.parse(start)) => verifyG2Trx(Buffer.from(value), ['shared-fixture'], at, Date.parse(finish));
  assert.deepEqual(check(source), { count: 1, sha256: hash(source) });
  for (const variant of [source.replace('<TestRun', '<!DOCTYPE TestRun><TestRun'),
    source.replace('</Results>', '</Other>'), source.replace('notExecuted="0"', 'notExecuted="1"'),
    source.replace('shared-fixture', 'different'), source.replace(result, result + result),
    source.replace('outcome="Passed"', 'outcome="NotExecuted"')]) {
    assert.throws(() => check(variant), { gateCode: 'G2_TRX_INVALID' });
  }
  assert.throws(() => check(source, Date.parse(start) + 1), { gateCode: 'G2_TRX_INVALID' });
});

test('evaluates both commits of an approved linear candidate; missing real stages block integration', () => {
  const report = run();
  assert.equal(report.base, base);
  assert.equal(report.head, head);
  assert.deepEqual(report.changedFiles, ['allowed/first.txt', 'allowed/second.txt']);
  assert.equal(report.checks.find((check) => check.id === 'write-set')?.exitCode, 0);
  assert.equal(report.checks.find((check) => check.id === 'imports')?.exitCode, 0);
  assert.equal(report.checks.find((check) => check.id === 'contracts')?.exitCode, null);
  assert.equal(report.code, 'REQUIRED_CHECK_UNAVAILABLE');
});

test('binds candidate check to the exact approved assignment revision and head', () => {
  assert.equal(run({ ...approved, assignmentRevision: 1 }).code, 'CARD_STALE');
  assert.equal(run(approved, { head: first }).code, 'CARD_STALE');
});

test('does not treat Windows case aliases as authorized or accept relative paths in the allowlist', () => {
  const alias = { ...approved, writeSet: ['Allowed/first.txt', 'allowed/second.txt'] };
  assert.equal(run(alias, approvalFor(alias)).code, 'WRITE_SET_VIOLATION');
  for (const unsafe of ['allowed/../seed.txt', 'allowed\\first.txt', 'allowed/first.txt:other']) {
    const card = { ...approved, writeSet: [unsafe] };
    assert.equal(run(card, approvalFor(card)).code, 'UNSAFE_PATH');
  }
});

test('detects a non-allowed file in a real commit diff', () => {
  try {
    save(tree, 'denied.txt', 'not on task card\n');
    const card = { ...approved, headCommit: commit('denied.txt') };
    assert.equal(run(card, approvalFor(card)).code, 'WRITE_SET_VIOLATION');
  } finally {
    git(tree, 'checkout', '-q', 'candidate-fixture~1');
    git(tree, 'branch', '-f', 'candidate-fixture', head);
    git(tree, 'checkout', '-q', 'candidate-fixture');
  }
});

test('refuses a real multi-parent merge even when its first parent descends from the base', () => {
  save(repo, 'side.txt', 'merge parent fixture\n');
  git(repo, 'add', '--', 'side.txt');
  git(repo, 'commit', '-qm', 'second parent fixture');
  const side = git(repo, 'rev-parse', 'HEAD');
  try {
    git(tree, 'merge', '--no-ff', '-qm', 'merge fixture', side);
    const card = { ...approved, headCommit: git(tree, 'rev-parse', 'HEAD'), writeSet: [...approved.writeSet, 'side.txt'] };
    assert.equal(run(card, approvalFor(card)).code, 'HISTORY_NOT_LINEAR');
  } finally {
    git(tree, 'checkout', '-q', head);
    git(tree, 'branch', '-f', 'candidate-fixture', head);
    git(tree, 'checkout', '-q', 'candidate-fixture');
  }
});

test('refuses a parent directory replaced by an actual Windows junction or symlink', () => {
  const allowed = path.join(tree, 'allowed');
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  save(outside, 'first.txt', 'first\n');
  save(outside, 'second.txt', 'second\n');
  assert.equal(realpathSync.native(allowed), allowed);
  rmSync(allowed, { recursive: true });
  try {
    symlinkSync(outside, allowed, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(run().code, 'WORKTREE_LINK');
  } finally {
    if (process.platform === 'win32') {
      rmSync(allowed, { recursive: true, force: true });
    } else {
      rmSync(allowed, { force: true });
    }
    git(tree, 'checkout', '--', 'allowed');
  }
});

test('author-supplied success, skip or arbitrary command fields are not accepted', () => {
  for (const extra of [
    { reports: [{ head, exitCode: 0 }] },
    { skip: ['contracts'] },
    { command: 'echo forged' },
    { trustedTypeScript: 'some-compiler.js' },
  ]) {
    const card = { ...approved, ...extra };
    assert.equal(run(card, approvalFor(card)).code, 'CARD_INVALID');
  }
});

test('candidate import preflight fails closed when the configured parser is unavailable', () => {
  const report = run(approved, { compiler: path.join(root, 'missing-parser.js') });
  assert.equal(report.code, 'IMPORT_PARSER_UNTRUSTED');
  assert.equal(report.checks.find(({ id }) => id === 'imports')?.exitCode, 1);
});

const compiler = process.env.ORANGE_TEST_TRUSTED_TYPESCRIPT;
test('candidate import preflight accepts pinned TSX parsing but never replaces build graph evidence',
  { skip: !compiler && 'A-only run: no explicit offline compiler fixture' }, () => {
    const name = 'apps/desktop/renderer/App.tsx';
    try {
      save(tree, name, "export const view = <div>safe</div>; throw Error('not executed');");
      const card = { ...approved, headCommit: commit(name), writeSet: [...approved.writeSet, name] };
      const report = run(card, { ...approvalFor(card), compiler });
      assert.equal(report.importParser?.version, '5.9.3');
      assert.equal(report.checks.find(({ id }) => id === 'imports')?.exitCode, 0);
      assert.equal(report.checks.find(({ id }) => id === 'import-build-graph')?.exitCode, null);
      assert.equal(report.code, 'REQUIRED_CHECK_UNAVAILABLE');
    } finally {
      git(tree, 'checkout', '-q', head);
      git(tree, 'branch', '-f', 'candidate-fixture', head);
      git(tree, 'checkout', '-q', 'candidate-fixture');
    }
  });

test('never executes a configured clean filter selected by candidate attributes', () => {
  const marker = path.join(root, 'filter-executed');
  git(tree, 'config', 'filter.gatefixture.clean', 'node filter-fixture.cjs');
  try {
    save(tree, 'filter-fixture.cjs', "require('node:fs').writeFileSync('../filter-executed', 'marker');process.stdin.pipe(process.stdout);");
    save(tree, '.gitattributes', 'allowed/first.txt filter=gatefixture\n');
    const filterHead = commit('filter-fixture.cjs', '.gitattributes', 'allowed/first.txt');
    if (existsSync(marker)) unlinkSync(marker);
    // git add may reuse an unchanged index entry. Exercise the fixture filter explicitly.
    git(tree, 'hash-object', '--path=allowed/first.txt', '--', 'allowed/first.txt');
    assert.ok(existsSync(marker), 'fixture setup must prove the configured Git filter can run');
    unlinkSync(marker);
    const card = { ...approved, headCommit: filterHead, writeSet: [...approved.writeSet, '.gitattributes', 'filter-fixture.cjs'] };
    assert.equal(run(card, approvalFor(card)).code, 'REQUIRED_CHECK_UNAVAILABLE');
    assert.equal(existsSync(marker), false);
    // Equal-length bytes force status to inspect the file, not short-circuit on size.
    save(tree, 'allowed/first.txt', 'dirty\n');
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(path.join(tree, 'allowed/first.txt'), earlier, earlier);
    const report = run(card, approvalFor(card));
    assert.equal(existsSync(marker), false, 'untrusted checkout filter must not execute');
    assert.equal(report.code, 'WORKTREE_DIRTY');
  } finally {
    git(tree, 'config', '--remove-section', 'filter.gatefixture');
    git(tree, 'checkout', '--', 'allowed/first.txt');
    git(tree, 'checkout', '-q', head);
    git(tree, 'branch', '-f', 'candidate-fixture', head);
    git(tree, 'checkout', '-q', 'candidate-fixture');
  }
});

test('rejects untracked files even if the candidate marks them ignored', () => {
  const ignored = path.join(tree, 'ignored');
  save(tree, 'ignored/preflight.js', 'untracked and ignored\n');
  try {
    assert.equal(run().code, 'WORKTREE_DIRTY');
  } finally {
    unlinkSync(path.join(ignored, 'preflight.js'));
    rmdirSync(ignored);
  }
});

test('rejects an external hardlink on an unchanged tracked file', () => {
  const seed = path.join(tree, 'seed.txt');
  save(root, 'external.txt', 'base\n');
  unlinkSync(seed);
  try {
    linkSync(path.join(root, 'external.txt'), seed);
    assert.equal(run().code, 'WORKTREE_CONTENT_MISMATCH');
  } finally {
    if (existsSync(seed)) unlinkSync(seed);
    save(tree, 'seed.txt', 'base\n');
  }
});

const graphSource = process.env.ORANGE_TEST_GRAPH_SOURCE;
const graphToolchain = process.env.ORANGE_TEST_GRAPH_TOOLCHAIN;
const graphRenderer = process.env.ORANGE_TEST_GRAPH_RENDERER;
const graphReviewed = process.env.ORANGE_TEST_GRAPH_PROFILE;
const graphEnabled = graphSource && graphToolchain && graphRenderer && compiler;
test('live Vite stage uses the approved B blobs in a disposable mirror and stays blocked overall',
  { skip: !graphEnabled && 'requires approved B blob source and both offline manifests' }, () => {
    const sourceFiles = [
      'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json',
      'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/vite.config.ts',
      'apps/desktop/renderer/index.html', 'apps/desktop/renderer/main.tsx', 'apps/desktop/renderer/App.tsx',
    ];
    const approvedShell = '0dc626daac1907bb7dc4685e972150b9eeb57b4a';
    const fromShell = (name, revision = approvedShell) => execFileSync('git', [
      '-c', 'safe.directory=' + graphSource.replaceAll('\\', '/'), '-C', graphSource,
      'cat-file', 'blob', revision + ':' + name,
    ], { windowsHide: true });
    const scratch = path.join(root, 'graph-scratch');
    mkdirSync(scratch);
    const options = {
      compiler, graph: ['--trusted-vite-manifest', graphToolchain, '--trusted-renderer-manifest', graphRenderer,
        '--trusted-node-modules', path.join(graphSource, 'node_modules'), '--graph-scratch', scratch],
    };
    try {
      for (const name of sourceFiles) save(tree, name, fromShell(name));
      let card = { ...approved, headCommit: commit(...sourceFiles), writeSet: [...approved.writeSet, ...sourceFiles] };
      const runGraph = (graph = options.graph, compilerPath = compiler) =>
        run(card, { ...approvalFor(card), ...options, graph, compiler: compilerPath });
      const report = runGraph();
      assert.equal(report.code, 'REQUIRED_CHECK_UNAVAILABLE');
      assert.equal(report.checks.find(({ id }) => id === 'import-build-graph')?.exitCode, 0);
      assert.deepEqual(report.rendererGraph.reactRoots, { react: 1, 'react-dom': 1 });
      assert.equal(report.rendererGraph.head, card.headCommit);
      assert.ok(report.rendererGraph.modules >= 3 && report.rendererGraph.edges > 0);
      for (const id of ['format-types', 'dependency-audit', 'secret-scan', 'windows', 'contracts', 'independent-review']) {
        assert.equal(report.checks.find((check) => check.id === id)?.exitCode, null, id);
      }
      assert.deepEqual(readdirSync(scratch), []);
      assert.deepEqual(readFileSync(path.join(tree, sourceFiles.at(-1))), fromShell(sourceFiles.at(-1)));
      assert.equal(git(tree, 'status', '--porcelain=v1', '--ignored'), '');

      const appEntry = 'apps/desktop/renderer/App.tsx';
      const mainEntry = 'apps/desktop/renderer/main.tsx';
      save(tree, mainEntry, "import React from 'react'; import { createRoot } from 'react-dom/client'; import { App } from './App'; createRoot(document.getElementById('root')).render(React.createElement(App));");
      save(tree, appEntry, "import React from 'react'; export function App() { const load = globalThis['require']; if (load) load('node:fs'); return React.createElement('span',null,'fixture'); }");
      card = { ...card, headCommit: commit(mainEntry, appEntry) };
      function graphDidNotRun(result, reason, importsExitCode) {
        assert.equal(result.head, card.headCommit);
        assert.equal(result.code, reason);
        assert.equal(result.checks.find(({ id }) => id === 'imports')?.exitCode, importsExitCode);
        assert.equal(result.checks.find(({ id }) => id === 'import-build-graph')?.exitCode, null);
        assert.equal(result.rendererGraph, undefined);
        assert.deepEqual(readdirSync(scratch), []);
      }
      graphDidNotRun(runGraph(options.graph, null), 'GRAPH_PARSER_REQUIRED', 1);
      const wrongCompiler = path.join(root, 'graph-invalid-typescript.js');
      writeFileSync(wrongCompiler, 'not the pinned TypeScript compiler');
      graphDidNotRun(runGraph(options.graph, wrongCompiler), 'IMPORT_PARSER_UNTRUSTED', 1);
      const astRejected = runGraph();
      graphDidNotRun(astRejected, 'IMPORT_PREFLIGHT_FAILED', 1);
      assert.ok(astRejected.violations?.some(({ file, code }) => file === appEntry && code === 'IMPORT_UNRESOLVED'));
      graphDidNotRun(runGraph([], null), 'REQUIRED_CHECK_UNAVAILABLE', 0);
      for (const name of [mainEntry, appEntry]) save(tree, name, fromShell(name));
      card = { ...card, headCommit: commit(mainEntry, appEntry) };

      assert.equal(runGraph([...options.graph.slice(0, -1), tree]).code, 'GRAPH_PATH_UNSAFE');
      assert.equal(runGraph([...options.graph.slice(0, 5), tree, ...options.graph.slice(6)]).code, 'GRAPH_PATH_UNSAFE');
      assert.equal(runGraph(options.graph.slice(0, -2)).code, 'GRAPH_CONFIG_INVALID');
      assert.equal(runGraph([...options.graph, '--graph-evidence', path.join(root, 'fake.json')]).code, 'BAD_ARGUMENTS');
      assert.equal(runGraph([...options.graph, '--graph-runner', path.join(tree, 'package.json')]).code, 'BAD_ARGUMENTS');
      const falseManifest = path.join(root, 'fake.json');
      writeFileSync(falseManifest, JSON.stringify({ admitted: true, head: card.headCommit }));
      assert.equal(runGraph([options.graph[0], falseManifest, ...options.graph.slice(2)]).code, 'GRAPH_MANIFEST_UNTRUSTED');
      const alteredPackages = path.join(root, 'altered-packages');
      const [pkg] = JSON.parse(readFileSync(graphToolchain, 'utf8')).packages;
      const [file] = pkg.files;
      save(alteredPackages, pkg.physicalRootFromNodeModules + '/' + file.path, Buffer.alloc(file.bytes));
      assert.equal(runGraph([...options.graph.slice(0, 5), alteredPackages, ...options.graph.slice(6)]).code, 'GRAPH_PACKAGE_MISMATCH');

      const liveFlags = Object.fromEntries(options.graph.flatMap((value, i) => i % 2 === 0 ? [[value, options.graph[i + 1]]] : []));
      for (const [target, code] of [
        ['node:fs', 'GRAPH_PRIVILEGED_IMPORT'],
        ['electron', 'GRAPH_PRIVILEGED_IMPORT'],
        ['https://example.invalid/never-fetch.js', 'GRAPH_EXTERNAL_EDGE'],
        ['../../../../escape.js', 'GRAPH_OUTSIDE_MIRROR'],
      ]) {
        const app = sourceFiles.at(-1);
        save(tree, app, 'import ' + JSON.stringify(target) + '; export function App(){return <span>fixture</span>;}');
        const fixtureHead = commit(app);
        assert.throws(() => runRendererGraph(tree, readTree(tree, fixtureHead), liveFlags), { gateCode: code });
        assert.deepEqual(readdirSync(scratch), []);
      }
      const app = sourceFiles.at(-1);
      save(tree, app, fromShell(app));

      const config = 'apps/desktop/vite.config.ts';
      const marker = path.join(root, 'config-executed');
      save(tree, config, "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(marker) + ", 'not allowed');");
      card = { ...card, headCommit: commit(config, app) };
      const rejected = runGraph();
      assert.equal(rejected.code, 'GRAPH_PROFILE_UNAVAILABLE');
      assert.equal(existsSync(marker), false);
      assert.deepEqual(readdirSync(scratch), []);

      if (graphReviewed) {
        const reviewedHead = '01d9da616b00ea6b41f09fac653b2a396a0abdce';
        for (const name of sourceFiles) save(tree, name, fromShell(name, reviewedHead));
        card = { ...card, headCommit: commit(...sourceFiles) };
        assert.equal(runGraph().code, 'GRAPH_PROFILE_UNAVAILABLE');
        assert.equal(runGraph([...options.graph, '--trusted-renderer-profile', falseManifest]).code, 'GRAPH_PROFILE_UNTRUSTED');
        const second = runGraph([...options.graph, '--trusted-renderer-profile', graphReviewed]);
        assert.equal(second.checks.find(({ id }) => id === 'import-build-graph')?.exitCode, 0, JSON.stringify(second));
        assert.equal(second.rendererGraph.profileSha256, '383b1b1f94eefbc3d8c2c21e35e4bca57d227edd2eb5a4180b7a9574337782dc');
        assert.equal(second.code, 'REQUIRED_CHECK_UNAVAILABLE');
        assert.deepEqual(readdirSync(scratch), []);
      }
    } finally {
      git(tree, 'checkout', '-q', head);
      git(tree, 'branch', '-f', 'candidate-fixture', head);
      git(tree, 'checkout', '-q', 'candidate-fixture');
    }
  });
