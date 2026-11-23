// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.

/**
 * One compatibility bridge for the rename: every existing `OPENFILM_*` read keeps working when a
 * person or a build sets the same name with `ORANGE_*`. `ORANGE_*` wins when both are present.
 * The bridge is intentionally process-wide and runs before any module reads its settings.
 */
export function bridgeOrangeEnv(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('ORANGE_') || typeof value !== 'string') continue;
    const legacy = `OPENFILM_${key.slice('ORANGE_'.length)}`;
    env[legacy] = value;
  }
  return env;
}
