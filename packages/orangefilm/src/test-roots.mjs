// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// Owned, isolated test fixture roots for the desktop/OrangeFilm suites.
//
// Why this exists: `development-isolation.mjs` (rootPath) refuses any approved
// base root that is on `C:`, is a filesystem root, contains an 8.3 alias (`~`),
// or has a component ending in `.`/` `. `os.tmpdir()` defaults to
// `C:\Users\<user>\AppData\Local\Temp` (and under a short-name shell to
// `C:\Users\ADMINI~1\...`), so fixtures built from it cannot ever satisfy the
// validator. Test fixtures therefore take their root from here instead of
// `os.tmpdir()`, and never return a short name.
//
// Resolution order:
//   1. `ORANGE_TEST_ROOT`, when it is an absolute directory that satisfies the
//      same constraints as an isolation base root (not on C:, no `~` alias,
//      no traversal segments);
//   2. `<repo>/.dev/test-roots` — `.dev/` is git-ignored and the checkout lives
//      on a development volume (D: or E:), so it satisfies those constraints.
//
// Every call creates the directory and returns its canonical long form, so
// callers can pass the value to `resolve(root) === root` style guards and to
// `readIsolationProfile({ approvedBaseRoot })` unchanged.
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Repository root, derived from this file's location (never from cwd). */
export const repositoryRoot = resolve(moduleDir, '..', '..', '..');

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ALIAS_CHARACTER = /[<>:"|?*~]/;

function components(absolute) {
    const windows = process.platform === 'win32';
    const body = windows ? absolute.slice(3) : absolute.slice(1);
    return body.split(windows ? /[\\/]/ : /\//);
}

/**
 * A directory usable as an approved isolation base root: absolute, local,
 * not on `C:` (Windows), not a volume root, and free of alias segments.
 */
export function isUsableTestRoot(value) {
    if (typeof value !== 'string' || value.trim() === '' || !isAbsolute(value)) return false;
    const absolute = normalize(value);
    if (process.platform === 'win32') {
        if (!/^[A-Za-z]:\\/.test(absolute)) return false;
        if (/^c:/i.test(absolute)) return false;
    }
    if (absolute === resolve(absolute, '..')) return false;
    return components(absolute).every(part => part !== '' && part !== '.' && part !== '..' && !ALIAS_CHARACTER.test(part) && !/[. ]$/.test(part));
}

/**
 * Absolute, canonical (long-form) directory owned by one test file.
 * @param {string} name single canonical path segment, e.g. `studio` or `desktop-auth`
 * @returns {string}
 */
export function testRoot(name) {
    if (typeof name !== 'string' || !NAME.test(name)) {
        throw new TypeError('testRoot(name): name must be a single canonical path segment');
    }
    const requested = process.env.ORANGE_TEST_ROOT;
    const base = isUsableTestRoot(requested) ? normalize(requested) : join(repositoryRoot, '.dev', 'test-roots');
    const directory = join(base, name);
    mkdirSync(directory, { recursive: true });
    // Canonicalise through the filesystem so no caller inherits an 8.3 alias or
    // a non-normalised casing from the request.
    return realpathSync.native(directory);
}

/** Same as {@link testRoot}, for fixtures that need their own unique subdirectory. */
export function testRootFor(name, prefix) {
    const root = testRoot(name);
    const directory = join(root, `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(directory, { recursive: true });
    return directory;
}
