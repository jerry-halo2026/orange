import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  g2BuildOutputs, g2DotnetEnvironment, g2InputNamesFor, g2ReportRunner, g2WindowsStages,
  verifyG2Control, verifyG2Execution, verifyG2InputSet, verifyG2Lease, verifyG2Outputs, verifyG2Tap, verifyG2Trx,
  materializeG3Database, readG3NativeLock, readG3Report, runG3OSV, verifyG3Control, verifyG3OSVReport, verifyG3Tool,
} from '../../tools/ci/check-candidate.mjs';
import { readTree, runRendererGraph } from '../../tools/ci/check-imports.mjs';

const testTempRoot = realpathSync.native(process.env.ORANGE_TEST_TMP ?? tmpdir());
assert.equal(realpathSync.native(tmpdir()), testTempRoot);
const root = mkdtempSync(path.join(testTempRoot, 'orange-gate-test-'));
after(() => {
  assert.equal(realpathSync.native(root), root);
  assert.equal(path.dirname(root), testTempRoot);
  assert.ok(path.basename(root).startsWith('orange-gate-test-'));
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
  assert.equal(root.split(path.sep).some(part => part.toLowerCase() === '.git'), false);
  for (const protectedRoot of [fileURLToPath(new URL('../..', import.meta.url)), 'D:/dev/orange', 'D:/dev/oc1-final',
    'D:/dev/oc2-exec', 'D:/dev/oc2-exec-output', 'D:/dev/oc2-exec-control', 'D:/dev/oc2-graph-scratch']) {
    const relative = path.relative(protectedRoot, root);
    assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'private cleanup must stay outside protected roots');
  }
  // Native rm removes link entries, not their targets. Retries remain bounded and failures still throw.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
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
  return runCandidateAt(tree, cardPath, card, { approval: approved, base, head, ...options });
}
function runCandidateAt(checkout, control, card, options) {
  writeFileSync(control, JSON.stringify(card));
  writeFileSync(path.join(path.dirname(control), 'index.json'), JSON.stringify({
    schemaVersion: 1,
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    cards: [options.approval],
    ...options.index,
  }));
  const args = [
    ...(options.nodeArgs ?? []), gate, '--base', options.base, '--head', options.head, '--card', control,
    ...(options.compiler ? ['--trusted-typescript', options.compiler] : []),
    ...(options.graph ?? []),
    ...(options.g2 ? ['--trusted-g2-plan', options.g2] : []),
    ...(options.g3 ? ['--trusted-g3-plan', options.g3] : []),
    ...(options.review ? ['--trusted-review', options.review] : []),
    ...(options.studio ? ['--trusted-studio-source', options.studio] : []),
    ...(options.extra ?? []),
  ];
  if (options.observe) return observeCandidateRun(args, checkout, control, options.observe);
  return decodeCandidateRun(spawnSync(process.execPath, args, { cwd: checkout, encoding: 'utf8', windowsHide: true }));
}
function decodeCandidateRun(result) {
  assert.ok(result.stdout, 'candidate gate must report a decision: ' + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 1, 'no fixture is eligible for integration');
  assert.equal(report.admitted, false);
  return report;
}
async function observeCandidateRun(args, checkout, control, observe) {
  const child = spawn(process.execPath, args, { cwd: checkout, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
  const [result, observation] = await Promise.allSettled([closed, observe({ child, control })]);
  if (observation.status === 'rejected') throw observation.reason;
  if (result.status === 'rejected') throw result.reason;
  return decodeCandidateRun(result.value);
}
function approvalFor(card) {
  return { approval: card, head: card.headCommit, base: card.workingBaselineCommit };
}

const studioUrl = 'https://example.invalid/reviewed/openfilm.git';
const studioLink = 'vendor/openfilm';
const studioModules = '[submodule "vendor/openfilm"]\n\tpath = vendor/openfilm\n\turl = ' + studioUrl + '\n';
function studioFixture(name, modules = studioModules) {
  const candidate = path.join(root, 'studio-candidate-' + name);
  const source = path.join(root, 'studio-source-' + name);
  for (const dir of [candidate, source]) {
    mkdirSync(dir);
    git(dir, 'init', '-q', '--object-format=sha1');
  }
  save(source, 'nested/source.js', 'throw Error("must not execute fixture source");\n');
  git(source, 'add', '--', 'nested/source.js');
  git(source, 'commit', '-qm', 'source pin fixture');
  const pin = git(source, 'rev-parse', 'HEAD');
  const sourceTree = git(source, 'rev-parse', 'HEAD^{tree}');
  const sourceBlob = git(source, 'rev-parse', 'HEAD:nested/source.js');
  save(candidate, '.gitmodules', modules);
  git(candidate, 'add', '--', '.gitmodules');
  git(candidate, 'update-index', '--add', '--cacheinfo', '160000,' + pin + ',' + studioLink);
  git(candidate, 'commit', '-qm', 'reviewed E0 fixture');
  const e0 = git(candidate, 'rev-parse', 'HEAD');
  const modulesBlob = git(candidate, 'rev-parse', 'HEAD:.gitmodules');
  save(candidate, 'unrelated.txt', 'descendant fixture\n');
  git(candidate, 'add', '--', 'unrelated.txt');
  git(candidate, 'commit', '-qm', 'E0 descendant fixture');
  const head = git(candidate, 'rev-parse', 'HEAD');
  const policy = { e0, pin, sourceTree, modulesBlob, url: studioUrl };
  return { candidate, source, policy, head, sourceBlob };
}
function studioCli(...args) {
  const result = spawnSync(process.execPath, [gate, '--verify-studio-source', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.ok(result.stdout, result.stderr);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

test('Studio source CLI has a fixed E0 and does not accept policy overrides', () => {
  const { candidate, source, policy } = studioFixture('cli');
  const args = ['--candidate', candidate, '--source', source];
  assert.deepEqual(studioCli(...args), { status: 1, report: {
    schemaVersion: 1, admitted: false, mode: 'studio-source-only', code: 'STUDIO_SOURCE_E0_MISSING',
  } });
  for (const extra of [['--e0', policy.e0], ['--pin', policy.pin], ['--card', cardPath], ['--source', source]]) {
    assert.deepEqual(studioCli(...args, ...extra), { status: 1, report: {
      schemaVersion: 1, admitted: false, mode: 'studio-source-only', code: 'BAD_ARGUMENTS',
    } });
  }
  assert.equal(studioCli('--candidate', '.', '--source', source).report.code, 'STUDIO_SOURCE_PATH_UNSAFE');
});

test('Studio source verifies only the real Git source-object reference, never the checkout or admission', async () => {
  const { verifyStudioSource } = await import(g4Module);
  assert.equal(typeof verifyStudioSource, 'function', 'Studio source verification is not implemented');
  const fixture = studioFixture('pass');
  const { candidate, source, policy, head } = fixture;
  git(source, 'checkout', '-q', '--detach', policy.pin);
  git(source, 'remote', 'add', 'origin', 'https://example.invalid/a-different-origin.git');
  save(source, 'nested/source.js', 'untrusted modified checkout\n');
  save(candidate, '.gitmodules', 'untrusted modified checkout\n');
  assert.deepEqual(verifyStudioSource({ candidate, source }, policy), {
    schemaVersion: 1, admitted: false, mode: 'studio-source-only', code: 'STUDIO_SOURCE_REFERENCE_VERIFIED',
    candidate: { e0: policy.e0, head, tree: git(candidate, 'rev-parse', 'HEAD^{tree}'), modulesBlob: policy.modulesBlob },
    sourceReference: { path: studioLink, url: studioUrl, commit: policy.pin, tree: policy.sourceTree, shallowAtPin: false },
  });
});

test('Studio source rejects a current gitlink with the wrong pin or mode', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy } = studioFixture('wrong-gitlink');
  for (const [mode, oid] of [['160000', policy.e0], ['100644', policy.modulesBlob]]) {
    git(candidate, 'update-index', '--add', '--cacheinfo', mode + ',' + oid + ',' + studioLink);
    git(candidate, 'commit', '-qm', 'unreviewed gitlink');
    assert.throws(() => verifyStudioSource({ candidate, source }, policy), { gateCode: 'STUDIO_SOURCE_GITLINK_MISMATCH' });
  }
});

test('Studio source rejects unreviewed gitmodules URL, extra directives and executable mode', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy } = studioFixture('wrong-gitmodules');
  for (const bytes of [studioModules.replace(studioUrl, 'https://example.invalid/wrong.git'), studioModules + '\tupdate = !echo never\n']) {
    save(candidate, '.gitmodules', bytes);
    git(candidate, 'add', '--', '.gitmodules');
    git(candidate, 'commit', '-qm', 'unreviewed gitmodules');
    assert.throws(() => verifyStudioSource({ candidate, source }, policy), { gateCode: 'STUDIO_SOURCE_GITMODULES_MISMATCH' });
  }
  git(candidate, 'update-index', '--add', '--cacheinfo', '100755,' + policy.modulesBlob + ',.gitmodules');
  git(candidate, 'commit', '-qm', 'unreviewed gitmodules mode');
  assert.throws(() => verifyStudioSource({ candidate, source }, policy), { gateCode: 'STUDIO_SOURCE_GITMODULES_MISMATCH' });
  const badE0 = studioFixture('invalid-e0-bytes', studioModules + '\tbranch = main\n');
  assert.throws(() => verifyStudioSource(badE0, badE0.policy), { gateCode: 'STUDIO_SOURCE_GITMODULES_MISMATCH' });
});

test('Studio source rejects a lookalike candidate tree outside the E0 ancestry', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy } = studioFixture('unrelated');
  const duplicate = git(candidate, 'commit-tree', git(candidate, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated commit');
  git(candidate, 'update-ref', 'HEAD', duplicate);
  assert.throws(() => verifyStudioSource({ candidate, source }, policy), { gateCode: 'STUDIO_SOURCE_ANCESTRY_MISMATCH' });
});

test('Studio source rejects a malformed raw commit with a forged ancestry header', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy } = studioFixture('malformed-commit');
  const tree = git(candidate, 'rev-parse', 'HEAD^{tree}');
  save(candidate, 'raw-commit', 'tree ' + tree + '\nparent ' + policy.e0 + '\n');
  const oid = git(candidate, 'hash-object', '--literally', '-w', '-t', 'commit', '--', 'raw-commit');
  const ref = git(candidate, 'symbolic-ref', 'HEAD');
  save(candidate, '.git/' + ref, oid + '\n');
  assert.throws(() => verifyStudioSource({ candidate, source }, policy), { gateCode: 'STUDIO_SOURCE_HEAD_INVALID' });
});

test('Studio source rejects Windows case aliases in exact reference tree lookups', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy, head } = studioFixture('reference-aliases');
  const tree = git(candidate, 'ls-tree', head);
  const vendor = git(candidate, 'rev-parse', head + ':vendor');
  const mkTree = (input) => execFileSync('git', ['-C', candidate, 'mktree', '--missing'], {
    input: input + '\n', encoding: 'utf8', windowsHide: true,
  }).trim();
  const aliasedVendor = mkTree('160000 commit ' + policy.pin + '\topenfilm\n160000 commit ' + policy.pin + '\tOPENFILM');
  for (const [contents, code] of [
    [tree + '\n100644 blob ' + policy.modulesBlob + '\t.GITMODULES', 'STUDIO_SOURCE_GITMODULES_MISMATCH'],
    [tree + '\n040000 tree ' + vendor + '\tVendor', 'STUDIO_SOURCE_GITLINK_MISMATCH'],
    [tree.replace(vendor + '\tvendor', aliasedVendor + '\tvendor'), 'STUDIO_SOURCE_GITLINK_MISMATCH'],
  ]) {
    const alias = git(candidate, 'commit-tree', mkTree(contents), '-p', head, '-m', 'reference alias');
    git(candidate, 'update-ref', 'HEAD', alias);
    assert.throws(() => verifyStudioSource({ candidate, source }, policy), { gateCode: code });
  }
});

for (const alias of ['.gitmodules::$DATA', 'gitmod~1']) {
  test('Studio source rejects Windows path alias ' + alias + ' in the reference tree', async () => {
    const { verifyStudioSource } = await import(g4Module);
    const { candidate, source, policy, head } = studioFixture(alias.startsWith('.') ? 'ads-alias' : 'short-alias');
    const input = git(candidate, 'ls-tree', head) + '\n100644 blob ' + policy.modulesBlob + '\t' + alias + '\n';
    const tree = execFileSync('git', ['-C', candidate, 'mktree', '--missing'], {
      input, encoding: 'utf8', windowsHide: true,
    }).trim();
    const commit = git(candidate, 'commit-tree', tree, '-p', head, '-m', 'Win32 path alias');
    git(candidate, 'update-ref', 'HEAD', commit);
    assert.throws(() => verifyStudioSource({ candidate, source }, policy), { gateCode: 'STUDIO_SOURCE_CANDIDATE_TREE_INVALID' });
  });
}

test('Studio source marks a packed-only Orange candidate unavailable rather than copying its mixed pack', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy } = studioFixture('packed-candidate');
  git(candidate, 'repack', '-ad');
  git(candidate, 'prune-packed');
  assert.equal(existsSync(path.join(candidate, '.git', 'objects', policy.e0.slice(0, 2), policy.e0.slice(2))), false);
  assert.throws(() => verifyStudioSource({ candidate, source }, policy), { gateCode: 'STUDIO_SOURCE_CANDIDATE_OBJECT_UNAVAILABLE' });
});

test('Studio source rejects an oversized Orange metadata object before staging it', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy } = studioFixture('oversized-orange-object');
  save(candidate, 'message.txt', 'a'.repeat(1024 * 1024) + '\n');
  git(candidate, 'commit', '--allow-empty', '-qF', 'message.txt');
  assert.throws(() => verifyStudioSource({ candidate, source }, policy), { gateCode: 'STUDIO_SOURCE_CANDIDATE_OBJECT_UNAVAILABLE' });
});

test('Studio source rejects the wrong repository, tree or an absent reachable blob', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy, sourceBlob } = studioFixture('wrong-objects');
  const runSource = (directory = source, expected = policy) => verifyStudioSource({ candidate, source: directory }, expected);
  assert.throws(() => runSource(candidate), { gateCode: 'STUDIO_SOURCE_SAME_REPOSITORY' });
  assert.throws(() => runSource(repo), { gateCode: 'STUDIO_SOURCE_COMMIT_UNAVAILABLE' });
  assert.throws(() => runSource(source, { ...policy, sourceTree: git(repo, 'rev-parse', 'HEAD^{tree}') }),
    { gateCode: 'STUDIO_SOURCE_TREE_MISMATCH' });
  unlinkSync(path.join(source, '.git', 'objects', sourceBlob.slice(0, 2), sourceBlob.slice(2)));
  assert.throws(() => runSource(), { gateCode: 'STUDIO_SOURCE_CLOSURE_INVALID' });
});

test('Studio source checks the digest of an expected loose object and ignores unrelated objects', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy, sourceBlob } = studioFixture('object-content');
  const check = () => verifyStudioSource({ candidate, source }, policy);
  const objectName = (oid) => '.git/objects/' + oid.slice(0, 2) + '/' + oid.slice(2);
  save(source, objectName('0'.repeat(40)), 'unreachable malformed loose content');
  assert.equal(check().sourceReference.commit, policy.pin);
  save(source, 'other.txt', 'another legitimate object\n');
  const other = git(source, 'hash-object', '-w', '--', 'other.txt');
  unlinkSync(path.join(source, objectName(sourceBlob)));
  save(source, objectName(sourceBlob), readFileSync(path.join(source, objectName(other))));
  assert.throws(check, { gateCode: 'STUDIO_SOURCE_CLOSURE_INVALID' });
});

test('Studio source does not consult an inherited alternate, Git directory or command config', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy } = studioFixture('inherited-env');
  const overrides = {
    GIT_DIR: path.join(repo, '.git'), GIT_OBJECT_DIRECTORY: path.join(repo, '.git', 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(source, '.git', 'objects'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'include.path', GIT_CONFIG_VALUE_0: path.join(source, 'injected.config'),
  };
  save(source, 'injected.config', 'not a Git configuration\n');
  const old = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    assert.equal(verifyStudioSource({ candidate, source }, policy).sourceReference.commit, policy.pin);
    assert.throws(() => verifyStudioSource({ candidate, source: repo }, policy), { gateCode: 'STUDIO_SOURCE_COMMIT_UNAVAILABLE' });
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Studio source never launches a caller-selected Git executable', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const fixture = studioFixture('caller-git');
  const outside = path.join(root, 'caller-bin');
  mkdirSync(outside);
  const win = process.platform === 'win32';
  copyFileSync(win ? path.join(process.env.SystemRoot, 'System32', 'where.exe') : '/usr/bin/false',
    path.join(outside, win ? 'git.exe' : 'git'));
  const old = process.env.PATH;
  try {
    process.env.PATH = outside + path.delimiter + old;
    assert.equal(verifyStudioSource(fixture, fixture.policy).sourceReference.commit, fixture.policy.pin);
  } finally {
    process.env.PATH = old;
  }
});

test('Studio source ignores replace refs and local config and rejects alternate and promisor stores', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy } = studioFixture('object-transport');
  const otherPin = git(source, 'commit-tree', policy.sourceTree, '-m', 'different valid commit');
  git(source, 'replace', policy.pin, otherPin);
  save(source, '.git/config', '[core]\n\trepositoryformatversion = 99\n');
  save(candidate, '.git/config', '[include]\n\tpath = config\n');
  const check = () => verifyStudioSource({ candidate, source }, policy);
  assert.equal(check().sourceReference.commit, policy.pin);
  const alternates = '.git/objects/info/alternates';
  save(source, alternates, path.join(repo, '.git', 'objects') + '\n');
  assert.throws(check, { gateCode: 'STUDIO_SOURCE_OBJECT_STORE_UNSAFE' });
  unlinkSync(path.join(source, alternates));
  save(source, '.git/objects/pack/pack-' + '0'.repeat(40) + '.promisor', '');
  assert.throws(check, { gateCode: 'STUDIO_SOURCE_OBJECT_STORE_UNSAFE' });
});

test('Studio source only honors a shallow boundary at the verified pin', async () => {
  const { verifyStudioSource } = await import(g4Module);
  const { candidate, source, policy } = studioFixture('shallow-pin');
  const check = () => verifyStudioSource({ candidate, source }, policy);
  save(source, '.git/shallow', policy.pin + '\n');
  assert.equal(check().sourceReference.shallowAtPin, true);
  save(source, '.git/shallow', policy.pin + '\n' + policy.e0 + '\n');
  assert.throws(check, { gateCode: 'STUDIO_SOURCE_OBJECT_STORE_UNSAFE' });
});

test('normal candidate check still rejects a gitlink in a real commit', () => {
  try {
    git(tree, 'update-index', '--add', '--cacheinfo', '160000,' + head + ',' + studioLink);
    git(tree, 'commit', '-qm', 'forbidden gitlink fixture');
    const card = { ...approved, headCommit: git(tree, 'rev-parse', 'HEAD'), writeSet: [...approved.writeSet, studioLink] };
    assert.equal(run(card, approvalFor(card)).code, 'UNSAFE_GIT_MODE');
  } finally {
    git(tree, 'checkout', '-q', head);
    git(tree, 'branch', '-f', 'candidate-fixture', head);
    git(tree, 'checkout', '-q', 'candidate-fixture');
  }
});

function candidateRepo(start, populate = () => {}) {
  const area = mkdtempSync(path.join(root, 'c0-'));
  const repository = path.join(area, 'repo');
  const checkout = path.join(area, 'linked');
  const control = path.join(area, 'card.json');
  const branch = 'admission-fixture';
  mkdirSync(repository, { recursive: true });
  git(repository, 'init', '-q', '--object-format=sha1');
  const common = path.join(repository, '.git');
  populate(common);
  if (!start) {
    save(repository, '.gitignore', 'ignored/\n');
    git(repository, 'add', '--', '.gitignore');
    git(repository, 'commit', '-qm', 'admission fixture baseline');
    start = git(repository, 'rev-parse', 'HEAD');
  }
  git(repository, 'worktree', 'add', '-qb', branch, checkout, start);
  const gitHere = (...args) => git(checkout, ...args);
  const commitHere = () => {
    gitHere('commit', '-qm', 'candidate fixture mutation');
    return gitHere('rev-parse', 'HEAD');
  };
  const append = (name = 'fixture.txt') => {
    save(checkout, name, 'fixture data\n');
    gitHere('add', '--', name);
    return commitHere();
  };
  const run = (base, options = {}) => {
    const head = gitHere('rev-parse', 'HEAD');
    const card = { ...approved, branch, worktree: checkout, baselineCommit: base, workingBaselineCommit: base,
      headCommit: head, writeSet: options.writeSet ?? ['fixture.txt'] };
    return runCandidateAt(checkout, control, card, { approval: card, base, head, ...options });
  };
  return { start, checkout, common, gitHere, commitHere, append, run };
}
const studioE0 = '75a00f94db1c5e640b05ead26ed31624fa1c5254';
const studioE0Parent = '8bc9a3bc817da362badee19884d716d9ef630c4d';
const studioHead = 'f7113a99246d0fde220c9da35cd5bc01c0815382';
const studioTree = 'e590320670b39696d20924e4cf33ce6f83d7549b';
const studioPin = '2e18a4bdf54647b2ece3c0975a6f9573720c7821';
const studioModulesOid = '12829551ca0bb641ff2fe235a35a81bbab5a283a';
const studioObjectsDonor = process.env.ORANGE_TEST_STUDIO_OBJECTS_DONOR;
const studioPinnedSource = process.env.ORANGE_TEST_STUDIO_PINNED_SOURCE;
const studioReal = { skip: !(studioObjectsDonor && studioPinnedSource)
  && 'requires the exact local Orange Git objects and the approved pinned OpenFilm snapshot' };
function exactStudioCandidate(at = studioHead) {
  const donor = realpathSync.native(studioObjectsDonor);
  const objects = git(donor, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
  // Copy only the known commit's reachable loose objects, not the donor's
  // refs, configuration, worktrees, index, alternates or any mixed pack.
  return candidateRepo(at, (common) => {
    for (const oid of git(donor, 'rev-list', '--objects', '--no-object-names', studioHead, '--').split(/\r?\n/)) {
      assert.match(oid, /^[0-9a-f]{40}$/);
      const dir = oid.slice(0, 2);
      const file = oid.slice(2);
      mkdirSync(path.join(common, 'objects', dir), { recursive: true });
      copyFileSync(path.join(objects, dir, file), path.join(common, 'objects', dir, file));
    }
  });
}

test('Studio C0 crosses real E0 and stops at the dual graph, not legacy imports or later flags', studioReal, () => {
  const { run, gitHere } = exactStudioCandidate();
  assert.equal(gitHere('rev-parse', 'HEAD^{tree}'), studioTree);
  const changes = gitHere('diff', '--name-only', studioE0Parent, studioHead, '--').split(/\r?\n/).sort();
  assert.ok(changes.includes(studioLink) && changes.includes('.gitmodules'));
  const report = run(studioE0Parent, { writeSet: changes, studio: studioPinnedSource,
    compiler: path.join(root, 'not-a-parser'), graph: ['--trusted-vite-manifest', path.join(root, 'not-a-graph')],
    g2: path.join(root, 'not-g2'), g3: path.join(root, 'not-g3'), review: path.join(root, 'not-g4') });
  assert.equal(report.code, 'STUDIO_DUAL_GRAPH_REQUIRED', JSON.stringify(report));
  assert.deepEqual(report.changedFiles, changes);
  assert.deepEqual(report.studioSource?.candidate, { e0: studioE0, head: studioHead, tree: studioTree, modulesBlob: studioModulesOid });
  assert.equal(report.studioSource?.sourceReference.commit, studioPin);
  assert.equal(report.studioSource?.sourceReference.tree, '5b898016c32e794091d9e4a5ac7901497b2e9210');
  assert.equal(report.studioSource?.admitted, false);
  assert.deepEqual(report.checks[0], { id: 'write-set', exitCode: 0, status: 'passed' });
  assert.deepEqual(report.checks[1], { id: 'imports', exitCode: null, status: 'not-run' });
  assert.deepEqual(report.checks.find(({ id }) => id === 'import-build-graph'),
    { id: 'import-build-graph', exitCode: null, status: 'unavailable', code: 'STUDIO_DUAL_GRAPH_REQUIRED' });
  assert.equal(report.checks.slice(2).some(({ exitCode }) => exitCode !== null), false);
  assert.equal(run(studioE0Parent, { writeSet: changes.filter((name) => name !== studioLink), studio: studioPinnedSource }).code,
    'WRITE_SET_VIOLATION');
});

const c1Profile = process.env.ORANGE_TEST_STUDIO_C1_PROFILE;
const c1Packages = process.env.ORANGE_TEST_STUDIO_C1_PACKAGES;
const c1Donor = process.env.ORANGE_TEST_STUDIO_C1_DONOR;
const c1Scratch = process.env.ORANGE_TEST_STUDIO_C1_SCRATCH;
const c1Compiler = process.env.ORANGE_TEST_TRUSTED_TYPESCRIPT;
const studioC1Real = { skip: studioReal.skip || !(c1Profile && c1Packages && c1Donor && c1Scratch && c1Compiler)
  && 'requires the exact local C1 recipe, offline package donor, pinned parser and isolated D scratch' };
const c1ProfileSha = 'da14717975ad2d34e2fc3acf518b90d9ce6968c1f2e0a8ec68a96b08f22b5fdc';
const c1PackageSha = '08a1d2e28b6990c3ecedceebf14f643ad7b890edc17238b7e86872e8060c6d5e';
const c2C1Receipt = process.env.ORANGE_TEST_STUDIO_C2_C1_RECEIPT;
const c2BuildRoot = process.env.ORANGE_TEST_STUDIO_C2_BUILD;
const c2BuildRecord = process.env.ORANGE_TEST_STUDIO_C2_BUILD_RECORD;
const c2InputRecord = process.env.ORANGE_TEST_STUDIO_C2_INPUT_RECORD;
const studioC2Real = { skip: studioReal.skip || !(c2C1Receipt && c2BuildRoot && c2BuildRecord && c2InputRecord && c1Profile)
  && 'requires the verified local C1 receipt and exact non-authorizing C2 rehearsal bytes' };
function exactC2Record(file, sha) {
  const bytes = readFileSync(file);
  assert.equal(hash(bytes), sha);
  return JSON.parse(bytes);
}
function c2Observations() {
  const { rendererGraph, studioSource, code, admitted } = exactC2Record(c2C1Receipt,
    '1d7d945f0031e4b41cb76401bd8d32bc07a0c38da58e6fa5588367d0dbd39a7c');
  assert.equal(code, 'STUDIO_C2_REQUIRED');
  assert.equal(admitted, false);
  const material = exactC2Record(c2InputRecord, 'd897b42d6848596bcfa27bda9bbd305dcdc7041b800187845c959ad534e5b9e9');
  const build = exactC2Record(c2BuildRecord, 'f7c804039870c5d6cc9a4662a03862034bedde86f8fe7eaeb23bf710e104361f');
  for (const record of [rendererGraph, material, build]) {
    assert.equal(record.head, studioHead);
    assert.equal(record.tree, studioTree);
  }
  return { rendererGraph, studioSource, material, build };
}

test('Studio C2 preserves the legacy Auth CONTROL: 6 outputs and 9/1/8 native identities', studioC2Real, () => {
  assert.equal(g2BuildOutputs(c2BuildRoot, studioHead, true).outputs.size, 6);
  assert.deepEqual(g2WindowsStages(true).map(({ id, expected }) => [id, expected.length]),
    [['windows-tap', 9], ['windows-auth-fixture-tap', 1], ['windows-auth-service-tap', 8]]);
});

test('Studio C2 selects the exact 35 inputs from the current independently rebuilt dual graph', studioC2Real, () => {
  const { checkout } = exactStudioCandidate();
  const { rendererGraph, studioSource, material } = c2Observations();
  const tracked = readTree(checkout, studioHead);
  const names = material.entries.map(({ path: name, mode, oid }) => {
    assert.deepEqual(tracked.get(name), { mode, oid });
    return name;
  });
  assert.equal(new Set(names).size, 35);
  assert.deepEqual([...g2InputNamesFor(tracked, rendererGraph, rendererGraph.base, studioHead, checkout,
    { studioSource })].sort(), names.sort());
  for (const graph of [undefined, { ...rendererGraph, head: studioE0 }, { ...rendererGraph, builds: rendererGraph.builds.slice(0, 1) }]) {
    assert.throws(() => g2InputNamesFor(tracked, graph, rendererGraph.base, studioHead, checkout, { studioSource }),
      { gateCode: 'STUDIO_C2_GRAPH_MISMATCH' });
  }
});

test('Studio C2 rejects an unreviewed adapter input in the exact committed-input metadata', studioC2Real, () => {
  const { checkout } = exactStudioCandidate();
  const { material, studioSource } = c2Observations();
  const tracked = readTree(checkout, studioHead);
  const entries = material.entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const names = new Set(entries.map(({ path }) => path));
  assert.doesNotThrow(() => verifyG2InputSet(tracked, entries, names, { studioSource }));
  // Metadata only: never create, import, or execute an unreviewed input.
  const extra = new Map([...tracked, ['packages/film-adapter/src/unreviewed-input.ts',
    tracked.get('packages/film-adapter/src/node.ts')]]);
  assert.throws(() => verifyG2InputSet(extra, entries, names, { studioSource }), { gateCode: 'G2_INPUT_UNREVIEWED' });
});

test('Studio C2 verifies the actual 17 build outputs against the independent C1 artifacts', studioC2Real, () => {
  const { studioSource, rendererGraph, build } = c2Observations();
  const profile = exactC2Record(c1Profile, c1ProfileSha);
  const outputs = g2BuildOutputs(c2BuildRoot, studioHead, true, { studioSource, rendererGraph,
    files: build.outputs.files, sourcePaths: profile.fixedUpstream.closure.map(({ path: name }) => name) });
  assert.equal(outputs.outputs.size, 17);
  assert.deepEqual(outputs.outputs, new Map(build.outputs.files.map(({ name, sha256 }) => ['apps/desktop/dist/' + name, sha256])));
});

test('Studio C2 does not substitute a self-consistent build list for the independent Studio artifacts or source closure', studioC2Real, () => {
  const { studioSource, rendererGraph, build } = c2Observations();
  const profile = exactC2Record(c1Profile, c1ProfileSha);
  const sourcePaths = profile.fixedUpstream.closure.map(({ path: name }) => name);
  const output = (opts) => g2BuildOutputs(c2BuildRoot, studioHead, true, {
    studioSource, rendererGraph, files: build.outputs.files, sourcePaths, ...opts,
  });
  const files = build.outputs.files.map((row) => row.name.endsWith('.woff2') ? { ...row, sha256: '0'.repeat(64) } : row);
  assert.throws(() => output({ files }), { gateCode: 'G2_BUILD_OUTPUT_INVALID' });
  assert.throws(() => output({ sourcePaths: sourcePaths.slice(1) }), { gateCode: 'G2_BUILD_OUTPUT_INVALID' });
});

test('Studio C2 schedules the two exact Studio identities before unchanged native Auth suites', studioC2Real, () => {
  const { studioSource } = c2Observations();
  const stages = g2WindowsStages(true, { studioSource });
  assert.deepEqual(stages.map(({ id, expected }) => [id, expected.length]),
    [['windows-studio-tap', 2], ['windows-tap', 9], ['windows-auth-fixture-tap', 1], ['windows-auth-service-tap', 8]]);
  assert.deepEqual(stages[0].args, ['--test', '--test-reporter=tap', 'tests/windows/studio-smoke.test.mjs']);
  assert.deepEqual(stages[0].expected, [
    'Studio Node adapter rejects untrusted, malformed, modified, extra and linked build inputs',
    'Windows real compiled Orange hosts Studio only in the native fixture; network and teardown are fail-closed',
  ]);
  assert.deepEqual(stages.slice(1), g2WindowsStages(true));
});

const studioJobTest = { skip: process.platform !== 'win32' && 'requires a real Windows kernel Job' };
const studioJobSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const studioJobLeaf = 'const f=require("node:fs"); f.writeFileSync(process.argv[1],String(process.pid),{flag:"wx"}); setTimeout(()=>{},15000);';
const studioJobRoot = 'const f=require("node:fs"),{spawn}=require("node:child_process"); const [leaf,mark]=process.argv.slice(1); '
  + 'const p=spawn(process.execPath,["-e",leaf,mark],{detached:true,stdio:"ignore",windowsHide:true}); p.unref(); '
  + 'const w=setInterval(()=>{if(f.existsSync(mark)){clearInterval(w);console.log(p.pid);}},20); '
  + 'setTimeout(()=>{clearInterval(w);process.exitCode=2;},3000).unref();';
const studioJobActive = 'const f=require("node:fs"); f.writeFileSync(process.argv[1],String(process.pid),{flag:"wx"}); '
  + 'if(process.argv[2])setTimeout(()=>f.writeFileSync(process.argv[2],"revoked"),200);setTimeout(()=>{},15000);';
function studioJobPid(file) {
  for (let i = 0; i < 150 && !existsSync(file); i++) studioJobSleep(20);
  const pid = Number(readFileSync(file, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  return pid;
}
function studioJobAlive(pid) {
  try { return process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function studioJobCleanup(file) {
  if (!existsSync(file)) return;
  const pid = studioJobPid(file);
  if (studioJobAlive(pid)) process.kill(pid); // Only the process that exclusively created this private marker.
  for (let i = 0; i < 60 && studioJobAlive(pid); i++) studioJobSleep(20);
  assert.equal(studioJobAlive(pid), false);
}
let studioJobSetup;
async function studioJobInvoke(ctx, args, maximum = 4000, expected = hash('active')) {
  if (!studioJobSetup) {
    const tools = {
      node: realpathSync.native(process.execPath), cmd: realpathSync.native('C:/Windows/System32/cmd.exe'),
      taskkill: realpathSync.native('C:/Windows/System32/taskkill.exe'),
      dotnet: realpathSync.native('C:/Program Files/dotnet/dotnet.exe'),
      csc: realpathSync.native('C:/Program Files/dotnet/sdk/10.0.300/Roslyn/bincore/csc.dll'),
    };
    const system = path.dirname(tools.cmd);
    const env = { SystemRoot: path.dirname(system), WINDIR: path.dirname(system), COMSPEC: tools.cmd,
      PATH: path.dirname(tools.node) + path.delimiter + system, DOTNET_ROOT: path.dirname(tools.dotnet) };
    const scratch = mkdtempSync(path.join(root, 'c2-job-'));
    const { prepareStudioG2Job } = await import(g4Module);
    const job = prepareStudioG2Job?.(scratch, tools, g2ReportRunner(scratch, tools,
      { ...env, TEMP: scratch, TMP: scratch }, () => 30_000, []));
    studioJobSetup = { tools, env, job };
  }
  const { tools, env, job } = studioJobSetup;
  const control = path.join(ctx, 'lease.json');
  writeFileSync(control, 'active', { flag: 'wx' });
  const commands = [];
  const run = g2ReportRunner(ctx, tools, { ...env, TEMP: ctx, TMP: ctx }, () => 6000, commands,
    { native: true, job, controls: [[control, expected]], guard() {} });
  let result, error;
  try { result = run('fixture', 'node', [...args, ...(args[0] === '-e' && args[1] === studioJobActive && maximum === 4000 ? [control] : [])], ctx, maximum); }
  catch (reason) { error = reason; }
  assert.equal(commands.length, 1);
  return { result, error, command: commands[0] };
}

test('Studio C2 R2 Job records normal root exit and refuses a pre-revoked child before it starts', studioJobTest, async () => {
  for (let i = 0; i < 12; i++) {
    const clean = await studioJobInvoke(mkdtempSync(path.join(root, 'job-clean-')), ['-e', 'console.log("owned")']);
    assert.equal(clean.error, undefined, JSON.stringify(clean.command));
    assert.equal(clean.result.stdout.toString().trimEnd(), 'owned');
    assert.equal(clean.command.nativeChild.status, 0);
    assert.equal(clean.command.nativeChild.activeAfter, 0);
    assert.equal(studioJobAlive(clean.command.nativeChild.pid), false);
  }
  const ctx = mkdtempSync(path.join(root, 'job-preflight-'));
  const file = path.join(ctx, 'must-not-run');
  const refused = await studioJobInvoke(ctx, ['-e', studioJobLeaf, file], 4000, '0'.repeat(64));
  assert.equal(refused.error?.gateCode, 'G2_COMMAND_FAILED');
  assert.equal(refused.command.nativeChild?.pid, null);
  assert.equal(existsSync(file), false);
});

test('Studio C2 R2 Job rejects a zero-exit root with a live detached descendant and reaps only its Job', studioJobTest, async (t) => {
  const ctx = mkdtempSync(path.join(root, 'job-detached-'));
  const file = path.join(ctx, 'detached.pid');
  try {
    const { error, command } = await studioJobInvoke(ctx, ['-e', studioJobRoot, studioJobLeaf, file]);
    const pid = studioJobPid(file);
    const descendantAlive = studioJobAlive(pid);
    t.diagnostic(JSON.stringify({ command, descendantAlive }));
    assert.equal(error?.gateCode, 'G2_COMMAND_FAILED', 'a top-level exit cannot certify native tree teardown');
    assert.equal(descendantAlive, false);
    assert.equal(command.nativeChild?.stopped, 'surviving-descendants');
    assert.equal(command.nativeChild?.activeAfter, 0);
  } finally { studioJobCleanup(file); }
});

for (const [reason, limit] of [['control-drift', 4000], ['deadline', 1500]]) {
  test('Studio C2 R2 Job witnesses active ' + reason + ' and preserves an unrelated process', studioJobTest, async (t) => {
    const ctx = mkdtempSync(path.join(root, 'job-active-'));
    const owned = path.join(ctx, 'owned.pid');
    const unrelated = path.join(ctx, 'unrelated.pid');
    const child = spawn(process.execPath, ['-e', studioJobLeaf, unrelated], { cwd: ctx, windowsHide: true, stdio: 'ignore' });
    try {
      assert.equal(studioJobPid(unrelated), child.pid);
      const { error, command } = await studioJobInvoke(ctx, ['-e', studioJobActive, owned], limit);
      const ownedPid = studioJobPid(owned);
      const ownedAlive = studioJobAlive(ownedPid), unrelatedAlive = studioJobAlive(child.pid);
      t.diagnostic(JSON.stringify({ command, ownedAlive, unrelatedAlive }));
      assert.equal(error?.gateCode, 'G2_COMMAND_FAILED');
      assert.equal(unrelatedAlive, true);
      assert.equal(ownedAlive, false);
      assert.equal(command.nativeChild?.stopped, reason, 'must witness terminal cancellation, not an outer timeout');
      assert.equal(command.nativeChild.pid, ownedPid);
      assert.equal(command.nativeChild.activeAfter, 0);
    } finally { studioJobCleanup(owned); studioJobCleanup(unrelated); }
  });
}


test('Studio C2 R2 Job refuses first-use owner DLL substitution after the fixed compiler succeeds', studioJobTest, async () => {
  await studioJobInvoke(mkdtempSync(path.join(root, 'job-prep-')), ['-e', 'console.log("prep")']);
  const { tools, env } = studioJobSetup;
  const output = mkdtempSync(path.join(root, 'job-owner-'));
  const { prepareStudioG2Job } = await import(g4Module);
  const commands = [];
  const compile = g2ReportRunner(output, tools, { ...env, TEMP: output, TMP: output }, () => 30_000, commands);
  assert.throws(() => prepareStudioG2Job(output, tools, (...args) => {
    const completed = compile(...args);
    const dll = path.join(output, 'studio-job', 'owner.dll');
    const bytes = readFileSync(dll);
    assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(dll, bytes); // Private test output only. Never execute the changed bytes.
    return completed;
  }), { gateCode: 'G2_JOB_UNTRUSTED' });
  assert.equal(commands[0].exitCode, 0, 'the real compiler must complete, not a mocked callback');
});

test('Studio C2 R2 Job closes owned processes if the outer runner loses the owner on output overflow', studioJobTest, async () => {
  const ctx = mkdtempSync(path.join(root, 'job-overflow-'));
  const file = path.join(ctx, 'owned-descendant.pid');
  const code = 'const f=require("node:fs"),{spawn}=require("node:child_process"); const [leaf,mark]=process.argv.slice(1); '
    + 'const p=spawn(process.execPath,["-e",leaf,mark],{detached:true,stdio:"ignore",windowsHide:true}); p.unref(); '
    + 'const w=setInterval(()=>{if(f.existsSync(mark)){clearInterval(w);process.stdout.write(Buffer.alloc(17*1024*1024));}},20); '
    + 'setTimeout(()=>{},12000);';
  try {
    const { error, command } = await studioJobInvoke(ctx, ['-e', code, studioJobLeaf, file]);
    const pid = studioJobPid(file);
    for (let i = 0; i < 100 && studioJobAlive(pid); i++) studioJobSleep(20);
    assert.equal(error?.gateCode, 'G2_COMMAND_FAILED');
    assert.equal(command.error, 'ENOBUFS');
    assert.equal(studioJobAlive(pid), false);
  } finally { studioJobCleanup(file); }
});



test('Studio C2 R3 Job retirement policy preserves cancellation and deadline across repeated accounting-only snapshots', studioJobTest, async () => {
  await studioJobInvoke(mkdtempSync(path.join(root, 'job-policy-prep-')), ['-e', 'console.log("policy prep")']);
  const { tools, env, job } = studioJobSetup;
  const folder = mkdtempSync(path.join(root, 'job-policy-'));
  const checks = path.join(folder, 'checks.cs'), dll = path.join(folder, 'checks.dll');
  writeFileSync(checks, [
    'using System;',
    'internal static class RetirementChecks {',
    '  static void Eq(string a,string b) { if(a!=b) throw new Exception("policy mismatch "+a+" / "+b); }',
    '  static int Main() {',
    '    uint root=77;',
    '    for(int n=0;n<4;n++) Eq(StudioJob.RetirementDecision(root,1,0,new long[0],true,null),"retiring-root");',
    '    Eq(StudioJob.RetirementDecision(root,1,0,new long[0],true,"control-drift"),"control-drift");',
    '    for(int n=0;n<4;n++) Eq(StudioJob.RetirementDecision(root,1,1,new long[]{77},true,null),"retiring-root");',
    '    Eq(StudioJob.RetirementDecision(root,1,1,new long[]{77},true,"deadline"),"deadline");',
    '    Eq(StudioJob.RetirementDecision(root,0,0,new long[0],true,null),null);',
    '    Eq(StudioJob.RetirementDecision(root,1,1,new long[]{88},true,null),"surviving-descendants");',
    '    Eq(StudioJob.RetirementDecision(root,0,1,new long[]{88},true,null),"surviving-descendants");',
    '    Eq(StudioJob.RetirementDecision(root,1,1,new long[0],true,null),"job-membership-unverified");',
    '    Eq(StudioJob.RetirementDecision(root,1,0,null,false,null),"job-membership-unverified");',
    '    Eq(StudioJob.RetirementDecision(root,1,0,new long[0],false,null),"job-membership-unverified");',
    '    Eq(StudioJob.RetirementDecision(root,1,2,new long[]{77,77},true,null),"job-membership-unverified");',
    '    Eq(StudioJob.RetirementDecision(root,1,17,new long[17],true,null),"job-membership-unverified");',
    '    Console.WriteLine("retirement-state-policy: passed"); return 0;',
    '  }',
    '}',
  ].join('\n'));
  const reference = path.join(path.dirname(tools.dotnet), 'packs/Microsoft.NETCore.App.Ref/10.0.8/ref/net10.0');
  const refs = ['System.Runtime', 'System.Runtime.InteropServices', 'System.Console', 'System.Security.Cryptography']
    .map((name) => '/reference:' + path.join(reference, name + '.dll'));
  const commands = [];
  const run = g2ReportRunner(folder, tools, { ...env, TEMP: folder, TMP: folder }, () => 30_000, commands);
  run('policy-compile', 'dotnet', ['exec', tools.csc, '/nologo', '/noconfig', '/nostdlib+', '/target:exe',
    '/main:RetirementChecks', '/out:' + dll, ...refs, path.join(job.folder, 'owner.cs'), checks], folder);
  const result = run('policy-test', 'dotnet', ['exec', '--runtimeconfig', job.config, dll], folder);
  assert.equal(result.stdout.toString().trim(), 'retirement-state-policy: passed');
  assert.deepEqual(commands.map(({ exitCode }) => exitCode), [0, 0]);
});



function c1Assignment() {
  const { run, gitHere, checkout, commitHere, common } = exactStudioCandidate();
  const writeSet = gitHere('diff', '--name-only', studioE0Parent, studioHead, '--').split(/\r?\n/).sort();
  const options = {
    writeSet, studio: studioPinnedSource, compiler: c1Compiler,
    graph: ['--trusted-renderer-profile', c1Profile, '--trusted-renderer-manifest', c1Packages,
      '--trusted-node-modules', c1Donor, '--graph-scratch', c1Scratch],
    index: { studioRendererApproval: { base: studioE0Parent, head: studioHead, tree: studioTree,
      profileSha256: c1ProfileSha, packageManifestSha256: c1PackageSha } },
  };
  const invoke = ({ index = options.index, ...overrides } = {}) => run(studioE0Parent, {
    ...options, ...overrides, index: { validUntil: new Date(Date.now() + 240_000).toISOString(), ...index },
  });
  return { run: invoke, options, checkout, gitHere, commitHere, common };
}

function c2PlanFixture(assignment) {
  const { checkout } = assignment;
  const { rendererGraph } = c2Observations();
  const invalid = { path: path.join(root, 'no-c2-material'), sha256: '1'.repeat(64) };
  return {
    schemaVersion: 2, taskId: approved.taskId, assignmentRevision: approved.assignmentRevision,
    base: studioE0Parent, head: studioHead, tree: studioTree,
    executionRoot: checkout, outputRoot: mkdtempSync(path.join(root, 'c2-out-')),
    validUntil: new Date(Date.now() + 220_000).toISOString(),
    desktopLease: { id: 'not-issued', holder: approved.taskId, validUntil: new Date(Date.now() + 210_000).toISOString() },
    executableInputs: invalid, installedPackages: { ...invalid, sourceRoot: path.join(root, 'unused') },
    nugetFeed: { path: path.join(root, 'unused'), files: [] },
    tools: Object.fromEntries(['node', 'git', 'dotnet', 'csc', 'cmd', 'taskkill'].map((role) => [role, invalid])),
    studio: { rendererGraphSha256: hash(JSON.stringify(rendererGraph)), buildOutputs: invalid },
  };
}
function c2Invoke(assignment, plan, index = {}) {
  const planFile = path.join(path.dirname(assignment.checkout), 'c2-plan.json');
  const bytes = JSON.stringify(plan);
  writeFileSync(planFile, bytes);
  return assignment.run({ g2: planFile, index: { ...assignment.options.index, g2PlanSha256: hash(bytes), ...index } });
}
const studioC2Cli = { skip: studioC1Real.skip || studioC2Real.skip };

test('Studio C2 CLI rejects a supplied plan that was never pinned; missing plan remains a typed C2 stop', studioC2Cli, () => {
  const assignment = c1Assignment();
  const report = assignment.run();
  assert.equal(report.code, 'STUDIO_C2_REQUIRED');
  assert.equal(report.g2, undefined);
  const supplied = c2Invoke(assignment, c2PlanFixture(assignment), { g2PlanSha256: undefined });
  assert.equal(supplied.code, 'G2_PLAN_UNTRUSTED', JSON.stringify(supplied.checks));
  assert.deepEqual(supplied.g2.commands, []);
});

test('Studio C2 CLI cannot fall back to an exact approved legacy-shape G2 v1 plan', studioC2Cli, () => {
  const assignment = c1Assignment();
  const { studio, ...plan } = c2PlanFixture(assignment);
  const report = c2Invoke(assignment, { ...plan, schemaVersion: 1 });
  assert.equal(report.code, 'G2_PLAN_INVALID', JSON.stringify(report.checks));
  assert.deepEqual(report.g2.commands, []);
});

test('Studio C2 CLI stops on a stale plan graph digest despite a fresh same-head C1 build', studioC2Cli, () => {
  const assignment = c1Assignment();
  const plan = c2PlanFixture(assignment);
  const report = c2Invoke(assignment, { ...plan, studio: { ...plan.studio, rendererGraphSha256: '0'.repeat(64) } });
  assert.equal(report.code, 'STUDIO_C2_GRAPH_MISMATCH', JSON.stringify(report.checks));
  assert.deepEqual(report.g2.commands, []);
});

test('Studio C2 CLI stops when the protected assignment card is revoked', studioC2Cli, () => {
  const assignment = c1Assignment();
  const report = c2Invoke(assignment, c2PlanFixture(assignment), { cards: [] });
  assert.equal(report.code, 'CARD_STALE', JSON.stringify(report.checks));
  assert.equal(report.g2, undefined);
});

test('Studio C2 CLI rejects a dirty linked fixture execution tree before loading tools or spawning', studioC2Cli, () => {
  const assignment = c1Assignment();
  const executionRoot = path.join(path.dirname(assignment.checkout), 'ex');
  git(assignment.checkout, 'worktree', 'add', '-q', '--detach', executionRoot, studioHead);
  // Private test fixture only; an extra empty directory is invisible to Git status.
  mkdirSync(path.join(executionRoot, 'unapproved-empty'));
  const report = c2Invoke(assignment, { ...c2PlanFixture(assignment), executionRoot });
  assert.equal(report.code, 'WORKTREE_DIRTY', JSON.stringify(report.checks));
  assert.deepEqual(report.g2.commands, []);
});

const c2StageBuild = process.env.ORANGE_TEST_STUDIO_C2_STAGE_BUILD;
const c2StageInputs = process.env.ORANGE_TEST_STUDIO_C2_STAGE_INPUTS;
const c2StageHost = process.env.ORANGE_TEST_STUDIO_C2_STAGE_HOST;
const studioC2StageReal = { skip: studioC2Cli.skip || !(c2StageBuild && c2StageInputs && c2StageHost)
  && 'requires the exact local C2 material and SDK feed tables' };

async function c2StageDrift(inject) {
  const assignment = c1Assignment();
  const area = path.join(path.dirname(assignment.checkout), 'p');
  mkdirSync(area);
  const exec = path.join(area, 'ex');
  git(assignment.checkout, 'worktree', 'add', '-q', '--detach', exec, studioHead);
  const approval = c2PlanFixture(assignment);
  const host = exactC2Record(c2StageHost, 'e942ad52393c6f55b8c241d91c57d31db8a5e8e87de922d6a7270fc59bcf5f4f');
  const plan = { ...approval, executionRoot: exec,
    executableInputs: { path: c2StageInputs, sha256: 'bba0da3482a8595967d3260ef7010a3bed67f332adec01394a2e908b1f17c1d6' },
    studio: { ...approval.studio, buildOutputs: {
      path: c2StageBuild, sha256: '4959623231af369a744e11481cfc5942f5cc2e099263b2c1058c92eb19435487',
    } },
    // Intentionally no executable package donor and no desktop authorization:
    // if the transitive check misses drift, the test stops before materializing.
    tools: host.tools, nugetFeed: host.nugetFeed,
  };
  const planFile = path.join(path.dirname(assignment.checkout), 'r2-plan.json');
  const bytes = JSON.stringify(plan);
  writeFileSync(planFile, bytes, { flag: 'wx' });
  let observed = false;
  const report = await assignment.run({ g2: planFile, index: {
    ...assignment.options.index, g2PlanSha256: hash(bytes),
  }, async observe({ child }) {
    const first = path.join(plan.outputRoot, 'node-version.stdout');
    const limit = Date.now() + 190_000;
    while (!existsSync(first) && child.exitCode === null && Date.now() < limit) await delay(5);
    assert.equal(readFileSync(first, 'utf8').trim(), 'v24.22.1');
    inject({ area, output: plan.outputRoot, host });
    observed = true;
  } });
  assert.equal(observed, true);
  assert.equal(report.g2.commands[0].id, 'node-version');
  assert.equal(report.g2.commands[0].exitCode, 0);
  assert.equal(readFileSync(report.g2.commands[0].stdout.file, 'utf8').trim(), 'v24.22.1');
  assert.equal(report.g2.commands.some(({ id }) => id.startsWith('windows-')), false);
  return report;
}

test('Studio C2 R2 protected first command does not allow an extra empty nested output directory', studioC2StageReal, async (t) => {
  const report = await c2StageDrift(({ output }) => mkdirSync(path.join(output, 'home', 'unreviewed-empty')));
  t.diagnostic(JSON.stringify({ code: report.code, commands: report.g2.commands }));
  assert.equal(report.code, 'G2_EVIDENCE_MUTATED');
});
test('Studio C2 R2 protected first command does not allow changed raw git control bytes', studioC2StageReal, async (t) => {
  const report = await c2StageDrift(({ output }) => writeFileSync(path.join(output, 'home', 'gitconfig'), '# unreviewed\n'));
  t.diagnostic(JSON.stringify({ code: report.code, commands: report.g2.commands }));
  assert.equal(report.code, 'G2_EVIDENCE_MUTATED');
});
test('Studio C2 R2 protected first command does not allow a newly discoverable ancestor targets file', studioC2StageReal, async (t) => {
  const report = await c2StageDrift(({ area }) => save(area, 'Directory.Build.targets',
    '<Project><PropertyGroup><PrivateC2Probe>unreviewed</PrivateC2Probe></PropertyGroup></Project>\n'));
  t.diagnostic(JSON.stringify({ code: report.code, commands: report.g2.commands }));
  assert.equal(report.code, 'G2_ANCESTOR_CONFIG');
});



function studioOutputFixture() {
  const output = mkdtempSync(path.join(root, 'c2-deep-output-'));
  for (const name of ['home/local', 'home/roaming', 'tmp']) mkdirSync(path.join(output, name), { recursive: true });
  const state = { seals: new Map(), resultsReady: false };
  const seal = (name, value) => {
    writeFileSync(path.join(output, name), value);
    state.seals.set(name, hash(value));
  };
  seal('home/gitconfig', '');
  seal('nuget.config', 'fixed test NuGet config\n');
  seal('csc-k07.cmd', 'fixed test shim\n');
  return { output, state, seal };
}

test('Studio C2 R2 output verification rejects deep file, empty directory, junction and both compilation control replacements', async () => {
  const { verifyStudioG2Evidence } = await import(g4Module);
  const cases = [
    (out) => save(out, 'home/local/unreviewed.txt', 'fixture'),
    (out) => mkdirSync(path.join(out, 'home/roaming/unreviewed-empty')),
    (out) => symlinkSync(path.join(out, 'home'), path.join(out, 'tmp/unreviewed-junction'), 'junction'),
    (out) => save(out, 'nuget.config', 'changed config'),
    (out) => save(out, 'csc-k07.cmd', 'changed shim'),
  ];
  for (const change of cases) {
    const { output, state } = studioOutputFixture();
    const verify = () => verifyStudioG2Evidence(output, [], state, 'contracts-dotnet-restore', false);
    assert.doesNotThrow(verify);
    change(output);
    assert.throws(verify, { gateCode: 'G2_EVIDENCE_MUTATED' });
  }
});

test('Studio C2 R2 output verification rejects files in the exact post-restore artifact tree', studioC2StageReal, async () => {
  const { verifyStudioG2Evidence } = await import(g4Module);
  const { output, state, seal } = studioOutputFixture();
  const host = exactC2Record(c2StageHost, 'e942ad52393c6f55b8c241d91c57d31db8a5e8e87de922d6a7270fc59bcf5f4f');
  const actual = path.join(path.dirname(host.nugetFeed.path), 'out');
  const copy = (relative, filter = () => true) => {
    const walk = (from, name) => {
      const to = path.join(output, name);
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const file = name + '/' + entry.name;
        if (!filter(file)) continue;
        const src = path.join(from, entry.name);
        if (entry.isDirectory()) walk(src, file);
        else copyFileSync(src, path.join(output, file));
      }
    };
    walk(path.join(actual, relative), relative);
  };
  copy('home');
  copy('out', (name) => !name.startsWith('out/bin') && !name.startsWith('out/obj/Orange.Contracts.Tests/debug'));
  seal('packages.lock.json', readFileSync(path.join(actual, 'packages.lock.json')));
  const stub = (name) => {
    const file = path.join(output, name);
    writeFileSync(file, '');
    return { file, sha256: hash('') };
  };
  // Command metadata is synthetic for this unit guard test; filesystem shape
  // and contents come from the independently generated K07 witness.
  const commands = [{ id: 'contracts-dotnet-restore', exitCode: 0, stdout: stub('restore.stdout'), stderr: stub('restore.stderr') }];
  const verify = () => verifyStudioG2Evidence(output, commands, state, 'contracts-dotnet-test', false);
  assert.doesNotThrow(verify);
  save(output, 'out/obj/Orange.Contracts.Tests/unreviewed.dll', 'not a compiled artifact');
  assert.throws(verify, { gateCode: 'G2_EVIDENCE_MUTATED' });
});



async function studioRestoreVerifier() {
  const imported = await import(g4Module);
  if (imported.sealStudioG2Restore) return imported.sealStudioG2Restore;
  // Test-first compatibility with exact R2: change visibility only, not the
  // production function body, and never call its candidate CLI.
  const bytes = readFileSync(gate);
  assert.equal(hash(bytes), '8ea608aa4781eff5d166616d98a02054509ae33317a8814539b3780e968e549f');
  const folder = mkdtempSync(path.join(root, 'r3-r2-helper-'));
  for (const name of ['check-imports.mjs', 'check-admission.mjs']) {
    copyFileSync(fileURLToPath(new URL('../../tools/ci/' + name, import.meta.url)), path.join(folder, name));
  }
  const module = path.join(folder, 'check-candidate.mjs');
  writeFileSync(module, Buffer.concat([bytes, Buffer.from('\nexport { sealStudioG2Restore };\n')]));
  return (await import(new URL('file:///' + module.replaceAll('\\', '/')))).sealStudioG2Restore;
}
function studioRestoreFixture(label, which = 'd', prefixRoots = false) {
  const host = exactC2Record(c2StageHost, 'e942ad52393c6f55b8c241d91c57d31db8a5e8e87de922d6a7270fc59bcf5f4f');
  const witness = which === 'd' ? path.dirname(host.nugetFeed.path) : path.join(path.dirname(c2StageHost), 'r2k-AgrZN5');
  const original = realpathSync.native(path.join(witness, which === 'd' ? 'out' : 'o'));
  const originalExec = realpathSync.native(path.join(witness, 'src'));
  const area = mkdtempSync(path.join(root, label));
  const execRoot = prefixRoots ? path.join(area, 'root') : originalExec;
  if (prefixRoots) mkdirSync(execRoot);
  const output = path.join(area, prefixRoots ? 'root-a' : 'out');
  mkdirSync(output);
  const copy = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) copy(path.join(from, entry.name), path.join(to, entry.name));
      else copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    }
  };
  copy(path.join(original, 'home'), path.join(output, 'home'));
  const obj = 'out/obj/Orange.Contracts.Tests';
  mkdirSync(path.join(output, obj), { recursive: true });
  for (const entry of readdirSync(path.join(original, obj), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    let bytes = readFileSync(path.join(original, obj, entry.name), 'utf8');
    const json = /\.(?:json|cache)$/.test(entry.name);
    // This fixture rebases trusted raw paths, never computes expected digests
    // and never executes the copied output.
    for (const [old, next] of [[original, output], [originalExec, execRoot]].sort(([a], [b]) => b.length - a.length)) {
      const encode = (name) => json ? JSON.stringify(name).slice(1, -1) : name;
      bytes = bytes.replaceAll(encode(old), encode(next));
    }
    writeFileSync(path.join(output, obj, entry.name), bytes);
  }
  const lock = readFileSync(path.join(original, 'packages.lock.json'));
  writeFileSync(path.join(output, 'packages.lock.json'), lock);
  return { output, execRoot, host, state: { seals: new Map() }, nativeLock: JSON.parse(lock).dependencies['net10.0'], obj };
}

test('Studio C2 R3 restore verifies both independent rebased witnesses and longest overlapping physical path forms', studioC2StageReal, async () => {
  const verify = await studioRestoreVerifier();
  for (const [which, overlapping] of [['c', false], ['d', false], ['d', true]]) {
    const c = studioRestoreFixture('restore-clean-', which, overlapping);
    assert.doesNotThrow(() => verify(c.output, c.state, c.host, c.nativeLock, c.execRoot));
    assert.equal(c.state.seals.size, 364); // 358 package files + 5 metadata + the independently verified lock.
  }
});
test('Studio C2 R3 restore rejects a same-path ordinary assets version change before first sealing', studioC2StageReal, async () => {
  const verify = await studioRestoreVerifier();
  const c = studioRestoreFixture('restore-json-');
  const file = path.join(c.output, c.obj, 'project.assets.json');
  const good = readFileSync(file, 'utf8');
  assert.match(good, /"version": 4,/);
  writeFileSync(file, good.replace(/"version": 4,/, '"version": 9,'));
  assert.throws(() => verify(c.output, c.state, c.host, c.nativeLock, c.execRoot), { gateCode: 'G2_RESTORE_LOCK_INVALID' });
});
test('Studio C2 R3 restore rejects changed extracted DLL bytes with the original archive still intact', studioC2StageReal, async () => {
  const verify = await studioRestoreVerifier();
  const c = studioRestoreFixture('restore-cache-');
  const file = path.join(c.output, 'home/packages/xunit.assert/2.9.3/lib/net6.0/xunit.assert.dll');
  const bytes = readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(file, bytes); // Byte-level comparison only: never load or execute this changed fixture.
  assert.throws(() => verify(c.output, c.state, c.host, c.nativeLock, c.execRoot), { gateCode: 'G2_RESTORE_LOCK_INVALID' });
});
test('Studio C2 R3 restore rejects preexisting normalization tokens and noncanonical dynamic cache values', studioC2StageReal, async () => {
  const verify = await studioRestoreVerifier();
  for (const value of ['<OUTPUT>', 'AAAAAAAAAAB=']) {
    const c = studioRestoreFixture('restore-token-');
    const file = path.join(c.output, c.obj, 'project.nuget.cache');
    const good = readFileSync(file, 'utf8');
    assert.match(good, /"dgSpecHash": "[A-Za-z0-9+/]{11}="/);
    writeFileSync(file, good.replace(/"dgSpecHash": "[A-Za-z0-9+/]{11}="/, '"dgSpecHash": "' + value + '"'));
    assert.throws(() => verify(c.output, c.state, c.host, c.nativeLock, c.execRoot), { gateCode: 'G2_RESTORE_LOCK_INVALID' });
  }
});
test('Studio C2 R3 restore permits only the canonical eight-byte dynamic hash slot to vary', studioC2StageReal, async () => {
  const verify = await studioRestoreVerifier();
  const c = studioRestoreFixture('restore-dynamic-');
  const file = path.join(c.output, c.obj, 'project.nuget.cache');
  const good = readFileSync(file, 'utf8');
  writeFileSync(file, good.replace(/"dgSpecHash": "[A-Za-z0-9+/]{11}="/, '"dgSpecHash": "AAAAAAAAAAA="'));
  assert.doesNotThrow(() => verify(c.output, c.state, c.host, c.nativeLock, c.execRoot));
});


test('Studio C2 R4 restore retains the verified raw observation across sealing and rejects changed data at the next guard', studioC2StageReal, async () => {
  const seal = await studioRestoreVerifier();
  const { verifyStudioG2Evidence } = await import(g4Module);
  const mutable = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const c = studioRestoreFixture('restore-handoff-');
  mkdirSync(path.join(c.output, 'tmp'));
  const relative = c.obj + '/project.assets.json', file = path.join(c.output, relative);
  const original = readFileSync(file);
  const changed = Buffer.from(original.toString().replace(/"version": 4,/, '"version": 9,'));
  assert.notDeepEqual(original, changed);
  const originalRead = mutable.readFileSync;
  let changedDuringReread = false;
  mutable.readFileSync = function (candidate, ...args) {
    if (typeof candidate === 'string' && path.resolve(candidate) === file && !changedDuringReread) {
      writeFileSync(file, changed); // Inert ordinary JSON only, never execute altered content.
      changedDuringReread = true;
    }
    return originalRead.call(mutable, candidate, ...args);
  };
  syncBuiltinESMExports();
  try { seal(c.output, c.state, c.host, c.nativeLock, c.execRoot); }
  finally { mutable.readFileSync = originalRead; syncBuiltinESMExports(); }
  if (!changedDuringReread) writeFileSync(file, changed);
  const report = (name) => {
    const file = path.join(c.output, name);
    writeFileSync(file, '');
    return { file, sha256: hash('') };
  };
  // Unit metadata only; no synthetic report is passed to the candidate CLI.
  const commands = [{ id: 'contracts-dotnet-restore', exitCode: 0,
    stdout: report('restore.stdout'), stderr: report('restore.stderr') }];
  let reason;
  try { verifyStudioG2Evidence(c.output, commands, c.state, 'contracts-dotnet-test', false); }
  catch (error) { reason = error.gateCode; }
  assert.deepEqual({ sealed: c.state.seals.get(relative), reason },
    { sealed: hash(original), reason: 'G2_EVIDENCE_MUTATED' },
    'a second read cannot replace independently checked raw bytes with a new expectation');
});



function c1PackageManifest() {
  const bytes = readFileSync(c1Packages);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), c1PackageSha);
  return JSON.parse(bytes.toString('utf8'));
}
function c1BuildArea(t, name) {
  const parent = realpathSync.native(c1Scratch);
  const area = mkdtempSync(path.join(parent, name + '-'));
  t.after(() => {
    assert.equal(realpathSync.native(area), area);
    assert.equal(path.dirname(area), parent);
    rmSync(area, { recursive: true });
  });
  return area;
}
async function observeC1Mirror(scratch, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && child.exitCode === null) {
    for (const name of readdirSync(scratch)) {
      if (!name.startsWith('orange-studio-c1-')) continue;
      const workspace = path.join(scratch, name);
      const roots = [path.join(workspace, 'auth/renderer'), path.join(workspace, 'studio/page')];
      if (roots.every((dir) => existsSync(path.join(dir, 'index.html')))) {
        assert.equal(realpathSync.native(workspace), workspace);
        assert.equal(existsSync(path.join(workspace, 'input.json')), false, 'test missed the pre-worker window');
        return roots;
      }
    }
    await delay(25);
  }
  assert.fail('protected worker mirror did not appear');
}

test('Studio C1 reconstructs both exact renderers, ignores config tripwires, and stops before C2', studioC1Real, async (t) => {
  const profileBytes = readFileSync(c1Profile);
  assert.equal(createHash('sha256').update(profileBytes).digest('hex'), c1ProfileSha);
  const expectedBuilds = JSON.parse(profileBytes.toString('utf8')).builds;
  const { run, options } = c1Assignment();
  const scratch = c1BuildArea(t, 'sentinels');
  const report = await run({
    g3: path.join(root, 'not-g3'), review: path.join(root, 'not-g4'),
    graph: [...options.graph.slice(0, -1), scratch],
    async observe({ child }) {
      for (const dir of await observeC1Mirror(scratch, child)) {
        save(dir, 'vite.config.mjs', 'throw new Error("ORANGE_C1_CONFIG_TRIPWIRE");\n');
        save(dir, '.env.production', 'VITE_ORANGE_TRIPWIRE=DO_NOT_READ\n');
        save(dir, 'public/tripwire.txt', 'DO_NOT_COPY\n');
      }
    },
  });
  assert.equal(report.code, 'STUDIO_C2_REQUIRED', JSON.stringify(report));
  assert.deepEqual(report.checks.find(({ id }) => id === 'import-build-graph'),
    { id: 'import-build-graph', status: 'passed', exitCode: 0 });
  assert.deepEqual(report.checks.find(({ id }) => id === 'imports'),
    { id: 'imports', status: 'passed', exitCode: 0 });
  const graphMatrix = (builds) => builds.map(({ track, graphSha256, artifacts }) => [track, graphSha256, artifacts.length]);
  assert.deepEqual(graphMatrix(report.rendererGraph.builds), graphMatrix(expectedBuilds));
  assert.deepEqual(report.rendererGraph.builds.map(({ artifacts }) => artifacts.length), [3, 10]);
  assert.equal(report.rendererGraph.builds[1].artifacts.filter(({ name }) => name.endsWith('.woff2')).length, 7);
  assert.equal(report.rendererGraph.builds[1].artifacts.find(({ name }) => name.endsWith('.js')).sha256,
    'c0e735aad4a51d43e0e86476278598ac9f5acd07889860eb50ba6c8ebe28e2b2');
  assert.deepEqual(report.checks.filter(({ id }) => !['write-set', 'imports', 'import-build-graph'].includes(id))
    .map(({ status, exitCode }) => [status, exitCode]), Array.from({ length: 6 }, () => ['unavailable', null]));
  t.diagnostic(JSON.stringify(report));
});

test('Studio C1 rejects half inputs, recipe without approval, and the legacy Auth profile', studioC1Real, () => {
  const { run, options } = c1Assignment();
  assert.equal(run({ graph: options.graph.slice(0, 2) }).code, 'STUDIO_DUAL_GRAPH_REQUIRED');
  assert.equal(run({ index: {} }).code, 'STUDIO_C1_APPROVAL_REQUIRED');
  const legacy = process.env.ORANGE_TEST_AUTH_GRAPH_PROFILE;
  assert.ok(legacy, 'exact historical Auth profile fixture required');
  assert.equal(run({ graph: [options.graph[0], legacy, ...options.graph.slice(2)] }).code, 'STUDIO_C1_PROFILE_UNTRUSTED');
});

test('Studio C1 cannot reclassify a changed committed projection or use scratch inside the candidate', studioC1Real, () => {
  const { run, options, checkout, gitHere, commitHere } = c1Assignment();
  assert.equal(run({ graph: [...options.graph.slice(0, -1), checkout] }).code, 'STUDIO_C1_PATH_UNSAFE');
  const probe = 'apps/desktop/renderer/features/creation/StudioProbe.tsx';
  save(checkout, probe, readFileSync(path.join(checkout, probe), 'utf8') + '\n// changed projection\n');
  gitHere('add', '--', probe);
  commitHere();
  assert.equal(run().code, 'STUDIO_C1_SUBJECT_MISMATCH');
});

test('Studio C1 rejects a changed package byte and a retargeted peer junction', studioC1Real, (t) => {
  const { run, options } = c1Assignment();
  const area = c1BuildArea(t, 'package-negatives');
  const donor = path.join(area, 'donor');
  const scratch = path.join(area, 'scratch');
  mkdirSync(scratch);
  const manifest = c1PackageManifest();
  for (const pkg of manifest.packages) {
    for (const file of pkg.files) {
      const name = pkg.physical + '/' + file.path;
      const dest = path.join(donor, name);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(path.join(c1Donor, name), dest);
    }
  }
  const makeJunction = ({ path: name, target }) => {
    const link = path.join(donor, name);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(donor, target), link, 'junction');
  };
  for (const link of manifest.links) makeJunction(link);
  const graph = [...options.graph.slice(0, 5), donor, '--graph-scratch', scratch];
  const pkg = manifest.packages[0];
  const entry = pkg.files.find(({ bytes }) => bytes > 0);
  const name = pkg.physical + '/' + entry.path;
  const bytes = readFileSync(path.join(donor, name));
  bytes[0] ^= 1;
  save(donor, name, bytes);
  const changed = run({ graph });
  assert.equal(changed.code, 'STUDIO_C1_PACKAGE_MISMATCH', JSON.stringify(changed));
  assert.equal(changed.rendererGraph, undefined);
  copyFileSync(path.join(c1Donor, name), path.join(donor, name));
  const link = manifest.links.find(({ path: name }) => name.endsWith('/lightningcss'));
  const wrong = manifest.packages.find(({ physical }) => physical !== link.target && physical.endsWith('/lightningcss'));
  assert.ok(wrong, 'test requires the second lightningcss peer slot');
  unlinkSync(path.join(donor, link.path));
  makeJunction({ ...link, target: wrong.physical });
  const retargeted = run({ graph });
  assert.equal(retargeted.code, 'STUDIO_C1_PACKAGE_MISMATCH', JSON.stringify(retargeted));
  assert.equal(retargeted.rendererGraph, undefined);
});

test('Studio C1 does not report a graph when the assignment changes during the protected build', studioC1Real, async (t) => {
  const { run, options } = c1Assignment();
  const scratch = c1BuildArea(t, 'approval-drift');
  const report = await run({
    graph: [...options.graph.slice(0, -1), scratch],
    async observe({ child, control }) {
      await observeC1Mirror(scratch, child);
      const index = path.join(path.dirname(control), 'index.json');
      const changed = JSON.parse(readFileSync(index, 'utf8'));
      changed.studioRendererApproval.profileSha256 = '0'.repeat(64);
      writeFileSync(index, JSON.stringify(changed));
    },
  });
  assert.equal(report.code, 'CARD_STALE', JSON.stringify(report));
  assert.equal(report.rendererGraph, undefined);
  assert.equal(report.checks.find(({ id }) => id === 'import-build-graph').status, 'failed');
});


test('Studio C1 ignores an invalid inherited Windows root when starting the protected worker', studioC1Real, (t) => {
  const { run } = c1Assignment();
  // Keep native Node startup on the real host; this test-only preload changes
  // the environment visible to the gate, not the Node bootstrap environment.
  const bootstrap = 'data:text/javascript,' + encodeURIComponent(
    'process.env.SystemRoot = process.env.WINDIR = "not-a-Windows-root";');
  const report = run({ nodeArgs: ['--import', bootstrap] });
  assert.equal(report.code, 'STUDIO_C2_REQUIRED', JSON.stringify(report));
  assert.equal(report.rendererGraph.artifactSha256, '528638c9ed8517627f6ece68a6573e6b9d315194563a6d6ba79a4cac6f8cc8ba');
  t.diagnostic('worker ignored both invalid inherited Windows root values and matched both actual renderers');
});

test('Studio C1 rejects replacement of its exact source pack by an equivalent loose store during the build', studioC1Real, async (t) => {
  const { run, options } = c1Assignment();
  const area = c1BuildArea(t, 'pack-continuity');
  const source = path.join(area, 'source');
  const gitDir = path.join(source, '.git');
  const expanded = path.join(area, 'expanded.git');
  const scratch = path.join(area, 'scratch');
  mkdirSync(scratch);
  for (const dir of [gitDir, expanded]) {
    mkdirSync(path.join(dir, 'objects'), { recursive: true });
    mkdirSync(path.join(dir, 'refs'));
    writeFileSync(path.join(dir, 'HEAD'), studioPin + '\n');
    writeFileSync(path.join(dir, 'shallow'), studioPin + '\n');
    writeFileSync(path.join(dir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
  }
  const stem = 'pack-1a9724bd90ba2ea35f8186cc6c0b439dba53cf2f';
  const packDir = path.join(gitDir, 'objects', 'pack');
  mkdirSync(packDir);
  for (const ext of ['idx', 'pack']) {
    const name = stem + '.' + ext;
    copyFileSync(path.join(studioPinnedSource, '.git', 'objects', 'pack', name), path.join(packDir, name));
  }
  const pack = readFileSync(path.join(packDir, stem + '.pack'));
  assert.equal(createHash('sha256').update(pack).digest('hex'), '7f29a83a4d2f020ea4e6a78d7f80581919573bd792235748bfe0c9a6f3f26864');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(area, 'empty-config'),
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' });
  const unpack = spawnSync('C:/Program Files/Git/ucrt64/bin/git.exe', [
    '--no-replace-objects', '--no-optional-locks', '--git-dir=' + expanded, '-c', 'protocol.allow=never', 'unpack-objects',
  ], { cwd: area, env, input: pack, windowsHide: true, timeout: 30_000 });
  assert.equal(unpack.status, 0, unpack.stderr?.toString());
  const replacement = path.join(expanded, 'objects');
  assert.equal(realpathSync.native(replacement), replacement);
  assert.ok(readdirSync(replacement).some((name) => /^[a-f0-9]{2}$/.test(name)), 'fixture must contain loose Git objects');
  const report = await run({
    studio: source, graph: [...options.graph.slice(0, -1), scratch],
    async observe({ child }) {
      await observeC1Mirror(scratch, child);
      const packed = path.join(gitDir, 'objects');
      assert.equal(realpathSync.native(packed), packed);
      assert.equal(path.relative(area, packed), path.join('source', '.git', 'objects'));
      assert.equal(path.relative(area, replacement), path.join('expanded.git', 'objects'));
      renameSync(packed, path.join(gitDir, 'packed-before-build'));
      renameSync(replacement, packed);
    },
  });
  assert.equal(report.code, 'STUDIO_SOURCE_PACK_UNAVAILABLE', JSON.stringify(report));
  assert.equal(report.rendererGraph, undefined);
  t.diagnostic('C1 rejected a real same-pin same-tree loose source store after its packed projection completed');
});

test('Studio C1 rejects genuine final JS divergence and a missing WOFF2 through the worker and CLI', studioC1Real, async (t) => {
  const { run, options } = c1Assignment();
  const manifest = c1PackageManifest();
  const inter = manifest.packages.find(({ id }) => id === '@fontsource-variable/inter@5.3.0');
  const afterInter = manifest.packages[manifest.packages.indexOf(inter) + 1];
  assert.ok(inter && afterInter !== inter);
  for (const variation of ['same-graph-js', 'missing-font']) {
    const scratch = c1BuildArea(t, variation);
    const report = await run({
      graph: [...options.graph.slice(0, -1), scratch],
      async observe({ child }) {
        const [, studio] = await observeC1Mirror(scratch, child);
        const workspace = path.resolve(studio, '../..');
        assert.equal(path.dirname(workspace), scratch);
        if (variation === 'same-graph-js') {
          // No new import or module. Vite really emits different JS; it is never executed.
          const probe = path.join(studio, 'probe.tsx');
          writeFileSync(probe, '\ndocument.documentElement.dataset.orangeC1FinalBytes = "different";\n', { flag: 'a' });
          return;
        }
        const marker = path.join(workspace, 'deps', afterInter.physical, afterInter.files[0].path);
        const deadline = Date.now() + 40_000;
        while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await delay(15);
        assert.ok(existsSync(marker), 'verified font package was not staged');
        assert.equal(existsSync(path.join(workspace, 'input.json')), false, 'test missed the pre-worker window');
        const stylesheet = path.join(workspace, 'deps', inter.physical, 'index.css');
        const bytes = readFileSync(stylesheet, 'utf8');
        const withoutFirstFont = bytes.replace(/^\/\* inter-cyrillic-ext-wght-normal \*\/\r?\n@font-face \{[^}]+\}\r?\n/, '');
        assert.notEqual(withoutFirstFont, bytes);
        assert.equal((withoutFirstFont.match(/\.woff2/g) ?? []).length, 6);
        writeFileSync(stylesheet, withoutFirstFont);
      },
    });
    assert.equal(report.code, 'STUDIO_C1_ARTIFACT_MISMATCH', JSON.stringify(report));
    assert.equal(report.rendererGraph, undefined);
    assert.equal(report.checks.find(({ id }) => id === 'import-build-graph').status, 'failed');
    t.diagnostic(variation + ': genuine protected Vite output rejected by CLI, graph never marked passed');
  }
});

test('Studio C0 cannot use a post-E0 base, missing source, or candidate checkout as source to downgrade', studioReal, () => {
  const { run, checkout } = exactStudioCandidate();
  const base = '05a3bb5687454b62b0205dee22e0d8de219ac941';
  const good = { writeSet: ['apps/desktop/main/index.ts', 'docs/adr/0003-film-entry.md', 'package.json',
    'packages/film-adapter/package.json', 'packages/film-adapter/src/node.ts', 'tests/windows/studio-smoke.test.mjs'] };
  assert.equal(run(base, good).code, 'STUDIO_SOURCE_REQUIRED');
  assert.equal(run(base, { ...good, studio: repo }).code, 'STUDIO_SOURCE_COMMIT_UNAVAILABLE');
  assert.equal(run(base, { ...good, studio: path.join(checkout, studioLink) }).code, 'STUDIO_SOURCE_PATH_UNSAFE');
  assert.equal(run(base, { ...good, studio: studioPinnedSource }).code, 'STUDIO_DUAL_GRAPH_REQUIRED');
});

test('Studio C0 rejects a real removal even with no source flags and a later chosen base', studioReal, () => {
  const { start, checkout, gitHere, commitHere, append, run } = exactStudioCandidate(studioE0);
  gitHere('update-index', '--force-remove', '--', studioLink);
  gitHere('rm', '--', '.gitmodules');
  const removed = commitHere();
  if (existsSync(path.join(checkout, studioLink))) rmdirSync(path.join(checkout, studioLink));
  if (existsSync(path.join(checkout, 'vendor'))) rmdirSync(path.join(checkout, 'vendor'));
  append();
  for (const base of [start, removed]) assert.equal(run(base).code, 'STUDIO_REFERENCE_HISTORY_INVALID');
});

function overwriteLooseObject(common, original, substitute) {
  const object = (oid) => path.join(common, 'objects', oid.slice(0, 2), oid.slice(2));
  chmodSync(object(original), 0o600);
  writeFileSync(object(original), readFileSync(object(substitute)));
}

test('Studio C0 rejects a forged historical commit under the original OID before lane selection', studioReal, () => {
  const { start, common, checkout, gitHere, commitHere, append, run } = exactStudioCandidate(studioE0);
  gitHere('update-index', '--force-remove', '--', studioLink);
  gitHere('rm', '--', '.gitmodules');
  const removed = commitHere();
  if (existsSync(path.join(checkout, studioLink))) rmdirSync(path.join(checkout, studioLink));
  if (existsSync(path.join(checkout, 'vendor'))) rmdirSync(path.join(checkout, 'vendor'));
  append();
  assert.equal(run(removed).code, 'STUDIO_REFERENCE_HISTORY_INVALID');
  assert.equal(gitHere('rev-parse', removed + '^'), start);
  const forged = gitHere('commit-tree', gitHere('rev-parse', removed + '^{tree}'), '-m', 'forged orphan');
  overwriteLooseObject(common, removed, forged);
  const report = run(removed);
  assert.equal(report.code, 'STUDIO_CANDIDATE_PROVENANCE_UNAVAILABLE');
  assert.equal(report.checks[1].status, 'not-run');
});

test('Studio C0 rejects a forged historical tree under the original OID before lane selection', () => {
  const { start, common, gitHere, commitHere, append, run } = candidateRepo();
  gitHere('update-index', '--add', '--cacheinfo', '160000,' + start + ',vendor/foreign');
  const introduced = commitHere();
  gitHere('update-index', '--force-remove', '--', 'vendor/foreign');
  const removed = commitHere();
  append();
  assert.equal(run(removed).code, 'UNSAFE_GIT_MODE');
  overwriteLooseObject(common, gitHere('rev-parse', introduced + '^{tree}'), gitHere('rev-parse', start + '^{tree}'));
  const report = run(removed);
  assert.equal(report.code, 'STUDIO_CANDIDATE_PROVENANCE_UNAVAILABLE');
  assert.equal(report.checks[1].status, 'not-run');
});

test('Studio C0 keeps the reviewed gitlink in scope despite local Git submodule ignore settings', studioReal, () => {
  const { gitHere, run } = exactStudioCandidate(studioE0);
  gitHere('config', '--local', 'submodule.vendor/openfilm.ignore', 'all');
  const report = run(studioE0Parent, { writeSet: ['.gitmodules', studioLink], studio: studioPinnedSource });
  assert.equal(report.code, 'STUDIO_DUAL_GRAPH_REQUIRED');
  assert.deepEqual(report.changedFiles, ['.gitmodules', studioLink]);
});

for (const alias of ['.gitmodules::$DATA', 'GITMOD~1']) {
  test('Studio C0 rejects historical protected alias ' + alias + ' before a later selected base', studioReal, () => {
    const { start, checkout, gitHere, append, run } = exactStudioCandidate(studioE0);
    const entries = gitHere('ls-tree', start) + '\n100644 blob ' + studioModulesOid + '\t' + alias + '\n';
    const aliasedTree = execFileSync('git', ['-C', checkout, 'mktree', '--missing'], {
      input: entries, encoding: 'utf8', windowsHide: true,
    }).trim();
    const aliased = gitHere('commit-tree', aliasedTree, '-p', start, '-m', 'historical alias');
    const restored = gitHere('commit-tree', gitHere('rev-parse', start + '^{tree}'), '-p', aliased, '-m', 'restore reference tree');
    gitHere('reset', '--hard', restored);
    append();
    assert.equal(run(restored, { studio: studioPinnedSource }).code, 'STUDIO_REFERENCE_HISTORY_INVALID');
  });
}

for (const [kind, pathName, mode, oid] of [
  ['removal/re-add', studioLink, null, null],
  ['retarget/restore', studioLink, '160000', studioHead],
  ['.gitmodules mode/restore', '.gitmodules', '100755', studioModulesOid],
  ['foreign link', 'vendor/other', '160000', studioPin],
  ['case alias', 'vendor/OPENFILM', '160000', studioPin],
]) {
  test('Studio C0 rejects committed ' + kind + ' before a later selected base', studioReal, () => {
    const { start, gitHere, commitHere, append, run } = exactStudioCandidate(studioE0);
    if (mode) gitHere('update-index', '--add', '--cacheinfo', mode + ',' + oid + ',' + pathName);
    else gitHere('update-index', '--force-remove', '--', pathName);
    const mutation = commitHere();
    assert.notEqual(mutation, start);
    if (pathName === studioLink || pathName === '.gitmodules') {
      const [originalMode, originalOid] = pathName === studioLink ? ['160000', studioPin] : ['100644', studioModulesOid];
      gitHere('update-index', '--add', '--cacheinfo', originalMode + ',' + originalOid + ',' + pathName);
    } else {
      gitHere('update-index', '--force-remove', '--', pathName);
    }
    const restored = commitHere();
    assert.equal(gitHere('rev-parse', restored + '^{tree}'), gitHere('rev-parse', start + '^{tree}'));
    append();
    assert.equal(run(restored, { studio: studioPinnedSource }).code, 'STUDIO_REFERENCE_HISTORY_INVALID');
  });
}

test('Studio C0 verifies the real index and only permits an absent or physical empty gitlink stub', studioReal, () => {
  const { start, checkout, gitHere, append, run } = exactStudioCandidate(studioE0);
  append();
  const stub = path.join(checkout, studioLink);
  if (existsSync(stub)) rmdirSync(stub);
  if (existsSync(path.join(checkout, 'vendor'))) rmdirSync(path.join(checkout, 'vendor'));
  const check = () => run(start, { studio: studioPinnedSource }).code;
  assert.equal(check(), 'STUDIO_DUAL_GRAPH_REQUIRED');
  mkdirSync(stub, { recursive: true });
  assert.equal(check(), 'STUDIO_DUAL_GRAPH_REQUIRED');
  gitHere('update-index', '--add', '--cacheinfo', '160000,' + studioHead + ',' + studioLink);
  assert.equal(check(), 'INDEX_NOT_NORMAL');
  gitHere('update-index', '--add', '--cacheinfo', '160000,' + studioPin + ',' + studioLink);
  save(checkout, studioLink + '/.git', 'gitdir: MUST-NOT-BE-READ\n');
  assert.equal(check(), 'WORKTREE_DIRTY');
  unlinkSync(path.join(stub, '.git'));
  rmdirSync(stub);
  const outside = path.join(root, 'studio-outside-stub');
  mkdirSync(outside);
  symlinkSync(outside, stub, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal(check(), 'WORKTREE_LINK');
  } finally {
    unlinkSync(stub);
  }
  mkdirSync(stub);
  mkdirSync(path.join(checkout, 'unexpected-empty'));
  assert.equal(check(), 'WORKTREE_DIRTY');
  rmdirSync(path.join(checkout, 'unexpected-empty'));
  save(checkout, 'fixture.txt', 'dirty ordinary file\n');
  assert.equal(check(), 'WORKTREE_DIRTY');
});

test('Studio C0 keeps a legacy vendored regular source path on the legacy lane', () => {
  const { start, append, run } = candidateRepo();
  const ordinary = studioLink + '/src/model.js';
  append(ordinary);
  const report = run(start, { writeSet: [ordinary] });
  assert.equal(report.code, 'REQUIRED_CHECK_UNAVAILABLE');
  assert.equal(report.checks[1].status, 'passed');
  assert.equal(report.studioSource, undefined);
});

test('Studio C0 rejects foreign or aliased historical gitlinks outside the selected range', () => {
  for (const pathName of ['vendor/unreviewed', 'vendor/OPENFILM']) {
    const { start, gitHere, commitHere, append, run } = candidateRepo();
    gitHere('update-index', '--add', '--cacheinfo', '160000,' + start + ',' + pathName);
    commitHere();
    gitHere('update-index', '--force-remove', '--', pathName);
    const removed = commitHere();
    append();
    assert.equal(run(removed).code, 'UNSAFE_GIT_MODE');
  }
});

test('Studio C0 rejects immutable-history substitutes before deciding on the legacy lane', () => {
  const { start, common, gitHere, append, run } = candidateRepo();
  const head = append();
  for (const [name, bytes] of [['shallow', head + '\n'], ['info/grafts', head + ' ' + start + '\n']]) {
    save(common, name, bytes);
    assert.equal(run(start).code, 'STUDIO_CANDIDATE_PROVENANCE_UNAVAILABLE');
    unlinkSync(path.join(common, name));
  }
  gitHere('replace', head, start);
  assert.equal(run(start).code, 'STUDIO_CANDIDATE_PROVENANCE_UNAVAILABLE');
});

test('Studio C0 does not accept source-only evidence, lookalike E0, or policy overrides in the candidate CLI', () => {
  const { start, gitHere, commitHere, checkout, run } = candidateRepo();
  save(checkout, '.gitmodules', '[submodule "vendor/openfilm"]\n\tpath = vendor/openfilm\n\turl = https://github.com/jerry-halo2026/openfilm.git\n');
  gitHere('add', '--', '.gitmodules');
  gitHere('update-index', '--add', '--cacheinfo', '160000,' + studioPin + ',' + studioLink);
  commitHere();
  const reportFile = path.join(root, 'not-studio-evidence.json');
  writeFileSync(reportFile, JSON.stringify({ admitted: false, code: 'STUDIO_SOURCE_REFERENCE_VERIFIED' }));
  const input = { writeSet: ['.gitmodules', studioLink] };
  assert.equal(run(start, { ...input, studio: reportFile }).code, 'UNSAFE_GIT_MODE');
  for (const [flag, value] of [['--e0', studioE0], ['--pin', studioPin], ['--studio-source-report', reportFile]]) {
    assert.equal(run(start, { ...input, extra: [flag, value] }).code, 'BAD_ARGUMENTS');
  }
});

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
  const projected = verifyG2Trx(Buffer.from(source), ['shared-fixture'], Date.parse(start), Date.parse(finish), true);
  const freshStart = new Date(Date.parse(start) + 1000).toISOString(), freshFinish = new Date(Date.parse(finish) + 1000).toISOString();
  const rerun = source.replaceAll(id, '22222222-2222-2222-2222-222222222222').replaceAll(start, freshStart).replaceAll(finish, freshFinish);
  const freshProjected = verifyG2Trx(Buffer.from(rerun), ['shared-fixture'], Date.parse(freshStart), Date.parse(freshFinish), true);
  assert.deepEqual(projected.cases, [{ id: 'shared-fixture', outcome: 'Passed' }]);
  assert.deepEqual(freshProjected.cases, projected.cases); assert.notEqual(freshProjected.sha256, projected.sha256);
  assert.throws(() => verifyG2Trx(Buffer.from(source.replace('outcome="Passed"', 'outcome="NotExecuted"')),
    ['shared-fixture'], Date.parse(start), Date.parse(finish), true), { gateCode: 'G2_TRX_INVALID' });
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

// C3 boundary controls exercise unmodified helper bodies in a private module copy.
const c3Materials = process.env.ORANGE_TEST_STUDIO_C3_MATERIALS;
const studioC3Real = { skip: studioReal.skip || !c3Materials && 'requires exact offline C3 inventory materials' };
let c3Module;
async function c3Helpers() {
  if (!c3Module) {
    const folder = mkdtempSync(path.join(root, 'c3-module-'));
    for (const name of ['check-admission.mjs', 'check-imports.mjs', 'check-candidate.mjs']) {
      let source = readFileSync(new URL('../../tools/ci/' + name, import.meta.url), 'utf8');
      if (name === 'check-candidate.mjs') for (const fn of ['g3NpmInventory', 'g3SourceSnapshot']) {
        if (!source.includes('export function ' + fn + '(')) source += '\nexport { ' + fn + ' };\n';
      }
      save(folder, name, source);
    }
    c3Module = await import((await import('node:url')).pathToFileURL(path.join(folder, 'check-candidate.mjs')));
  }
  return c3Module;
}
function c3Inventory(studio) {
  const file = path.join(c3Materials, studio ? 'orange-studio-c3-inventory-from-git/pnpm-inventory.draft.json'
    : 'orange-g3-pnpm-inventory-7c78700d.json');
  return { path: file, sha256: hash(readFileSync(file)) };
}
test('Studio C3 CONTROL: old Auth inventory remains exact61 and wrong Studio lock is refused', studioC3Real, async () => {
  const g = await c3Helpers(), ref = c3Inventory(false);
  assert.equal(g.g3NpmInventory(ref, { sha256: '7c78700dfd15c68a4aadae2bd3e7aa80323030725a3ae2742f98e88d73b76af7' }, []).length, 61);
  assert.throws(() => g.g3NpmInventory(ref, { sha256: '310ba40fbad44925b503b8d850798f691b416b6427c08c7e18cf7a388c759f90' }, []),
    { gateCode: 'G3_INVENTORY_INVALID' });
});
test('Studio C3 derives all100 npm identities from actual Git lock rather than trusting scanner or inventory', studioC3Real, async () => {
  const g = await c3Helpers(), { checkout } = exactStudioCandidate();
  const lockBytes = Buffer.from(execFileSync('git', ['-C', checkout, 'cat-file', 'blob', studioHead + ':pnpm-lock.yaml']));
  const ref = c3Inventory(true), lock = { sha256: hash(lockBytes) };
  const actual = g.g3NpmInventory(ref, lock, [], { studio: true, lockBytes });
  assert.equal(actual.length, 100);
  assert.ok(actual.some(({ name, version }) => name === '@fontsource-variable/inter' && version === '5.3.0'));
});
test('Studio C3 exact tracked snapshot excludes only bound OpenFilm gitlink and preserves Auth refusal', studioC3Real, async () => {
  const g = await c3Helpers(), { checkout } = exactStudioCandidate();
  const tracked = readTree(checkout, studioHead);
  assert.throws(() => g.g3SourceSnapshot(checkout, tracked, path.join(root, 'c3-auth-snapshot')), { gateCode: 'G3_SCOPE_UNSUPPORTED' });
  const result = g.g3SourceSnapshot(checkout, tracked, path.join(root, 'c3-studio-snapshot'),
    { studio: true, pin: studioPin, head: studioHead, tree: studioTree });
  assert.equal(result.entries.length, 74);
  assert.ok(result.entries.every(({ path: name }) => name !== studioLink));
  assert.throws(() => g.g3SourceSnapshot(checkout, tracked, path.join(root, 'c3-wrong-pin'),
    { studio: true, pin: '1'.repeat(40), head: studioHead, tree: studioTree }), { gateCode: 'STUDIO_C3_SOURCE_MISMATCH' });
});

test('Studio C3 rejects inventory content drift even with matching inventory digest', studioC3Real, async () => {
  const g = await c3Helpers(), { checkout } = exactStudioCandidate();
  const lockBytes = execFileSync('git', ['-C', checkout, 'cat-file', 'blob', studioHead + ':pnpm-lock.yaml']);
  const native = JSON.parse(readFileSync(c3Inventory(true).path));
  for (const mutate of [x => x.packages.pop(), x => x.packages[0].version = '0.0.1',
    x => x.packages[0] = x.packages[1], x => x.lockSha256 = '1'.repeat(64)]) {
    const changed = structuredClone(native); mutate(changed);
    const file = path.join(root, 'c3-altered-inventory.json'), bytes = JSON.stringify(changed);
    writeFileSync(file, bytes);
    assert.throws(() => g.g3NpmInventory({ path: file, sha256: hash(bytes) }, { sha256: hash(lockBytes) }, [],
      { studio: true, lockBytes }), { gateCode: 'G3_INVENTORY_INVALID' });
  }
});
function c3CoverageFixture() {
  const entries = [['orange', 74], ['openfilm', 235], ['notices', 3], ['build', 10]].flatMap(([category, count]) =>
    Array.from({ length: count }, (_, i) => ({ path: category + '/file-' + i + '.txt', bytes: 1, sha256: hash('x') })));
  const fonts = Array.from({ length: 7 }, (_, i) => ({ path: 'build/studio/assets/font-' + i + '.woff2',
    packageFile: 'files/font-' + i + '.woff2', bytes: 4, sha256: hash('wOF2') }));
  return { entries, fonts };
}
test('Studio C3 coverage refuses omissions, duplicate aliases and binary-font scan inflation', async () => {
  const g = await import(g4Module), { entries, fonts } = c3CoverageFixture();
  assert.deepEqual(g.verifyStudioG3Coverage(entries, fonts), { files: 322, scans: 644, fonts: 7 });
  for (const rows of [entries.slice(1), [...entries, entries[0]], entries.map((x, i) => i === 1 ? entries[0] : x),
    entries.map((x, i) => i === 0 ? { ...x, path: 'orange/font.woff2' } : x),
    entries.map((x, i) => i === 0 ? { ...x, path: 'orange/../escape.txt' } : x)]) {
    assert.throws(() => g.verifyStudioG3Coverage(rows, fonts), { gateCode: 'STUDIO_C3_COVERAGE_MISMATCH' });
  }
  assert.throws(() => g.verifyStudioG3Coverage(entries, fonts.slice(1)), { gateCode: 'STUDIO_C3_COVERAGE_MISMATCH' });
});
test('Studio C3 workers scan actual fixed original and neutral content privately in deterministic order',
  { skip: !g3Tooling && 'requires approved offline scanner' }, async () => {
    const g = await import(g4Module), output = mkdtempSync(path.join(root, 'c3-workers-'));
    const snapshot = path.join(output, 'snapshot'); mkdirSync(snapshot);
    const entries = ['z.svg', 'a.txt', 'pnpm-lock.yaml'].map(name => {
      save(snapshot, name, 'clean fixture\n');
      return { path: name, bytes: 14, sha256: hash('clean fixture\n') };
    });
    await c3SlotSetup();
    const control = path.join(output, 'control.json'); writeFileSync(control, 'active');
    const receipts = await g.runStudioG3Workers({ entries, snapshot, output, ref: g3ToolRefs(g3Tooling).gitleaks,
      protectedRoots: [output], checkControl: () => 20_000, controls: [[control, hash('active')]],
      job: studioJobSetup.job, tools: studioJobSetup.tools, deadline: Date.now() + 20_000, workers: 2 });
    assert.deepEqual(receipts.map(x => x.path), ['a.txt', 'pnpm-lock.yaml', 'z.svg']);
    assert.ok(receipts.every(x => x.scans.length === 2 && x.scans.every(y => y.exitCode === 0 && y.findings.length === 0)));
    assert.equal(new Set(receipts.flatMap(x => x.scans.map(y => y.command.cwd))).size, 2);
    for (const receipt of receipts) assert.equal(existsSync(path.join(receipt.scans[0].command.cwd, 'g3-content.txt')), false);
  });

test('Studio C3 lifecycle pre-revoked slot refuses before any owner process starts',
  { skip: !g3Tooling && 'requires fixed local offline scanner' }, async () => {
    const g = await import(g4Module), output = mkdtempSync(path.join(root, 'c3-pre-revoked-'));
    const snapshot = path.join(output, 'snapshot'); mkdirSync(snapshot); save(snapshot, 'clean.txt', 'clean fixture\n');
    const entries = [{ path: 'clean.txt', bytes: 14, sha256: hash('clean fixture\n') }];
    const control = path.join(root, 'c3-revoked-control.json'); writeFileSync(control, 'revoked');
    await assert.rejects(() => g.runStudioG3Workers({ entries, snapshot, output, ref: g3ToolRefs(g3Tooling).gitleaks,
      protectedRoots: [output], checkControl: () => { throw Object.assign(new Error('G3_CONTROL_CHANGED'), { gateCode: 'G3_CONTROL_CHANGED' }); },
      controls: [[control, hash('active')]], deadline: Date.now() + 20_000, workers: 2 }), { gateCode: 'G3_CONTROL_CHANGED' });
    assert.deepEqual(readdirSync(output), ['snapshot']);
  });

async function c3SlotSetup() { if (!studioJobSetup) await studioJobInvoke(mkdtempSync(path.join(root, 'c3-owner-setup-')), ['--version']); }
async function c3LifecycleFixture(count = 32, budget = 6000) {
  await c3SlotSetup();
  const output = mkdtempSync(path.join(root, 'c3-life-')), snapshot = path.join(output, 'snapshot'); mkdirSync(snapshot);
  const value = 'plain local lifecycle test text '.repeat(2048);
  const entries = Array.from({ length: count }, (_, i) => { const name = 'file-' + String(i).padStart(3, '0') + '.txt';
    save(snapshot, name, value); return { path: name, bytes: Buffer.byteLength(value), sha256: hash(value) }; });
  const control = path.join(output, 'control.json'); writeFileSync(control, 'active');
  const options = { entries, snapshot, output, ref: g3ToolRefs(g3Tooling).gitleaks, protectedRoots: [output],
    controls: [[control, hash('active')]], deadline: Date.now() + budget, workers: 2,
    job: studioJobSetup.job, tools: studioJobSetup.tools };
  options.checkControl = () => {
    assert.equal(readFileSync(control, 'utf8'), 'active', 'fixture must retain active control');
    return options.deadline - Date.now();
  };
  return { options, control };
}
async function c3Active(output, count = 2) {
  for (let i = 0; i < 400; i++) {
    const found = Array.from({ length: count }, (_, n) => path.join(output, 'slot-' + n, 'activity.json'));
    if (found.every(existsSync)) return found.map((file, n) => ({ ...JSON.parse(readFileSync(file)),
      ownerPid: JSON.parse(readFileSync(path.join(output, 'slot-' + n, 'owner-pid.json'))).pid }));
    await delay(10);
  }
  assert.fail('actual fixed scanner activity was not observed');
}
async function c3ObserveDead(rows) {
  const pids = [...new Set(rows.flatMap(({ ownerPid, rootPid, scannerPid }) => [ownerPid, rootPid, scannerPid]))];
  for (let i = 0; i < 600 && pids.some(studioJobAlive); i++) await delay(10);
  assert.ok(pids.every(pid => !studioJobAlive(pid)), JSON.stringify({ pids, live: pids.filter(studioJobAlive) }));
}
test('Studio C3 lifecycle active revocation closes only owned Jobs and never invents terminal membership',
  { skip: !g3Tooling && 'requires fixed local scanner' }, async t => {
    const g = await import(g4Module), { options, control } = await c3LifecycleFixture();
    options.checkControl = () => {
      if (readFileSync(control, 'utf8') !== 'active') throw Object.assign(new Error('G3_CONTROL_CHANGED'), { gateCode: 'G3_CONTROL_CHANGED' });
      return options.deadline - Date.now();
    };
    const sentinel = spawn(process.execPath, ['--interactive'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let outcome; const run = g.runStudioG3Workers(options).catch(error => { outcome = error; });
    try {
      const active = await c3Active(options.output); let mutationError;
      try { writeFileSync(control, 'revoked'); } catch (error) { mutationError = error; }
      const controlBytes = readFileSync(control); await run;
      t.diagnostic(JSON.stringify({ revocationDiagnostic: { mutationError: mutationError && { name: mutationError.name, code: mutationError.code,
        message: mutationError.message, stack: mutationError.stack }, actualControlSha256: hash(controlBytes),
        actualControlChanged: controlBytes.equals(Buffer.from('revoked')), outcome: outcome && { name: outcome.name,
          code: outcome.code, gateCode: outcome.gateCode, message: outcome.message, stack: outcome.stack }, owners: outcome?.owners } }));
      c3ArchiveFailure('active-revocation', outcome);
      assert.ifError(mutationError); assert.equal(controlBytes.toString(), 'revoked');
      assert.equal(outcome?.gateCode, 'G3_CONTROL_CHANGED'); await c3ObserveDead(active);
      assert.ok(studioJobAlive(sentinel.pid));
      assert.ok(outcome.owners.every(x => x.nativeChild === null || x.nativeChild.stopped !== null));
      t.diagnostic(JSON.stringify({ active, code: outcome.gateCode, owners: outcome.owners, unrelatedAlive: true }));
    } finally { sentinel.kill(); await run; }
  });
test('Studio C3 lifecycle deadline closes fixed scanner Jobs without a renewed lease',
  { skip: !g3Tooling && 'requires fixed local scanner' }, async t => {
    const g = await import(g4Module), { options } = await c3LifecycleFixture(32, 2000);
    let outcome; const run = g.runStudioG3Workers(options).catch(error => { outcome = error; });
    const active = await c3Active(options.output); await run; assert.ok(outcome); await c3ObserveDead(active);
    assert.ok(outcome.owners.every(x => Number(x.command.args[4]) === options.deadline));
    t.diagnostic(JSON.stringify({ active, deadline: options.deadline, code: outcome.gateCode, owners: outcome.owners }));
  });
test('Studio C3 lifecycle killed owner causes failure and kernel-owned scanner death',
  { skip: !g3Tooling && 'requires fixed local scanner' }, async t => {
    const g = await import(g4Module), { options } = await c3LifecycleFixture();
    let outcome; const run = g.runStudioG3Workers(options).catch(error => { outcome = error; });
    const active = await c3Active(options.output); process.kill(active[0].ownerPid); await run;
    assert.ok(outcome); c3ArchiveFailure('owner-killed', outcome);
    assert.equal(outcome.owners[0].nativeChild, null);
    assert.ok(outcome.owners.every(owner => owner.cleanup && owner.cleanup.resourceReleaseAllowed === false));
    assert.ok(outcome.owners[0].cleanup.observations.some(row => row.pid === active[0].rootPid && row.state === 'exited'));
    assert.ok(outcome.owners[0].cleanup.activity.sha256);
    assert.equal(outcome.owners[0].cleanup.originalDeadline, options.deadline);
    await c3ObserveDead(active);
    t.diagnostic(JSON.stringify({ active, owners: outcome.owners, code: outcome.gateCode, fabricatedActiveAfter: false }));
  });
test('Studio C3 lifecycle fixed worker input failure aborts its still-active sibling',
  { skip: !g3Tooling && 'requires fixed local scanner' }, async t => {
    const g = await import(g4Module), { options } = await c3LifecycleFixture();
    let outcome; const run = g.runStudioG3Workers(options).catch(error => { outcome = error; });
    const active = await c3Active(options.output); save(options.snapshot, options.entries[2].path, 'changed inert text'); await run;
    assert.ok(outcome); await c3ObserveDead(active);
    t.diagnostic(JSON.stringify({ active, code: outcome.gateCode, owners: outcome.owners }));
  });
test('Studio C3 lifecycle missing reviewed import fails in owned bootstrap without hanging',
  { skip: !g3Tooling && 'requires fixed local scanner' }, async t => {
    const g = await c3Helpers(), { options } = await c3LifecycleFixture();
    // Only remove an inert reviewed dependency in a private test copy, never alter executable/code bytes.
    const folders = readdirSync(root).filter(name => name.startsWith('c3-module-'));
    assert.equal(folders.length, 1); unlinkSync(path.join(root, folders[0], 'check-imports.mjs'));
    let outcome; await g.runStudioG3Workers(options).catch(error => { outcome = error; });
    assert.ok(outcome); t.diagnostic(JSON.stringify({ observedBootstrapOwners: outcome.owners }));
    assert.ok(outcome.owners.some(x => x.nativeChild?.stopped === 'root-failed'));
    assert.ok(outcome.owners.every(x => x.nativeChild === null || x.nativeChild.stopped !== null));
    t.diagnostic(JSON.stringify({ code: outcome.gateCode, owners: outcome.owners }));
  });
test('Studio C3 lifecycle outer controller forced exit leaves original-deadline owners, never a pass',
  { skip: !g3Tooling && 'requires fixed local scanner' }, async t => {
    const childConfig = process.env.ORANGE_TEST_C3_CHILD_POOL;
    if (childConfig) {
      const data = JSON.parse(readFileSync(childConfig)); data.job.files = new Map(data.job.files);
      data.checkControl = () => data.deadline - Date.now();
      await (await import(g4Module)).runStudioG3Workers(data); return;
    }
    const { options } = await c3LifecycleFixture(322, 5000), file = path.join(options.output, 'child-pool.json');
    writeFileSync(file, JSON.stringify({ ...options, job: { ...options.job, files: [...options.job.files] } }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
    const child = spawn(process.execPath, ['--test', '--test-isolation=none',
      '--test-name-pattern=^Studio C3 lifecycle outer controller forced exit', fileURLToPath(import.meta.url)],
      { windowsHide: true, env: { ...env, ORANGE_TEST_C3_CHILD_POOL: file }, stdio: ['ignore', 'pipe', 'pipe'] });
    let raw = ''; child.stdout.on('data', chunk => { raw += chunk; }); child.stderr.on('data', chunk => { raw += chunk; });
    const closed = new Promise(resolve => child.once('close', resolve));
    const active = await c3Active(options.output); child.kill(); await closed;
    await c3ObserveDead(active); assert.ok(Date.now() <= options.deadline + 5000);
    const terminal = active.map((_, n) => readFileSync(path.join(options.output, 'slot-' + n, 'stderr.log'), 'utf8'));
    t.diagnostic(JSON.stringify({ hardExitTerminal: terminal, now: Date.now(), deadline: options.deadline }));
    assert.ok(terminal.every(value => value.includes('[studio-c2-child]') && value.includes('deadline')));
    assert.ok(Date.now() >= options.deadline, 'must observe independent original-deadline enforcement, not a completed short workload');
    assert.ok(active.every(({ ownerPid }) => !studioJobAlive(ownerPid)));
    t.diagnostic(JSON.stringify({ controllerPid: child.pid, active, deadline: options.deadline, observedAt: Date.now(),
      rawSha256: hash(raw), admission: false, ownershipAfterHardExit: 'original-deadline only; not immediate cleanup' }));
  });
let c3Assembly;
function c3AssemblyFixture() {
  if (c3Assembly) return c3Assembly;
  // Immutable prior C2 is data-only unit fixture, never a reusable runtime authority.
  const prior = exactC2Record('D:/dev/oc2-exec-control/verified.json', 'c1f2bf601c15559f0ecd0c38744c061dd1b7555a39d8a16a23a802dd06bf011e');
  const report = structuredClone(prior.report), { checkout } = exactStudioCandidate();
  report.g2.executionRoot = c2BuildRoot;
  const expected = new Map(JSON.parse(readFileSync(c2BuildRecord)).outputs.files.map(({ name, bytes, sha256 }) =>
    ['apps/desktop/dist/' + name, { bytes, sha256 }]));
  const manifest = exactC2Record(path.join(c3Materials, 'orange-studio-c2-offline-donor/packages.compact.json'),
    '0d32df0c0ec6c2a62eae8e038671baaf4692ae318591cf05eeb317563d2c7e46');
  const fonts = manifest.packages.find(x => x.name === '@fontsource-variable/inter');
  const files = new Map(fonts.files.map(x => ['node_modules/' + fonts.physicalRootFromNodeModules + '/' + x.path, x]));
  const closure = exactC2Record(c1Profile, c1ProfileSha).fixedUpstream.closure;
  const gitArgs = ['--no-replace-objects', '--no-optional-locks', '-c', 'safe.directory=' + studioPinnedSource,
    '-C', studioPinnedSource, 'cat-file', '--batch'];
  const raw = execFileSync('C:/Program Files/Git/ucrt64/bin/git.exe', gitArgs,
    { input: closure.map(x => x.oid).join('\n') + '\n', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const upstream = new Map(); let at = 0;
  for (const row of closure) {
    const header = Buffer.from(row.oid + ' blob ' + row.bytes + '\n'); assert.deepEqual(raw.subarray(at, at + header.length), header);
    const bytes = raw.subarray(at + header.length, at + header.length + row.bytes); assert.equal(hash(bytes), row.sha256);
    upstream.set(row.path, bytes); at += header.length + row.bytes + 1;
  }
  assert.equal(at, raw.length);
  const notices = new Map(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'TRADEMARK.md'].map(name => [name,
    execFileSync('C:/Program Files/Git/ucrt64/bin/git.exe', ['--no-replace-objects', '--no-optional-locks',
      '-c', 'safe.directory=' + studioPinnedSource, '-C', studioPinnedSource, 'cat-file', 'blob', studioPin + ':' + name], { windowsHide: true })]));
  const context = { root: checkout, tree: readTree(checkout, studioHead), base: report.base, head: report.head,
    card: { assignmentRevision: report.g2.assignmentRevision }, index: { g2PlanSha256: report.g2.planSha256 }, report };
  const studio = { studioSource: report.studioSource, upstream, notices,
    c2: { execution: report.g2, expectedBuild: { expected }, deps: { files } } };
  return c3Assembly = { context, studio };
}
test('Studio C3 handoff refuses replayed subject, source, graph, C2 plan and partial stages', studioC3Real, async () => {
  const g = await import(g4Module), { context, studio } = c3AssemblyFixture();
  assert.equal(g.verifyStudioG3Handoff(context, studio), true);
  for (const modify of [x => x.head = studioE0, x => x.card.assignmentRevision++, x => x.index.g2PlanSha256 = '1'.repeat(64),
    x => x.report.rendererGraph.source.commit = studioE0, x => x.report.rendererGraph.builds.pop(),
    x => x.report.g2.studio.outputs = {}, x => x.report.checks.find(c => c.id === 'windows').status = 'unavailable']) {
    const value = structuredClone(context); value.tree = context.tree; modify(value);
    const local = { ...studio, c2: { ...studio.c2, execution: value.report.g2 } };
    assert.throws(() => g.verifyStudioG3Handoff(value, local));
  }
  assert.throws(() => g.verifyStudioG3Handoff(context, { ...studio, c2: undefined }));
});
test('Studio C3 assembles actual322 texts and7 original package fonts without walking vendor or local caches', studioC3Real, async () => {
  const g = await import(g4Module), { context, studio } = c3AssemblyFixture();
  const snapshot = path.join(root, 'c3-assembly');
  const result = g.buildStudioG3Snapshot({ ...context, snapshot }, studio);
  assert.deepEqual(g.verifyStudioG3Coverage(result.entries, result.fonts), { files: 322, scans: 644, fonts: 7 });
  assert.equal(result.entries.filter(x => x.path.startsWith('build/')).length, 10);
  assert.ok(result.entries.some(x => x.path === 'build/main/index.js'));
  assert.ok(result.entries.some(x => x.path === 'build/studio/studio-build.json'));
  assert.ok(result.fonts.every(x => x.packageFile.endsWith('-wght-normal.woff2')));
  assert.throws(() => g.buildStudioG3Snapshot({ ...context, snapshot: path.join(root, 'c3-assembly-omitted') },
    { ...studio, upstream: new Map([...studio.upstream].slice(1)) }), { gateCode: 'STUDIO_C3_SOURCE_MISMATCH' });
});

test('Studio C3 offline owned audit uses independent100 npm and actual C2 lock13 without a scanner self-report inventory',
  { skip: studioC3Real.skip || !g3Tooling && 'requires exact offline scanner/db material' }, async t => {
    const g = await import(g4Module), { context, studio } = c3AssemblyFixture(); await c3SlotSetup();
    const output = mkdtempSync(path.join(root, 'c3-owned-audit-')), snapshot = path.join(output, 'snapshot');
    const material = g.buildStudioG3Snapshot({ ...context, snapshot }, studio);
    const lock = material.entries.find(row => row.path === 'orange/pnpm-lock.yaml'), pnpm = path.join(snapshot, lock.path);
    const npm = g.g3NpmInventory(c3Inventory(true), lock, [], { studio: true, lockBytes: readFileSync(pnpm) });
    const witness = exactC2Record('D:/dev/oc2-exec-control/verified.json', 'c1f2bf601c15559f0ecd0c38744c061dd1b7555a39d8a16a23a802dd06bf011e').report.g2;
    const native = readG3NativeLock(witness, witness), nuget = path.join(output, 'packages.lock.json'); writeFileSync(nuget, native.bytes);
    const db = path.join(output, 'db'), database = materializeG3Database(g3DatabaseRef(g3Tooling), db, [output]);
    const control = path.join(output, 'control.json'); writeFileSync(control, 'active');
    const evidence = await g.runStudioG3Workers({ entries: material.entries, snapshot, output,
      ref: g3ToolRefs(g3Tooling).osv, protectedRoots: [output], checkControl: () => 120_000,
      controls: [[control, hash('active')]], deadline: Date.now() + 120_000, job: studioJobSetup.job, tools: studioJobSetup.tools,
      workers: 1, audit: { locks: [{ file: pnpm, ecosystem: 'npm', packages: npm }, { file: nuget, ecosystem: 'NuGet', packages: native.packages }], db, database } });
    assert.deepEqual(evidence.audit.sources.map(x => [x.ecosystem, x.count]).sort(), [['NuGet', 13], ['npm', 100]]);
    assert.equal(evidence.audit.findings.length, 0);
    assert.equal(evidence.owners[0].nativeChild.activeAfter, 0);
    t.diagnostic(JSON.stringify({ scope: 'unit fixture, prior C2 lock is not renewed authority', sources: evidence.audit.sources,
      findings: 0, owners: evidence.owners }));
  });

test('Studio C3 actual322 texts complete644 fixed scans within prior measured remaining budget',
  { skip: studioC3Real.skip || !g3Tooling && 'requires exact offline scanner material' }, async t => {
    const g = await import(g4Module), { context, studio } = c3AssemblyFixture(); await c3SlotSetup();
    const output = mkdtempSync(path.join(root, 'c3-full-coverage-')), snapshot = path.join(output, 'snapshot');
    const started = Date.now(), material = g.buildStudioG3Snapshot({ ...context, snapshot }, studio);
    const control = path.join(output, 'control.json'); writeFileSync(control, 'active');
    const rows = await g.runStudioG3Workers({ entries: material.entries, snapshot, output, ref: g3ToolRefs(g3Tooling).gitleaks,
      protectedRoots: [output], checkControl: () => started + 132750 - Date.now(), controls: [[control, hash('active')]],
      deadline: started + 132750, job: studioJobSetup.job, tools: studioJobSetup.tools, workers: 4 });
    assert.equal(rows.length, 322); assert.equal(rows.flatMap(x => x.scans).length, 644);
    assert.ok(rows.every(x => x.findings.length === 0)); assert.ok(rows.owners.every(x => x.nativeChild.activeAfter === 0));
    assert.equal(material.fonts.length, 7); assert.ok(Date.now() - started < 132750);
    const auditOutput = path.join(output, 'audit'); mkdirSync(auditOutput);
    const lock = material.entries.find(row => row.path === 'orange/pnpm-lock.yaml'), pnpm = path.join(snapshot, lock.path);
    const npm = g.g3NpmInventory(c3Inventory(true), lock, [], { studio: true, lockBytes: readFileSync(pnpm) });
    const witness = exactC2Record('D:/dev/oc2-exec-control/verified.json', 'c1f2bf601c15559f0ecd0c38744c061dd1b7555a39d8a16a23a802dd06bf011e').report.g2;
    const native = readG3NativeLock(witness, witness), nuget = path.join(auditOutput, 'packages.lock.json'); writeFileSync(nuget, native.bytes);
    const db = path.join(auditOutput, 'db'), database = materializeG3Database(g3DatabaseRef(g3Tooling), db, [output]);
    const audit = await g.runStudioG3Workers({ entries: material.entries, snapshot, output: auditOutput,
      ref: g3ToolRefs(g3Tooling).osv, protectedRoots: [output], checkControl: () => started + 132750 - Date.now(),
      controls: [[control, hash('active')]], deadline: started + 132750, job: studioJobSetup.job, tools: studioJobSetup.tools, workers: 1,
      audit: { locks: [{ file: pnpm, ecosystem: 'npm', packages: npm }, { file: nuget, ecosystem: 'NuGet', packages: native.packages }], db, database } });
    assert.equal(audit.audit.findings.length, 0); assert.deepEqual(audit.audit.sources.map(x => [x.ecosystem, x.count]).sort(), [['NuGet', 13], ['npm', 100]]);
    assert.ok(Date.now() - started < 132750);
    if (process.env.ORANGE_TEST_STUDIO_C3_EVIDENCE) {
      const archive = path.join(process.env.ORANGE_TEST_STUDIO_C3_EVIDENCE, 'full-offline-fixture'); mkdirSync(archive, { recursive: true });
      writeFileSync(path.join(archive, 'verified.json'), JSON.stringify({ scope: 'Non-authorizing complete C3 fixture sequence; prior C2 lock is data only',
        admitted: false, entries: material.entries, fonts: material.fonts, receipts: rows, audit: audit.audit,
        owners: [...rows.owners, ...audit.owners], elapsedMs: Date.now() - started, budgetMs: 132750 }, null, 2) + '\n', { flag: 'wx' });
      for (const owner of [...rows.owners, ...audit.owners]) {
        const prefix = owner === audit.owners[0] ? 'audit' : 'secret-' + owner.slot;
        copyFileSync(owner.stdoutFile, path.join(archive, prefix + '.stdout.json'));
        copyFileSync(owner.stderrFile, path.join(archive, prefix + '.stderr.log'));
        const dataFile = owner.command.args.at(-2); copyFileSync(dataFile, path.join(archive, prefix + '.slot.json'));
      }
    }
    t.diagnostic(JSON.stringify({ scope: 'offline fixture coverage/timing only, NOT a combined formal C1/C2/C3 run',
      texts: rows.length, scans: 644, fonts: material.fonts.length, elapsedMs: Date.now() - started,
      remainingBudgetMs: 132750, manifestSha256: hash(JSON.stringify(material.entries)),
      receiptsSha256: hash(JSON.stringify(rows)), owners: rows.owners }));
  });

test('Studio C3 neutral scan defeats identical SVG lock and ignore exemptions with redacted failure evidence',
  { skip: !g3Tooling && 'requires fixed scanner' }, async t => {
    const g = await import(g4Module); await c3SlotSetup();
    const value = 'gh' + 'p_' + createHash('sha256').update('Studio C3 synthetic local sentinel no real credential').digest('hex').slice(0, 36) + '\n';
    for (const name of ['asset.svg', 'pnpm-lock.yaml', '.gitleaksignore']) {
      const output = mkdtempSync(path.join(root, 'c3-neutral-negative-')), snapshot = path.join(output, 'snapshot'); mkdirSync(snapshot);
      save(snapshot, name, value); const control = path.join(output, 'control.json'); writeFileSync(control, 'active');
      let error; await g.runStudioG3Workers({ entries: [{ path: name, bytes: Buffer.byteLength(value), sha256: hash(value) }],
        snapshot, output, ref: g3ToolRefs(g3Tooling).gitleaks, protectedRoots: [output], checkControl: () => 20_000,
        controls: [[control, hash('active')]], deadline: Date.now() + 20_000, workers: 1, job: studioJobSetup.job, tools: studioJobSetup.tools })
        .catch(reason => { error = reason; });
      assert.equal(error?.gateCode, 'G3_SECRET_FOUND');
      const failure = error.owners[0].failure?.receipt;
      assert.equal(failure.scans.length, 2); assert.equal(failure.scans[1].mode, 'neutral-content');
      assert.equal(failure.scans[1].exitCode, 1); assert.equal(failure.scans[1].raw, undefined, 'sensitive finding must not retain native raw bytes'); assert.deepEqual(failure.findings, [{ path: name, rule: 'github-pat', line: 1 }]);
      assert.equal(JSON.stringify(error.owners).includes(value.trim()), false);
      t.diagnostic(JSON.stringify({ path: name, failure, owner: error.owners[0] }));
    }
  });

async function c3R2EarlyOwnerFailure(options, t) {
  const g = await import(g4Module); let outcome;
  const run = g.runStudioG3Workers({ ...options, workers: 1 }).catch(error => { outcome = error; });
  const marker = path.join(options.output, 'slot-0', 'owner-pid.json');
  for (let i = 0; i < 600 && !existsSync(marker); i++) await delay(2);
  assert.ok(existsSync(marker)); const pid = JSON.parse(readFileSync(marker)).pid;
  const activityAlreadyExisted = existsSync(path.join(options.output, 'slot-0', 'activity.json'));
  process.kill(pid); await run;
  assert.equal(activityAlreadyExisted, false, 'fixture must kill the captured owner before any descendant activity witness');
  assert.ok(outcome); c3ArchiveFailure(options.audit ? 'missing-osv' : 'missing-gitleaks', outcome);
  assert.equal(outcome.owners[0].nativeChild, null);
  const cleanup = outcome.owners[0].cleanup;
  assert.equal(cleanup.status, 'cleanup-unconfirmed'); assert.equal(cleanup.resourceReleaseAllowed, false);
  assert.equal(cleanup.originalDeadline, options.deadline); assert.ok(cleanup.controllerAction);
  assert.equal(cleanup.activity.available, false); assert.ok(cleanup.activity.file.endsWith('activity.json'));
  assert.equal(cleanup.observations.some(row => row.pid !== pid && row.state === 'exited'), false);
  t.diagnostic(JSON.stringify({ role: options.audit ? 'osv' : 'gitleaks', ownerPid: pid, owners: outcome.owners }));
}
test('Studio C3 R2 missing Gitleaks activity remains cleanup-unconfirmed without vacuous empty success',
  { skip: !g3Tooling && 'requires fixed scanner' }, async t => {
    const { options } = await c3LifecycleFixture(); await c3R2EarlyOwnerFailure(options, t);
  });
test('Studio C3 R2 missing OSV provenance remains cleanup-unconfirmed without inferred Gitleaks evidence',
  { skip: studioC3Real.skip || !g3Tooling && 'requires actual offline audit fixture' }, async t => {
    const g = await import(g4Module), { context, studio } = c3AssemblyFixture(); await c3SlotSetup();
    const output = mkdtempSync(path.join(root, 'c3-r2-audit-')), snapshot = path.join(output, 'snapshot');
    const material = g.buildStudioG3Snapshot({ ...context, snapshot }, studio);
    const lock = material.entries.find(row => row.path === 'orange/pnpm-lock.yaml'), pnpm = path.join(snapshot, lock.path);
    const npm = g.g3NpmInventory(c3Inventory(true), lock, [], { studio: true, lockBytes: readFileSync(pnpm) });
    const witness = exactC2Record('D:/dev/oc2-exec-control/verified.json', 'c1f2bf601c15559f0ecd0c38744c061dd1b7555a39d8a16a23a802dd06bf011e').report.g2;
    const native = readG3NativeLock(witness, witness), nuget = path.join(output, 'packages.lock.json'); writeFileSync(nuget, native.bytes);
    const db = path.join(output, 'db'), database = materializeG3Database(g3DatabaseRef(g3Tooling), db, [output]);
    const control = path.join(output, 'control.json'); writeFileSync(control, 'active');
    await c3R2EarlyOwnerFailure({ entries: material.entries, snapshot, output, ref: g3ToolRefs(g3Tooling).osv,
      protectedRoots: [output], checkControl: () => 6000, controls: [[control, hash('active')]], deadline: Date.now() + 6000,
      job: studioJobSetup.job, tools: studioJobSetup.tools, workers: 1,
      audit: { locks: [{ file: pnpm, ecosystem: 'npm', packages: npm }, { file: nuget, ecosystem: 'NuGet', packages: native.packages }], db, database } }, t);
  });

function c3ArchiveFailure(label, error) {
  if (!process.env.ORANGE_TEST_STUDIO_C3_EVIDENCE) return;
  const folder = path.join(process.env.ORANGE_TEST_STUDIO_C3_EVIDENCE, 'failure-' + label);
  mkdirSync(folder, { recursive: true });
  const files = [];
  for (const owner of error?.owners ?? []) for (const name of ['stdout.json', 'stderr.log', 'activity.json', 'owner-pid.json', 'slot.json']) {
    const file = path.join(owner.command.cwd, name);
    if (existsSync(file)) {
      const raw = readFileSync(file), target = 'slot-' + owner.slot + '-' + name;
      writeFileSync(path.join(folder, target), raw, { flag: 'wx' }); files.push({ path: target, bytes: raw.length, sha256: hash(raw) });
    }
  }
  writeFileSync(path.join(folder, 'verified.json'), JSON.stringify({ scope: 'Failed unit-run handoff evidence only; no resource release or admission',
    admitted: false, code: error?.gateCode, error: error && { name: error.name, message: error.message, stack: error.stack },
    owners: error?.owners, files }, null, 2) + '\n', { flag: 'wx' });
}

test('Studio C3 R3 actual producer serializes owned OSV failure after real322/644 unit-data scans',
  { skip: studioC3Real.skip || !g3Tooling && 'requires exact offline C3 unit fixtures' }, async t => {
    await c3SlotSetup();
    const moduleRoot = mkdtempSync(path.join(root, 'c3-producer-module-'));
    for (const name of ['check-candidate.mjs', 'check-imports.mjs', 'check-admission.mjs']) {
      const raw = readFileSync(new URL('../../tools/ci/' + name, import.meta.url));
      save(moduleRoot, name, name === 'check-candidate.mjs' ? Buffer.concat([raw,
        Buffer.from('\nexport { runStudioG3 };\n')]) : raw);
    }
    // Only the existing private-copy export seam; the entire producer body is unmodified.
    const g = await import((await import('node:url')).pathToFileURL(path.join(moduleRoot, 'check-candidate.mjs')));
    const fixture = c3AssemblyFixture(), context = { ...fixture.context, report: structuredClone(fixture.context.report) };
    context.report.fixtureScope = 'Non-authorizing producer-negative unit data; C0/C1/C2 are outside this test, no GUI or fresh formal authority';
    const nativeRoot = mkdtempSync(path.join(root, 'c3-producer-native-'));
    const witness = exactC2Record('D:/dev/oc2-exec-control/verified.json', 'c1f2bf601c15559f0ecd0c38744c061dd1b7555a39d8a16a23a802dd06bf011e').report.g2;
    const native = readG3NativeLock(witness, witness), lock = path.join(nativeRoot, 'packages.lock.json'); writeFileSync(lock, native.bytes);
    const execution = context.report.g2; execution.outputRoot = nativeRoot;
    const project = path.join(execution.executionRoot, 'tests/contracts/dotnet/Orange.Contracts.Tests.csproj');
    execution.contracts.restoreLock.file = lock;
    for (const command of execution.commands) if (['contracts-dotnet-restore', 'contracts-dotnet-test'].includes(command.id)) {
      command.args[1] = project;
      command.args = command.args.map(value => value.startsWith('-p:NuGetLockFilePath=') ? '-p:NuGetLockFilePath=' + lock : value);
    }
    const controls = mkdtempSync(path.join(root, 'c3-producer-control-')), output = mkdtempSync(path.join(root, 'c3-producer-output-'));
    const until = Date.now() + 132750;
    context.card = { ...approved, taskId: 'T01.c3-producer-unit', assignmentRevision: execution.assignmentRevision,
      baselineCommit: context.base, workingBaselineCommit: context.base, headCommit: context.head,
      worktree: context.root, branch: 'admission-fixture', writeSet: context.report.changedFiles };
    const plan = { schemaVersion: 1, taskId: context.card.taskId, assignmentRevision: context.card.assignmentRevision,
      base: context.base, head: context.head, tree: execution.tree, validUntil: new Date(until).toISOString(), outputRoot: output,
      tools: g3ToolRefs(g3Tooling), database: g3DatabaseRef(g3Tooling), pnpmInventory: c3Inventory(true) };
    const planFile = path.join(controls, 'g3-plan.json'), planBytes = JSON.stringify(plan); writeFileSync(planFile, planBytes);
    context.cardFile = path.join(controls, 'card.json'); context.indexFile = path.join(controls, 'index.json');
    context.index = { schemaVersion: 1, validUntil: plan.validUntil, cards: [context.card],
      g3PlanSha256: hash(planBytes), g2PlanSha256: execution.planSha256 };
    writeFileSync(context.cardFile, JSON.stringify(context.card)); writeFileSync(context.indexFile, JSON.stringify(context.index));
    context.common = git(context.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    let guardCalls = 0;
    const studio = { ...fixture.studio, protectedRoots: [context.root, context.common, c2BuildRoot, moduleRoot],
      freshC1() { assert.equal(hash(JSON.stringify(context.report.rendererGraph)), execution.studio.rendererGraphSha256); },
      c2: { ...fixture.studio.c2, execution, deadline: until, job: studioJobSetup.job, tools: studioJobSetup.tools,
        guard() {
          guardCalls++;
          assert.equal(readG3NativeLock(execution, execution).packages.length, 13);
          const files = [...fixture.studio.c2.expectedBuild.expected].map(([name, value]) => ({ name: name.slice('apps/desktop/dist/'.length), ...value }));
          assert.equal(g2BuildOutputs(execution.executionRoot, context.head, true, { studioSource: fixture.studio.studioSource,
            rendererGraph: context.report.rendererGraph, files, sourcePaths: [...fixture.studio.upstream.keys()] }).outputs.size, 17);
        } } };
    context.studio = studio;
    let originalError, capturedOwner;
    const producer = g.runStudioG3(planFile, context, studio).catch(error => { originalError = error; });
    const ownerMarker = path.join(output, 'audit', 'slot-0', 'owner-pid.json');
    while (!existsSync(ownerMarker) && !originalError && Date.now() < until) await delay(10);
    if (existsSync(ownerMarker)) {
      capturedOwner = JSON.parse(readFileSync(ownerMarker)).pid;
      process.kill(capturedOwner); // Only this invocation's captured OSV owner, never an executable substitute.
    }
    await producer;
    c3ArchiveFailure(capturedOwner ? 'producer-osv' : 'producer-before-audit', originalError);
    if (process.env.ORANGE_TEST_STUDIO_C3_EVIDENCE) {
      const earlyArchive = path.join(process.env.ORANGE_TEST_STUDIO_C3_EVIDENCE, capturedOwner ? 'failure-producer-osv' : 'failure-producer-before-audit');
      writeFileSync(path.join(earlyArchive, 'producer-report-before-assert.json'), JSON.stringify(context.report, null, 2) + '\n', { flag: 'wx' });
    }
    t.diagnostic(JSON.stringify({ producerError: originalError && { name: originalError.name, code: originalError.gateCode,
      message: originalError.message, stack: originalError.stack }, capturedOwner, guardCalls, secret: context.report.g3?.secret && { files: context.report.g3.secret.files, unscanned: context.report.g3.secret.unscanned, owners: context.report.g3.secret.owners }, stage: context.report.checks.find(row => row.id === 'dependency-audit') }));
    assert.ok(capturedOwner, 'must reach the actual producer OSV await, not fail fixture setup');
    assert.ok(originalError); context.report.code = originalError.gateCode ?? 'GATE_ERROR';
    const serialized = JSON.parse(JSON.stringify(context.report));
    assert.equal(serialized.admitted, false); assert.equal(serialized.g3.secret.unscanned, 0);
    assert.equal(serialized.g3.secret.receipts.length, 322);
    assert.equal(serialized.g3.secret.receipts.flatMap(row => row.scans).length, 644);
    assert.equal(serialized.checks.find(row => row.id === 'dependency-audit').status, 'failed');
    assert.equal(context.report.g3.dependencies?.owners, originalError.owners, 'preserve the original failure owner array, not a replacement receipt');
    const failure = serialized.g3.dependencies;
    assert.ok(failure, 'actual producer must attach OSV failure handoff before final report JSON serialization');
    assert.equal(failure.owners.length, 1); assert.equal(failure.native.lockSha256, native.lockSha256);
    assert.equal(failure.pnpm.sha256, '310ba40fbad44925b503b8d850798f691b416b6427c08c7e18cf7a388c759f90');
    assert.equal(failure.owners[0].nativeChild, null); assert.equal(failure.owners[0].cleanup.status, 'cleanup-unconfirmed');
    assert.equal(failure.owners[0].cleanup.resourceReleaseAllowed, false);
    assert.equal(failure.owners[0].cleanup.originalDeadline, until);
    assert.ok(failure.owners[0].cleanup.raw.every(row => row.sha256));
    assert.equal(Object.hasOwn(failure, 'sources'), false); assert.equal(Object.hasOwn(failure, 'findings'), false);
    assert.ok(guardCalls >= 3);
    if (process.env.ORANGE_TEST_STUDIO_C3_EVIDENCE) {
      const archive = path.join(process.env.ORANGE_TEST_STUDIO_C3_EVIDENCE, 'failure-producer-osv');
      writeFileSync(path.join(archive, 'producer-report.json'), JSON.stringify(serialized, null, 2) + '\n', { flag: 'wx' });
      for (const file of [planFile, context.cardFile, context.indexFile]) copyFileSync(file, path.join(archive, path.basename(file)));
    }
    t.diagnostic(JSON.stringify({ scope: serialized.fixtureScope, code: serialized.code, secretScans: 644,
      failedOwners: failure.owners, nativeLockSha256: failure.native.lockSha256, admission: serialized.admitted }));
  });

// C4 loader unit boundary: real whole module plus appended private exports only.
// This does not establish C0/C1/C2/C3 authority or formal admission.
let c4Module;
async function c4Helpers() {
  if (!c4Module) {
    const folder = mkdtempSync(path.join(root, 'c4-module-'));
    for (const name of ['check-admission.mjs', 'check-imports.mjs', 'check-candidate.mjs']) {
      const bytes = readFileSync(new URL('../../tools/ci/' + name, import.meta.url));
      save(folder, name, name === 'check-candidate.mjs' ? Buffer.concat([bytes,
        Buffer.from('\nexport { loadG4Review, studioG3RawSink, studioG4Digest, studioG4ProjectVerified, studioG4Projection, studioG4RunEvidence, verifyStudioG3Raw, runStudioG4, studioG4Continuations };\n')]) : bytes);
    }
    c4Module = await import((await import('node:url')).pathToFileURL(path.join(folder, 'check-candidate.mjs')));
  }
  return c4Module;
}
test('Studio C4 loader accepts a protected v2 review only with authenticated Studio subject', async () => {
  const { loadG4Review } = await c4Helpers();
  const fixture = g4Fixture('c4-v2-red', record => {
    record.schemaVersion = 2;
    record.subject.lane = 'studio-dual';
  });
  const context = { root: tree, common: repo, base, head, card: approved,
    index: { ...fixture.index, cards: [approved] }, changes: approved.writeSet,
    studioSource: { candidate: { tree: fixture.subject.tree } } };
  assert.equal(loadG4Review(fixture.review, context).schemaVersion, 2);
});

test('Studio C4 v2 loader rejects lane swaps, unknown subject keys and folded author aliases', async () => {
  const { loadG4Review } = await c4Helpers();
  for (const [name, mutate, studio, pinMutate, code] of [
    ['v1-in-studio', () => {}, true, () => {}, 'G4_REVIEW_INVALID'],
    ['v2-in-legacy', r => { r.schemaVersion = 2; r.subject.lane = 'studio-dual'; }, false, () => {}, 'G4_REVIEW_INVALID'],
    ['wrong-lane', r => { r.schemaVersion = 2; r.subject.lane = 'auth'; }, true, () => {}, 'G4_REVIEW_INVALID'],
    ['extra-key', r => { r.schemaVersion = 2; r.subject.lane = 'studio-dual'; r.subject.roles = []; }, true, () => {}, 'G4_REVIEW_INVALID'],
    ['author-alias', r => { r.schemaVersion = 2; r.subject.lane = 'studio-dual'; }, true,
      p => { p.authors.push('/ROOT/REVIEWER'); }, 'G4_REVIEW_IDENTITY'],
  ]) {
    const fixture = g4Fixture('c4-' + name, mutate, pinMutate);
    const context = { root: tree, common: repo, base, head, card: approved,
      index: { ...fixture.index, cards: [approved] }, changes: approved.writeSet,
      ...(studio && { studioSource: { candidate: { tree: fixture.subject.tree } } }) };
    assert.throws(() => loadG4Review(fixture.review, context), { gateCode: code }, name);
  }
});

// Real scanner primitive boundary, independent of any candidate authority.
// A valid JSON byte stream with whitespace must be preserved, not reserialized.
test('Studio C4 raw scanner sink retains exact validated bytes and refuses reuse or budget overflow', async () => {
  const { studioG3RawSink } = await c4Helpers();
  const folder = mkdtempSync(path.join(root, 'c4-raw-'));
  const budget = { bytes: 0 }, buffers = { report: Buffer.from(' [ ] \n'), stdout: Buffer.from('native stdout\n'), stderr: Buffer.from('') };
  const sink = studioG3RawSink(folder, '0-original', () => 1000, budget);
  const refs = sink(buffers);
  for (const role of ['report', 'stdout', 'stderr']) {
    assert.deepEqual(readFileSync(refs[role].file), buffers[role]);
    assert.equal(refs[role].sha256, hash(buffers[role]));
    assert.equal(refs[role].bytes, buffers[role].length);
  }
  assert.equal(budget.bytes, Object.values(buffers).reduce((n, b) => n + b.length, 0));
  assert.throws(() => sink(buffers));
  assert.throws(() => studioG3RawSink(folder, '../escape', () => 1000, budget));
  assert.throws(() => studioG3RawSink(folder, '1-neutral', () => 1000, { bytes: 16 * 1024 * 1024 })(buffers),
    { gateCode: 'G3_SLOT_FAILED' });
  assert.equal(existsSync(path.join(folder, 'raw/1-neutral.report.bin')), false);
});

test('Studio C4 stable closure rejects missing, extra and folded roles and binds every family', async () => {
  const { studioG4Digest } = await c4Helpers();
  // Projector-only unit data; no control, PID, build or scanner success is asserted here.
  const families = Object.fromEntries(['subject-scope', 'source-policy', 'source-ledger', 'source-notices',
    'c1-shared', 'c1-inputs', 'c1-packages', 'c1-auth', 'c1-studio', 'c2-inputs', 'c2-packages', 'c2-tools',
    'c2-outputs', 'c2-commands', 'c2-results', 'c2-contracts', 'c2-restore', 'c3-coverage', 'c3-fonts',
    'c3-tools-config', 'c3-database', 'c3-inventories', 'c3-results', 'execution-code']
    .map(role => [role, { identity: role, contentSha256: hash(role) }]));
  const original = studioG4Digest(families);
  assert.match(original, /^[0-9a-f]{64}$/);
  for (const role of Object.keys(families)) {
    const missing = structuredClone(families); delete missing[role];
    assert.throws(() => studioG4Digest(missing), { gateCode: 'G4_INPUTS_UNAVAILABLE' }, role);
    const changed = structuredClone(families); changed[role].contentSha256 = hash('changed');
    assert.notEqual(studioG4Digest(changed), original, role);
  }
  assert.throws(() => studioG4Digest({ ...families, 'C1-AUTH': families['c1-auth'] }), { gateCode: 'G4_INPUTS_UNAVAILABLE' });
  assert.throws(() => studioG4Digest({ ...families, rogue: {} }), { gateCode: 'G4_INPUTS_UNAVAILABLE' });
  const reordered = Object.fromEntries(Object.entries(families).reverse().map(([key, row]) => [key,
    Object.fromEntries(Object.entries(row).reverse())]));
  assert.equal(studioG4Digest(reordered), original);
});

test('Studio C4 preserves exact TAP case identities after the existing strict parser', () => {
  const bytes = Buffer.from('TAP version 13\n# Subtest: case-a\nok 1 - case-a\n  ---\n  duration_ms: 0.1\n  type: \'test\'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n');
  assert.deepEqual(verifyG2Tap(bytes, ['case-a'], true).cases, [{ id: 'case-a', outcome: 'Passed' }]);
  assert.throws(() => verifyG2Tap(bytes, ['case-b'], true), { gateCode: 'G2_TAP_INVALID' });
});

function c4ProjectionUnit() {
  // Pure typed-value projector fixture. No C0–C3 producer, PID, stage success or admission is claimed.
  const home = mkdtempSync(path.join(root, 'c4-projection-'));
  const dirs = Object.fromEntries(['execution', 'output', 'feed', 'dotnet', 'slot'].map(role => {
    const folder = path.join(home, role); mkdirSync(folder); return [role, folder];
  }));
  const ref = value => hash(value), bytes = Buffer.from('plain unit input\n');
  // Only a path role is needed by this pure projection; no executable is created or replaced.
  const dotnet = path.join(dirs.dotnet, 'UNUSED-UNIT-DOTNET-ROLE');
  const file = (name, value = 'file') => ({ path: name, bytes: value.length, sha256: ref(value) });
  const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  const source = { candidate: { e0: base, head, tree: 'a'.repeat(40), modulesBlob: 'b'.repeat(40) },
    sourceReference: { path: 'vendor/openfilm', url: 'https://example.invalid/unit', commit: 'c'.repeat(40), tree: 'd'.repeat(40) } };
  const cases = { count: 1, cases: [{ id: 'case-unit', outcome: 'Passed' }] };
  const graph = { staticProof: { parserSha256: ref('parser'), files: 1, sha256: ref('static') },
    ...Object.fromEntries(['profileSha256', 'packageManifestSha256', 'lockSha256', 'nodeSha256'].map(role => [role, ref(role)])),
    vite: 'unit', tailwind: 'unit', studioAssetReferences: ['./font.woff2'],
    builds: ['auth', 'studio'].map(track => ({ track, graphSha256: ref(track), edgeSha256: ref(track + '-edges'),
      modules: 1, chunkModules: 1, reactRoots: { react: 1, 'react-dom': 1 }, artifacts: [{ name: 'index.js', bytes: 2, sha256: ref(track) }] })) };
  const ids = ['node-version', 'diff-check', 'desktop-types', 'desktop-build-main', 'desktop-build-preload',
    'desktop-build-renderer', 'desktop-build-studio', 'studio-job-compile', 'windows-studio-tap', 'windows-tap',
    'windows-auth-fixture-tap', 'windows-auth-service-tap', 'contracts-generated-check', 'contracts-ts-tap',
    'dotnet-sdk-version', 'contracts-dotnet-restore', 'contracts-dotnet-test'];
  const commands = ids.map(id => ({ id, executable: process.execPath, cwd: dirs.execution, args: ['--version'],
    exitCode: 0, signal: null, error: undefined, started: new Date(1000).toISOString(), ended: new Date(1001).toISOString() }));
  commands[1].args = ['core.attributesFile=' + path.join(dirs.output, 'home/gitconfig')];
  const scanArgs = (mode, name = 'orange/a.txt', slot = dirs.slot) => ['dir', mode ? 'g3-content.txt' : path.join(slot, 'snapshot', name),
    '--config', path.join(slot, 'gitleaks.toml'), '--gitleaks-ignore-path', path.join(slot, 'empty-ignore'),
    '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color', '--log-level', 'error', '--timeout', '60',
    '--report-format', 'json', '--report-path', path.join(slot, 'native-report.json')];
  const report = { changedFiles: ['a.txt'], rendererGraph: graph, g2: { commands,
    windows: { ...cases, studio: cases, authFixture: cases, authService: cases, desktopLease: 'unit-lease-a' },
    contracts: { ts: cases, dotnet: cases, freeze: { schemaSha256: ref('schema') }, restoreLock: { file: 'unused' } },
    build: { appVersion: 'unit', buildCommit: head, mainSha256: ref('main') } },
    g3: { deadline: new Date(Date.now() + 10000).toISOString(), secret: { owners: [{ command: { cwd: dirs.slot }, pid: 0 }],
      receipts: ['orange/.gitmodules', 'orange/a.txt'].map(name => ({ ...file(name), scans: [0, 1].map(mode => ({ mode: mode ? 'neutral-content' : 'original-path',
        inputSha256: ref('file'), exitCode: 0, findings: [], started: 'runtime-not-stable',
        command: { executable: 'unit-gitleaks', cwd: dirs.slot, args: scanArgs(mode, name) } })) })) },
    dependencies: { exitCode: 0, findings: [], owners: [{ command: { cwd: dirs.slot } }], command: { executable: 'unit-osv', cwd: dirs.slot,
      args: ['scan', 'source', '--offline', '--no-resolve', '--no-call-analysis=all', '--config', path.join(dirs.slot, 'osv.toml'),
        '--format=json', '--all-packages', '--all-vulns', '--output-file', path.join(dirs.slot, 'osv.json'),
        '--lockfile', path.join(dirs.slot, 'pnpm-lock.yaml')] }, sources: [{ ecosystem: 'npm', path: 'pnpm-lock.yaml',
      packages: [{ name: 'x', version: '1.0.0' }, { name: 'x', version: '2.0.0' }] }] } } };
  const control = path.join(home, 'control.json'); writeFileSync(control, '{}');
  const context = { report, card: { taskId: 'T01.unit', assignmentRevision: 1, branch: 'unit', writeSet: ['a.txt'] },
    base, head, cardFile: control, indexFile: control, index: {}, tree: new Map([['.gitmodules', { oid: 'b'.repeat(40) }]]),
    studioScope: [{ parent: base, commit: head, changes: [{ path: 'a.txt', status: 'A' }] }] };
  const c2 = { execution: { commands, executionRoot: dirs.execution, outputRoot: dirs.output }, planFile: control,
    plan: { tools: { node: { path: process.execPath, sha256: ref('node') }, dotnet: { path: dotnet, sha256: ref('dotnet') } }, nugetFeed: { path: dirs.feed, files: [file('one.nupkg')] } },
    tools: { node: process.execPath, dotnet }, job: { folder: dirs.output },
    electron: { entry: path.join(dirs.execution, 'node_modules/x/index.js'), exe: path.join(dirs.execution, 'node_modules/x/index.js'), version: 'unit' },
    inputs: new Map([['a.txt', bytes]]), expectedBuild: { expected: new Map([['dist/index.js', file('dist/index.js')]]) },
    deps: { files: new Map([['node_modules/x/index.js', file('node_modules/x/index.js')]]),
      links: new Map([['node_modules/x', 'node_modules/.pnpm/x']]), packages: [{ name: 'x', version: '1.0.0',
        physicalRootFromNodeModules: '.pnpm/x', generated: [] }] }, fixture: [{ id: 'case-unit', kind: 'json' }],
    restoreStable: { packages: [['cache/file', ref('cache')]], metadata: [['meta.json', ref('meta')]] } };
  const studio = { studioSource: source, upstream: new Map([['packages/openfilm/unit.ts', bytes]]),
    notices: new Map([['LICENSE', bytes]]), c2, inputs: { profile: { inputs: [file('a.txt')], fixedUpstream: { closure: [
      { path: 'packages/openfilm/unit.ts', oid: blob, bytes: bytes.length, sha256: ref(bytes), active: true }] } },
    manifest: { packages: [{ id: 'unit', physical: 'node_modules/unit', files: [file('index.js')] }], links: [] } } };
  const c3 = { planFile: control, snapshot: dirs.slot, tools: { gitleaks: 'unit-gitleaks', osv: 'unit-osv' }, plan: { tools: {
    gitleaks: { path: 'unit-gitleaks', sha256: ref('gitleaks') }, osv: { path: 'unit-osv', sha256: ref('osv') } } },
    entries: [file('orange/a.txt'), file('orange/.gitmodules')], fonts: [{ ...file('font.woff2'), packageFile: 'files/font.woff2' }],
    audit: { locks: [{ file: path.join(dirs.slot, 'pnpm-lock.yaml'), ecosystem: 'npm' }], npm: [{ name: 'x', version: '1.0.0' }, { name: 'x', version: '2.0.0' }],
      native: { bytes: Buffer.from('{}'), lockSha256: ref('{}'), packages: [{ name: 'N', version: '1.0.0' }] },
      database: { manifestSha256: ref('db'), archives: [{ ecosystem: 'npm', generation: '1', size: 1, sha256: ref('archive') }] } } };
  return { context, studio, c3, dirs, control, redistribute() {
    const other = path.join(home, 'other-slot'); mkdirSync(other);
    report.g3.secret.owners.push({ command: { cwd: other }, pid: 0 });
    const row = report.g3.secret.receipts[1];
    row.scans.forEach((scan, mode) => { scan.command = { executable: 'unit-gitleaks', cwd: other, args: scanArgs(mode, row.path, other) }; });
  } };
}
test('Studio C4 complete typed projection binds real content roles but excludes only run entropy', async () => {
  const g = await c4Helpers(), fixture = c4ProjectionUnit();
  const project = () => g.studioG4ProjectVerified(fixture.context, fixture.studio, fixture.c3);
  const before = project();
  const relocated = c4ProjectionUnit();
  assert.equal(g.studioG4ProjectVerified(relocated.context, relocated.studio, relocated.c3).inputsSha256, before.inputsSha256,
    'physical isolated execution roots must not leak into stable command roles');
  relocated.redistribute();
  assert.equal(g.studioG4ProjectVerified(relocated.context, relocated.studio, relocated.c3).inputsSha256, before.inputsSha256,
    'legal one-to-two slot redistribution preserves exact coverage semantics');
  assert.equal(Object.keys(before.families).length, 24);
  const runtimeBefore = g.studioG4RunEvidence(fixture.context, fixture.studio, fixture.c3, before, null);
  fixture.context.report.g2.commands[0].started = new Date(2000).toISOString();
  fixture.context.report.g2.windows.desktopLease = 'unit-lease-b'; fixture.context.report.g3.secret.owners[0].pid = 7;
  fixture.context.report.g3.secret.receipts[0].scans[0].started = 'new-runtime';
  fixture.context.report.g3.deadline = new Date(Date.now() + 20000).toISOString();
  assert.equal(project().inputsSha256, before.inputsSha256);
  assert.notEqual(g.studioG4RunEvidence(fixture.context, fixture.studio, fixture.c3, before, null).receiptsSha256,
    runtimeBefore.receiptsSha256);
  const mutations = [
    () => { fixture.context.report.rendererGraph.builds[0].artifacts[0].sha256 = hash('auth JS changed'); },
    () => { fixture.c3.fonts[0].sha256 = hash('font changed'); },
    () => { fixture.c3.audit.database.archives[0].generation = '2'; },
    () => { fixture.c3.audit.npm[0].version = '1.0.1'; },
    () => { fixture.studio.c2.inputs.set('a.txt', Buffer.from('changed input')); },
    () => { fixture.studio.c2.execution.commands[0].args = ['--different']; },
    () => { fixture.context.report.g2.contracts.ts.cases[0].id = 'new-case'; },
  ];
  for (const mutate of mutations) { const previous = project().inputsSha256; mutate(); assert.notEqual(project().inputsSha256, previous); }
  assert.throws(() => g.studioG4Projection(fixture.context, fixture.studio, fixture.c3), { gateCode: 'G4_INPUTS_UNAVAILABLE' },
    'unit data must not mint the real in-process continuation');
  assert.throws(() => g.runStudioG4(null, fixture.context, fixture.studio, fixture.c3), { gateCode: 'G4_INPUTS_UNAVAILABLE' });
});

function c4ArchiveRaw(label, refs, metadata) {
  const evidence = process.env.ORANGE_TEST_STUDIO_C4_EVIDENCE;
  if (!evidence) return;
  const folder = path.join(evidence, label); mkdirSync(folder, { recursive: true });
  const files = refs.map(({ file, bytes, sha256 }, ordinal) => {
    const raw = readFileSync(file); assert.equal(raw.length, bytes); assert.equal(hash(raw), sha256);
    const name = ordinal + '-' + path.basename(file); writeFileSync(path.join(folder, name), raw, { flag: 'wx' });
    return { path: name, bytes, sha256 };
  });
  writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ scope: 'Focused raw native scanner unit evidence only; not C0–C3/admission',
    files, metadata }, null, 2) + '\n', { flag: 'wx' });
}
test('Studio C4 actual owned scanner carries native raw buffers and rejects a changed retained original',
  { skip: !g3Tooling && 'requires fixed offline scanner' }, async () => {
    const moduleURL = process.env.ORANGE_TEST_STUDIO_C4_RAW_BASELINE
      ? (await import('node:url')).pathToFileURL(process.env.ORANGE_TEST_STUDIO_C4_RAW_BASELINE) : g4Module;
    const g = await import(moduleURL), helpers = await c4Helpers(); await c3SlotSetup();
    const output = mkdtempSync(path.join(root, 'c4-native-')), snapshot = path.join(output, 'snapshot'); mkdirSync(snapshot);
    const entries = ['a.txt', 'b.svg', 'pnpm-lock.yaml'].map(name => {
      save(snapshot, name, 'clean fixture\n'); return { path: name, bytes: 14, sha256: hash('clean fixture\n') };
    });
    const control = path.join(output, 'control.json'); writeFileSync(control, 'active');
    const receipts = await g.runStudioG3Workers({ entries, snapshot, output, ref: g3ToolRefs(g3Tooling).gitleaks,
      protectedRoots: [output], checkControl: () => 20000, controls: [[control, hash('active')]],
      job: studioJobSetup.job, tools: studioJobSetup.tools, deadline: Date.now() + 20000, workers: 2 });
    const refs = [];
    for (const row of receipts) for (const scan of row.scans) {
      assert.equal(scan.exitCode, 0); assert.deepEqual(scan.findings, []);
      assert.ok(scan.raw, 'successful native scans must retain exact native report/stdout/stderr references');
      assert.deepEqual(JSON.parse(readFileSync(scan.raw.report.file)), []);
      for (const role of ['report', 'stdout', 'stderr']) {
        const ref = scan.raw[role]; refs.push(ref);
        assert.equal(hash(readFileSync(ref.file)), scan[role + 'Sha256']);
        assert.equal(readFileSync(ref.file).length, ref.bytes);
        assert.equal(path.dirname(ref.file), path.join(scan.command.cwd, 'raw'));
      }
      assert.equal(existsSync(path.join(scan.command.cwd, 'native-report.json')), false);
    }
    assert.equal(refs.length, 18);
    assert.ok(receipts.owners.every(owner => owner.ioBytes >= owner.nativeBytes && owner.ioBytes <= 16 * 1024 * 1024));
    c4ArchiveRaw('native-secret', refs, { receipts, owners: receipts.owners });
    const scan = receipts[0].scans[0], cwd = scan.command.cwd;
    const hashes = { report: scan.reportSha256, stdout: scan.stdoutSha256, stderr: scan.stderrSha256 };
    const stem = path.basename(scan.raw.report.file).replace(/\.report\.bin$/, '');
    helpers.verifyStudioG3Raw(scan.raw, cwd, stem, hashes);
    writeFileSync(scan.raw.report.file, '[ ]\nchanged');
    assert.throws(() => helpers.verifyStudioG3Raw(scan.raw, cwd, stem, hashes), { gateCode: 'G3_RAW_CHANGED' });
  });

test('Studio C4 actual OSV retains same validated bytes only when explicitly requested on zero findings',
  { skip: !g3Tooling && 'requires fixed offline scanner/db' }, async () => {
    const g = await c4Helpers(), output = mkdtempSync(path.join(root, 'c4-osv-'));
    const db = path.join(output, 'db'); materializeG3Database(g3DatabaseRef(g3Tooling), db, [output]);
    const tool = verifyG3Tool('osv', g3ToolRefs(g3Tooling).osv, [output]);
    const config = path.join(output, 'osv.toml'); writeFileSync(config, '');
    const lock = path.join(output, 'package-lock.json');
    writeFileSync(lock, JSON.stringify({ name: 'c4-unit', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'c4-unit', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } },
        'node_modules/is-number': { version: '7.0.0', resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz' } } }));
    const env = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: output, TMP: output, HOME: output, USERPROFILE: output };
    const call = rawSink => runG3OSV({ tool, locks: [{ file: lock, ecosystem: 'npm', packages: [{ name: 'is-number', version: '7.0.0' }] }],
      config, cwd: output, env, db, checkControl: () => 120000, file: path.join(output, 'native.json'), rawSink });
    const legacy = call(); assert.equal(legacy.raw, undefined); assert.equal(existsSync(path.join(output, 'native.json')), false);
    const retained = call(g.studioG3RawSink(output, 'osv', () => 120000, { bytes: 0 }));
    assert.equal(retained.exitCode, 0); assert.deepEqual(retained.findings, []);
    for (const role of ['report', 'stdout', 'stderr']) assert.equal(hash(readFileSync(retained.raw[role].file)), retained[role + 'Sha256']);
    assert.ok(readFileSync(retained.raw.report.file).includes(Buffer.from('is-number')));
    assert.equal(existsSync(path.join(output, 'native.json')), false);
    c4ArchiveRaw('native-osv', Object.values(retained.raw), retained);
  });

test('Studio C4 v2 rejects duplicate JSON approval keys even when the last value is approved', async () => {
  const { loadG4Review } = await c4Helpers();
  const fixture = g4Fixture('c4-duplicate-key', record => { record.schemaVersion = 2; record.subject.lane = 'studio-dual'; });
  const raw = readFileSync(fixture.review, 'utf8').replace('"quality":"approved"', '"qual\\u0069ty":"pending","quality":"approved"');
  writeFileSync(fixture.review, raw); fixture.index.reviewApproval.sha256 = hash(raw);
  const context = { root: tree, common: repo, base, head, card: approved,
    index: { ...fixture.index, cards: [approved] }, changes: approved.writeSet,
    studioSource: { candidate: { tree: fixture.subject.tree } } };
  assert.throws(() => loadG4Review(fixture.review, context), { gateCode: 'G4_REVIEW_INVALID' });
});


test('Studio C4 typed projection refuses incomplete coverage, lane alias, source drift and unroleable paths', async () => {
  const g = await c4Helpers();
  const mutate = [
    f => { f.c3.fonts = []; },
    f => { f.context.report.g3.secret.receipts.pop(); },
    f => { f.context.report.g3.secret.receipts[0].scans.pop(); },
    f => { f.context.report.rendererGraph.builds.reverse(); },
    f => { const a = f.context.report.rendererGraph.builds[0].artifacts[0];
      f.context.report.rendererGraph.builds[0].artifacts.push({ ...a, name: a.name.toUpperCase() }); },
    f => { f.studio.upstream.set('packages/openfilm/unit.ts', Buffer.from('changed authorized source')); },
    f => { f.studio.c2.execution.commands[0].args = ['--unrecognized=' + f.dirs.output]; },
    f => { f.studio.c2.execution.commands[0].args = [path.join(root, 'outside-role-root')]; },
    f => { f.context.report.g3.dependencies.command.args.push('--resolve'); },
    f => { f.studio.c2.execution.commands[0].exitCode = 1; },
  ];
  for (const change of mutate) {
    const fixture = c4ProjectionUnit(); change(fixture);
    assert.throws(() => g.studioG4ProjectVerified(fixture.context, fixture.studio, fixture.c3), { gateCode: 'G4_INPUTS_UNAVAILABLE' });
  }
});

test('Studio C4 path roles cannot collide with literal argv tokens', async () => {
  const g = await c4Helpers(), f = c4ProjectionUnit();
  const project = () => g.studioG4ProjectVerified(f.context, f.studio, f.c3).inputsSha256;
  f.studio.c2.execution.commands[0].args = [path.join(f.dirs.execution, 'a.txt')];
  const physical = project(); f.studio.c2.execution.commands[0].args = ['execution:a.txt'];
  assert.notEqual(project(), physical, 'a physical argument role must not collapse into a literal string');
  f.studio.c2.execution.commands[0].args = [process.execPath];
  const tool = project(); f.studio.c2.execution.commands[0].args = ['tool:node'];
  assert.notEqual(project(), tool, 'a fixed executable argument role must not collapse into a literal string');
});


// Fix-round regressions keep C0-C3 as explicit non-authorizing unit-data boundaries.
// The private module is the actual entire source plus exports only; its WeakSet is
// not the real runner's private capability registry and is never exposed by the CLI.
function c4ScanUnitRows(entries, cwd, executable = 'unit-gitleaks') {
  return entries.map(entry => ({ ...entry, findings: [], scans: [false, true].map(neutral => ({
    mode: neutral ? 'neutral-content' : 'original-path', inputSha256: entry.sha256, exitCode: 0, findings: [],
    command: { executable, cwd, args: ['dir', neutral ? 'g3-content.txt' : path.join(cwd, 'snapshot', entry.path),
      '--config', path.join(cwd, 'gitleaks.toml'), '--gitleaks-ignore-path', path.join(cwd, 'empty-ignore'),
      '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color', '--log-level', 'error', '--timeout', '60',
      '--report-format', 'json', '--report-path', path.join(cwd, 'native-report.json')] },
  })) }));
}
test('Studio C4 R3 actual tracked blob and nonblob coverage project equal identities without losing provenance', async () => {
  const g = await c4Helpers(), f = c4ProjectionUnit(), candidate = candidateRepo();
  save(candidate.checkout, '.gitmodules', '# plain private tracked fixture\n');
  save(candidate.checkout, 'a.txt', 'actual tracked fixture\n');
  candidate.gitHere('add', '--', '.gitmodules', 'a.txt'); const current = candidate.commitHere();
  const trackedTree = readTree(candidate.checkout, current), snapshot = path.join(path.dirname(f.dirs.execution), 'tracked-snapshot');
  const tracked = g.g3SourceSnapshot(candidate.checkout, trackedTree, snapshot).entries.map(row => ({ ...row, path: 'orange/' + row.path }));
  const value = Buffer.from('nontracked fixture text\n');
  const other = ['openfilm/unit.ts', 'notices/LICENSE', 'build/index.js'].map(name => ({ path: name, bytes: value.length, sha256: hash(value) }));
  assert.equal(tracked.length, 3); assert.ok(tracked.every(row => /^[0-9a-f]{40}$/.test(row.blob)));
  assert.ok(other.every(row => !Object.hasOwn(row, 'blob')));
  f.context.tree = trackedTree; f.c3.entries = [...tracked, ...other];
  f.context.report.g3.secret.receipts = c4ScanUnitRows(f.c3.entries, f.dirs.slot);
  const projection = g.studioG4ProjectVerified(f.context, f.studio, f.c3);
  const modules = tracked.find(row => row.path === 'orange/.gitmodules');
  assert.equal(projection.families['c3-coverage'].find(row => row.path === modules.path).blob, trackedTree.get('.gitmodules').oid);
  assert.equal(projection.families['source-policy'].modules.blob, modules.blob);
  assert.equal(projection.families['source-policy'].modules.oid, modules.blob);
  const before = projection.inputsSha256;
  modules.blob = '0'.repeat(40);
  assert.notEqual(g.studioG4ProjectVerified(f.context, f.studio, f.c3).inputsSha256, before, 'blob provenance remains a stable input');
  modules.blob = trackedTree.get('.gitmodules').oid;
  for (const mutate of [rows => rows.pop(), rows => rows.push({ ...rows[0] }), rows => { rows[0].bytes++; },
    rows => { rows[0].sha256 = hash('wrong content'); }]) {
    const saved = f.context.report.g3.secret.receipts;
    f.context.report.g3.secret.receipts = structuredClone(saved); mutate(f.context.report.g3.secret.receipts);
    assert.throws(() => g.studioG4ProjectVerified(f.context, f.studio, f.c3), { gateCode: 'G4_INPUTS_UNAVAILABLE' });
    f.context.report.g3.secret.receipts = saved;
  }
});

async function c4FinalControlUnit({ lease = 'valid', afterGuard } = {}) {
  const g = await c4Helpers(), f = c4ProjectionUnit(), candidate = candidateRepo();
  save(candidate.checkout, '.gitmodules', '# isolated G4 control fixture\n');
  save(candidate.checkout, 'a.txt', 'isolated G4 control fixture\n');
  candidate.gitHere('add', '--', '.gitmodules', 'a.txt'); const current = candidate.commitHere();
  const card = { ...approved, worktree: candidate.checkout, branch: 'admission-fixture', baselineCommit: candidate.start,
    workingBaselineCommit: candidate.start, headCommit: current, writeSet: ['.gitmodules', 'a.txt'] };
  const until = Date.now() + 60000, leaseUntil = lease === 'expired' ? Date.now() - 1000 : Date.now() + (lease === 'post-decision' ? 1000 : 30000);
  const control = path.join(path.dirname(f.dirs.execution), 'controls'); mkdirSync(control);
  const cardFile = path.join(control, 'card.json'), indexFile = path.join(control, 'index.json');
  const g2File = path.join(control, 'g2-plan.json'), g3File = path.join(control, 'g3-plan.json');
  const plan = { ...g2FixturePlan(f.dirs.execution), taskId: card.taskId, assignmentRevision: card.assignmentRevision,
    base: candidate.start, head: current, tree: candidate.gitHere('rev-parse', 'HEAD^{tree}'), outputRoot: f.dirs.output,
    validUntil: new Date(until).toISOString(), desktopLease: { id: 'fixture-c4-desktop', holder: card.taskId,
      validUntil: new Date(leaseUntil).toISOString() }, tools: f.studio.c2.plan.tools, nugetFeed: f.studio.c2.plan.nugetFeed };
  const g3Plan = { ...f.c3.plan, schemaVersion: 1, taskId: card.taskId, assignmentRevision: card.assignmentRevision,
    base: candidate.start, head: current, tree: plan.tree, validUntil: plan.validUntil, outputRoot: f.dirs.slot };
  const planBytes = JSON.stringify(plan), g3Bytes = JSON.stringify(g3Plan);
  const index = { schemaVersion: 1, validUntil: plan.validUntil, cards: [card], g2PlanSha256: hash(planBytes), g3PlanSha256: hash(g3Bytes),
    resourceLeases: lease === 'revoked' ? [] : [{ kind: 'desktop', id: plan.desktopLease.id, holder: card.taskId }] };
  Object.assign(f.context, { root: candidate.checkout, common: candidate.common, tree: readTree(candidate.checkout, current),
    card, index, cardFile, indexFile, base: candidate.start, head: current, changes: card.writeSet,
    studioSource: f.studio.studioSource, studioScope: [{ parent: candidate.start, commit: current, changes: card.writeSet.map(name => ({ path: name, status: 'A' })) }] });
  f.studio.studioSource.candidate.tree = plan.tree;
  f.studio.protectedRoots = [candidate.checkout, candidate.common];
  Object.assign(f.studio.c2, { plan, planFile: g2File });
  Object.assign(f.c3, { plan: g3Plan, planFile: g3File });
  f.context.report.changedFiles = card.writeSet;
  f.context.report.fixtureScope = 'C0-C3 are typed unit data only; capability minted only in isolated appended-export copy, not the actual runner; real G4 and original control validators execute';
  f.context.report.admitted = false;
  f.context.report.checks = ['write-set', 'imports', 'format-types', 'dependency-audit', 'secret-scan',
    'import-build-graph', 'windows', 'contracts', 'independent-review'].map(id => ({ id,
      exitCode: id === 'independent-review' ? null : 0, status: id === 'independent-review' ? 'unavailable' : 'passed' }));
  const evidencePath = path.join(control, 'review-evidence.txt'), review = path.join(control, 'review.json');
  writeFileSync(evidencePath, 'Isolated real G4 closure/control regression; never a formal review approval.\n');
  const inputsSha256 = g.studioG4ProjectVerified(f.context, f.studio, f.c3).inputsSha256;
  const subject = { taskId: card.taskId, assignmentRevision: card.assignmentRevision, branch: card.branch,
    base: candidate.start, head: current, tree: plan.tree, lane: 'studio-dual', scopeKind: 'integration',
    scopeSha256: hash(JSON.stringify(['integration', [...card.writeSet].sort(), [...card.writeSet].sort()])), inputsSha256 };
  const record = { schemaVersion: 2, subject, reviewerId: '/root/unit-reviewer', specs: 'approved', quality: 'approved',
    evidenceSha256: hash(readFileSync(evidencePath)) };
  const reviewBytes = JSON.stringify(record); writeFileSync(review, reviewBytes);
  index.reviewApproval = { sha256: hash(reviewBytes), scopeKind: 'integration', reviewerId: record.reviewerId,
    authors: ['/root/unit-author'], evidencePath, evidenceSha256: record.evidenceSha256 };
  writeFileSync(cardFile, JSON.stringify(card)); writeFileSync(indexFile, JSON.stringify(index));
  writeFileSync(g2File, planBytes); writeFileSync(g3File, g3Bytes);
  const controls = { cardFile, indexFile, planFile: g2File, card, index, protectedRoots: [candidate.checkout, candidate.common, f.dirs.execution, f.dirs.output] };
  const g3Controls = { ...controls, planFile: g3File }, calls = []; let guards = 0;
  f.studio.c2.checkControl = desktop => { const remaining = verifyG2Control(controls, desktop); calls.push({ desktop, remaining }); return remaining; };
  f.c3.checkControl = () => verifyG3Control(g3Controls);
  // This is the explicit C3-unit boundary: real original control validators run;
  // no C3 scanner/build success, process identity or fresh formal authority is fabricated.
  f.c3.guard = () => { verifyG2Control(controls); verifyG3Control(g3Controls); guards++; afterGuard?.({ guards, leaseUntil, controls, indexFile, cardFile, g2File, planBytes, card, index }); };
  g.studioG4Continuations.add(f.c3); // The isolated copy only; the real runner registry remains inaccessible.
  return { ...f, g, review, controls, calls, leaseUntil, get guardCalls() { return guards; } };
}
test('Studio C4 R3 real G4 unit finalizer preserves valid desktop lease positive', async () => {
  const f = await c4FinalControlUnit();
  assert.ok(verifyG2Control(f.controls, true) > 0);
  f.g.runStudioG4(f.review, f.context, f.studio, f.c3);
  assert.equal(f.context.report.code, 'CANDIDATE_CHECKS_PASSED'); assert.equal(f.context.report.admitted, true);
  assert.ok(f.calls.length >= 2 && f.calls.every(({ desktop, remaining }) => desktop === true && remaining > 0),
    'real original lease validation surrounds final decision, not just a spy flag');
});
test('Studio C4 R3 real G4 rejects an expired lease while original main plan remains valid', async () => {
  const f = await c4FinalControlUnit({ lease: 'expired' });
  assert.ok(verifyG2Control(f.controls) > 0);
  assert.throws(() => verifyG2Control(f.controls, true), { gateCode: 'G2_LEASE_EXPIRED' });
  assert.throws(() => f.g.runStudioG4(f.review, f.context, f.studio, f.c3), { gateCode: 'G2_LEASE_EXPIRED' });
  assert.equal(f.context.report.admitted, false);
});
test('Studio C4 R3 real G4 rejects natural lease expiry after the unit decision with main plan still valid', async () => {
  const f = await c4FinalControlUnit({ lease: 'post-decision', afterGuard({ guards, leaseUntil, controls }) {
    if (guards === 2) { while (Date.now() <= leaseUntil) { /* Real short expiry, no mocked clock or renewed authority. */ } assert.ok(verifyG2Control(controls) > 0); }
  } });
  assert.throws(() => f.g.runStudioG4(f.review, f.context, f.studio, f.c3), { gateCode: 'G2_LEASE_EXPIRED' });
  assert.ok(f.guardCalls >= 2, 'reach actual post-decision freshness control before natural expiry');
  assert.equal(f.context.report.checks.find(row => row.id === 'independent-review').status, 'passed');
  assert.ok(f.context.report.independentReview?.subject.inputsSha256);
  assert.equal(f.context.report.admitted, false);
});


test('Studio C4 R3 real G4 rejects revoked authority and fresh control review evidence or physical source drift', async () => {
  const revoked = await c4FinalControlUnit({ lease: 'revoked' });
  assert.ok(verifyG2Control(revoked.controls) > 0);
  assert.throws(() => verifyG2Control(revoked.controls, true), { gateCode: 'G2_LEASE_UNAVAILABLE' });
  assert.throws(() => revoked.g.runStudioG4(revoked.review, revoked.context, revoked.studio, revoked.c3), { gateCode: 'G2_LEASE_UNAVAILABLE' });
  const cases = [
    ['revoke-before-decision', 1, ({ indexFile, index }) => writeFileSync(indexFile, JSON.stringify({ ...index, resourceLeases: [] })), 'G2_CONTROL_CHANGED'],
    ['revoke-after-decision', 2, ({ indexFile, index }) => writeFileSync(indexFile, JSON.stringify({ ...index, resourceLeases: [] })), 'G2_CONTROL_CHANGED'],
    ['plan-byte-drift', 1, ({ g2File, planBytes }) => writeFileSync(g2File, planBytes + '\n'), 'G2_CONTROL_CHANGED'],
    ['card-revision-drift', 1, ({ cardFile, card }) => writeFileSync(cardFile, JSON.stringify({ ...card, assignmentRevision: card.assignmentRevision + 1 })), 'CARD_STALE'],
    ['physical-source-drift', 1, (_, f) => writeFileSync(path.join(f.context.root, 'a.txt'), 'changed source bytes\n'), 'WORKTREE_DIRTY'],
    ['review-byte-drift', 1, (_, f) => writeFileSync(f.review, readFileSync(f.review, 'utf8') + '\n'), 'G4_REVIEW_UNTRUSTED'],
    ['review-evidence-drift', 1, (_, f) => writeFileSync(f.context.index.reviewApproval.evidencePath, 'changed evidence\n'), 'G4_REVIEW_EVIDENCE'],
  ];
  for (const [name, phase, mutate, code] of cases) {
    const f = await c4FinalControlUnit({ afterGuard(value) { if (value.guards === phase) mutate(value, f); } });
    assert.throws(() => f.g.runStudioG4(f.review, f.context, f.studio, f.c3), { gateCode: code }, name);
    assert.equal(f.context.report.admitted, false, name);
  }
});


// R4: real pinned-tool physical producer; C0-C3/report semantics below remain explicit unit data.
// Removing the validated-tool handoff or comparing the raw plan spelling must reject these positives.
for (const role of ['gitleaks', 'osv']) test('Studio C4 R4 real verified ' + role + ' producer accepts separated raw-plan spelling',
  { skip: !g3Tooling && 'requires fixed scanner artifacts' }, async (t) => {
    const g = await c4Helpers(), f = c4ProjectionUnit();
    const ref = { ...g3ToolRefs(g3Tooling)[role] };
    ref.path = ref.path.split('\\').join('/'); // Input fixture only, never production normalization.
    const physical = verifyG3Tool(role, ref, [root]);
    assert.equal(physical, realpathSync.native(ref.path)); assert.notEqual(physical, ref.path);
    assert.equal(hash(readFileSync(physical)), ref.sha256);
    f.c3.plan.tools[role] = ref;
    f.c3.tools = { gitleaks: 'unit-gitleaks', osv: 'unit-osv', [role]: physical };
    if (role === 'gitleaks') f.context.report.g3.secret.receipts.forEach(row => row.scans.forEach(scan => { scan.command.executable = physical; }));
    else f.context.report.g3.dependencies.command.executable = physical;
    t.diagnostic(JSON.stringify({ scope: 'real verifyG3Tool; typed C0-C3 unit data, no admission', role, raw: ref.path, physical, sha256: ref.sha256 }));
    assert.match(g.studioG4ProjectVerified(f.context, f.studio, f.c3).inputsSha256, /^[0-9a-f]{64}$/);
  });


test('Studio C4 R4 rejects missing handoff, report aliases, swapped tools and untrusted physical inputs',
  { skip: !g3Tooling && 'requires fixed scanner artifacts' }, async () => {
    const g = await c4Helpers();
    for (const role of ['gitleaks', 'osv']) {
      const ref = { ...g3ToolRefs(g3Tooling)[role] }; ref.path = ref.path.split('\\').join('/');
      const physical = verifyG3Tool(role, ref, [root]);
      const fixture = () => {
        const f = c4ProjectionUnit(); f.c3.plan.tools[role] = ref; f.c3.tools[role] = physical;
        if (role === 'gitleaks') f.context.report.g3.secret.receipts.forEach(row => row.scans.forEach(scan => { scan.command.executable = physical; }));
        else f.context.report.g3.dependencies.command.executable = physical;
        return f;
      };
      const project = f => g.studioG4ProjectVerified(f.context, f.studio, f.c3);
      const missing = fixture(); delete missing.c3.tools; assert.throws(() => project(missing), { gateCode: 'G4_INPUTS_UNAVAILABLE' });
      for (const executable of [ref.path, g3ToolRefs(g3Tooling)[role === 'osv' ? 'gitleaks' : 'osv'].path, physical + '.other']) {
        const f = fixture();
        if (role === 'gitleaks') f.context.report.g3.secret.receipts[0].scans[0].command.executable = executable;
        else f.context.report.g3.dependencies.command.executable = executable;
        assert.throws(() => project(f), { gateCode: 'G4_INPUTS_UNAVAILABLE' }, role + ': unvalidated report executable');
      }
      assert.throws(() => verifyG3Tool(role, { ...ref, sha256: '0'.repeat(64) }, [root]), { gateCode: 'G3_TOOL_UNTRUSTED' });
      assert.throws(() => verifyG3Tool(role, ref, [path.dirname(physical)]), { gateCode: 'G3_TOOL_UNTRUSTED' });
      const bad = mkdtempSync(path.join(root, 'c4-tool-content-'));
      const wrong = path.join(bad, path.basename(physical)); writeFileSync(wrong, 'not the approved executable');
      assert.throws(() => verifyG3Tool(role, { ...ref, path: wrong }, [tree]), { gateCode: 'G3_TOOL_UNTRUSTED' });
      const alias = path.join(bad, 'linked'); symlinkSync(path.dirname(physical), alias, 'junction');
      assert.throws(() => verifyG3Tool(role, { ...ref, path: path.join(alias, path.basename(physical)) }, [tree]), { gateCode: 'G3_TOOL_UNTRUSTED' });
    }
  });
