// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { types } from 'node:util';
import { readIsolationProfile } from '../../src/development-isolation.mjs';
import { isolatedControlPolicy, isolatedControlContains } from './isolation-control-policy.mjs';

const brands = new WeakSet();
const active = new AsyncLocalStorage();
export const isProjectControlGuard = value => brands.has(value);
export function controlError(code = 'control-invalid') {
 const error = new Error(code === 'control-busy' ? 'Project control is busy.' : code === 'control-required' ? 'Project control is required.' : 'Project control is invalid.');
 error.code = code; error.status = code === 'control-busy' ? 409 : 403; return error;
}
/** Any real critical section here is milliseconds; a lock older than this is abandoned, whatever it says. */
const ABANDONED_LOCK_MS = 5 * 60 * 1000;
/**
 * A lock with no holder name yet is either being written right now (the microseconds between `openSync('wx')` and the
 * `writeSync` that stamps the pid) or was left empty by a delete that Windows refused for a moment. A quarter of a
 * second covers the first and clears the second almost at once, instead of holding up every project call for minutes.
 */
const EMPTY_LOCK_GRACE_MS = 250;
/** How long a live holder is waited out before the caller is told the project is busy: about a second in total. */
const LOCK_WAIT_ATTEMPTS = 200;
const LOCK_WAIT_STEP_MS = 5;
/**
 * Delete a file Windows may hold for an instant (Defender, the indexer), retrying briefly. A lock or temporary that
 * will not go is what turns one bad moment into every later call failing, so this is worth the few milliseconds.
 */
function unlinkWithRetry(file, attempts = 8) {
 for (let attempt = 0; attempt < attempts; attempt++) {
  try { unlinkSync(file); return true; } catch (error) {
   if (error?.code === 'ENOENT') return true;
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
 }
 return false;
}
/**
 * Whether `meta.lock` still has a live holder. A lock that names a running process does; one whose process is gone —
 * or that is empty, unreadable, or far older than any critical section — does not, and may be reclaimed.
 */
function lockHeld(lock) {
 let age;
 try { age = Date.now() - statSync(lock).mtimeMs; } catch { return false; }
 let pid = 0;
 try { pid = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10); } catch { return false; }
 if (Number.isSafeInteger(pid) && pid > 0) {
  /* signal 0 asks "may I signal this pid" without sending anything: ESRCH means no such process */
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
 }
 return age < EMPTY_LOCK_GRACE_MS;
}
function plain(value, keys) {
 if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw controlError();
 const ds = Object.getOwnPropertyDescriptors(value);
 if (Reflect.ownKeys(ds).length !== keys.length || keys.some(k => !ds[k] || !('value' in ds[k]))) throw controlError();
 return value;
}
function array(value) {
 if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw controlError();
 const ds = Object.getOwnPropertyDescriptors(value);
 if (Reflect.ownKeys(ds).length !== value.length + 1) throw controlError();
 for (let i = 0; i < value.length; i++) if (!ds[i] || !('value' in ds[i])) throw controlError();
 return value;
}
const fold = p => process.platform === 'win32' ? p.toLowerCase() : p;
function pathValue(p) {
 if (typeof p !== 'string' || !isAbsolute(p) || p.includes('\0') || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(p) || /[:]/.test(p.slice(2))))) throw controlError();
 return resolve(p);
}
function stat(p) { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw controlError(); } }
function ancestors(p) { const all = []; for (;;) { all.push(p); const up = dirname(p); if (up === p) return all; p = up; } }
export function ordinaryControlPath(p) {
 const full = pathValue(p);
 for (const at of ancestors(full)) { const s = stat(at); if (s && (s.isSymbolicLink() || (s.isFile() && s.nlink !== 1))) throw controlError(); }
 return full;
}
function marker(p) {
 const s = stat(p); if (!s) return;
 ordinaryControlPath(p);
 if (!s.isFile()) throw controlError();
 let value; try { value = JSON.parse(readFileSync(p, 'utf8')); } catch { throw controlError(); }
 if (value?.version === 2) {
  plain(value, ['version', 'domainId', 'coordinationId']);
  if (typeof value.coordinationId !== 'string' || !/^[a-f0-9]{64}$/.test(value.coordinationId)) throw controlError();
 } else { plain(value, ['version', 'domainId']); if (value.version !== 1) throw controlError(); }
 if (typeof value.domainId !== 'string' || !value.domainId) throw controlError();
 throw controlError('control-required');
}
function canonical(p, deny) {
 const full = pathValue(p), paths = new Set([full]);
 if (deny && p.split(/[\\/]/).some(part => part === '.' || part === '..')) {
  const segments = p.split(/[\\/]/);
  for (let n = 1; n <= segments.length; n++) {
   const prefix = segments.slice(0, n).join(sep);
   if (isAbsolute(prefix)) for (const parent of ancestors(resolve(prefix))) {
    marker(join(parent, '.openfilm-control.json')); marker(join(parent, '.film', 'control.json'));
    if (stat(parent)) {
     let real; try { real = realpathSync(parent); } catch { throw controlError(); }
     for (const realParent of ancestors(real)) { marker(join(realParent, '.openfilm-control.json')); marker(join(realParent, '.film', 'control.json')); }
    }
   }
  }
 }
 // Check lexical ancestors as well as the real ancestor + missing tail.
 let at = full, tail = [];
 while (!stat(at)) { tail.unshift(at.slice(dirname(at).length + (dirname(at).endsWith(sep) ? 0 : 1))); const up = dirname(at); if (up === at) throw controlError(); at = up; }
 try { paths.add(resolve(realpathSync(at), ...tail)); } catch { throw controlError(); }
 if (deny) for (const base of paths) for (const parent of ancestors(base)) { marker(join(parent, '.openfilm-control.json')); marker(join(parent, '.film', 'control.json')); }
 return [...paths].map(fold);
}
function resources(value, deny = true) {
 plain(value, ['homes', 'roots', 'targets']);
 const paths = ['homes','roots','targets'].flatMap(k => array(value[k]).flatMap(p => canonical(p, deny)));
 if (!paths.length) throw controlError();
 return [...new Set(paths)];
}
const overlaps = (a, b) => a.some(x => b.some(y => x === y || x.startsWith(y.endsWith(sep) ? y : y + sep) || y.startsWith(x.endsWith(sep) ? x : x + sep)));
function validateRegistry(r) {
 plain(r, ['version','readers','reservations']); if (r.version !== 1) throw controlError();
 const seen = new Set();
 for (const [kind, keys] of [['readers',['nonce','paths','pid']],['reservations',['nonce','paths','pid','instanceId','epoch']]]) for (const record of array(r[kind])) {
  plain(record, keys);
  if (typeof record.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(record.nonce) || seen.has(record.nonce)) throw controlError();
  seen.add(record.nonce);
  if (!array(record.paths).length || record.paths.some(p => typeof p !== 'string' || fold(pathValue(p)) !== p)) throw controlError();
  if (kind === 'reservations' && (typeof record.instanceId !== 'string' || !/^[a-f0-9]{48}$/.test(record.instanceId) || !Number.isSafeInteger(record.epoch) || record.epoch < 1)) throw controlError();
 }
}
export function createProjectControlGuard(options = {}) {
 if (types.isProxy(options) || !options || Object.getPrototypeOf(options) !== Object.prototype) throw controlError();
 const desc = Object.getOwnPropertyDescriptors(options);
 if (Reflect.ownKeys(desc).some(k => k !== 'coordinationRoot') || (desc.coordinationRoot && !('value' in desc.coordinationRoot))) throw controlError();
 const explicit = desc.coordinationRoot ? pathValue(desc.coordinationRoot.value) : null;
 // Resolve lazily at first acquisition, then keep this guard's registry stable
 // through include/release and later acquisitions, even when environment changes.
 // Plain HOME is not authority: only a validated explicit native profile is used.
 let boundRoot = null, boundPolicy = null;
 const root = () => {
  let profile; try { profile = readIsolationProfile(); } catch { throw controlError(); } // Never fall back.
  if (profile) {
   let policy; try { policy = isolatedControlPolicy(profile); } catch { throw controlError(); }
   if ((explicit && fold(explicit) !== fold(policy.coordinationRoot)) || (boundPolicy && boundPolicy.digest !== policy.digest) || (boundRoot && fold(boundRoot) !== fold(policy.coordinationRoot))) throw controlError();
   boundPolicy = policy; boundRoot = pathValue(policy.coordinationRoot);
  } else {
   if (boundPolicy) throw controlError();
   const candidate = explicit ?? join(userInfo().homedir, '.openfilm-control-coordination');
   if (boundRoot && fold(boundRoot) !== fold(candidate)) throw controlError();
   boundRoot = pathValue(candidate);
  }
  return boundRoot;
 };
 function scoped(input, deny = true) {
  root(); const paths = resources(input, deny);
  if (boundPolicy && paths.some(p => !isolatedControlContains(boundPolicy, p))) throw controlError();
  return paths;
 }
 // Failed releases remain reachable by this guard only. A later operation retries these exact owned records.
 const pendingReleases = new Map();
 const pause = new Int32Array(new SharedArrayBuffer(4));
 function retryRelease(release) {
  for (let attempt = 0; attempt < 32; attempt++) {
   try { release(); return; }
   catch (e) { if (e?.code !== 'control-busy' || attempt === 31) throw e; Atomics.wait(pause, 0, 0, 2); }
  }
 }
 function recoverReleases() { for (const release of pendingReleases.values()) retryRelease(release); }
 /* atomic.mjs's Windows rule, for this synchronous transaction: renaming onto a file another handle (Defender, the search
    indexer, an editor) holds for a moment fails with EPERM/EBUSY/EACCES. That is not a verdict about the registry, and
    `transaction` would turn it into `control-invalid` for every later acquisition of this guard, so it is tried again. */
 function publish(temp, file) {
  for (let attempt = 0; ; attempt++) {
   try { renameSync(temp, file); return; }
   catch (e) {
    const code = /** @type {{ code?: string }} */ (e)?.code ?? '';
    if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt >= 32) throw e;
    Atomics.wait(pause, 0, 0, 2);
   }
  }
 }
 function transaction(change) {
  try { return transactionIO(change); }
  catch (e) { if (e?.code?.startsWith('control-')) throw e; throw controlError(); }
 }
 function transactionIO(change) {
  const dir = ordinaryControlPath(root()); mkdirSync(dir, { recursive: true }); ordinaryControlPath(dir);
  const lock = join(dir, 'meta.lock'), file = join(dir, 'registry.json');
  ordinaryControlPath(lock); ordinaryControlPath(file);
  let fd;
  /* Judged once per acquisition: the lock's age grows while we wait, so re-reading it on every attempt would turn a
     held lock into an "abandoned" one a few hundred milliseconds into the wait. */
  let judged = null;
  /* A critical section here is milliseconds, and the contention is nearly always another process of Studio's own (an
     export worker on the same coordination root, a second Studio, a suite running beside another one): waiting one out
     is what the caller wanted, and a one-shot `control-busy` made a whole suite fail where every call would have
     succeeded a few milliseconds later (2026-11-19). The wait is bounded, so a holder that stays still says busy. */
  for (let attempt = 0; ; attempt++) {
   try { fd = openSync(lock, 'wx', 0o600); break; }
   catch (error) {
    if (error?.code !== 'EEXIST') throw controlError('control-busy');
    /* A lock nobody holds is not a busy project: a killed run leaves `meta.lock` behind, and refusing everything until
       a person deletes the file by hand turned into 409 for every call across whole suites. The lock names its holder,
       so one whose holder is gone — or that is empty and older than a moment — is reclaimed and judged again. */
    if (judged === null) judged = lockHeld(lock);
    if (!judged) { unlinkWithRetry(lock); judged = null; continue; }
    if (attempt >= LOCK_WAIT_ATTEMPTS) throw controlError('control-busy');
    Atomics.wait(pause, 0, 0, LOCK_WAIT_STEP_MS);
   }
  }
  try { writeSync(fd, String(process.pid)); } catch { /* the lock is the file, not its contents */ }
  try {
   let r = { version: 1, readers: [], reservations: [] };
   /* A registry written by a tool that adds a UTF-8 BOM parses as garbage, and that turned every native call into a
      500 with `Cannot read properties of null (reading 'run')`. The marker is ours, so its own reader tolerates a BOM
      rather than failing the whole workspace. */
   if (stat(file)) { try { r = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw controlError(); } }
   validateRegistry(r);
   const result = change(r);
   const temp = join(dir, `${randomBytes(24).toString('hex')}.tmp`);
   /* A write that does not land leaves no temporary behind: the coordination directory keeps only the registry. */
   try { writeFileSync(temp, JSON.stringify(r), { flag: 'wx', mode: 0o600 }); publish(temp, file); }
   catch (e) { try { unlinkSync(temp); } catch { /* it never landed */ } throw e; }
   return result;
  } finally {
   closeSync(fd);
   /* the registry is written by now; a delete Windows refuses for an instant must not leave a lock for the next run */
   unlinkWithRetry(lock);
  }
 }
 function acquire(input, controlled) {
  recoverReleases();
  // Marker traversal is outside the metadata critical section; no user work runs under it.
  const paths = scoped(input, !controlled), nonce = randomBytes(24).toString('hex');
  const record = { nonce, paths, pid: process.pid, ...(controlled ? { instanceId: randomBytes(24).toString('hex'), epoch: 1 } : {}) };
  const kind = controlled ? 'reservations' : 'readers';
  transaction(r => { if (r.reservations.some(x => overlaps(paths, x.paths)) || (controlled && r.readers.some(x => overlaps(paths, x.paths)))) throw controlError('control-busy'); r[kind].push(record); });
  let closed = false;
  const assertActive = () => { if (closed) throw controlError(); root(); };
  const release = () => {
   transaction(r => { const index = r[kind].findIndex(x => x.nonce === nonce); if (index < 0) throw controlError(); r[kind].splice(index, 1); });
   pendingReleases.delete(nonce);
  };
  const close = () => {
   if (closed && !pendingReleases.has(nonce)) return;
   closed = true; // The callback has ended, even if its record must remain fail-closed for now.
   pendingReleases.set(nonce, release);
   retryRelease(release);
  };
  const includeSync = paths => {
   assertActive(); const more = scoped({ homes: [], roots: [], targets: paths });
   transaction(r => { const own = r[kind].find(x => x.nonce === nonce); if (!own) throw controlError(); if (r.reservations.some(x => x.nonce !== nonce && overlaps(more, x.paths))) throw controlError('control-busy'); own.paths = [...new Set([...own.paths, ...more])]; });
   scoped({ homes: [], roots: [], targets: paths });
  };
  return { close, lease: Object.freeze({ assertActive, include: async paths => includeSync(paths) }), includeSync, record };
 }
 /* A record written by a process that no longer exists cannot be holding anything: a hard kill used to leave the
    registry reserved forever. This removes exactly those and reports how many it took, leaving live holders alone. */
 function reclaimDead() {
  const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
  return transaction(r => {
   const before = r.readers.length + r.reservations.length;
   r.readers = r.readers.filter(x => !(Number.isInteger(x.pid) && !alive(x.pid)));
   r.reservations = r.reservations.filter(x => !(Number.isInteger(x.pid) && !alive(x.pid)));
   return before - (r.readers.length + r.reservations.length);
  });
 }
 const guard = Object.freeze({
  reclaimDead,
  isControlledAccess() {
   const scope = active.getStore();
   if (scope?.guard !== guard || !scope.controlled) return false;
   scope.controlled.check(); return true;
  },
  async withNativeAccess(input, work) {
   const scope = active.getStore();
   if (scope?.guard === guard && scope.controlled) {
    scope.controlled.admit(input); return work(scope.controlled.lease);
   }
   // Nothing is held in the unleased read-only context: the paths are still checked, no record is written.
   if (scope?.guard === guard && scope.allowingRead) { scoped(input, false); return await work(scope.lease); }
   const holder = acquire(input, false);
   try { scoped(input); return await active.run({ guard }, () => work(holder.lease)); } finally { holder.close(); }
  },
  withNativeAccessSync(input, work) {
   const scope = active.getStore();
   if (scope?.guard === guard && scope.controlled) {
    scope.controlled.admit(input); const value = work(); if (value && typeof value.then === 'function') throw controlError(); return value;
   }
   if (scope?.guard === guard && scope.allowingRead) {
    scoped(input, false); const value = work(scope.lease); if (value && typeof value.then === 'function') throw controlError(); return value;
   }
   const holder = acquire(input, false);
   try { scoped(input); const value = active.run({ guard }, work); if (value && typeof value.then === 'function') throw controlError(); return value; } finally { holder.close(); }
  },
  /* A person signed in on this machine whose controlled reservation cannot be taken — a coordination record another
     copy left behind, an unwritable marker, a registry some other tool left unreadable — still reaches the projects on
     this machine: the folder is the device's work, not the account's. This mode establishes the guard's own async
     context, which is everything `assertGuardSwitch` and projects.mjs need (taking the guard out at the call site is
     what crashed Studio: the native entry points fell back to the default guard, a different coordination root), and
     it neither reads nor writes the registry and never consults the deny markers. It authorises reading only:
     `readOnly` must be true, and projects.mjs refuses every change that runs under a read-only authority. */
  async withProjectControlGuardAllowingRead(work, options) {
   if (typeof work !== 'function') throw controlError();
   plain(options, ['readOnly']);
   if (options.readOnly !== true) throw controlError('control-required');
   const scope = active.getStore();
   if (scope && scope.guard !== guard) throw controlError();
   // A reservation already governs this work: keep its scope (and its lease) instead of narrowing it.
   if (scope?.controlled) return await work();
   const lease = Object.freeze({
    readOnly: true,
    assertActive() { root(); },
    async include(paths) { scoped({ homes: [], roots: [], targets: paths }, false); },
   });
   return await active.run({ guard, allowingRead: true, lease }, () => work());
  },
  /** Whether this call runs in the guard's unleased read-only context (a degraded sign-in on this device). */
  isUnleasedReadOnlyAccess() {
   const scope = active.getStore();
   return scope?.guard === guard && scope.allowingRead === true;
  },
  async acquireControlledReservation(input) {
   const holder = acquire(input, true);
   return Object.freeze({ instanceId: holder.record.instanceId, epoch: holder.record.epoch, close: holder.close,
    async run(validate, work) {
     if (typeof validate !== 'function' || typeof work !== 'function') throw controlError();
     const check = () => { holder.lease.assertActive(); if (validate() !== true) throw controlError('control-required'); };
     const admit = input => {
      check(); const requested = scoped(input, false);
      if (!requested.every(path => holder.record.paths.some(root => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)))) throw controlError();
     };
     const lease = Object.freeze({ assertActive:check, include:async paths => admit({homes:[],roots:[],targets:paths}) });
     check(); return active.run({guard,controlled:{check,admit,lease}}, work);
    },
   });
  },
 });
 brands.add(guard); return guard;
}
export function assertGuardSwitch(guard) { if (!brands.has(guard) || (active.getStore() && active.getStore().guard !== guard)) throw controlError(); }
