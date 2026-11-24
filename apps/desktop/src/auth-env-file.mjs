// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The environment the Studio child signs into, as a file.
 *
 * `desktop-auth` reads a path (`ORANGE_AUTH_CONFIG_FILE`) and its `snapshot` refuses any key beyond the three, so a
 * packaged app cannot simply hand its own branding along: the resolver's answer is written out as exactly
 * `environmentId`, `authOrigin`, `publishableKey` with 0600, and that path is what the child gets.
 *
 * An explicit `ORANGE_AUTH_CONFIG_FILE` still wins — that is how development and the bench point at their own
 * environment. Everything else is the resolver's business, and its failures are reported with their code so the window
 * can say "the installer is incomplete" instead of "this sign-in is not active".
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The resolver, loaded where it actually is.
 *
 * A static `../../../packages/…` import works in the checkout and **crashes an installed app**:
 * inside `app.asar` that path resolves to `Contents/packages/…`, which does not exist — the window died on
 * `ERR_MODULE_NOT_FOUND` before it could say anything. In an installed app the release copies the module to
 * `Resources/orangefilm/packages/orangefilm/src` (PACKED_EDITOR_MODULES), so the packaged path is asked first.
 */
let loaded = null;
async function environmentModule(resourcesDir) {
  if (loaded) return loaded;
  const candidates = [];
  if (resourcesDir) {
    for (const root of ['orangefilm', 'orangefilm']) {
      for (const pkg of ['orangefilm', 'orangefilm']) {
        candidates.push(new URL(`file://${join(resourcesDir, root, 'packages', pkg, 'src', 'auth-environment.mjs')}`).href);
      }
    }
  }
  candidates.push(new URL('../../../packages/orangefilm/src/auth-environment.mjs', import.meta.url).href);
  /** @type {string[]} */
  const tried = [];
  for (const candidate of candidates) {
    try {
      loaded = await import(candidate);
      return loaded;
    } catch (error) {
      tried.push(`${candidate}: ${String(/** @type {any} */ (error)?.code ?? error)}`);
    }
  }
  throw new Error(`登录环境模块加载失败（${tried.join('；')}）`);
}

/**
 * The signed-out reason a person should see, from the error code the resolver produced.
 *
 * `configuration-required` is a development state ("nothing points at an environment yet"); an installed app that
 * cannot find its environment is a different thing — the installer is incomplete — and telling its user to "provide
 * local configuration" is what made a downloaded build look like a broken product on 2026-11-19. The whitelist is what
 * `desktop-auth` accepts, so the two cannot drift.
 * @param {string | undefined} code
 * @returns {'configuration-required' | 'install-incomplete' | 'install-conflict'}
 */
export function authEnvironmentReason(code) {
  if (code === 'auth-environment-conflict') return 'install-conflict';
  if (code === 'auth-environment-missing' || code === 'auth-environment-incomplete' || code === 'auth-environment-unreadable') {
    return 'install-incomplete';
  }
  return 'configuration-required';
}

/** What a person is told when the environment cannot be established. @param {unknown} error */
export function authEnvironmentMessage(error) {
  const code = /** @type {any} */ (error)?.code;
  const missing = /** @type {any} */ (error)?.missing;
  if (code === 'auth-environment-missing') return '安装包缺少登录环境配置，请重新安装。';
  if (code === 'auth-environment-incomplete') return `登录环境配置不完整（缺少 ${Array.isArray(missing) ? missing.join('、') : '字段'}），请重新安装。`;
  if (code === 'auth-environment-conflict') return '同时配置了两个登录环境，请只保留一个后重启。';
  if (code === 'auth-environment-unreadable') return '登录环境配置无法读取，请重新安装。';
  return '登录环境无法建立，请检查配置后重启。';
}

/**
 * The file the Studio child should read, or `{ error }` when there is nothing usable to give it.
 * @param {{ env?: Record<string, string | undefined>, dataDir: string, resourcesDir?: string, requireDescription?: boolean }} options
 */
export async function materializeAuthEnvironmentFile(options) {
  const env = options.env ?? process.env;
  const explicit = typeof env.ORANGE_AUTH_CONFIG_FILE === 'string' ? env.ORANGE_AUTH_CONFIG_FILE.trim() : '';
  if (explicit) return { file: explicit, source: 'override' };
  let resolved;
  const { AuthEnvironmentError, resolveEnvironment } = await environmentModule(options.resourcesDir);
  try {
    resolved = resolveEnvironment({ env, resourcesDir: options.resourcesDir, requireDescription: options.requireDescription });
  } catch (error) {
    return {
      error,
      message: authEnvironmentMessage(error),
      code: error instanceof AuthEnvironmentError ? error.code : 'auth-environment-unknown',
    };
  }
  const file = join(options.dataDir, 'auth-runtime.json');
  try {
    mkdirSync(options.dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify({
      environmentId: resolved.environmentId,
      authOrigin: resolved.authOrigin,
      publishableKey: resolved.publishableKey,
    }), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* the mode already asked for it */ }
  } catch (error) {
    return { error, message: authEnvironmentMessage(error), code: 'auth-environment-unwritable' };
  }
  return { file, source: resolved.source, local: resolved.local };
}
