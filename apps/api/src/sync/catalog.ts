// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The sync catalogue: pull the supplier's material list into `material`, idempotently.
 *
 * Three modes, and the reason each exists:
 *  - `day`       the change clock the supplier actually honours (`esUpdateStartTime/EndTime`, one day
 *                wide because the value must be a calendar day) plus newest-first ordering;
 *  - `watermark` walk newest-first until the page falls behind the stored cursor, so a long outage
 *                heals without asking for a range the supplier cannot express;
 *  - `full`      a weekly reconciliation: everything, and the only mode that may mark deletions.
 *
 * Paging **never** terminates on `total`. The supplier answers an out-of-range page with `total=0`,
 * which is indistinguishable from "nothing matched", so termination is "this page is empty" (or, for
 * the watermark mode, "we are past the cursor").
 *
 * The cursor only moves forward after a page has been persisted: a failed batch leaves the watermark
 * where it was, so the next run asks for the same window again instead of silently skipping it.
 */
import type {Limiter} from './rate.ts';
import {withBackoff} from './rate.ts';
import {contentHash} from './hash.ts';
import type {MaterialRow,MaterialStore,SyncCursor,SyncMode,SyncState} from './store.ts';

/** The supplier row, already decoded by the transport (numbers unwrapped). */
export type CatalogItem=Readonly<{
  videoId:string;
  observation:Readonly<Record<string,unknown>>;
}>;

export type CatalogPage=Readonly<{items:readonly CatalogItem[]}>;

export type CatalogReader=Readonly<{
  /** One page, newest-first; `filter` carries the window the mode needs. */
  page(request:Readonly<{pageNo:number;pageSize:number;filter:Readonly<Record<string,string|number>>}>):Promise<CatalogPage>;
}>;

export type SyncTarget=Readonly<{companyKey:string;envId:string;accountKey?:string}>;

export type SyncOptions=Readonly<{
  reader:CatalogReader;
  store:MaterialStore;
  target:SyncTarget;
  mode:SyncMode;
  dryRun?:boolean;
  now?:()=>number;
  limiter?:Limiter;
  /** Attempts per page before the run gives up and leaves the cursor alone. */
  attempts?:number;
  sleep?:(ms:number)=>Promise<void>;
  /** Extra day of overlap so a supplier that lands late is still picked up. */
  overlapDays?:number;
}>;

export type SyncReport=Readonly<{
  mode:SyncMode;
  companyKey:string;
  envId:string;
  dryRun:boolean;
  pages:number;
  requests:number;
  seen:number;
  upserted:number;
  skipped:number;
  deleted:number;
  cursor:SyncCursor;
  status:'ok'|'failed';
  error:string|null;
}>;

const DAY_MS=24*60*60*1000;
const iso=()=>new Date().toISOString();
const dayString=(stamp:number)=>new Date(stamp).toISOString().slice(0,10);
const text=(value:unknown):string|null=>typeof value==='string'&&value.length?value:null;
const number=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?value:null;
const wrapped=(value:unknown):string|null=>{
  if(typeof value==='string')return value;
  if(value&&typeof value==='object'&&(value as {sourceType?:unknown}).sourceType==='number'&&typeof (value as {source?:unknown}).source==='string')return (value as {source:string}).source;
  return null;
};

/** One supplier row as the `material` row it becomes; `null` when the id is unusable. */
export function toMaterialRow(item:CatalogItem,target:SyncTarget):MaterialRow|null {
  const observation=item.observation;
  const videoId=item.videoId;
  if(!videoId)return null;
  const labels=Array.isArray(observation.videoLabels)?observation.videoLabels.map(entry=>String(entry)).filter(entry=>entry.length):[];
  const category2=wrapped(observation.twoLevelVideoTypeId)??wrapped((observation.twoLevelVideoType as {id?:unknown}|undefined)?.id);
  return Object.freeze({
    company_key:target.companyKey,
    env_id:target.envId,
    video_id:videoId,
    video_type:number(observation.videoType),
    name:text(observation.name),
    size:number(observation.fileSize),
    duration_ms:number(observation.duration),
    category1_id:wrapped(observation.oneLevelVideoTypeId)??wrapped((observation.oneLevelVideoType as {id?:unknown}|undefined)?.id),
    category2_id:category2,
    labels:Object.freeze(labels),
    account_key:text(observation.accountKey),
    account_name:text(observation.accountName),
    create_time:text(observation.createTime),
    provider_state:(observation.videoState??null) as MaterialRow['provider_state'],
    sha256:null,
    content_hash:contentHash({
      name:observation.name,
      size:observation.fileSize,
      duration:observation.duration,
      category2,
      labels,
      createTime:observation.createTime,
      account:observation.accountKey,
    }),
  });
}

/** The filter the mode sends; the keys are the same ones `filters.ts` allows. */
function windowFor(mode:SyncMode,nowMs:number,overlapDays:number):Record<string,string|number> {
  if(mode!=='day')return {orderByType:1};
  const start=dayString(nowMs-overlapDays*DAY_MS);
  const end=dayString(nowMs);
  return {orderByType:1,esUpdateStartTime:start,esUpdateEndTime:end};
}

const pageSizeFor=(mode:SyncMode)=>mode==='full'?1000:200;

const behind=(createTime:string|null,cursor:SyncCursor):boolean=>{
  if(!createTime||!cursor.createTime)return false;
  return createTime<cursor.createTime;
};

export async function syncCatalog(options:SyncOptions):Promise<SyncReport> {
  const {reader,store,target,mode}=options;
  const dryRun=options.dryRun===true;
  const now=options.now??Date.now;
  const overlapDays=options.overlapDays??1;
  const pageSize=pageSizeFor(mode);
  const recent=store.readState?await store.readState(target.companyKey,target.envId,mode):null;
  let cursor:SyncCursor=recent?.cursor??{createTime:null,videoId:null};

  let pageNo=1,pages=0,requests=0,seen=0,upserted=0,skipped=0,deleted=0;
  const seenIds:string[]=[];

  try{
    for(;;){
      const request=Object.freeze({pageNo,pageSize,filter:Object.freeze(windowFor(mode,now(),overlapDays))});
      const page=await (options.limiter
        ? options.limiter.run(()=>withBackoff(()=>reader.page(request),{attempts:options.attempts??5,sleep:options.sleep}))
        : withBackoff(()=>reader.page(request),{attempts:options.attempts??5,sleep:options.sleep}));
      requests+=1;pages+=1;
      // Termination is an empty page - never `total`, which reads 0 on an out-of-range page too.
      if(!page.items.length)break;

      const rows:MaterialRow[]=[];
      for(const item of page.items){
        const row=toMaterialRow(item,target);
        if(!row)continue;
        seen+=1;seenIds.push(row.video_id);
        rows.push(row);
      }

      if(mode==='watermark'&&rows.length&&rows.every(row=>behind(row.create_time,cursor))){
        // The whole page is older than the cursor: we are past the window, so this page is not
        // written and the cursor does not move.
        break;
      }

      if(rows.length&&!dryRun){
        const existing=await store.hashes(target.companyKey,target.envId,rows.map(row=>row.video_id));
        const changed=rows.filter(row=>existing.get(row.video_id)!==row.content_hash);
        skipped+=rows.length-changed.length;
        if(changed.length)upserted+=await store.upsert(changed);
      }else{
        skipped+=rows.length;
      }

      // The cursor moves only after the page above is durable in the store.
      if(!dryRun){
        const newest=rows.reduce<string|null>((latest,row)=>(row.create_time&&(!latest||row.create_time>latest)?row.create_time:latest),cursor.createTime);
        if(newest&&newest!==cursor.createTime)cursor={createTime:newest,videoId:null};
      }

      if(page.items.length<pageSize)break;
      pageNo+=1;
    }

    if(mode==='full'&&!dryRun){
      deleted=await store.pruneMissing(target.companyKey,target.envId,seenIds,iso());
    }

    const report:SyncReport=Object.freeze({mode,companyKey:target.companyKey,envId:target.envId,dryRun,pages,requests,seen,upserted,skipped,deleted,cursor,status:'ok',error:null});
    if(!dryRun)await store.writeState(stateOf(report,now()));
    return report;
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    // A failed run reports the cursor it started from: nothing was committed past that point.
    const report:SyncReport=Object.freeze({mode,companyKey:target.companyKey,envId:target.envId,dryRun,pages,requests,seen,upserted,skipped,deleted:0,cursor:recent?.cursor??{createTime:null,videoId:null},status:'failed',error:message});
    if(!dryRun)await store.writeState(stateOf(report,now()));
    throw Object.assign(new Error(`sync failed: ${message}`),{code:'sync-failed',report});
  }
}

function stateOf(report:SyncReport,nowMs:number):SyncState {
  return Object.freeze({
    company_key:report.companyKey,
    env_id:report.envId,
    mode:report.mode,
    account_key:'',
    cursor:report.cursor,
    last_run:new Date(nowMs).toISOString(),
    drift:Object.freeze({seen:report.seen,upserted:report.upserted,skipped:report.skipped,deleted:report.deleted}),
    pages:report.pages,
    requests:report.requests,
    status:report.status,
    error:report.error,
  });
}
