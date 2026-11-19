// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** index-client.mjs: the one PostgREST/RPC client, typed. Tenant comes from the JWT, never from a header. */

/** The filters `search_materials` accepts; unknown fields are not forwarded. */
export type SearchFilters = {
  /** One-level category id. */
  category1?: number;
  /** Two-level category ids, any of. */
  category2?: readonly number[];
  /** Label ids, all of. */
  labels?: readonly number[];
  /** Inclusive range on the supplier's creation time, `yyyy-MM-dd`. */
  createdFrom?: string;
  createdTo?: string;
  /** Inclusive duration bounds in milliseconds. */
  minDurationMs?: number;
  maxDurationMs?: number;
  /** Author account key. */
  accountKey?: string;
  videoTypes?: readonly number[];
};

/** One row of `search_materials` (`returns table`). */
export type SearchHit = {
  video_id: string;
  name: string | null;
  score: number;
  category2_id: string | null;
  labels: readonly string[];
  create_time: string | null;
  account_key: string | null;
};

/** A row written back through `p_row`: whatever the table takes, nothing added. */
export type IndexRow = Readonly<Record<string, unknown>>;

export type IndexClientOptions = {
  baseUrl: string;
  /** Session token. `authorization: Bearer <jwt>` is the only credential sent. */
  jwt: string;
  /** Sent every request; the tenant always comes from the token, never from an option. */
  fetch?: typeof fetch;
};

export type IndexClient = Readonly<{
  searchMaterials(request?: Readonly<{ query?: string; filters?: SearchFilters; limit?: number }>): Promise<readonly SearchHit[]>;
  upsertSummary(row: IndexRow): Promise<void>;
  upsertSource(row: IndexRow): Promise<void>;
  upsertEntity(row: IndexRow): Promise<void>;
  recordEvent(row: IndexRow): Promise<void>;
  wikiVideo(request: Readonly<{ videoId: string }>): Promise<unknown>;
  wikiTimeline(request: Readonly<{ videoId: string; from?: number; to?: number }>): Promise<unknown>;
  wikiShot(request: Readonly<{ videoId: string; index?: number }>): Promise<unknown>;
}>;

/** The `rpc` keys of docs/sql/contract.json; nothing outside this list is called. */
export declare const RPC_NAMES: readonly string[];

/** Throws `configuration-required` without a base URL or a jwt. */
export declare function createIndexClient(options: IndexClientOptions): IndexClient;
