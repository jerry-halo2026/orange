// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The cloud-steward panel's groups: one supplier two-level category, one card.
 *
 * A group card is a **name**. At 888 groups, "a request per card in view" is not a strategy but a denial of service:
 * the supplier throttles the account and every later list and raw call fails. So the tree is the only read the panel
 * makes on its own (`facets`, cached 24 h by the server), and a group's count is learned where it is already paid for —
 * the list that opens the group answers `providerTotal` — or, when the person explicitly asks for counts, by a small
 * controlled queue (≤24 groups, 2 at a time, the client's 6 QPS gate) that stops the moment the supplier says no.
 */
import type {Facets, MaterialPage, OneLevelCategory, WireNumber} from './contract.ts';

/** What the board needs from a client: the tree, and one small page per group. */
export type GroupBoardClient = {
  facets(query: Readonly<Record<string, string | number>>): Promise<Facets>;
  list(query: Readonly<Record<string, string | number>>): Promise<MaterialPage>;
};

/** One two-level category, as a card. `key` is stable for the session cache. */
export type GroupRef = {
  readonly id: number;
  readonly name: string;
  readonly oneLevelId: number;
  readonly oneLevelName: string;
  readonly key: string;
};

/** A one-level category as a section; a section with one group shows it directly (no extra nesting layer). */
export type GroupSection = {
  readonly oneLevel: {readonly id: number; readonly name: string};
  readonly groups: readonly GroupRef[];
  readonly flat: boolean;
};

export type GroupScope = 'company' | 'own';

export function buildGroupSections(facets: {readonly oneLevel: readonly OneLevelCategory[]} | null | undefined): readonly GroupSection[] {
  if (!facets) return [];
  const sections: GroupSection[] = [];
  for (const one of facets.oneLevel) {
    const children = one.children ?? [];
    if (children.length === 0) continue;
    const groups = children.map(child => ({
      id: child.id,
      name: child.name,
      oneLevelId: one.id,
      oneLevelName: one.name,
      key: one.id + '/' + child.id,
    }));
    sections.push({oneLevel: {id: one.id, name: one.name}, groups, flat: groups.length === 1});
  }
  return sections;
}

export function allGroups(sections: readonly GroupSection[]): readonly GroupRef[] {
  return sections.flatMap(section => section.groups);
}

/** The panel's words for one group card; English until a language says otherwise. */
export type GroupCopy = {
  readonly title: string;
  /** The list's first row: no 合集 chosen, every cloud material. */
  readonly allMaterials: string;
  /** The breadcrumb's way back to "no 合集 chosen". */
  readonly clear: string;
  readonly close: string;
  readonly crumbRoot: string;
  readonly back: string;
  readonly loading: string;
  readonly empty: string;
  readonly failed: string;
  readonly updated: string;
  readonly showCounts: string;
  readonly hideCounts: string;
  readonly limitNotice: string;
  readonly countAtLeast: (count: number) => string;
  readonly countExact: (count: number) => string;
};

/** Why a counts batch stopped early. */
export type GroupNotice = 'throttled' | null;

export type GroupBoardOptions = {
  readonly client: GroupBoardClient;
  readonly scope: GroupScope;
  readonly videoType: number;
  /** How many groups one explicit "show counts" pass asks about; defaults to 24. */
  readonly batch?: number;
  /** How many of those are out at once; defaults to 2. */
  readonly concurrency?: number;
  /** The page size a counts read asks for (the count comes from `providerTotal`); defaults to 1. */
  readonly pageSize?: number;
  readonly now?: () => number;
  /** The session memory; defaults to the page's one board memory. */
  readonly cache?: GroupBoardCache;
};

export type GroupBoard = {
  /** The tree for this scope: one facets read per session, none on a remount. */
  load(): Promise<void>;
  sections(): readonly GroupSection[];
  failure(): {readonly status: number; readonly code: string} | null;
  /** The count a group already has (from its own page, or a counts batch); null while unknown. */
  count(key: string): number | null;
  /** A count learned elsewhere — the drill-down's `providerTotal` — written without a request. */
  remember(group: GroupRef, total: number | null): void;
  /** The explicit pass: up to `batch` unknown groups, `concurrency` at a time, stopping on a throttle. */
  collect(): Promise<void>;
  collecting(): boolean;
  notice(): GroupNotice;
  /** The person asks again after reading the throttle sentence. */
  clearNotice(): void;
  /** How many groups a full pass may ask about. */
  batchSize(): number;
  subscribe(listener: () => void): () => void;
  destroy(): void;
};

/**
 * The session's memory of the board: the tree and the known counts, by scope.
 *
 * A page's panel may mount more than once (a reopen, a re-render above it); sharing this is what keeps a second mount
 * from reading the tree again, and what lets a count learned in a drill-down show on the card after the person returns.
 */
export type GroupBoardCache = {
  sections(scope: GroupScope): readonly GroupSection[] | undefined;
  setSections(scope: GroupScope, sections: readonly GroupSection[]): void;
  count(scope: GroupScope, key: string): number | null | undefined;
  setCount(scope: GroupScope, key: string, count: number | null): void;
};

export function createGroupBoardCache(): GroupBoardCache {
  const trees = new Map<GroupScope, readonly GroupSection[]>();
  const counts = new Map<string, number | null>();
  return {
    sections: scope => trees.get(scope),
    setSections(scope, sections) { trees.set(scope, sections); },
    count: (scope, key) => counts.get(scope + '|' + key),
    setCount(scope, key, count) { counts.set(scope + '|' + key, count); },
  };
}

/** One page's board memory, shared by every mount of the panel in this session. */
export const sessionGroupBoards = createGroupBoardCache();

/** The supplier's refusal to be asked that often. */
export function isThrottled(error: unknown): boolean {
  const at = error as {status?: number; code?: string; body?: {code?: string}} | null;
  if (!at || typeof at !== 'object') return false;
  const code = at.code ?? at.body?.code;
  return at.status === 429 || code === 'provider-rate-limited';
}

export function createGroupBoard(options: GroupBoardOptions): GroupBoard {
  const batch = Math.max(1, options.batch ?? 24);
  const limit = Math.max(1, options.concurrency ?? 2);
  const pageSize = Math.max(1, options.pageSize ?? 1);
  const memory = options.cache ?? sessionGroupBoards;
  const listeners = new Set<() => void>();
  let sections: readonly GroupSection[] = memory.sections(options.scope) ?? [];
  let failure: {status: number; code: string} | null = null;
  let notice: GroupNotice = null;
  let collecting = false;
  let live = true;
  let loading: Promise<void> | null = null;
  const notify = () => { for (const listener of listeners) listener(); };

  async function readCount(group: GroupRef): Promise<{count: number | null; throttled: boolean}> {
    try {
      const page = await options.client.list({pageNo: 1, pageSize, videoType: options.videoType, scope: options.scope, twoLevelTypeIds: String(group.id)});
      const raw: WireNumber | number = page.providerTotal ?? page.total ?? page.items.length;
      const total = typeof raw === 'number' ? raw : Number(raw);
      memory.setCount(options.scope, group.key, total);
      notify();
      return {count: total, throttled: false};
    } catch (error) {
      if (!live) return {count: null, throttled: false};
      /* The supplier's no is final for this pass: mark the group unknown, stop, and say why. Never ask again by
         itself — only a person pressing the button starts another pass. */
      if (isThrottled(error)) return {count: null, throttled: true};
      return {count: null, throttled: false};
    }
  }

  return {
    load() {
      const known = memory.sections(options.scope);
      if (known) {
        sections = known;
        return Promise.resolve();
      }
      if (loading) return loading;
      failure = null;
      loading = (async () => {
        try {
          const facets: Facets = await options.client.facets({videoType: options.videoType, scope: options.scope});
          if (!live) return;
          sections = buildGroupSections(facets);
          memory.setSections(options.scope, sections);
        } catch (error) {
          if (!live) return;
          const at = error as {status?: number; code?: string};
          failure = {status: typeof at?.status === 'number' ? at.status : 500, code: typeof at?.code === 'string' ? at.code : ''};
          sections = [];
        } finally {
          loading = null;
        }
        notify();
      })();
      return loading;
    },
    sections: () => sections,
    failure: () => failure,
    count: key => memory.count(options.scope, key) ?? null,
    remember(group, total) {
      memory.setCount(options.scope, group.key, total);
      notify();
    },
    async collect() {
      if (!live || collecting) return;
      /* A refusal stands until the person clears it: the queue never restarts itself. */
      if (notice === 'throttled') return;
      const unknown = allGroups(sections).filter(group => memory.count(options.scope, group.key) === undefined).slice(0, batch);
      if (unknown.length === 0) return;
      collecting = true;
      notice = null;
      notify();
      let stop = false;
      const queue = [...unknown];
      const worker = async () => {
        while (live && !stop && queue.length > 0) {
          const group = queue.shift()!;
          const outcome = await readCount(group);
          if (outcome.throttled) {
            stop = true;
            notice = 'throttled';
            notify();
            return;
          }
        }
      };
      try {
        await Promise.all(Array.from({length: Math.min(limit, unknown.length)}, worker));
      } finally {
        collecting = false;
        notify();
      }
    },
    collecting: () => collecting,
    notice: () => notice,
    clearNotice() { notice = null; notify(); },
    batchSize: () => batch,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      live = false;
      listeners.clear();
    },
  };
}
