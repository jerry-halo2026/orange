// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * `GET /api/materials/index`: the 批次 → 合集 → 子合集 index our own builder landed on this computer, read-only.
 *
 * Why a route and not a page-side read: the tree is already built and on disk
 * (`~/.openfilm-dev/material-index/index.json` — 78 874 rows on this account, 7 real batches, 1 726 derived ones).
 * The page used to walk the supplier itself, 8 pages × 100 rows, so the 合集 view drew 800 rows out of 78 874 and
 * looked almost empty. The file is the whole account; this hands it over.
 *
 * The rules, each because the page depends on it:
 *  - **read-only**: one file, no build, no sweep, no write. A stale index is still *read* (the page says it is stale);
 *    only a `force` rebuild from the CLI replaces it.
 *  - **as it is**: every field of the file comes back unchanged (`schema`, `generatedAt`, `staleAfterMs`,
 *    `sourceTotal`, `pageable`, `unreachable`, `duplicates`, `videos`, `parsed`, `unclassified`, `pageSize`, `pages`,
 *    `warnings`, `index`), with the names the page reads beside them: `claimed` for `sourceTotal`, and
 *    `totals` / `batches` / `derived` hoisted out of `index` so a reader does not have to know the nesting.
 *  - **no file is 404 `index-missing`; unusable bytes are 500 `index-unreadable`.** Never an empty index: a reader
 *    handed one would draw an empty 合集 view and call it the account.
 */
import { readFileSync } from 'node:fs';
import { HttpError } from './http.mjs';
import { defaultIndexDir, isIndexStale, materialIndexPath } from '../../src/material-index-build.mjs';
import { materialIndexStatus } from '../../src/material-index-bootstrap.mjs';

/**
 * The landed index as the route answers it: the file's own fields, plus the three aliases and `stale`.
 *
 * `stale` is the file's own arithmetic (`generatedAt` against `staleAfterMs`, 24 h by default), computed here once so
 * the page and the CLI cannot disagree about it. A file that cannot say when it was built is stale.
 *
 * @param {{dir?: string, now?: Date, read?: (path: string, encoding: 'utf8') => string}} [options]
 *   `dir` defaults to `defaultIndexDir()` (`$OPENFILM_MATERIAL_INDEX_DIR`, else `~/.openfilm-dev/material-index`).
 */
export function landedIndex({ dir = defaultIndexDir(), now = new Date(), read = readFileSync } = {}) {
  const file = materialIndexPath(dir);
  /** @type {string} */
  let text;
  try {
    text = read(file, 'utf8');
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '');
    if (code === 'ENOENT') {
      /* A missing file is not the whole story: the app is bootstrapping one, so answer with the build's state
         (absent / building / failed) beside `index-missing` instead of leaving the page to say "missing". */
      let buildState = { state: 'absent' };
      try { buildState = materialIndexStatus(dir, { now }); } catch { /* the status reader is optional */ }
      throw new HttpError(404, `没有素材索引：${file} 不存在。先跑 node packages/openfilm/scripts/material-index-build.mjs。`, {
        code: 'index-missing', file, ...buildState,
      });
    }
    throw new HttpError(500, `素材索引读不出来：${file}。`, { code: 'index-unreadable', file });
  }
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(500, `素材索引不是合法 JSON：${file}。`, { code: 'index-unreadable', file });
  }
  const tree = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.index : null;
  const usable = tree && typeof tree === 'object' && Array.isArray(tree.batches) && tree.totals && typeof tree.totals === 'object';
  if (!usable) {
    throw new HttpError(500, `素材索引里没有批次树：${file}。`, { code: 'index-unreadable', file });
  }
  return {
    /* the file, field for field */
    ...parsed,
    /* and the names a reader asks it by */
    claimed: typeof parsed.sourceTotal === 'number' ? parsed.sourceTotal : null,
    totals: tree.totals,
    batches: tree.batches,
    derived: tree.derived ?? null,
    products: tree.products ?? null,
    stale: isIndexStale(parsed, { now }),
  };
}
