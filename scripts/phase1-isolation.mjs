/**
 * T01's read-only admission check, not a launcher or an isolation sandbox.
 * Native startup must explicitly consume every location before it is safe to run.
 * Revalidate immediately before creating directories: concurrent filesystem changes
 * after this check (TOCTOU) are not prevented by a profile object.
 */
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i;
const FOLDERS = Object.freeze({
  home: 'home', sharedHome: 'shared-home', projects: 'projects', saved: 'Saved', library: 'library',
  exports: 'exports', skills: 'skills', downloads: 'downloads', cache: 'cache', logs: 'logs',
  temp: 'temp', crash: 'crash', userData: 'user-data',
});

function object(value, name, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is required.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${name}.${key} is not supported.`);
}

function identity(value, name) {
  // Canonical casing avoids distinct profiles aliasing on case-insensitive volumes.
  const pattern = name === 'taskId' ? /^[A-Z][A-Z0-9_-]{0,63}$/ : /^[a-z0-9][a-z0-9_-]{0,63}$/;
  if (typeof value !== 'string' || !pattern.test(value) || DEVICE.test(value)) throw new TypeError(`${name} must be a canonical single-component ID.`);
  return value;
}

function rootPath(value, paths, windows, name) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} must be an explicit absolute directory.`);
  if (windows && (!/^[A-Za-z]:[\\/]/.test(value) || /^C:/i.test(value))) throw new TypeError(`${name} must be a local non-C Windows development directory.`);
  if (!paths.isAbsolute(value) || value === paths.parse(value).root) throw new TypeError(`${name} must not be relative or a filesystem root.`);
  const body = windows ? value.slice(3) : value.slice(1);
  const parts = body.split(windows ? /[\\/]/ : /\//);
  if (parts.some((part) => !part || part === '.' || part === '..' || (windows && (/[<>:"|?*~]/.test(part) || /[. ]$/.test(part) || DEVICE.test(part))))) {
    throw new TypeError(`${name} must not contain traversal or path aliases.`);
  }
  return paths.normalize(value);
}

function samePath(a, b, paths, windows) {
  const canonical = (value) => windows ? paths.normalize(value).toLowerCase() : paths.normalize(value);
  return canonical(a) === canonical(b);
}

function contained(root, target, paths) {
  const relative = paths.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

function checkAncestors(target, paths, windows) {
  // Inspect even parents above the approved root: approving a lexical path must
  // not implicitly approve a junction, symlink, short-name or mount alias.
  for (let current = target; ; current = paths.dirname(current)) {
    let info;
    try { info = lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Profile ancestors must be ordinary directories, not links or files.');
      if (!samePath(realpathSync.native(current), current, paths, windows)) throw new Error('Profile ancestor resolves through a filesystem alias.');
    }
    if (paths.dirname(current) === current) break;
  }
}

/**
 * Derive an immutable development profile. No environment defaults, path
 * overrides, filesystem writes, port binding, or process creation are allowed.
 * The caller must separately approve the exact base root, not request approval
 * using untrusted config itself. Ports are explicit and distinct, not reserved.
 * Filesystem checks run only with native semantics; macOS requires a Mac test.
 */
export function resolveIsolationProfile(config, policy) {
  object(config, 'profile', ['baseRoot', 'instanceId', 'taskId', 'attemptId', 'ports']);
  object(policy, 'policy', ['approvedBaseRoot', 'platform']);
  const platform = policy.platform ?? process.platform;
  if (!['win32', 'darwin'].includes(platform) || platform !== process.platform) throw new Error('Profile validation requires a native Windows or macOS host.');
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const approved = rootPath(policy.approvedBaseRoot, paths, windows, 'approvedBaseRoot');
  const baseRoot = rootPath(config.baseRoot, paths, windows, 'baseRoot');
  if (!samePath(approved, baseRoot, paths, windows)) throw new Error('Profile base root is not the caller-approved root.');
  const instanceId = identity(config.instanceId, 'instanceId');
  const taskId = identity(config.taskId, 'taskId');
  const attemptId = identity(config.attemptId, 'attemptId');
  object(config.ports, 'ports', ['studio', 'film']);
  for (const key of ['studio', 'film']) {
    if (!Number.isInteger(config.ports[key]) || config.ports[key] < 1 || config.ports[key] > 65535) throw new TypeError(`${key} requires an explicit TCP port.`);
  }
  if (config.ports.studio === config.ports.film) throw new Error('Studio and film ports must be distinct.');
  const root = paths.join(baseRoot, instanceId, taskId, attemptId);
  const locations = Object.fromEntries(Object.entries(FOLDERS).map(([key, folder]) => [key, paths.join(root, folder)]));
  for (const location of [root, ...Object.values(locations)]) {
    if (!contained(baseRoot, location, paths)) throw new Error('Profile location escapes its approved root.');
    checkAncestors(location, paths, windows);
  }
  return Object.freeze({
    baseRoot, instanceId, taskId, attemptId, root,
    paths: Object.freeze(locations), ports: Object.freeze({ studio: config.ports.studio, film: config.ports.film }),
  });
}
