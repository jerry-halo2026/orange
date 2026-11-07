import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const sha = /^[0-9a-f]{40}$/;
const id = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const resourceKinds = new Set(['desktop', 'tcp-port', 'test-db', 'profile', 'cache', 'output', 'gpu', 'account', 'jianying']);
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)));
Object.assign(gitEnv, { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' });
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function requireThat(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { gateCode: code });
}
export function parseArgs(args, names, optional = []) {
  requireThat(args.length % 2 === 0 && args.length >= names.length * 2
    && args.length <= (names.length + optional.length) * 2, 'BAD_ARGUMENTS');
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const [key, value] = args.slice(i, i + 2);
    requireThat((names.includes(key) || optional.includes(key)) && value && !flags.has(key), 'BAD_ARGUMENTS');
    flags.set(key, value);
  }
  requireThat(names.every((key) => flags.has(key)), 'BAD_ARGUMENTS');
  return Object.fromEntries(flags);
}
export function cli(moduleUrl, main) {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(moduleUrl)) return;
  const report = { schemaVersion: 1, admitted: false };
  try {
    main(process.argv.slice(2), report);
  } catch (error) {
    report.code = error.gateCode ?? 'GATE_ERROR';
  }
  console.log(JSON.stringify(report));
  process.exitCode = report.code === 'IMPORT_PREFLIGHT_PASSED'
    || (report.code === 'CANDIDATE_CHECKS_PASSED' && report.admitted === true) ? 0 : 1;
}
export function exactSha(value) {
  return typeof value === 'string' && sha.test(value);
}
export function text(bytes) {
  return decoder.decode(bytes);
}
export function nulFields(bytes) {
  const input = text(bytes);
  requireThat(!input || input.endsWith('\0'), 'GIT_OUTPUT_INVALID');
  return input ? input.slice(0, -1).split('\0') : [];
}
export function fold(value) {
  return value.normalize('NFC').toLowerCase();
}
export function contained(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function gitExecutable(cwd) {
  // Resolve an absolute operator-installed executable, never a candidate-local git.exe.
  for (const entry of (gitEnv.PATH ?? gitEnv.Path ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    try {
      const file = realpathSync.native(path.join(entry, process.platform === 'win32' ? 'git.exe' : 'git'));
      if (!contained(cwd, file) && statSync(file).isFile()) return file;
    } catch {
      // Uninstalled path entry.
    }
  }
  requireThat(false, 'GIT_UNAVAILABLE');
}
export function git(cwd, ...args) {
  const common = textOptionPath(cwd);
  const result = spawnSync(gitExecutable(cwd), [
    '--no-replace-objects', '--no-optional-locks',
    '-c', 'safe.directory=' + common,
    '-c', 'core.fsmonitor=false', '-c', 'diff.ignoreSubmodules=none',
    '-C', cwd, ...args,
  ], { cwd: path.dirname(process.execPath), env: gitEnv, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  requireThat(result.status === 0, 'GIT_FAILED');
  return result.stdout;
}
function textOptionPath(value) {
  return process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
}
export function repositoryPath(value) {
  requireThat(typeof value === 'string' && value.length > 0 && value === value.normalize('NFC'), 'UNSAFE_PATH');
  const parts = value.split('/');
  requireThat(parts.every((part) =>
    part && part !== '.' && part !== '..' && fold(part) !== '.git'
    && !/[\x00-\x1f\x7f<>:"\\|?*]/.test(part) && !/[ .]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
    && !/~\d/i.test(part)), 'UNSAFE_PATH');
  return parts;
}
export function checkWorktreePath(root, name, expected = 'any') {
  const parts = repositoryPath(name);
  let current = root;
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    current = path.join(current, part);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT' && expected !== 'present') return;
      requireThat(false, 'WORKTREE_CONTENT_MISMATCH');
    }
    requireThat(!entry.isSymbolicLink() && realpathSync.native(current) === current, 'WORKTREE_LINK');
    requireThat(last ? expected !== 'absent' && entry.isFile() && entry.nlink === 1 : entry.isDirectory(),
      'WORKTREE_CONTENT_MISMATCH');
    if (last) return entry;
  }
}
function sameLocation(a, b) {
  return path.relative(a, b) === '';
}
function physical(value) {
  requireThat(typeof value === 'string' && path.isAbsolute(value), 'WORKTREE_PATH_INVALID');
  const resolved = path.resolve(value);
  const real = realpathSync.native(resolved);
  requireThat(sameLocation(real, resolved), 'WORKTREE_LINK');
  return real;
}
export function linkedWorktree(card) {
  const root = physical(card.worktree);
  const gitFile = lstatSync(path.join(root, '.git'));
  requireThat(gitFile.isFile() && !gitFile.isSymbolicLink() && gitFile.nlink === 1, 'WORKTREE_NOT_LINKED');
  const query = (...args) => text(git(root, 'rev-parse', ...args)).trimEnd();
  requireThat(sameLocation(physical(query('--show-toplevel')), root), 'WORKTREE_NOT_LINKED');
  requireThat(query('--show-superproject-working-tree') === '', 'WORKTREE_NOT_LINKED');
  const gitDir = physical(query('--path-format=absolute', '--git-dir'));
  const common = physical(query('--path-format=absolute', '--git-common-dir'));
  requireThat(!sameLocation(gitDir, common) && contained(path.join(common, 'worktrees'), gitDir), 'WORKTREE_NOT_LINKED');
  const records = nulFields(git(root, 'worktree', 'list', '--porcelain', '-z')).join('\0').split('\0\0');
  const branch = 'refs/heads/' + card.branch;
  requireThat(records.some((record) => {
    const [location, ...fields] = record.split('\0');
    return location.startsWith('worktree ') && sameLocation(location.slice(9), root)
      && fields.includes('HEAD ' + card.headCommit) && fields.includes('branch ' + branch)
      && !fields.some((field) => field === 'prunable' || field.startsWith('prunable '));
  }), 'WORKTREE_STALE');
  requireThat(query('HEAD') === card.headCommit && query('--symbolic-full-name', 'HEAD') === branch, 'WORKTREE_STALE');
  return { root, common };
}
function jsonFile(file) {
  const full = path.resolve(file);
  const item = lstatSync(full);
  requireThat(item.isFile() && item.nlink === 1 && item.size < 1024 * 1024, 'CONTROL_FILE_INVALID');
  requireThat(sameLocation(realpathSync.native(full), full), 'CONTROL_FILE_INVALID');
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    requireThat(false, 'CONTROL_FILE_INVALID');
  }
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactFields(value, fields) {
  return record(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function unique(values) {
  return new Set(values).size === values.length;
}
function key(value) {
  return typeof value === 'string' && id.test(value);
}
function dependency(item) {
  return exactFields(item, ['taskId', 'headCommit']) && key(item.taskId) && exactSha(item.headCommit);
}
function contractIdentity(item) {
  return key(item.id) && key(item.version)
    && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256);
}
function resourceKey({ kind, id: value }) {
  return kind + ':' + fold(value);
}
function validResource(kind, value) {
  return resourceKinds.has(kind) && key(value)
    && (kind !== 'tcp-port' || /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535);
}
function validateCard(card) {
  requireThat(exactFields(card, [
    'taskId', 'assignmentRevision', 'baselineCommit', 'workingBaselineCommit', 'headCommit',
    'worktree', 'branch', 'writeSet', 'dependencies', 'contracts', 'resources',
  ]), 'CARD_INVALID');
  requireThat(key(card.taskId) && Number.isSafeInteger(card.assignmentRevision) && card.assignmentRevision > 0
    && [card.baselineCommit, card.workingBaselineCommit, card.headCommit].every(exactSha)
    && typeof card.worktree === 'string' && path.isAbsolute(card.worktree)
    && typeof card.branch === 'string' && /^[a-z0-9][a-z0-9._/-]*$/i.test(card.branch)
    && Array.isArray(card.writeSet) && card.writeSet.length > 0
    && Array.isArray(card.dependencies) && Array.isArray(card.contracts) && Array.isArray(card.resources), 'CARD_INVALID');
  for (const item of card.writeSet) repositoryPath(item);
  requireThat(unique(card.writeSet.map(fold)), 'UNSAFE_PATH');
  for (const dep of card.dependencies) {
    requireThat(dependency(dep) && dep.taskId !== card.taskId, 'CARD_INVALID');
  }
  for (const contract of card.contracts) {
    requireThat(exactFields(contract, ['id', 'version', 'sha256']) && contractIdentity(contract), 'CARD_INVALID');
  }
  for (const item of card.resources) {
    requireThat(exactFields(item, ['kind', 'id']) && validResource(item.kind, item.id), 'CARD_INVALID');
  }
  requireThat(unique(card.dependencies.map(({ taskId }) => fold(taskId)))
    && unique(card.contracts.map(({ id }) => fold(id))) && unique(card.resources.map(resourceKey)), 'CARD_INVALID');
}
export function assertIndexFresh(index) {
  const expires = Date.parse(index.validUntil);
  const now = Date.now();
  requireThat(Number.isFinite(expires) && expires > now, 'INDEX_EXPIRED');
  requireThat(expires - now <= 5 * 60_000, 'INDEX_INVALID');
}
export function loadApproval(cardPath, indexPath) {
  const card = jsonFile(cardPath);
  const index = jsonFile(indexPath);
  validateCard(card);
  requireThat(record(index) && index.schemaVersion === 1 && typeof index.validUntil === 'string'
    && Array.isArray(index.cards), 'INDEX_INVALID');
  assertIndexFresh(index);
  for (const item of index.cards) validateCard(item);
  requireThat(unique(index.cards.map(({ taskId }) => fold(taskId))), 'INDEX_INVALID');
  const approval = index.cards.find((item) => item.taskId === card.taskId);
  requireThat(isDeepStrictEqual(approval, card), 'CARD_STALE');
  for (const item of index.cards) {
    const root = physical(item.worktree);
    requireThat(!contained(root, realpathSync.native(cardPath)) && !contained(root, realpathSync.native(indexPath)), 'CONTROL_FILE_INSIDE_WORKTREE');
  }
  return { card, index };
}
export function verifyBaseline(root, card) {
  try {
    for (const commit of [card.baselineCommit, card.workingBaselineCommit, card.headCommit]) {
      requireThat(text(git(root, 'cat-file', '-t', commit)).trim() === 'commit', 'BASELINE_INVALID');
    }
    git(root, 'merge-base', '--is-ancestor', card.baselineCommit, card.workingBaselineCommit);
    git(root, 'merge-base', '--is-ancestor', card.workingBaselineCommit, card.headCommit);
  } catch {
    requireThat(false, 'BASELINE_INVALID');
  }
}
function overlaps(left, right) {
  const a = left.split('/');
  const b = right.split('/');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (fold(a[i]) !== fold(b[i])) return false;
    if (a[i] !== b[i]) return true; // The same Windows directory is spelled differently.
  }
  return true; // Equal path, or one names an ancestor of the other.
}
function checkWriteConflict(a, b) {
  requireThat(!a.writeSet.some((item) => b.writeSet.some((other) => overlaps(item, other))), 'WRITE_SET_CONFLICT');
}
function inspectWorktree(item) {
  const actual = linkedWorktree(item);
  verifyBaseline(actual.root, item);
  return { item, ...actual };
}
function checkOccupancy(occupied, resourceLeases) {
  const keys = [...resourceLeases.map(resourceKey), ...occupied.flatMap(({ item }) => item.resources.map(resourceKey))];
  requireThat(unique(keys), 'RESOURCE_CONFLICT');
  for (const [i, a] of occupied.entries()) {
    for (const b of occupied.slice(i + 1)) {
      requireThat(sameLocation(a.common, b.common), 'WORKTREE_REPOSITORY_MISMATCH');
      requireThat(a.item.branch !== b.item.branch
        && !contained(a.root, b.root) && !contained(b.root, a.root), 'WORKTREE_CONFLICT');
      checkWriteConflict(a.item, b.item);
    }
    for (const name of a.item.writeSet) checkWorktreePath(a.root, name);
  }
}

const k07Slice = 'K07.desktop-startup.v1';
const k07Signature = 'bc41ba5f2eeca4aec400b42cbf8aa34f8354da674915669402d5b72912daedfd';
const k07Contract = { id: k07Slice, version: '1', sha256: k07Signature };
const k07Machine = '6b0757200affe0635f853b9099984c47bc6a5421';
const k07Validation = '8bd12582144e6e734f406c45df20c9a3e336470c';
const k07OriginalRegistration = '18e29f76ea768776acbde2e595e1964c165a35ff';
const k07IntegratedRegistration = '67e974da976a88591ec93b14411b4d3376f74a7a';
const k07RegistryPath = 'packages/contracts/freeze-registry.json';
const k07SchemaPath = 'packages/contracts/schemas/K07/v1.schema.json';
const k07FixturePath = 'tests/contracts/fixtures/K07/cases.json';
const k07SchemaSha = '05ab9b80f10c5e4fbd59c2b09ff7975f18197108fd18e82430715f3dbd95d345';
const k07FixtureSha = '81b0a6008518675719fb1e7261eb927bf39b843138ef3c8113be165eb9620693';
const k07HistoricalLock = '661d5ae66caed613baf1d9620d2e2257177caa59db9537b9acddeb2a37e50a45';
// Exact regular Git blobs from the reviewed machine closure plus the signed registry.
const k07FrozenBlobs = new Map([
  ['packages/contracts/package.json', ['7d403fe10b4ed5fd04c9dea58e57be6222b57d53', 'bfe1710c997b7ec0f6ee7ff110790dd7e0c746660216aab2c895ed6c935ddfb8']],
  ['packages/contracts/schemas/K07/v1.schema.json', ['0690736ae015b1203e8269e43addd10423dcd2a3', '05ab9b80f10c5e4fbd59c2b09ff7975f18197108fd18e82430715f3dbd95d345']],
  ['tests/contracts/fixtures/K07/cases.json', ['449385ec8c0f4f129b11df8fcc2c0765547fe631', '81b0a6008518675719fb1e7261eb927bf39b843138ef3c8113be165eb9620693']],
  ['packages/contracts/src/validate.ts', ['e67a076bb98fee0475111ab0640cba6f96aac1e8', '1455846cc92b1aca1f43c2762314a3fed29205db87715614e227064dab6c41f1']],
  ['packages/contracts/generated/ts/K07.ts', ['4481234a34b98a088552ed048cf21d7e55c1c5a5', '048637b98b4fed0f2806818841b814e573104a9bd3cc9cc9af4f1f64f05ce5d9']],
  ['packages/contracts/generated/dotnet/K07.g.cs', ['23a1e231017345b0bd7c839f8496eba75b2991b4', 'ba84beb04460df99cafc96352b0b7cc466d300efc9882250e859d06e71c079f7']],
  ['tools/contracts/generate.mjs', ['a505a0478cf759c19fe0c5d0c06b4d0eccd31ada', 'e20bfae5a4b4abb78b5526b698420c547ff0a523e61d1bb720daf1774221237d']],
  ['tests/contracts/ts/contracts.test.ts', ['73eea1438fce2c92df1b517fe0b3e4ec3eb8480e', 'ab867eda72cce8fb1e73c4136e75e7747f4c94615c400066baaadb091b79b8b2']],
  ['tests/contracts/dotnet/ContractCases.cs', ['07793dedb42d9690714704f258e20fc9f9ec09ed', '23e58c698a5412e0f6f345cc15310a75b269b3708678a8d29ea5805801fea7a0']],
  ['tests/contracts/dotnet/Orange.Contracts.Tests.csproj', ['9e89e47ed47745b63f537c24e3d9c841dc6c4fd8', '9d29cfa39bde4ca00cd7ca4ea3a36999c84da35f22b26d2815d2270a96f3693d']],
  ['packages/contracts/freeze-registry.json', ['064ce8a0f22282842a4aa97d08ececc62cb32c85', '0f50dc2adfa044c2a405b43753d9024cf50f29d060914134953d8622b3c44696']],
]);
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nativeSpelling = (value) => process.platform === 'win32' ? value.replaceAll('/', path.sep) : value;

function k07Bytes(file, expected, roots, code) {
  try {
    requireThat(typeof file === 'string' && path.isAbsolute(file) && digest(expected), code);
    const absolute = path.resolve(file);
    const stat = lstatSync(absolute);
    const canonical = realpathSync.native(absolute);
    requireThat(stat.isFile() && stat.nlink === 1 && canonical === absolute && nativeSpelling(file) === absolute
      && roots.every((root) => !contained(root, canonical)) && stat.size > 0 && stat.size <= 2 * 1024 * 1024, code);
    const bytes = readFileSync(canonical);
    requireThat(bytes.length === stat.size && sha256(bytes) === expected, code);
    return bytes;
  } catch {
    requireThat(false, code);
  }
}

function k07Json(bytes, code) {
  try {
    return JSON.parse(text(bytes));
  } catch {
    requireThat(false, code);
  }
}

function loadK07Proof(file, { card, index, requested }) {
  const roots = [requested.common, ...index.cards.map(({ worktree }) => physical(worktree))];
  const proofCode = 'K07_PROOF_UNTRUSTED';
  const proof = k07Json(k07Bytes(file, index.k07ProofSha256, roots, proofCode), proofCode);
  requireThat(exactFields(proof, ['schemaVersion', 'subject', 'n1Path', 'registrationReview']) && proof.schemaVersion === 1,
    'K07_PROOF_INVALID');
  const { taskId, assignmentRevision, branch, baselineCommit, workingBaselineCommit, headCommit } = card;
  const { subject, registrationReview } = proof;
  requireThat(exactFields(subject, ['taskId', 'assignmentRevision', 'branch', 'baselineCommit', 'workingBaselineCommit', 'headCommit', 'gitCommonDir'])
    && typeof subject.gitCommonDir === 'string' && path.isAbsolute(subject.gitCommonDir)
    && isDeepStrictEqual({ ...subject, gitCommonDir: nativeSpelling(subject.gitCommonDir) },
      { taskId, assignmentRevision, branch, baselineCommit, workingBaselineCommit, headCommit, gitCommonDir: requested.common }),
  'K07_PROOF_STALE');
  const reviewCode = 'K07_REGISTRATION_REVIEW';
  requireThat(exactFields(registrationReview, ['reviewerId', 'authorId', 'result', 'originalCommit', 'integratedCommit', 'evidencePath', 'evidenceSha256'])
    && registrationReview.reviewerId === '/root/k07_n0_review' && registrationReview.authorId === '/root/t02_k07'
    && registrationReview.result === 'approved' && registrationReview.originalCommit === k07OriginalRegistration
    && registrationReview.integratedCommit === k07IntegratedRegistration, reviewCode);
  k07Bytes(registrationReview.evidencePath, registrationReview.evidenceSha256, roots, reviewCode);
  const n1Code = 'K07_N1_UNTRUSTED';
  const n1 = k07Json(k07Bytes(proof.n1Path, k07Signature, roots, n1Code), n1Code);
  requireThat(n1?.slice === k07Slice && n1.status === 'n1_verified' && n1.machineHead === k07Machine
    && n1.rootValidationHead === k07Validation && n1.schemaSha256 === k07SchemaSha
    && n1.fixtureSha256 === k07FixtureSha && n1.lockSha256 === k07HistoricalLock, n1Code);
  return n1;
}

function k07Tree(root, commit, names, code) {
  let entries;
  try {
    requireThat(text(git(root, 'cat-file', '-t', commit)).trim() === 'commit', code);
    // Exact pathspecs miss Git siblings that shadow a protected file or directory on Windows.
    entries = nulFields(git(root, 'ls-tree', '-r', '-t', '-z', commit));
  } catch {
    requireThat(false, code);
  }
  const leaves = new Set(names);
  const protectedNames = new Map();
  for (const name of names) {
    const parts = repositoryPath(name);
    for (let count = 1; count <= parts.length; count++) {
      const prefix = parts.slice(0, count).join('/');
      protectedNames.set(fold(prefix), prefix);
    }
  }
  const found = new Map();
  for (const entry of entries) {
    const row = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    requireThat(row, code);
    const [, mode, type, oid, name] = row;
    const canonical = protectedNames.get(fold(name));
    if (canonical === undefined) continue;
    requireThat(name === canonical, 'K07_FREEZE_PATH_ALIAS');
    if (leaves.has(name)) {
      requireThat(mode === '100644' && type === 'blob' && !found.has(name), code);
      found.set(name, oid);
    } else {
      requireThat(mode === '040000' && type === 'tree', code);
    }
  }
  requireThat(found.size === names.length, code);
  return found;
}

function verifyK07Git({ card, requested }, n1) {
  const { root } = requested;
  const ancestor = 'K07_REGISTRATION_ANCESTRY';
  try {
    git(root, 'merge-base', '--is-ancestor', k07IntegratedRegistration, card.workingBaselineCommit);
    requireThat(text(git(root, 'rev-parse', k07OriginalRegistration + '^')).trim() === k07Validation, ancestor);
  } catch {
    requireThat(false, ancestor);
  }
  const code = 'K07_FREEZE_BYTES';
  const registrationDelta = (commit) => git(root, 'diff-tree', '--no-commit-id', '--no-renames', '-r', '--raw',
    '--no-abbrev', '-z', commit + '^', commit);
  requireThat(registrationDelta(k07OriginalRegistration).equals(registrationDelta(k07IntegratedRegistration)), code);
  const names = [...k07FrozenBlobs.keys()];
  requireThat(!card.writeSet.some((name) => names.some((locked) => overlaps(name, locked))), 'K07_PROTECTED_WRITE');
  for (const commit of new Set([k07OriginalRegistration, k07IntegratedRegistration, card.workingBaselineCommit, card.headCommit])) {
    const actual = k07Tree(root, commit, names, code);
    requireThat(names.every((name) => actual.get(name) === k07FrozenBlobs.get(name)[0]), code);
  }
  const machinePaths = names.filter((name) => name !== k07RegistryPath);
  for (const commit of [k07Machine, k07Validation]) {
    const actual = k07Tree(root, commit, machinePaths, code);
    requireThat(machinePaths.every((name) => actual.get(name) === k07FrozenBlobs.get(name)[0]), code);
  }
  const raw = (oid) => git(root, 'cat-file', 'blob', oid);
  const lock = k07Tree(root, k07Validation, ['pnpm-lock.yaml'], code);
  requireThat(sha256(raw(lock.get('pnpm-lock.yaml'))) === k07HistoricalLock, code);
  const bytes = new Map([...k07FrozenBlobs].map(([name, [oid, expected]]) => {
    const blob = raw(oid);
    requireThat(sha256(blob) === expected, code);
    return [name, blob];
  }));
  const registryBytes = bytes.get(k07RegistryPath);
  const fixtureBytes = bytes.get(k07FixturePath);
  const record = k07Json(registryBytes, code)?.slices?.[k07Slice];
  const fixture = k07Json(fixtureBytes, code);
  requireThat(record?.pack === 'K07' && record.schemaVersion === 1 && record.status === 'consumer_ready'
    && record.machineReview === 'passed' && record.registrationReviewRequired === true
    && record.design?.sha256 === n1.designSha256 && record.n1?.signoff?.sha256 === k07Signature
    && record.n1.machineHead === k07Machine && record.n1.rootValidationHead === k07Validation
    && record.n1.lock?.sha256 === k07HistoricalLock && isDeepStrictEqual(record.n1.approvals, n1.approvals)
    && isDeepStrictEqual(record.n1.evidence?.checks, n1.evidence?.checks)
    && isDeepStrictEqual(record.compatibility?.acceptedVersions, [1])
    && isDeepStrictEqual(record.schema, { path: k07SchemaPath, sha256: k07SchemaSha })
    && isDeepStrictEqual(record.fixtures, { path: k07FixturePath, sha256: k07FixtureSha, count: 114 })
    && fixture?.pack === 'K07' && fixture.slice === k07Slice && Array.isArray(fixture.cases)
    && fixture.cases.length === 114 && fixture.cases.every((item) => typeof item?.id === 'string' && item.id.length > 0)
    && new Set(fixture.cases.map(({ id }) => id)).size === 114, code);
}

function checkAdmission(args, report) {
  const flags = parseArgs(args, ['--index', '--card'], ['--trusted-k07-proof']);
  const { card, index } = loadApproval(flags['--card'], flags['--index']);
  Object.assign(report, { taskId: card.taskId, assignmentRevision: card.assignmentRevision, base: card.workingBaselineCommit, head: card.headCommit, nextSlot: null });
  const { slots, activeWriters, pendingReviews, completed, freezes, resourceLeases } = index;
  requireThat(exactFields(slots, ['total', 'otherOccupied'])
    && Number.isSafeInteger(slots.total) && slots.total > 0 && Number.isSafeInteger(slots.otherOccupied)
    && slots.otherOccupied >= 1 && [activeWriters, pendingReviews, completed, freezes, resourceLeases].every(Array.isArray)
    && [activeWriters, pendingReviews].every((list) => list.every(key) && unique(list)), 'INDEX_INVALID');
  requireThat(resourceLeases.every((lease) => exactFields(lease, ['kind', 'id', 'holder'])
    && validResource(lease.kind, lease.id) && key(lease.holder)), 'INDEX_INVALID');
  requireThat(completed.every(dependency) && unique(completed.map((item) => fold(item.taskId)))
    && freezes.every((item) => exactFields(item, ['id', 'version', 'sha256', 'state'])
      && contractIdentity(item) && key(item.state))
    && unique(freezes.map((item) => fold(item.id) + ':' + fold(item.version))), 'INDEX_INVALID');
  const registered = new Map(index.cards.map((item) => [item.taskId, item]));
  requireThat([...activeWriters, ...pendingReviews].every((task) => registered.has(task)), 'INDEX_INVALID');
  requireThat(!activeWriters.includes(card.taskId), 'WRITER_ALREADY_ACTIVE');
  const free = slots.total - slots.otherOccupied - activeWriters.length;
  report.freeSlots = Math.max(0, free);
  requireThat(free > 0, 'CAPACITY_EXHAUSTED');
  const active = activeWriters.map((task) => inspectWorktree(registered.get(task)));
  if (pendingReviews.length) {
    const taskId = pendingReviews[0];
    checkOccupancy(active, resourceLeases);
    const review = active.find(({ item }) => item.taskId === taskId) ?? inspectWorktree(registered.get(taskId));
    requireThat(active.every(({ common }) => sameLocation(common, review.common)), 'WORKTREE_REPOSITORY_MISMATCH');
    assertIndexFresh(index);
    report.nextSlot = { role: 'reviewer', taskId };
    requireThat(false, 'REVIEW_PRIORITY');
  }
  const requested = inspectWorktree(card);
  checkOccupancy([...active, requested], resourceLeases);
  for (const dep of card.dependencies) {
    requireThat(completed.some((item) => isDeepStrictEqual(item, dep)), 'DEPENDENCY_UNAVAILABLE');
    try {
      git(requested.root, 'merge-base', '--is-ancestor', dep.headCommit, card.workingBaselineCommit);
    } catch {
      requireThat(false, 'DEPENDENCY_UNAVAILABLE');
    }
  }
  for (const contract of card.contracts) {
    requireThat(freezes.some((item) => isDeepStrictEqual(item, { ...contract, state: 'consumer_ready' })), 'CONTRACT_UNAVAILABLE');
  }
  const proofPath = flags['--trusted-k07-proof'];
  if (card.contracts.length !== 0) {
    requireThat(card.contracts.length === 1 && isDeepStrictEqual(card.contracts[0], k07Contract) && proofPath,
      'CONTRACT_VERIFICATION_UNAVAILABLE');
    const context = { card, index, requested };
    const n1 = loadK07Proof(proofPath, context);
    verifyK07Git(context, n1);
  } else {
    requireThat(!proofPath, 'CONTRACT_VERIFICATION_UNAVAILABLE');
  }
  assertIndexFresh(index);
  const current = loadApproval(flags['--card'], flags['--index']);
  requireThat(isDeepStrictEqual(current, { card, index }), 'ADMISSION_CONTROL_CHANGED');
  const checked = linkedWorktree(card);
  requireThat(sameLocation(checked.root, requested.root) && sameLocation(checked.common, requested.common), 'WORKTREE_STALE');
  checkOccupancy([...activeWriters.map((task) => inspectWorktree(registered.get(task))), { item: card, ...checked }], resourceLeases);
  if (proofPath) loadK07Proof(proofPath, { card, index, requested: checked });
  requireThat(isDeepStrictEqual(loadApproval(flags['--card'], flags['--index']), { card, index }), 'ADMISSION_CONTROL_CHANGED');
  if (card.contracts.length) Object.assign(report, { eligibility: 'read-only-verified', verifiedContracts: [{ ...k07Contract }] });
  report.nextSlot = { role: 'implementer', taskId: card.taskId };
  report.code = 'N5A_UNVERIFIED';
}
cli(import.meta.url, checkAdmission);
