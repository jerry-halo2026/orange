import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'orange-admission-test-'));
after(() => {
  assert.equal(realpathSync.native(root), root);
  rmSync(root, { recursive: true, force: true });
});
const repo = path.join(root, 'repo');
const gate = fileURLToPath(new URL('../../tools/ci/check-admission.mjs', import.meta.url));
const git = (...args) => execFileSync('git', [
  '-c', 'user.name=Gate Test Fixture', '-c', 'user.email=gate-test@example.invalid',
  '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', '-C', repo, ...args,
], { encoding: 'utf8', windowsHide: true }).trim();
mkdirSync(repo);
git('init', '-q');
git('commit', '-qm', 'fixture baseline', '--allow-empty');
const base = git('rev-parse', 'HEAD');
const cards = ['a', 'b'].map((taskId) => {
  const worktree = path.join(root, taskId);
  git('worktree', 'add', '-qb', taskId, worktree, base);
  return {
    taskId, assignmentRevision: 2, baselineCommit: base, workingBaselineCommit: base,
    headCommit: base, worktree, branch: taskId, writeSet: [taskId + '.txt'],
    dependencies: [], contracts: [], resources: [],
  };
});
const [a, b] = cards;
function run(card = b, { active = a, index = {}, approval = card, expiresDuringCheck = false, proofPath } = {}) {
  const indexPath = path.join(root, 'index.json');
  const cardPath = path.join(root, 'card.json');
  const clock = Date.UTC(2030, 0, 1);
  const nodeArgs = [];
  if (expiresDuringCheck) {
    const fakeClock = path.join(root, 'test-clock.mjs');
    writeFileSync(fakeClock, `let calls = 0; Date.now = () => ${clock} + (calls++ === 0 ? 0 : 60_001);\n`);
    nodeArgs.push('--import', pathToFileURL(fakeClock).href);
  }
  writeFileSync(indexPath, JSON.stringify({
    schemaVersion: 1,
    validUntil: new Date((expiresDuringCheck ? clock : Date.now()) + 60_000).toISOString(),
    cards: [active, approval],
    slots: { total: 4, otherOccupied: 1 },
    activeWriters: [active.taskId],
    pendingReviews: [],
    resourceLeases: [],
    completed: [],
    freezes: [],
    ...index,
  }));
  writeFileSync(cardPath, JSON.stringify(card));
  const result = spawnSync(process.execPath, [
    ...nodeArgs, gate, '--index', indexPath, '--card', cardPath,
    ...(proofPath ? ['--trusted-k07-proof', proofPath] : []),
  ], { encoding: 'utf8', windowsHide: true });
  assert.ok(result.stdout, 'admission gate must report a decision: ' + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 1, 'fixtures cannot establish N5a');
  assert.equal(report.admitted, false);
  return report;
}

test('finds a free slot and independent real worktrees without declaring N5a passed', () => {
  const report = run();
  assert.equal(report.code, 'N5A_UNVERIFIED');
  assert.deepEqual(report.nextSlot, { role: 'implementer', taskId: 'b' });
});

test('gives the next genuinely available slot to independent review before a writer', () => {
  const pendingReviews = ['a'];
  const report = run(b, { index: { pendingReviews } });
  assert.equal(report.code, 'REVIEW_PRIORITY');
  assert.deepEqual(report.nextSlot, { role: 'reviewer', taskId: 'a' });
});

test('rejects stale assignment, expired snapshot, and depleted capacity', () => {
  assert.equal(run({ ...b, assignmentRevision: 1 }, { approval: b }).code, 'CARD_STALE');
  assert.equal(run(b, { index: { validUntil: '2000-01-01T00:00:00.000Z' } }).code, 'INDEX_EXPIRED');
  assert.equal(run(b, { index: { slots: { total: 2, otherOccupied: 1 } } }).code, 'CAPACITY_EXHAUSTED');
});

test('rejects writes overlapping the root lock, including a Windows case alias', () => {
  const active = { ...a, writeSet: ['pnpm-lock.yaml'] };
  for (const name of ['pnpm-lock.yaml', 'PNPM-lock.yaml']) {
    assert.equal(run({ ...b, writeSet: [name] }, { active }).code, 'WRITE_SET_CONFLICT');
  }
});

test('different files cannot share a Windows case-aliased directory prefix', () => {
  assert.equal(run({ ...b, writeSet: ['future/b.txt'] }, {
    active: { ...a, writeSet: ['Future/a.txt'] },
  }).code, 'WRITE_SET_CONFLICT');
});

test('a requested writer conflict does not hide the available review slot', () => {
  const report = run({ ...b, writeSet: a.writeSet }, { index: { pendingReviews: ['a'] } });
  assert.equal(report.code, 'REVIEW_PRIORITY');
  assert.deepEqual(report.nextSlot, { role: 'reviewer', taskId: 'a' });
});

test('an approved review card whose real branch has advanced cannot receive a slot', () => {
  const worktree = path.join(root, 'review');
  git('worktree', 'add', '-qb', 'review', worktree, base);
  execFileSync('git', ['-c', 'user.name=Gate Test Fixture', '-c', 'user.email=gate-test@example.invalid',
    '-c', 'commit.gpgSign=false', '-C', worktree, 'commit', '-qm', 'new review head', '--allow-empty']);
  const stale = { ...b, taskId: 'review', worktree, branch: 'review' };
  const report = run(b, { index: { cards: [a, b, stale], pendingReviews: ['review'] } });
  assert.equal(report.code, 'WORKTREE_STALE');
  assert.equal(report.nextSlot, null);
});

test('does not recommend a slot if the snapshot expires during the Git checks', () => {
  for (const pendingReviews of [[], ['a']]) {
    const report = run(b, { index: { pendingReviews }, expiresDuringCheck: true });
    assert.equal(report.code, 'INDEX_EXPIRED');
    assert.equal(report.nextSlot, null);
  }
});

test('malformed dependency and freeze entries invalidate the snapshot', () => {
  assert.equal(run(b, { index: { completed: [17], freezes: [{}] } }).code, 'INDEX_INVALID');
});

test('rejects contested desktop, TCP port and test database leases', () => {
  for (const [kind, id] of [['desktop', 'default'], ['tcp-port', '5432'], ['test-db', 'orange-test']]) {
    const resources = [{ kind, id }];
    assert.equal(run({ ...b, resources }, { active: { ...a, resources } }).code, 'RESOURCE_CONFLICT');
  }
});

test('refuses the same physical worktree and a non-linked repository', () => {
  assert.equal(run({ ...b, worktree: a.worktree, branch: a.branch }).code, 'WORKTREE_CONFLICT');
  assert.equal(run({ ...b, worktree: repo }).code, 'WORKTREE_NOT_LINKED');
});

test('rejects a desktop lease held by a non-writer reviewer', () => {
  const desktop = { kind: 'desktop', id: 'default' };
  assert.equal(run({ ...b, resources: [desktop] }, {
    index: { resourceLeases: [{ ...desktop, holder: 'independent-reviewer' }] },
  }).code, 'RESOURCE_CONFLICT');
});

test('refuses to admit a write path through a real junction or symlink', () => {
  const link = path.join(b.worktree, 'linked-output');
  const outside = path.join(root, 'outside-output');
  mkdirSync(outside);
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal(run({ ...b, writeSet: ['linked-output/new.txt'] }).code, 'WORKTREE_LINK');
  } finally {
    if (process.platform === 'win32') rmdirSync(link);
    else unlinkSync(link);
  }
});

test('rejects missing direct dependencies and unverified or stale contract freezes', () => {
  assert.equal(run({ ...b, dependencies: [{ taskId: a.taskId, headCommit: base }] }).code, 'DEPENDENCY_UNAVAILABLE');
  const contract = { id: 'K01.fixture', version: '1.0.0', sha256: 'c'.repeat(64) };
  const card = { ...b, contracts: [contract] };
  assert.equal(run(card).code, 'CONTRACT_UNAVAILABLE');
  const differentDigest = { ...contract, sha256: 'd'.repeat(64), state: 'consumer_ready' };
  assert.equal(run(card, { index: { freezes: [differentDigest] } }).code, 'CONTRACT_UNAVAILABLE');
  const labelled = { ...contract, state: 'consumer_ready' };
  assert.equal(run(card, { index: { freezes: [labelled] } }).code, 'CONTRACT_VERIFICATION_UNAVAILABLE');
});

const g5FixtureEnabled = process.env.ORANGE_TEST_G5_OBJECTS && process.env.ORANGE_TEST_G5_N1;
test('G5 proves only actual K07 v1 Git bytes and never grants a writing slot',
  { skip: !g5FixtureEnabled && 'requires independently approved local K07 Git objects and N1 evidence' }, () => {
    const sha = (value) => createHash('sha256').update(value).digest('hex');
    const actualBase = '405b45f322e29e097dca57efef6c0be90e95f699';
    const actualHead = 'd1759a63e8dc9405daf9cc0caa288fefca4a453a';
    const originalCommit = '18e29f76ea768776acbde2e595e1964c165a35ff';
    const integratedCommit = '67e974da976a88591ec93b14411b4d3376f74a7a';
    const signoff = 'bc41ba5f2eeca4aec400b42cbf8aa34f8354da674915669402d5b72912daedfd';
    const n1Bytes = readFileSync(process.env.ORANGE_TEST_G5_N1);
    assert.equal(sha(n1Bytes), signoff);
    writeFileSync(path.join(repo, '.git/objects/info/alternates'), realpathSync.native(process.env.ORANGE_TEST_G5_OBJECTS).replaceAll('\\', '/') + '\n');
    const gitCommonDir = realpathSync.native(path.join(repo, '.git'));
    const worktree = path.join(root, 'g5-source');
    git('worktree', 'add', '-qb', 'g5-fixture', worktree, actualHead);
    const inWorktree = (...args) => git('-C', worktree, ...args);
    const k07 = { id: 'K07.desktop-startup.v1', version: '1', sha256: signoff };
    const fixture = { ...b, taskId: 'g5-fixture', worktree, branch: 'g5-fixture', baselineCommit: actualBase,
      workingBaselineCommit: actualHead, headCommit: actualHead, contracts: [k07] };
    const n1Path = path.join(root, 'n1.json');
    const evidencePath = path.join(root, 'test-only-registration-review.md');
    const evidence = 'Test-only review stand-in, never authorizes a real task.\n';
    const proofPath = path.join(root, 'k07-proof.json');
    writeFileSync(n1Path, n1Bytes);
    writeFileSync(evidencePath, evidence);
    const options = (card, mutate = () => {}) => {
      const { taskId, assignmentRevision, branch, baselineCommit, workingBaselineCommit, headCommit } = card;
      const proof = { schemaVersion: 1, subject: { taskId, assignmentRevision, branch, baselineCommit, workingBaselineCommit,
        headCommit, gitCommonDir }, n1Path, registrationReview: {
        reviewerId: '/root/k07_n0_review', authorId: '/root/t02_k07', result: 'approved', originalCommit, integratedCommit,
        evidencePath, evidenceSha256: sha(evidence),
      } };
      mutate(proof);
      const bytes = JSON.stringify(proof);
      writeFileSync(proofPath, bytes);
      return { proofPath, index: { activeWriters: [], k07ProofSha256: sha(bytes),
        freezes: card.contracts.map((contract) => ({ ...contract, state: 'consumer_ready' })) } };
    };
    const positive = options(fixture);
    const aliasOptions = options(fixture, (proof) => {
      proof.subject.gitCommonDir += path.sep + '..' + path.sep + '.git';
    });
    assert.equal(run(fixture, aliasOptions).code, 'K07_PROOF_STALE');
    options(fixture);
    const result = run(fixture, positive);
    assert.equal(result.code, 'N5A_UNVERIFIED');
    assert.equal(result.eligibility, 'read-only-verified');
    assert.deepEqual(result.verifiedContracts, [k07]);
    assert.deepEqual(result.nextSlot, { role: 'implementer', taskId: fixture.taskId });
    const shadowBytes = 'export const unsignedAlias = true;\n';
    const shadowFile = path.join(root, 'g5-shadow.txt');
    writeFileSync(shadowFile, shadowBytes);
    const shadowOid = git('hash-object', '-w', shadowFile);
    const validator = 'packages/contracts/src/validate.ts';
    const aliases = [
      ['file', 'packages/contracts/src/VALIDATE.ts'],
      ['directory', 'packages/contracts/SRC/validate.ts'],
      ['directory-other-leaf', 'packages/contracts/SRC/unrelated.ts'],
      ['directory-nfc', 'packages/contracts/schemas/K07/unrelated.json'],
    ];
    const aliasResults = [];
    for (const [id, alias] of aliases) {
      const branch = 'g5-shadow-' + id;
      const aliasRoot = path.join(root, branch);
      git('worktree', 'add', '-qb', branch, aliasRoot, actualHead);
      const aliasGit = (...args) => git('-C', aliasRoot, '-c', 'core.ignorecase=false', ...args);
      aliasGit('update-index', '--add', '--cacheinfo', '100644,' + shadowOid + ',' + alias);
      aliasGit('commit', '-qm', 'add a protected path alias via Git index');
      const aliasHead = aliasGit('rev-parse', 'HEAD');
      assert.equal(aliasGit('rev-parse', aliasHead + ':' + validator), aliasGit('rev-parse', actualHead + ':' + validator));
      assert.equal(aliasGit('rev-parse', aliasHead + ':' + alias), shadowOid);
      if (id === 'file' && process.platform === 'win32') {
        aliasGit('checkout-index', '--force', '--', alias);
        assert.equal(readFileSync(path.join(aliasRoot, validator), 'utf8'), shadowBytes,
          'the real Windows checkout must read the shadow blob through the canonical validator path');
      }
      const aliased = { ...fixture, worktree: aliasRoot, branch, headCommit: aliasHead };
      const headRejection = run(aliased, options(aliased));
      aliasResults.push([id + ' requested head', headRejection.code, headRejection.eligibility, headRejection.nextSlot]);
      const cleanTree = git('rev-parse', actualHead + '^{tree}');
      const descendant = git('commit-tree', cleanTree, '-p', aliasHead, '-m', 'clean head with aliased working baseline');
      const cleanBranch = branch + '-clean';
      const cleanRoot = path.join(root, cleanBranch);
      git('worktree', 'add', '-qb', cleanBranch, cleanRoot, descendant);
      const badBaseline = { ...fixture, worktree: cleanRoot, branch: cleanBranch, workingBaselineCommit: aliasHead, headCommit: descendant };
      const baselineRejection = run(badBaseline, options(badBaseline));
      aliasResults.push([id + ' working baseline', baselineRejection.code, baselineRejection.eligibility, baselineRejection.nextSlot]);
    }
    const unrelatedBranch = 'g5-unrelated-alias';
    const unrelatedRoot = path.join(root, unrelatedBranch);
    git('worktree', 'add', '-qb', unrelatedBranch, unrelatedRoot, actualHead);
    for (const rel of ['unrelated/FOLDER/a.txt', 'unrelated/folder/b.txt']) {
      git('-C', unrelatedRoot, '-c', 'core.ignorecase=false', 'update-index', '--add', '--cacheinfo', '100644,' + shadowOid + ',' + rel);
    }
    git('-C', unrelatedRoot, 'commit', '-qm', 'add unrelated alias outside K07 protected paths');
    const unrelatedAlias = { ...fixture, worktree: unrelatedRoot, branch: unrelatedBranch,
      headCommit: git('-C', unrelatedRoot, 'rev-parse', 'HEAD') };
    assert.equal(run(unrelatedAlias, options(unrelatedAlias)).eligibility, 'read-only-verified');
    assert.deepEqual(aliasResults, aliases.flatMap(([id]) => ['requested head', 'working baseline']
      .map((boundary) => [id + ' ' + boundary, 'K07_FREEZE_PATH_ALIAS', undefined, null])));
    options(fixture);
    const expired = run(fixture, { ...positive, expiresDuringCheck: true });
    assert.equal(expired.code, 'INDEX_EXPIRED');
    assert.equal(expired.eligibility, undefined);
    assert.equal(run(fixture, { ...positive, proofPath: undefined }).code, 'CONTRACT_VERIFICATION_UNAVAILABLE');
    assert.equal(run(fixture, { ...positive, index: { ...positive.index, k07ProofSha256: 'a'.repeat(64) } }).code, 'K07_PROOF_UNTRUSTED');
    for (const [field, value] of Object.entries({ taskId: 'wrong', assignmentRevision: 1, branch: 'other-ref',
      workingBaselineCommit: integratedCommit, headCommit: integratedCommit, gitCommonDir: realpathSync.native(root) })) {
      assert.equal(run(fixture, options(fixture, (proof) => { proof.subject[field] = value; })).code, 'K07_PROOF_STALE', field);
    }
    for (const contract of [{ ...k07, version: '2' }, { ...k07, id: k07.id.toLowerCase() }, { ...k07, sha256: 'a'.repeat(64) }]) {
      const bad = { ...fixture, contracts: [contract] };
      assert.equal(run(bad, options(bad)).code, 'CONTRACT_VERIFICATION_UNAVAILABLE');
    }
    assert.equal(run(fixture, options(fixture, (proof) => { proof.registrationReview.reviewerId = '/root/t02_k07'; })).code, 'K07_REGISTRATION_REVIEW');
    assert.equal(run(fixture, options(fixture, (proof) => { proof.registrationReview.integratedCommit = originalCommit; })).code, 'K07_REGISTRATION_REVIEW');
    writeFileSync(evidencePath, 'mutated review bytes');
    assert.equal(run(fixture, options(fixture)).code, 'K07_REGISTRATION_REVIEW');
    writeFileSync(evidencePath, evidence);
    writeFileSync(n1Path, Buffer.concat([n1Bytes, Buffer.from('\n')]));
    assert.equal(run(fixture, options(fixture)).code, 'K07_N1_UNTRUSTED');
    writeFileSync(n1Path, n1Bytes);
    const registry = 'packages/contracts/freeze-registry.json';
    assert.equal(run({ ...fixture, writeSet: [registry] }, options(fixture)).code, 'K07_PROTECTED_WRITE');
    assert.equal(run({ ...fixture, writeSet: [registry.toUpperCase()] }, options(fixture)).code,
      process.platform === 'win32' ? 'WORKTREE_LINK' : 'K07_PROTECTED_WRITE');
    const unrelated = git('commit-tree', git('rev-parse', actualHead + '^{tree}'), '-p', actualBase, '-m', 'copy without registration ancestry');
    const orphanRoot = path.join(root, 'g5-orphan');
    git('worktree', 'add', '-qb', 'g5-orphan', orphanRoot, unrelated);
    const orphan = { ...fixture, worktree: orphanRoot, branch: 'g5-orphan', workingBaselineCommit: unrelated, headCommit: unrelated };
    assert.equal(run(orphan, options(orphan)).code, 'K07_REGISTRATION_ANCESTRY');
    for (const rel of [registry, 'packages/contracts/schemas/K07/v1.schema.json', 'tests/contracts/fixtures/K07/cases.json',
      'packages/contracts/src/validate.ts', 'packages/contracts/generated/ts/K07.ts']) {
      const file = path.join(worktree, rel);
      const bytes = readFileSync(file);
      if (rel.endsWith('cases.json')) {
        const data = JSON.parse(bytes);
        assert.equal(data.cases.length, 114);
        data.cases[0].id += '-changed';
        writeFileSync(file, JSON.stringify(data));
      } else writeFileSync(file, Buffer.concat([bytes, Buffer.from('\n')]));
      inWorktree('add', '--', rel);
      inWorktree('commit', '-qm', 'mutate frozen fixture file');
      const mutated = { ...fixture, headCommit: inWorktree('rev-parse', 'HEAD') };
      assert.equal(run(mutated, options(mutated)).code, 'K07_FREEZE_BYTES', rel);
      writeFileSync(file, bytes);
      inWorktree('add', '--', rel);
      inWorktree('commit', '-qm', 'restore frozen fixture bytes');
      const baselineDrift = { ...mutated, workingBaselineCommit: mutated.headCommit, headCommit: inWorktree('rev-parse', 'HEAD') };
      assert.equal(run(baselineDrift, options(baselineDrift)).code, 'K07_FREEZE_BYTES', rel + ' baseline');
    }
  });
