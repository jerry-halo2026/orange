// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The brand's own words, from `brand.json` at the repository's root (schema orange/brand/1): the window's title, and
 * the name the menu's About carries. One file names the product; a checkout or a build that renames it renames it there.
 *
 * It keeps the name this window had before when there is nothing to read — no brand.json, one that cannot be read, or
 * one that says no title — so a build without the file still opens as the app it is.
 *
 * Reads no Electron module, so `node --test` can use it.
 */
/*
 * No `node:*` import at the top: this module is also reached from a renderer bundle (an agent definition imports it),
 * and vite turns a static `node:path` import into an empty browser shim, so `dirname` would not exist and the build
 * would fail. The filesystem is fetched only when a name is actually read, and only where Node is the runtime.
 */
const isNode = () => typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function';
const builtin = (name) => (isNode() ? process.getBuiltinModule(name) : null);

/** The name this window carries by default: what it said before brand.json said one. */
export const FALLBACK_WINDOW_TITLE = 'Orange 橙子创作中心';

/**
 * The product's name as this tree ships it, for a build that has no brand.json to read: the name every user-facing
 * place says (the window's app name, its data folder, the installer, Studio's About).
 */
export const FALLBACK_PRODUCT_NAME = 'OrangeFilm';

/** The repository's root, from this file's URL: this file sits three levels down, in apps/desktop/src. */
const here = (() => {
  const url = typeof import.meta !== 'undefined' ? String(import.meta.url ?? '') : '';
  const path = url.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1');
  return path.replace(/[\\/]apps[\\/]desktop[\\/]src[\\/]brand\.mjs$/, '');
})();

/**
 * Where a brand.json can be, in the order it is looked for: the repository's root (this file sits three levels down,
 * in apps/desktop/src), then beside a build's resources, where a packaged app can ship one.
 */
export function brandCandidates(base, resourcesPath = typeof process !== 'undefined' ? process.resourcesPath : undefined) {
  const sep = typeof process !== 'undefined' && process.platform === 'win32' ? '\\' : '/';
  const up = (dir) => dir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
  /* A base that points at this file's own folder is the checkout's apps/desktop/src; the brand lives at the root. */
  const asRoot = (dir) => dir.replace(/[\\/]+$/, '').replace(/[\\/]apps[\\/]desktop[\\/]src$/, '');
  const join = (dir, name) => `${asRoot(dir).split(/[\\/]/).join(sep)}${sep}${name}`;
  /** The checkout this process runs from: the working directory and its parents, then this file's own root. */
  const climb = () => {
    const out = [];
    let dir = typeof process !== 'undefined' ? process.cwd() : '';
    for (let level = 0; level < 5 && dir; level += 1) { out.push(dir); dir = up(dir); }
    out.push(here);
    return out;
  };
  const roots = base !== undefined ? [base] : [here];
  return [
    ...roots.map((root) => join(root, 'brand.json')),
    ...(typeof resourcesPath === 'string' && resourcesPath ? [join(resourcesPath, 'brand.json')] : []),
  ];
}

/** brand.json's own object, or {} when there is none to read or it is not an object. */
export function readBrand({ read, candidates = brandCandidates() } = {}) {
  /* In a renderer there is no filesystem: the caller gets the fallbacks rather than an exception, because a name is not
     worth failing a page over. */
  const reader = read ?? (() => {
    const fs = builtin('node:fs');
    return fs ? (path) => fs.readFileSync(path, 'utf8') : null;
  })();
  if (!reader) return {};
  for (const path of candidates) {
    let text;
    try { text = reader(path); } catch { continue; /* the next place, then the fallback */ }
    try {
      const brand = JSON.parse(text);
      if (brand && typeof brand === 'object' && !Array.isArray(brand)) return brand;
    } catch { /* said nothing a brand can be read from: the next place, then the fallback */ }
  }
  return {};
}

/**
 * The product's name: brand.json's `productName` when it says one. It is what the app is called everywhere a person
 * reads or types it — the menu's About, the data folder under appData, the installer's folder and file names, and the
 * UA token Chromium builds from the app's name (productName with its spaces taken out).
 */
export function brandProductName(brand = readBrand(), fallback = FALLBACK_PRODUCT_NAME) {
  const said = typeof brand?.productName === 'string' ? brand.productName.trim() : '';
  return said || fallback;
}

/** The window's title, and the name About says: brand.json's `windowTitle` when it says one. */
export function brandWindowTitle(brand = readBrand(), fallback = FALLBACK_WINDOW_TITLE) {
  const said = typeof brand?.windowTitle === 'string' ? brand.windowTitle.trim() : '';
  return said || fallback;
}
