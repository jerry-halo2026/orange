// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Where the sync writes: the `material` table and one `sync_state` row per (tenant, environment, mode).
 *
 * Two implementations live here:
 *  - `createRestStore` talks to PostgREST (`/rest/v1/...`), which is how this service reaches the
 *    database in production: zero dependencies, one HTTP hop, and the tenant is passed as an explicit
 *    filter on every statement because RLS reads `app.company_key` from the connection;
 *  - the tests use a plain in-memory store, so the sync logic is verified without a database.
 *
 * Deletion is a **tombstone**, never a DELETE: a vanished row can mean "the supplier hid it", and a
 * physical delete would destroy the analysis history hanging off the same id.
 */
import type {Observation} from '../zhishang.ts';

export type SyncMode='day'|'watermark'|'full';
export type SyncCursor=Readonly<{createTime:string|null;videoId:string|null}>;

export type MaterialRow=Readonly<{
  company_key:string;
  env_id:string;
  video_id:string;
  video_type:number|null;
  name:string|null;
  size:number|null;
  duration_ms:number|null;
  category1_id:string|null;
  category2_id:string|null;
  labels:readonly string[];
  account_key:string|null;
  account_name:string|null;
  create_time:string|null;
  provider_state:Observation|null;
  sha256:string|null;
  content_hash:string;
}>;

export type SyncState=Readonly<{
  company_key:string;
  env_id:string;
  mode:SyncMode;
  /** The supplier account this watermark belongs to; `''` is the company-wide run (007/008 keep it in the key). */
  account_key:string;
  cursor:SyncCursor;
  last_run:string;
  drift:Readonly<{seen:number;upserted:number;skipped:number;deleted:number}>;
  pages:number;
  requests:number;
  status:'ok'|'failed';
  error:string|null;
}>;

export type MaterialStore=Readonly<{
  /** Current fingerprints for the ids in this page; a missing id maps to `undefined`. */
  hashes(companyKey:string,envId:string,videoIds:readonly string[]):Promise<Map<string,string|null>>;
  /** Insert-or-update by the natural key; returns how many rows were written. */
  upsert(rows:readonly MaterialRow[]):Promise<number>;
  /** Tombstone every row this tenant has that the full run did not see. */
  pruneMissing(companyKey:string,envId:string,seenVideoIds:readonly string[],at:string):Promise<number>;
  readState(companyKey:string,envId:string,mode:SyncMode):Promise<SyncState|null>;
  writeState(state:SyncState):Promise<void>;
}>;

export type RestStoreOptions=Readonly<{
  baseUrl:string;
  apiKey:string;
  fetch?:typeof fetch;
}>;

/**
 * The sync writes with a service credential, and the tenant travels **only** as an explicit
 * `company_key=eq.` filter on every statement below 鈥?never as a header. A header would be one more
 * place where a tenant could disagree with the filter, and PostgREST does not turn an arbitrary
 * header into `app.company_key` anyway; the previous `x-company-key` was silently ignored on the
 * server and looked like isolation in the code.
 */
const jsonHeaders=(options:RestStoreOptions,extra:Record<string,string>={})=>({
  apikey:options.apiKey,
  authorization:`Bearer ${options.apiKey}`,
  'content-type':'application/json',
  accept:'application/json',
  ...extra,
});

const quote=(value:string)=>`"${value.replace(/"/g,'\\"')}"`;

/** PostgREST-backed store. Every statement carries the tenant explicitly; nothing is inferred. */
export function createRestStore(options:RestStoreOptions):MaterialStore {
  const fetcher=options.fetch??globalThis.fetch;
  const base=options.baseUrl.replace(/\/+$/,'');

  const call=async(path:string,init:RequestInit):Promise<unknown>=>{
    const response=await fetcher(`${base}${path}`,{...init,headers:jsonHeaders(options,(init.headers??{}) as Record<string,string>)});
    if(!response.ok){const detail=await response.text().catch(()=>'');throw Object.assign(new Error(`postgrest ${response.status}`),{code:'store-failed',status:response.status,detail:detail.slice(0,512)});}
    const body=await response.text();
    return body.length?JSON.parse(body):null;
  };

  return Object.freeze({
    async hashes(companyKey,envId,videoIds){
      const map=new Map<string,string|null>();
      if(!videoIds.length)return map;
      // Chunked `in` list: a long URL is a 414, not a smaller query.
      for(let index=0;index<videoIds.length;index+=100){
        const chunk=videoIds.slice(index,index+100);
        const path=`/rest/v1/material?select=video_id,content_hash&company_key=eq.${encodeURIComponent(companyKey)}&env_id=eq.${encodeURIComponent(envId)}&video_id=in.(${chunk.map(quote).join(',')})`;
        const rows=(await call(path,{method:'GET'})) as Array<{video_id:string;content_hash:string|null}>|null;
        for(const row of rows??[])map.set(row.video_id,row.content_hash);
      }
      return map;
    },
    async upsert(rows){
      if(!rows.length)return 0;
      const body=rows.map(row=>({...row,labels:[...row.labels]}));
      const result=(await call('/rest/v1/material?on_conflict=company_key,env_id,video_id',{
        method:'POST',body:JSON.stringify(body),
        // merge-duplicates is the idempotent half: the same natural key overwrites, never duplicates.
        headers:{prefer:'resolution=merge-duplicates,return=representation'},
      })) as unknown[]|null;
      return Array.isArray(result)?result.length:rows.length;
    },
    async pruneMissing(companyKey,envId,seenVideoIds,at){
      const present=(await call(`/rest/v1/material?select=video_id&company_key=eq.${encodeURIComponent(companyKey)}&env_id=eq.${encodeURIComponent(envId)}&deleted_at=is.null`,{method:'GET'})) as Array<{video_id:string}>|null;
      const seen=new Set(seenVideoIds);
      const missing=(present??[]).map(row=>row.video_id).filter(id=>!seen.has(id));
      if(!missing.length)return 0;
      await call(`/rest/v1/material?company_key=eq.${encodeURIComponent(companyKey)}&env_id=eq.${encodeURIComponent(envId)}&video_id=in.(${missing.map(quote).join(',')})`,{
        method:'PATCH',body:JSON.stringify({deleted_at:at}),
      });
      return missing.length;
    },
    async readState(companyKey,envId,mode){
      const rows=(await call(`/rest/v1/sync_state?select=*&company_key=eq.${encodeURIComponent(companyKey)}&env_id=eq.${encodeURIComponent(envId)}&mode=eq.${encodeURIComponent(mode)}&order=account_key.asc`,{method:'GET'})) as SyncState[]|null;
      return rows&&rows.length?rows[0]:null;
    },
    async writeState(state){
      // Four columns, because 008 made account_key part of the key; a three-column conflict target is 42P10.
      await call('/rest/v1/sync_state?on_conflict=company_key,env_id,mode,account_key',{
        method:'POST',body:JSON.stringify([{...state,account_key:state.account_key??''}]),
        headers:{prefer:'resolution=merge-duplicates'},
      });
    },
  });
}

/** 鏈ā鍧楅渶瑕佺殑 DDL **涓嶅啀**浠ュ父閲忓舰寮忓鍒跺湪杩欓噷锛氳縼绉绘槸鍞竴鏉ユ簮銆? *  - `sync_state` 寤鸿〃涓庢敞閲婏細docs/sql/005_sync_state.sql
 *  - `sync_state.account_key` 涓庡洓鍒椾富閿?(company_key,env_id,mode,account_key)锛歞ocs/sql/008_unify_surface.sql
 *  - `material.deleted_at` 杞垹闄ゅ垪锛歞ocs/sql/005_sync_state.sql
 *  鍦ㄨ繖閲岀暀绗簩浠?DDL 鍙細璁┾€滀唬鐮侀噷鐨勮〃缁撴瀯鈥濆拰鈥滆縼绉婚噷鐨勮〃缁撴瀯鈥濆悇鑷紓绉伙紙涓婁竴鐗堝氨婕備簡锛? *  涓婚敭灏戜竴鍒?account_key 鍗存病鏈変竴澶勮兘鍙戠幇锛夈€傝鏀硅〃锛屽嚭 010 杩佺Щ锛屼笉鏀硅繖涓枃浠躲€?*/
