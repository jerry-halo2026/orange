// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * An in-memory store that also enforces the version rule.
 *
 * `compileVideo` already refuses a stale analyser before it writes, but a store is shared by every
 * caller (a re-import, a replay, a repair script), so the rule is checked again here - and this is the
 * check that a test can prove by writing straight to the store.
 */
import {compareVer} from './compile.ts';
import type {EntityKind,EntityRow,EventRow,Store,SummaryRow} from './types.ts';

export type MemoryWikiStore=Store&Readonly<{
  entities():readonly EntityRow[];
  events():readonly EventRow[];
  summaries():readonly SummaryRow[];
  /** Writes that actually changed something, as opposed to calls that were refused. */
  counts():Readonly<{entities:number;events:number;summaries:number;refused:number}>;
}>;

export function createMemoryWikiStore(seed:readonly EntityRow[]=[]):MemoryWikiStore {
  const entities=new Map<string,EntityRow>();
  const events=new Map<string,EventRow>();
  const summaries=new Map<string,SummaryRow>();
  const counts={entities:0,events:0,summaries:0,refused:0};
  for(const row of seed)entities.set(`${row.company_key}/${row.entity_id}`,row);

  return Object.freeze({
    async readEntity(companyKey,kind,slug){
      for(const row of entities.values())if(row.company_key===companyKey&&row.kind===kind&&row.slug===slug)return row;
      return null;
    },
    async readEntityById(companyKey,entityId){return entities.get(`${companyKey}/${entityId}`)??null;},
    async listEntitiesBySource(companyKey,videoId){
      return [...entities.values()].filter(row=>row.company_key===companyKey&&row.sources.includes(videoId));
    },
    async upsertEntity(row){
      const current=entities.get(`${row.company_key}/${row.entity_id}`);
      if(current&&compareVer(row.analyzer_ver,current.analyzer_ver)<0){counts.refused+=1;throw Object.assign(new Error('stale-analyzer-version'),{code:'stale-analyzer-version'});}
      entities.set(`${row.company_key}/${row.entity_id}`,row);
      counts.entities+=1;
    },
    async upsertSummary(row){
      const current=summaries.get(`${row.company_key}/${row.video_id}`);
      if(current&&compareVer(row.analyzer_ver,current.analyzer_ver)<0){counts.refused+=1;throw Object.assign(new Error('stale-analyzer-version'),{code:'stale-analyzer-version'});}
      summaries.set(`${row.company_key}/${row.video_id}`,row);
      counts.summaries+=1;
    },
    async recordEvent(row){
      // `event_id` is the idempotency key: a recompiled video adds nothing.
      if(events.has(`${row.company_key}/${row.event_id}`))return;
      events.set(`${row.company_key}/${row.event_id}`,row);
      counts.events+=1;
    },
    entities:()=>[...entities.values()],
    events:()=>[...events.values()],
    summaries:()=>[...summaries.values()],
    counts:()=>Object.freeze({...counts}),
  });
}

export type {EntityKind};
