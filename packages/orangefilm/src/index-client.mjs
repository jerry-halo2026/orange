// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The one client for the OrangeFilm index: PostgREST `/rest/v1/rpc/<fn>`, nothing else.
 *
 * Zero dependencies on purpose (global `fetch`, `TextDecoder`), so the same file runs in Node, in Electron's
 * renderer/utility process and inside an asar, where `apps/api`'s TypeScript is not resolvable.
 *
 * Tenant isolation is structural, in two ways:
 *  - it is never a header — the only credential sent is `authorization: Bearer <jwt>`, the tenant is the server's
 *    own reading of that token (`app_metadata.company_key`), so a client cannot name a tenant it was not issued;
 *  - the body the caller influences is nested: `p_company_key` is written by this client from the token and every
 *    other key is a fixed parameter, so a filter or a row can never lift a tenant key to the top level.
 *  There is deliberately **no** option to pass a company key in: a writer that needs another tenant's rows signs a
 *  different token (`infra/jwt.mjs` for the service role), which is the one thing an operator can audit.
 *
 * The function names are the `rpc` keys of `docs/sql/contract.json`, written down here because the packaged app has
 * no `docs/`. `apps/api/src/index/client.test.ts` compares this list with the contract, so a drift is red.
 */

/** Every RPC the data plane declares (`docs/sql/contract.json` → `rpc`), and nothing else may be called. */
export const RPC_NAMES = Object.freeze([
  'search_materials',
  'upsert_wiki_summary',
  'upsert_wiki_source',
  'upsert_wiki_entity',
  'record_wiki_event',
  'wiki_video',
  'wiki_timeline',
  'wiki_shot',
  'upsert_media_doc',
  'media_search',
  'orange_resolve_materials',
  'orange_preflight',
  'orange_freeze_claim',
  'orange_claim_status',
  'orange_start_attempt',
  'orange_cancel_claim',
  'orange_mark_unknown',
  'orange_record_delivery',
]);

const RPC = new Set(RPC_NAMES);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_QUERY = 200;
const DETAIL_LIMIT = 512;

/** An error with the code and status a caller branches on. */
function fail(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

/** A JWT's payload, or null: base64url JSON, no library, no signature check (the server is the one that checks). */
function jwtPayload(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** The tenant the token was issued for: `app_metadata.company_key`, and nothing else in the token. */
function tenantOf(jwt) {
  const claim = jwtPayload(jwt);
  const company = claim?.app_metadata?.company_key;
  return typeof company === 'string' && company.trim() ? company.trim() : '';
}

const wholeNumber = (value) => Math.max(0, Math.trunc(value));

/** The filters the RPC receives; anything the caller invents is not forwarded. */
function rpcFilters(filters = {}) {
  const out = {};
  if (filters.category1 !== undefined) out.category1 = wholeNumber(filters.category1);
  if (filters.category2?.length) out.category2 = filters.category2.map(wholeNumber);
  if (filters.labels?.length) out.labels = filters.labels.map(wholeNumber);
  if (filters.videoTypes?.length) out.video_types = filters.videoTypes.map(wholeNumber);
  if (filters.createdFrom) out.created_from = filters.createdFrom;
  if (filters.createdTo) out.created_to = filters.createdTo;
  if (filters.minDurationMs !== undefined) out.min_duration_ms = wholeNumber(filters.minDurationMs);
  if (filters.maxDurationMs !== undefined) out.max_duration_ms = wholeNumber(filters.maxDurationMs);
  if (filters.accountKey) out.account_key = filters.accountKey;
  return out;
}

/**
 * The client. `jwt` is the only credential and the only source of the tenant: a call made with a token that names
 * no `app_metadata.company_key` is refused here, before any request, instead of travelling as an empty tenant.
 * Missing configuration throws `configuration-required` here, not per call.
 */
export function createIndexClient(options = {}) {
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl.trim().replace(/\/+$/, '') : '';
  const jwt = typeof options.jwt === 'string' ? options.jwt.trim() : '';
  if (!baseUrl) throw fail('configuration-required', 'baseUrl is required');
  if (!jwt) throw fail('configuration-required', 'jwt is required');
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw fail('configuration-required', 'no fetch to send with');

  /** The tenant for this call: the token's own claim, and nothing else. */
  const tenantKey = () => {
    const company = tenantOf(jwt);
    if (!company) throw fail('tenant-context-required', 'the session names no app_metadata.company_key', 401);
    return company;
  };

  const rpc = async (name, params) => {
    if (!RPC.has(name)) throw fail('unknown-rpc', 'rpc ' + name + ' is not in the contract', 400);
    const body = { p_company_key: tenantKey(), ...params };
    const response = await fetcher(baseUrl + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + jwt,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error('rpc ' + name + ' failed'), {
        code: 'rpc-failed',
        status: response.status,
        detail: typeof detail === 'string' ? detail.slice(0, DETAIL_LIMIT) : '',
      });
    }
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const identifier = (value, what) => {
    if (typeof value !== 'string' || !value.trim()) throw fail('invalid-argument', what + ' is required', 422);
    return value.trim();
  };

  return Object.freeze({
    async searchMaterials({ query, filters, limit } = {}) {
      const raw = typeof query === 'string' ? query.trim() : '';
      if (raw.length > MAX_QUERY) throw fail('invalid-query', 'query is longer than ' + MAX_QUERY + ' characters', 422);
      const wanted = Math.trunc(Number(limit));
      const size = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(wanted) ? wanted : DEFAULT_LIMIT));
      const rows = await rpc('search_materials', {
        p_query: raw ? raw : null,
        p_filters: rpcFilters(filters),
        p_limit: size,
      });
      return Object.freeze(
        (Array.isArray(rows) ? rows : []).map((row) =>
          Object.freeze({ ...row, labels: Object.freeze([...(row?.labels ?? [])]) }),
        ),
      );
    },

    async upsertSummary(row) {
      await rpc('upsert_wiki_summary', { p_row: { ...(row ?? {}) } });
    },

    async upsertSource(row) {
      await rpc('upsert_wiki_source', { p_row: { ...(row ?? {}) } });
    },

    async upsertEntity(row) {
      await rpc('upsert_wiki_entity', { p_row: { ...(row ?? {}) } });
    },

    async recordEvent(row) {
      await rpc('record_wiki_event', { p_row: { ...(row ?? {}) } });
    },

    async wikiVideo({ videoId } = {}) {
      return rpc('wiki_video', { p_video_id: identifier(videoId, 'videoId') });
    },

    async wikiTimeline({ videoId, from, to } = {}) {
      return rpc('wiki_timeline', {
        p_video_id: identifier(videoId, 'videoId'),
        p_from: Number.isFinite(Number(from)) ? Number(from) : null,
        p_to: Number.isFinite(Number(to)) ? Number(to) : null,
      });
    },

    async wikiShot({ videoId, index } = {}) {
      return rpc('wiki_shot', {
        p_video_id: identifier(videoId, 'videoId'),
        p_index: Number.isInteger(Number(index)) ? Math.trunc(Number(index)) : 0,
      });
    },
  });
}
