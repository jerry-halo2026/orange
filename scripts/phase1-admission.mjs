// Local governance, not cryptographic proof of human/agent identity. Callers supply
// independently approved Git-BLOB anchors; candidate worktree cards are never policy.
// Approval/card-pointer anchors hash exact Git blob bytes. For executable, dependency
// and review file entries: sha256 = exact current bytes; gitBlobSha256 = exact commit
// blob bytes. Only policy JSON comparisons are structural (checkout CRLF tolerated).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, lstatSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REGISTRY = 'docs/execution/project-tasks.json';
const SELF_TEST = 'scripts/phase1-admission.test.mjs';
const PURE_TESTS = new Set(['scripts/phase1-isolation.test.mjs','apps/desktop/src/flavor.test.mjs']);
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function deny(code) { const e = new Error(code); e.code = code; throw e; }
function need(ok, code) { if (!ok) deny(code); }
function list(x, code) { need(Array.isArray(x), code); return x; }
function sha(x, code) { need(typeof x === 'string' && HEX64.test(x), code); }
function commit(x, code) { need(typeof x === 'string' && HEX40.test(x), code); }
function git(root, args, allowFailure = false) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: null, windowsHide: true, shell: false, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  if (!allowFailure) need(!r.error && r.status === 0, 'GIT');
  return r;
}
function gitText(root, args) { return git(root, args).stdout.toString('utf8').trim(); }
function blob(root, at, file) { commit(at, 'ANCHOR'); relative(file); return git(root, ['show', `${at}:${file}`]).stdout; }
function json(bytes, code) { try { return JSON.parse(bytes.toString('utf8')); } catch { deny(code); } }
function relative(p) {
  need(typeof p === 'string' && p.length > 0 && !/[\\:\x00-\x1f]/.test(p) && !p.startsWith('/'), 'PATH');
  for (const part of p.split('/')) need(part && part !== '.' && part !== '..' && !/[. ~]$|~\d|[<>"|?*]/.test(part) && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part), 'PATH');
  return p;
}
const slash = p => p.replaceAll('\\', '/');
const fold = p => slash(p).toLowerCase();
function nested(a, b) { return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); }
function absolute(p) {
  need(typeof p === 'string' && path.isAbsolute(p) && fold(p) === fold(path.resolve(p)), 'PATH');
  if (process.platform === 'win32') need(/^[a-z]:[\\/]/i.test(p), 'PATH');
  const tail = slash(p.slice(path.parse(p).root.length)); if (tail) relative(tail);
  return fold(p);
}
function checkedPath(root, p) {
  relative(p); let current = root;
  for (const segment of p.split('/')) {
    if (existsSync(current)) {
      need(lstatSync(current).isDirectory(),'PATH_TYPE');
      const aliases = readdirSync(current).filter(name => name.toLowerCase() === segment.toLowerCase());
      need(aliases.length <= 1 && (!aliases.length || aliases[0] === segment), 'PATH_CASE');
    }
    current = path.join(current, segment);
    const stat = lstatSync(current,{throwIfNoEntry:false});
    if (stat) need(!stat.isSymbolicLink(), 'PATH_LINK');
  }
  return current;
}
function validCard(c) {
  need(c && typeof c.taskId === 'string' && typeof c.authorAgent === 'string' && c.authorAgent.length > 0 && Number.isSafeInteger(c.assignmentRevision) && c.assignmentRevision > 0, 'CARD');
  absolute(c.worktreePath); need(typeof c.branch === 'string' && c.branch.startsWith('codex/'), 'CARD');
  commit(c.workingBaselineCommit, 'CARD');
  const writes = list(c.writeAllowlist, 'CARD'); need(writes.length > 0, 'CARD'); writes.forEach(relative);
  need(new Set(writes.map(fold)).size === writes.length, 'PATH_CASE');
  list(c.resourceLeases, 'CARD').forEach(resource);
}
function resource(r) {
  need(r && ['cpu', 'directory', 'port', 'database', 'desktop', 'gpu'].includes(r.kind) && typeof r.exclusive === 'boolean', 'RESOURCE');
  if (r.kind === 'cpu') { need(r.exclusive === false, 'RESOURCE'); return; }
  need(r.exclusive === true, 'RESOURCE');
  if (r.kind === 'port') need(Number.isInteger(r.value) && r.value > 0 && r.value <= 65535, 'RESOURCE');
  else need(typeof r.value === 'string' && r.value.length > 0 && !/[\x00-\x1f]/.test(r.value), 'RESOURCE');
  if (r.kind === 'directory') { if (path.isAbsolute(r.value)) absolute(r.value); else relative(r.value); }
}
function resourceValue(r, root) {
  if (r.kind !== 'directory') return String(r.value).toLowerCase();
  const resolved = path.isAbsolute(r.value) ? r.value : path.resolve(root, relative(r.value));
  const drive = path.parse(resolved).root;
  checkedPath(drive, slash(resolved.slice(drive.length)));
  return absolute(resolved);
}
// Parse NUL records, never line-split paths. Git -M emits both endpoints.
export function parseNameStatus(bytes) {
  const parts = bytes.toString('utf8').split('\0'); if (parts.at(-1) === '') parts.pop();
  const paths = [];
  while (parts.length) {
    const status = parts.shift(); need(/^[ACDMRTUXB][0-9]*$/.test(status), 'GIT_DIFF');
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let i = 0; i < count; i++) { need(parts.length > 0, 'GIT_DIFF'); paths.push(parts.shift()); }
  }
  return paths;
}
// Source ancestry and actor-write authority have distinct commits. Coordinator
// allocation/card changes before approval are not attributed to the source author.
export function collectGitState(root, baselineCommit, dependencyCommits = [], approvalCommit = baselineCommit) {
  commit(baselineCommit, 'BASELINE'); commit(approvalCommit,'APPROVAL'); const realRoot = realpathSync(root);
  need(absolute(gitText(root, ['rev-parse', '--show-toplevel'])) === absolute(realRoot), 'WORKTREE');
  const head = gitText(root, ['rev-parse', 'HEAD']);
  const branchResult = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  need(!branchResult.error && [0,1].includes(branchResult.status),'GIT');
  const branch = branchResult.status === 0 ? branchResult.stdout.toString('utf8').trim() : '';
  const entries = gitText(root, ['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/);
  const linked = lstatSync(path.join(root, '.git')).isFile() && entries.some(e => e.split(/\r?\n/).some(l => l.startsWith('worktree ') && absolute(l.slice(9)) === absolute(realRoot)) && e.includes(`HEAD ${head}`) && e.includes(`branch refs/heads/${branch}`));
  const ancestor = (c,target=head) => { commit(c, 'DEPENDENCY'); const r = git(root, ['merge-base', '--is-ancestor', c, target], true); need(!r.error && [0, 1].includes(r.status), 'GIT'); return r.status === 0; };
  const changedPaths = [
    ...parseNameStatus(git(root, ['diff', '--name-status', '-z', '-M', approvalCommit, head, '--']).stdout),
    ...parseNameStatus(git(root, ['diff', '--cached', '--name-status', '-z', '-M', '--']).stdout),
    ...parseNameStatus(git(root, ['diff', '--name-status', '-z', '-M', '--']).stdout),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.toString('utf8').split('\0').filter(Boolean),
  ];
  const flags = git(root,['ls-files','-v','-z']).stdout.toString('utf8').split('\0').filter(Boolean);
  need(flags.every(x => x[0] === x[0].toUpperCase() && x[0] !== 'S'),'GIT_HIDDEN');
  const all = git(root, ['ls-files', '-z']).stdout.toString('utf8').split('\0').filter(Boolean);
  need(new Set(all.map(fold)).size === all.length, 'PATH_CASE');
  const contentHashes = Object.fromEntries([...new Set(changedPaths)].sort().map(p => {
    const file=checkedPath(realRoot,p), stat=lstatSync(file,{throwIfNoEntry:false});
    need(!stat || stat.isFile(),'PATH_TYPE');
    return [p,stat ? digest(readFileSync(file)) : null];
  }));
  return { root: realRoot, head, branch, linked, baselineAncestor: ancestor(baselineCommit), baselineApprovalAncestor:ancestor(baselineCommit,approvalCommit), approvalAncestor:ancestor(approvalCommit), dependencyAncestors: Object.fromEntries(dependencyCommits.map(c => [c, ancestor(c)])), changedPaths: [...new Set(changedPaths)],contentHashes };
}
function shared(p) {
  return !p.includes('/') || p.startsWith('.github/') || p === REGISTRY || p.startsWith('docs/discovery/07_') || /(?:assignment|review|fixture|contract)/i.test(p) || p.startsWith('scripts/phase1-') || /(?:^|\/)(?:main\.(?:mjs|ts)|server\.mjs|preload\.cjs|bridge\.ts|App\.tsx|ProjectView\.tsx|Timeline\.tsx|CaptionsPane\.tsx)$/.test(p);
}
function same(a,b) { return JSON.stringify(a) === JSON.stringify(b); }
export function evaluateAdmission({card:c,registry,state:s,activeCards,dependencies}) {
  validCard(c);
  need(registry?.executionAuthorized === true && registry.tasks?.some(t => t.id === c.taskId && ['ready','claimed','in_progress'].includes(t.status) && Array.isArray(t.externalGates) && t.externalGates.length === 0), 'REGISTRY');
  need(s.linked && absolute(s.root) === absolute(c.worktreePath), 'WORKTREE');
  need(s.branch === c.branch, 'BRANCH'); need(s.head === c.candidateHead, 'HEAD'); need(s.baselineAncestor && s.baselineApprovalAncestor, 'BASELINE'); need(s.approvalAncestor,'APPROVAL_ANCESTRY');
  list(c.dependencyCommits,'DEPENDENCY').forEach(at => { commit(at,'DEPENDENCY'); need(s.dependencyAncestors[at] === true,'DEPENDENCY'); });
  need(!s.registryChanged, 'POLICY');
  const policy = c.admission; need(policy, 'POLICY');
  const grants = list(policy.sharedWriteGrants, 'SHARED'); grants.forEach(relative);
  for (const p of s.changedPaths) {
    relative(p); need(c.writeAllowlist.some(allow => p === allow || p.startsWith(allow + '/')), 'WRITE');
    if (shared(p)) need(grants.includes(p), 'SHARED');
  }
  for (const a of list(activeCards,'CARD')) {
    validCard(a);
    need(absolute(a.worktreePath) !== absolute(c.worktreePath), 'WORKTREE_OVERLAP');
    for (const left of c.writeAllowlist) for (const right of a.writeAllowlist) need(!nested(fold(left),fold(right)), 'WRITE_OVERLAP');
    for (const left of c.resourceLeases) for (const right of a.resourceLeases) if (left.kind === right.kind && left.kind !== 'cpu') {
      const l = resourceValue(left,c.worktreePath), r = resourceValue(right,a.worktreePath);
      need(!(left.kind === 'directory' ? nested(l,r) : l === r), 'RESOURCE_OVERLAP');
    }
  }
  const required = list(policy.dependencies, 'DEPENDENCY'); need(dependencies.length === required.length, 'DEPENDENCY');
  const task = registry.tasks.find(t => t.id === c.taskId);
  for (const id of list(task.dependsOn,'DEPENDENCY')) need(required.some(d => d.taskId === id),'DEPENDENCY_SUBSET');
  need(new Set(required.map(d => d.taskId)).size === required.length,'DEPENDENCY');
  for (const expected of required) {
    commit(expected.commit,'DEPENDENCY');
    need(expected.commit === s.head || s.dependencyAncestors[expected.commit] === true,'DEPENDENCY');
    need(registry.tasks.some(t => t.id === expected.taskId) && typeof expected.authorAgent === 'string' && expected.authorAgent && list(expected.source,'DEPENDENCY').length > 0 && list(expected.fixtures,'DEPENDENCY').length > 0,'DEPENDENCY');
    const actual = dependencies.find(d => d.taskId === expected.taskId && d.commit === expected.commit);
    need(actual && same(actual.source,expected.source) && same(actual.fixtures,expected.fixtures), 'DEPENDENCY_HASH');
    const review = actual.reviewEvidence;
    need(review && review.authorAgent === expected.authorAgent && review.reviewerAgent && review.reviewerAgent !== expected.authorAgent && review.commit === expected.commit && review.spec === 'approved' && review.quality === 'approved' && same(review.source,expected.source) && same(review.fixtures,expected.fixtures), 'REVIEW');
  }
  return { admitted: true, taskId: c.taskId, assignmentRevision: c.assignmentRevision };
}
export function loadApproval(root, anchors) {
  need(anchors && typeof anchors === 'object', 'ANCHOR');
  commit(anchors.approvalCommit,'ANCHOR');commit(anchors.candidateHead,'ANCHOR');sha(anchors.approvalCardSha256,'ANCHOR');
  need(Number.isSafeInteger(anchors.expectedRevision) && anchors.expectedRevision > 0, 'ANCHOR'); relative(anchors.cardPath);
  const bytes = blob(root,anchors.approvalCommit,anchors.cardPath);need(digest(bytes) === anchors.approvalCardSha256,'APPROVAL_HASH');
  const card = json(bytes,'APPROVAL_JSON');need(card.assignmentRevision === anchors.expectedRevision,'REVISION');
  const registry = json(blob(root,anchors.approvalCommit,REGISTRY),'REGISTRY');
  return {card:{...card,candidateHead:anchors.candidateHead},registry,anchors:{...anchors}};
}
function verifyFile(root,entry,at,code) {
  sha(entry.sha256,code);sha(entry.gitBlobSha256,code);commit(at,code);
  const file = checkedPath(root,entry.path);
  need(digest(readFileSync(file)) === entry.sha256 && digest(blob(root,at,entry.path)) === entry.gitBlobSha256,code);
}
export function loadEvidence(root,bundle) {
  const p = bundle.card.admission;need(p,'MISSING_TEST_POLICY');
  const activeCards = list(p.activeCards,'CARD').map(ref => {
    sha(ref.sha256,'CARD'); const bytes = blob(root,bundle.anchors.approvalCommit,ref.path);need(digest(bytes) === ref.sha256,'CARD_HASH');
    const c = json(bytes,'CARD');need(c.assignmentRevision === ref.assignmentRevision && c.status === 'active','CARD_REVISION');return c;
  });
  const dependencies = list(p.dependencies,'DEPENDENCY').map(d => {
    commit(d.commit,'DEPENDENCY');need(typeof d.authorAgent === 'string' && d.authorAgent,'DEPENDENCY');
    need(list(d.source,'DEPENDENCY').length > 0 && list(d.fixtures,'DEPENDENCY').length > 0,'DEPENDENCY');
    [...d.source,...d.fixtures].forEach(e => verifyFile(root,e,d.commit,'DEPENDENCY_HASH'));
    verifyFile(root,d.review,bundle.anchors.approvalCommit,'REVIEW_HASH');
    return {...d,reviewEvidence:json(readFileSync(checkedPath(root,d.review.path)),'REVIEW')};
  });
  return {activeCards,dependencies};
}
// Deliberately flat TAP only. Nested suites are rejected, not guessed complete.
export function verifyTap(tap,exitCode,requiredNames) {
  need(exitCode === 0 && typeof tap === 'string' && tap.startsWith('TAP version 13\n'),'TAP_EXIT');
  need(!/^(?:Bail out!|\s+(?:not )?ok \d|\s+1\.\.)/m.test(tap),'TAP_STRUCTURE');
  const plans = [...tap.matchAll(/^1\.\.(\d+)\s*$/gm)];need(plans.length === 1,'TAP_PLAN');
  const records = [...tap.matchAll(/^(not )?ok (\d+) - (.*)$/gm)];const count=Number(plans[0][1]);
  need(count > 0 && count === records.length,'TAP_COUNT');
  records.forEach((r,i) => need(!r[1] && Number(r[2]) === i+1 && !/\s+#\s*(?:SKIP|TODO)\b/i.test(r[3]),'TAP_CASE'));
  for(const key of ['fail','cancelled','skipped','todo']) need(new RegExp(`^# ${key} 0$`,'m').test(tap),'TAP_SUMMARY');
  need(new RegExp(`^# tests ${count}$`,'m').test(tap),'TAP_SUMMARY');
  const names = records.map(r => r[3]); need(list(requiredNames,'TAP_REQUIRED').length > 0,'TAP_REQUIRED');
  for(const name of requiredNames) need(typeof name === 'string' && names.filter(n => n === name).length === 1,'TAP_REQUIRED');
  return names;
}
// Validate the root's ancestors as well as the whole temp chain BEFORE mkdir.
// Re-check before spawning; this rejects existing/dangling junctions and files,
// rather than resolving an alias and granting its target write authority.
function runnerTemp(root,create=false) {
  absolute(root);
  const drive=path.parse(root).root, tail=slash(root.slice(drive.length));
  need(tail.length>0,'PATH_ROOT');
  const checkedRoot=checkedPath(drive,tail);
  need(lstatSync(checkedRoot).isDirectory() && absolute(realpathSync(checkedRoot))===absolute(root),'PATH_ROOT');
  const rel='.dev/admission-fixtures/runner-temp', temp=checkedPath(checkedRoot,rel);
  let ancestor=temp, stat=lstatSync(ancestor,{throwIfNoEntry:false});
  while(!stat) { ancestor=path.dirname(ancestor); need(absolute(ancestor)===absolute(root) || absolute(ancestor).startsWith(absolute(root)+'/'),'PATH_CONTAINMENT'); stat=lstatSync(ancestor,{throwIfNoEntry:false}); }
  need(stat.isDirectory() && !stat.isSymbolicLink() && absolute(realpathSync(ancestor))===absolute(ancestor),'PATH_TYPE');
  if(create) mkdirSync(temp,{recursive:true});
  checkedPath(checkedRoot,rel);
  need(lstatSync(temp).isDirectory() && absolute(realpathSync(temp))===absolute(temp) && absolute(temp).startsWith(absolute(root)+'/'),'PATH_CONTAINMENT');
  return temp;
}
export function runApprovedTests(root,policy) {
  need(policy && Array.isArray(policy.tests) && policy.tests.length > 0,'MISSING_TEST_POLICY');
  const temp = runnerTemp(root,true);
  return policy.tests.map(spec => {
    need(spec && !('command' in spec) && spec.path !== SELF_TEST,'TEST_POLICY'); relative(spec.path);sha(spec.sha256,'TEST_HASH');
    const fixture = policy.fixtureNamespace && relative(policy.fixtureNamespace).startsWith('.dev/admission-fixtures/') && spec.path.startsWith(policy.fixtureNamespace+'/');
    need(PURE_TESTS.has(spec.path) || fixture,'TEST_POLICY');
    const file = checkedPath(root,spec.path);need(digest(readFileSync(file)) === spec.sha256,'TEST_HASH');
    if (!fixture) verifyFile(root,spec,spec.commit,'TEST_HASH');
    const args = ['--test','--test-reporter=tap'];
    if (spec.namePattern !== undefined) {need(typeof spec.namePattern === 'string' && spec.namePattern.length > 0,'TEST_POLICY');args.push(`--test-name-pattern=${spec.namePattern}`);}
    args.push(file);
    const env = Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','ComSpec'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    Object.assign(env,{TEMP:temp,TMP:temp,TMPDIR:temp});
    need(runnerTemp(root)===temp,'PATH_CONTAINMENT');
    const r = spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',shell:false,windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});
    need(!r.error && !r.signal && r.status === 0,'TEST_EXIT');
    const names = verifyTap(r.stdout.replaceAll('\r\n','\n'),r.status,spec.requiredNames);
    need(digest(readFileSync(file)) === spec.sha256,'TEST_HASH');
    return {path:spec.path,exitCode:r.status,names};
  });
}
export function runAdmission(root,anchors) {
  const bundle=loadApproval(root,anchors);
  need(bundle.card.admission?.tests?.length > 0,'MISSING_TEST_POLICY');
  const evidence=loadEvidence(root,bundle);
  const before=collectGitState(root,bundle.card.workingBaselineCommit,bundle.card.dependencyCommits,anchors.approvalCommit);
  // Worktree policy files must still equal approval blobs, even if write-allowed.
  const policyPaths=[REGISTRY,anchors.cardPath,...bundle.card.admission.activeCards.map(x=>x.path)];
  // Only policy JSON gets structural comparison (permits checkout CRLF). No Git filters run.
  for(const p of policyPaths) need(same(json(readFileSync(checkedPath(root,p)),'POLICY_JSON'),json(blob(root,anchors.approvalCommit,p),'POLICY_JSON')),'POLICY_CHANGED');
  const result=evaluateAdmission({card:bundle.card,registry:bundle.registry,state:before,...evidence});
  const testResults=runApprovedTests(root,bundle.card.admission);
  const after=collectGitState(root,bundle.card.workingBaselineCommit,bundle.card.dependencyCommits,anchors.approvalCommit);
  need(same(before,after),'STATE_CHANGED');
  loadEvidence(root,bundle);
  return {...result,testResults};
}
function cli(args) {
  const names={'--root':'root','--card':'cardPath','--approval-commit':'approvalCommit','--approval-card-sha256':'approvalCardSha256','--expected-revision':'expectedRevision','--candidate-head':'candidateHead'};
  const values={};need(args.length%2===0,'ANCHOR');
  for(let i=0;i<args.length;i+=2){const key=names[args[i]];need(key && !(key in values) && args[i+1],'ANCHOR');values[key]=args[i+1];}
  need(values.root && values.cardPath,'ANCHOR');values.expectedRevision=Number(values.expectedRevision);
  return runAdmission(values.root,values);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.stdout.write(JSON.stringify(cli(process.argv.slice(2)))+'\n');}
  catch(e) {process.stderr.write(`ADMISSION_DENIED:${/^[A-Z_]+$/.test(e.code||'')?e.code:'INVALID_INPUT'}\n`);process.exitCode=1;}
}
