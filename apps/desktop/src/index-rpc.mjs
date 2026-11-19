// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The retrieval side, as the desktop hands it to the agents: configuration in, `index-client` out, and nothing at all
 * when nothing is configured.
 *
 * There is no request shape here any more. Every call goes through `packages/openfilm/src/index-client.mjs` — the one
 * client — so `/rest/v1/rpc/<fn>`, the `Bearer` token and `p_company_key` exist in exactly one file. What is left in
 * this module is the two things the desktop owns: **where the settings come from** (`OPENFILM_INDEX_URL`,
 * `OPENFILM_INDEX_SESSION`) and **how a failure is named** for the tools that show it.
 *
 * `OPENFILM_INDEX_COMPANY` is deliberately not read: the tenant is the token's own claim, so a setting on this side
 * could only ever disagree with it. A stale value in a deployment now has no effect instead of a silent one.
 *
 * Unconfigured is a **value**, not a throw: `readIndexConfig()` returns null without a base URL and a session, and
 * every caller turns that into its own `not-configured` answer.
 */
import { createIndexClient } from 'openfilm/index-client';

/** The environment keys the window reads. Nothing else is consulted, and none of these values is ever logged. */
export function readIndexConfig(env = process.env) {
  const baseUrl = typeof env.OPENFILM_INDEX_URL === 'string' ? env.OPENFILM_INDEX_URL.trim().replace(/\/+$/, '') : '';
  const jwt = typeof env.OPENFILM_INDEX_SESSION === 'string' ? env.OPENFILM_INDEX_SESSION.trim() : '';
  if (!baseUrl || !jwt) return null;
  if (!/^https?:\/\//.test(baseUrl)) return null;
  return { baseUrl, jwt };
}

/** A failure as the tools report it: the client's code and status, or `rpc-failed` for anything unexpected. */
function mapError(error) {
  return Object.assign(new Error(String(error?.message ?? error ?? 'index rpc failed')), {
    code: typeof error?.code === 'string' ? error.code : 'rpc-failed',
    ...(Number.isFinite(error?.status) ? { status: error.status } : {}),
    ...(typeof error?.detail === 'string' ? { detail: error.detail } : {}),
  });
}

/** `range` as the wiki tools spell it: `[from, to]`, `{from, to}`, or the arguments themselves. */
function rangeOf({ range, from, to } = {}) {
  const start = Array.isArray(range) ? range[0] : range?.from ?? from;
  const end = Array.isArray(range) ? range[1] : range?.to ?? to;
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : undefined);
  return { from: number(start), to: number(end) };
}

/**
 * The client the tools use. `null` when nothing is configured, so a caller can answer `not-configured` without a
 * try/catch; every method the tools need is present on the returned object.
 * @param {{config?: ReturnType<typeof readIndexConfig>, fetch?: typeof fetch}} [options]
 */
export async function createIndexRpc(options = {}) {
  const config = options.config ?? readIndexConfig();
  if (!config) return null;

  let client;
  try {
    client = createIndexClient({
      baseUrl: config.baseUrl,
      jwt: config.jwt,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  } catch (error) {
    if (error?.code === 'configuration-required') return null;
    throw mapError(error);
  }

  const call = async (run) => {
    try {
      return await run();
    } catch (error) {
      throw mapError(error);
    }
  };

  return {
    /** What the client is made of, for a log line — never the session or the company key. */
    readonly: { transport: 'index-client' },

    async search({ query, category, labels, aspect, durationMax, limit } = {}) {
      const filters = {};
      if (category !== undefined && category !== null && category !== '') {
        const id = Number(category);
        if (Number.isInteger(id)) filters.category1 = id;
      }
      if (Array.isArray(labels) && labels.length) {
        const ids = labels.map(Number).filter(Number.isInteger);
        if (ids.length) filters.labels = ids;
      }
      if (Number.isFinite(durationMax)) filters.maxDurationMs = Math.max(0, Math.trunc(durationMax * 1000));
      const wanted = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.trunc(limit))) : 20;
      const hits = await call(() => client.searchMaterials({ ...(query ? { query } : {}), filters, limit: wanted }));
      return { hits, count: hits.length, transport: 'index-client' };
    },

    async wikiVideo({ videoId } = {}) {
      return { wiki: await call(() => client.wikiVideo({ videoId })), transport: 'index-client' };
    },

    async wikiTimeline({ videoId, range, from, to } = {}) {
      const span = rangeOf({ range, from, to });
      return {
        wiki: await call(() => client.wikiTimeline({ videoId, ...(span.from !== undefined ? { from: span.from } : {}), ...(span.to !== undefined ? { to: span.to } : {}) })),
        transport: 'index-client',
      };
    },

    async wikiShot({ videoId, index } = {}) {
      return { wiki: await call(() => client.wikiShot({ videoId, index })), transport: 'index-client' };
    },

    /**
     * The analyser's write-back, first half: the analysed markdown and its evidence (`upsert_wiki_source`, 007 §5).
     * It goes before the summary, so a summary never exists without the source it was concluded from.
     */
    async upsertWikiSource(row) {
      await call(() => client.upsertSource(row ?? {}));
      return { uploaded: true, transport: 'index-client' };
    },

    /**
     * The analyser's write-back, second half: one flat summary row (`upsert_wiki_summary`, 007 §4).
     *
     * Nothing is added here. The row's `analyzer_ver` is the caller's own reading of the runner's version (it is the
     * version guard the function compares), so a default invented in this module could only ever disagree with the
     * source row written a moment earlier under a different version. Missing fields stay missing — 007 has its own
     * defaults for what it can default. The caller decides whether a failure is worth reporting.
     */
    async upsertWikiSummary(row) {
      await call(() => client.upsertSummary(row ?? {}));
      return { uploaded: true, transport: 'index-client' };
    },
  };
}
