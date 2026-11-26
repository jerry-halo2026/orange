// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Which app this process is. Two apps, each with its own name, bundle id, data folder and Studio home, so the
 * one run from this repository never shares a window, a lock or a Studio with the installed one. Projects are the
 * person's, so every app but the bench shares one library: the one ~/.orangefilm says (`sharedHome`; by default
 * ~/Movies/OrangeFilm/Projects, or ORANGE_LIBRARY):
 *
 *   · release — the packaged app. Its Studio is the machine's Studio (~/.orangefilm), the one `orangefilm open` finds.
 *   · preview — a packaged app built with `release --preview`, "<product> Preview", to try a build in: its own data
 *               folder, Studio home and port, so it never meets an installed app (its package says so:
 *               `orangefilmFlavor`).
 *   · dev     — `pnpm --filter @orange/desktop start`: this repository's code, with its own Studio home.
 *   · bench   — `node bench/run.mjs`: this repository's code, everything (data, Studio home, projects) in the throwaway
 *               folder the benchmark names in ORANGE_BENCH_DIR, so a run never touches a person's dev or installed app.
 *
 * The names are brand.json's own (`productName`, through brand.mjs), with the flavor's suffix: the release is the
 * product's name and nothing else. `~/.orangefilm*` and the bundle ids stay the ones this app has always had: they are
 * the app's identity to the system and the machine, not words a person reads.
 *
 * Reads no Electron module, so `node --test` can use it.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandProductName } from './brand.mjs';

const packaged = Boolean(process.versions.electron) && !process.defaultApp;

/* the product's name, brand.json's own (brand.mjs): the app's name, its data folder, and the token Chromium puts in
   the UA ("OrangeFilmDev/0.3.0" for "OrangeFilm Dev"), so a rename is that one file */
const NAME = brandProductName();

export const FLAVORS = Object.freeze({
  release: { productName: NAME, bundleId: 'com.orange.studio', studioPort: 4747, studioHome: null, library: null, sharedHome: null },
  preview: {
    productName: `${NAME} Preview`, bundleId: 'com.orange.studio.preview', studioPort: 4777,
    studioHome: join(homedir(), '.orangefilm-preview'), library: null, sharedHome: join(homedir(), '.orangefilm'),
  },
  dev: {
    productName: `${NAME} Dev`, bundleId: 'com.orange.studio.dev', studioPort: 4757,
    studioHome: join(homedir(), '.orangefilm-dev'), library: null, sharedHome: join(homedir(), '.orangefilm'),
  },
});

const benchDir = process.env.ORANGE_BENCH_DIR ?? '';
const BENCH = Object.freeze({
  productName: `${NAME} Bench`, bundleId: 'com.orange.studio.bench', studioPort: 4767,
  studioHome: join(benchDir, 'home'), library: join(benchDir, 'projects'), sharedHome: null, userData: join(benchDir, 'data'),
});

/** What the app's package says it was built as (`release --preview` writes `orangefilmFlavor`). */
function builtFlavor() {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).orangefilmFlavor ?? null;
  } catch { return null; }
}

export function flavorName(env = process.env, isPackaged = packaged, built = isPackaged ? builtFlavor() : null) {
  if (isPackaged) return built === 'preview' ? 'preview' : 'release';
  if (env.ORANGE_DESKTOP_FLAVOR === 'dev') return 'dev';
  if (env.ORANGE_DESKTOP_FLAVOR === 'bench' && env.ORANGE_BENCH_DIR) return 'bench';
  return 'release';
}

export const FLAVOR = flavorName();
export const IDENTITY = FLAVOR === 'bench' ? BENCH : FLAVORS[FLAVOR];
export const PRODUCT_NAME = IDENTITY.productName;
