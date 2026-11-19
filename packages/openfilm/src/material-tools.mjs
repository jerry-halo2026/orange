// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The three read-only tools an agent browses the material library with, and the five-tool budget they live inside.
 *
 * `material-index.mjs` decides what a batch / collection / group is, `material-index-build.mjs` decides what the counts
 * are. These tools only read the index those two landed — no network, no write, no second opinion about a number. The
 * editor's material views read the same file, so the agent and the person cannot see different counts.
 *
 * The one exception is `material.search`: a name filter over the local index cannot answer "find me the shot of the tea
 * that looks like this", so the search tool asks the account's own documents (`material-search.mjs`, over
 * `media_search`) and says with `mode` which of its three routes answered. It still writes nothing.
 *
 * The tool surface is capped at five (`docs/contracts/mcp-tools.schema.json` declares exactly five), so `material.search`
 * takes the slot `material.batches` held — a batch's availability is what `material.collections({batch})` answers
 * anyway. `planMaterialToolSurface` writes the whole arithmetic down; see that function.
 *
 * Result envelope is the MCP server's own (`openfilm-mcp.mjs`): `content` for prose, `structuredContent` for the agent.
 */
import { defaultIndexDir, readMaterialIndex } from './material-index-build.mjs';
import { MATERIAL_SEARCH_CAPS, MATERIAL_SEARCH_CAPS_CONTRACT, normaliseFilters } from './material-search.mjs';

/** The hard cap on the MCP tool surface. */
export const TOOL_BUDGET = 5;

/** The names the desktop server's `TOOL_DEFINITIONS` carries today (`apps/desktop/src/openfilm-mcp.mjs`). */
export const EXISTING_TOOL_NAMES = Object.freeze([
  'materials.search', 'materials.take', 'wiki.video', 'wiki.timeline', 'wiki.shot', 'timeline.insert_clip', 'openfilm.look',
]);

/** The tools this module adds, in the order a reader meets them. */
export const MATERIAL_TOOL_NAMES = Object.freeze(['material.search', 'material.collections', 'material.items']);

/**
 * The five slots as they are served, in the order an agent reads them: the three read-only tools, then the two write
 * verbs. `planMaterialToolSurface` returns this order, and `apps/desktop/src/openfilm-mcp.mjs` serves it — the same
 * list in both places is the whole point of writing it down once here.
 */
export const MATERIAL_BUDGET_SURFACE = Object.freeze([...MATERIAL_TOOL_NAMES, 'materials.take', 'timeline.insert_clip']);

/** How much of a large index one answer carries, and what a caller may ask for. */
export const MATERIAL_TOOL_CAPS = Object.freeze({
  search: MATERIAL_SEARCH_CAPS.limit,
  searchDefault: MATERIAL_SEARCH_CAPS.defaultLimit,
  /* batch ids named in a refusal ("no batch 20990101, the index has: …"): a listing aid, not a tool slot — the batch
     listing itself is `material.collections({})`, which answers with every collection of every batch. */
  batches: 20,
  collections: 50, groupsPerCollection: 200, items: 200, itemsDefault: 50,
});

/**
 * The same two numbers under the names the contract uses (`docs/contracts/mcp-tools.schema.json` says `rows` /
 * `defaultRows` for `material.items`) — one number, two names, written down here so the schema and this file can be
 * compared without a reader having to guess which key is which. `material.search` keeps the search module's own pair.
 */
export const MATERIAL_TOOL_CAPS_CONTRACT = Object.freeze({
  rows: MATERIAL_TOOL_CAPS.items, defaultRows: MATERIAL_TOOL_CAPS.itemsDefault,
  searchRows: MATERIAL_SEARCH_CAPS_CONTRACT.rows, searchDefaultRows: MATERIAL_SEARCH_CAPS_CONTRACT.defaultRows,
});

/** The tools `tools/list` should answer with, read-only first (the list is also the documentation an agent reads). */
export const MATERIAL_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'material.search',
    description: 'Search the account\'s materials by what they show or what they are called (semantic first, the words as a fallback, the landed index as the last resort — `mode` says which answered), each row with whether this computer already holds the bytes. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what to look for, e.g. 柠檬宝藏茶 外包装' },
        batch: { type: 'string', description: 'batch id, e.g. 20261106' },
        product: { type: 'string', description: 'collection id (20261106-柠檬宝藏茶200g罐) or its name' },
        group: { type: 'string', description: 'group id or name inside that collection, e.g. 外包装' },
        durationMaxMs: { type: 'number', description: 'longest material wanted, in milliseconds' },
        limit: { type: 'number', description: `rows wanted (1-${MATERIAL_SEARCH_CAPS.limit}, default ${MATERIAL_SEARCH_CAPS.defaultLimit})` },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'material.collections',
    description: 'List the collections (products) of one batch, or of every batch, each with its groups and counts. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { batch: { type: 'string', description: 'batch id, e.g. 20261106; omit for all batches' } },
      additionalProperties: false,
    },
  },
  {
    name: 'material.items',
    description: 'List the video ids and names of one collection, optionally narrowed to one group. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'collection id (20261106-柠檬宝藏茶200g罐) or its name' },
        group: { type: 'string', description: 'group id or name inside that collection' },
        limit: { type: 'number', description: `rows wanted (1-${MATERIAL_TOOL_CAPS.items}, default ${MATERIAL_TOOL_CAPS.itemsDefault})` },
      },
      required: ['collection'],
      additionalProperties: false,
    },
  },
]);

/** What the answer looks like: `structuredContent` is the machine answer, `content` the same for an agent reading prose. */
const answer = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload });

const wholeLimit = (value, fallback, max) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(number, max);
};

/** The rows of a group, name included; an index built before `entries` existed still yields its ids. */
const entriesOf = (group) => {
  if (Array.isArray(group?.entries)) return group.entries.map((/** @type {any} */ entry) => ({
    videoId: String(entry.videoId), name: typeof entry.name === 'string' ? entry.name : '',
  }));
  return (Array.isArray(group?.videoIds) ? group.videoIds : []).map((/** @type {any} */ id) => ({ videoId: String(id), name: '' }));
};

/** `~/.openfilm-dev/material-index/index.json`, or whatever `dir` names. */
const loadIndex = (readIndex, dir, home) => readIndex(dir ?? defaultIndexDir({ home }));

const missing = (tool, dir) => answer({
  ok: false, code: 'index-missing', tool, dir,
  message: `还没有素材索引：${dir}/index.json 不存在或无法解析。先跑 node packages/openfilm/scripts/material-index-build.mjs。`,
});

const indexFacts = (result) => ({
  schema: result.schema, generatedAt: result.generatedAt, sourceTotal: result.sourceTotal,
  totals: { videos: result.videos, parsed: result.parsed, unclassified: result.unclassified },
  warnings: Array.isArray(result.warnings) ? result.warnings.map((/** @type {any} */ warning) => warning.code) : [],
});

/** Collections flattened across batches, so `material.collections` and `material.items` agree on what one is. */
function collectionsOf(index, batchId = null) {
  const batches = batchId === null ? index.batches : index.batches.filter((/** @type {any} */ batch) => batch.id === batchId);
  return batches.flatMap((/** @type {any} */ batch) => batch.products.map((/** @type {any} */ product) => ({
    id: product.id, name: product.name, batch: batch.id, count: product.count,
    groups: product.groups.map((/** @type {any} */ group) => ({ id: group.id, name: group.name, count: group.count })),
    raw: product,
  })));
}

/**
 * The four handlers over one index directory. `readIndex` is injected so a test never touches the person's home;
 * `search` is the one handler that leaves this computer (`material-search.mjs`), and it is injected for the same
 * reason — a test asks a function, not a database.
 * @param {{dir?: string | null, home?: string, readIndex?: typeof readMaterialIndex,
 *   search?: ((request: {query: string, filters: Record<string, string | number>, limit: number}) => Promise<any>) | null}} [options]
 */
export function createMaterialTools({
  dir = null, home, readIndex = readMaterialIndex, search = null,
} = /** @type {any} */ ({})) {
  const where = () => dir ?? defaultIndexDir({ home });
  const load = () => {
    const result = loadIndex(readIndex, dir, home);
    return result ?? null;
  };

  return {
    /**
     * The account's own search: `media_search` through `material-search.mjs`, which decides the mode (vector / lexical
     * / index) and refuses to invent a row. This tool has no index of its own to read — the RPC index is the answer —
     * so an installation without a tenant answers `not-configured` and names the setting, exactly like the cloud tools.
     * @param {{query?: string, batch?: string, product?: string, group?: string, durationMaxMs?: number, limit?: number}} [args]
     */
    async 'material.search'(args = {}) {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return answer({ ok: false, code: 'invalid-arguments', tool: 'material.search', message: 'query is required' });
      }
      const limit = wholeLimit(args?.limit, MATERIAL_SEARCH_CAPS.defaultLimit, MATERIAL_SEARCH_CAPS.limit);
      const filters = normaliseFilters({
        batch: args?.batch, product: args?.product, gname: args?.group, durationMaxMs: args?.durationMaxMs,
      });
      if (typeof search !== 'function') {
        return answer({
          ok: false, code: 'not-configured', tool: 'material.search',
          message: 'The material search is not configured on this machine (OPENFILM_MEDIA_TENANT).',
        });
      }
      try {
        const result = await search({ query, filters, limit });
        const items = Array.isArray(result?.items) ? result.items : [];
        return answer({
          ok: true, tool: 'material.search', query: typeof result?.query === 'string' ? result.query : query,
          mode: result?.mode ?? 'index', count: items.length, limit, filters, items,
        });
      } catch (error) {
        return {
          ...answer({
            ok: false, code: /** @type {any} */ (error)?.code ?? 'search-failed', tool: 'material.search',
            message: String(/** @type {any} */ (error)?.message ?? error),
          }),
          isError: true,
        };
      }
    },

    /**
     * @param {{batch?: string}} [args]
     */
    async 'material.collections'(args = {}) {
      const result = load();
      if (!result) return missing('material.collections', where());
      const index = result.index;
      const batchId = typeof args?.batch === 'string' && args.batch.trim() ? args.batch.trim() : null;
      if (batchId !== null && !index.batches.some((/** @type {any} */ batch) => batch.id === batchId)) {
        return answer({
          ok: false, code: 'batch-unknown', tool: 'material.collections', batch: batchId, ...indexFacts(result),
          batches: index.batches.slice(0, MATERIAL_TOOL_CAPS.batches).map((/** @type {any} */ batch) => batch.id),
          message: `没有批次 ${batchId}；索引里的批次见 batches。`,
        });
      }
      const all = collectionsOf(index, batchId);
      const collections = all.slice(0, MATERIAL_TOOL_CAPS.collections).map((collection) => ({
        id: collection.id, name: collection.name, batch: collection.batch, count: collection.count,
        groups: collection.groups.slice(0, MATERIAL_TOOL_CAPS.groupsPerCollection),
      }));
      return answer({
        ok: true, tool: 'material.collections', dir: where(), batch: batchId, ...indexFacts(result),
        collections, truncated: collections.length < all.length,
      });
    },

    /**
     * @param {{collection?: string, group?: string, limit?: number}} [args]
     */
    async 'material.items'(args = {}) {
      const result = load();
      if (!result) return missing('material.items', where());
      const index = result.index;
      const wanted = typeof args?.collection === 'string' ? args.collection.trim() : '';
      if (!wanted) {
        return answer({ ok: false, code: 'invalid-arguments', tool: 'material.items', message: 'collection is required' });
      }
      const all = collectionsOf(index);
      /* id first (it is unique), then the name a person reads — a name can repeat across batches, and then all of them */
      const byId = all.filter((collection) => collection.id === wanted);
      const matches = byId.length ? byId : all.filter((collection) => collection.name === wanted);
      if (!matches.length) {
        return answer({
          ok: false, code: 'collection-unknown', tool: 'material.items', collection: wanted, ...indexFacts(result),
          collections: all.slice(0, MATERIAL_TOOL_CAPS.collections).map((collection) => collection.id),
          message: `没有合集 ${wanted}；先用 material.collections 拿 id。`,
        });
      }

      const groupWanted = typeof args?.group === 'string' && args.group.trim() ? args.group.trim() : null;
      const limit = wholeLimit(args?.limit, MATERIAL_TOOL_CAPS.itemsDefault, MATERIAL_TOOL_CAPS.items);

      /** @type {{videoId: string, name: string}[]} */
      const collected = [];
      let matchedGroups = 0;
      for (const collection of matches) {
        const groups = groupWanted === null
          ? collection.raw.groups
          : collection.raw.groups.filter((/** @type {any} */ group) => group.id === groupWanted || group.name === groupWanted);
        if (groupWanted !== null && !groups.length) continue;
        matchedGroups += groups.length;
        for (const group of groups) for (const entry of entriesOf(group)) collected.push(entry);
      }
      if (groupWanted !== null && matchedGroups === 0) {
        return answer({
          ok: false, code: 'group-unknown', tool: 'material.items', collection: matches[0].id, group: groupWanted, ...indexFacts(result),
          groups: matches[0].groups.map((/** @type {any} */ group) => group.name),
          message: `合集 ${matches[0].id} 里没有分组 ${groupWanted}。`,
        });
      }

      const items = collected.slice(0, limit);
      return answer({
        ok: true, tool: 'material.items', dir: where(), ...indexFacts(result),
        collection: matches.length === 1 ? matches[0].id : matches.map((collection) => collection.id),
        name: matches[0].name, group: groupWanted,
        total: collected.length, items, truncated: items.length < collected.length,
      });
    },
  };
}

/** Call one of the three by name, as an MCP server would. */
export async function callMaterialTool(name, args = {}, options = {}) {
  const handlers = createMaterialTools(options);
  const handler = /** @type {any} */ (handlers)[name];
  if (typeof handler !== 'function') {
    return answer({ ok: false, code: 'unknown-tool', tool: String(name), tools: MATERIAL_TOOL_NAMES });
  }
  return handler(args);
}

/**
 * The five-slot decision, written down so a reviewer can check it instead of guessing.
 *
 * The desktop server's list today is seven names (three of them one wiki read in three modes). Three material tools cost
 * three slots on top of that, and the budget is hard, so:
 *
 *  1. **merged**: `wiki.video` + `wiki.timeline` + `wiki.shot` → `wiki.read` (one tool, `mode` picks), −2 slots.
 *  2. **absorbed**: `materials.search` → `material.search`, −1 slot: one search tool for the account's own documents,
 *     and it is the better one — vectors over the whole library instead of a name filter over one collection.
 *  3. **retired**: `wiki.read` and `openfilm.look` (+3 material tools + `materials.take` + `timeline.insert_clip` = 5).
 *     `openfilm.look` draws a PNG for a person, not for an agent; `wiki.read` belongs to the wiki surface, which this
 *     branch does not serve.
 *
 * The third material slot was `material.batches` until this branch: a batch's own facts are what
 * `material.collections({batch})` answers (it lists every batch when `batch` is omitted, and each collection's count),
 * so the slot went to `material.search` instead — `replaced` says so, and nothing else changed.
 *
 * If the wiki read must stay, the way back inside the budget is to fold `material.collections({batch})` output into
 * something else — `retire` says which names are given up, and `fits` says when the arithmetic no longer works.
 * @param {readonly string[]} [existing] the names the server carries now
 * @param {{retire?: readonly string[]}} [options]
 */
export function planMaterialToolSurface(existing = EXISTING_TOOL_NAMES, { retire = ['wiki.read', 'openfilm.look'] } = {}) {
  const kept = [...existing];
  const applied = [];
  const drop = (name) => {
    const at = kept.indexOf(name);
    if (at !== -1) { kept.splice(at, 1); applied.push(name); }
  };
  /* the three wiki modes are one tool in the contract already: merge them before counting */
  const wiki = ['wiki.video', 'wiki.timeline', 'wiki.shot'].filter((name) => kept.includes(name));
  if (wiki.length) {
    for (const name of wiki) drop(name);
    if (!kept.includes('wiki.read')) kept.push('wiki.read');
  }
  drop('materials.search'); // absorbed into material.search
  for (const name of retire) drop(name);
  /* the served order, and anything kept outside it after: a name that survived is still a name the answer accounts for */
  const after = [
    ...MATERIAL_BUDGET_SURFACE.filter((name) => kept.includes(name) || MATERIAL_TOOL_NAMES.includes(name)),
    ...kept.filter((name) => !MATERIAL_BUDGET_SURFACE.includes(name)),
  ];
  /* the slots, counted the way the prose above counts them: 7 − 2 (wiki merge) − 1 (absorbed) − 2 (retired) + 3 = 5 */
  const merged = wiki.length ? wiki.length - 1 : 0;
  const absorbed = applied.includes('materials.search') ? 1 : 0;
  const retired = retire.filter((name) => applied.includes(name)).length;
  const added = MATERIAL_TOOL_NAMES.filter((name) => !existing.includes(name)).length;
  const slots = {
    before: existing.length,
    merged,
    absorbed,
    retired,
    added,
    after: after.length,
    balanced: existing.length - merged - absorbed - retired + added === after.length,
  };
  return {
    budget: TOOL_BUDGET,
    before: [...existing],
    after,
    count: after.length,
    fits: after.length <= TOOL_BUDGET,
    slots,
    added: MATERIAL_TOOL_NAMES.filter((name) => !existing.includes(name)),
    merged: wiki.length ? [{ from: wiki, to: 'wiki.read', why: '同一个读物，只是模式不同（contract 已是这个形状）' }] : [],
    absorbed: [{ tool: 'materials.search', into: 'material.search', why: '同一个问题，一个检索工具：向量覆盖全库，名称过滤只覆盖一个合集' }],
    replaced: [{ tool: 'material.batches', by: 'material.collections', why: '批次的条数与合集数由 material.collections({batch}) 给出，不必独占一个名额' }],
    retired: retire.filter((name) => applied.includes(name)),
    alternative: '要保留 wiki.read：把 material.collections({batch}) 的结果并进 material.search 的过滤器，工具数仍是 5。',
  };
}
