import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, freemem, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  assertIndexFresh, checkWorktreePath, cli, contained, exactSha, fold, git, linkedWorktree, loadApproval, nulFields, parseArgs,
  repositoryPath, requireThat, text,
} from './check-admission.mjs';
import { checkImports, loadImportParser, loadStudioRendererInputs, rendererGraphFlags, runRendererGraph,
  runStudioRendererGraph, studioRendererRequested, verifyStudioRendererStatic } from './check-imports.mjs';

const regularModes = new Set(['100644', '100755']);
const requiredStages = [
  'format-types', 'dependency-audit', 'secret-scan', 'import-build-graph', 'windows', 'contracts', 'independent-review',
];
const candidateChecks = ['write-set', 'imports', ...requiredStages];
const reviewerIdentity = (value) => typeof value === 'string' && value.length <= 160
  && /^\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i.test(value);

const studioMode = 'studio-source-only';
const studioLink = 'vendor/openfilm';
const studioDualGraphRequired = 'STUDIO_DUAL_GRAPH_REQUIRED';
const studioPolicy = Object.freeze({
  e0: '75a00f94db1c5e640b05ead26ed31624fa1c5254',
  url: 'https://github.com/jerry-halo2026/openfilm.git',
  pin: '2e18a4bdf54647b2ece3c0975a6f9573720c7821',
  sourceTree: '5b898016c32e794091d9e4a5ac7901497b2e9210',
  modulesBlob: '12829551ca0bb641ff2fe235a35a81bbab5a283a',
  pack: Object.freeze({
    stem: 'pack-1a9724bd90ba2ea35f8186cc6c0b439dba53cf2f',
    indexBytes: 28288, indexSha256: 'f9bc0c5ec32a4f7c3cc4a5e2d5eb9a899668c9721cc81617f57ee70a43d85a67',
    packBytes: 11943077, packSha256: '7f29a83a4d2f020ea4e6a78d7f80581919573bd792235748bfe0c9a6f3f26864',
  }),
});
const studioPathUnsafe = 'STUDIO_SOURCE_PATH_UNSAFE';
const studioRepoUnsafe = 'STUDIO_SOURCE_REPOSITORY_UNSAFE';
const studioStoreUnsafe = 'STUDIO_SOURCE_OBJECT_STORE_UNSAFE';
const studioHeadInvalid = 'STUDIO_SOURCE_HEAD_INVALID';
const studioCandidateUnavailable = 'STUDIO_SOURCE_CANDIDATE_OBJECT_UNAVAILABLE';
const studioMiB = 1024 * 1024;

function studioPhysical(file, kind, code, optional = false) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    requireThat(false, code);
  }
  let resolved;
  try {
    resolved = realpathSync.native(file);
  } catch {
    requireThat(false, code);
  }
  const regular = stat.isFile() && (stat.nlink === 1 || kind === 'trusted-executable');
  requireThat(path.relative(file, resolved) === '' && !stat.isSymbolicLink()
    && (kind === 'directory' ? stat.isDirectory() : kind === 'marker' ? stat.isDirectory() || regular : regular), code);
  return { path: resolved, stat };
}
function studioReadBytes({ path: file, stat }, limit, code) {
  requireThat(stat.size <= limit, code);
  const sameFile = (current) => current.isFile()
    && ['dev', 'ino', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((key) => current[key] === stat[key]);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    requireThat(sameFile(fstatSync(fd)), code);
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    requireThat(offset === stat.size && sameFile(fstatSync(fd)), code);
    return bytes.subarray(0, offset);
  } catch {
    requireThat(false, code);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function studioRead(file, code, { optional = false, max = 4096 } = {}) {
  const physical = studioPhysical(file, 'file', code, optional);
  if (!physical) return null;
  try {
    return text(studioReadBytes(physical, max, code));
  } catch {
    requireThat(false, code);
  }
}
const studioAbsolute = (value) => typeof value === 'string' && path.isAbsolute(value)
  && !/[\x00-\x1f\x7f]/.test(value) && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(value));
function studioRepo(value) {
  requireThat(studioAbsolute(value), studioPathUnsafe);
  const root = studioPhysical(path.resolve(value), 'directory', studioPathUnsafe).path;
  const marker = studioPhysical(path.join(root, '.git'), 'marker', studioRepoUnsafe);
  if (marker.stat.isDirectory()) return { root, gitDir: marker.path, common: marker.path };
  const locator = /^gitdir: ([^\x00-\x1f\x7f]+)\r?\n$/.exec(studioRead(marker.path, studioRepoUnsafe));
  requireThat(locator && (!path.isAbsolute(locator[1]) || studioAbsolute(locator[1])), studioRepoUnsafe);
  const gitDir = studioPhysical(path.resolve(root, locator[1]), 'directory', studioRepoUnsafe).path;
  const common = studioPhysical(path.resolve(gitDir, '../..'), 'directory', studioRepoUnsafe).path;
  const backlink = studioRead(path.join(gitDir, 'gitdir'), studioRepoUnsafe).replace(/\r?\n$/, '');
  requireThat(path.relative(path.join(common, 'worktrees'), path.dirname(gitDir)) === ''
    && /^(?:\.\.\/\.\.|\.\.\\\.\.)\r?\n$/.test(studioRead(path.join(gitDir, 'commondir'), studioRepoUnsafe))
    && studioAbsolute(backlink) && path.relative(backlink, marker.path) === '', studioRepoUnsafe);
  return { root, gitDir, common };
}
function studioHead({ gitDir, common }) {
  const content = studioRead(path.join(gitDir, 'HEAD'), studioHeadInvalid);
  const ref = content.replace(/\r?\n$/, '');
  if (exactSha(ref)) return ref;
  const branch = /^ref: (refs\/heads\/[A-Za-z0-9_-][A-Za-z0-9._/-]*)$/.exec(ref)?.[1];
  requireThat(branch && !branch.includes('..')
    && branch.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.') && !/\.lock$/i.test(part)), studioHeadInvalid);
  const loose = studioRead(path.join(common, branch), studioHeadInvalid, { optional: true });
  if (loose !== null) {
    const oid = loose.replace(/\r?\n$/, '');
    requireThat(exactSha(oid), studioHeadInvalid);
    return oid;
  }
  const packed = studioRead(path.join(common, 'packed-refs'), studioHeadInvalid, { optional: true, max: 16 * 1024 * 1024 });
  const entries = (packed ?? '').split(/\r?\n/).filter((line) => line.endsWith(' ' + branch));
  const oid = entries[0]?.slice(0, -(branch.length + 1));
  requireThat(entries.length === 1 && exactSha(oid), studioHeadInvalid);
  return oid;
}
function studioGitExecutable() {
  const code = 'STUDIO_SOURCE_GIT_UNAVAILABLE';
  requireThat(process.platform === 'win32', code);
  // Direct reviewed Git for Windows 2.56.0.windows.4 executable, not its
  // launcher, PATH lookup, or any operator/candidate-supplied executable.
  const file = studioPhysical('C:/Program Files/Git/ucrt64/bin/git.exe', 'trusted-executable', code);
  const size = 4412760;
  requireThat(file.stat.size === size
    && createHash('sha256').update(studioReadBytes(file, size, code)).digest('hex')
      === '9c75f3f41eb5686bacde4b7c4fdfcd7970e8b699ee05c8d7a0cc9c8a7ddaffe8', code);
  return file.path;
}
function studioGitEnvironment(scratch) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:SystemRoot|WINDIR)$/i.test(key)));
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'empty-global-config'),
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
  });
}
function studioGitStore(executable, scratch, head, shallow = null) {
  mkdirSync(scratch);
  mkdirSync(path.join(scratch, 'refs'));
  writeFileSync(path.join(scratch, 'HEAD'), head + '\n');
  writeFileSync(path.join(scratch, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
  if (shallow) writeFileSync(path.join(scratch, 'shallow'), shallow);
  // No original Git config, refs, hooks, index, worktree, grafts or Git environment.
  const env = studioGitEnvironment(scratch);
  const run = (code, input, args) => {
    const result = spawnSync(executable, [
      '--no-pager', '--no-replace-objects', '--no-optional-locks', '--literal-pathspecs', '--git-dir=' + scratch,
      '-c', 'protocol.allow=never', '-c', 'core.multiPackIndex=false', '-c', 'core.commitGraph=false', ...args,
    ], { cwd: scratch, env, input, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    requireThat(result.status === 0, code);
    return result.stdout;
  };
  const query = (code, ...args) => run(code, undefined, args);
  query.batchBlobs = (code, ids) => {
    requireThat(ids.length <= 235 && ids.every(exactSha), code);
    return run(code, ids.join('\n') + '\n', ['cat-file', '--batch']);
  };
  return query;
}
function studioObjectStore(common) {
  const objects = studioPhysical(path.join(common, 'objects'), 'directory', studioStoreUnsafe).path;
  const info = studioPhysical(path.join(objects, 'info'), 'directory', studioStoreUnsafe, true);
  // A repack can leave a dumb-HTTP pack list. It is ignored, not read/copied.
  requireThat(!info || readdirSync(info.path).every((name) => name === 'packs'), studioStoreUnsafe);
  const pack = studioPhysical(path.join(objects, 'pack'), 'directory', studioStoreUnsafe, true);
  const packNames = pack ? readdirSync(pack.path) : [];
  requireThat(!packNames.some((name) => name.toLowerCase().endsWith('.promisor')), studioStoreUnsafe);
  return { objects, pack: pack?.path, packNames };
}
function studioLooseObjects(objects, scratch, { limit, total, capacity, budgetCode, missingPackCode }) {
  const staged = new Map();
  let compressedTotal = 0;
  let rawTotal = 0;
  return (type, oid, code) => {
    requireThat(exactSha(oid), code);
    const stagedType = staged.get(oid);
    if (!stagedType) {
      const prefix = oid.slice(0, 2);
      const name = oid.slice(2);
      const dir = studioPhysical(path.join(objects, prefix), 'directory', studioStoreUnsafe, true);
      const file = dir && studioPhysical(path.join(dir.path, name), 'file', studioStoreUnsafe, true);
      requireThat(file, missingPackCode ?? code);
      requireThat(staged.size < capacity && compressedTotal < total && rawTotal < total, budgetCode);
      const compressed = studioReadBytes(file, Math.min(limit, total - compressedTotal), budgetCode);
      let object;
      try {
        object = inflateSync(compressed, { maxOutputLength: Math.min(limit, total - rawTotal) });
      } catch (error) {
        requireThat(false, error.code === 'ERR_BUFFER_TOO_LARGE' ? budgetCode : code);
      }
      const end = object.indexOf(0);
      requireThat(end > 0
        && object.subarray(0, end).equals(Buffer.from(type + ' ' + (object.length - end - 1)))
        && createHash('sha1').update(object).digest('hex') === oid, code);
      const target = path.join(scratch, 'objects', prefix);
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, name), compressed, { flag: 'wx' });
      staged.set(oid, type);
      compressedTotal += compressed.length;
      rawTotal += object.length;
      return object.subarray(end + 1);
    }
    requireThat(stagedType === type, code);
    return null;
  };
}
function studioCommit(bytes, code) {
  const boundary = bytes.indexOf('\n\n');
  requireThat(boundary > 46 && !bytes.includes(0), code);
  const headers = bytes.subarray(0, boundary).toString('latin1').split('\n');
  const tree = /^tree ([0-9a-f]{40})$/.exec(headers[0])?.[1];
  requireThat(tree, code);
  const parents = [];
  let at = 1;
  while (headers[at]?.startsWith('parent ')) {
    const parent = headers[at++].slice(7);
    requireThat(exactSha(parent), code);
    parents.push(parent);
  }
  const ident = /^[^<>\r\n]+ <[^<>\r\n]+> [0-9]+ [+-][0-9]{4}$/;
  for (const role of ['author ', 'committer ']) {
    const line = headers[at++];
    requireThat(line?.startsWith(role) && ident.test(line.slice(role.length)), code);
  }
  let extra = false;
  for (; at < headers.length; at++) {
    const line = headers[at];
    if (extra && line.startsWith(' ')) continue;
    requireThat(/^(?!(?:tree|parent|author|committer) )[a-z0-9-]+ [^\r\n]*$/.test(line), code);
    extra = true;
  }
  return { tree, parents };
}
function* studioTreeEntries(bytes, code) {
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at);
    const end = bytes.indexOf(0, at);
    requireThat(space > at && end > space + 1 && end + 21 <= bytes.length, code);
    yield {
      mode: bytes.subarray(at, space).toString('latin1'), name: bytes.subarray(space + 1, end),
      oid: bytes.subarray(end + 1, end + 21).toString('hex'),
    };
    at = end + 21;
  }
}
function studioCandidateReferences(read, tree, { pin, modulesBlob, url }) {
  const gitlinkMismatch = 'STUDIO_SOURCE_GITLINK_MISMATCH';
  const modulesMismatch = 'STUDIO_SOURCE_GITMODULES_MISMATCH';
  const treeInvalid = 'STUDIO_SOURCE_CANDIDATE_TREE_INVALID';
  const entries = (oid) => Array.from(studioTreeEntries(read('tree', oid, treeInvalid), treeInvalid), (entry) => {
    let name;
    try {
      name = text(entry.name);
      requireThat(repositoryPath(name).length === 1, treeInvalid);
    } catch {
      requireThat(false, treeInvalid);
    }
    return { ...entry, name };
  });
  const find = (items, name, mode, code) => {
    let oid;
    for (const entry of items) {
      if (fold(entry.name) === name) {
        requireThat(entry.name === name && oid === undefined && entry.mode === mode, code);
        oid = entry.oid;
      }
    }
    requireThat(oid !== undefined, code);
    return oid;
  };
  const root = entries(tree);
  const vendor = entries(find(root, 'vendor', '40000', gitlinkMismatch));
  requireThat(find(vendor, 'openfilm', '160000', gitlinkMismatch) === pin, gitlinkMismatch);
  requireThat(find(root, '.gitmodules', '100644', modulesMismatch) === modulesBlob, modulesMismatch);
  const exact = Buffer.from('[submodule "' + studioLink + '"]\n\tpath = ' + studioLink + '\n\turl = ' + url + '\n');
  requireThat(read('blob', modulesBlob, modulesMismatch).equals(exact), modulesMismatch);
}
const studioCommitUnavailable = 'STUDIO_SOURCE_COMMIT_UNAVAILABLE';
const studioClosureInvalid = 'STUDIO_SOURCE_CLOSURE_INVALID';
const studioTreeMismatch = 'STUDIO_SOURCE_TREE_MISMATCH';
const studioPacked = ({ packNames }) => packNames.some((name) => /^pack-[0-9a-f]{40}\.pack$/.test(name));
function studioSourceObjects(store, scratch, { pack, pin, sourceTree }, shallow) {
  const objects = path.join(scratch, 'objects');
  mkdirSync(objects);
  if (studioPacked(store)) {
    const code = 'STUDIO_SOURCE_PACK_UNAVAILABLE';
    // The reviewed pack's object IDs equal the pin's shallow reachable set.
    // Transfer only these two exact byte streams, never other pack/index data.
    requireThat(shallow && pack && /^pack-[0-9a-f]{40}$/.test(pack.stem), code);
    const target = path.join(objects, 'pack');
    mkdirSync(target);
    for (const [extension, size, digest] of [
      ['idx', pack.indexBytes, pack.indexSha256], ['pack', pack.packBytes, pack.packSha256],
    ]) {
      const name = pack.stem + '.' + extension;
      const file = studioPhysical(path.join(store.pack, name), 'file', code);
      requireThat(file.stat.size === size, code);
      const bytes = studioReadBytes(file, size, code);
      requireThat(bytes.length === size && createHash('sha256').update(bytes).digest('hex') === digest, code);
      writeFileSync(path.join(target, name), bytes, { flag: 'wx' });
    }
    return;
  }
  // For loose-only snapshots, traverse and transfer only objects named by
  // the verified pin; unrelated loose content is never enumerated or copied.
  const stage = studioLooseObjects(store.objects, scratch, {
    limit: 16 * studioMiB, total: 32 * studioMiB, capacity: 8192, budgetCode: studioClosureInvalid,
  });
  const stagedPin = studioCommit(stage('commit', pin, studioCommitUnavailable), studioCommitUnavailable);
  requireThat(stagedPin.tree === sourceTree, studioTreeMismatch);
  const pending = [['tree', sourceTree], ...(shallow ? [] : stagedPin.parents.map((oid) => ['commit', oid]))];
  for (let i = 0; i < pending.length; i++) {
    requireThat(pending.length <= 65_536, studioClosureInvalid);
    const [type, oid] = pending[i];
    const bytes = stage(type, oid, studioClosureInvalid);
    if (!bytes) continue;
    if (type === 'commit') {
      const commit = studioCommit(bytes, studioClosureInvalid);
      pending.push(['tree', commit.tree], ...commit.parents.map((parent) => ['commit', parent]));
    } else if (type === 'tree') {
      for (const entry of studioTreeEntries(bytes, studioClosureInvalid)) {
        requireThat(['40000', '100644', '100755', '120000'].includes(entry.mode), studioClosureInvalid);
        pending.push([entry.mode === '40000' ? 'tree' : 'blob', entry.oid]);
      }
    }
  }
}
// The optional policy is an in-process fixture seam, never a CLI input.
export function verifyStudioSource({ candidate, source }, policy = studioPolicy) {
  return withVerifiedStudioSource({ candidate, source }, policy, (proof) => proof);
}
function withVerifiedStudioSource({ candidate, source }, policy, run, requirePack = false) {
  const { e0, pin, sourceTree, modulesBlob, url } = policy;
  requireThat([e0, pin, sourceTree, modulesBlob].every(exactSha)
    && typeof url === 'string' && /^https:\/\/[^\s\x00-\x1f\x7f]+$/.test(url), 'STUDIO_SOURCE_POLICY_INVALID');
  const orange = studioRepo(candidate);
  const openfilm = studioRepo(source);
  requireThat(path.relative(orange.root, openfilm.root) !== '' && path.relative(orange.common, openfilm.common) !== '',
    'STUDIO_SOURCE_SAME_REPOSITORY');
  const head = studioHead(orange);
  requireThat(studioRead(path.join(orange.common, 'shallow'), studioStoreUnsafe, { optional: true }) === null, studioStoreUnsafe);
  const shallow = studioRead(path.join(openfilm.common, 'shallow'), studioStoreUnsafe, { optional: true });
  requireThat(shallow === null || shallow === pin + '\n', studioStoreUnsafe);
  const executable = studioGitExecutable();
  const tempRoot = realpathSync.native(tmpdir());
  requireThat(![orange.root, path.dirname(orange.common), openfilm.root, path.dirname(openfilm.common)]
    .some((root) => contained(root, tempRoot)), studioPathUnsafe);
  const scratch = mkdtempSync(path.join(tempRoot, 'orange-studio-e1-'));
  try {
    const candidateScratch = path.join(scratch, 'candidate.git');
    const candidateGit = studioGitStore(executable, candidateScratch, head);
    mkdirSync(path.join(candidateScratch, 'objects'));
    const orangeStore = studioObjectStore(orange.common);
    const stage = studioLooseObjects(orangeStore.objects, candidateScratch, {
      limit: studioMiB, total: 4 * studioMiB, capacity: 512, budgetCode: studioCandidateUnavailable,
      missingPackCode: studioPacked(orangeStore) ? studioCandidateUnavailable : undefined,
    });
    const read = (type, oid, code) => {
      stage(type, oid, code);
      return candidateGit(code, 'cat-file', type, oid);
    };
    const commit = (oid, code) => studioCommit(read('commit', oid, code), code);
    const reviewed = commit(e0, 'STUDIO_SOURCE_E0_MISSING');
    const current = head === e0 ? reviewed : commit(head, studioHeadInvalid);
    // Verify a bounded parent chain without opening any unrelated Orange blobs,
    // other refs, mixed packs, or ancestors of the reviewed boundary.
    const ancestry = 'STUDIO_SOURCE_ANCESTRY_MISMATCH';
    const commits = new Set(current.parents);
    if (head !== e0) {
      for (const parent of commits) {
        if (commits.has(e0)) break;
        requireThat(commits.size <= 512, studioCandidateUnavailable);
        const node = commit(parent, ancestry);
        for (const ancestor of node.parents) commits.add(ancestor);
      }
      requireThat(commits.has(e0), ancestry);
    }
    studioCandidateReferences(read, reviewed.tree, policy);
    if (current.tree !== reviewed.tree) studioCandidateReferences(read, current.tree, policy);

    const sourceScratch = path.join(scratch, 'source.git');
    const sourceGit = studioGitStore(executable, sourceScratch, pin, shallow);
    const store = studioObjectStore(openfilm.common);
    requireThat(!requirePack || studioPacked(store) && shallow === pin + '\n', 'STUDIO_SOURCE_PACK_UNAVAILABLE');
    studioSourceObjects(store, sourceScratch, policy, shallow);
    requireThat(text(sourceGit(studioCommitUnavailable, 'cat-file', '-t', pin)).trim() === 'commit', studioCommitUnavailable);
    const pinnedCommit = sourceGit(studioCommitUnavailable, 'cat-file', 'commit', pin);
    requireThat(studioCommit(pinnedCommit, studioCommitUnavailable).tree === sourceTree, studioTreeMismatch);
    sourceGit(studioClosureInvalid, 'fsck', '--strict', '--full', '--no-dangling', '--no-reflogs', pin);
    const modes = nulFields(sourceGit(studioClosureInvalid, 'ls-tree', '-r', '-z', '--format=%(objectmode)', sourceTree));
    requireThat(!modes.includes('160000'), studioClosureInvalid);
    requireThat(studioHead(orange) === head, studioHeadInvalid);
    const proof = {
      schemaVersion: 1, admitted: false, mode: studioMode, code: 'STUDIO_SOURCE_REFERENCE_VERIFIED',
      candidate: { e0, head, tree: current.tree, modulesBlob },
      sourceReference: { path: studioLink, url, commit: pin, tree: sourceTree, shallowAtPin: shallow !== null },
    };
    return run(proof, read, sourceGit);
  } finally {
    const target = studioPhysical(scratch, 'directory', studioPathUnsafe).path;
    requireThat(path.relative(tempRoot, path.dirname(target)) === ''
      && path.basename(target).startsWith('orange-studio-e1-'), studioPathUnsafe);
    rmSync(target, { recursive: true, force: true });
  }
}

// JSON.parse discards duplicate object keys. Reject those in v2 on the very
// same pinned bytes before parsing, including escaped spellings of one key.
function studioG4UniqueKeys(bytes) {
  const source = text(bytes), stack = [];
  for (let at = 0; at < source.length; at++) {
    const ch = source[at];
    if (ch === '{') stack.push(new Set());
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === '"') {
      const start = at++;
      while (at < source.length && source[at] !== '"') { if (source[at] === '\\') at++; at++; }
      const token = source.slice(start, at + 1);
      if (/^\s*:/.test(source.slice(at + 1))) {
        let key; try { key = JSON.parse(token); } catch { requireThat(false, 'G4_REVIEW_INVALID'); }
        const keys = stack.at(-1);
        requireThat(keys && !keys.has(key), 'G4_REVIEW_INVALID'); keys.add(key);
      }
    }
  }
}
function loadG4Review(file, { root, common, base, head, card, index, changes, studioSource }, extraRoots = []) {
  const pin = index.reviewApproval;
  requireThat(shape(pin, ['sha256', 'scopeKind', 'reviewerId', 'authors', 'evidencePath', 'evidenceSha256'])
    && digest(pin.sha256) && digest(pin.evidenceSha256) && ['task', 'integration'].includes(pin.scopeKind)
    && reviewerIdentity(pin.reviewerId) && Array.isArray(pin.authors) && pin.authors.length > 0
    && pin.authors.every(reviewerIdentity)
    && new Set(pin.authors.map(fold)).size === pin.authors.length, 'G4_REVIEW_UNTRUSTED');
  const roots = [root, common, ...extraRoots, ...index.cards.map(({ worktree }) => realpathSync.native(worktree))];
  const record = g2JSON(file, pin.sha256, roots, 'G4_REVIEW_UNTRUSTED', studioSource ? studioG4UniqueKeys : undefined);
  const { subject } = record ?? {};
  requireThat(shape(record, ['schemaVersion', 'subject', 'reviewerId', 'specs', 'quality', 'evidenceSha256'])
    && record.schemaVersion === (studioSource ? 2 : 1)
    && shape(subject, ['taskId', 'assignmentRevision', 'branch', 'base', 'head', 'tree', 'scopeKind', 'scopeSha256', 'inputsSha256', ...(studioSource ? ['lane'] : [])])
    && (!studioSource || subject.lane === 'studio-dual')
    && digest(subject.inputsSha256) && digest(record.evidenceSha256), 'G4_REVIEW_INVALID');
  const scopeSha256 = sha256(JSON.stringify([pin.scopeKind, [...changes].sort(), [...card.writeSet].sort()]));
  requireThat(subject.taskId === card.taskId && subject.assignmentRevision === card.assignmentRevision && subject.branch === card.branch
    && subject.base === base && subject.head === head && subject.tree === (studioSource ? studioSource.candidate.tree : text(git(root, 'rev-parse', head + '^{tree}')).trim())
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


const studioG4Continuations = new WeakSet();
const studioG4Domain = 'orange:studio-g4:closure:v2';
const studioG4Families = Object.freeze(['subject-scope', 'source-policy', 'source-ledger', 'source-notices',
  'c1-shared', 'c1-inputs', 'c1-packages', 'c1-auth', 'c1-studio', 'c2-inputs', 'c2-packages', 'c2-tools',
  'c2-outputs', 'c2-commands', 'c2-results', 'c2-contracts', 'c2-restore', 'c3-coverage', 'c3-fonts',
  'c3-tools-config', 'c3-database', 'c3-inventories', 'c3-results', 'execution-code']);
function studioG4Canonical(value) {
  const code = 'G4_INPUTS_UNAVAILABLE';
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { requireThat(Number.isFinite(value), code); return value; }
  if (Array.isArray(value)) return value.map(studioG4Canonical);
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, code);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, studioG4Canonical(value[key])]));
}
function studioG4Digest(families) {
  requireThat(shape(families, studioG4Families), 'G4_INPUTS_UNAVAILABLE');
  return sha256(studioG4Domain + '\n' + JSON.stringify(studioG4Families.map(role => [role, studioG4Canonical(families[role])])));
}
function studioG4Rows(rows, key = 'path') {
  requireThat(Array.isArray(rows) && rows.length > 0 && rows.every(row => typeof row?.[key] === 'string')
    && new Set(rows.map(row => fold(row[key]))).size === rows.length, 'G4_INPUTS_UNAVAILABLE');
  return rows.map(row => ({ ...row })).sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
}
// A path is assigned a role only after its exact producing root/tool has been
// physically verified. Never replace arbitrary substrings in untrusted argv.
function studioG4Packages(rows) {
  return studioG4Rows(rows.map(row => ({ ...row, identity: row.name + '\0' + row.version })), 'identity')
    .map(({ identity, ...row }) => row);
}
function studioG4CommandProjection(commands, roots, tools, toolPins, job) {
  const code = 'G4_INPUTS_UNAVAILABLE';
  const names = ['node-version', 'diff-check', 'desktop-types', ...['main', 'preload', 'renderer', 'studio']
    .map(mode => 'desktop-build-' + mode), 'studio-job-compile', ...g2WindowsStages(true, { studioSource: true }).map(row => row.id),
  'contracts-generated-check', 'contracts-ts-tap', 'dotnet-sdk-version', 'contracts-dotnet-restore', 'contracts-dotnet-test'];
  requireThat(commands.length === names.length && commands.every((row, i) => row.id === names[i]
    && row.exitCode === 0 && row.signal === null && !row.error), code);
  const locations = Object.entries(roots).map(([role, file]) => [role, g2Physical(file, 'dir', code)]);
  requireThat(locations.every(([role, file], i) => locations.every(([otherRole, other], j) =>
    i === j || differentRoots(file, other))), code);
  const pathRole = (file) => {
    for (const [role, actual] of Object.entries(tools)) if (file === actual) return { toolRole: role };
    requireThat(studioAbsolute(file), code);
    for (const [role, location] of locations) if (contained(location, file)) {
      const relative = path.relative(location, file).split(path.sep).join('/');
      if (relative) repositoryPath(relative);
      return { pathRole: role, relative };
    }
    requireThat(false, code);
  };
  const argument = (value) => {
    requireThat(typeof value === 'string', code);
    if (value.startsWith('/pathmap:')) {
      requireThat(value === '/pathmap:' + job.folder + '=C:/orange-studio-job', code);
      return ['/pathmap:', pathRole(job.folder), 'C:/orange-studio-job'];
    }
    const option = /^(core\.attributesFile=|-p:(?:ArtifactsPath|NuGetLockFilePath|CscToolPath)=|\/(?:out|reference):)(.*)$/.exec(value);
    if (option) return [option[1], pathRole(option[2])];
    if (studioAbsolute(value)) return pathRole(value);
    requireThat(!/[A-Za-z]:[\\/]/.test(value), code); return value;
  };
  return commands.map(row => {
    const roles = Object.keys(tools).filter(role => tools[role] === row.executable);
    requireThat(roles.length === 1 && digest(toolPins[roles[0]].sha256), code);
    return { id: row.id, tool: roles[0], toolSha256: toolPins[roles[0]].sha256,
      args: row.args.map(argument), cwd: pathRole(row.cwd), exitCode: 0 };
  });
}
function studioG4RawGuard(c3, report) {
  const code = 'G3_RAW_CHANGED';
  const owners = [...report.g3.secret.owners, ...report.g3.dependencies.owners];
  for (const owner of owners) {
    const cwd = g2Physical(owner.command.cwd, 'dir', code);
    let nativeBytes = 0;
    if (report.g3.dependencies.owners.includes(owner)) {
      const row = report.g3.dependencies;
      nativeBytes = verifyStudioG3Raw(row.raw, cwd, 'osv',
        { report: row.reportSha256, stdout: row.stdoutSha256, stderr: row.stderrSha256 });
    } else {
      const assigned = c3.entries.filter((_, ordinal) => ordinal % report.g3.secret.owners.length === owner.slot);
      const rows = assigned.map(entry => report.g3.secret.receipts.find(row => row.path === entry.path));
      rows.forEach((row, ordinal) => row.scans.forEach((scan, mode) => {
        nativeBytes += verifyStudioG3Raw(scan.raw, cwd, ordinal + (mode ? '-neutral' : '-original'),
          { report: scan.reportSha256, stdout: scan.stdoutSha256, stderr: scan.stderrSha256 });
      }));
    }
    let outputBytes = 0;
    for (const [file, expected] of [[owner.stdoutFile, owner.stdoutSha256], [owner.stderrFile, owner.stderrSha256]]) {
      const bytes = studioReadBytes(studioPhysical(file, 'file', code), 16 * studioMiB, code);
      requireThat(sha256(bytes) === expected, code); outputBytes += bytes.length;
    }
    requireThat(nativeBytes === owner.nativeBytes && nativeBytes + outputBytes === owner.ioBytes
      && nativeBytes + outputBytes <= 16 * studioMiB, code);
  }
}
function studioG4Projection(context, studio, c3) {
  requireThat(studioG4Continuations.has(c3), 'G4_INPUTS_UNAVAILABLE');
  return studioG4ProjectVerified(context, studio, c3);
}
// Pure stable projection; production calls only through the private branded continuation above.
function studioG4ProjectVerified(context, studio, c3) {
  const code = 'G4_INPUTS_UNAVAILABLE', { report, card, base, head, studioScope } = context;
  const { c2, inputs: c1, upstream, notices, studioSource } = studio, graph = report.rendererGraph;
  requireThat(studioScope?.length > 0 && c2.inputs instanceof Map && c2.deps.files instanceof Map
    && c3.audit && shape(c3.tools, ['gitleaks', 'osv']) && Object.values(c3.tools).every(value => typeof value === 'string' && value.length > 0)
    && c3.entries.length > 0 && graph.builds.length === 2
    && graph.builds.every((build, i) => build.track === ['auth', 'studio'][i]), code);
  const blobRow = (name, bytes) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes),
    oid: createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') });
  const sourceRows = studioG4Rows([...upstream].map(([name, bytes]) => blobRow(name, bytes)));
  requireThat(sourceRows.length === c1.profile.fixedUpstream.closure.length
    && sourceRows.every(row => c1.profile.fixedUpstream.closure.some(expected => expected.path === row.path
      && expected.oid === row.oid && expected.bytes === row.bytes && expected.sha256 === row.sha256)), code);
  const fileRows = map => studioG4Rows([...map].map(([name, row]) => ({ path: name, bytes: row.bytes, sha256: row.sha256 })));
  const cases = row => {
    requireThat(Array.isArray(row.cases) && row.cases.length === row.count && row.cases.every(value =>
      shape(value, ['id', 'outcome']) && value.outcome === 'Passed') && new Set(row.cases.map(value => value.id)).size === row.count, code);
    return row.cases;
  };
  const commands = studioG4CommandProjection(c2.execution.commands,
    { execution: c2.execution.executionRoot, output: c2.execution.outputRoot,
      feed: c2.plan.nugetFeed.path, dotnet: path.dirname(c2.tools.dotnet) }, c2.tools, c2.plan.tools, c2.job);
  const coverageIdentity = ({ path, bytes, sha256 }) => ({ path, bytes, sha256 });
  requireThat(isDeepStrictEqual(studioG4Rows(report.g3.secret.receipts.map(coverageIdentity)),
    studioG4Rows(c3.entries.map(coverageIdentity))) && report.g3.secret.receipts.every(row => row.scans.length === 2), code);
  const scanResults = report.g3.secret.receipts.map(row => ({ path: row.path, bytes: row.bytes, sha256: row.sha256,
    scans: row.scans.map((scan, i) => {
      const cwd = scan.command.cwd, owner = report.g3.secret.owners.find(value => value.command.cwd === cwd);
      const target = path.join(cwd, 'snapshot', row.path);
      const args = ['dir', i ? g3NeutralFile : target, '--config', path.join(cwd, 'gitleaks.toml'),
        '--gitleaks-ignore-path', path.join(cwd, 'empty-ignore'), '--ignore-gitleaks-allow', '--redact=100', '--no-banner',
        '--no-color', '--log-level', 'error', '--timeout', '60', '--report-format', 'json', '--report-path', path.join(cwd, 'native-report.json')];
      requireThat(owner && scan.command.executable === c3.tools.gitleaks && isDeepStrictEqual(scan.command.args, args)
        && scan.mode === (i ? 'neutral-content' : 'original-path') && scan.inputSha256 === row.sha256
        && scan.findings.length === 0 && scan.exitCode === 0, code);
      return { mode: scan.mode, inputSha256: scan.inputSha256, exitCode: 0, findings: [],
        command: { tool: 'gitleaks', args: ['dir', i ? 'neutral-content' : 'entry:' + row.path,
          ...args.slice(2).map(value => value === path.join(cwd, 'gitleaks.toml') ? 'config:gitleaks'
            : value === path.join(cwd, 'empty-ignore') ? 'ignore:empty'
              : value === path.join(cwd, 'native-report.json') ? 'report:native' : value)], cwd: 'slot' } };
    }) }));
  const audit = report.g3.dependencies, auditCwd = audit.command.cwd;
  const auditArgs = ['scan', 'source', '--offline', '--no-resolve', '--no-call-analysis=all',
    '--config', path.join(auditCwd, 'osv.toml'), '--format=json', '--all-packages', '--all-vulns',
    '--output-file', path.join(auditCwd, 'osv.json'), ...c3.audit.locks.flatMap(lock => ['--lockfile', lock.file])];
  requireThat(audit.command.executable === c3.tools.osv && audit.exitCode === 0 && audit.findings.length === 0
    && audit.owners.length === 1 && auditCwd === audit.owners[0].command.cwd && isDeepStrictEqual(audit.command.args, auditArgs), code);
  const auditSemantics = { tool: 'osv', cwd: 'audit-slot', args: ['scan', 'source', '--offline', '--no-resolve',
    '--no-call-analysis=all', '--config', 'config:osv', '--format=json', '--all-packages', '--all-vulns',
    '--output-file', 'report:native', ...c3.audit.locks.flatMap(lock => ['--lockfile', 'lock:' + lock.ecosystem])] };
  const electron = Object.fromEntries(['entry', 'exe'].map(role => {
    const file = c2.electron[role], relative = path.relative(c2.execution.executionRoot, file).split(path.sep).join('/');
    const row = c2.deps.files.get(relative); requireThat(row, code);
    return [role, { path: relative, bytes: row.bytes, sha256: row.sha256 }];
  }));
  const pins = ['parserSha256', 'profileSha256', 'packageManifestSha256', 'lockSha256', 'nodeSha256'];
  const shared = { ...Object.fromEntries(pins.map(role => [role,
    role === 'parserSha256' ? graph.staticProof.parserSha256 : graph[role]])), vite: graph.vite, tailwind: graph.tailwind,
  staticProof: { files: graph.staticProof.files, sha256: graph.staticProof.sha256 }, studioAssetReferences: graph.studioAssetReferences };
  requireThat(pins.every(role => digest(shared[role])), code);
  const sourcePolicy = { ...studioSource, pack: studioPolicy.pack,
    modules: { ...c3.entries.find(row => row.path === 'orange/.gitmodules'),
      oid: context.tree.get('.gitmodules').oid } };
  // These are content-stable, already verified inputs, not entire graph/TAP/TRX/control/report hashes.
  const families = {
    'subject-scope': { lane: 'studio-dual', taskId: card.taskId, assignmentRevision: card.assignmentRevision, branch: card.branch,
      base, head, tree: studioSource.candidate.tree, scopeKind: 'integration', commits: studioScope,
      changes: [...report.changedFiles].sort(), writeSet: [...card.writeSet].sort() },
    'source-policy': sourcePolicy, 'source-ledger': sourceRows.map(row => ({ ...row,
      active: c1.profile.fixedUpstream.closure.find(expected => expected.path === row.path).active })),
    'source-notices': studioG4Rows([...notices].map(([name, bytes]) => blobRow(name, bytes))),
    'c1-shared': shared, 'c1-inputs': studioG4Rows(c1.profile.inputs), 'c1-packages': c1.manifest,
    'c1-auth': { ...graph.builds[0], artifacts: studioG4Rows(graph.builds[0].artifacts, 'name') },
    'c1-studio': { ...graph.builds[1], artifacts: studioG4Rows(graph.builds[1].artifacts, 'name') },
    'c2-inputs': studioG4Rows([...c2.inputs].map(([name, bytes]) => blobRow(name, bytes))),
    'c2-packages': { files: fileRows(c2.deps.files), links: studioG4Rows([...c2.deps.links].map(([name, target]) => ({ path: name, target }))),
      identities: c2.deps.packages.map(pkg => ({ name: pkg.name, version: pkg.version, physical: pkg.physicalRootFromNodeModules,
        generated: pkg.generated })) },
    'c2-tools': { host: Object.fromEntries(Object.entries(c2.plan.tools).map(([role, ref]) => [role, { sha256: ref.sha256 }])),
      electron: { version: c2.electron.version, ...electron } },
    'c2-outputs': fileRows(c2.expectedBuild.expected), 'c2-commands': commands,
    'c2-results': { windows: g2WindowsStages(true, { studioSource: true }).map(({ id }, i) => ({ id,
      cases: cases([report.g2.windows.studio, report.g2.windows, report.g2.windows.authFixture, report.g2.windows.authService][i]) })),
      ts: cases(report.g2.contracts.ts), dotnet: cases(report.g2.contracts.dotnet) },
    'c2-contracts': { fixture: c2.fixture, freeze: report.g2.contracts.freeze, build: report.g2.build,
      nativeLock: { bytes: c3.audit.native.bytes.length, sha256: c3.audit.native.lockSha256,
        packages: studioG4Packages(c3.audit.native.packages) } },
    'c2-restore': { ...c2.restoreStable, feed: studioG4Rows(c2.plan.nugetFeed.files) },
    'c3-coverage': studioG4Rows(c3.entries), 'c3-fonts': studioG4Rows(c3.fonts),
    'c3-tools-config': { tools: Object.fromEntries(Object.entries(c3.plan.tools).map(([role, ref]) =>
      [role, { version: g3Tools[role].version, sha256: ref.sha256 }])), gitleaks: { bytes: Buffer.byteLength(g3GitleaksConfig),
      sha256: sha256(g3GitleaksConfig), ignoreEntries: [] }, osv: { bytes: 0, sha256: sha256('') } },
    'c3-database': { manifestSha256: c3.audit.database.manifestSha256,
      archives: studioG4Rows(c3.audit.database.archives, 'ecosystem') },
    'c3-inventories': { npm: studioG4Packages(c3.audit.npm), NuGet: studioG4Packages(c3.audit.native.packages) },
    'c3-results': { secret: studioG4Rows(scanResults), audit: { command: auditSemantics, exitCode: report.g3.dependencies.exitCode, findings: [],
      sources: studioG4Rows(report.g3.dependencies.sources.map(row => ({ ecosystem: row.ecosystem,
        path: row.path, packages: studioG4Packages(row.packages) })), 'ecosystem') } },
    'execution-code': { runner: Object.fromEntries(['check-candidate.mjs', 'check-admission.mjs', 'check-imports.mjs'].map(name =>
      [name, sha256(readFileSync(fileURLToPath(new URL('./' + name, import.meta.url))))])),
      worker: { runner: 'check-candidate.mjs', entry: '--studio-c3-scan-slot' }, node: c2.plan.tools.node.sha256,
      job: { source: sha256(studioG2JobSource), runtime: sha256(studioG2JobRuntime), pe: studioG2JobBinarySha,
        host: studioG2JobHost } },
  };
  return { schemaVersion: 2, domain: studioG4Domain, inputsSha256: studioG4Digest(families), families };
}
function studioG4RunEvidence(context, studio, c3, closure, review) {
  const { report, cardFile, indexFile } = context;
  const files = [['card', cardFile], ['index', indexFile], ['g2-plan', studio.c2.planFile], ['g3-plan', c3.planFile],
    ...(review ? [['review', review.file], ['review-evidence', context.index.reviewApproval.evidencePath]] : [])];
  const controls = files.map(([role, file]) => {
    const raw = studioReadBytes(studioPhysical(path.resolve(file), 'file', 'G4_REVIEW_STALE'), 2 * studioMiB, 'G4_REVIEW_STALE');
    return { role, file: path.resolve(file), bytes: raw.length, sha256: sha256(raw) };
  });
  const receipts = { schemaVersion: 1, subject: closure.families['subject-scope'], inputsSha256: closure.inputsSha256,
    reviewPin: review ? context.index.reviewApproval : null, controls, c2Commands: report.g2.commands.map(command => {
      const role = Object.keys(studio.c2.tools).find(role => studio.c2.tools[role] === command.executable);
      requireThat(role && digest(studio.c2.plan.tools[role].sha256), 'G4_INPUTS_UNAVAILABLE');
      return { ...command, toolSha256: studio.c2.plan.tools[role].sha256 };
    }),
    contracts: report.g2.contracts, secretOwners: report.g3.secret.owners, auditOwners: report.g3.dependencies.owners,
    secretReceipts: report.g3.secret.receipts, audit: report.g3.dependencies,
    deadline: report.g3.deadline };
  // This hashes only the separate receipt object, never the report containing it.
  return { ...receipts, receiptsSha256: sha256(JSON.stringify(receipts)) };
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
    const unavailable = code === 'GRAPH_PROFILE_UNAVAILABLE' || code === 'GRAPH_RUNTIME_UNAVAILABLE' || code === studioDualGraphRequired;
    Object.assign(check, { exitCode: unavailable ? null : 1, status: unavailable ? 'unavailable' : 'failed', code });
    throw error;
  }
}
function verifyCandidateBaseline(query, { baselineCommit, workingBaselineCommit, headCommit }) {
  const code = 'BASELINE_INVALID';
  try {
    for (const commit of [baselineCommit, workingBaselineCommit, headCommit]) {
      requireThat(text(query(code, 'cat-file', '-t', commit)).trim() === 'commit', code);
    }
    query(code, 'merge-base', '--is-ancestor', baselineCommit, workingBaselineCommit);
    query(code, 'merge-base', '--is-ancestor', workingBaselineCommit, headCommit);
  } catch {
    requireThat(false, code);
  }
}
function readCandidateTree(query, head) {
  const tree = new Map();
  for (const field of nulFields(query('GIT_FAILED', 'ls-tree', '-r', '-z', head))) {
    const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(field);
    requireThat(match, 'GIT_OUTPUT_INVALID');
    const [, mode, oid, name] = match;
    repositoryPath(name);
    requireThat(!tree.has(name), 'GIT_OUTPUT_INVALID');
    tree.set(name, { mode, oid });
  }
  return tree;
}
function linearCommits(query, base, head) {
  const log = text(query('GIT_FAILED', 'rev-list', '--first-parent', '--parents', base + '..' + head)).trim();
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
function rawChange(header) {
  const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([ADMT])$/.exec(header);
  requireThat(match, 'GIT_OUTPUT_INVALID');
  const [, oldMode, newMode, oldOid, newOid, status] = match;
  return { oldMode, newMode, oldOid, newOid, status };
}
function exactE0Addition(commit, change, mode, oid) {
  return commit === studioPolicy.e0 && change.oldMode === '000000' && /^0{40}$/.test(change.oldOid)
    && change.newMode === mode && change.newOid === oid && change.status === 'A';
}
const candidateProvenanceUnavailable = 'STUDIO_CANDIDATE_PROVENANCE_UNAVAILABLE';
const historyObjectArgs = ['rev-list', '--objects', '--no-object-names', '--filter=blob:none'];
function candidateHistoryObjects(bytes, head) {
  const ids = text(bytes).trimEnd().split(/\r?\n/);
  requireThat(ids[0] === head && ids.length <= 32_768 && ids.every(exactSha) && new Set(ids).size === ids.length,
    candidateProvenanceUnavailable);
  return ids;
}
function stageCandidateHistory(executable, root, repository, ids) {
  const code = candidateProvenanceUnavailable;
  const safeRoot = process.platform === 'win32' ? root.replaceAll('\\', '/') : root;
  const batch = spawnSync(executable, [
    '--no-pager', '--no-replace-objects', '--no-optional-locks',
    '-c', 'safe.directory=' + safeRoot, '-c', 'core.fsmonitor=false',
    '-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false', '-C', root, 'cat-file', '--batch',
  ], { cwd: repository, env: studioGitEnvironment(repository), input: ids.join('\n') + '\n',
    windowsHide: true, timeout: 30_000, maxBuffer: 16 * studioMiB });
  requireThat(batch.status === 0, code);
  const objects = path.join(repository, 'objects');
  mkdirSync(objects);
  const bytes = batch.stdout;
  let at = 0;
  for (const oid of ids) {
    const headerEnd = bytes.indexOf(10, at);
    requireThat(headerEnd > at && headerEnd - at <= 64, code);
    const match = /^([a-f0-9]{40}) (commit|tree) (0|[1-9][0-9]*)$/.exec(bytes.subarray(at, headerEnd).toString('latin1'));
    const length = Number(match?.[3]);
    const end = headerEnd + 1 + length;
    requireThat(match?.[1] === oid && Number.isSafeInteger(length) && end < bytes.length && bytes[end] === 10, code);
    const object = Buffer.concat([Buffer.from(match[2] + ' ' + length + '\0'), bytes.subarray(headerEnd + 1, end)]);
    requireThat(createHash('sha1').update(object).digest('hex') === oid, code);
    const prefix = path.join(objects, oid.slice(0, 2));
    mkdirSync(prefix, { recursive: true });
    writeFileSync(path.join(prefix, oid.slice(2)), deflateSync(object), { flag: 'wx' });
    at = end + 1;
  }
  requireThat(at === bytes.length, code);
}
function withCandidateHistory(root, common, head, run) {
  const code = candidateProvenanceUnavailable;
  let tempRoot, scratch, query;
  try {
    const gitDir = text(git(root, 'rev-parse', '--absolute-git-dir')).trimEnd();
    for (const directory of new Set([common, gitDir])) {
      absentG2Path(path.join(directory, 'shallow'), code);
      absentG2Path(path.join(directory, 'info', 'grafts'), code);
    }
    requireThat(text(git(root, 'rev-parse', '--is-shallow-repository')).trim() === 'false'
      && git(root, 'for-each-ref', '--format=%(refname)', 'refs/replace').length === 0, code);
    const ids = candidateHistoryObjects(git(root, '-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false',
      ...historyObjectArgs, head, '--'), head);
    // Use the installed Git selected by the existing trusted wrapper, not a
    // candidate executable or the candidate's Git environment.
    const execDir = text(git(root, '--exec-path')).trimEnd();
    requireThat(path.isAbsolute(execDir), code);
    const executable = realpathSync.native(path.join(execDir, process.platform === 'win32' ? 'git.exe' : 'git'));
    requireThat(![root, common].some((dir) => contained(dir, executable)) && lstatSync(executable).isFile(), code);
    tempRoot = realpathSync.native(tmpdir());
    requireThat(![root, path.dirname(common)].some((dir) => contained(dir, tempRoot)), code);
    scratch = mkdtempSync(path.join(tempRoot, 'orange-candidate-history-'));
    const repository = path.join(scratch, 'history.git');
    query = studioGitStore(executable, repository, head);
    stageCandidateHistory(executable, root, repository, ids);
    const isolated = candidateHistoryObjects(query(code, ...historyObjectArgs, head, '--'), head);
    requireThat(isolated.length === ids.length && isDeepStrictEqual(new Set(isolated), new Set(ids)), code);
  } catch (error) {
    if (scratch) removeCandidateHistory(tempRoot, scratch);
    requireThat(false, code);
  }
  try {
    // Do not expose the private path to a generic Git helper. Every consumer
    // must use the original executable and environment bound to this query.
    return run(query);
  } finally {
    removeCandidateHistory(tempRoot, scratch);
  }
}
function removeCandidateHistory(tempRoot, scratch) {
  const code = candidateProvenanceUnavailable;
  const target = studioPhysical(scratch, 'directory', code).path;
  requireThat(path.relative(tempRoot, path.dirname(target)) === '' && path.basename(target).startsWith('orange-candidate-history-'), code);
  rmSync(target, { recursive: true, force: true });
}
function studioCandidateSubject(query, head) {
  // Inspect every authenticated parent edge, including merges outside the
  // task's selected range. A late base cannot hide a restored reference.
  const fields = nulFields(query(candidateProvenanceUnavailable,
    'log', '--format=%H', '--raw', '-z', '--root', '--full-history', '--diff-merges=separate',
    '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-show-signature',
    '--no-notes', '--no-decorate', '--no-color', '--ignore-submodules=none', head, '--'));
  requireThat(fields[0] === head, candidateProvenanceUnavailable);
  let commit;
  let inherited = false;
  let links = 0;
  let modules = 0;
  let invalidReference = false;
  let unsafeHistoryPath = false;
  for (let i = 0; i < fields.length;) {
    const field = fields[i++];
    if (exactSha(field)) {
      commit = field;
      inherited ||= commit === studioPolicy.e0;
      continue;
    }
    requireThat(commit && i < fields.length, 'GIT_OUTPUT_INVALID');
    const change = rawChange(field.replace(/^\n/, ''));
    const name = fields[i++];
    const canonical = fold(name);
    try {
      repositoryPath(name);
    } catch {
      unsafeHistoryPath = true;
    }
    if (change.oldMode === '160000' || change.newMode === '160000') {
      links++;
      invalidReference ||= name !== studioLink || !exactE0Addition(commit, change, '160000', studioPolicy.pin);
    } else if (canonical === studioLink || canonical.startsWith(studioLink + '/')) {
      // No aliases or regular-file substitutes in the exact reference's
      // namespace. Historical ordinary vendor source stays valid on legacy.
      invalidReference = true;
    }
    if (canonical === '.gitmodules' || canonical.startsWith('.gitmodules/')) {
      modules++;
      invalidReference ||= name !== '.gitmodules' || !exactE0Addition(commit, change, '100644', studioPolicy.modulesBlob);
    }
  }
  if (!inherited) {
    requireThat(links === 0, 'UNSAFE_GIT_MODE');
    requireThat(modules === 0, 'STUDIO_CANDIDATE_ANCESTRY_MISMATCH');
    return false;
  }
  requireThat(!invalidReference && !unsafeHistoryPath && links === 1 && modules === 1, 'STUDIO_REFERENCE_HISTORY_INVALID');
  return true;
}
function verifyStudioCandidate(root, common, head, tree, source, requirePack = false) {
  requireThat(source, 'STUDIO_SOURCE_REQUIRED');
  requireThat(studioAbsolute(source) && differentRoots(root, path.resolve(source)) && differentRoots(common, path.resolve(source)),
    studioPathUnsafe);
  const proof = withVerifiedStudioSource({ candidate: root, source }, studioPolicy, (sourceProof) => sourceProof, requirePack);
  requireThat(proof.candidate.head === head && proof.candidate.tree === tree, 'STUDIO_SOURCE_SUBJECT_MISMATCH');
  return proof;
}
function studioRendererObject(bytes, row, code) {
  requireThat(bytes.length === row.bytes && createHash('sha256').update(bytes).digest('hex') === row.sha256
    && createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') === row.oid, code);
  return bytes;
}
function studioRendererProjection(root, tree, source, prior, profile) {
  return withVerifiedStudioSource({ candidate: root, source }, studioPolicy, (proof, read, sourceGit) => {
    requireThat(isDeepStrictEqual(proof, prior), 'STUDIO_C1_SOURCE_MISMATCH');
    const { path: link, mode, head, tree: upstreamTree, closure } = profile.fixedUpstream;
    requireThat(tree.get(link)?.mode === mode && tree.get(link)?.oid === head
      && tree.get('.gitmodules')?.oid === proof.candidate.modulesBlob, 'STUDIO_C1_SOURCE_MISMATCH');
    const orange = new Map();
    const orangeCode = 'STUDIO_C1_SUBJECT_MISMATCH';
    for (const row of profile.inputs) {
      const entry = tree.get(row.path);
      requireThat(entry?.mode === '100644' && entry.oid === row.oid, orangeCode);
      const bytes = studioRendererObject(read('blob', row.oid, orangeCode), row, orangeCode);
      if (row.buildInput) orange.set(row.path, bytes);
    }
    const sourceCode = 'STUDIO_C1_SOURCE_MISMATCH';
    const actualTree = new Map(nulFields(sourceGit(sourceCode, 'ls-tree', '-r', '-z', upstreamTree)).map((entry) => {
      const match = /^(\d{6}) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
      requireThat(match, sourceCode);
      return [match[3], { mode: match[1], oid: match[2] }];
    }));
    for (const row of closure) {
      const entry = actualTree.get(row.path);
      requireThat(entry?.mode === '100644' && entry.oid === row.oid, sourceCode);
    }
    const raw = sourceGit.batchBlobs(sourceCode, closure.map(({ oid }) => oid));
    const upstream = new Map();
    let offset = 0;
    for (const row of closure) {
      const header = Buffer.from(row.oid + ' blob ' + row.bytes + '\n');
      const from = offset + header.length;
      const to = from + row.bytes;
      requireThat(raw.subarray(offset, from).equals(header) && raw[to] === 10, sourceCode);
      upstream.set(row.path, studioRendererObject(raw.subarray(from, to), row, sourceCode));
      offset = to + 1;
    }
    requireThat(offset === raw.length, sourceCode);
    return { orange, upstream };
  }, true);
}
function changedPaths(query, commits, studioSource, ledger) {
  const paths = new Set();
  for (const [parent, commit] of commits) {
    const rows = [];
    const fields = nulFields(query('GIT_FAILED', 'diff-tree', '--raw', '-r', '-z', '--no-renames',
      '--no-ext-diff', '--no-textconv', '--no-abbrev', '--ignore-submodules=none', parent, commit, '--'));
    requireThat(fields.length % 2 === 0, 'GIT_OUTPUT_INVALID');
    for (let i = 0; i < fields.length; i += 2) {
      const change = rawChange(fields[i]);
      const name = fields[i + 1];
      requireThat([change.oldMode, change.newMode].every((mode) => mode === '000000' || regularModes.has(mode))
        || (studioSource && name === studioLink && exactE0Addition(commit, change, '160000', studioPolicy.pin)),
      'UNSAFE_GIT_MODE');
      repositoryPath(name);
      paths.add(name); rows.push({ path: name, ...change });
    }
    ledger?.push({ parent, commit, changes: rows });
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
function verifyCheckout(root, tree, outputs = [], studioSource) {
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
    if (studioSource && name === studioLink && mode === '160000' && oid === studioPolicy.pin) {
      // Inspect only the canonical stub itself, never follow a link, traverse
      // children, or ask Git to interpret local submodule metadata.
      const vendor = studioPhysical(path.join(root, 'vendor'), 'directory', 'WORKTREE_LINK', true);
      const stub = vendor && studioPhysical(path.join(vendor.path, 'openfilm'), 'directory', 'WORKTREE_LINK', true);
      if (stub) add(name, true);
      continue;
    }
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
    requireThat(size === blob.length && createHash('sha1').update('blob ' + blob.length + '\0').update(blob).digest('hex') === oid
      && readFileSync(path.join(root, name)).equals(blob), 'WORKTREE_DIRTY');
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
const studioG2Inputs = [
  'apps/desktop/renderer/features/creation/StudioProbe.tsx', 'packages/film-adapter/package.json',
  'packages/film-adapter/src/node.ts', 'packages/film-adapter/src/renderer.tsx',
  'tests/windows/studio-smoke.test.mjs', 'docs/evidence/film-upstream.md',
];
const studioG2Lock = '310ba40fbad44925b503b8d850798f691b416b6427c08c7e18cf7a388c759f90';
const studioG2Dist = 'apps/desktop/dist/';
const studioG2BuildLeaves = ['main/build-identity.json', 'main/index.js', 'preload/index.cjs', 'studio/studio-build.json'];
const studioG2Ledger = 'ceeec16d948e301de54a8a06e2d1faa050291777833b49cd9b7edfbbc077d9d6';
const studioG2NonModules = ['packages/openfilm/src/film-doc.d.mts', 'packages/openfilm/studio/ui/src/i18n/words.ts'];
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
function studioG2Graph(graph, studioSource, base, head) {
  requireThat(graph?.mode === 'studio-c1-dual-renderer' && graph.base === base && graph.head === head
    && studioSource.candidate.head === head && graph.tree === studioSource.candidate.tree
    && studioSource.sourceReference.commit === studioPolicy.pin && graph.source?.commit === studioPolicy.pin
    && studioSource.sourceReference.tree === studioPolicy.sourceTree && graph.source.tree === studioPolicy.sourceTree
    && graph.source.objects === 235 && isDeepStrictEqual(graph.source.pack, studioPolicy.pack)
    && graph.lockSha256 === studioG2Lock
    && ['inputSha256', 'artifactSha256', 'profileSha256', 'packageManifestSha256'].every((name) => digest(graph[name]))
    && Array.isArray(graph.builds) && graph.builds.length === 2
    && graph.builds.every((lane, i) => lane?.track === (i === 0 ? 'auth' : 'studio') && digest(lane.graphSha256)
      && isDeepStrictEqual(lane.reactRoots, { react: 1, 'react-dom': 1 })
      && Array.isArray(lane.artifacts) && lane.artifacts.length === (i === 0 ? 3 : 10)),
  'STUDIO_C2_GRAPH_MISMATCH');
  return graph;
}
export function g2InputNamesFor(tree, graph, base, head, root, { studioSource } = {}) {
  if (studioSource) {
    studioG2Graph(graph, studioSource, base, head);
    const names = new Set([...g2InputNames, ...authG2Inputs, ...studioG2Inputs]);
    requireThat([...names].every((name) => tree.get(name)?.mode === '100644'), 'G2_INPUT_UNTRUSTED');
    return names;
  }
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
function g2JSON(file, expected, externalTo, code, inspect) {
  const physical = g2Physical(file, 'file', code);
  requireThat(externalTo.every((root) => !contained(root, physical)) && digest(expected), code);
  requireThat(lstatSync(physical).size <= 2 * 1024 * 1024, code);
  const bytes = readFileSync(physical);
  requireThat(sha256(bytes) === expected, code);
  inspect?.(bytes);
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
  const { root, card, index, base, head, studio, report } = context;
  const plan = g2JSON(file, index.g2PlanSha256, studio ? studio.protectedRoots : [root], 'G2_PLAN_UNTRUSTED');
  requireThat(shape(plan, ['schemaVersion', 'taskId', 'assignmentRevision', 'base', 'head', 'tree',
    'executionRoot', 'outputRoot', 'validUntil', 'desktopLease', 'executableInputs', 'installedPackages', 'nugetFeed', 'tools',
    ...(studio ? ['studio'] : [])])
    && plan.schemaVersion === (studio ? 2 : 1) && exactSha(plan.tree)
    && shape(plan.desktopLease, ['id', 'holder', 'validUntil']) && identity(plan.desktopLease.id)
    && plan.desktopLease.holder === card.taskId
    && shape(plan.executableInputs, ['path', 'sha256']) && digest(plan.executableInputs.sha256)
    && shape(plan.installedPackages, ['path', 'sha256', 'sourceRoot']) && digest(plan.installedPackages.sha256)
    && shape(plan.nugetFeed, ['path', 'files']) && Array.isArray(plan.nugetFeed.files)
    && shape(plan.tools, ['node', 'git', 'dotnet', 'csc', 'cmd', 'taskkill'])
    && Object.values(plan.tools).every((item) => shape(item, ['path', 'sha256']) && digest(item.sha256))
    && (!studio || shape(plan.studio, ['rendererGraphSha256', 'buildOutputs']) && digest(plan.studio.rendererGraphSha256)
      && shape(plan.studio.buildOutputs, ['path', 'sha256']) && digest(plan.studio.buildOutputs.sha256)),
  'G2_PLAN_INVALID');
  requireThat(plan.taskId === card.taskId && plan.assignmentRevision === card.assignmentRevision
    && plan.base === base && plan.head === head && text(git(root, 'rev-parse', head + '^{tree}')).trim() === plan.tree,
  'G2_PLAN_STALE');
  const expires = g2Deadline(plan.validUntil, Date.parse(index.validUntil), 'G2_PLAN_EXPIRED');
  if (studio) {
    const graph = studioG2Graph(report.rendererGraph, studio.studioSource, base, head);
    requireThat(sha256(JSON.stringify(graph)) === plan.studio.rendererGraphSha256, 'STUDIO_C2_GRAPH_MISMATCH');
  }
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
export function verifyG2InputSet(tree, entries, names, { studioSource } = {}) {
  requireThat(Array.isArray(entries) && entries.length === names.size, 'G2_INPUT_UNTRUSTED');
  const seen = new Set();
  for (const entry of entries) {
    requireThat(validG2Entry(entry) && names.has(entry.path) && !seen.has(entry.path) && tree.has(entry.path), 'G2_INPUT_UNTRUSTED');
    seen.add(entry.path);
  }
  for (const name of tree.keys()) {
    requireThat(seen.has(name)
      || (!/^(?:apps\/desktop|packages\/contracts|tests\/(?:windows|contracts)|tools\/contracts)\//i.test(name)
        && !(studioSource && /^packages\/film-adapter\//i.test(name))
        && !name.split('/').some((part) => injectedName.test(part) || fold(part) === 'node_modules')), 'G2_INPUT_UNREVIEWED');
  }
}
function verifyG2Inputs(root, tree, plan, protectedRoots, names, studio) {
  const manifest = g2JSON(plan.executableInputs.path, plan.executableInputs.sha256, protectedRoots, 'G2_INPUT_UNTRUSTED');
  requireThat(manifest?.type === 'controller-reviewed-G2-executable-inputs' && manifest.schemaVersion === 1
    && manifest.candidate === plan.head && exactSha(manifest.approvedSource)
    && (!studio || shape(manifest, ['type', 'schemaVersion', 'base', 'tree', 'approvedSource', 'candidate', 'entries'])
      && manifest.base === plan.base && manifest.tree === plan.tree && manifest.approvedSource === plan.head),
  'G2_INPUT_UNTRUSTED');
  verifyG2InputSet(tree, manifest.entries, names, studio);
  const reviewed = new Map();
  for (const entry of manifest.entries) {
    checkWorktreePath(root, entry.path, 'present');
    const bytes = readFileSync(path.join(root, entry.path));
    requireThat(bytes.length === entry.bytes && sha256(bytes) === entry.sha256
      && (!studio || createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
        === tree.get(entry.path).oid), 'G2_INPUT_MISMATCH');
    reviewed.set(entry.path, bytes);
  }
  verifyG2Ancestors(root, studio);
  return reviewed;
}
function verifyG2Ancestors(root, studio) {
  for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
    for (const name of studio ? [...ancestorInputs, '.env.studio', '.env.studio.local'] : ancestorInputs) {
      absentG2Path(path.join(dir, name), 'G2_ANCESTOR_CONFIG');
    }
    if (dir === path.dirname(dir)) break;
  }
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
const studioG2PackageSha = '0d32df0c0ec6c2a62eae8e038671baaf4692ae318591cf05eeb317563d2c7e46';
const studioG2Links = new Map([
  ['apps/desktop/node_modules/@orange/film-adapter', 'packages/film-adapter'],
  ['node_modules/.pnpm/node_modules/@orange/film-adapter', 'packages/film-adapter'],
  ['packages/film-adapter/node_modules/@types/react', 'node_modules/.pnpm/@types+react@19.3.0/node_modules/@types/react'],
  ['packages/film-adapter/node_modules/react', 'node_modules/.pnpm/react@19.3.1/node_modules/react'],
]);
function materializeG2Packages(root, plan, inputs, protectedRoots, studio) {
  const code = 'G2_PACKAGE_UNTRUSTED';
  const ref = plan.installedPackages;
  const donor = g2Physical(ref.sourceRoot, 'dir', code);
  requireThat(protectedRoots.every((other) => differentRoots(other, donor)), code);
  const manifest = g2JSON(ref.path, ref.sha256, protectedRoots, code);
  requireThat(manifest?.schemaVersion === 1 && manifest.type === (studio ? 'studio-c2-unapproved-offline-package-inputs'
    : 'controller-approved-installed-public-package-closure')
    && manifest.sourceLockSha256 === sha256(inputs.get('pnpm-lock.yaml'))
    && (!studio || ref.sha256 === studioG2PackageSha && manifest.sourceLockSha256 === studioG2Lock)
    && Array.isArray(manifest.packages) && manifest.packages.length === (studio ? 54 : 36)
    && Array.isArray(manifest.links) && manifest.links.length === (studio ? 131 : 82), code);
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
    const adapterTarget = studio && studioG2Links.get(link.path);
    const adapterLink = adapterTarget && link.target === adapterTarget
      && (adapterTarget === 'packages/film-adapter' || packages.has(adapterTarget));
    requireThat(shape(link, ['path', 'target']) && typeof link.path === 'string'
      && !link.path.split('/').some((segment) => fold(segment) === '.bin')
      && !links.has(link.path) && !files.has(link.path)
      && (adapterLink || (!adapterTarget
        && /^(?:node_modules\/(?:\.pnpm\/(?:[^/]+\/)?node_modules\/)?|apps\/desktop\/node_modules\/)(?:@[^/]+\/)?[^/]+$/.test(link.path)
        && (packages.has(link.target) || (link.target === 'packages/contracts'
        && /^(?:apps\/desktop\/node_modules|node_modules\/\.pnpm\/node_modules)\/@orange\/contracts$/.test(link.path))
        || (link.target === 'apps/desktop' && link.path === 'node_modules/.pnpm/node_modules/@orange/desktop')))),
    code);
    repositoryPath(link.path);
    links.set(link.path, link.target);
  }
  rejectAliases([...files.keys(), ...links.keys()]);
  const total = [...files.values()].reduce((bytes, entry) => bytes + entry.bytes, 0);
  requireThat((studio ? files.size === 5162 && total === 520110284
    && [...studioG2Links].every(([name, target]) => links.get(name) === target)
    : files.size === 1187 && total <= 600 * 1024 * 1024)
    && [...files.keys(), ...packages.keys(), ...links.keys()].every((name) => !name.split('/').slice(0, -1)
      .some((_, i, parts) => links.has(parts.slice(0, i + 1).join('/')))), code);
  for (const [name, entry] of files) {
    const source = g2Physical(path.join(donor, name), 'file', code, Boolean(studio));
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
  return { files, links, ...(studio && { packages: manifest.packages }) };
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
function studioG2OutputFiles(graph, files) {
  const code = 'G2_BUILD_OUTPUT_INVALID';
  const independent = new Map(graph.builds.flatMap((lane) => lane.artifacts.map((item) =>
    [(lane.track === 'auth' ? 'renderer/' : 'studio/') + item.name, item])));
  requireThat(independent.size === 13 && Array.isArray(files) && files.length === 17, code);
  const expected = new Map();
  for (const { name, bytes, sha256: hash } of files) {
    const artifact = independent.get(name);
    requireThat(validG2Entry({ path: name, bytes, sha256: hash }) && !expected.has(name)
      && (artifact ? bytes === artifact.bytes && hash === artifact.sha256 : studioG2BuildLeaves.includes(name)), code);
    repositoryPath(name);
    expected.set(studioG2Dist + name, { bytes, sha256: hash });
  }
  return expected;
}
function verifyStudioG2Dist(root, expected) {
  const code = 'G2_BUILD_OUTPUT_INVALID';
  const base = path.join(root, studioG2Dist);
  const dirs = new Map();
  for (const name of expected.keys()) {
    for (let current = name; current !== studioG2Dist.slice(0, -1); current = path.posix.dirname(current)) {
      const parent = path.posix.dirname(current);
      if (!dirs.has(parent)) dirs.set(parent, new Set());
      dirs.get(parent).add(path.posix.basename(current));
    }
  }
  for (const [dir, children] of [...dirs].sort(([a], [b]) => a.length - b.length)) {
    const actual = readdirSync(g2Physical(path.join(root, dir), 'dir', code));
    requireThat(actual.length === children.size && actual.every((name) => children.has(name)), code);
  }
  for (const [name, item] of expected) {
    const bytes = readFileSync(g2Physical(path.join(root, name), 'file', code));
    requireThat(bytes.length === item.bytes && sha256(bytes) === item.sha256, code);
  }
  return JSON.parse(text(readFileSync(path.join(base, 'studio/studio-build.json'))));
}
function studioG2ExpectedBuild(plan, graph, protectedRoots) {
  const code = 'G2_BUILD_OUTPUT_INVALID';
  const { path: file, sha256: hash } = plan.studio.buildOutputs;
  const manifest = g2JSON(file, hash, protectedRoots, code);
  requireThat(shape(manifest, ['type', 'schemaVersion', 'base', 'head', 'tree', 'files'])
    && manifest.type === 'controller-reviewed-Studio-C2-build-outputs' && manifest.schemaVersion === 1
    && manifest.base === plan.base && manifest.head === plan.head && manifest.tree === plan.tree, code);
  return { files: manifest.files, expected: studioG2OutputFiles(graph, manifest.files) };
}
function materializeStudioG2Source(root, upstream) {
  const code = 'STUDIO_C2_SOURCE_MISMATCH';
  requireThat(upstream.size === 235, code);
  const files = new Map();
  for (const [name, bytes] of upstream) {
    repositoryPath(name);
    requireThat(name.startsWith('packages/openfilm/'), code);
    const dest = '.orange-local/studio-src-' + studioPolicy.pin.slice(0, 7) + '/' + name;
    const file = path.join(root, dest);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes, { flag: 'wx' });
    files.set(dest, { bytes: bytes.length, sha256: sha256(bytes) });
  }
  return files;
}
function verifyStudioG2Layout(root, tree, marker, { files, links } = {}, source, outputs, scratch = [], optionalStub = false) {
  const code = 'WORKTREE_DIRTY';
  const dirs = new Map([['', new Set()]]);
  const leaves = new Map();
  const add = (name, item) => {
    const parts = name === '.git' ? [name] : repositoryPath(name);
    let parent = '';
    for (const [i, part] of parts.entries()) {
      requireThat(dirs.has(parent), code);
      dirs.get(parent).add(part);
      parent += (parent ? '/' : '') + part;
      if (!item || i < parts.length - 1) {
        requireThat(!leaves.has(parent), code);
        if (!dirs.has(parent)) dirs.set(parent, new Set());
      }
    }
    if (item) {
      requireThat(!leaves.has(name) && !dirs.has(name), code);
      leaves.set(name, item);
    }
  };
  add('.git', { sha256: marker });
  for (const [name, { mode, oid }] of tree) {
    if (name === studioLink && mode === '160000' && oid === studioPolicy.pin) {
      if (!optionalStub || lstatSync(path.join(root, name), { throwIfNoEntry: false })) add(name);
    } else {
      requireThat(regularModes.has(mode), 'UNSAFE_GIT_MODE');
      add(name, { oid, mode });
    }
  }
  for (const group of [files, source, outputs]) if (group) for (const [name, row] of group) add(name, row);
  if (links) for (const [name, target] of links) add(name, { target });
  const observedScratch = scratch.filter((name) => lstatSync(path.join(root, name), { throwIfNoEntry: false }));
  for (const name of observedScratch) add(name);
  // Parent dirs are inserted before children. Check the full physical directory
  // shape (including every empty directory) before opening any file.
  for (const [name, children] of dirs) {
    const dir = g2Physical(path.join(root, name), 'dir', code);
    const actual = readdirSync(dir);
    requireThat(actual.length === children.size && actual.every((child) => children.has(child)), code);
  }
  for (const [name, item] of leaves) {
    const file = path.join(root, name);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (item.target) {
      const target = path.join(root, item.target);
      requireThat(dirs.has(item.target) && stat?.isSymbolicLink()
        && path.relative(path.resolve(path.dirname(file), readlinkSync(file).replace(/^\\\\\?\\/, '')), target) === ''
        && path.relative(realpathSync.native(file), target) === '', code);
      continue;
    }
    requireThat(stat?.isFile() && stat.nlink === 1 && (item.bytes === undefined || stat.size === item.bytes)
      && (!item.mode || process.platform === 'win32' || Boolean(stat.mode & 0o111) === (item.mode === '100755')), code);
    const bytes = studioReadBytes({ path: file, stat }, item.bytes ?? 4 * studioMiB, code);
    requireThat(item.oid ? createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') === item.oid
      : sha256(bytes) === item.sha256, code);
  }
  return { directories: dirs.size, leaves: leaves.size, observedScratch };
}
const studioG2Electron = 'node_modules/.pnpm/electron@45.2.3/node_modules/electron';
function verifyStudioG2Electron(root) {
  const code = 'G2_PACKAGE_UNTRUSTED';
  const entry = g2Physical(path.join(root, studioG2Electron, 'index.js'), 'file', code);
  const exe = g2Physical(path.join(root, studioG2Electron, 'dist/electron.exe'), 'file', code);
  const require = createRequire(path.join(root, 'apps/desktop/package.json'));
  requireThat(path.relative(require.resolve('electron'), entry) === ''
    && readFileSync(path.join(root, studioG2Electron, 'path.txt'), 'utf8') === 'electron.exe'
    && sha256(readFileSync(exe)) === '15e815a2d04aed1a01787354b93cd2cab425f339b3beaef4f9e4193647f5399b', code);
  return { entry, exe, version: '45.2.3' };
}
export function g2BuildOutputs(root, head, auth = false, studio) {
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
  if (studio?.studioSource) {
    const { studioSource, rendererGraph, files, sourcePaths } = studio;
    studioG2Graph(rendererGraph, studioSource, rendererGraph?.base, head);
    const expected = studioG2OutputFiles(rendererGraph, files);
    const receipt = verifyStudioG2Dist(root, expected);
    const { source } = receipt;
    requireThat(Array.isArray(sourcePaths) && sourcePaths.length === 235 && new Set(sourcePaths).size === 235
      && studioG2NonModules.every((name) => sourcePaths.includes(name)), code);
    const modulePaths = sourcePaths.filter((name) => !studioG2NonModules.includes(name)).sort();
    requireThat(source?.pin === studioPolicy.pin && source.ledgerSha256 === studioG2Ledger && source.files === 235
      && modulePaths.length === 233 && isDeepStrictEqual(source.modulePaths, modulePaths)
      && isDeepStrictEqual(source.nonModules, studioG2NonModules)
      && isDeepStrictEqual(receipt.artifacts, rendererGraph.builds[1].artifacts), code);
    return { build, outputs: new Map([...expected].map(([name, item]) => [name, item.sha256])) };
  }
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
export function g2WindowsStages(auth, { studioSource } = {}) {
  const node = ['--test', '--test-reporter=tap'];
  const shell = 'tests/windows/shell-smoke.test.mjs';
  const filter = (names) => '--test-name-pattern=^(?:' + names.map((name) => name.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&')).join('|') + ')$';
  return [...(studioSource ? [{ id: 'windows-studio-tap', args: [...node, 'tests/windows/studio-smoke.test.mjs'], expected: [
    'Studio Node adapter rejects untrusted, malformed, modified, extra and linked build inputs',
    'Windows real compiled Orange hosts Studio only in the native fixture; network and teardown are fail-closed',
  ] }] : []), { id: 'windows-tap', args: [...node, ...(auth ? [filter(windowsTests)] : []), shell], expected: [...windowsTests] },
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
export function verifyG2Tap(bytes, expected, project = false) {
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
  return { count, sha256: sha256(bytes), ...(project && { bytes: bytes.length, cases: expected.map(id => ({ id, outcome: 'Passed' })) }) };
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
export function verifyG2Trx(bytes, expected, started, ended, project = false) {
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
  return { count, sha256: sha256(bytes), ...(project && { bytes: bytes.length, cases: expected.map(id => ({ id, outcome: 'Passed' })) }) };
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
// This fixed source is built offline by the pinned SDK, never supplied by a candidate.
// The kernel owns the tree before any test instruction can execute. No PID-based cleanup.
const studioG2JobSource = String.raw`
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

internal static class StudioJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Limits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long UserTime, KernelTime, ThisUserTime, ThisKernelTime;
        public uint PageFaults, Processes, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Startup {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort Show, ReservedLength;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupExtended { public Startup Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint Pid, Tid;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits value, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting value, uint length, IntPtr resultLength);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr value, uint length, out uint resultLength);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr copy,
        uint access, bool inherit, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateJobObject(IntPtr job, uint status);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint status);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr GetStdHandle(int role);
    [DllImport("kernel32.dll")]
    static extern void Sleep(uint ms);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern bool CreateProcessW(string app, StringBuilder command, IntPtr procAttrs, IntPtr threadAttrs,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupExtended startup, out ProcessInfo process);
    static void Require(bool result) {
        if (!result) throw new InvalidOperationException();
    }
    static uint Active(IntPtr job) {
        Require(QueryInformationJobObject(job, 1, out Accounting value,
            (uint) Marshal.SizeOf<Accounting>(), IntPtr.Zero));
        return value.Active;
    }
    static string Why(string[] args, int controls, long until) {
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= until) return "deadline";
        try {
            for (int i = 0; i < controls; i++) {
                string file = args[3 + 2 * i], expected = args[4 + 2 * i];
                if (new FileInfo(file).Length > 2097152 ||
                    !string.Equals(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))), expected,
                        StringComparison.OrdinalIgnoreCase)) return "control-drift";
            }
        } catch { return "control-drift"; }
        return null;
    }
    // CRT command-line quoting; no shell and no word splitting by metacharacters.
    static void Quote(StringBuilder line, string value) {
        line.Append('"');
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            line.Append('\\', ch == '"' ? 2 * slashes + 1 : slashes);
            slashes = 0;
            line.Append(ch);
        }
        line.Append('\\', 2 * slashes).Append('"');
    }
    static ProcessInfo CreateOwned(IntPtr job, string node, StringBuilder line) {
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobValue = IntPtr.Zero;
        bool initialized = false;
        var stdio = new IntPtr[3];
        try {
            IntPtr bytes = IntPtr.Zero;
            Require(!InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes) &&
                Marshal.GetLastWin32Error() == 122 && bytes.ToInt64() > 0);
            attributes = Marshal.AllocHGlobal(bytes);
            Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes));
            initialized = true;
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            IntPtr self = GetCurrentProcess();
            for (int i = 0; i < 3; i++) {
                Require(DuplicateHandle(self, GetStdHandle(-10-i), self, out stdio[i], 0, true, 2));
                Marshal.WriteIntPtr(handles, i * IntPtr.Size, stdio[i]);
            }
            jobValue = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobValue, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles,
                new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            // JOB_LIST assigns the child atomically inside CreateProcessW: there is no
            // unowned suspended child if the owner dies between Win32 calls.
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobValue,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupExtended {
                Info = new Startup { Size = (uint) Marshal.SizeOf<StartupExtended>(), Flags = 0x100,
                    Input = stdio[0], Output = stdio[1], Error = stdio[2] },
                Attributes = attributes
            };
            Require(CreateProcessW(node, line, IntPtr.Zero, IntPtr.Zero, true, 0x08080004,
                IntPtr.Zero, null, ref startup, out ProcessInfo child));
            return child;
        } finally {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
            foreach (IntPtr h in stdio) if (h != IntPtr.Zero) CloseHandle(h);
        }
    }
    // Root's wait handle may become signalled before the Job accounting snapshot
    // retires it. Only an empty list or that exact retired root can be rechecked.
    internal static string RetirementDecision(uint root, uint active, int assigned,
        long[] members, bool complete, string control) {
        if (control != null) return control;
        if (!complete || members == null || members.Length > 16 || assigned != members.Length)
            return "job-membership-unverified";
        for (int i=0; i<members.Length; i++) {
            if (members[i] != root) return "surviving-descendants";
        }
        if (members.Length > 1) return "job-membership-unverified";
        return active == 0 && members.Length == 0 ? null : "retiring-root";
    }
    static string RetiringRoot(IntPtr job, uint root, uint active, string control) {
        const int capacity = 16;
        int length = 8 + capacity * IntPtr.Size;
        IntPtr data = Marshal.AllocHGlobal(length);
        try {
            if (!QueryInformationJobObject(job, 3, data, (uint)length, out uint written) ||
                written < 8 || written > length)
                return RetirementDecision(root, active, 0, null, false, control);
            int assigned = Marshal.ReadInt32(data, 0);
            int count = Marshal.ReadInt32(data, 4);
            if (count < 0 || count > capacity || 8 + count * IntPtr.Size > written)
                return RetirementDecision(root, active, assigned, null, false, control);
            var members = new long[count];
            for (int i=0; i<count; i++)
                members[i] = Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64();
            return RetirementDecision(root, active, assigned, members, true, control);
        } finally { Marshal.FreeHGlobal(data); }
    }
    static uint Drain(IntPtr job) {
        if (Active(job) == 0) return 0;
        Require(TerminateJobObject(job, 1));
        long drainUntil = Environment.TickCount64 + 4000;
        while (Active(job) != 0 && Environment.TickCount64 < drainUntil) Sleep(10);
        return Active(job);
    }

    static int Main(string[] args) {
        IntPtr job = IntPtr.Zero;
        var child = new ProcessInfo();
        int before = -1, after = -1, firstActive = -1, retireChecks = 0;
        long status = -1;
        string stopped = null;
        try {
            long until = long.Parse(args[0]);
            string node = args[1];
            int controls = int.Parse(args[2]);
            Require(controls >= 1 && controls <= 3 && args.Length > 3 + controls * 2);
            stopped = Why(args, controls, until);
            if (stopped == null) {
                job = CreateJobObjectW(IntPtr.Zero, null);
                Require(job != IntPtr.Zero);
                var limits = new Limits();
                limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; neither breakaway flag is set.
                Require(SetInformationJobObject(job, 9, ref limits, (uint) Marshal.SizeOf<Limits>()));
                var line = new StringBuilder();
                Quote(line, node);
                for (int i = 3 + controls * 2; i < args.Length; i++) {
                    line.Append(' ');
                    Quote(line, args[i]);
                }
                child = CreateOwned(job, node, line);
                Require(IsProcessInJob(child.Process, job, out bool owned) && owned && Active(job) == 1);
                stopped = Why(args, controls, until);
                if (stopped == null) {
                    Require(ResumeThread(child.Thread) == 1);
                    while (stopped == null) {
                        uint wait = WaitForSingleObject(child.Process, 45);
                        stopped = Why(args, controls, until);
                        if (wait == 0) {
                            Require(GetExitCodeProcess(child.Process, out uint value));
                            status = value;
                            break;
                        }
                        Require(wait == 258);
                    }
                }
                before = firstActive = checked((int) Active(job));
                if (stopped == null && status != 0) stopped = "root-failed";
                while (stopped == null) {
                    stopped = Why(args, controls, until);
                    if (stopped != null) break;
                    before = checked((int) Active(job));
                    string verdict = RetiringRoot(job, child.Pid, (uint)before, stopped);
                    if (verdict == null) break;
                    if (verdict != "retiring-root") { stopped = verdict; break; }
                    retireChecks++;
                    Sleep(2);
                }
                after = checked((int) Drain(job));
                if (after != 0) stopped = "drain-failed";
                if (stopped == null) stopped = Why(args, controls, until);
            }
        } catch {
            stopped = "owner-error";
            if (job != IntPtr.Zero) {
                try { before = checked((int) Active(job)); after = checked((int) Drain(job)); }
                catch { stopped = "drain-failed"; } // CloseHandle below is still kernel-enforced cleanup.
            }
        } finally {
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
        string pid = child.Pid == 0 ? "null" : child.Pid.ToString();
        Console.Error.WriteLine("\n[studio-c2-child] {\"pid\":" + pid + ",\"status\":" +
            (status < 0 ? "null" : status.ToString()) + ",\"stopped\":" +
            (stopped == null ? "null" : "\"" + stopped + "\"") + ",\"activeBefore\":" + before +
            ",\"activeAfter\":" + after + ",\"firstActive\":" + firstActive + ",\"retireChecks\":" + retireChecks + "}");
        return stopped == null && status == 0 && before == 0 && after == 0 ? 0 : 1;
    }
}
`;


const studioG2JobHost = Object.freeze({
  "dotnet.exe":
    "cbb1746f9b08dd9825129d451d99869e84e9024e62c804dede22c9fb61e0291d",
  "sdk/10.0.300/Roslyn/bincore/csc.dll":
    "5d03664b92a3c91bafb63466d1796d1aa863a5cbab3d6b79a30ba1b13d192cd2",
  "packs/Microsoft.NETCore.App.Ref/10.0.8/ref/net10.0/System.Runtime.dll":
    "e80034d0e2671af90f7581ca44fd147420d96514f8ee7eddb209c080c7d4bae4",
  "packs/Microsoft.NETCore.App.Ref/10.0.8/ref/net10.0/System.Runtime.InteropServices.dll":
    "813657857e037166ae25d641355a823a730e2ae80f78dfcffee935c61781c244",
  "packs/Microsoft.NETCore.App.Ref/10.0.8/ref/net10.0/System.Console.dll":
    "b4fe3cf096dd0853d245eb00942247f1469c9303e062aa84361128b9490d56f4",
  "sdk/10.0.300/Roslyn/bincore/csc.runtimeconfig.json":
    "6048f0a7678a310ef8c378141caa210c3dcf7efa6596e9374f235dd28a195171",
  "sdk/10.0.300/Roslyn/bincore/csc.deps.json":
    "ac9fad8bbbf424be2507be5f1dde95e4fe8b4af834f96b3d1a13fb038f9ddb43",
  "sdk/10.0.300/Roslyn/bincore/Microsoft.CodeAnalysis.dll":
    "f9a140c3aca40ea3cb8b922dc3efcdb7fdcea1f5aa752106ea381a9ad5d7b5c6",
  "sdk/10.0.300/Roslyn/bincore/Microsoft.CodeAnalysis.CSharp.dll":
    "6a2c562412e0936082343c415ee72526303c4914cf8ae92750c6c561750a53ad",
  "shared/Microsoft.NETCore.App/10.0.8/System.Private.CoreLib.dll":
    "5b6700e2802afdb2cc4863b096760a66442e89fd6ee5edb718c697ae5cf33ddc",
  "shared/Microsoft.NETCore.App/10.0.8/System.Runtime.dll":
    "7f87ad22ac2ec701604a68646bcf4aa1f5c43ad6744c6d01bfaa9e9667e5595e",
  "shared/Microsoft.NETCore.App/10.0.8/System.Runtime.InteropServices.dll":
    "b6231cd2114de5d310fa8665715b39a08c0f045da62c66648dc948ae757b5b4d",
  "shared/Microsoft.NETCore.App/10.0.8/System.Console.dll":
    "16e68d0bc220bd1ca98baf56652f0682b858da1d8dc8a8a357a07e141b1db7ac",
  "shared/Microsoft.NETCore.App/10.0.8/hostpolicy.dll":
    "385c3c4cddab07e1763a1fb1f978c57e31bb0f478b30b4c535ca1a3db50d28db",
  "shared/Microsoft.NETCore.App/10.0.8/coreclr.dll":
    "85135fcf132fae2c3e03d3480dfbb51f910e78e8a6c35ffa367ea33b243216d7",
  "shared/Microsoft.NETCore.App/10.0.8/Microsoft.NETCore.App.deps.json":
    "edc6746154c0540b6f8a39de2ffd73278d06445a5b674dc6846d7a1158d46293",
  "host/fxr/10.0.8/hostfxr.dll":
    "dec56b41cf09cfcae002a3bb752b0b381c68b6217ed9e4b41b1ac2b645b5fdc5",
  "packs/Microsoft.NETCore.App.Ref/10.0.8/ref/net10.0/System.Security.Cryptography.dll":
    "c3d3cbf9eb89e180d2c63ca8b655d7deabb5fedb2c93e862df0f142c0a0182fb",
  "shared/Microsoft.NETCore.App/10.0.8/System.Security.Cryptography.dll":
    "4b49704286fde85ca0492af6f563b7ff42b7af3094bb8775419fd79c98f65ba6",
  "shared/Microsoft.NETCore.App/10.0.8/clrjit.dll":
    "18fe968846117d13edf3262bcb305ca28f678742a3281f8b4228a44047966f79",
});

const studioG2JobBinarySha = '153cb19e3aefb58dab5b128f046d59e927c77ed654e247d884269abf9dccb773';
const studioG2JobRuntime = '{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.8"},"rollForward":"Disable"}}\n';
function verifyStudioG2JobHost(tools) {
  const code = 'G2_TOOL_UNTRUSTED';
  const root = g2Physical(path.dirname(tools.dotnet), 'dir', code);
  requireThat(path.relative(root, 'C:/Program Files/dotnet') === ''
    && path.relative(tools.csc, path.join(root, 'sdk/10.0.300/Roslyn/bincore/csc.dll')) === '', code);
  for (const [name, expected] of Object.entries(studioG2JobHost)) {
    const file = g2Physical(path.join(root, name), 'file', code, false);
    requireThat(sha256(readFileSync(file)) === expected, code);
  }
  return root;
}
export function prepareStudioG2Job(output, tools, run, planned = () => {}) {
  const host = verifyStudioG2JobHost(tools);
  const folder = path.join(output, 'studio-job');
  mkdirSync(folder);
  const source = path.join(folder, 'owner.cs');
  const config = path.join(folder, 'owner.runtimeconfig.json');
  const dll = path.join(folder, 'owner.dll');
  writeFileSync(source, studioG2JobSource, { flag: 'wx' });
  writeFileSync(config, studioG2JobRuntime, { flag: 'wx' });
  const files = new Map([[source, sha256(studioG2JobSource)], [config, sha256(studioG2JobRuntime)]]);
  verifyStudioG2JobFiles(folder, files);
  const job = { folder, files, dll, config };
  planned(job);
  const refs = ['System.Runtime', 'System.Runtime.InteropServices', 'System.Console', 'System.Security.Cryptography']
    .map((name) => '/reference:' + path.join(host, 'packs/Microsoft.NETCore.App.Ref/10.0.8/ref/net10.0', name + '.dll'));
  run('studio-job-compile', 'dotnet', ['exec', tools.csc, '/nologo', '/noconfig', '/nostdlib+', '/target:exe',
    '/deterministic+', '/optimize+', '/debug-', '/pathmap:' + folder + '=C:/orange-studio-job',
    '/out:' + dll, ...refs, source], folder);
  verifyStudioG2JobHost(tools);
  files.set(dll, studioG2JobBinarySha);
  verifyStudioG2JobFiles(folder, files);
  return job;
}
function verifyStudioG2JobFiles(folder, files) {
  const code = 'G2_JOB_UNTRUSTED';
  const dir = g2Physical(folder, 'dir', code);
  const names = new Set([...files.keys()].map((file) => path.basename(file)));
  const actual = readdirSync(dir);
  requireThat(actual.length === names.size && actual.every((name) => names.has(name)), code);
  for (const [file, expected] of files) {
    const bytes = studioReadBytes(studioPhysical(file, 'file', code), 2 * studioMiB, code);
    requireThat(sha256(bytes) === expected, code);
  }
}
export function g2ReportRunner(output, tools, env, checkControl, commands, studio) {
  return (id, tool, args, cwd, maximum = 60_000) => {
    const stdoutFile = path.join(output, id + '.stdout');
    const stderrFile = path.join(output, id + '.stderr');
    requireThat(!existsSync(stdoutFile) && !existsSync(stderrFile), 'G2_OUTPUT_REUSED');
    studio?.guard(id, false);
    const timeout = Math.min(checkControl(), maximum);
    const started = Date.now();
    const supervised = studio?.native;
    let supervisor;
    if (supervised) {
      requireThat(tool === 'node' && studio.job, 'G2_JOB_UNTRUSTED');
      const { folder, files, dll, config } = studio.job;
      verifyStudioG2JobHost(tools);
      verifyStudioG2JobFiles(folder, files);
      supervisor = { executable: tools.dotnet,
        args: ['exec', '--runtimeconfig', config, dll, String(started + timeout), tools.node,
          String(studio.controls.length), ...studio.controls.flat(), ...args] };
    }
    const result = spawnSync(supervisor?.executable ?? tools[tool], supervisor?.args ?? args, {
      cwd, env, windowsHide: true, timeout: timeout + (supervised ? 7000 : 0), maxBuffer: 16 * 1024 * 1024,
    });
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
    let nativeChild;
    if (supervised) {
      const record = /\n\[studio-c2-child\] (\{[^\r\n]+\})\r?\n$/.exec(text(stderr));
      if (record) nativeChild = JSON.parse(record[1]);
    }
    commands.push({
      id, executable: tools[tool], args, cwd, started: new Date(started).toISOString(),
      ended: new Date(ended).toISOString(), exitCode: result.status, signal: result.signal, error: result.error?.code,
      stdout: { file: stdoutFile, sha256: sha256(stdout), ...(studio && { bytes: stdout.length }) },
      stderr: { file: stderrFile, sha256: sha256(stderr), ...(studio && { bytes: stderr.length }) },
      ...(supervised && { nativeChild: nativeChild ?? null, supervisor }),
    });
    if (controlFailure) throw controlFailure;
    requireThat(result.status === 0 && !result.error && !result.signal, 'G2_COMMAND_FAILED');
    if (supervised) {
      requireThat(Number.isSafeInteger(nativeChild?.pid) && nativeChild.pid > 0 && nativeChild.status === 0
        && nativeChild.stopped === null && nativeChild.activeBefore === 0 && nativeChild.activeAfter === 0, 'G2_COMMAND_FAILED');
      verifyStudioG2JobHost(tools);
      verifyStudioG2JobFiles(studio.job.folder, studio.job.files);
    }
    studio?.guard(id, true);
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
// Normalized paths (with / marking directories) from the same fixed SDK/feed
// in both the historical Auth control and independent same-head K07 witness.
const studioG2HomeShape = '3a14fa60958707431aa9b302ca597f718ef0caa9ceccdcdd18efa725e04062f2';
const studioG2BuiltShape = '7d5eff19607e29e9aac71b241799b5010d620bee91e830a5c5e9ec5a134dba4c';
const studioG2HomeBase = ['gitconfig', 'local/', 'roaming/'];
const studioG2SdkHome = new Set([...studioG2HomeBase, '.dotnet/', '.dotnet/10.0.300.dotnetFirstUseSentinel',
  'local/NuGet/', 'local/NuGet/Migrations/', 'local/NuGet/Migrations/1',
  'roaming/NuGet/', 'roaming/NuGet/NuGet.Config']);
const studioG2Restored = ['obj/', 'obj/Orange.Contracts.Tests/',
  ...['Orange.Contracts.Tests.csproj.nuget.dgspec.json', 'Orange.Contracts.Tests.csproj.nuget.g.props',
    'Orange.Contracts.Tests.csproj.nuget.g.targets', 'project.assets.json', 'project.nuget.cache']
    .map((name) => 'obj/Orange.Contracts.Tests/' + name)].sort();
const studioG2NoAmbientMSBuild = ['-p:ImportDirectoryBuildProps=false', '-p:ImportDirectoryBuildTargets=false',
  '-p:ImportDirectoryPackagesProps=false'];
function studioG2EvidenceTree(root) {
  const code = 'G2_EVIDENCE_MUTATED';
  const entries = [];
  let bytes = 0;
  const walk = (folder, prefix) => {
    const actual = readdirSync(g2Physical(folder, 'dir', code), { withFileTypes: true });
    for (const item of actual) {
      const name = prefix + item.name;
      requireThat(entries.length < 1200 && name.length <= 250, code);
      repositoryPath(name);
      const file = path.join(folder, item.name);
      const stat = lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        entries.push(name + '/');
        walk(file, name + '/');
      } else {
        requireThat(!stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1, code);
        bytes += stat.size;
        requireThat(bytes <= 256 * studioMiB, code);
        entries.push(name);
      }
    }
  };
  walk(root, '');
  return entries.sort();
}
function verifyStudioG2Temp(output, sdk, restored) {
  const code = 'G2_EVIDENCE_MUTATED';
  const files = studioG2EvidenceTree(path.join(output, 'tmp'));
  let randomDirs = 0;
  let workloads = 0;
  for (const name of files) {
    const valid = restored && ['NuGetScratch/', 'NuGetScratch/lock/'].includes(name)
      || restored && /^[a-z0-9]{8}\.[a-z0-9]{3}\/$/.test(name) && ++randomDirs <= 3
      || sdk && /^Microsoft\.NET\.Workload_\d+_\d{8}_\d{6}_\d{3}\.log$/.test(name) && ++workloads <= 2;
    requireThat(valid, code);
  }
}
export function verifyStudioG2Evidence(output, commands, state, phase, after) {
  const code = 'G2_EVIDENCE_MUTATED';
  const done = (id) => commands.some((command) => command.id === id && command.exitCode === 0);
  const sdk = done('dotnet-sdk-version');
  const restored = done('contracts-dotnet-restore');
  const built = done('contracts-dotnet-test');
  const artifacts = [...state.seals.keys()].filter((name) => !name.includes('/'));
  if (state.job) artifacts.push('studio-job');
  if (restored) artifacts.push('out', 'packages.lock.json');
  if (state.resultsReady) artifacts.push('results');
  g2Physical(output, 'dir', code);
  verifyG2Evidence(output, commands, artifacts);
  for (const [name, expected] of state.seals) {
    const file = path.join(output, name);
    const bytes = studioReadBytes(studioPhysical(file, 'file', code), 512 * studioMiB, code);
    requireThat(sha256(bytes) === expected, code);
  }
  if (state.job) {
    const files = new Map(state.job.files);
    if (phase === 'studio-job-compile' && after) files.set(state.job.dll, studioG2JobBinarySha);
    verifyStudioG2JobFiles(state.job.folder, files);
  }
  const home = studioG2EvidenceTree(path.join(output, 'home'));
  const allowed = sdk ? studioG2SdkHome : new Set(studioG2HomeBase);
  requireThat(restored ? home.length === 546 && sha256(JSON.stringify(home)) === studioG2HomeShape
    : studioG2HomeBase.every((name) => home.includes(name)) && home.every((name) => allowed.has(name)), code);
  verifyStudioG2Temp(output, sdk, restored);
  if (restored) {
    g2Physical(path.join(output, 'packages.lock.json'), 'file', code);
    const out = studioG2EvidenceTree(path.join(output, 'out'));
    requireThat(built ? out.length === 125 && sha256(JSON.stringify(out)) === studioG2BuiltShape
      : isDeepStrictEqual(out, studioG2Restored), code);
  }
  if (state.resultsReady) {
    const results = studioG2EvidenceTree(path.join(output, 'results'));
    requireThat(isDeepStrictEqual(results, built ? ['orange-k07.trx'] : []), code);
  }
}
// Independent prior C/D witness content expectations: 358 cache files include
// 319 entries independently matched to the 13 pinned source ZIPs. Exact source
// list/raw hashes and this normalization algorithm were sealed before this run
// in restore-expectations-source.json (1d1285044ee3348c681d8bad2bc939f7a74e604ae2e2592478047ddff0644f40).
const studioG2RestoredPackagesSha = 'f7cbef93133face1831831cadb7a5c8fb5d64d39e80e352e5fecb7d714b28c7e';
const studioG2RestoredLockSha = '38fa4dc4794842db3410090d29be2608af1781b8f9ee9b10af16bb723893721b';
const studioG2RestoreMetadata = Object.freeze({
  'Orange.Contracts.Tests.csproj.nuget.dgspec.json': '02b0d2fc60a1d5b3e655b82e03af6f4c7c30c5f8d6a3c428e3327658b01dc4fc',
  'Orange.Contracts.Tests.csproj.nuget.g.props': '8a33aa0fd180fe12045d8e8b1f578739b80875a1167eda9317fff878f3f117f2',
  'Orange.Contracts.Tests.csproj.nuget.g.targets': '724b018dd87ab80339e241ae5acf06fa10179ad0899a2fc9ea84109f7c83a84f',
  'project.assets.json': '086586d63af3d42ea9befbce7c6247e37e22a718cb1944b4fb4691b0fcad7d77',
  'project.nuget.cache': '42ee91a55c81043e5bfc91000dc6e594d7e228b788c55dbfbe014f5f09eb024d',
});
function verifyStudioG2RestoreContent(output, execRoot, plan) {
  const code = 'G2_RESTORE_LOCK_INVALID';
  const roots = [
    [g2Physical(output, 'dir', code), '<OUTPUT>'],
    [g2Physical(execRoot, 'dir', code), '<EXEC>'],
    [g2Physical(plan.nugetFeed.path, 'dir', code), '<FEED>'],
  ];
  requireThat(roots.every(([root], i) => roots.every(([other], j) => i === j || differentRoots(root, other))), code);
  const normalize = (bytes, json) => {
    let value = text(bytes);
    requireThat(!['<OUTPUT>', '<EXEC>', '<FEED>', '<DYNAMIC>'].some((token) => value.includes(token)), code);
    const forms = roots.flatMap(([root, token]) => [...new Set([root, root.replaceAll('\\', '/')])]
      .map((form) => [json ? JSON.stringify(form).slice(1, -1) : form, token]))
      .sort(([a], [b]) => b.length - a.length);
    for (const [form, token] of forms) value = value.replaceAll(form, token);
    return value;
  };
  // Preserve the very raw observations whose independent expectations are
  // checked below. A later filesystem read can never redefine these values.
  const verified = new Map();
  const read = (relative) => {
    const bytes = studioReadBytes(studioPhysical(path.join(output, relative), 'file', code), 16 * studioMiB, code);
    requireThat(!verified.has(relative), code);
    verified.set(relative, sha256(bytes));
    return bytes;
  };
  requireThat(sha256(read('packages.lock.json')) === studioG2RestoredLockSha, code);
  const packages = studioG2EvidenceTree(path.join(output, 'home/packages')).filter((name) => !name.endsWith('/'));
  requireThat(packages.length === 358, code);
  const stablePackages = [];
  const expected = packages.map((name) => {
    const bytes = read('home/packages/' + name), value = name.endsWith('/.nupkg.metadata') ? normalize(bytes, true) : bytes;
    const digest = sha256(value);
    stablePackages.push({ path: name, bytes: Buffer.byteLength(value), sha256: digest });
    return [name, digest];
  });
  const stableMetadata = [];
  requireThat(sha256(JSON.stringify(expected)) === studioG2RestoredPackagesSha, code);
  for (const [name, expectedSha] of Object.entries(studioG2RestoreMetadata)) {
    let value = normalize(read('out/obj/Orange.Contracts.Tests/' + name), name.endsWith('.json') || name.endsWith('.cache'));
    if (name === 'project.nuget.cache') {
      const slots = [...value.matchAll(/"dgSpecHash": "([A-Za-z0-9+/]{11}=)"/g)];
      requireThat(slots.length === 1 && Buffer.from(slots[0][1], 'base64').length === 8
        && Buffer.from(slots[0][1], 'base64').toString('base64') === slots[0][1], code);
      value = value.replace(slots[0][0], '"dgSpecHash": "<DYNAMIC>"');
    }
    requireThat(sha256(value) === expectedSha, code);
    stableMetadata.push({ path: name, bytes: Buffer.byteLength(value), sha256: expectedSha });
  }
  verified.stable = { packages: stablePackages, metadata: stableMetadata };
  return verified;
}


export function sealStudioG2Restore(output, state, plan, nativeLock, execRoot) {
  const verified = verifyStudioG2RestoreContent(output, execRoot, plan);
  const code = 'G2_RESTORE_LOCK_INVALID';
  for (const [name, { resolved }] of Object.entries(nativeLock)) {
    const fileName = fold(name + '.' + resolved + '.nupkg');
    const expected = plan.nugetFeed.files.find(({ path: file }) => fold(file) === fileName);
    const relative = 'home/packages/' + fold(name) + '/' + fold(resolved) + '/' + fileName;
    requireThat(expected && verified.get(relative) === expected.sha256, code);
  }
  // Transfer only the already independently verified raw-byte digests,
  // including the lock, archives, extracted files and generated metadata.
  for (const [relative, expected] of verified) state.seals.set(relative, expected);
  state.restoreStable = verified.stable;
}

function runG2(planFile, context) {
  const { root, common, tree, card, index, cardFile, indexFile, base, head, report, studio } = context;
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
  let sourceFiles;
  let expectedBuild;
  let electron;
  let execMarker;
  let candidateMarker;
  let execIndex;
  let execIndexSha256;
  let studioControls;
  const studioEvidence = { seals: new Map([['home/gitconfig', sha256('')]]), job: undefined, resultsReady: false };
  const modes = new Set();
  const nativeStages = new Set();
  let auth = false;
  const checkControl = (desktop = false) => {
    const duration = verifyG2Control({ cardFile, indexFile, planFile, card, index, protectedRoots: resolvedRoots }, desktop);
    if (studio) for (const [file, expected] of studioControls) {
      requireThat(sha256(readFileSync(g2Physical(file, 'file', 'G2_CONTROL_CHANGED'))) === expected, 'G2_CONTROL_CHANGED');
    }
    return duration;
  };
  const studioGuard = (id, after) => {
    checkControl();
    requireThat(path.relative(linkedWorktree(card).common, common) === '', 'G2_EXECUTION_MISMATCH');
    verifyG2Execution(execRoot, root, common, head, plan.tree);
    verifyIndex(root, tree);
    verifyIndex(execRoot, tree);
    requireThat(sha256(readFileSync(g2Physical(execIndex, 'file', 'INDEX_NOT_NORMAL'))) === execIndexSha256, 'INDEX_NOT_NORMAL');
    studio.freshC1();
    verifyG2Ancestors(execRoot, studio);
    const attributes = lstatSync(path.join(common, 'info', 'attributes'), { throwIfNoEntry: false });
    requireThat(!attributes || attributes.isFile() && !attributes.isSymbolicLink()
      && attributes.size === 0 && attributes.nlink === 1, 'G2_ANCESTOR_CONFIG');
    if (tools) {
      requireThat(isDeepStrictEqual(verifyG2Tools(plan, resolvedRoots), tools), 'G2_TOOL_UNTRUSTED');
      requireThat(verifyG2Feed(plan, resolvedRoots) === feed, 'G2_FEED_UNTRUSTED');
      for (const ref of [plan.executableInputs, plan.studio.buildOutputs, ...(deps ? [plan.installedPackages] : [])]) {
        g2JSON(ref.path, ref.sha256, resolvedRoots, 'G2_CONTROL_CHANGED');
      }
    }
    if (env) verifyStudioG2Evidence(output, execution.commands, studioEvidence, id, after);
    verifyStudioG2Layout(root, tree, candidateMarker, {}, undefined, undefined, [], true);
    if (after && id.startsWith('desktop-build-')) modes.add(id.slice('desktop-build-'.length));
    if (after && id.startsWith('windows-')) nativeStages.add(id);
    const outputs = new Map([...(expectedBuild?.expected ?? [])].filter(([name]) =>
      modes.has(name.slice(studioG2Dist.length).split('/')[0])));
    const scratch = [
      ...(modes.size ? ['apps/desktop/node_modules/.vite-temp'] : []),
      ...(nativeStages.has('windows-studio-tap') ? ['.orange-local/studio-smoke'] : []),
      ...(nativeStages.has('windows-tap') || nativeStages.has('windows-auth-fixture-tap') ? ['.orange-local/shell-smoke'] : []),
    ];
    const layout = verifyStudioG2Layout(execRoot, tree, execMarker, deps, sourceFiles, outputs, scratch);
    execution.studio.layout.push({ phase: id, when: after ? 'after' : 'before', ...layout });
    checkControl();
  };
  const studioRunner = studio ? { guard: studioGuard } : undefined;
  const fresh = (post = false, windowsStarted = false) => {
    if (studio) {
      checkControl();
      return; // The Studio runner verifies the full physical closure for every command.
    }
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
    const isolation = studio ? studio.protectedRoots : [root, common];
    if (studio) {
      requireThat(isolation.every((item) => differentRoots(item, execRoot)) && process.platform === 'win32'
        && fold(path.parse(execRoot).root) === 'd:\\' && execRoot.length <= 90
        && !/[\x00-\x1f%!"&^|<>]/.test(execRoot), 'G2_EXECUTION_MISMATCH');
    }
    output = g2ScratchRoot(plan.outputRoot, [execRoot, ...isolation]);
    resolvedRoots = [execRoot, output, ...isolation];
    for (const control of [planFile, cardFile, indexFile]) {
      requireThat(![execRoot, output, common].some((item) => contained(item, realpathSync.native(control))), 'G2_CONTROL_UNSAFE');
    }
    Object.assign(execution, { base, head, tree: plan.tree, assignmentRevision: card.assignmentRevision,
      planSha256: index.g2PlanSha256, executionRoot: execRoot, outputRoot: output });
    if (studio) {
      requireThat(fold(path.parse(output).root) === 'd:\\', 'G2_OUTPUT_UNSAFE');
      studioControls = [
        [cardFile, studio.cardSha256], [indexFile, studio.indexSha256],
        [path.resolve(planFile), index.g2PlanSha256],
      ];
      const marker = (dir) => sha256(readFileSync(g2Physical(path.join(dir, '.git'), 'file', 'G2_EXECUTION_MISMATCH')));
      execMarker = marker(execRoot);
      candidateMarker = marker(root);
      execIndex = g2Physical(text(git(execRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).trimEnd(),
        'file', 'INDEX_NOT_NORMAL');
      execIndexSha256 = sha256(readFileSync(execIndex));
      execution.studio = { rendererGraphSha256: plan.studio.rendererGraphSha256,
        expectedBuildSha256: plan.studio.buildOutputs.sha256, executableInputsSha256: plan.executableInputs.sha256,
        installedPackagesSha256: plan.installedPackages.sha256, executionIndexSha256: execIndexSha256, layout: [] };
      studioGuard('initial', false);
      expectedBuild = studioG2ExpectedBuild(plan, report.rendererGraph, resolvedRoots);
    } else {
      fresh();
      verifyCheckout(execRoot, tree);
    }
    const names = g2InputNamesFor(tree, report.rendererGraph, base, head, root, studio);
    auth = names.size !== g2InputNames.size;
    inputs = verifyG2Inputs(execRoot, tree, plan, resolvedRoots, names, studio);
    fixture = g2Fixture(inputs);
    tools = verifyG2Tools(plan, resolvedRoots);
    if (studio) requireThat(plan.tools.node.sha256 === report.rendererGraph.nodeSha256, 'G2_TOOL_UNTRUSTED');
    feed = verifyG2Feed(plan, resolvedRoots);
    const infoAttributes = path.join(common, 'info', 'attributes');
    requireThat(!existsSync(infoAttributes) || lstatSync(infoAttributes).size === 0, 'G2_ANCESTOR_CONFIG');
    env = g2Environment(execRoot, output, tools);
    if (studio) Object.assign(env, { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
      ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: 'localhost,127.0.0.1,::1', NODE_DISABLE_COMPILE_CACHE: '1' });
    run = g2ReportRunner(output, tools, env, checkControl, execution.commands, studioRunner);
    requireThat(text(run('node-version', 'node', ['--version'], execRoot).stdout).trim() === 'v24.22.1', 'G2_TOOL_UNTRUSTED');
    run('diff-check', 'git', ['--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.attributesFile=' + env.GIT_CONFIG_GLOBAL,
      '-c', 'core.whitespace=blank-at-eol,blank-at-eof,space-before-tab', 'diff', '--check',
      '--no-ext-diff', '--no-textconv', base, head, '--'], execRoot);
    deps = materializeG2Packages(execRoot, plan, inputs, resolvedRoots, studio);
    if (studio) {
      sourceFiles = materializeStudioG2Source(execRoot, studio.upstream);
      studioGuard('materialized', true);
      execution.studio.electron = electron = verifyStudioG2Electron(execRoot);
    }
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
    for (const mode of ['main', 'preload', 'renderer', ...(studio ? ['studio'] : [])]) {
      run('desktop-build-' + mode, 'node', [vite, 'build', '--mode', mode], desktop);
    }
    generated = g2BuildOutputs(execRoot, head, auth, studio && { studioSource: studio.studioSource,
      rendererGraph: report.rendererGraph, files: expectedBuild.files, sourcePaths: [...studio.upstream.keys()] });
    fresh(true);
    verifyG2Evidence(output, execution.commands);
    execution.build = generated.build;
    if (studio) Object.assign(execution.studio, { inputs: inputs.size, outputs: Object.fromEntries(generated.outputs) });
    else if (auth) execution.auth = { profileSha256: startupG2ProfileDigest, inputs: inputs.size, outputs: Object.fromEntries(generated.outputs) };
  });
  stage(selected('windows'), () => {
    verifyG2Tools(plan, resolvedRoots);
    const job = studio && prepareStudioG2Job(output, tools, g2ReportRunner(output, tools, env,
      checkControl, execution.commands, studioRunner), (pending) => { studioEvidence.job = pending; });
    const windows = g2ReportRunner(output, tools, env, () => checkControl(true), execution.commands,
      studio && { ...studioRunner, controls: studioControls, native: true, job });
    const evidence = [];
    for (const { id, args, expected } of g2WindowsStages(auth, studio)) {
      fresh(true, evidence.length > 0);
      const result = windows(id, 'node', args, execRoot, 125_000);
      evidence.push(verifyG2Tap(result.stdout, expected, Boolean(studio)));
      fresh(true, true);
      verifyG2Evidence(output, execution.commands, studio ? ['studio-job'] : []);
      checkControl(true);
    }
    execution.windows = studio
      ? { studio: evidence[0], ...evidence[1], authFixture: evidence[2], authService: evidence[3], desktopLease: plan.desktopLease.id }
      : { ...evidence[0], desktopLease: plan.desktopLease.id, ...(auth && { authFixture: evidence[1], authService: evidence[2] }) };
  });
  stage(selected('contracts'), () => {
    verifyG2Tools(plan, resolvedRoots);
    requireThat(verifyG2Feed(plan, resolvedRoots) === feed, 'G2_FEED_UNTRUSTED');
    fresh();
    const freeze = g2Freeze(inputs, fixture.length);
    const contracts = path.join(execRoot, 'packages', 'contracts');
    run('contracts-generated-check', 'node', [path.join(execRoot, 'tools', 'contracts', 'generate.mjs'), '--check'], contracts);
    const ts = run('contracts-ts-tap', 'node', ['--test-reporter=tap', 'tests/contracts/ts/contracts.test.ts', '--pack', 'K07'], execRoot);
    const tsResult = verifyG2Tap(ts.stdout, [...fixture.map(({ id, kind }) => '[K07] ' + kind + ': ' + id), ...generatorTests], Boolean(studio));
    const runDotnet = g2ReportRunner(output, tools, g2DotnetEnvironment(env, tools), checkControl, execution.commands, studioRunner);
    requireThat(text(runDotnet('dotnet-sdk-version', 'dotnet', ['--version'], execRoot).stdout).trim() === '10.0.300', 'G2_TOOL_UNTRUSTED');
    const project = path.join(execRoot, 'tests', 'contracts', 'dotnet', 'Orange.Contracts.Tests.csproj');
    const artifacts = path.join(output, 'out');
    const results = path.join(output, 'results');
    const config = path.join(output, 'nuget.config');
    const shim = path.join(output, 'csc-k07.cmd');
    const lock = path.join(output, 'packages.lock.json');
    requireThat([tools.dotnet, tools.csc].every((value) => !/[\x00-\x1f%!"&^|<>]/.test(value)), 'G2_TOOL_UNTRUSTED');
    const configBytes = '<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><clear /></packageSources></configuration>\n';
    const shimBytes = '@echo off\r\n"' + tools.dotnet + '" exec "' + tools.csc + '" %*\r\nexit /b %errorlevel%\r\n';
    writeFileSync(config, configBytes, { flag: 'wx' });
    writeFileSync(shim, shimBytes, { flag: 'wx' });
    if (studio) {
      studioEvidence.seals.set('nuget.config', sha256(configBytes));
      studioEvidence.seals.set('csc-k07.cmd', sha256(shimBytes));
    }
    requireThat(!existsSync(lock), 'G2_OUTPUT_REUSED');
    runDotnet('contracts-dotnet-restore', 'dotnet', ['restore', project, '--configfile', config, '--source', feed,
      '-p:ArtifactsPath=' + artifacts, '-p:NuGetAudit=false', '-p:RestorePackagesWithLockFile=true',
      '-p:NuGetLockFilePath=' + lock, ...(studio ? studioG2NoAmbientMSBuild : [])], execRoot);
    const lockBytes = readFileSync(g2Physical(lock, 'file', 'G2_RESTORE_LOCK_INVALID'));
    const frameworks = JSON.parse(text(lockBytes)).dependencies;
    const nativeLock = frameworks?.['net10.0'];
    requireThat(frameworks && Object.keys(frameworks).length === 1 && nativeLock && Object.keys(nativeLock).length === 13
      && Object.entries(nativeLock).every(([name, item]) => typeof item?.resolved === 'string'
        && plan.nugetFeed.files.some(({ path: file }) => fold(file) === fold(name + '.' + item.resolved + '.nupkg'))),
    'G2_RESTORE_LOCK_INVALID');
    if (studio) {
      studioEvidence.seals.set('packages.lock.json', sha256(lockBytes));
      sealStudioG2Restore(output, studioEvidence, plan, nativeLock, execRoot);
      studioEvidence.resultsReady = true;
    }
    mkdirSync(results);
    const trx = path.join(results, 'orange-k07.trx');
    requireThat(!existsSync(trx), 'G2_OUTPUT_REUSED');
    const cmd = runDotnet('contracts-dotnet-test', 'dotnet', ['test', project, '--no-restore', '--artifacts-path', artifacts,
      '--filter', 'Pack=K07', '--results-directory', results, '--logger', 'trx;LogFileName=orange-k07.trx',
      '-p:UseSharedCompilation=false', '-p:CscToolPath=' + output, '-p:CscToolExe=csc-k07.cmd',
      ...(studio ? studioG2NoAmbientMSBuild : [])], execRoot, 85_000);
    const trxFile = g2Physical(trx, 'file', 'G2_TRX_INVALID');
    const stat = lstatSync(trxFile);
    requireThat(isDeepStrictEqual(readdirSync(results), ['orange-k07.trx']) && stat.size <= 4 * 1024 * 1024
      && stat.mtimeMs >= cmd.started && stat.mtimeMs <= cmd.ended, 'G2_TRX_STALE');
    const dotnet = verifyG2Trx(readFileSync(trxFile), fixture.map(({ id }) => id), cmd.started, cmd.ended, Boolean(studio));
    fresh(true, true);
    verifyG2Evidence(output, execution.commands, ['out', 'results', 'nuget.config', 'csc-k07.cmd', 'packages.lock.json', ...(studio ? ['studio-job'] : [])]);
    requireThat(readFileSync(g2Physical(lock, 'file', 'G2_EVIDENCE_MUTATED')).equals(lockBytes)
      && sha256(readFileSync(g2Physical(trxFile, 'file', 'G2_EVIDENCE_MUTATED'))) === dotnet.sha256,
    'G2_EVIDENCE_MUTATED');
    execution.contracts = { pack: 'K07', sharedCount: fixture.length, freeze, ts: tsResult, dotnet: { ...dotnet, file: trxFile },
      restoreLock: { file: lock, sha256: sha256(lockBytes), packages: 13 } };
    if (studio) {
      studioEvidence.seals.set('results/orange-k07.trx', dotnet.sha256);
      readG3NativeLock(execution, { base, head, tree: plan.tree, assignmentRevision: card.assignmentRevision });
      studioGuard('terminal', true);
    }
  });
  return studio && { execution, expectedBuild, electron, deps, tools, plan, planFile, inputs, fixture,
    restoreStable: studioEvidence.restoreStable, checkControl, job: studioEvidence.job,
    deadline: Date.parse(plan.validUntil), guard: () => studioGuard('terminal', true) };
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
  const plan = g2JSON(planFile, index.g3PlanSha256, context.studio?.protectedRoots ?? [root], 'G3_PLAN_UNTRUSTED');
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
export function g3SourceSnapshot(root, tree, snapshot, studio) {
  if (studio) requireThat(studio.studio === true && studio.pin === studioPolicy.pin
    && exactSha(studio.head) && exactSha(studio.tree)
    && tree.size === 75 && tree.get(studioLink)?.mode === '160000' && tree.get(studioLink)?.oid === studioPolicy.pin
    && tree.get('.gitmodules')?.oid === studioPolicy.modulesBlob
    && text(git(root, 'rev-parse', studio.head + '^{tree}')).trimEnd() === studio.tree, 'STUDIO_C3_SOURCE_MISMATCH');
  requireThat(tree.size > 0 && tree.size <= 1000, 'G3_SCOPE_UNSUPPORTED');
  let totalBytes = 0;
  const entries = [];
  mkdirSync(snapshot);
  for (const [name, { mode, oid }] of [...tree.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    repositoryPath(name);
    if (studio && name === studioLink && mode === '160000' && oid === studioPolicy.pin) continue;
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
export function readG3Report(file, result, retain = false) {
  const code = 'G3_REPORT_INVALID';
  const physical = g2Physical(file, 'file', code);
  const stat = lstatSync(physical);
  requireThat(stat.size > 0 && stat.size <= 8 * 1024 * 1024 && stat.mtimeMs >= result.started && stat.mtimeMs <= result.ended, code);
  const bytes = readFileSync(physical);
  try {
    return { native: JSON.parse(text(bytes)), reportSha256: sha256(bytes), ...(retain && { reportBytes: bytes }) };
  } catch {
    requireThat(false, code);
  }
}
// Studio only: retain the same validated native buffers within the existing slot/output quota.
// The legacy caller never supplies a sink, and continues deleting native match reports.
function studioG3RawSink(cwd, stem, checkControl, budget) {
  const code = 'G3_SLOT_FAILED';
  requireThat(/^(?:[0-9]+-(?:original|neutral)|osv)$/.test(stem), code);
  const slot = g2Physical(cwd, 'dir', code), folder = path.join(slot, 'raw');
  if (!existsSync(folder)) mkdirSync(folder);
  requireThat(path.relative(slot, g2Physical(folder, 'dir', code)) === 'raw', code);
  return (buffers) => {
    checkControl();
    requireThat(shape(buffers, ['report', 'stdout', 'stderr']) && Object.values(buffers).every(Buffer.isBuffer)
      && buffers.report.length > 0 && buffers.report.length <= 8 * studioMiB
      && buffers.stdout.length + buffers.stderr.length <= 4 * studioMiB
      && Number.isSafeInteger(budget.bytes) && budget.bytes >= 0, code);
    const bytes = Object.values(buffers).reduce((sum, buffer) => sum + buffer.length, 0);
    requireThat(budget.bytes + bytes <= 16 * studioMiB, code);
    const refs = {};
    for (const role of ['report', 'stdout', 'stderr']) {
      const file = path.join(folder, stem + '.' + role + '.bin'), raw = buffers[role];
      writeFileSync(file, raw, { flag: 'wx' });
      refs[role] = { file, bytes: raw.length, sha256: sha256(raw) };
    }
    budget.bytes += bytes; checkControl(); return refs;
  };
}
function verifyStudioG3Raw(raw, cwd, stem, hashes) {
  const code = 'G3_RAW_CHANGED';
  requireThat(shape(raw, ['report', 'stdout', 'stderr']), code);
  let total = 0;
  for (const role of ['report', 'stdout', 'stderr']) {
    const ref = raw[role], expected = path.join(cwd, 'raw', stem + '.' + role + '.bin');
    requireThat(shape(ref, ['file', 'bytes', 'sha256']) && ref.file === expected && digest(ref.sha256)
      && ref.sha256 === hashes[role] && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0
      && ref.bytes <= (role === 'report' ? 8 : 4) * studioMiB, code);
    const bytes = studioReadBytes(studioPhysical(expected, 'file', code), ref.bytes, code);
    requireThat(bytes.length === ref.bytes && sha256(bytes) === ref.sha256, code); total += bytes.length;
  }
  return total;
}
function g3RunReport(tool, args, cwd, env, checkControl, maximum, file, validate, rawSink) {
  absentG2Path(file, 'G3_REPORT_REUSED');
  try {
    const result = g3Scanner(tool, args, cwd, env, checkControl, maximum);
    const { native, reportSha256, reportBytes } = readG3Report(file, result, Boolean(rawSink));
    const validated = validate(native, result);
    const raw = rawSink && validated.findings.length === 0
      ? rawSink({ report: reportBytes, stdout: result.stdout, stderr: result.stderr }) : null;
    return {
      ...validated, ...(raw && { raw }), reportSha256, exitCode: result.exitCode,
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
    return { findings: g3SecretFindings(native, result, target, relative, neutral) };
  });
}
function g3SecretFindings(native, result, target, relative, neutral) {
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
    return findings;
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
export function runG3OSV({ tool, locks, config, cwd, env, db, checkControl, file, recordCommand = false, rawSink }) {
  const args = ['scan', 'source', '--offline', '--no-resolve', '--no-call-analysis=all',
    '--config', config, '--format=json', '--all-packages', '--all-vulns', '--output-file', file,
    ...locks.flatMap((lock) => ['--lockfile', lock.file])];
  const result = g3RunReport(tool, args, cwd,
  { ...env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: db }, checkControl, 120_000, file, (native, result) => {
    verifyG3OSVDiagnostics(result, locks, db);
    return verifyG3OSVReport(native, locks, result.exitCode);
  }, rawSink);
  return recordCommand ? { ...result, command: { executable: tool, args, cwd } } : result;
}
export function g3NpmInventory(ref, lock, protectedRoots, studio) {
  const code = 'G3_INVENTORY_INVALID';
  const inventory = g2JSON(ref.path, ref.sha256, protectedRoots, code);
  requireThat(shape(inventory, ['schemaVersion', 'lockSha256', 'packages']) && inventory.schemaVersion === 1
    && inventory.lockSha256 === (studio ? studioG2Lock : g3PnpmSha256)
    && lock.sha256 === inventory.lockSha256
    && Array.isArray(inventory.packages) && inventory.packages.length === (studio ? 100 : 61), code);
  requireThat(new Set(inventory.packages.map((item) => {
    requireThat(shape(item, ['name', 'version']), code);
    return g3Identity('npm', item.name, item.version);
  })).size === (studio ? 100 : 61), code);
  if (studio) {
    requireThat(studio.studio === true && Buffer.isBuffer(studio.lockBytes) && sha256(studio.lockBytes) === studioG2Lock, code);
    const lines = text(studio.lockBytes).split('\n');
    const from = lines.indexOf('packages:');
    const to = lines.indexOf('snapshots:');
    requireThat(lines[0] === "lockfileVersion: '9.0'" && from > 0 && to > from
      && lines.filter((line) => line === 'packages:').length === 1
      && lines.filter((line) => line === 'snapshots:').length === 1, code);
    const packages = [];
    for (const line of lines.slice(from + 1, to)) {
      if (line === '' || /^ {4}/.test(line)) continue;
      const match = /^ {2}(?:'([^']+)'|([^ 	:'"]+)):$/.exec(line);
      requireThat(match, code);
      const key = match[1] ?? match[2], at = key.lastIndexOf('@');
      requireThat(at > 0, code);
      const row = { name: key.slice(0, at), version: key.slice(at + 1) };
      g3Identity('npm', row.name, row.version);
      packages.push(row);
    }
    const sort = (rows) => [...rows].sort((a, b) => {
      const x = g3Identity('npm', a.name, a.version), y = g3Identity('npm', b.name, b.version);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    requireThat(packages.length === 100 && isDeepStrictEqual(sort(packages), sort(inventory.packages)), code);
    return sort(packages);
  }
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
export function verifyStudioG3Handoff({ base, head, card, index, report }, studio) {
  const code = 'STUDIO_C3_HANDOFF_MISMATCH', execution = report.g2;
  requireThat(studio?.c2 && studio.c2.execution === execution && execution.base === base && execution.head === head
    && execution.tree === studio.studioSource?.candidate.tree && execution.assignmentRevision === card.assignmentRevision
    && execution.planSha256 === index.g2PlanSha256 && isDeepStrictEqual(report.studioSource, studio.studioSource)
    && ['write-set', 'imports', 'import-build-graph', 'format-types', 'windows', 'contracts'].every(id =>
      report.checks.some(row => row.id === id && row.status === 'passed' && row.exitCode === 0))
    && execution.studio?.inputs === 35 && execution.contracts?.pack === 'K07' && execution.contracts.ts?.count === 125
    && execution.contracts.dotnet?.count === 114 && execution.contracts.restoreLock?.packages === 13
    && execution.studio.rendererGraphSha256 === sha256(JSON.stringify(report.rendererGraph))
    && execution.studio.installedPackagesSha256 === studioG2PackageSha, code);
  studioG2Graph(report.rendererGraph, studio.studioSource, base, head);
  const expected = studio.c2.expectedBuild?.expected;
  requireThat(expected instanceof Map && expected.size === 17 && isDeepStrictEqual(execution.studio.outputs,
    Object.fromEntries([...expected].map(([name, item]) => [name, item.sha256]))), code);
  studioG2OutputFiles(report.rendererGraph, [...expected].map(([name, item]) => ({ name: name.slice(studioG2Dist.length), ...item })));
  return true;
}
export function buildStudioG3Snapshot(context, studio) {
  verifyStudioG3Handoff(context, studio);
  const code = 'STUDIO_C3_SOURCE_MISMATCH', { root, tree, snapshot, head, report } = context;
  requireThat(studio.upstream instanceof Map && studio.upstream.size === 235 && studio.notices instanceof Map
    && isDeepStrictEqual([...studio.notices.keys()].sort(), ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'TRADEMARK.md']), code);
  mkdirSync(snapshot);
  const tracked = g3SourceSnapshot(root, tree, path.join(snapshot, 'orange'),
    { studio: true, head, tree: report.g2.tree, pin: studioPolicy.pin });
  const entries = tracked.entries.map(row => ({ ...row, path: 'orange/' + row.path })), fonts = [];
  const put = (name, value) => {
    repositoryPath(name); const bytes = Buffer.from(value), decoded = text(bytes);
    requireThat(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded) && !/\.(?:zip|tar|gz|tgz|7z|rar|jar|nupkg|woff2)$/i.test(name), 'G3_SCOPE_UNSUPPORTED');
    const file = path.join(snapshot, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes, { flag: 'wx' });
    entries.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  };
  for (const [name, bytes] of studio.upstream) { requireThat(name.startsWith('packages/openfilm/'), code); put('openfilm/' + name, bytes); }
  for (const [name, bytes] of studio.notices) put('notices/' + name, bytes);
  const execution = report.g2, fontPrefix = 'node_modules/.pnpm/@fontsource-variable+inter@5.3.0/node_modules/@fontsource-variable/inter/';
  for (const [name, row] of studio.c2.expectedBuild.expected) {
    const file = g3CheckedBlob(path.join(execution.executionRoot, name), { ...row, path: name });
    const bytes = readFileSync(file), relative = 'build/' + name.slice(studioG2Dist.length);
    if (name.endsWith('.woff2')) {
      const matches = [...studio.c2.deps.files].filter(([source, asset]) => source.startsWith(fontPrefix)
        && source.endsWith('.woff2') && asset.bytes === row.bytes && asset.sha256 === row.sha256);
      requireThat(matches.length === 1 && bytes.subarray(0, 4).equals(Buffer.from('wOF2')), 'STUDIO_C3_FONT_MISMATCH');
      const [packagePath, asset] = matches[0];
      g3CheckedBlob(path.join(execution.executionRoot, packagePath), asset);
      fonts.push({ path: relative, packageFile: packagePath.slice(fontPrefix.length), bytes: row.bytes, sha256: row.sha256 });
    } else put(relative, bytes);
  }
  verifyStudioG3Coverage(entries, fonts);
  const totalBytes = entries.reduce((sum, row) => sum + row.bytes, 0);
  requireThat(totalBytes <= 64 * studioMiB, 'G3_SCOPE_UNSUPPORTED');
  verifyG3Snapshot(snapshot, entries);
  return { entries: entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), totalBytes, fonts };
}
function studioG3Notices(root, source, prior) {
  return withVerifiedStudioSource({ candidate: root, source }, studioPolicy, (proof, read, query) => {
    requireThat(isDeepStrictEqual(proof, prior), 'STUDIO_C3_SOURCE_MISMATCH');
    return new Map(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'TRADEMARK.md'].map(name => {
      const oid = text(query('STUDIO_C3_SOURCE_MISMATCH', 'rev-parse', studioPolicy.pin + ':' + name)).trimEnd();
      requireThat(exactSha(oid), 'STUDIO_C3_SOURCE_MISMATCH');
      const bytes = query('STUDIO_C3_SOURCE_MISMATCH', 'cat-file', 'blob', oid);
      requireThat(createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') === oid, 'STUDIO_C3_SOURCE_MISMATCH');
      return [name, bytes];
    }));
  }, true);
}

export function verifyStudioG3Coverage(entries, fonts) {
  const code = 'STUDIO_C3_COVERAGE_MISMATCH';
  requireThat(Array.isArray(entries) && entries.length === 322 && Array.isArray(fonts) && fonts.length === 7, code);
  const counts = { orange: 0, openfilm: 0, notices: 0, build: 0 }, names = new Set();
  for (const row of [...entries, ...fonts]) {
    requireThat(validG2Entry({ path: row.path, bytes: row.bytes, sha256: row.sha256 }), code);
    try { repositoryPath(row.path); } catch { requireThat(false, code); }
    requireThat(!names.has(fold(row.path)), code); names.add(fold(row.path));
  }
  for (const row of entries) {
    const category = row.path.split('/')[0];
    requireThat(Object.hasOwn(counts, category) && !/\.woff2$/i.test(row.path), code); counts[category]++;
  }
  requireThat(isDeepStrictEqual(counts, { orange: 74, openfilm: 235, notices: 3, build: 10 })
    && fonts.every((row) => row.path.startsWith('build/studio/assets/') && row.path.endsWith('.woff2')
      && typeof row.packageFile === 'string' && row.packageFile.startsWith('files/') && row.packageFile.endsWith('.woff2')), code);
  return { files: 322, scans: 644, fonts: 7 };
}
function studioG3SlotControl(data) {
  requireThat(Date.now() < data.deadline, 'G3_PLAN_EXPIRED');
  for (const [file, hash] of data.controls) requireThat(sha256(readFileSync(g2Physical(file, 'file', 'G3_CONTROL_CHANGED'))) === hash,
    'G3_CONTROL_CHANGED');
  requireThat(sha256(readFileSync(g2Physical(data.config, 'file', 'G3_CONFIG_CHANGED'))) === sha256(g3GitleaksConfig)
    && readdirSync(g2Physical(data.ignore, 'dir', 'G3_CONFIG_CHANGED')).length === 0, 'G3_CONFIG_CHANGED');
  return data.deadline - Date.now();
}
async function studioG3SlotScan(data, entry, target, neutral, rawBudget) {
  const tool = verifyG3Tool('gitleaks', data.ref, data.protectedRoots);
  const file = path.join(data.cwd, 'native-report.json'); absentG2Path(file, 'G3_REPORT_REUSED');
  const args = ['dir', neutral ? g3NeutralFile : target, '--config', data.config, '--gitleaks-ignore-path', data.ignore,
    '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color', '--log-level', 'error', '--timeout', '60',
    '--report-format', 'json', '--report-path', file];
  const started = Date.now(), until = Math.min(data.deadline, started + 70_000);
  studioG3SlotControl(data);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(tool, args, { cwd: data.cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = [], stderr = []; let size = 0, failed;
      const abort = (error) => { failed ??= error; child.kill(); };
      child.once('spawn', () => writeFileSync(path.join(data.cwd, 'activity.json'),
        JSON.stringify({ slot: data.number, rootPid: process.pid, scannerPid: child.pid, path: entry.path, neutral })));
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4 * studioMiB) abort(Object.assign(new Error('G3_SCANNER_FAILED'), { gateCode: 'G3_SCANNER_FAILED' }));
        else chunks.push(chunk);
      });
      const timer = setInterval(() => {
        try { studioG3SlotControl(data); requireThat(Date.now() < until, 'G3_SCANNER_FAILED'); }
        catch (error) { abort(error); }
      }, 25);
      child.once('error', (error) => { failed ??= Object.assign(error, { gateCode: 'G3_SCANNER_FAILED' }); });
      child.once('close', (status, signal) => {
        clearInterval(timer);
        if (failed) reject(failed);
        else if (signal || ![0, 1].includes(status)) reject(Object.assign(new Error('G3_SCANNER_FAILED'),
          { gateCode: 'G3_SCANNER_FAILED', scannerExitCode: status }));
        else resolve({ started, ended: Date.now(), exitCode: status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
    });
    studioG3SlotControl(data);
    const { native, reportSha256, reportBytes } = readG3Report(file, result, true);
    const findings = g3SecretFindings(native, result, target, entry.path, neutral);
    const ordinal = data.entries.indexOf(entry); requireThat(ordinal >= 0, 'G3_SLOT_UNTRUSTED');
    const raw = findings.length === 0 ? studioG3RawSink(data.cwd, ordinal + (neutral ? '-neutral' : '-original'),
      () => studioG3SlotControl(data), rawBudget)({ report: reportBytes, stdout: result.stdout, stderr: result.stderr }) : null;
    return { mode: neutral ? 'neutral-content' : 'original-path', inputSha256: entry.sha256, findings,
      reportSha256, ...(raw && { raw }), exitCode: result.exitCode, started: new Date(result.started).toISOString(), ended: new Date(result.ended).toISOString(),
      stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr), command: { executable: tool, args, cwd: data.cwd } };
  } finally { if (existsSync(file)) unlinkSync(file); }
}
async function studioG3Slot(file, expected) {
  const data = g2JSON(file, expected, [], 'G3_SLOT_UNTRUSTED');
  requireThat(shape(data, ['schemaVersion', 'number', 'cwd', 'snapshot', 'entries', 'ref', 'protectedRoots', 'controls',
    'deadline', 'runnerSha256', 'nodeSha256', 'config', 'ignore', 'audit']) && data.schemaVersion === 1
    && Number.isInteger(data.number) && data.number >= 0 && data.number < 4
    && path.relative(file, path.join(data.cwd, 'slot.json')) === ''
    && Number.isFinite(data.deadline) && data.deadline - Date.now() <= 300_000
    && Array.isArray(data.controls) && data.controls.length >= 1 && data.controls.length <= 3
    && data.controls.every((pair) => Array.isArray(pair) && pair.length === 2 && studioAbsolute(pair[0]) && digest(pair[1]))
    && Array.isArray(data.entries) && data.entries.length > 0 && data.entries.length <= 322
    && new Set(data.entries.map(({ path: name }) => fold(name))).size === data.entries.length
    && data.entries.every((row) => validG2Entry({ path: row.path, bytes: row.bytes, sha256: row.sha256 }))
    && sha256(readFileSync(fileURLToPath(import.meta.url))) === data.runnerSha256
    && sha256(readFileSync(process.execPath)) === data.nodeSha256 && process.version === 'v24.22.1'
    && path.relative(data.config, path.join(data.cwd, 'gitleaks.toml')) === ''
    && path.relative(data.ignore, path.join(data.cwd, 'empty-ignore')) === '', 'G3_SLOT_UNTRUSTED');
  g2Physical(data.cwd, 'dir', 'G3_SLOT_UNTRUSTED');
  studioG3SlotControl(data);
  const rawBudget = { bytes: 0 };
  if (data.audit) {
    const code = 'G3_INVENTORY_INVALID', audit = data.audit;
    requireThat(shape(audit, ['locks', 'db', 'database']) && Array.isArray(audit.locks) && audit.locks.length === 2
      && audit.locks.every((lock, i) => shape(lock, ['file', 'ecosystem', 'packages', 'sha256'])
        && lock.ecosystem === (i === 0 ? 'npm' : 'NuGet') && lock.packages.length === (i === 0 ? 100 : 13) && digest(lock.sha256))
      && path.relative(audit.locks[0].file, path.join(data.snapshot, 'orange/pnpm-lock.yaml')) === ''
      && path.relative(audit.locks[1].file, path.join(path.dirname(data.cwd), 'packages.lock.json')) === '', code);
    const config = path.join(data.cwd, 'osv.toml'); writeFileSync(config, '', { flag: 'wx' });
    const control = () => {
      studioG3SlotControl(data);
      requireThat(lstatSync(g2Physical(config, 'file', 'G3_CONFIG_CHANGED')).size === 0, 'G3_CONFIG_CHANGED');
      for (const lock of audit.locks) requireThat(sha256(readFileSync(g2Physical(lock.file, 'file', code))) === lock.sha256, code);
      return data.deadline - Date.now();
    };
    const tool = verifyG3Tool('osv', data.ref, data.protectedRoots);
    const version = g3Version('osv', tool, data.cwd, process.env, control);
    verifyG3DatabaseCopy(audit.db, audit.database);
    const evidence = runG3OSV({ tool, locks: audit.locks, config, cwd: data.cwd, env: process.env, db: audit.db,
      checkControl: control, file: path.join(data.cwd, 'osv.json'), recordCommand: true,
      rawSink: studioG3RawSink(data.cwd, 'osv', control, rawBudget) });
    requireThat(evidence.findings.length === 0, 'G3_VULNERABILITIES_FOUND');
    verifyG3DatabaseCopy(audit.db, audit.database); verifyG3Tool('osv', data.ref, data.protectedRoots); control();
    return { slot: data.number, rows: [{ audit: { ...evidence, tool: version } }], tool: version };
  }
  const version = g3Version('gitleaks', verifyG3Tool('gitleaks', data.ref, data.protectedRoots), data.cwd, process.env,
    () => studioG3SlotControl(data));
  const rows = [], snapshot = path.join(data.cwd, 'snapshot'); mkdirSync(snapshot);
  for (const entry of data.entries) {
    repositoryPath(entry.path);
    const source = g3SnapshotFile(data.snapshot, entry), target = path.join(snapshot, entry.path);
    mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, readFileSync(source), { flag: 'wx' });
    g3CheckedBlob(target, entry);
    const original = await studioG3SlotScan(data, entry, target, false, rawBudget), neutral = path.join(data.cwd, g3NeutralFile);
    absentG2Path(neutral, 'G3_TEMP_REUSED'); writeFileSync(neutral, readFileSync(target), { flag: 'wx' });
    let content;
    try {
      g3CheckedBlob(neutral, entry); content = await studioG3SlotScan(data, entry, neutral, true, rawBudget); g3CheckedBlob(neutral, entry);
    } finally { if (existsSync(neutral)) unlinkSync(neutral); }
    g3CheckedBlob(target, entry); g3SnapshotFile(data.snapshot, entry);
    const scans = [original, content], findings = [...new Map(scans.flatMap((scan) => scan.findings)
      .map((finding) => [JSON.stringify(finding), finding])).values()];
    const receipt = { ...entry, scans, findings }; rows.push(receipt);
    if (findings.length) throw Object.assign(new Error('G3_SECRET_FOUND'), { gateCode: 'G3_SECRET_FOUND', receipt });
  }
  verifyG3Snapshot(snapshot, data.entries); studioG3SlotControl(data);
  return { slot: data.number, rows, tool: version };
}
async function studioG3FailedCleanup(owner, deadline, until) {
  const activityFile = path.join(owner.command.cwd, 'activity.json');
  const activity = { file: activityFile, available: false, sha256: null };
  const positivePid = value => Number.isSafeInteger(value) && value > 0;
  const pids = new Set(positivePid(owner.pid) ? [owner.pid] : []);
  let descendants = 0, identityValid = true;
  if (positivePid(owner.nativeChild?.pid)) { pids.add(owner.nativeChild.pid); descendants++; }
  try {
    const raw = studioReadBytes(studioPhysical(activityFile, 'file', 'G3_CLEANUP_ACTIVITY_UNAVAILABLE'), 4096, 'G3_CLEANUP_ACTIVITY_UNAVAILABLE');
    activity.sha256 = sha256(raw);
    const value = JSON.parse(text(raw));
    requireThat(shape(value, ['slot', 'rootPid', 'scannerPid', 'path', 'neutral']) && value.slot === owner.slot
      && positivePid(value.rootPid) && positivePid(value.scannerPid), 'G3_CLEANUP_ACTIVITY_INVALID');
    requireThat(!positivePid(owner.nativeChild?.pid) || value.rootPid === owner.nativeChild.pid, 'G3_CLEANUP_ACTIVITY_INVALID');
    activity.available = true; activity.rootPid = value.rootPid; activity.scannerPid = value.scannerPid;
    pids.add(value.rootPid); pids.add(value.scannerPid); descendants++;
  } catch (error) {
    activity.reason = error.gateCode ?? error.code ?? 'G3_CLEANUP_ACTIVITY_INVALID';
    if (activity.sha256) identityValid = false;
  }
  let observations = [];
  do {
    observations = [...pids].map(pid => {
      let state = 'alive', code;
      try { process.kill(pid, 0); }
      catch (error) { state = error.code === 'ESRCH' ? 'exited' : 'unqueryable'; code = error.code; }
      return { pid, state, ...(code && { code }), observedAt: new Date().toISOString() };
    });
    if (observations.every(row => row.state !== 'alive') || Date.now() >= until) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < until);
  const raw = [];
  for (const [file, expected] of [[owner.stdoutFile, owner.stdoutSha256], [owner.stderrFile, owner.stderrSha256]]) {
    const row = { file, sha256: null, matchesOwnerCloseHash: false };
    try {
      const bytes = studioReadBytes(studioPhysical(file, 'file', 'G3_CLEANUP_RAW_UNAVAILABLE'), 16 * studioMiB, 'G3_CLEANUP_RAW_UNAVAILABLE');
      row.sha256 = sha256(bytes); row.matchesOwnerCloseHash = row.sha256 === expected;
    } catch (error) { row.reason = error.gateCode ?? error.code ?? 'G3_CLEANUP_RAW_UNAVAILABLE'; }
    raw.push(row);
  }
  try {
    const bytes = studioReadBytes(studioPhysical(activityFile, 'file', 'G3_CLEANUP_ACTIVITY_UNAVAILABLE'), 4096, 'G3_CLEANUP_ACTIVITY_UNAVAILABLE');
    activity.finalSha256 = sha256(bytes);
    if (activity.finalSha256 !== activity.sha256) identityValid = false;
  } catch { if (activity.available) identityValid = false; }
  const knownExited = descendants > 0 && observations.length > 0 && observations.every(row => row.state === 'exited');
  const drainWitness = positivePid(owner.nativeChild?.pid) && owner.nativeChild.activeAfter === 0;
  const confirmed = identityValid && raw.every(row => row.matchesOwnerCloseHash) && knownExited;
  return { status: confirmed ? drainWitness ? 'confirmed-owner-drain' : 'observed-known-pids-exited' : 'cleanup-unconfirmed',
    originalDeadline: deadline, cleanupOnlyUntil: until, observationBudgetMs: 4000, newExecutionAuthority: false,
    scope: drainWitness ? 'original fixed owner Job accounting plus known PID observations' : 'known bound PIDs only; no activeAfter inferred',
    activity, raw, observations, actualNativeDrainRecorded: drainWitness, resourceReleaseAllowed: false,
    controllerAction: 'Controller must review bound terminal/ownership evidence and confirm cleanup before releasing or reusing failed-run resources.' };
}

export async function runStudioG3Workers({ entries, snapshot, output, ref, protectedRoots, checkControl, controls, deadline,
  job, tools, audit = null, workers = Math.min(4, availableParallelism()) }) {
  checkControl();
  requireThat(Number.isInteger(workers) && workers >= 1 && workers <= 4 && workers <= availableParallelism()
    && freemem() >= workers * 256 * studioMiB && entries.length > 0 && entries.length <= 322, 'G3_CAPACITY_UNAVAILABLE');
  verifyG3Snapshot(snapshot, entries); verifyG3Tool(audit ? 'osv' : 'gitleaks', ref, protectedRoots);
  requireThat(!audit || workers === 1, 'G3_SLOT_UNTRUSTED');
  requireThat(Number.isFinite(deadline) && deadline > Date.now() && deadline - Date.now() <= 300_000
    && Array.isArray(controls) && controls.length >= 1 && controls.length <= 3, 'G3_SLOT_UNTRUSTED');
  verifyStudioG2JobHost(tools); verifyStudioG2JobFiles(job.folder, job.files);
  requireThat(path.relative(tools.node, process.execPath) === '' && process.version === 'v24.22.1', 'G3_SLOT_UNTRUSTED');
  const runner = fileURLToPath(import.meta.url), runnerSha256 = sha256(readFileSync(runner)), nodeSha256 = sha256(readFileSync(tools.node));
  const handles = new Set(), owners = [], tasks = []; let failure;
  const cancel = (error) => { failure ??= error; for (const child of handles) child.kill(); };
  const timer = setInterval(() => {
    try { checkControl(); requireThat(Date.now() < deadline, 'G3_PLAN_EXPIRED'); }
    catch (error) { cancel(error); }
  }, 25);
  try {
    for (let number = 0; number < Math.min(workers, entries.length); number++) {
      checkControl();
      const cwd = path.join(output, 'slot-' + number); mkdirSync(cwd);
      const config = path.join(cwd, 'gitleaks.toml'), ignore = path.join(cwd, 'empty-ignore');
      writeFileSync(config, g3GitleaksConfig, { flag: 'wx' }); mkdirSync(ignore);
      for (const name of ['tmp', 'home']) mkdirSync(path.join(cwd, name));
      const data = { schemaVersion: 1, number, cwd, snapshot,
        entries: entries.filter((_, i) => i % Math.min(workers, entries.length) === number), ref, protectedRoots, controls, deadline,
        runnerSha256, nodeSha256, config, ignore, audit: audit && { ...audit, locks: audit.locks.map(lock =>
          ({ ...lock, sha256: sha256(readFileSync(g2Physical(lock.file, 'file', 'G3_INVENTORY_INVALID'))) })) } };
      const input = path.join(cwd, 'slot.json'), raw = JSON.stringify(data); writeFileSync(input, raw, { flag: 'wx' });
      const args = ['exec', '--runtimeconfig', job.config, job.dll, String(deadline), tools.node, String(controls.length),
        ...controls.flat(), runner, '--studio-c3-scan-slot', input, sha256(raw)];
      const env = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', GOMAXPROCS: '1', DOTNET_ROOT: path.dirname(tools.dotnet),
        TEMP: path.join(cwd, 'tmp'), TMP: path.join(cwd, 'tmp'), HOME: path.join(cwd, 'home'), USERPROFILE: path.join(cwd, 'home'),
        APPDATA: path.join(cwd, 'home'), LOCALAPPDATA: path.join(cwd, 'home') };
      const stdoutFile = path.join(cwd, 'stdout.json'), stderrFile = path.join(cwd, 'stderr.log');
      const outFd = openSync(stdoutFile, 'wx'), errFd = openSync(stderrFile, 'wx');
      tasks.push(new Promise((resolve, reject) => {
        let child;
        try { child = spawn(tools.dotnet, args, { cwd, env, windowsHide: true, detached: true, stdio: ['ignore', outFd, errFd] }); }
        catch (reason) { cancel(reason); reject(reason); return; }
        finally { closeSync(outFd); closeSync(errFd); }
        handles.add(child);
        let error;
        const record = { slot: number, command: { executable: tools.dotnet, args, cwd },
          stdoutFile, stderrFile, started: new Date().toISOString() };
        owners.push(record);
        child.once('spawn', () => {
          try { writeFileSync(path.join(cwd, 'owner-pid.json'), JSON.stringify({ pid: child.pid, deadline })); }
          catch (reason) { error = reason; cancel(reason); }
        });
        const sizeGuard = setInterval(() => {
          try { requireThat(lstatSync(stdoutFile).size + lstatSync(stderrFile).size <= 16 * studioMiB, 'G3_SLOT_FAILED'); }
          catch (reason) { error = reason; cancel(reason); }
        }, 25);
        child.once('error', (reason) => { error = Object.assign(reason, { gateCode: 'G3_SLOT_FAILED' }); cancel(error); });
        child.once('close', (status, signal) => {
          clearInterval(sizeGuard); handles.delete(child);
          Object.assign(record, { ended: new Date().toISOString(), pid: child.pid, exitCode: status, signal, nativeChild: null });
          // Re-check the actual authority before parsing a possibly interrupted worker stdout.
          // Keep only a real control/deadline failure; never relabel arbitrary parse errors.
          try { checkControl(); requireThat(Date.now() < deadline, 'G3_PLAN_EXPIRED'); }
          catch (reason) { error ??= reason; }
          try {
            const out = readFileSync(g2Physical(stdoutFile, 'file', 'G3_REPORT_INVALID'));
            const err = readFileSync(g2Physical(stderrFile, 'file', 'G3_REPORT_INVALID'));
            requireThat(out.length + err.length <= 16 * studioMiB, 'G3_SLOT_FAILED');
            Object.assign(record, { stdoutSha256: sha256(out), stderrSha256: sha256(err), stdoutBytes: out.length, stderrBytes: err.length });
            const metadata = /\n\[studio-c2-child\] (\{[^\r\n]+\})\r?\n$/.exec(text(err));
            record.nativeChild = metadata && JSON.parse(metadata[1]);
            const value = JSON.parse(text(out));
            if (status !== 0) record.failure = value;
            requireThat(!error && status === 0 && !signal && record.nativeChild?.status === 0 && record.nativeChild.stopped === null
              && record.nativeChild.activeBefore === 0 && record.nativeChild.activeAfter === 0
              && isDeepStrictEqual(value.tool, { version: g3Tools[audit ? 'osv' : 'gitleaks'].version, sha256: ref.sha256 })
              && shape(value, ['slot', 'rows', 'tool']) && value.slot === number && Array.isArray(value.rows)
              && value.rows.length === (audit ? 1 : data.entries.length), value?.code ?? 'G3_SLOT_FAILED');
            let nativeBytes = 0;
            if (audit) {
              const row = value.rows[0].audit;
              nativeBytes += verifyStudioG3Raw(row.raw, cwd, 'osv',
                { report: row.reportSha256, stdout: row.stdoutSha256, stderr: row.stderrSha256 });
            } else value.rows.forEach((row, ordinal) => {
              requireThat(row.path === data.entries[ordinal].path && row.scans?.length === 2, 'G3_SLOT_FAILED');
              row.scans.forEach((scan, mode) => { nativeBytes += verifyStudioG3Raw(scan.raw, cwd,
                ordinal + (mode ? '-neutral' : '-original'),
                { report: scan.reportSha256, stdout: scan.stdoutSha256, stderr: scan.stderrSha256 }); });
            });
            requireThat(nativeBytes + out.length + err.length <= 16 * studioMiB, 'G3_SLOT_FAILED');
            Object.assign(record, { tool: value.tool, nativeBytes, ioBytes: nativeBytes + out.length + err.length }); resolve(value.rows);
          } catch (reason) { cancel(error ?? reason); reject(error ?? reason); }
        });
      }));
    }
    const settled = await Promise.allSettled(tasks);
    if (failure) throw Object.assign(failure, { owners });
    requireThat(settled.every(({ status }) => status === 'fulfilled'), 'G3_SLOT_FAILED');
    if (audit) {
      checkControl(); requireThat(Date.now() < deadline, 'G3_PLAN_EXPIRED');
      return { audit: settled[0].value[0].audit, owners };
    }
    const rows = settled.flatMap(({ value }) => value).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    requireThat(rows.length === entries.length && new Set(rows.map(({ path: name }) => name)).size === entries.length
      && rows.every((row) => { const entry = entries.find((item) => item.path === row.path);
        return entry && entry.bytes === row.bytes && entry.sha256 === row.sha256 && row.findings.length === 0
          && row.scans.length === 2 && row.scans.every((scan, i) => scan.mode === (i ? 'neutral-content' : 'original-path')
            && scan.inputSha256 === entry.sha256 && scan.findings.length === 0 && scan.exitCode === 0); }), 'G3_SLOT_FAILED');
    verifyG3Snapshot(snapshot, entries); verifyStudioG2JobHost(tools); verifyStudioG2JobFiles(job.folder, job.files);
    checkControl(); requireThat(Date.now() < deadline, 'G3_PLAN_EXPIRED'); return Object.assign(rows, { owners });
  } catch (error) {
    cancel(error); await Promise.allSettled(tasks);
    const cleanupUntil = Date.now() + 4000; // Observation only, not renewed execution authority.
    await Promise.all(owners.map(async owner => { owner.cleanup = await studioG3FailedCleanup(owner, deadline, cleanupUntil); }));
    throw Object.assign(error, { owners });
  } finally { clearInterval(timer); }
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
async function studioG3Stage(check, run) {
  try { const result = await run(); Object.assign(check, { exitCode: 0, status: 'passed' }); return result; }
  catch (error) { Object.assign(check, { exitCode: 1, status: 'failed', code: error.gateCode ?? 'GATE_ERROR' }); throw error; }
}
async function runStudioG3(planFile, context, studio) {
  const { root, common, tree, card, index, cardFile, indexFile, base, head, report } = context;
  const selected = id => report.checks.find(row => row.id === id);
  const plan = g3LoadPlan(planFile, context);
  const protectedInputs = [...studio.protectedRoots, report.g2.executionRoot, report.g2.outputRoot];
  const output = g2ScratchRoot(plan.outputRoot, protectedInputs, 'G3_OUTPUT_UNSAFE');
  requireThat(fold(path.parse(output).root) === 'd:\\', 'G3_OUTPUT_UNSAFE');
  const protectedRoots = [...protectedInputs, output];
  for (const file of [planFile, cardFile, indexFile]) requireThat(protectedRoots.every(location =>
    !contained(location, realpathSync.native(file))), 'G3_PLAN_UNTRUSTED');
  const controls = [[cardFile, sha256(readFileSync(cardFile))], [indexFile, sha256(readFileSync(indexFile))],
    [path.resolve(planFile), index.g3PlanSha256]];
  const deadline = Math.min(Date.parse(plan.validUntil), Date.parse(index.validUntil), studio.c2.deadline);
  const checkControl = () => {
    const remaining = Math.min(verifyG3Control({ planFile, index, card, cardFile, indexFile, protectedRoots }), deadline - Date.now());
    requireThat(remaining > 0, 'G3_PLAN_EXPIRED'); return remaining;
  };
  const fresh = () => {
    checkControl(); studio.c2.guard(); studio.freshC1(); verifyStudioG3Handoff(context, studio); checkControl();
  };
  fresh();
  const snapshot = path.join(output, 'snapshot');
  const material = buildStudioG3Snapshot({ ...context, snapshot }, studio), { entries, fonts, totalBytes } = material;
  let verifiedAudit, verifiedTools;
  const sourceManifest = sha256(JSON.stringify([...studio.upstream].map(([name, bytes]) => [name, bytes.length, sha256(bytes)])));
  const secret = { files: 322, scans: 644, totalBytes, manifestSha256: sha256(JSON.stringify(entries)),
    unscanned: 322, receipts: [], fontProvenance: fonts, owners: [] };
  report.g3 = { mode: 'studio-c3-offline', base, head, tree: plan.tree, assignmentRevision: card.assignmentRevision,
    planSha256: index.g3PlanSha256, outputRoot: output, deadline: new Date(deadline).toISOString(),
    c1GraphSha256: sha256(JSON.stringify(report.rendererGraph)), c2PlanSha256: report.g2.planSha256,
    sourceManifestSha256: sourceManifest, secret };
  await studioG3Stage(selected('secret-scan'), async () => {
    try {
      const rows = await runStudioG3Workers({ entries, snapshot, output, ref: plan.tools.gitleaks, protectedRoots,
        checkControl, controls, deadline, job: studio.c2.job, tools: studio.c2.tools });
      secret.receipts = rows; secret.owners = rows.owners; secret.unscanned = 0; secret.tool = rows.owners[0].tool;
    } catch (error) { secret.owners = error.owners ?? []; throw error; }
    verifyG3Snapshot(snapshot, entries); fresh();
  });
  await studioG3Stage(selected('dependency-audit'), async () => {
    fresh();
    const admitted = entries.find(row => row.path === 'orange/pnpm-lock.yaml'), pnpm = g3SnapshotFile(snapshot, admitted);
    const npm = g3NpmInventory(plan.pnpmInventory, admitted, protectedRoots, { studio: true, lockBytes: readFileSync(pnpm) });
    const native = readG3NativeLock(report.g2, { base, head, tree: plan.tree, assignmentRevision: card.assignmentRevision });
    const auditOutput = path.join(output, 'audit'); mkdirSync(auditOutput);
    const nuget = path.join(auditOutput, 'packages.lock.json'); writeFileSync(nuget, native.bytes, { flag: 'wx' });
    const db = path.join(auditOutput, 'db'), database = materializeG3Database(plan.database, db, protectedRoots);
    const locks = [{ file: pnpm, ecosystem: 'npm', packages: npm }, { file: nuget, ecosystem: 'NuGet', packages: native.packages }];
    let audit;
    try {
      audit = await runStudioG3Workers({ entries, snapshot, output: auditOutput, ref: plan.tools.osv, protectedRoots,
        checkControl, controls, deadline, job: studio.c2.job, tools: studio.c2.tools, workers: 1, audit: { locks, db, database } });
    } catch (error) {
      report.g3.dependencies = { owners: error.owners ?? [], database, pnpm: admitted,
        pnpmInventorySha256: plan.pnpmInventory.sha256, native: { project: native.project, lockSha256: native.lockSha256 } };
      throw error;
    }
    report.g3.dependencies = { ...audit.audit, owners: audit.owners, database, configSha256: sha256(''), pnpm: admitted,
      pnpmInventorySha256: plan.pnpmInventory.sha256, native: { project: native.project, lockSha256: native.lockSha256 } };
    requireThat(audit.audit.sources.length === 2 && audit.audit.sources.some(row => row.ecosystem === 'npm' && row.count === 100)
      && audit.audit.sources.some(row => row.ecosystem === 'NuGet' && row.count === 13) && audit.audit.findings.length === 0, 'G3_OSV_INVALID');
    verifyG3DatabaseCopy(db, database);
    verifiedTools = { osv: verifyG3Tool('osv', plan.tools.osv, protectedRoots),
      gitleaks: verifyG3Tool('gitleaks', plan.tools.gitleaks, protectedRoots) };
    requireThat(sha256(readFileSync(nuget)) === native.lockSha256, 'G3_NUGET_HANDOFF');
    readG3NativeLock(report.g2, { base, head, tree: plan.tree, assignmentRevision: card.assignmentRevision });
    g3NpmInventory(plan.pnpmInventory, admitted, protectedRoots, { studio: true, lockBytes: readFileSync(pnpm) });
    verifyG3Snapshot(snapshot, entries); fresh();
    verifiedAudit = { npm, native, database, db, nuget, admitted, locks };
  });
  checkControl();
  const continuation = { plan, planFile, entries, fonts, snapshot, tools: verifiedTools, audit: verifiedAudit, checkControl, guard: () => {
    fresh(); verifyG3Snapshot(snapshot, entries);
    verifyG3DatabaseCopy(verifiedAudit.db, verifiedAudit.database);
    requireThat(verifyG3Tool('osv', plan.tools.osv, protectedRoots) === verifiedTools.osv
      && verifyG3Tool('gitleaks', plan.tools.gitleaks, protectedRoots) === verifiedTools.gitleaks, 'G3_TOOL_UNTRUSTED');
    requireThat(sha256(readFileSync(g2Physical(verifiedAudit.nuget, 'file', 'G3_NUGET_HANDOFF')))
      === verifiedAudit.native.lockSha256, 'G3_NUGET_HANDOFF');
    g3NpmInventory(plan.pnpmInventory, verifiedAudit.admitted, protectedRoots,
      { studio: true, lockBytes: readFileSync(g3SnapshotFile(snapshot, verifiedAudit.admitted)) });
    studioG4RawGuard(continuation, report); checkControl();
  } };
  studioG4Continuations.add(continuation); return continuation;
}


function runStudioG4(reviewFile, context, studio, c3) {
  const { report, index, root, common, tree, card, studioSource } = context;
  requireThat(studioG4Continuations.has(c3), 'G4_INPUTS_UNAVAILABLE');
  const started = Date.now(), reviewCheck = report.checks.find(row => row.id === 'independent-review');
  const extraRoots = [...studio.protectedRoots, studio.c2.execution.executionRoot, studio.c2.execution.outputRoot, c3.plan.outputRoot];
  const review = reviewFile ? loadG4Review(reviewFile, context, extraRoots) : null;
  if (review) requireThat(index.reviewApproval.scopeKind === 'integration' && review.subject.scopeKind === 'integration', 'G4_REVIEW_STALE');
  const controls = () => {
    studio.c2.checkControl(true); c3.checkControl();
    if (review) requireThat(isDeepStrictEqual(loadG4Review(reviewFile, context, extraRoots), review), 'G4_REVIEW_STALE');
  };
  const fresh = () => {
    controls(); c3.guard(); assertIndexFresh(index);
    requireThat(path.relative(linkedWorktree(card).common, common) === '', 'WORKTREE_MISMATCH');
    verifyIndex(root, tree); verifyCheckout(root, tree, [], studioSource);
    controls();
  };
  // Same in-process validated values; neither reports nor author metadata can mint this continuation.
  const closure = studioG4Projection(context, studio, c3);
  report.studioClosure = closure;
  if (!review) {
    fresh();
    report.studioRunEvidence = studioG4RunEvidence(context, studio, c3, closure, null);
    controls();
    report.studioC4Work = { started: new Date(started).toISOString(), elapsedMs: Date.now() - started,
      originalDeadline: report.g3.deadline, remainingMs: c3.plan ? Date.parse(report.g3.deadline) - Date.now() : 0 };
    report.code = 'STUDIO_C4_REQUIRED'; return;
  }
  let observedInputs;
  stage(reviewCheck, () => {
    fresh();
    observedInputs = studioG4Projection(context, studio, c3).inputsSha256;
    requireThat(observedInputs === closure.inputsSha256 && observedInputs === review.subject.inputsSha256, 'G4_INPUTS_STALE');
    report.independentReview = { subject: review.subject, reviewerId: review.reviewerId,
      specs: review.specs, quality: review.quality, evidenceSha256: review.evidenceSha256 };
  });
  requireThat(g4DecideCandidate(report.checks, review.subject.inputsSha256, observedInputs), 'G4_INPUTS_STALE');
  fresh();
  requireThat(studioG4Projection(context, studio, c3).inputsSha256 === observedInputs, 'G4_INPUTS_STALE');
  report.studioRunEvidence = studioG4RunEvidence(context, studio, c3, closure, { file: reviewFile });
  controls();
  report.studioC4Work = { started: new Date(started).toISOString(), elapsedMs: Date.now() - started,
    originalDeadline: report.g3.deadline, remainingMs: Date.parse(report.g3.deadline) - Date.now() };
  requireThat(report.studioC4Work.remainingMs > 0, 'G3_PLAN_EXPIRED');
  Object.assign(report, { code: 'CANDIDATE_CHECKS_PASSED', admitted: true });
}

async function evaluate(args, report) {
  const flags = parseArgs(args, ['--base', '--head', '--card'],
    ['--trusted-typescript', ...rendererGraphFlags, '--trusted-g2-plan', '--trusted-g3-plan', '--trusted-review', '--trusted-studio-source']);
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
  const { root, common, tree, index, card, studioSource, studioScope } = stage(checks[0], () => {
    const { card, index } = loadApproval(cardFile, indexFile);
    requireThat(card.workingBaselineCommit === base && card.headCommit === head, 'CARD_STALE');
    const { root, common } = linkedWorktree(card);
    requireThat(path.relative(root, realpathSync.native(process.cwd())) === '', 'WORKTREE_MISMATCH');
    const trustedRoot = realpathSync.native(fileURLToPath(new URL('../..', import.meta.url)));
    requireThat(!contained(root, trustedRoot), 'GATE_SELF_EXECUTION');
    const { tree, studioSource, studioScope } = withCandidateHistory(root, common, head, (query) => {
      const studio = studioCandidateSubject(query, head);
      requireThat(studio || !flags['--trusted-studio-source'] && index.studioRendererApproval === undefined,
        'STUDIO_CANDIDATE_ANCESTRY_MISMATCH');
      verifyCandidateBaseline(query, card);
      const treeOid = studio ? text(query('GIT_FAILED', 'rev-parse', head + '^{tree}')).trimEnd() : undefined;
      const studioSource = studio ? verifyStudioCandidate(root, common, head, treeOid, flags['--trusted-studio-source']) : undefined;
      const studioScope = studioSource ? [] : undefined;
      const changes = changedPaths(query, linearCommits(query, base, head), studioSource, studioScope);
      report.changedFiles = changes;
      requireThat(changes.length > 0, 'EMPTY_CANDIDATE');
      const allowed = new Set(card.writeSet);
      requireThat(changes.every((name) => allowed.has(name)), 'WRITE_SET_VIOLATION');
      const tree = readCandidateTree(query, head);
      rejectAliases([...new Set([...tree.keys(), ...changes])]);
      return { tree, studioSource, studioScope };
    });
    verifyIndex(root, tree);
    verifyCheckout(root, tree, [], studioSource);
    if (studioSource) {
      requireThat(isDeepStrictEqual(loadApproval(cardFile, indexFile), { card, index })
        && path.relative(linkedWorktree(card).common, common) === '', 'CARD_STALE');
    }
    return { root, common, tree, index, card, studioSource, studioScope };
  });
  if (studioSource) {
    report.studioSource = studioSource;
    const graph = checks.find(({ id }) => id === 'import-build-graph');
    const source = flags['--trusted-studio-source'];
    const sourceRepo = studioRepo(source);
    const trustedRoot = realpathSync.native(fileURLToPath(new URL('../..', import.meta.url)));
    const subject = { base, head, tree: studioSource.candidate.tree,
      sourceHead: studioSource.sourceReference.commit, sourceTree: studioSource.sourceReference.tree };
    const protectedRoots = [root, common, trustedRoot, sourceRepo.root, sourceRepo.common];
    const g2PlanFile = flags['--trusted-g2-plan'];
    const controls = g2PlanFile && { cardSha256: sha256(readFileSync(cardFile)), indexSha256: sha256(readFileSync(indexFile)) };
    const readInputs = () => loadStudioRendererInputs(flags, protectedRoots, subject, index.studioRendererApproval);
    const inputs = stage(graph, () => {
      requireThat(studioRendererRequested(flags), studioDualGraphRequired);
      return readInputs();
    });
    // Setup is not a graph pass. The check remains unavailable until the two
    // final-byte builds and all post-run controls pass together.
    Object.assign(graph, { status: 'unavailable', exitCode: null });
    const parser = stage(checks[1], () => {
      const parser = loadImportParser(root, inputs.parserPath);
      requireThat(parser, 'GRAPH_PARSER_REQUIRED');
      report.importParser = parser.provenance;
      return parser;
    });
    Object.assign(checks[1], { status: 'not-run', exitCode: null });
    const projection = stage(checks[1], () => {
      const { orange, upstream } = studioRendererProjection(root, tree, source, studioSource, inputs.profile);
      return { orange, upstream, staticProof: verifyStudioRendererStatic(parser, orange, upstream) };
    });
    stage(graph, () => {
      const fresh = () => {
        assertIndexFresh(index);
        requireThat(isDeepStrictEqual(loadApproval(cardFile, indexFile), { card, index })
          && path.relative(linkedWorktree(card).common, common) === '', 'CARD_STALE');
        verifyIndex(root, tree);
        verifyCheckout(root, tree, [], studioSource);
      };
      fresh();
      const result = runStudioRendererGraph(inputs, projection.orange, projection.upstream, projection.staticProof);
      requireThat(isDeepStrictEqual(readInputs(), inputs), 'STUDIO_C1_CONTROL_DRIFT');
      loadImportParser(root, inputs.parserPath);
      requireThat(isDeepStrictEqual(verifyStudioCandidate(root, common, head, subject.tree, source, true), studioSource),
        'STUDIO_C1_SOURCE_MISMATCH');
      fresh();
      report.rendererGraph = { ...result, source: { ...result.source, pack: studioPolicy.pack } };
    });
    if (!g2PlanFile) {
      report.code = 'STUDIO_C2_REQUIRED';
      return;
    }
    const freshC1 = () => {
      requireThat(isDeepStrictEqual(readInputs(), inputs), 'STUDIO_C1_CONTROL_DRIFT');
      const parser = g2Physical(inputs.parserPath, 'file', 'GRAPH_PARSER_REQUIRED', false);
      requireThat(sha256(readFileSync(parser)) === report.rendererGraph.staticProof.parserSha256, 'STUDIO_C1_CONTROL_DRIFT');
      const code = 'STUDIO_C2_SOURCE_MISMATCH';
      requireThat(isDeepStrictEqual(studioRepo(source), sourceRepo)
        && studioRead(path.join(sourceRepo.common, 'shallow'), code) === studioPolicy.pin + '\n', code);
      const { pack: store } = studioObjectStore(sourceRepo.common);
      const pack = studioPolicy.pack;
      requireThat(store, code);
      for (const [extension, bytes, expected] of [
        ['idx', pack.indexBytes, pack.indexSha256], ['pack', pack.packBytes, pack.packSha256],
      ]) {
        const file = studioPhysical(path.join(store, pack.stem + '.' + extension), 'file', code);
        requireThat(file.stat.size === bytes && sha256(studioReadBytes(file, bytes, code)) === expected, code);
      }
    };
    const c2 = runG2(g2PlanFile, { root, common, tree, card, index, cardFile, indexFile, base, head, report, studio: {
      studioSource, upstream: projection.upstream, freshC1, ...controls,
      protectedRoots: [...protectedRoots, inputs.scratch, inputs.donor],
    } });
    // C3 is selected only by this authenticated Studio path and the actual in-process C2 continuation.
    if (flags['--trusted-g3-plan']) {
      const studio = { studioSource, inputs, upstream: projection.upstream, freshC1, c2,
        notices: studioG3Notices(root, source, studioSource), protectedRoots: [...protectedRoots, inputs.scratch, inputs.donor] };
      const context = { root, common, tree, card, index, cardFile, indexFile, base, head, report, studioSource,
        studioScope, changes: report.changedFiles };
      const c3 = await runStudioG3(flags['--trusted-g3-plan'], context, studio);
      runStudioG4(flags['--trusted-review'], context, studio, c3);
      return;
    }
    // No legacy review/audit fallthrough and no final admission.
    report.code = 'STUDIO_C3_REQUIRED';
    return;
  }
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
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--studio-c3-scan-slot') {
  try {
    requireThat(process.argv.length === 5, 'BAD_ARGUMENTS');
    console.log(JSON.stringify(await studioG3Slot(path.resolve(process.argv[3]), process.argv[4])));
  } catch (error) { console.log(JSON.stringify({ code: error.gateCode ?? 'G3_SLOT_FAILED', ...(error.receipt && { receipt: error.receipt }) })); process.exitCode = 1; }
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && process.argv[2] === '--verify-studio-source') {
  let report;
  try {
    const flags = parseArgs(process.argv.slice(3), ['--candidate', '--source']);
    report = verifyStudioSource({ candidate: flags['--candidate'], source: flags['--source'] });
  } catch (error) {
    report = { schemaVersion: 1, admitted: false, mode: studioMode, code: error.gateCode ?? 'STUDIO_SOURCE_ERROR' };
  }
  console.log(JSON.stringify(report));
  process.exitCode = report.code === 'STUDIO_SOURCE_REFERENCE_VERIFIED' ? 0 : 1;
} else {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const report = { schemaVersion: 1, admitted: false };
    try { await evaluate(process.argv.slice(2), report); }
    catch (error) { report.code = error.gateCode ?? 'GATE_ERROR'; }
    console.log(JSON.stringify(report));
    process.exitCode = report.code === 'CANDIDATE_CHECKS_PASSED' && report.admitted === true ? 0 : 1;
  }
}

// C3 bounded asynchronous scanner slots resume under explicit 2026-11-07 two-path approval.
