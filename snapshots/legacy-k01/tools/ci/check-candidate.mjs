import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  assertIndexFresh, checkWorktreePath, cli, contained, exactSha, fold, git, linkedWorktree, loadApproval, nulFields, parseArgs,
  repositoryPath, requireThat, text, verifyBaseline,
} from './check-admission.mjs';
import { checkImports, loadImportParser, readTree, rendererGraphFlags, runRendererGraph } from './check-imports.mjs';

const regularModes = new Set(['100644', '100755']);
const requiredStages = [
  'format-types', 'dependency-audit', 'secret-scan', 'import-build-graph', 'windows', 'contracts', 'independent-review',
];
const candidateChecks = ['write-set', 'imports', ...requiredStages];
const reviewerIdentity = (value) => typeof value === 'string' && value.length <= 160
  && /^\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i.test(value);

function loadG4Review(file, { root, common, base, head, card, index, changes }, extraRoots = []) {
  const pin = index.reviewApproval;
  requireThat(shape(pin, ['sha256', 'scopeKind', 'reviewerId', 'authors', 'evidencePath', 'evidenceSha256'])
    && digest(pin.sha256) && digest(pin.evidenceSha256) && ['task', 'integration'].includes(pin.scopeKind)
    && reviewerIdentity(pin.reviewerId) && Array.isArray(pin.authors) && pin.authors.length > 0
    && pin.authors.every(reviewerIdentity)
    && new Set(pin.authors.map(fold)).size === pin.authors.length, 'G4_REVIEW_UNTRUSTED');
  const roots = [root, common, ...extraRoots, ...index.cards.map(({ worktree }) => realpathSync.native(worktree))];
  const record = g2JSON(file, pin.sha256, roots, 'G4_REVIEW_UNTRUSTED');
  const { subject } = record ?? {};
  requireThat(shape(record, ['schemaVersion', 'subject', 'reviewerId', 'specs', 'quality', 'evidenceSha256'])
    && record.schemaVersion === 1
    && shape(subject, ['taskId', 'assignmentRevision', 'branch', 'base', 'head', 'tree', 'scopeKind', 'scopeSha256', 'inputsSha256'])
    && digest(subject.inputsSha256) && digest(record.evidenceSha256), 'G4_REVIEW_INVALID');
  const scopeSha256 = sha256(JSON.stringify([pin.scopeKind, [...changes].sort(), [...card.writeSet].sort()]));
  requireThat(subject.taskId === card.taskId && subject.assignmentRevision === card.assignmentRevision && subject.branch === card.branch
    && subject.base === base && subject.head === head && subject.tree === text(git(root, 'rev-parse', head + '^{tree}')).trim()
    && subject.scopeKind === pin.scopeKind && subject.scopeSha256 === scopeSha256, 'G4_REVIEW_STALE');
  requireThat(record.reviewerId === pin.reviewerId && !pin.authors.map(fold).includes(fold(record.reviewerId)), 'G4_REVIEW_IDENTITY');
  requireThat(record.specs === 'approved' && record.quality === 'approved', 'G4_REVIEW_NOT_APPROVED');
  const evidence = g2Physical(pin.evidencePath, 'file', 'G4_REVIEW_EVIDENCE');
  requireThat(!roots.some((dir) => contained(dir, evidence))
    && lstatSync(evidence).size > 0 && lstatSync(evidence).size <= 2 * 1024 * 1024
    && record.evidenceSha256 === pin.evidenceSha256 && sha256(readFileSync(evidence)) === pin.evidenceSha256,
  'G4_REVIEW_EVIDENCE');
  return record;
}

function g4InputDigest(context, g2, g3) {
  const { root, head, report } = context;
  const graph = report.rendererGraph;
  const scans = report.g3;
  const bytesOf = (name) => sha256(git(root, 'cat-file', 'blob', head + ':' + name));
  const refs = [
    ['git:freeze-registry', bytesOf('packages/contracts/freeze-registry.json')],
    ['git:k07-schema', bytesOf('packages/contracts/schemas/K07/v1.schema.json')],
    ['git:k07-fixture', bytesOf('tests/contracts/fixtures/K07/cases.json')],
    ['git:pnpm-lock', bytesOf('pnpm-lock.yaml')],
    ['g1:typescript', report.importParser?.sha256],
    ['g1:toolchain', graph.toolchainSha256],
    ['g1:renderer', graph.rendererSha256],
    ...(graph.profileSha256 ? [['g1:profile', graph.profileSha256]] : []),
    ['g2:executable-inputs', g2.executableInputs.sha256],
    ['g2:installed-packages', g2.installedPackages.sha256],
    ...Object.entries(g2.tools).map(([role, ref]) => ['g2:tool:' + role, ref.sha256]),
    ['g2:nuget-feed', sha256(JSON.stringify(g2.nugetFeed.files.map(({ path: name, sha256: value }) => [name, value]).sort()))],
    ['g3:database', g3.database.sha256],
    ['g3:inventory', g3.pnpmInventory.sha256],
    ['g3:native-lock', scans.dependencies.native.lockSha256],
    ['g3:secret-config', scans.secret.configSha256],
    ['g3:audit-config', scans.dependencies.configSha256],
    ...Object.entries(g3.tools).map(([role, ref]) => ['g3:tool:' + role, ref.sha256]),
    ...['check-candidate.mjs', 'check-admission.mjs', 'check-imports.mjs'].map((name) =>
      ['runner:' + name, sha256(readFileSync(fileURLToPath(new URL('./' + name, import.meta.url))))]),
  ];
  requireThat(refs.every(([, value]) => digest(value)), 'G4_INPUTS_UNAVAILABLE');
  return sha256(JSON.stringify(refs.sort()));
}

export function g4DecideCandidate(checks, reviewedInputs, observedInputs) {
  return digest(reviewedInputs) && reviewedInputs === observedInputs && checks.length === candidateChecks.length
    && checks.every((check, i) => check.id === candidateChecks[i] && check.status === 'passed' && check.exitCode === 0);
}
function stage(check, run) {
  try {
    const value = run();
    Object.assign(check, { exitCode: 0, status: 'passed' });
    return value;
  } catch (error) {
    const code = error.gateCode ?? 'GATE_ERROR';
    const unavailable = code === 'GRAPH_PROFILE_UNAVAILABLE' || code === 'GRAPH_RUNTIME_UNAVAILABLE';
    Object.assign(check, { exitCode: unavailable ? null : 1, status: unavailable ? 'unavailable' : 'failed', code });
    throw error;
  }
}
function linearCommits(root, base, head) {
  const log = text(git(root, 'rev-list', '--first-parent', '--parents', base + '..' + head)).trim();
  requireThat(log.length > 0, 'BASELINE_INVALID');
  const commits = [];
  let expected = head;
  for (const line of log.split(/\r?\n/)) {
    const [commit, parent, ...additional] = line.split(' ');
    requireThat(commit === expected && exactSha(parent) && additional.length === 0, 'HISTORY_NOT_LINEAR');
    commits.push([parent, commit]);
    expected = parent;
  }
  requireThat(expected === base, 'HISTORY_NOT_LINEAR');
  return commits;
}
function changedPaths(root, commits) {
  const paths = new Set();
  for (const [parent, commit] of commits) {
    const fields = nulFields(git(root, 'diff-tree', '--raw', '-r', '-z', '--no-renames',
      '--no-ext-diff', '--no-textconv', '--no-abbrev', parent, commit, '--'));
    requireThat(fields.length % 2 === 0, 'GIT_OUTPUT_INVALID');
    for (let i = 0; i < fields.length; i += 2) {
      const match = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} [ADMT]$/.exec(fields[i]);
      requireThat(match, 'GIT_OUTPUT_INVALID');
      requireThat(match.slice(1).every((mode) => mode === '000000' || regularModes.has(mode)), 'UNSAFE_GIT_MODE');
      repositoryPath(fields[i + 1]);
      paths.add(fields[i + 1]);
    }
  }
  return [...paths].sort();
}
function rejectAliases(names) {
  const prefixes = new Map();
  for (const name of names) {
    let prefix = '';
    for (const segment of repositoryPath(name)) {
      prefix += '/' + segment;
      const key = fold(prefix);
      requireThat(!prefixes.has(key) || prefixes.get(key) === prefix, 'PATH_ALIAS');
      prefixes.set(key, prefix);
    }
  }
}
function verifyIndex(root, tree) {
  // Index-only plumbing: status/diff of worktree content could invoke clean/process filters.
  const entries = nulFields(git(root, 'ls-files', '-v', '--stage', '-z'));
  requireThat(entries.length === tree.size, 'INDEX_NOT_NORMAL');
  const seen = new Set();
  for (const entry of entries) {
    const match = /^H (\d{6}) ([0-9a-f]{40}) 0\t([\s\S]+)$/.exec(entry);
    requireThat(match, 'INDEX_NOT_NORMAL');
    const [, mode, oid, name] = match;
    const expected = tree.get(name);
    requireThat(expected?.mode === mode && expected.oid === oid && !seen.has(name), 'INDEX_NOT_NORMAL');
    seen.add(name);
  }
}
function verifyCheckout(root, tree, outputs = []) {
  const files = [];
  const directories = new Map([['', new Set(['.git'])]]);
  const add = (name, directory = false) => {
    const segments = name.split('/');
    let parent = '';
    for (const [i, segment] of segments.entries()) {
      directories.get(parent).add(segment);
      parent += (parent ? '/' : '') + segment;
      if ((directory || i < segments.length - 1) && !directories.has(parent)) directories.set(parent, new Set());
    }
  };
  for (const [name, directory] of outputs) add(name, directory);
  for (const [name, { mode, oid }] of tree) {
    requireThat(regularModes.has(mode), 'UNSAFE_GIT_MODE');
    const stat = checkWorktreePath(root, name, 'present');
    requireThat(process.platform === 'win32' || Boolean(stat.mode & 0o111) === (mode === '100755'),
      'WORKTREE_CONTENT_MISMATCH');
    add(name);
    files.push({ name, oid, size: stat.size });
  }
  for (const [dir, expected] of directories) {
    // No ignore rules and no traversal of extra entries.
    const actual = readdirSync(path.join(root, dir));
    requireThat(actual.length === expected.size && actual.every((name) => expected.has(name)), 'WORKTREE_DIRTY');
  }
  for (const { name, oid, size } of files) {
    const blob = git(root, 'cat-file', 'blob', oid);
    requireThat(size === blob.length && readFileSync(path.join(root, name)).equals(blob), 'WORKTREE_DIRTY');
  }
}
const g2InputNames = new Set([
  'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json',
  'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/vite.config.ts',
  'apps/desktop/main/index.ts', 'apps/desktop/preload/index.ts', 'apps/desktop/renderer/index.html',
  'apps/desktop/renderer/main.tsx', 'apps/desktop/renderer/App.tsx', 'tests/windows/shell-smoke.test.mjs',
  'packages/contracts/package.json', 'packages/contracts/freeze-registry.json',
  'packages/contracts/schemas/K07/v1.schema.json', 'packages/contracts/src/validate.ts',
  'packages/contracts/generated/ts/K07.ts', 'packages/contracts/generated/dotnet/K07.g.cs',
  'tools/contracts/generate.mjs', 'tests/contracts/fixtures/K07/cases.json', 'tests/contracts/ts/contracts.test.ts',
  'tests/contracts/dotnet/Orange.Contracts.Tests.csproj', 'tests/contracts/dotnet/ContractCases.cs',
]);
const authG2Inputs = ['apps/desktop/auth-contract.ts', 'apps/desktop/main/auth-ipc.ts', 'apps/desktop/main/auth.ts',
  'apps/desktop/renderer/startup.css', 'tests/windows/auth-service.test.mjs'];
const startupG2ProfileDigest = '3eb5101fe2a5deeb03df4c7c7f69399f990eec9263d045bdd494ac7805ae8c20';
const introducedCommitOid = '1fc7f7675f426714bbe49c519269c4d9782f99ce';
function g2HasAuthProvenance(root, head) {
  const code = 'G2_AUTH_PROVENANCE_UNAVAILABLE';
  try {
    requireThat(exactSha(head) && text(git(root, 'rev-parse', '--is-shallow-repository')).trim() === 'false', code);
    const common = g2Physical(text(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trimEnd(), 'dir', code);
    absentG2Path(path.join(common, 'info', 'grafts'), code);
    // The trusted git wrapper disables replacements. Traverse from HEAD, not a caller-selected diff range.
    const commits = text(git(root, 'rev-list', head, '--')).trimEnd().split(/\r?\n/);
    requireThat(commits[0] === head && commits.every(exactSha), code);
    return commits.includes(introducedCommitOid);
  } catch {
    requireThat(false, code);
  }
}
export function g2InputNamesFor(tree, graph, base, head, root) {
  const inheritedAuth = g2HasAuthProvenance(root, head);
  if (!inheritedAuth && !authG2Inputs.some((name) => tree.has(name)) && graph?.profileSha256 !== startupG2ProfileDigest) {
    return new Set(g2InputNames);
  }
  requireThat(authG2Inputs.every((name) => tree.get(name)?.mode === '100644')
    && graph?.profileSha256 === startupG2ProfileDigest && graph.base === base && graph.head === head
    && graph.stylesheets === 1 && graph.reactRoots?.react === 1 && graph.reactRoots?.['react-dom'] === 1,
  'G2_AUTH_PROFILE_REQUIRED');
  return new Set([...g2InputNames, ...authG2Inputs]);
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const shape = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
const identity = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(value);
const differentRoots = (a, b) => !contained(a, b) && !contained(b, a);

function g2Physical(file, type, code, unique = true) {
  requireThat(typeof file === 'string' && path.isAbsolute(file), code);
  try {
    const absolute = path.resolve(file);
    const stat = lstatSync(absolute);
    requireThat(!stat.isSymbolicLink() && path.relative(absolute, realpathSync.native(absolute)) === '', code);
    requireThat(type === 'dir' ? stat.isDirectory() : stat.isFile() && (!unique || stat.nlink === 1), code);
    return realpathSync.native(absolute);
  } catch {
    requireThat(false, code);
  }
}
function g2JSON(file, expected, externalTo, code) {
  const physical = g2Physical(file, 'file', code);
  requireThat(externalTo.every((root) => !contained(root, physical)) && digest(expected), code);
  requireThat(lstatSync(physical).size <= 2 * 1024 * 1024, code);
  const bytes = readFileSync(physical);
  requireThat(sha256(bytes) === expected, code);
  try {
    return JSON.parse(text(bytes));
  } catch {
    requireThat(false, code);
  }
}
function g2Deadline(value, max, code) {
  const until = Date.parse(value);
  requireThat(typeof value === 'string' && Number.isFinite(until) && new Date(until).toISOString() === value
    && until > Date.now() && until <= max, code);
  return until;
}
function loadG2Plan(file, context) {
  const { root, card, index, base, head } = context;
  const plan = g2JSON(file, index.g2PlanSha256, [root], 'G2_PLAN_UNTRUSTED');
  requireThat(shape(plan, ['schemaVersion', 'taskId', 'assignmentRevision', 'base', 'head', 'tree',
    'executionRoot', 'outputRoot', 'validUntil', 'desktopLease', 'executableInputs', 'installedPackages', 'nugetFeed', 'tools'])
    && plan.schemaVersion === 1 && exactSha(plan.tree)
    && shape(plan.desktopLease, ['id', 'holder', 'validUntil']) && identity(plan.desktopLease.id)
    && plan.desktopLease.holder === card.taskId
    && shape(plan.executableInputs, ['path', 'sha256']) && digest(plan.executableInputs.sha256)
    && shape(plan.installedPackages, ['path', 'sha256', 'sourceRoot']) && digest(plan.installedPackages.sha256)
    && shape(plan.nugetFeed, ['path', 'files']) && Array.isArray(plan.nugetFeed.files)
    && shape(plan.tools, ['node', 'git', 'dotnet', 'csc', 'cmd', 'taskkill'])
    && Object.values(plan.tools).every((item) => shape(item, ['path', 'sha256']) && digest(item.sha256)),
  'G2_PLAN_INVALID');
  requireThat(plan.taskId === card.taskId && plan.assignmentRevision === card.assignmentRevision
    && plan.base === base && plan.head === head && text(git(root, 'rev-parse', head + '^{tree}')).trim() === plan.tree,
  'G2_PLAN_STALE');
  const expires = g2Deadline(plan.validUntil, Date.parse(index.validUntil), 'G2_PLAN_EXPIRED');
  return { plan, expires };
}
export function verifyG2Lease(plan, index) {
  const { id, holder, validUntil } = plan.desktopLease;
  g2Deadline(validUntil, Date.parse(plan.validUntil), 'G2_LEASE_EXPIRED');
  const relevant = Array.isArray(index.resourceLeases) ? index.resourceLeases
    .filter((lease) => lease?.kind === 'desktop') : [];
  requireThat(relevant.length === 1 && isDeepStrictEqual(relevant[0], { kind: 'desktop', id, holder })
    && !index.cards.some((card) => card.taskId !== holder && card.resources
      .some((resource) => resource.kind === 'desktop')), 'G2_LEASE_UNAVAILABLE');
}
export function verifyG2Control({ cardFile, indexFile, planFile, card, index, protectedRoots }, desktop = false) {
  const current = loadApproval(cardFile, indexFile);
  requireThat(isDeepStrictEqual(current, { card, index }), 'G2_CONTROL_CHANGED');
  const plan = g2JSON(planFile, current.index.g2PlanSha256, protectedRoots, 'G2_CONTROL_CHANGED');
  const expires = g2Deadline(plan.validUntil, Date.parse(current.index.validUntil), 'G2_PLAN_EXPIRED');
  if (desktop) verifyG2Lease(plan, current.index);
  const lease = desktop ? Date.parse(plan.desktopLease.validUntil) : expires;
  const duration = Math.min(expires, lease) - Date.now();
  requireThat(duration > 0, desktop && lease <= expires ? 'G2_LEASE_EXPIRED' : 'G2_PLAN_EXPIRED');
  return duration;
}
export function verifyG2Execution(executionRoot, source, expectedCommon, head, expectedTree) {
  const code = 'G2_EXECUTION_MISMATCH';
  const root = g2Physical(executionRoot, 'dir', code);
  requireThat(differentRoots(root, source), code);
  g2Physical(path.join(root, '.git'), 'file', code);
  const query = (...args) => text(git(root, 'rev-parse', ...args)).trimEnd();
  const worktreeRoot = g2Physical(query('--show-toplevel'), 'dir', code);
  const gitDir = g2Physical(query('--path-format=absolute', '--git-dir'), 'dir', code);
  const common = g2Physical(query('--path-format=absolute', '--git-common-dir'), 'dir', code);
  requireThat(path.relative(root, worktreeRoot) === '' && path.relative(expectedCommon, common) === ''
    && contained(path.join(common, 'worktrees'), gitDir) && path.relative(path.dirname(gitDir), path.join(common, 'worktrees')) === ''
    && query('--show-superproject-working-tree') === ''
    && query('HEAD') === head && query('HEAD^{tree}') === expectedTree, code);
  const records = nulFields(git(root, 'worktree', 'list', '--porcelain', '-z')).join('\0').split('\0\0');
  const ref = query('--symbolic-full-name', 'HEAD');
  requireThat(records.some((record) => {
    const [location, ...fields] = record.split('\0');
    return location.startsWith('worktree ') && path.relative(location.slice(9), root) === ''
      && fields.includes('HEAD ' + head) && fields.includes(ref === 'HEAD' ? 'detached' : 'branch ' + ref)
      && !fields.some((field) => /^prunable(?: |$)/.test(field));
  }), code);
  return root;
}
const injectedName = /^(?:\.env(?:\..*)?|\.npmrc|\.gitattributes|(?:\.pnpmfile|pnpmfile)\.[^.]+|(?:\.postcssrc|postcss\.config|vite\.config)(?:\..*)?|directory\.(?:build\..+|packages\.props)|global\.json|nuget\.config|(?:msbuild|directory\.build)\.rsp|[^.].*\.(?:exe|com|cmd|bat|dll))$/i;
const ancestorInputs = [
  'node_modules', 'package.json', '.gitattributes', '.npmrc', '.env', '.env.local', 'global.json', 'NuGet.Config',
  'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'Directory.Build.rsp', 'MSBuild.rsp',
  ...['main', 'preload', 'renderer'].flatMap((mode) => ['.env.' + mode, '.env.' + mode + '.local']),
  '.postcssrc',
  ...['json', 'yaml', 'yml', 'js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].flatMap((ext) =>
    ['.postcssrc.', 'postcss.config.', 'vite.config.', '.pnpmfile.'].map((prefix) => prefix + ext)),
];
function absentG2Path(file, code) {
  try {
    lstatSync(file);
  } catch (error) {
    requireThat(error.code === 'ENOENT', code);
    return;
  }
  requireThat(false, code);
}
export function verifyG2InputSet(tree, entries, names) {
  requireThat(Array.isArray(entries) && entries.length === names.size, 'G2_INPUT_UNTRUSTED');
  const seen = new Set();
  for (const entry of entries) {
    requireThat(validG2Entry(entry) && names.has(entry.path) && !seen.has(entry.path) && tree.has(entry.path), 'G2_INPUT_UNTRUSTED');
    seen.add(entry.path);
  }
  for (const name of tree.keys()) {
    requireThat(seen.has(name)
      || (!/^(?:apps\/desktop|packages\/contracts|tests\/(?:windows|contracts)|tools\/contracts)\//i.test(name)
        && !name.split('/').some((part) => injectedName.test(part) || fold(part) === 'node_modules')), 'G2_INPUT_UNREVIEWED');
  }
}
function verifyG2Inputs(root, tree, plan, protectedRoots, names) {
  const manifest = g2JSON(plan.executableInputs.path, plan.executableInputs.sha256, protectedRoots, 'G2_INPUT_UNTRUSTED');
  requireThat(manifest?.type === 'controller-reviewed-G2-executable-inputs' && manifest.schemaVersion === 1
    && manifest.candidate === plan.head && exactSha(manifest.approvedSource), 'G2_INPUT_UNTRUSTED');
  verifyG2InputSet(tree, manifest.entries, names);
  const reviewed = new Map();
  for (const entry of manifest.entries) {
    checkWorktreePath(root, entry.path, 'present');
    const bytes = readFileSync(path.join(root, entry.path));
    requireThat(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'G2_INPUT_MISMATCH');
    reviewed.set(entry.path, bytes);
  }
  for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
    for (const name of ancestorInputs) absentG2Path(path.join(dir, name), 'G2_ANCESTOR_CONFIG');
    if (dir === path.dirname(dir)) break;
  }
  return reviewed;
}
function validG2Entry(entry) {
  return shape(entry, ['path', 'bytes', 'sha256']) && typeof entry.path === 'string'
    && digest(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= 512 * 1024 * 1024;
}
function verifyG2Tools(plan, protectedRoots) {
  const roles = { node: 'node.exe', git: 'git.exe', dotnet: 'dotnet.exe', csc: 'csc.dll', cmd: 'cmd.exe', taskkill: 'taskkill.exe' };
  const tools = {};
  for (const [role, item] of Object.entries(plan.tools)) {
    // Installed Windows/Git host tools can be OS-managed hard links (e.g. WinSxS).
    const actual = g2Physical(item.path, 'file', 'G2_TOOL_UNTRUSTED', false);
    requireThat(fold(path.basename(actual)) === roles[role]
      && protectedRoots.every((root) => !contained(root, actual))
      && sha256(readFileSync(actual)) === item.sha256, 'G2_TOOL_UNTRUSTED');
    tools[role] = actual;
  }
  requireThat(process.platform === 'win32' && process.arch === 'x64' && path.relative(
    path.join(path.dirname(tools.dotnet), 'sdk', '10.0.300', 'Roslyn', 'bincore', 'csc.dll'), tools.csc) === ''
    && path.relative('C:/Windows/System32/cmd.exe', tools.cmd) === ''
    && path.relative('C:/Windows/System32/taskkill.exe', tools.taskkill) === '',
  'G2_TOOL_UNTRUSTED');
  return tools;
}
function verifyG2Feed(plan, protectedRoots) {
  const code = 'G2_FEED_UNTRUSTED';
  const root = g2Physical(plan.nugetFeed.path, 'dir', code);
  requireThat(protectedRoots.every((other) => differentRoots(other, root))
    && plan.nugetFeed.files.length === 13, code);
  const names = new Set();
  for (const entry of plan.nugetFeed.files) {
    requireThat(validG2Entry(entry) && /^[a-zA-Z0-9._-]+\.nupkg$/.test(entry.path)
      && !names.has(fold(entry.path)), code);
    const file = g2Physical(path.join(root, entry.path), 'file', code);
    requireThat(path.basename(file) === entry.path && lstatSync(file).size === entry.bytes
      && sha256(readFileSync(file)) === entry.sha256, code);
    names.add(fold(entry.path));
  }
  requireThat(readdirSync(root).length === names.size, code);
  return root;
}
function materializeG2Packages(root, plan, inputs, protectedRoots) {
  const code = 'G2_PACKAGE_UNTRUSTED';
  const ref = plan.installedPackages;
  const donor = g2Physical(ref.sourceRoot, 'dir', code);
  requireThat(protectedRoots.every((other) => differentRoots(other, donor)), code);
  const manifest = g2JSON(ref.path, ref.sha256, protectedRoots, code);
  requireThat(manifest?.schemaVersion === 1 && manifest.type === 'controller-approved-installed-public-package-closure'
    && manifest.sourceLockSha256 === sha256(inputs.get('pnpm-lock.yaml'))
    && Array.isArray(manifest.packages) && manifest.packages.length === 36
    && Array.isArray(manifest.links) && manifest.links.length === 82, code);
  const packages = new Map();
  const files = new Map();
  const links = new Map();
  for (const pkg of manifest.packages) {
    requireThat(shape(pkg, ['name', 'version', 'physicalRootFromNodeModules', 'files', 'generated'])
      && Array.isArray(pkg.files) && pkg.files.length > 0 && typeof pkg.physicalRootFromNodeModules === 'string'
      && /^\.pnpm\/[^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+$/.test(pkg.physicalRootFromNodeModules), code);
    const prefix = 'node_modules/' + pkg.physicalRootFromNodeModules;
    repositoryPath(prefix);
    requireThat(!packages.has(prefix), code);
    packages.set(prefix, pkg);
    for (const entry of pkg.files) {
      requireThat(validG2Entry(entry) && !entry.path.split('/').some((segment) =>
        ['node_modules', '.bin'].includes(fold(segment))), code);
      const name = prefix + '/' + entry.path;
      repositoryPath(name);
      requireThat(!files.has(name), code);
      files.set(name, entry);
    }
  }
  for (const link of manifest.links) {
    requireThat(shape(link, ['path', 'target']) && typeof link.path === 'string'
      && /^(?:node_modules\/(?:\.pnpm\/(?:[^/]+\/)?node_modules\/)?|apps\/desktop\/node_modules\/)(?:@[^/]+\/)?[^/]+$/.test(link.path)
      && !link.path.split('/').some((segment) => fold(segment) === '.bin')
      && !links.has(link.path) && !files.has(link.path)
      && (packages.has(link.target) || (link.target === 'packages/contracts'
        && /^(?:apps\/desktop\/node_modules|node_modules\/\.pnpm\/node_modules)\/@orange\/contracts$/.test(link.path))
        || (link.target === 'apps/desktop' && link.path === 'node_modules/.pnpm/node_modules/@orange/desktop')),
    code);
    repositoryPath(link.path);
    links.set(link.path, link.target);
  }
  rejectAliases([...files.keys(), ...links.keys()]);
  requireThat(files.size === 1187 && [...files.values()].reduce((bytes, entry) => bytes + entry.bytes, 0) <= 600 * 1024 * 1024
    && [...files.keys(), ...packages.keys(), ...links.keys()].every((name) => !name.split('/').slice(0, -1)
      .some((_, i, parts) => links.has(parts.slice(0, i + 1).join('/')))), code);
  for (const [name, entry] of files) {
    const source = g2Physical(path.join(donor, name), 'file', code, false);
    requireThat(lstatSync(source).size === entry.bytes, code);
    const bytes = readFileSync(source);
    requireThat(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, code);
    const dest = path.join(root, name);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, bytes, { flag: 'wx' });
  }
  for (const [name, target] of links) {
    const dest = path.join(root, name);
    const directory = g2Physical(path.join(root, target), 'dir', code);
    mkdirSync(path.dirname(dest), { recursive: true });
    symlinkSync(directory, dest, 'junction');
  }
  return { files, links };
}
function authRendererHtml(js, css) {
  // Complete pinned Vite output shape. Asset basenames are constrained before interpolation.
  return [
    '<!doctype html>', '<html lang="zh-CN">', '  <head>', '    <meta charset="UTF-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'">`,
    '    <title>橙子创作中心</title>', '    <script type="module" crossorigin src="./assets/' + js + '"></script>',
    '    <link rel="stylesheet" crossorigin href="./assets/' + css + '">', '  </head>', '  <body>',
    '    <div id="root"></div>', '  </body>', '</html>', '',
  ].join('\n');
}
export function g2BuildOutputs(root, head, auth = false) {
  const code = 'G2_BUILD_OUTPUT_INVALID';
  const base = 'apps/desktop/dist/';
  const assetRoot = g2Physical(path.join(root, base, 'renderer/assets'), 'dir', code);
  const assets = readdirSync(assetRoot);
  const js = assets.find((name) => /^index-[a-zA-Z0-9_-]+\.js$/.test(name));
  const css = assets.find((name) => /^index-[a-zA-Z0-9_-]+\.css$/.test(name));
  requireThat(js && (auth ? assets.length === 2 && css : assets.length === 1), code);
  const names = ['main/build-identity.json', 'main/index.js', 'preload/index.cjs', 'renderer/index.html',
    'renderer/assets/' + js, ...(auth ? ['renderer/assets/' + css] : [])];
  const outputs = new Map();
  for (const name of names) {
    const file = g2Physical(path.join(root, base + name), 'file', code);
    const bytes = readFileSync(file);
    if (auth && name === 'renderer/index.html') requireThat(bytes.equals(Buffer.from(authRendererHtml(js, css))), code);
    outputs.set(base + name, sha256(bytes));
  }
  const identityFile = path.join(root, base, names[0]);
  const build = JSON.parse(text(readFileSync(identityFile)));
  const { version } = JSON.parse(text(readFileSync(path.join(root, 'apps/desktop/package.json'))));
  requireThat(shape(build, ['appVersion', 'buildCommit', 'mainSha256']) && build.appVersion === version
    && build.buildCommit === head && build.mainSha256 === outputs.get(base + 'main/index.js'), code);
  return { build, outputs };
}
export function verifyG2Outputs(root, tree, dependencies, outputs, windowsStarted) {
  const extras = [];
  const code = 'G2_OUTPUT_MUTATED';
  for (const [name, entry] of dependencies.files) {
    const file = g2Physical(path.join(root, name), 'file', code);
    requireThat(lstatSync(file).size === entry.bytes && sha256(readFileSync(file)) === entry.sha256, code);
    extras.push([name, false]);
  }
  for (const [name, target] of dependencies.links) {
    const file = path.join(root, name);
    requireThat(lstatSync(file).isSymbolicLink() && path.relative(realpathSync.native(file), path.join(root, target)) === '', code);
    extras.push([name, false]);
  }
  for (const [name, expected] of outputs) {
    const file = g2Physical(path.join(root, name), 'file', code);
    requireThat(sha256(readFileSync(file)) === expected, code);
    extras.push([name, false]);
  }
  for (const name of ['apps/desktop/node_modules/.vite-temp', 'node_modules/.vite-temp',
    ...(windowsStarted ? ['.orange-local/shell-smoke'] : [])]) {
    if (existsSync(path.join(root, name))) {
      g2Physical(path.join(root, name), 'dir', code);
      extras.push([name, true]); // The reviewed tests/config may leave only an empty scratch directory.
    }
  }
  verifyCheckout(root, tree, extras);
}
const windowsTests = [
  'Windows starts one isolated, unprivileged shell and never enters a workspace without a first-party session',
  ...['renderer-failure', 'renderer-failure-left-bracket', 'renderer-failure-right-bracket', 'renderer-failure-percent',
    'early-profile', 'visible-window', 'missing-terminal', 'missing-eof'].map((name) => 'K07 Electron fd3: ' + name),
];
const authWindowsTest = 'Windows Auth fixture: rejects anonymous and wrong password, verifies user, and signs out without network';
const authServiceTests = [
  'accepts a hosted Supabase origin and only modern publishable keys',
  'no configuration or malformed credentials cannot call Auth or open the workspace',
  'password exchange must be followed by authenticated /user before returning only a public signed-in state',
  'invalid password, provider failure, and invalid user response remain signed out',
  'expiration and local signout are fail-closed even if logout cannot reach the provider',
  'late authentication cannot undo logout and only one exchange can be in flight',
  'time spent exchanging a token never extends the maximum local lifetime',
  'rejects malformed anonymous or MFA fields rather than opening a workspace',
];
export function g2WindowsStages(auth) {
  const node = ['--test', '--test-reporter=tap'];
  const shell = 'tests/windows/shell-smoke.test.mjs';
  const filter = (names) => '--test-name-pattern=^(?:' + names.map((name) => name.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&')).join('|') + ')$';
  return [{ id: 'windows-tap', args: [...node, ...(auth ? [filter(windowsTests)] : []), shell], expected: [...windowsTests] },
    ...(auth ? [
      { id: 'windows-auth-fixture-tap', args: [...node, filter([authWindowsTest]), shell], expected: [authWindowsTest] },
      { id: 'windows-auth-service-tap', args: [...node, 'tests/windows/auth-service.test.mjs'], expected: [...authServiceTests] },
    ] : [])];
}
const generatorTests = [
  'unsupported root maximum property count', 'missing root object type', 'missing root required',
  'unsupported branch constraint', 'unsupported branch field constraint', 'missing branch exclusion',
  'branch exclusion contains unknown key', 'missing Gregorian format', 'missing integer bound',
  'unsupported field constraint', 'unhandled version bound',
].map((name) => '[K07] generator fails closed: ' + name);
export function verifyG2Tap(bytes, expected) {
  const code = 'G2_TAP_INVALID';
  const lines = text(bytes).split(/\r?\n/);
  const count = expected.length;
  requireThat(count > 0 && new Set(expected).size === count && lines.shift() === 'TAP version 13' && lines.pop() === '', code);
  requireThat(/^# duration_ms \d+(?:\.\d+)?$/.test(lines.pop() ?? ''), code);
  const summary = ['1..' + count, '# tests ' + count, '# suites 0', '# pass ' + count,
    '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'];
  requireThat(isDeepStrictEqual(lines.splice(-summary.length), summary), code);
  let seen = 0;
  let subtest = false;
  let yaml = false;
  for (const line of lines) {
    if (line.startsWith('# Subtest: ')) {
      requireThat(!yaml && !subtest && line === '# Subtest: ' + expected[seen], code);
      subtest = true;
    } else if (line.startsWith('ok ')) {
      requireThat(!yaml && subtest && !/\s#\s*(?:SKIP|TODO)\b/i.test(line)
        && line === 'ok ' + (seen + 1) + ' - ' + expected[seen], code);
      seen++;
      subtest = false;
    } else if (line === '  ---') {
      requireThat(seen > 0 && !yaml && !subtest, code);
      yaml = true;
    } else if (line === '  ...') {
      requireThat(yaml, code);
      yaml = false;
    } else {
      requireThat(yaml ? /^  (?:duration_ms: \d+(?:\.\d+)?|type: 'test')$/.test(line)
        : /^# (?!Subtest:|tests |suites |pass |fail |cancelled |skipped |todo |duration_ms )/.test(line), code);
    }
  }
  requireThat(!yaml && !subtest && seen === count, code);
  return { count, sha256: sha256(bytes) };
}
function trxXML(bytes) {
  // Recognize the restricted VSTest TRX envelope, not general XML. No DTD, namespaces
  // other than the root default, processing instructions, or network/entity expansion.
  const code = 'G2_TRX_INVALID';
  const xml = text(bytes).replace(/^\uFEFF/, '');
  const header = '<?xml version="1.0" encoding="utf-8"?>';
  requireThat(xml.startsWith(header) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml), code);
  const entity = /&(?:amp|lt|gt|apos|quot|#\d+|#x[\da-fA-F]+);/g;
  const decode = (raw) => {
    requireThat(!raw.replace(entity, '').includes('&'), code);
    return raw.replace(entity, (value) => {
      const decoded = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&apos;': "'", '&quot;': '"' }[value];
      if (decoded) return decoded;
      const number = value.startsWith('&#x') ? parseInt(value.slice(3, -1), 16) : Number(value.slice(2, -1));
      requireThat([9, 10, 13].includes(number) || (number >= 32 && number <= 0x10ffff
        && !(number >= 0xd800 && number <= 0xdfff) && number !== 0xfffe && number !== 0xffff), code);
      return String.fromCodePoint(number);
    });
  };
  const tokens = /<\/(?<close>[a-zA-Z]\w*)\s*>|<(?<open>[a-zA-Z]\w*)(?<attributes>(?:\s+[a-zA-Z]\w*="[^"<]*")*)\s*(?<short>\/?)>|(?<content>[^<]+)/gy;
  const outer = { name: '', children: [], attrs: {} };
  const stack = [outer];
  let offset = header.length;
  while (offset < xml.length) {
    tokens.lastIndex = offset;
    const match = tokens.exec(xml);
    requireThat(match && stack.length <= 30, code);
    offset = tokens.lastIndex;
    const { close, open, attributes, short, content } = match.groups;
    const parent = stack.at(-1);
    if (close) {
      requireThat(parent.name === close, code);
      stack.pop();
    } else if (open) {
      const attrs = Object.create(null);
      for (const [, key, value] of attributes.matchAll(/\s+([a-zA-Z]\w*)="([^"]*)"/g)) {
        requireThat(!Object.hasOwn(attrs, key), code);
        attrs[key] = decode(value);
      }
      const node = { name: open, attrs, children: [] };
      parent.children.push(node);
      if (!short) stack.push(node);
    } else {
      requireThat(!content.includes(']]>'), code);
      const value = decode(content);
      requireThat(!value.trim() || parent.name === 'StdOut', code);
    }
  }
  requireThat(stack.length === 1 && outer.children.length === 1, code);
  return outer.children[0];
}
export function verifyG2Trx(bytes, expected, started, ended) {
  const code = 'G2_TRX_INVALID';
  const only = (parent, name) => {
    const matches = parent.children.filter((item) => item.name === name);
    requireThat(matches.length === 1, code);
    return matches[0];
  };
  const guid = (value) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  const root = trxXML(bytes);
  requireThat(root.name === 'TestRun' && root.attrs.xmlns === 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'
    && guid(root.attrs.id) && root.children.every(({ name }) =>
      ['Times', 'TestSettings', 'Results', 'TestDefinitions', 'TestEntries', 'TestLists', 'ResultSummary'].includes(name))
    && new Set(root.children.map(({ name }) => name)).size === root.children.length, code);
  const count = expected.length;
  requireThat(count > 0 && new Set(expected).size === count, code);
  const times = only(root, 'Times').attrs;
  const first = Date.parse(times.start);
  const last = Date.parse(times.finish);
  requireThat(first >= started && last >= first && last <= ended, code);
  const summary = only(root, 'ResultSummary');
  const counters = only(summary, 'Counters').attrs;
  requireThat(summary.attrs.outcome === 'Completed'
    && ['total', 'executed', 'passed'].every((key) => counters[key] === String(count))
    && ['failed', 'error', 'timeout', 'aborted', 'inconclusive', 'passedButRunAborted', 'notRunnable',
      'notExecuted', 'disconnected', 'warning', 'completed', 'inProgress', 'pending'].every((key) => counters[key] === '0'), code);
  const seen = new Set();
  const tests = new Set();
  const executions = new Set();
  const results = only(root, 'Results').children;
  requireThat(results.length === count, code);
  for (const { name, attrs, children } of results) {
    const match = /^Orange\.Contracts\.Tests\.ContractCases\.SharedGoldenCase\(id: "([a-z0-9-]+)"\)$/.exec(attrs.testName);
    requireThat(name === 'UnitTestResult' && !children.length && match && !seen.has(match[1]) && attrs.outcome === 'Passed'
      && guid(attrs.testId) && guid(attrs.executionId) && !tests.has(attrs.testId) && !executions.has(attrs.executionId)
      && Date.parse(attrs.startTime) >= first && Date.parse(attrs.endTime) >= Date.parse(attrs.startTime)
      && Date.parse(attrs.endTime) <= last, code);
    seen.add(match[1]);
    tests.add(attrs.testId);
    executions.add(attrs.executionId);
  }
  requireThat(expected.every((id) => seen.has(id)), code);
  return { count, sha256: sha256(bytes) };
}
function g2Environment(root, output, tools) {
  const system = path.dirname(tools.cmd);
  const windows = path.dirname(system);
  const home = path.join(output, 'home');
  const temp = path.join(output, 'tmp');
  const appData = path.join(home, 'roaming');
  const local = path.join(home, 'local');
  for (const dir of [temp, appData, local]) mkdirSync(dir, { recursive: true });
  const global = path.join(home, 'gitconfig');
  writeFileSync(global, '', { flag: 'wx' });
  return {
    SystemRoot: windows, WINDIR: windows, COMSPEC: tools.cmd, PATHEXT: '.EXE;.COM;.BAT;.CMD',
    PATH: [path.dirname(tools.git), path.dirname(tools.node), system].join(path.delimiter),
    HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: local, TEMP: temp, TMP: temp,
    GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: root.replaceAll('\\', '/'),
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    DOTNET_ROOT: path.dirname(tools.dotnet), DOTNET_CLI_HOME: home,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false',
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true', MSBUILDDISABLENODEREUSE: '1',
    NUGET_PACKAGES: path.join(home, 'packages'), NUGET_HTTP_CACHE_PATH: path.join(home, 'http-cache'),
  };
}
export function g2DotnetEnvironment(env, tools) {
  const code = 'G2_TOOL_UNTRUSTED';
  const system = path.dirname(tools.cmd);
  const drive = path.parse(system).root;
  const programFiles = g2Physical(path.join(drive, 'Program Files'), 'dir', code);
  const programFilesX86 = g2Physical(path.join(drive, 'Program Files (x86)'), 'dir', code);
  const programData = g2Physical(path.join(drive, 'ProgramData'), 'dir', code);
  const dotnet = path.dirname(tools.dotnet);
  requireThat(path.relative(path.join(programFiles, 'dotnet'), dotnet) === '', code);
  // NuGet/MSBuild require the host layout; never recover it from the caller environment.
  return {
    ...env,
    ProgramFiles: programFiles, 'ProgramFiles(x86)': programFilesX86, ProgramW6432: programFiles,
    ProgramData: programData, ALLUSERSPROFILE: programData,
    PATH: [path.dirname(tools.git), path.dirname(tools.node), dotnet, system].join(path.delimiter),
  };
}
export function g2ReportRunner(output, tools, env, checkControl, commands) {
  return (id, tool, args, cwd, maximum = 60_000) => {
    const stdoutFile = path.join(output, id + '.stdout');
    const stderrFile = path.join(output, id + '.stderr');
    requireThat(!existsSync(stdoutFile) && !existsSync(stderrFile), 'G2_OUTPUT_REUSED');
    const timeout = Math.min(checkControl(), maximum);
    const started = Date.now();
    const result = spawnSync(tools[tool], args, { cwd, env, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
    const ended = Date.now();
    let controlFailure;
    try {
      checkControl();
    } catch (error) {
      controlFailure = error;
    }
    const stdout = result.stdout ?? Buffer.alloc(0);
    const stderr = result.stderr ?? Buffer.alloc(0);
    writeFileSync(stdoutFile, stdout, { flag: 'wx' });
    writeFileSync(stderrFile, stderr, { flag: 'wx' });
    commands.push({
      id, executable: tools[tool], args, cwd, started: new Date(started).toISOString(),
      ended: new Date(ended).toISOString(), exitCode: result.status, signal: result.signal, error: result.error?.code,
      stdout: { file: stdoutFile, sha256: sha256(stdout) }, stderr: { file: stderrFile, sha256: sha256(stderr) },
    });
    if (controlFailure) throw controlFailure;
    requireThat(result.status === 0 && !result.error && !result.signal, 'G2_COMMAND_FAILED');
    return { stdout, started, ended };
  };
}
function g2Fixture(inputs) {
  const name = 'tests/contracts/fixtures/K07/cases.json';
  const fixture = JSON.parse(text(inputs.get(name)));
  requireThat(fixture?.pack === 'K07' && fixture.slice === 'K07.desktop-startup.v1'
    && Array.isArray(fixture.cases) && fixture.cases.length === 114
    && fixture.cases.every((item) => typeof item?.id === 'string' && /^[a-z0-9-]+$/.test(item.id)
      && ['object', 'encode', 'json', 'json-encode', 'projection', 'stream'].includes(item.kind))
    && new Set(fixture.cases.map(({ id }) => id)).size === 114, 'G2_FIXTURE_UNTRUSTED');
  return fixture.cases;
}
function g2Freeze(inputs, count) {
  const schema = 'packages/contracts/schemas/K07/v1.schema.json';
  const fixture = 'tests/contracts/fixtures/K07/cases.json';
  const registry = 'packages/contracts/freeze-registry.json';
  const record = JSON.parse(text(inputs.get(registry)))?.slices?.['K07.desktop-startup.v1'];
  const schemaSha256 = sha256(inputs.get(schema));
  const fixtureSha256 = sha256(inputs.get(fixture));
  requireThat(record?.pack === 'K07' && record.schemaVersion === 1 && record.status === 'consumer_ready'
    && record.machineReview === 'passed' && isDeepStrictEqual(record.schema, { path: schema, sha256: schemaSha256 })
    && isDeepStrictEqual(record.fixtures, { path: fixture, sha256: fixtureSha256, count }), 'G2_FREEZE_UNVERIFIED');
  // n1.lock is the historical freeze evidence, not the current execution dependency lock.
  return { schemaSha256, fixtureSha256, registrySha256: sha256(inputs.get(registry)),
    currentLockSha256: sha256(inputs.get('pnpm-lock.yaml')) };
}
function g2ScratchRoot(file, protectedRoots, code = 'G2_OUTPUT_UNSAFE') {
  const root = g2Physical(file, 'dir', code);
  requireThat(protectedRoots.every((other) => differentRoots(root, other)) && !readdirSync(root).length
    && !/[\x00-\x1f%!"&^|<>]/.test(root) && root.length <= 160, code);
  for (let dir = path.dirname(root); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    requireThat(!existsSync(path.join(dir, '.git')) && !existsSync(path.join(dir, 'node_modules')), code);
  }
  return root;
}
function verifyG2Evidence(output, commands, contractArtifacts = []) {
  const code = 'G2_EVIDENCE_MUTATED';
  const expected = new Set(['home', 'tmp', ...contractArtifacts]);
  for (const dir of ['home', 'tmp']) g2Physical(path.join(output, dir), 'dir', code);
  for (const command of commands) {
    for (const item of [command.stdout, command.stderr]) {
      const file = g2Physical(item.file, 'file', code);
      requireThat(sha256(readFileSync(file)) === item.sha256, code);
      expected.add(path.basename(file));
    }
  }
  const actual = readdirSync(output);
  requireThat(actual.length === expected.size && actual.every((name) => expected.has(name)), code);
}
function runG2(planFile, context) {
  const { root, common, tree, card, index, cardFile, indexFile, base, head, report } = context;
  const selected = (id) => report.checks.find((check) => check.id === id);
  const execution = { commands: [] };
  report.g2 = execution;
  let plan;
  let execRoot;
  let output;
  let deps;
  let generated;
  let tools;
  let env;
  let run;
  let fixture;
  let inputs;
  let feed;
  let resolvedRoots;
  let auth = false;
  const checkControl = (desktop = false) => verifyG2Control({
    cardFile, indexFile, planFile, card, index, protectedRoots: resolvedRoots,
  }, desktop);
  const fresh = (post = false, windowsStarted = false) => {
    checkControl();
    requireThat(path.relative(linkedWorktree(card).common, common) === '', 'G2_EXECUTION_MISMATCH');
    verifyG2Execution(execRoot, root, common, head, plan.tree);
    verifyIndex(root, tree);
    verifyIndex(execRoot, tree);
    if (post) {
      verifyCheckout(root, tree);
      verifyG2Outputs(execRoot, tree, deps, generated.outputs, windowsStarted);
    }
    checkControl();
  };
  stage(selected('format-types'), () => {
    ({ plan } = loadG2Plan(planFile, context));
    execRoot = verifyG2Execution(plan.executionRoot, root, common, head, plan.tree);
    output = g2ScratchRoot(plan.outputRoot, [root, execRoot, common]);
    resolvedRoots = [root, execRoot, output, common];
    for (const control of [planFile, cardFile, indexFile]) {
      requireThat(![execRoot, output, common].some((item) => contained(item, realpathSync.native(control))), 'G2_CONTROL_UNSAFE');
    }
    Object.assign(execution, { base, head, tree: plan.tree, assignmentRevision: card.assignmentRevision,
      planSha256: index.g2PlanSha256, executionRoot: execRoot, outputRoot: output });
    fresh();
    verifyCheckout(execRoot, tree);
    const names = g2InputNamesFor(tree, report.rendererGraph, base, head, root);
    auth = names.size !== g2InputNames.size;
    inputs = verifyG2Inputs(execRoot, tree, plan, resolvedRoots, names);
    fixture = g2Fixture(inputs);
    tools = verifyG2Tools(plan, resolvedRoots);
    feed = verifyG2Feed(plan, resolvedRoots);
    const infoAttributes = path.join(common, 'info', 'attributes');
    requireThat(!existsSync(infoAttributes) || lstatSync(infoAttributes).size === 0, 'G2_ANCESTOR_CONFIG');
    env = g2Environment(execRoot, output, tools);
    run = g2ReportRunner(output, tools, env, checkControl, execution.commands);
    requireThat(text(run('node-version', 'node', ['--version'], execRoot).stdout).trim() === 'v24.22.1', 'G2_TOOL_UNTRUSTED');
    run('diff-check', 'git', ['--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.attributesFile=' + env.GIT_CONFIG_GLOBAL,
      '-c', 'core.whitespace=blank-at-eol,blank-at-eof,space-before-tab', 'diff', '--check',
      '--no-ext-diff', '--no-textconv', base, head, '--'], execRoot);
    deps = materializeG2Packages(execRoot, plan, inputs, resolvedRoots);
    fresh();
    const desktop = path.join(execRoot, 'apps', 'desktop');
    const tsc = path.join(desktop, 'node_modules', 'typescript', 'bin', 'tsc');
    const vite = path.join(desktop, 'node_modules', 'vite', 'bin', 'vite.js');
    for (const entry of [tsc, vite]) {
      const physical = realpathSync.native(entry);
      const name = path.relative(execRoot, physical).split(path.sep).join('/');
      requireThat(deps.files.has(name), 'G2_PACKAGE_UNTRUSTED');
    }
    run('desktop-types', 'node', [tsc, '--noEmit', '--allowImportingTsExtensions'], desktop);
    for (const mode of ['main', 'preload', 'renderer']) {
      run('desktop-build-' + mode, 'node', [vite, 'build', '--mode', mode], desktop);
    }
    generated = g2BuildOutputs(execRoot, head, auth);
    fresh(true);
    verifyG2Evidence(output, execution.commands);
    execution.build = generated.build;
    if (auth) execution.auth = { profileSha256: startupG2ProfileDigest, inputs: inputs.size, outputs: Object.fromEntries(generated.outputs) };
  });
  stage(selected('windows'), () => {
    verifyG2Tools(plan, resolvedRoots);
    const windows = g2ReportRunner(output, tools, env, () => checkControl(true), execution.commands);
    const evidence = [];
    for (const { id, args, expected } of g2WindowsStages(auth)) {
      fresh(true, evidence.length > 0);
      const result = windows(id, 'node', args, execRoot, 125_000);
      evidence.push(verifyG2Tap(result.stdout, expected));
      fresh(true, true);
      verifyG2Evidence(output, execution.commands);
      checkControl(true);
    }
    execution.windows = { ...evidence[0], desktopLease: plan.desktopLease.id,
      ...(auth && { authFixture: evidence[1], authService: evidence[2] }) };
  });
  stage(selected('contracts'), () => {
    verifyG2Tools(plan, resolvedRoots);
    requireThat(verifyG2Feed(plan, resolvedRoots) === feed, 'G2_FEED_UNTRUSTED');
    fresh();
    const freeze = g2Freeze(inputs, fixture.length);
    const contracts = path.join(execRoot, 'packages', 'contracts');
    run('contracts-generated-check', 'node', [path.join(execRoot, 'tools', 'contracts', 'generate.mjs'), '--check'], contracts);
    const ts = run('contracts-ts-tap', 'node', ['--test-reporter=tap', 'tests/contracts/ts/contracts.test.ts', '--pack', 'K07'], execRoot);
    const tsResult = verifyG2Tap(ts.stdout, [...fixture.map(({ id, kind }) => '[K07] ' + kind + ': ' + id), ...generatorTests]);
    const runDotnet = g2ReportRunner(output, tools, g2DotnetEnvironment(env, tools), checkControl, execution.commands);
    requireThat(text(runDotnet('dotnet-sdk-version', 'dotnet', ['--version'], execRoot).stdout).trim() === '10.0.300', 'G2_TOOL_UNTRUSTED');
    const project = path.join(execRoot, 'tests', 'contracts', 'dotnet', 'Orange.Contracts.Tests.csproj');
    const artifacts = path.join(output, 'out');
    const results = path.join(output, 'results');
    const config = path.join(output, 'nuget.config');
    const shim = path.join(output, 'csc-k07.cmd');
    const lock = path.join(output, 'packages.lock.json');
    requireThat([tools.dotnet, tools.csc].every((value) => !/[\x00-\x1f%!"&^|<>]/.test(value)), 'G2_TOOL_UNTRUSTED');
    writeFileSync(config, '<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><clear /></packageSources></configuration>\n', { flag: 'wx' });
    writeFileSync(shim, '@echo off\r\n"' + tools.dotnet + '" exec "' + tools.csc + '" %*\r\nexit /b %errorlevel%\r\n', { flag: 'wx' });
    requireThat(!existsSync(lock), 'G2_OUTPUT_REUSED');
    runDotnet('contracts-dotnet-restore', 'dotnet', ['restore', project, '--configfile', config, '--source', feed,
      '-p:ArtifactsPath=' + artifacts, '-p:NuGetAudit=false', '-p:RestorePackagesWithLockFile=true',
      '-p:NuGetLockFilePath=' + lock], execRoot);
    const lockBytes = readFileSync(g2Physical(lock, 'file', 'G2_RESTORE_LOCK_INVALID'));
    const frameworks = JSON.parse(text(lockBytes)).dependencies;
    const nativeLock = frameworks?.['net10.0'];
    requireThat(frameworks && Object.keys(frameworks).length === 1 && nativeLock && Object.keys(nativeLock).length === 13
      && Object.entries(nativeLock).every(([name, item]) => typeof item?.resolved === 'string'
        && plan.nugetFeed.files.some(({ path: file }) => fold(file) === fold(name + '.' + item.resolved + '.nupkg'))),
    'G2_RESTORE_LOCK_INVALID');
    mkdirSync(results);
    const trx = path.join(results, 'orange-k07.trx');
    requireThat(!existsSync(trx), 'G2_OUTPUT_REUSED');
    const cmd = runDotnet('contracts-dotnet-test', 'dotnet', ['test', project, '--no-restore', '--artifacts-path', artifacts,
      '--filter', 'Pack=K07', '--results-directory', results, '--logger', 'trx;LogFileName=orange-k07.trx',
      '-p:UseSharedCompilation=false', '-p:CscToolPath=' + output, '-p:CscToolExe=csc-k07.cmd'], execRoot, 85_000);
    const trxFile = g2Physical(trx, 'file', 'G2_TRX_INVALID');
    const stat = lstatSync(trxFile);
    requireThat(isDeepStrictEqual(readdirSync(results), ['orange-k07.trx']) && stat.size <= 4 * 1024 * 1024
      && stat.mtimeMs >= cmd.started && stat.mtimeMs <= cmd.ended, 'G2_TRX_STALE');
    const dotnet = verifyG2Trx(readFileSync(trxFile), fixture.map(({ id }) => id), cmd.started, cmd.ended);
    fresh(true, true);
    verifyG2Evidence(output, execution.commands, ['out', 'results', 'nuget.config', 'csc-k07.cmd', 'packages.lock.json']);
    requireThat(readFileSync(g2Physical(lock, 'file', 'G2_EVIDENCE_MUTATED')).equals(lockBytes)
      && sha256(readFileSync(g2Physical(trxFile, 'file', 'G2_EVIDENCE_MUTATED'))) === dotnet.sha256,
    'G2_EVIDENCE_MUTATED');
    execution.contracts = { pack: 'K07', sharedCount: fixture.length, freeze, ts: tsResult, dotnet: { ...dotnet, file: trxFile },
      restoreLock: { file: lock, sha256: sha256(lockBytes), packages: 13 } };
  });
}
const g3Tools = {
  gitleaks: { name: 'gitleaks.exe', version: '8.30.1', sha256: '17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c' },
  osv: { name: 'osv-scanner_windows_amd64.exe', version: '2.7.0', sha256: '9964ed64ec9a387391eb4cc006ad5c531154821aef29b793e02c448de4686438' },
};
const g3DatabaseSha256 = 'a08114a4143f6de37691b7e983f4b80ca09d658e3c4889f6c48088d7669b3dfd';
const g3PnpmSha256 = '7c78700dfd15c68a4aadae2bd3e7aa80323030725a3ae2742f98e88d73b76af7';
const g3GitleaksConfig = 'title = "Orange controlled default rules"\n[extend]\nuseDefault = true\n';
const g3NeutralFile = 'g3-content.txt';
function g3LoadPlan(planFile, context) {
  const { root, card, index, base, head } = context;
  const plan = g2JSON(planFile, index.g3PlanSha256, [root], 'G3_PLAN_UNTRUSTED');
  requireThat(shape(plan, ['schemaVersion', 'taskId', 'assignmentRevision', 'base', 'head', 'tree', 'validUntil',
    'outputRoot', 'tools', 'database', 'pnpmInventory'])
    && plan.schemaVersion === 1 && exactSha(plan.tree)
    && shape(plan.tools, ['gitleaks', 'osv'])
    && Object.values(plan.tools).every((ref) => shape(ref, ['path', 'sha256']) && digest(ref.sha256))
    && shape(plan.database, ['path', 'sha256', 'cacheRoot']) && digest(plan.database.sha256)
    && shape(plan.pnpmInventory, ['path', 'sha256']) && digest(plan.pnpmInventory.sha256), 'G3_PLAN_INVALID');
  requireThat(plan.taskId === card.taskId && plan.assignmentRevision === card.assignmentRevision
    && plan.base === base && plan.head === head && text(git(root, 'rev-parse', head + '^{tree}')).trim() === plan.tree, 'G3_PLAN_STALE');
  g2Deadline(plan.validUntil, Date.parse(index.validUntil), 'G3_PLAN_EXPIRED');
  return plan;
}
export function verifyG3Control({ planFile, index, card, cardFile, indexFile, protectedRoots }) {
  const current = loadApproval(cardFile, indexFile);
  requireThat(isDeepStrictEqual(current, { card, index }), 'G3_CONTROL_CHANGED');
  const plan = g2JSON(planFile, current.index.g3PlanSha256, protectedRoots, 'G3_CONTROL_CHANGED');
  const remaining = g2Deadline(plan.validUntil, Date.parse(current.index.validUntil), 'G3_PLAN_EXPIRED') - Date.now();
  requireThat(remaining > 0, 'G3_PLAN_EXPIRED');
  return remaining;
}
export function verifyG3Tool(role, ref, protectedRoots) {
  const code = 'G3_TOOL_UNTRUSTED';
  const pin = g3Tools[role];
  requireThat(process.platform === 'win32' && process.arch === 'x64' && pin && ref.sha256 === pin.sha256, code);
  const file = g2Physical(ref.path, 'file', code);
  requireThat(path.basename(file) === pin.name && protectedRoots.every((root) => !contained(root, file))
    && lstatSync(file).size <= 128 * 1024 * 1024 && sha256(readFileSync(file)) === pin.sha256, code);
  return file;
}
export function materializeG3Database(ref, output, protectedRoots) {
  const code = 'G3_DATABASE_UNTRUSTED';
  requireThat(ref.sha256 === g3DatabaseSha256, code);
  const manifest = g2JSON(ref.path, ref.sha256, protectedRoots, code);
  const donor = g2Physical(ref.cacheRoot, 'dir', code);
  requireThat(protectedRoots.every((root) => differentRoots(root, donor)), code);
  for (const entry of manifest.entries) {
    const name = path.join('osv-scalibr', entry.ecosystem, 'all.zip');
    const source = g2Physical(path.join(donor, name), 'file', code);
    requireThat(lstatSync(source).size === entry.size, code);
    const bytes = readFileSync(source);
    requireThat(bytes.length === entry.size && sha256(bytes) === entry.sha256, code);
    const file = path.join(output, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes, { flag: 'wx' });
  }
  return { manifestSha256: ref.sha256, fetchedAt: manifest.fetchedAt, archives: manifest.entries
    .map(({ ecosystem, generation, sha256, size }) => ({ ecosystem, generation, sha256, size })) };
}
function verifyG3DatabaseCopy(db, database) {
  const code = 'G3_DATABASE_UNTRUSTED';
  const layout = g2Physical(path.join(db, 'osv-scalibr'), 'dir', code);
  requireThat(isDeepStrictEqual(readdirSync(db), ['osv-scalibr'])
    && isDeepStrictEqual(readdirSync(layout).sort(), database.archives.map(({ ecosystem }) => ecosystem).sort()), code);
  for (const entry of database.archives) {
    const directory = g2Physical(path.join(layout, entry.ecosystem), 'dir', code);
    requireThat(isDeepStrictEqual(readdirSync(directory), ['all.zip']), code);
    const file = g2Physical(path.join(directory, 'all.zip'), 'file', code);
    requireThat(lstatSync(file).size === entry.size && sha256(readFileSync(file)) === entry.sha256, code);
  }
}
function g3SourceSnapshot(root, tree, snapshot) {
  requireThat(tree.size > 0 && tree.size <= 1000, 'G3_SCOPE_UNSUPPORTED');
  let totalBytes = 0;
  const entries = [];
  mkdirSync(snapshot);
  for (const [name, { mode, oid }] of [...tree.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    repositoryPath(name);
    requireThat(regularModes.has(mode), 'G3_SCOPE_UNSUPPORTED');
    const bytes = git(root, 'cat-file', 'blob', oid);
    let decoded;
    try {
      decoded = text(bytes);
    } catch {
      requireThat(false, 'G3_SCOPE_UNSUPPORTED');
    }
    requireThat(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded) && !/\.(?:zip|tar|gz|tgz|7z|rar|jar|nupkg)$/i.test(name),
      'G3_SCOPE_UNSUPPORTED');
    totalBytes += bytes.length;
    requireThat(totalBytes <= 64 * 1024 * 1024, 'G3_SCOPE_UNSUPPORTED');
    const file = path.join(snapshot, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes, { flag: 'wx' });
    entries.push({ path: name, blob: oid, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { entries, totalBytes };
}
function g3SnapshotFile(snapshot, entry) {
  return g3CheckedBlob(path.join(snapshot, entry.path), entry);
}
function g3CheckedBlob(file, entry) {
  const code = 'G3_SNAPSHOT_CHANGED';
  const checked = g2Physical(file, 'file', code);
  requireThat(lstatSync(checked).size === entry.bytes, code);
  const bytes = readFileSync(checked);
  requireThat(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, code);
  return checked;
}
function verifyG3Snapshot(snapshot, entries) {
  const expected = new Set(entries.map((entry) => entry.path));
  const dirs = new Set(['']);
  for (const entry of entries) {
    const parts = entry.path.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    g3SnapshotFile(snapshot, entry);
  }
  for (const dir of dirs) {
    const full = g2Physical(path.join(snapshot, dir), 'dir', 'G3_SNAPSHOT_CHANGED');
    for (const item of readdirSync(full)) {
      const name = dir ? dir + '/' + item : item;
      requireThat(expected.has(name) || dirs.has(name), 'G3_SNAPSHOT_CHANGED');
    }
  }
}
function g3Scanner(executable, args, cwd, env, checkControl, maximum) {
  const timeout = Math.min(checkControl(), maximum);
  const started = Date.now();
  const result = spawnSync(executable, args, { cwd, env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
  const ended = Date.now();
  checkControl();
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw Object.assign(new Error('G3_SCANNER_FAILED'), { gateCode: 'G3_SCANNER_FAILED', scannerExitCode: result.status });
  }
  return { started, ended, stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}
function g3Version(role, tool, cwd, env, checkControl) {
  const result = g3Scanner(tool, [role === 'gitleaks' ? 'version' : '--version'], cwd, env, checkControl, 10_000);
  const version = g3Tools[role].version;
  const lines = text(result.stdout).trimEnd().split(/\r?\n/);
  requireThat(result.exitCode === 0 && result.stderr.length === 0 && (role === 'gitleaks'
    ? isDeepStrictEqual(lines, [version])
    : lines[0] === 'osv-scanner version: ' + version && lines.length === 4
      && /^osv-scalibr version: [\d.]+$/.test(lines[1])
      && /^commit: [a-f0-9]{40}$/.test(lines[2]) && /^built at: [\d:T-]+Z$/.test(lines[3])), 'G3_TOOL_UNTRUSTED');
  return { version, sha256: g3Tools[role].sha256 };
}
function sameG3Source(actual, expected) {
  return typeof actual === 'string' && path.isAbsolute(actual) && path.relative(actual, expected) === '';
}
export function readG3Report(file, result) {
  const code = 'G3_REPORT_INVALID';
  const physical = g2Physical(file, 'file', code);
  const stat = lstatSync(physical);
  requireThat(stat.size > 0 && stat.size <= 8 * 1024 * 1024 && stat.mtimeMs >= result.started && stat.mtimeMs <= result.ended, code);
  const bytes = readFileSync(physical);
  try {
    return { native: JSON.parse(text(bytes)), reportSha256: sha256(bytes) };
  } catch {
    requireThat(false, code);
  }
}
function g3RunReport(tool, args, cwd, env, checkControl, maximum, file, validate) {
  absentG2Path(file, 'G3_REPORT_REUSED');
  try {
    const result = g3Scanner(tool, args, cwd, env, checkControl, maximum);
    const { native, reportSha256 } = readG3Report(file, result);
    return {
      ...validate(native, result), reportSha256, exitCode: result.exitCode,
      started: new Date(result.started).toISOString(), ended: new Date(result.ended).toISOString(),
      stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr),
    };
  } finally {
    // The native report is fresh evidence, not an output channel for raw match data.
    if (existsSync(file)) unlinkSync(file);
  }
}
export function runG3SecretFile({ tool, target, relative, config, ignore, cwd, env, checkControl, file, neutral = false }) {
  g2Physical(target, 'file', 'G3_SNAPSHOT_CHANGED');
  // Pass the fixed neutral basename relative to the trusted cwd: no candidate path or
  // controller-selected ancestor can reintroduce the scanner's default path exemptions.
  requireThat(!neutral || path.relative(cwd, target) === g3NeutralFile, 'G3_SNAPSHOT_CHANGED');
  const scanTarget = neutral ? g3NeutralFile : target;
  return g3RunReport(tool, ['dir', scanTarget, '--config', config, '--gitleaks-ignore-path', ignore,
    '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color', '--log-level', 'error', '--timeout', '60',
    '--report-format', 'json', '--report-path', file], cwd, env, checkControl, 70_000, file, (native, result) => {
    const code = 'G3_GITLEAKS_INVALID';
    requireThat(result.stdout.length === 0 && result.stderr.length === 0 && Array.isArray(native)
      && (result.exitCode === 0) === (native.length === 0), code);
    const findings = native.map((item) => {
      requireThat(item && (neutral ? item.File === g3NeutralFile : sameG3Source(item.File, target))
        && item.SymlinkFile === '' && item.Secret === 'REDACTED'
        && item.Match === 'REDACTED' && typeof item.RuleID === 'string' && /^[a-z0-9-]{1,100}$/.test(item.RuleID)
        && Number.isSafeInteger(item.StartLine) && item.StartLine > 0, code);
      return { path: relative, rule: item.RuleID, line: item.StartLine };
    });
    return { findings };
  });
}
function g3ScanNeutral(entry, target, parameters) {
  const bytes = readFileSync(target);
  requireThat(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'G3_SNAPSHOT_CHANGED');
  const neutral = path.join(parameters.cwd, g3NeutralFile);
  absentG2Path(neutral, 'G3_TEMP_REUSED');
  const fd = openSync(neutral, 'wx');
  try {
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    const checked = g3CheckedBlob(neutral, entry);
    const receipt = runG3SecretFile({ ...parameters, target: checked, neutral: true });
    g3CheckedBlob(neutral, entry);
    return receipt;
  } finally {
    unlinkSync(neutral);
  }
}
function g3Identity(ecosystem, name, version) {
  const code = 'G3_INVENTORY_INVALID';
  requireThat(typeof name === 'string' && typeof version === 'string'
    && /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.-]+)?$/.test(version)
    && (ecosystem === 'npm' ? /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)
      : ecosystem === 'NuGet' && /^[A-Za-z0-9._-]+$/.test(name)), code);
  return (ecosystem === 'NuGet' ? fold(name) : name) + '\0' + version;
}
export function verifyG3OSVReport(native, locks, exitCode) {
  const code = 'G3_OSV_INVALID';
  requireThat([0, 1].includes(exitCode) && shape(native, ['results', 'experimental_config']) && Array.isArray(native.results)
    && native.results.length === locks.length && native.experimental_config && typeof native.experimental_config === 'object', code);
  const seenLocks = new Set();
  const sources = [];
  const findings = [];
  for (const result of native.results) {
    requireThat(shape(result, ['source', 'packages']) && shape(result.source, ['path', 'type'])
      && result.source.type === 'lockfile' && Array.isArray(result.packages), code);
    const lock = locks.find((item) => sameG3Source(result.source.path, item.file));
    requireThat(lock && !seenLocks.has(lock.file) && result.packages.length === lock.packages.length, code);
    seenLocks.add(lock.file);
    const remaining = new Set(lock.packages.map(({ name, version }) => g3Identity(lock.ecosystem, name, version)));
    requireThat(remaining.size === lock.packages.length && remaining.size > 0, code);
    for (const row of result.packages) {
      requireThat(row && Object.keys(row).every((key) => ['package', 'groups', 'vulnerabilities'].includes(key))
        && shape(row.package, ['ecosystem', 'name', 'version', 'purl']) && row.package.ecosystem === lock.ecosystem, code);
      const { name, version, purl } = row.package;
      const key = g3Identity(lock.ecosystem, name, version);
      const expectedPurl = 'pkg:' + lock.ecosystem.toLowerCase() + '/' + encodeURIComponent(name).replaceAll('%2F', '/') + '@' + version;
      requireThat(remaining.delete(key) && (purl === expectedPurl || (lock.ecosystem === 'npm'
        && purl === expectedPurl + '?source=PUBLIC_REGISTRY')), code);
      const vulns = Object.hasOwn(row, 'vulnerabilities') ? row.vulnerabilities : [];
      requireThat(Array.isArray(vulns) && (!Object.hasOwn(row, 'groups') || Array.isArray(row.groups)
        && (row.groups.length === 0 || vulns.length > 0)), code);
      const ids = new Set();
      for (const vuln of vulns) {
        requireThat(vuln && typeof vuln.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(vuln.id)
          && !ids.has(vuln.id), code);
        ids.add(vuln.id);
        findings.push({ source: path.basename(lock.file), ecosystem: lock.ecosystem, name, version, id: vuln.id });
      }
    }
    requireThat(remaining.size === 0, code);
    sources.push({ path: path.basename(lock.file), ecosystem: lock.ecosystem, count: lock.packages.length,
      inventorySha256: sha256(JSON.stringify(lock.packages)), packages: lock.packages });
  }
  requireThat((exitCode === 0) === (findings.length === 0), code);
  return { sources, findings };
}
function verifyG3OSVDiagnostics(result, locks, db) {
  const code = 'G3_OSV_DIAGNOSTICS';
  requireThat(result.stdout.length === 0, code);
  const lines = text(result.stderr).trimEnd().split(/\r?\n/);
  const walk = new Set(locks.map(({ file }) => path.parse(file).root));
  const scanned = new Set(locks);
  const loaded = new Set(locks.map(({ ecosystem }) => ecosystem));
  let ends = 0;
  for (const line of lines) {
    if (line.startsWith('Starting filesystem walk for root: ')) {
      requireThat(walk.delete(line.slice('Starting filesystem walk for root: '.length)), code);
    } else if (line.startsWith('Scanned ')) {
      const match = /^Scanned (.+) file and found ([1-9]\d*) packages?$/.exec(line);
      const lock = match && locks.find(({ file }) => sameG3Source(match[1], file));
      requireThat(lock && scanned.delete(lock) && Number(match[2]) === lock.packages.length, code);
    } else if (line.startsWith('Loaded ')) {
      const match = /^Loaded (npm|NuGet) local db from (.+)$/.exec(line);
      requireThat(match && loaded.delete(match[1]) && sameG3Source(match[2], path.join(db, 'osv-scalibr', match[1], 'all.zip')), code);
    } else {
      requireThat(++ends === 1 && new RegExp('^End status: 0 dirs visited, ' + locks.length + ' inodes visited, '
        + locks.length + ' Extract calls, [0-9a-zµ.]+ elapsed, [0-9a-zµ.]+ wall time$').test(line), code);
    }
  }
  requireThat(ends === 1 && walk.size === 0 && scanned.size === 0 && loaded.size === 0, code);
}
export function runG3OSV({ tool, locks, config, cwd, env, db, checkControl, file }) {
  return g3RunReport(tool, ['scan', 'source', '--offline', '--no-resolve', '--no-call-analysis=all',
    '--config', config, '--format=json', '--all-packages', '--all-vulns', '--output-file', file,
    ...locks.flatMap((lock) => ['--lockfile', lock.file])], cwd,
  { ...env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: db }, checkControl, 120_000, file, (native, result) => {
    verifyG3OSVDiagnostics(result, locks, db);
    return verifyG3OSVReport(native, locks, result.exitCode);
  });
}
function g3NpmInventory(ref, lock, protectedRoots) {
  const code = 'G3_INVENTORY_INVALID';
  const inventory = g2JSON(ref.path, ref.sha256, protectedRoots, code);
  requireThat(shape(inventory, ['schemaVersion', 'lockSha256', 'packages']) && inventory.schemaVersion === 1
    && inventory.lockSha256 === g3PnpmSha256 && lock.sha256 === g3PnpmSha256
    && Array.isArray(inventory.packages) && inventory.packages.length === 61, code);
  requireThat(new Set(inventory.packages.map((item) => {
    requireThat(shape(item, ['name', 'version']), code);
    return g3Identity('npm', item.name, item.version);
  })).size === 61, code);
  return inventory.packages;
}
export function readG3NativeLock(g2, { base, head, tree, assignmentRevision }) {
  const code = 'G3_NUGET_HANDOFF';
  requireThat(g2 && g2.base === base && g2.head === head && g2.tree === tree && g2.assignmentRevision === assignmentRevision
    && g2.contracts?.pack === 'K07' && g2.contracts.restoreLock?.packages === 13, code);
  const lock = g2.contracts.restoreLock;
  const file = g2Physical(lock.file, 'file', code);
  const project = path.join(g2.executionRoot, 'tests/contracts/dotnet/Orange.Contracts.Tests.csproj');
  const commands = g2.commands.filter(({ id }) => ['contracts-dotnet-restore', 'contracts-dotnet-test'].includes(id));
  requireThat(path.relative(file, path.join(g2.outputRoot, 'packages.lock.json')) === ''
    && commands.length === 2 && commands[0].id === 'contracts-dotnet-restore' && commands[1].id === 'contracts-dotnet-test'
    && commands.every(({ exitCode, args }) => exitCode === 0 && sameG3Source(args[1], project))
    && commands[0].args.includes('-p:NuGetLockFilePath=' + file)
    && commands[1].args.includes('Pack=K07') && lstatSync(file).size <= 2 * 1024 * 1024, code);
  const bytes = readFileSync(file);
  requireThat(sha256(bytes) === lock.sha256, code);
  const native = JSON.parse(text(bytes));
  requireThat(shape(native, ['version', 'dependencies']) && native.version === 1 && shape(native.dependencies, ['net10.0']), code);
  const entries = Object.entries(native.dependencies['net10.0'] ?? {});
  requireThat(entries.length === 13, code);
  const packages = entries.map(([name, row]) => {
    requireThat(row && ['Direct', 'Transitive'].includes(row.type) && typeof row.contentHash === 'string'
      && /^[A-Za-z0-9+/]{86}==$/.test(row.contentHash), code);
    g3Identity('NuGet', name, row.resolved);
    return { name, version: row.resolved };
  });
  requireThat(new Set(packages.map(({ name, version }) => g3Identity('NuGet', name, version))).size === 13, code);
  return { bytes, packages, project, lockSha256: lock.sha256 };
}
function runG3(planFile, context) {
  const { root, common, tree, card, index, cardFile, indexFile, base, head, report } = context;
  const selected = (id) => report.checks.find((item) => item.id === id);
  let plan;
  let output;
  let protectedRoots;
  let snapshot;
  let entries;
  let env;
  const checkControl = () => verifyG3Control({ planFile, card, index, cardFile, indexFile, protectedRoots });
  const fresh = () => {
    checkControl();
    requireThat(path.relative(linkedWorktree(card).common, common) === '', 'G3_PLAN_STALE');
    verifyIndex(root, tree);
    verifyCheckout(root, tree);
    checkControl();
  };
  const scanSecret = () => stage(selected('secret-scan'), () => {
    plan = g3LoadPlan(planFile, context);
    const g2Roots = report.g2 ? [report.g2.executionRoot, report.g2.outputRoot] : [];
    output = g2ScratchRoot(plan.outputRoot, [root, common, ...g2Roots], 'G3_OUTPUT_UNSAFE');
    protectedRoots = [root, common, output, ...g2Roots];
    for (const item of [planFile, cardFile, indexFile]) {
      requireThat(!protectedRoots.some((location) => contained(location, realpathSync.native(item))), 'G3_PLAN_UNTRUSTED');
    }
    fresh();
    const tool = verifyG3Tool('gitleaks', plan.tools.gitleaks, protectedRoots);
    const windows = g2Physical('C:/Windows', 'dir', 'G3_TOOL_UNTRUSTED');
    const temp = path.join(output, 'tmp');
    const home = path.join(output, 'home');
    const ignore = path.join(output, 'empty-ignore');
    for (const dir of [temp, home, ignore]) mkdirSync(dir);
    env = { SystemRoot: windows, WINDIR: windows, TEMP: temp, TMP: temp, HOME: home, USERPROFILE: home,
      APPDATA: home, LOCALAPPDATA: home };
    const config = path.join(output, 'gitleaks.toml');
    writeFileSync(config, g3GitleaksConfig, { flag: 'wx' });
    const checkSecretControl = () => {
      const code = 'G3_CONFIG_CHANGED';
      requireThat(sha256(readFileSync(g2Physical(config, 'file', code))) === sha256(g3GitleaksConfig)
        && readdirSync(g2Physical(ignore, 'dir', code)).length === 0, code);
      return checkControl();
    };
    const version = g3Version('gitleaks', tool, output, env, checkControl);
    snapshot = path.join(output, 'snapshot');
    let totalBytes;
    ({ entries, totalBytes } = g3SourceSnapshot(root, tree, snapshot));
    verifyG3Snapshot(snapshot, entries);
    const secret = { tool: version, configSha256: sha256(g3GitleaksConfig), files: entries.length, totalBytes,
      manifestSha256: sha256(JSON.stringify(entries)), unscanned: entries.length, receipts: [] };
    report.g3 = { base, head, tree: plan.tree, assignmentRevision: card.assignmentRevision,
      planSha256: index.g3PlanSha256, secret };
    for (const [number, entry] of entries.entries()) {
      const target = g3SnapshotFile(snapshot, entry);
      const parameters = { tool, relative: entry.path, config, ignore, cwd: output, env, checkControl: checkSecretControl };
      const receipt = { ...entry, scans: [] };
      secret.receipts.push(receipt);
      const original = runG3SecretFile({ ...parameters, target, file: path.join(output, 'gitleaks-' + number + '-path.json') });
      receipt.scans.push({ mode: 'original-path', inputSha256: entry.sha256, ...original });
      const neutral = g3ScanNeutral(entry, target, { ...parameters, file: path.join(output, 'gitleaks-' + number + '-content.json') });
      receipt.scans.push({ mode: 'neutral-content', inputSha256: entry.sha256, ...neutral });
      receipt.findings = [...new Map(receipt.scans.flatMap((scan) => scan.findings)
        .map((finding) => [JSON.stringify(finding), finding])).values()];
      secret.unscanned--;
      requireThat(receipt.findings.length === 0, 'G3_SECRET_FOUND');
    }
    verifyG3Snapshot(snapshot, entries);
    fresh();
  });
  const scanDependencies = () => stage(selected('dependency-audit'), () => {
    fresh();
    const tool = verifyG3Tool('osv', plan.tools.osv, protectedRoots);
    const version = g3Version('osv', tool, output, env, checkControl);
    const admitted = entries.find((item) => item.path === 'pnpm-lock.yaml');
    requireThat(admitted, 'G3_INVENTORY_INVALID');
    const pnpm = g3SnapshotFile(snapshot, admitted);
    const npm = g3NpmInventory(plan.pnpmInventory, admitted, protectedRoots);
    const native = readG3NativeLock(report.g2, { base, head, tree: plan.tree, assignmentRevision: card.assignmentRevision });
    const nuget = path.join(output, 'packages.lock.json');
    writeFileSync(nuget, native.bytes, { flag: 'wx' });
    const db = path.join(output, 'db');
    const database = materializeG3Database(plan.database, db, protectedRoots);
    const config = path.join(output, 'osv.toml');
    writeFileSync(config, '', { flag: 'wx' });
    const locks = [{ file: pnpm, ecosystem: 'npm', packages: npm }, { file: nuget, ecosystem: 'NuGet', packages: native.packages }];
    const checkAuditControl = () => {
      const code = 'G3_CONFIG_CHANGED';
      requireThat(lstatSync(g2Physical(config, 'file', code)).size === 0, code);
      return checkControl();
    };
    const evidence = runG3OSV({ tool, locks, config, cwd: output, env, db, checkControl: checkAuditControl, file: path.join(output, 'osv.json') });
    report.g3.dependencies = { tool: version, database, configSha256: sha256(''), pnpm: admitted,
      pnpmInventorySha256: plan.pnpmInventory.sha256, native: { project: native.project, lockSha256: native.lockSha256 }, ...evidence };
    requireThat(evidence.findings.length === 0, 'G3_VULNERABILITIES_FOUND');
    verifyG3DatabaseCopy(db, database);
    requireThat(sha256(readFileSync(g2Physical(nuget, 'file', 'G3_NUGET_HANDOFF'))) === native.lockSha256, 'G3_NUGET_HANDOFF');
    readG3NativeLock(report.g2, { base, head, tree: plan.tree, assignmentRevision: card.assignmentRevision });
    verifyG3Snapshot(snapshot, entries);
    fresh();
  });
  try {
    scanSecret();
    if (selected('contracts').status === 'passed') scanDependencies();
  } finally {
    if (snapshot && existsSync(snapshot)) {
      const checkedOutput = g2Physical(output, 'dir', 'G3_OUTPUT_UNSAFE');
      const checkedSnapshot = g2Physical(snapshot, 'dir', 'G3_OUTPUT_UNSAFE');
      requireThat(path.relative(checkedOutput, checkedSnapshot) === 'snapshot', 'G3_OUTPUT_UNSAFE');
      rmSync(checkedSnapshot, { recursive: true });
    }
  }
  checkControl();
}
function evaluate(args, report) {
  const flags = parseArgs(args, ['--base', '--head', '--card'],
    ['--trusted-typescript', ...rendererGraphFlags, '--trusted-g2-plan', '--trusted-g3-plan', '--trusted-review']);
  const graphRequested = rendererGraphFlags.some((flag) => flags[flag]);
  const base = flags['--base'];
  const head = flags['--head'];
  requireThat(exactSha(base) && exactSha(head), 'BAD_ARGUMENTS');
  const cardFile = path.resolve(flags['--card']);
  const indexFile = path.join(path.dirname(cardFile), 'index.json');
  const checks = [
    ...['write-set', 'imports'].map((id) => ({ id, exitCode: null, status: 'not-run' })),
    ...requiredStages.map((id) => ({ id, exitCode: null, status: 'unavailable' })),
  ];
  Object.assign(report, { base, head, changedFiles: [], checks });
  const { root, common, tree, index, card } = stage(checks[0], () => {
    const { card, index } = loadApproval(cardFile, indexFile);
    requireThat(card.workingBaselineCommit === base && card.headCommit === head, 'CARD_STALE');
    const { root, common } = linkedWorktree(card);
    requireThat(path.relative(root, realpathSync.native(process.cwd())) === '', 'WORKTREE_MISMATCH');
    const trustedRoot = realpathSync.native(fileURLToPath(new URL('../..', import.meta.url)));
    requireThat(!contained(root, trustedRoot), 'GATE_SELF_EXECUTION');
    verifyBaseline(root, card);
    const changes = changedPaths(root, linearCommits(root, base, head));
    report.changedFiles = changes;
    requireThat(changes.length > 0, 'EMPTY_CANDIDATE');
    const allowed = new Set(card.writeSet);
    requireThat(changes.every((name) => allowed.has(name)), 'WRITE_SET_VIOLATION');
    const tree = readTree(root, head);
    rejectAliases([...new Set([...tree.keys(), ...changes])]);
    verifyIndex(root, tree);
    verifyCheckout(root, tree);
    return { root, common, tree, index, card };
  });
  stage(checks[1], () => {
    const parser = loadImportParser(root, flags['--trusted-typescript']);
    requireThat(!graphRequested || parser, 'GRAPH_PARSER_REQUIRED');
    if (parser) report.importParser = parser.provenance;
    const violations = checkImports(root, tree, parser);
    if (violations.length) report.violations = violations;
    requireThat(violations.length === 0, 'IMPORT_PREFLIGHT_FAILED');
  });
  const context = { root, common, tree, card, index, cardFile, indexFile, base, head, report, changes: report.changedFiles };
  const reviewFile = flags['--trusted-review'];
  const reviewCheck = checks.find(({ id }) => id === 'independent-review');
  let review;
  if (reviewFile) {
    try {
      review = loadG4Review(reviewFile, context);
    } catch (error) {
      stage(reviewCheck, () => { throw error; });
    }
  }
  if (graphRequested) {
    const check = checks.find(({ id }) => id === 'import-build-graph');
    stage(check, () => {
      let result;
      try {
        result = runRendererGraph(root, tree, flags);
      } finally {
        assertIndexFresh(index);
        requireThat(isDeepStrictEqual(loadApproval(cardFile, indexFile).card, card), 'CARD_STALE');
        linkedWorktree(card);
        verifyIndex(root, tree);
        verifyCheckout(root, tree);
      }
      report.rendererGraph = { ...result, base, head };
    });
  }
  if (flags['--trusted-g2-plan']) {
    runG2(flags['--trusted-g2-plan'], context);
  }
  if (flags['--trusted-g3-plan']) {
    runG3(flags['--trusted-g3-plan'], context);
  }
  assertIndexFresh(index);
  if (review && checks.filter((item) => item !== reviewCheck).every(({ status, exitCode }) => status === 'passed' && exitCode === 0)) {
    let observedInputs;
    stage(reviewCheck, () => {
      const g2File = flags['--trusted-g2-plan'];
      const g3File = flags['--trusted-g3-plan'];
      requireThat(graphRequested && g2File && g3File, 'G4_INPUTS_UNAVAILABLE');
      const { plan: g2 } = loadG2Plan(g2File, context);
      const g3 = g3LoadPlan(g3File, context);
      const extraRoots = [g2.executionRoot, g2.outputRoot, g3.outputRoot, flags['--graph-scratch']].map((dir) => realpathSync.native(dir));
      const protectedRoots = [root, common, ...extraRoots];
      const currentControls = () => {
        verifyG2Control({ ...context, planFile: g2File, protectedRoots }, true);
        verifyG3Control({ ...context, planFile: g3File, protectedRoots });
        requireThat(isDeepStrictEqual(loadG4Review(reviewFile, context, extraRoots), review), 'G4_REVIEW_STALE');
      };
      currentControls();
      requireThat(path.relative(linkedWorktree(card).common, common) === '', 'WORKTREE_MISMATCH');
      verifyIndex(root, tree);
      verifyCheckout(root, tree);
      observedInputs = g4InputDigest(context, g2, g3);
      requireThat(observedInputs === review.subject.inputsSha256, 'G4_INPUTS_STALE');
      currentControls();
      report.independentReview = { subject: review.subject, reviewerId: review.reviewerId,
        specs: review.specs, quality: review.quality, evidenceSha256: review.evidenceSha256 };
    });
    if (g4DecideCandidate(checks, review.subject.inputsSha256, observedInputs)) {
      Object.assign(report, { code: 'CANDIDATE_CHECKS_PASSED', admitted: true });
      return;
    }
  }
  report.code = 'REQUIRED_CHECK_UNAVAILABLE';
}
cli(import.meta.url, evaluate);
