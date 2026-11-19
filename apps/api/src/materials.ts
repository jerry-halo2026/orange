// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Material-centre read contract (function + type layer only; no route is registered here).
 *
 * Three operations, all read-only and all carrying `authorization:{layer,reason}` in the result:
 *  - `list`   — `/openapi/video/list`, passing only field-confirmed parameters
 *               (`pageNo`, `pageSize`, `videoType`, plus the reviewed `name`/`videoIds`),
 *               with `isInner` forced to 0 and `pageSize` capped at 100;
 *  - `facets` — one-level/two-level categories, states and the company label set;
 *  - `labels` — the paged company label set.
 *
 * A request outside `public`/`self`/`granted` is rejected before any supplier traffic: the throw
 * carries `code: authorization-denied` and the denial's `authorization:{layer:null,reason}`. The
 * transport independently refuses any `account_key` that is not the caller's own binding unless
 * the composition's `authorizeAccount` clears it, so a contract-layer bug alone cannot widen the
 * read scope.
 *
 * Not implemented here on purpose: `video/query/raw` (it increments supplier download counters),
 * any upload/write endpoint, account-directory enumeration, and any cloud write.
 */
import {fail,SupplierError} from './errors.ts';
import {decide,type Access,type Authorization,type Decision,type MaterialScope} from './authorization.ts';
import type {ExternalId,Observation,ZhishangReadOnly} from './zhishang.ts';
import {plainRow,plainRows,type PlainRow} from './plain.ts';
import {FILTER_KEYS,filterValues} from './filters.ts';

export type MaterialListQuery=Readonly<{pageNo?:number;pageSize?:number;videoType?:number;name?:string;videoIds?:string;scope?:MaterialScope}>;
export type MaterialFacetsQuery=Readonly<{videoType?:number;scope?:MaterialScope}>;
export type MaterialLabelsQuery=Readonly<{pageNo?:number;pageSize?:number;videoType?:number;scope?:MaterialScope}>;

export type MaterialItem=Readonly<{videoId:ExternalId;observation:Readonly<Record<string,Observation>>}>;

export type MaterialListResponse=Readonly<{
  authorization:Authorization;
  providerScope:string;
  pageNo:number;
  pageSize:number;
  /** Rows this page is allowed to show. Never a claim about the whole result set. */
  items:readonly MaterialItem[];
  /** The supplier's own total for the query, unchanged. Not an author-scoped count. */
  total?:Observation;
  providerTotal:number|null;
  totalIsProviderTotal:true;
  /** How this page was narrowed. `inspected` is the supplier row count, `dropped` the rest. */
  filtered:Readonly<{inspected:number;dropped:number}>;
  grants:false;
}>;

export type MaterialFacetsResponse=Readonly<{
  authorization:Authorization;
  providerScope:string;
  videoType:number;
  oneLevel:readonly PlainRow[];
  twoLevel:readonly PlainRow[];
  states:readonly PlainRow[];
  publicLabels:readonly PlainRow[];
  labelTotal?:Observation;
}>;

export type MaterialLabelsResponse=Readonly<{
  authorization:Authorization;
  providerScope:string;
  pageNo:number;
  pageSize:number;
  labels:readonly PlainRow[];
  total?:Observation;
}>;

export type MaterialsReadOnly=Readonly<{
  list(context:unknown,query?:MaterialListQuery):Promise<MaterialListResponse>;
  facets(context:unknown,query?:MaterialFacetsQuery):Promise<MaterialFacetsResponse>;
  labels(context:unknown,query?:MaterialLabelsQuery):Promise<MaterialLabelsResponse>;
}>;

export type MaterialsDependencies=Readonly<{
  transport:ZhishangReadOnly;
  /** Trusted side: the subject's own key, the company-view key, and the explicit grant list. */
  access:(context:unknown)=>Access|Promise<Access>;
}>;

const LIST_KEYS:readonly string[]=Object.freeze(['pageNo','pageSize','videoType','name','videoIds','scope',...FILTER_KEYS]);
const FACET_KEYS:readonly string[]=Object.freeze(['videoType','scope']);
const LABEL_KEYS:readonly string[]=Object.freeze(['pageNo','pageSize','videoType','scope']);
const PAGE_SIZE_MAX=100;
const PAGE_NO_MAX=1000000;

const printable=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);

function shape(query:unknown,allowed:readonly string[]):Record<string,unknown> {
  if(query===undefined)return Object.create(null);
  if(!query||typeof query!=='object'||Array.isArray(query))return fail('invalid-query',422);
  const record=query as Record<string,unknown>;
  if(Object.keys(record).some(key=>!allowed.includes(key)))return fail('invalid-query',422);
  return record;
}

function paging(query:Record<string,unknown>,defaultPageSize:number):{pageNo:number;pageSize:number;videoType:number} {
  const pageNo=query.pageNo??1,pageSize=query.pageSize??defaultPageSize,videoType=query.videoType??1;
  if(!Number.isSafeInteger(pageNo)||(pageNo as number)<1||(pageNo as number)>PAGE_NO_MAX)return fail('invalid-query',422);
  if(!Number.isSafeInteger(pageSize)||(pageSize as number)<1||(pageSize as number)>PAGE_SIZE_MAX)return fail('invalid-query',422);
  if(!Number.isSafeInteger(videoType)||(videoType as number)<0||(videoType as number)>4)return fail('invalid-query',422);
  return {pageNo:pageNo as number,pageSize:pageSize as number,videoType:videoType as number};
}

/** A one-level row keeps its children, each child unwrapped like any other row. */
function facetTree(rows:readonly Observation[]):readonly PlainRow[]{
  return Object.freeze((rows as readonly unknown[]).map(row=>{
    const plain=plainRow(row);
    const children=(row as {children?:unknown}).children;
    return Object.freeze({...plain,...(Array.isArray(children)?{children:plainRows(children)}:{})});
  }));
}

const denial=(decision:Extract<Decision,{allowed:false}>):never=>{
  const status=decision.code==='invalid-query'?422:403;
  throw Object.assign(new SupplierError(decision.code,status),{authorization:decision.authorization});
};

/**
 * Row-level narrowing, forced by the first live read: `account_key` selects the company view, not
 * one author (3 of 3 sampled rows belonged to a different `accountKey`). So each layer decides
 * which authors it may show:
 *  - `public`  — the company view: every row stays;
 *  - `self`    — only rows whose `accountKey` is exactly the resolved self key;
 *  - `granted` — only rows whose `accountKey` is in the explicit allow-list.
 *
 * A row without an `accountKey` is dropped in the `self`/`granted` layers: an unidentified author
 * cannot be proven to be in scope. The page is never extended or re-fetched to refill — a short
 * page is reported as short, with `filtered` saying how much was inspected and dropped.
 */
function authorOf(item:MaterialItem):string|null {
  const value=item.observation.accountKey;
  return typeof value==='string'?value:null;
}

function narrow(layer:Authorization['layer'],access:Access,items:readonly MaterialItem[]):readonly MaterialItem[] {
  if(layer==='public')return items;
  if(layer==='self'){
    const self=access.selfAccountKey;
    return typeof self==='string'?items.filter(item=>authorOf(item)===self):[];
  }
  const grants=access.grants;
  return items.filter(item=>{const author=authorOf(item);return author!==null&&grants.includes(author);});
}

export function createMaterialsReadOnly(dependencies:MaterialsDependencies):MaterialsReadOnly {
  if(!dependencies||!dependencies.transport||typeof dependencies.access!=='function')return fail('configuration-required');
  const transport=dependencies.transport;

  async function authorize(context:unknown,scope:unknown):Promise<{decision:Decision&{allowed:true};access:Access}> {
    const access=await dependencies.access(context);
    // The material centre is a company pool: with no explicit scope the company view is the default.
    // It falls back to the caller's own account only when no company key exists, so a machine that
    // has no company key keeps whatever it could read before instead of failing closed twice.
    const fallback=access.companyAccountKey?{kind:'company' as const}:{kind:'own' as const};
    const decision=decide(scope??fallback,access);
    if(!decision.allowed)return denial(decision);
    return {decision:decision as Decision&{allowed:true},access};
  }

  return Object.freeze({
    async list(context:unknown,query:MaterialListQuery={}):Promise<MaterialListResponse> {
      const record=shape(query,[...LIST_KEYS]);
      const {pageNo,pageSize,videoType}=paging(record,20);
      if(record.name!==undefined&&!printable(record.name,128))return fail('invalid-query',422);
      if(record.videoIds!==undefined&&!printable(record.videoIds,512))return fail('invalid-query',422);
      // The supplier's filter dimensions (contract 8.1); date pairs are validated together, so the
      // whole set is parsed at once instead of key by key.
      const filters=filterValues(record);
      const {decision,access}=await authorize(context,record.scope);
      // `isInner:0` is not a caller parameter; the transport fixes it and rejects any attempt to
      // send it (it is outside the reviewed query whitelist).
      const result=await transport.listMaterialsAs(context,decision.accountKey,{pageNo,pageSize,videoType,...(record.name===undefined?{}:{name:record.name as string}),...(record.videoIds===undefined?{}:{videoIds:record.videoIds as string}),...filters});
      const inspected=Object.freeze(result.items.map(item=>Object.freeze({videoId:item.videoId,observation:item.observation})));
      const items=narrow(decision.authorization.layer,access,inspected);
      const total=result.total as Observation|undefined;
      const providerTotal=total&&typeof total==='object'&&!Array.isArray(total)&&total.sourceType==='number'&&Number.isSafeInteger(Number(total.source))?Number(total.source):null;
      return Object.freeze({
        authorization:decision.authorization,
        providerScope:result.providerScope,
        pageNo:result.pageNo,
        pageSize:result.pageSize,
        items:Object.freeze([...items]),
        ...(total===undefined?{}:{total}),
        providerTotal,
        totalIsProviderTotal:true as const,
        filtered:Object.freeze({inspected:inspected.length,dropped:inspected.length-items.length}),
        grants:false as const,
      });
    },
    async facets(context:unknown,query:MaterialFacetsQuery={}):Promise<MaterialFacetsResponse> {
      const record=shape(query,[...FACET_KEYS]);
      const {videoType}=paging({videoType:record.videoType},50);
      const {decision}=await authorize(context,record.scope);
      const result=await transport.listFacets(context,decision.accountKey,{videoType});
      // Contract 1.3 publishes plain numbers and strings (the editor's OneLevelCategory), so the wire
      // number wrappers are unwrapped here. `labelTotal` stays a WireNumber by that same contract.
      return Object.freeze({
        authorization:decision.authorization,
        providerScope:result.providerScope,
        videoType:result.videoType,
        oneLevel:facetTree(result.oneLevel),
        twoLevel:plainRows(result.twoLevel),
        states:plainRows(result.states),
        publicLabels:plainRows(result.publicLabels),
        ...(result.labelTotal===undefined?{}:{labelTotal:result.labelTotal}),
      });
    },
    async labels(context:unknown,query:MaterialLabelsQuery={}):Promise<MaterialLabelsResponse> {
      const record=shape(query,[...LABEL_KEYS]);
      const {pageNo,pageSize,videoType}=paging(record,50);
      const {decision}=await authorize(context,record.scope);
      const result=await transport.listLabels(context,decision.accountKey,{pageNo,pageSize,videoType});
      return Object.freeze({authorization:decision.authorization,providerScope:result.providerScope,pageNo:result.pageNo,pageSize:result.pageSize,labels:plainRows(result.labels),...(result.total===undefined?{}:{total:result.total})});
    },
  });
}
