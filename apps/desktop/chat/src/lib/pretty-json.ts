// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Compact JSON on disk is one line. Viewers expand it so a file is readable
 * without rewriting what the author (or agent) saved.
 */
export function prettyJsonSource(path: string, raw: string): string {
  if (!/\.json$/i.test(path) || /\.jsonl$/i.test(path)) return raw;
  try {
    return `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  } catch {
    return raw;
  }
}
