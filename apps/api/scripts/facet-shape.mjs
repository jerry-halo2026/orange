#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * One-pass read-only shape check for the two facet dimensions that `facets` depends on:
 *
 *   - `video/type/list` — re-confirms the split the contract layer now performs: the top array is
 *     the one-level list and every row carries `children` (the two-level list).
 *   - `video/state/list` — first read. Records the payload kind, entry count and key union so the
 *     state dimension can be filed against the live shape rather than the document example.
 *
 * Same rules as `first-read.mjs`: credentials only from the ignored local file, one pass, no
 * retry, `isInner` untouched (no material read here at all), and the receipt carries field names,
 * counts, timings and codes only — no values, no account identifiers beyond a sha256 prefix.
 */
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {signZhishang,ZHISHANG_ORIGIN} from '../src/zhishang.ts';
import {readSupplierCredentials,credentialsPath} from '../src/credentials.ts';

const ARGS=new Map();
for(const argv of process.argv.slice(2)){
  const match=/^--([a-z-]+)(?:=(.*))?$/.exec(argv);
  if(!match)throw new Error(`unknown argument ${argv}`);
  ARGS.set(match[1],match[2]);
}
const checkout=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','..');
const credentialFile=ARGS.get('credentials')??credentialsPath(checkout);
const accountLogin=ARGS.get('account');
const outFile=ARGS.get('out');
if(!accountLogin)throw new Error('--account=<exact login or display name> is required');
if(!outFile)throw new Error('--out=<receipt.json> is required');

const fingerprint=(value)=>typeof value==='string'&&value.length?createHash('sha256').update(value).digest('hex').slice(0,8):null;
const credentials=await readSupplierCredentials(credentialFile);
const steps=[];
const started=Date.now();
const kind=(value)=>Array.isArray(value)?'array':value&&typeof value==='object'?'object':typeof value;
const keysOf=(entries)=>[...new Set(entries.flatMap(entry=>entry&&typeof entry==='object'?Object.keys(entry):[]))].sort();

async function post(endpoint,body,extra={}){
  const at=Date.now();
  const timestamp=String(Math.floor(at/1000));
  const unique=createHash('sha256').update(String(at)+Math.random()).digest('hex').slice(0,16);
  const fields={company_key:credentials.companyKey,timestamp,nonce:unique,...extra};
  const headers={...fields,sign:signZhishang({...fields,...body},credentials.companySecret),'content-type':'application/json'};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  let status=0,payload=null,note=null;
  try{
    const response=await fetch(ZHISHANG_ORIGIN+endpoint,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:controller.signal});
    status=response.status;
    const text=await response.text();
    if(Buffer.byteLength(text,'utf8')>3*1024*1024)throw new Error('response too large');
    payload=JSON.parse(text);
  }catch(error){note=error?.name==='AbortError'?'timeout':String(error?.code??error?.name??'transport-error');}
  finally{clearTimeout(timer);}
  steps.push({endpoint,httpStatus:status,supplierCode:Number.isInteger(payload?.code)?payload.code:null,elapsedMs:Date.now()-at,...(note===null?{}:{note})});
  return payload&&payload.success===true&&Number(payload.code)===1?payload.data:null;
}

const receipt={checkedAt:new Date(started).toISOString(),origin:ZHISHANG_ORIGIN,loginSha256Prefix8:fingerprint(accountLogin),steps,findings:{},verdict:{}};

const token=(await post('/openapi/auth/access_token',{}))?.accessToken;
if(typeof token!=='string'||!token){receipt.verdict={status:'blocked',reason:'access_token not obtained'};await finish();}

let accountKey=null;
for(const field of ['account','name']){
  const data=await post('/openapi/account/list',{pageNo:1,pageSize:5,[field]:accountLogin},{access_token:token});
  const list=Array.isArray(data?.list)?data.list:null;
  if(list&&list.length===0)continue;
  const match=list?.filter(row=>row&&row[field]===accountLogin)??[];
  receipt.findings[`accountLookup.${field}`]={rows:list?.length??0,exactMatches:match.length};
  if(match.length===1){accountKey=typeof match[0].accountKey==='string'?match[0].accountKey:String(match[0].accountKey);break;}
  receipt.verdict={status:'blocked',reason:`${field} lookup was not a single exact match`};await finish();
}
if(!accountKey){receipt.verdict={status:'blocked',reason:'login not found by exact account or name match'};await finish();}
receipt.findings.accountKeySha256Prefix8=fingerprint(accountKey);

const tree=await post('/openapi/video/type/list',{videoType:1},{access_token:token,account_key:accountKey});
const tops=Array.isArray(tree)?tree:Array.isArray(tree?.list)?tree.list:null;
const children=tops?tops.flatMap(row=>Array.isArray(row?.children)?row.children:[]):null;
receipt.findings.typeTree={
  payloadKind:kind(tree),
  topCount:tops?.length??null,
  topsWithChildrenArray:tops?tops.filter(row=>Array.isArray(row?.children)).length:null,
  childrenTotal:children?.length??null,
  topKeys:tops?keysOf(tops):null,
  childKeys:children?keysOf(children):null,
  childLevelValues:children?[...new Set(children.map(child=>Number(child?.level)).filter(Number.isFinite))].sort((a,b)=>a-b):null,
  childrenPerTopFirst5:tops?tops.slice(0,5).map(row=>Array.isArray(row?.children)?row.children.length:null):null,
};

const states=await post('/openapi/video/state/list',{},{access_token:token,account_key:accountKey});
const stateRows=Array.isArray(states)?states:Array.isArray(states?.list)?states.list:null;
receipt.findings.stateList={
  payloadKind:kind(states),
  rootKeys:states&&typeof states==='object'&&!Array.isArray(states)?Object.keys(states).sort():null,
  entryCount:stateRows?.length??null,
  keysUnion:stateRows?keysOf(stateRows):null,
  totalValue:Number.isSafeInteger(Number(states?.total))?Number(states.total):null,
};

receipt.verdict={
  status:'read',
  typeTreeSplittable:Boolean(tops?.length)&&Boolean(children)&&(receipt.findings.typeTree.topsWithChildrenArray===tops?.length),
  counts:`top ${tops?.length??'?'} / children ${children?.length??'?'}`,
  stateShapeFileable:Boolean(stateRows),
  stateNote:stateRows?'state rows are an array of objects; `collection()` already accepts this':'state payload shape is not an array or {list}; facets must be revisited',
};
await finish();

async function finish(){
  receipt.elapsedMs=Date.now()-started;
  receipt.calls=steps.length;
  await writeFile(outFile,JSON.stringify(receipt,null,2),'utf8');
  process.stdout.write(JSON.stringify({out:outFile,calls:receipt.calls,elapsedMs:receipt.elapsedMs,verdict:receipt.verdict})+'\n');
  process.exit(receipt.verdict.status==='read'?0:1);
}
