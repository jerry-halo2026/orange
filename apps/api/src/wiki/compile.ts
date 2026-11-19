// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Compile one video's claims into wiki pages.
 *
 * The cloud does **compilation only**: the claims arrive already understood (the analyser machine
 * produced them), and this step decides - deterministically, not by asking a model - whether each
 * entity page is new, extended, or disputed, then asks the model only to write the Markdown.
 *
 * Why the decision is not the model's: a model that is asked "is this a conflict?" will sometimes say
 * no, and a silently swallowed conflict is exactly the failure this layer exists to prevent.
 *
 * All pages are compiled and validated **before** anything is written, so a malformed reply leaves the
 * store untouched.
 */
import {ENTITY_KINDS,isEntityKind,type Analyzer,type Claim,type Dispute,type EntityKind,type EntityRow,type EventRow,type Store,type SummaryRow,type VideoSummary} from './types.ts';
import {PAGE_SCHEMA,validate} from './schema.ts';
import {slugFor} from './slug.ts';

export type Triage='new'|'update'|'disputed';

export type EntityRef=Readonly<{entityId:string;kind:EntityKind;slug:string;triage:Triage}>;

export type CompileResult=Readonly<{triage:readonly Triage[];entities:readonly EntityRef[];events:number}>;

export type CompileOptions=Readonly<{
  companyKey:string;
  videoId:string;
  summary:VideoSummary;
  analyzer:Analyzer;
  store:Store;
  now?:()=>number;
}>;

export const malformed=(reason:string)=>Object.assign(new Error(`analyzer-malformed: ${reason}`),{code:'analyzer-malformed'});

/**
 * Versions are compared as plain strings, which is what "dictionary order" means here: `a1.0 < a1.10`
 * because `0` sorts before `1`. A newer version may overwrite; an equal one may re-write the same
 * page (idempotent); an older one never may.
 */
export const compareVer=(left:string,right:string):number=>left===right?0:(left<right?-1:1);

export function entityId(companyKey:string,kind:EntityKind,slug:string):string {
  return `${companyKey}:${kind}:${slug}`;
}

/**
 * The event key: one event per (video, entity, triage, analyser version).
 *
 * Recompiling the same video at the same version with the same verdict is the same event and is
 * deduplicated by the store. A **change of verdict** is not a duplicate - update becoming
 * disputed must leave its own event, otherwise the moment a page started disagreeing would be
 * missing from the event stream, which is precisely what an audit needs.
 */
export function eventId(videoId:string,kind:string,slug:string,triage:Triage,version:string):string {
  return `${videoId}:${kind}:${slug}:${triage}:${version}`;
}

const isPlain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

function pagePrompt(input:Readonly<{kind:EntityKind;claim:Claim;existing:EntityRow|null;notes?:string}>):string {
  const {kind,claim,existing,notes}=input;
  return [
    'You are compiling one page of an internal material wiki.',
    `Entity kind: ${kind}`,
    `Title: ${claim.title}`,
    `This video claims: ${claim.claim}`,
    existing?`The page already says:\n${existing.body_md}`:'This page does not exist yet.',
    notes?`Analyser notes: ${notes}`:'',
    'Write the page body in Markdown. Do not invent facts that are not in the claim.',
    'Return only JSON matching the schema.',
  ].filter(line=>line.length).join('\n');
}

type Page=Readonly<{title:string;body_md:string;tags:readonly string[];confidence:number}>;

async function writePage(analyzer:Analyzer,prompt:string):Promise<Page> {
  const reply=await analyzer(prompt,PAGE_SCHEMA);
  const reason=validate(PAGE_SCHEMA,reply);
  if(reason)throw malformed(reason);
  const page=reply as Page;
  return Object.freeze({title:page.title,body_md:page.body_md,tags:Object.freeze([...page.tags].map(tag=>tag.trim()).filter(tag=>tag.length)),confidence:page.confidence});
}

const mergeTags=(old:readonly string[],incoming:readonly string[]):readonly string[]=>{
  const out=[...old];
  for(const tag of incoming)if(!out.includes(tag))out.push(tag);
  return Object.freeze(out);
};

const mergeSources=(old:readonly string[],videoId:string):readonly string[]=>Object.freeze(old.includes(videoId)?[...old]:[...old,videoId]);

const candidateOf=(input:Readonly<{claim:Claim;page:Page;videoId:string;version:string}>):Dispute['candidate']=>Object.freeze({
  claim:input.claim.claim,
  body_md:input.page.body_md,
  sources:Object.freeze([input.videoId]),
  analyzer_ver:input.version,
  video_id:input.videoId,
});

export async function compileVideo(options:CompileOptions):Promise<CompileResult> {
  const {companyKey,videoId,summary,analyzer,store}=options;
  // A wiki page is only meaningful inside a tenant; there is no "default" one.
  if(typeof companyKey!=='string'||!companyKey.length)throw Object.assign(new Error('companyKey is required'),{code:'invalid-tenant'});
  if(!summary||!Array.isArray(summary.claims))throw malformed('summary.claims is required');
  const version=summary.analyzerVer;
  if(typeof version!=='string'||!version.length)throw malformed('summary.analyzerVer is required');
  const now=new Date((options.now??Date.now)()).toISOString();

  // 1. Compile every claim to a page, validated, before touching the store.
  const staged:Array<{claim:Claim;page:Page;existing:EntityRow|null;triage:Triage;slug:string;kind:EntityKind}>=[];
  for(const claim of summary.claims){
    if(!isEntityKind(claim.kind))throw malformed(`unknown entity kind: ${String(claim.kind)}`);
    const kind=claim.kind as EntityKind;
    const slug=slugFor(claim.title,claim.slug);
    const existing=await store.readEntity(companyKey,kind,slug);
    const page=await writePage(analyzer,pagePrompt({kind,claim,existing,notes:summary.notes}));

    let triage:Triage;
    if(!existing)triage='new';
    else if(claim.relation==='contradicts')triage='disputed';
    else triage='update';

    // An older analyser may extend nothing: it would rewrite the page with a weaker reading.
    if(existing&&compareVer(version,existing.analyzer_ver)<0)throw Object.assign(new Error('stale-analyzer-version'),{code:'stale-analyzer-version',entityId:existing.entity_id});

    staged.push({claim,page,existing,triage,slug,kind});
  }

  // 2. Write: each page once, then its event. Nothing above wrote anything.
  let events=0;
  const refs:EntityRef[]=[];
  const triage:Array<Triage>=[];
  for(const entry of staged){
    const id=entityId(companyKey,entry.kind,entry.slug);
    const {claim,page,existing}=entry;

    let row:EntityRow;
    if(!existing){
      row=Object.freeze({
        company_key:companyKey,entity_id:id,kind:entry.kind,slug:entry.slug,title:page.title,
        body_md:page.body_md,tags:page.tags,sources:Object.freeze([videoId]),confidence:page.confidence,
        status:'active' as const,analyzer_ver:version,last_updated:now,disputes:Object.freeze([]),
      });
    }else if(entry.triage==='disputed'){
      // The incumbent text is kept **verbatim**; the new reading is only recorded as the other side.
      const dispute:Dispute=Object.freeze({
        at:now,side:'b' as const,reason:claim.claim,
        candidate:candidateOf({claim,page,videoId,version}),
        incumbent:Object.freeze({
          claim:existing.body_md,body_md:existing.body_md,sources:Object.freeze([...existing.sources]),
          analyzer_ver:existing.analyzer_ver,video_id:existing.sources[existing.sources.length-1]??videoId,
        }),
      });
      row=Object.freeze({
        ...existing,
        status:'disputed' as const,
        sources:mergeSources(existing.sources,videoId),
        tags:mergeTags(existing.tags,page.tags),
        disputes:Object.freeze([...existing.disputes,dispute]),
        last_updated:now,
      });
    }else if(existing.status==='disputed'){
      // A page under dispute keeps its text until a human decides: more evidence may widen it
      // (tags, sources) but never quietly rewrites the sentence two sources disagree about.
      row=Object.freeze({
        ...existing,
        tags:mergeTags(existing.tags,page.tags),
        sources:mergeSources(existing.sources,videoId),
        last_updated:now,
      });
    }else{
      row=Object.freeze({
        ...existing,
        title:page.title,
        body_md:page.body_md,
        tags:mergeTags(existing.tags,page.tags),
        sources:mergeSources(existing.sources,videoId),
        confidence:page.confidence,
        analyzer_ver:version,
        last_updated:now,
      });
    }

    await store.upsertEntity(row);
    await store.recordEvent(Object.freeze({
      company_key:companyKey,
      event_id:eventId(videoId,entry.kind,entry.slug,entry.triage,version),
      video_id:videoId,entity_id:id,kind:entry.triage,
      detail:Object.freeze({slug:entry.slug,kind:entry.kind,status:row.status,sources:row.sources}),
      analyzer_ver:version,at:now,
    }) as EventRow);
    events+=1;
    triage.push(entry.triage);
    refs.push(Object.freeze({entityId:id,kind:entry.kind,slug:entry.slug,triage:entry.triage}));
  }

  // 3. The summary goes through the store's own entry point, so its idempotency lives in one place.
  await store.upsertSummary(Object.freeze({
    company_key:companyKey,video_id:videoId,
    summary_md:summary.notes??summary.claims.map(claim=>`- ${claim.title}: ${claim.claim}`).join('\n'),
    analyzer_ver:version,content_hash:`${version}:${videoId}`,
    updated_at:now,
  }) as SummaryRow);

  return Object.freeze({triage:Object.freeze(triage),entities:Object.freeze(refs),events});
}

export {ENTITY_KINDS};
