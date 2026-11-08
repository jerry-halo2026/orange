import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { types } from 'node:util';

const brands = new WeakSet();
const active = new AsyncLocalStorage();
export const isProjectControlGuard = value => brands.has(value);
export function controlError(code = 'control-invalid') {
 const error = new Error(code === 'control-busy' ? 'Project control is busy.' : code === 'control-required' ? 'Project control is required.' : 'Project control is invalid.');
 error.code = code; error.status = code === 'control-busy' ? 409 : 403; return error;
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
 plain(value, ['version', 'domainId']);
 if (value.version !== 1 || typeof value.domainId !== 'string' || !value.domainId) throw controlError();
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
 for (const [kind, keys] of [['readers',['nonce','paths']],['reservations',['nonce','paths','instanceId','epoch']]]) for (const record of array(r[kind])) {
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
 // No filesystem access until acquisition. Environment HOME never selects this namespace.
 const root = () => explicit ?? join(userInfo().homedir, '.openfilm-control-coordination');
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
 function transaction(change) {
  try { return transactionIO(change); }
  catch (e) { if (e?.code?.startsWith('control-')) throw e; throw controlError(); }
 }
 function transactionIO(change) {
  const dir = ordinaryControlPath(root()); mkdirSync(dir, { recursive: true }); ordinaryControlPath(dir);
  const lock = join(dir, 'meta.lock'), file = join(dir, 'registry.json');
  ordinaryControlPath(lock); ordinaryControlPath(file);
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch { throw controlError('control-busy'); }
  try {
   let r = { version: 1, readers: [], reservations: [] };
   if (stat(file)) { try { r = JSON.parse(readFileSync(file, 'utf8')); } catch { throw controlError(); } }
   validateRegistry(r);
   const result = change(r);
   const temp = join(dir, `${randomBytes(24).toString('hex')}.tmp`);
   writeFileSync(temp, JSON.stringify(r), { flag: 'wx', mode: 0o600 }); renameSync(temp, file);
   return result;
  } finally { closeSync(fd); unlinkSync(lock); }
 }
 function acquire(input, controlled) {
  recoverReleases();
  // Marker traversal is outside the metadata critical section; no user work runs under it.
  const paths = resources(input, !controlled), nonce = randomBytes(24).toString('hex');
  const record = { nonce, paths, ...(controlled ? { instanceId: randomBytes(24).toString('hex'), epoch: 1 } : {}) };
  const kind = controlled ? 'reservations' : 'readers';
  transaction(r => { if (r.reservations.some(x => overlaps(paths, x.paths)) || (controlled && r.readers.some(x => overlaps(paths, x.paths)))) throw controlError('control-busy'); r[kind].push(record); });
  let closed = false;
  const assertActive = () => { if (closed) throw controlError(); };
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
   assertActive(); const more = resources({ homes: [], roots: [], targets: paths });
   transaction(r => { const own = r[kind].find(x => x.nonce === nonce); if (!own) throw controlError(); if (r.reservations.some(x => x.nonce !== nonce && overlaps(more, x.paths))) throw controlError('control-busy'); own.paths = [...new Set([...own.paths, ...more])]; });
   resources({ homes: [], roots: [], targets: paths });
  };
  return { close, lease: Object.freeze({ assertActive, include: async paths => includeSync(paths) }), includeSync, record };
 }
 const guard = Object.freeze({
  async withNativeAccess(input, work) {
   const holder = acquire(input, false);
   try { resources(input); return await active.run({ guard }, () => work(holder.lease)); } finally { holder.close(); }
  },
  withNativeAccessSync(input, work) {
   const holder = acquire(input, false);
   try { resources(input); const value = active.run({ guard }, work); if (value && typeof value.then === 'function') throw controlError(); return value; } finally { holder.close(); }
  },
  async acquireControlledReservation(input) {
   const holder = acquire(input, true);
   return Object.freeze({ instanceId: holder.record.instanceId, epoch: holder.record.epoch, close: holder.close });
  },
 });
 brands.add(guard); return guard;
}
export function assertGuardSwitch(guard) { if (!brands.has(guard) || (active.getStore() && active.getStore().guard !== guard)) throw controlError(); }
