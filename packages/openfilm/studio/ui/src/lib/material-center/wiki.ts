// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The material centre's wiki: a one-line summary, a scene timeline, a best clip, tags, risks and a production class for
 * one material, and entity pages (products, people, hooks, selling points…) built from them.
 *
 * Nothing here is fetched by looking. A material's wiki is asked for when its panel is first opened and kept for the
 * session (a second open is a memory read); the entity list is asked for when the entity view is first opened. A 200
 * with nothing in it is an empty answer, not a failure — and a service that is not wired yet has its own sentence.
 */
export type Production = 'live' | 'ai' | 'code' | 'mixed';
export type WikiStatus = 'candidate' | 'trusted' | 'disputed';
export type WikiKind = 'product' | 'person' | 'scene' | 'style' | 'brand' | 'collection' | 'hook' | 'selling_point';
export type Arbitration = 'a' | 'b' | 'keep';

export type WikiScene = {readonly startMs: number; readonly endMs: number; readonly desc: string; readonly shotSize?: string; readonly camera?: string};
export type WikiTags = {readonly product?: readonly string[]; readonly person?: readonly string[]; readonly scene?: readonly string[]; readonly style?: readonly string[]};
export type WikiClip = {readonly startMs: number; readonly endMs: number; readonly why: string};

export type VideoWiki = {
  readonly videoId: string;
  readonly oneLine: string;
  readonly scenes: readonly WikiScene[];
  readonly bestClip?: WikiClip;
  readonly tags: WikiTags;
  readonly production: Production;
  readonly confidence: number;
  readonly risks: readonly string[];
  readonly status: WikiStatus;
};

export type WikiEntity = {
  readonly entityId: string;
  readonly kind: WikiKind;
  readonly slug: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly tags: readonly string[];
  readonly sources: readonly string[];
  readonly confidence: number;
  readonly status: 'active' | 'disputed' | 'retired';
};

export const WIKI_KINDS: readonly WikiKind[] = ['product', 'person', 'scene', 'style', 'brand', 'collection', 'hook', 'selling_point'];
export const ARBITRATION_CHOICES: readonly Arbitration[] = ['a', 'b', 'keep'];

/** How a wiki failure is told apart: a service not wired yet, the supplier's rate limit, or a genuine failure. */
export type WikiFailureKind = 'not-connected' | 'limited' | 'failed';
export type WikiFailure = Error & {readonly status: number; readonly code: string; readonly kind: WikiFailureKind};

export function wikiFailureKindOf(status: number, code: string): WikiFailureKind {
  if (status === 429 || code === 'provider-rate-limited' || code === 'rate-limited') return 'limited';
  if (status === 404 || status === 405 || status === 501 || code === 'wiki-service-unavailable' || code === 'not-connected') return 'not-connected';
  return 'failed';
}

const failure = (status: number, code: string, kind: WikiFailureKind, message: string): WikiFailure =>
  Object.assign(new Error(message), {status, code, kind});

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export type WikiClient = {
  readonly routes: readonly string[];
  video(videoId: string): Promise<VideoWiki>;
  entities(): Promise<WikiEntity[]>;
  entity(entityId: string): Promise<WikiEntity>;
  arbitrate(entityId: string, choice: Arbitration): Promise<WikiEntity>;
};

export function createWikiClient(options: {readonly fetch?: Fetcher; readonly baseUrl?: string} = {}): WikiClient {
  const fetcher: Fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = (options.baseUrl ?? '/api/materials/wiki').replace(/\/+$/, '');
  async function read<T>(path: string, decode: (body: unknown) => T, init?: RequestInit): Promise<T> {
    const response = await fetcher(base + path, {cache: 'no-store', redirect: 'error', credentials: 'same-origin', headers: {accept: 'application/json', ...(init?.headers ?? {})}, ...init});
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = isRecord(body) && typeof body.code === 'string' ? body.code : 'internal-error';
      const message = isRecord(body) && typeof body.message === 'string' ? body.message : '接口返回 ' + response.status;
      throw failure(response.status, code, wikiFailureKindOf(response.status, code), message);
    }
    return decode(body);
  }
  const videoOf = (body: unknown): VideoWiki => body as VideoWiki;
  const entityOf = (body: unknown): WikiEntity => (isRecord(body) && isRecord(body.entity) ? body.entity : body) as WikiEntity;
  const listOf = (body: unknown): WikiEntity[] => {
    if (Array.isArray(body)) return body as WikiEntity[];
    if (isRecord(body) && Array.isArray(body.entities)) return body.entities as WikiEntity[];
    return [];
  };
  return {
    routes: Object.freeze(['/video/:id', '/entities', '/entities/:id', '/entities/:id/arbitrate']),
    video: (videoId: string) => read('/video/' + encodeURIComponent(videoId), videoOf),
    entities: () => read('/entities', listOf),
    entity: (entityId: string) => read('/entities/' + encodeURIComponent(entityId), entityOf),
    arbitrate: (entityId: string, choice: Arbitration) => read('/entities/' + encodeURIComponent(entityId) + '/arbitrate', entityOf,
      {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({choice})}),
  };
}

/** The session's memory: each material's wiki read once, the entity list read once, and arbitrations written back. */
export type WikiCache = {
  video(videoId: string): Promise<VideoWiki>;
  peekVideo(videoId: string): VideoWiki | undefined;
  entities(): Promise<readonly WikiEntity[]>;
  peekEntities(): readonly WikiEntity[] | undefined;
  entity(entityId: string): Promise<WikiEntity>;
  arbitrate(entityId: string, choice: Arbitration): Promise<WikiEntity>;
};

export function createWikiCache(client: WikiClient): WikiCache {
  const videos = new Map<string, VideoWiki>();
  const videoFlights = new Map<string, Promise<VideoWiki>>();
  const entityById = new Map<string, WikiEntity>();
  let list: readonly WikiEntity[] | null = null;
  let listFlight: Promise<readonly WikiEntity[]> | null = null;
  return {
    video(videoId) {
      const known = videos.get(videoId);
      if (known) return Promise.resolve(known);
      const flying = videoFlights.get(videoId);
      if (flying) return flying;
      const flight = client.video(videoId).then(wiki => {
        videos.set(videoId, wiki);
        videoFlights.delete(videoId);
        return wiki;
      }, error => {
        videoFlights.delete(videoId);
        throw error;
      });
      videoFlights.set(videoId, flight);
      return flight;
    },
    peekVideo: videoId => videos.get(videoId),
    entities() {
      if (list) return Promise.resolve(list);
      if (listFlight) return listFlight;
      listFlight = client.entities().then(entities => {
        list = entities;
        for (const entity of entities) entityById.set(entity.entityId, entity);
        listFlight = null;
        return entities;
      }, error => {
        listFlight = null;
        throw error;
      });
      return listFlight;
    },
    peekEntities: () => list ?? undefined,
    entity(entityId) {
      const known = entityById.get(entityId);
      if (known) return Promise.resolve(known);
      return client.entity(entityId).then(entity => {
        entityById.set(entity.entityId, entity);
        return entity;
      });
    },
    arbitrate(entityId, choice) {
      return client.arbitrate(entityId, choice).then(entity => {
        entityById.set(entity.entityId, entity);
        if (list) list = list.map(row => (row.entityId === entity.entityId ? entity : row));
        return entity;
      });
    },
  };
}

/** Entities by kind, in the catalogue's order; a kind with nothing in it is not a section. */
export function groupEntities(entities: readonly WikiEntity[]): readonly {readonly kind: WikiKind; readonly entities: readonly WikiEntity[]}[] {
  const groups: {kind: WikiKind; entities: WikiEntity[]}[] = [];
  for (const kind of WIKI_KINDS) {
    const rows = entities.filter(entity => entity.kind === kind);
    if (rows.length > 0) groups.push({kind, entities: rows});
  }
  return groups;
}

/** An arbitration's meaning in the model: adopting a side settles it; keeping the conflict leaves it disputed. */
export function arbitratedStatus(choice: Arbitration): WikiEntity['status'] {
  return choice === 'keep' ? 'disputed' : 'active';
}
