// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// Development-only authority. All participating processes from this checkout
// must read the same locally provisioned policy; environment is not authority.
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const policyFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.dev/orange-test-control-policy.json');
const fold = p => process.platform === 'win32' ? p.toLowerCase() : p;
export function isolatedControlPolicy(profile) {
  const info = lstatSync(policyFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || fold(realpathSync(policyFile)) !== fold(policyFile)) throw Error('Invalid isolated control policy.');
  const raw = readFileSync(policyFile, 'utf8');
  const value = JSON.parse(raw);
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== 'baseRoot,version' || value.version !== 1 || typeof value.baseRoot !== 'string' || fold(resolve(value.baseRoot)) !== fold(profile.baseRoot) || value.baseRoot !== resolve(value.baseRoot)) throw Error('Invalid isolated control policy.');
  return Object.freeze({ baseRoot: profile.baseRoot, coordinationRoot: join(profile.baseRoot, '.orange-coordination'), digest: createHash('sha256').update(raw).digest('hex') });
}
export function isolatedControlContains(policy, target) {
  const root = fold(resolve(policy.baseRoot)), value = fold(resolve(target));
  return value !== root && value.startsWith(root + sep);
}
