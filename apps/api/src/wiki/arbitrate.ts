// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Human arbitration for a disputed page.
 *
 * A dispute is not resolved by more evidence - a later video that agrees with the incumbent leaves the
 * page `disputed` on purpose (test 10). Only an explicit choice does, and that choice is recorded as
 * an event so the reasoning survives the decision.
 */
import {compareVer,type Triage} from './compile.ts';
import type {EntityRow,EventRow,Store} from './types.ts';

export type ArbitrateOptions=Readonly<{
  companyKey:string;
  entityId:string;
  choice:'a'|'b'|'keep';
  store:Store;
  /** Who decided; defaults to `human`. */
  by?:string;
  now?:()=>number;
}>;

export type ArbitrateResult=Readonly<{
  entityId:string;
  choice:'a'|'b'|'keep';
  status:'active'|'disputed';
  adopted:boolean;
  disputes:number;
}>;

export async function arbitrate(options:ArbitrateOptions):Promise<ArbitrateResult> {
  const {companyKey,entityId,choice,store}=options;
  if(!companyKey)throw Object.assign(new Error('companyKey is required'),{code:'invalid-tenant'});
  const row=await store.readEntityById(companyKey,entityId);
  if(!row)throw Object.assign(new Error('entity not found'),{code:'entity-not-found',status:404});
  const now=new Date((options.now??Date.now)()).toISOString();

  // `a` is the incumbent (what the page said), `b` is the challenger recorded on the dispute.
  const latest=row.disputes[row.disputes.length-1]??null;
  let next:EntityRow=row;

  if(choice==='a'||choice==='b'){
    if(!latest)throw Object.assign(new Error('no dispute to arbitrate'),{code:'no-dispute',status:409});
    if(choice==='a'){
      // Keeping the incumbent text: only the flag changes.
      next=Object.freeze({...row,status:'active' as const,last_updated:now});
    }else{
      // Adopting the challenger: its text and its source become the page, the old sources stay.
      const challenger=latest.candidate;
      const sources=row.sources.includes(challenger.video_id)?[...row.sources]:[...row.sources,challenger.video_id];
      next=Object.freeze({
        ...row,
        body_md:challenger.body_md,
        sources:Object.freeze(sources),
        confidence:1,
        status:'active' as const,
        // The adopted text came from that analyser, so the page records that version.
        analyzer_ver:compareVer(challenger.analyzer_ver,row.analyzer_ver)>0?challenger.analyzer_ver:row.analyzer_ver,
        last_updated:now,
      });
    }
    await store.upsertEntity(next);
  }

  const triage:Triage=next.status==='disputed'?'disputed':'update';
  await store.recordEvent(Object.freeze({
    company_key:companyKey,
    event_id:`${entityId}:arbitrate:${choice}:${now}`,
    video_id:latest?.candidate.video_id??null,
    entity_id:entityId,
    kind:'arbitrate',
    detail:Object.freeze({choice,by:options.by??'human',status:next.status,triage,disputes:next.disputes.length}),
    analyzer_ver:next.analyzer_ver,
    at:now,
  }) as EventRow);

  return Object.freeze({entityId,choice,status:next.status,adopted:choice==='b',disputes:next.disputes.length});
}
