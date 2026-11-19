// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The wiki layer's data shapes. Everything here is plain data: the compile step receives a store and
 * an analyzer, and never reaches for a database or a model on its own.
 */

/** The fixed taxonomy. A new kind is a schema change, not a prompt tweak. */
export const ENTITY_KINDS=Object.freeze(['product','person','scene','style','brand','collection','hook','selling_point'] as const);
export type EntityKind=typeof ENTITY_KINDS[number];

export const isEntityKind=(value:unknown):value is EntityKind=>typeof value==='string'&&(ENTITY_KINDS as readonly string[]).includes(value);

/** `disputed` is a state a human has to resolve; nothing in a compile run clears it. */
export type EntityStatus='active'|'disputed';

/** One side of a disagreement, kept so an arbitration can adopt it verbatim. */
export type DisputeCandidate=Readonly<{
  claim:string;
  body_md:string;
  sources:readonly string[];
  analyzer_ver:string;
  video_id:string;
}>;

export type Dispute=Readonly<{
  at:string;
  /** Which side of the pair this record argues for. */
  side:'b';
  reason:string|null;
  candidate:DisputeCandidate;
  /** The claim that was already on the page when the dispute arrived. */
  incumbent:DisputeCandidate;
}>;

export type EntityRow=Readonly<{
  company_key:string;
  entity_id:string;
  kind:EntityKind;
  slug:string;
  title:string;
  body_md:string;
  tags:readonly string[];
  /** Every video that ever contributed; a merge never drops one. */
  sources:readonly string[];
  confidence:number;
  status:EntityStatus;
  analyzer_ver:string;
  last_updated:string;
  /** Append-only. An arbitration keeps the record; it does not delete it. */
  disputes:readonly Dispute[];
}>;

export type SummaryRow=Readonly<{
  company_key:string;
  video_id:string;
  summary_md:string;
  analyzer_ver:string;
  content_hash:string;
  updated_at:string;
}>;

export type EventRow=Readonly<{
  company_key:string;
  event_id:string;
  video_id:string|null;
  entity_id:string|null;
  kind:'new'|'update'|'disputed'|'arbitrate'|'summary';
  detail:Readonly<Record<string,unknown>>;
  analyzer_ver:string;
  at:string;
}>;

export type Store=Readonly<{
  readEntity(companyKey:string,kind:EntityKind,slug:string):Promise<EntityRow|null>;
  /** Not in the original six: an arbitration is given an entity id, not a (kind, slug) pair. */
  readEntityById(companyKey:string,entityId:string):Promise<EntityRow|null>;
  listEntitiesBySource(companyKey:string,videoId:string):Promise<EntityRow[]>;
  upsertEntity(row:EntityRow):Promise<void>;
  upsertSummary(row:SummaryRow):Promise<void>;
  recordEvent(row:EventRow):Promise<void>;
}>;

/** `(prompt, schema) -> unknown`. The reply is validated, never trusted. */
export type Analyzer=(prompt:string,schema:object)=>Promise<unknown>;

export type Claim=Readonly<{
  kind:EntityKind;
  /** A human-readable name; the slug is derived from it unless `slug` is given. */
  title:string;
  slug?:string;
  /** The claim this video makes about the entity. */
  claim:string;
  /** How this video relates to what the wiki already says. */
  relation:'new'|'supports'|'contradicts';
  tags?:readonly string[];
  confidence?:number;
}>;

/** What the analyser hands to the compiler: one video's claims, not its raw understanding. */
export type VideoSummary=Readonly<{
  videoId:string;
  claims:readonly Claim[];
  /** Free-form notes the analyzer may use when writing the page. */
  notes?:string;
  analyzerVer:string;
}>;
