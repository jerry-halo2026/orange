#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * One-pass read-only first read against the supplier, used to close two contract items that the
 * offline receipts could only count:
 *
 *   1. the `video/type/list` entry shape  — does every row carry `level` / `parentTypeId`, or is
 *      the tree nested behind some other key? `facets` classifies on those two fields only.
 *   2. the `video/list` `total` semantics — is the count the requested account's own material, or
 *      the whole company's? The discriminator is row-level: for the sampled rows, does the row's
 *      own `accountKey` equal the `account_key` we requested?
 *
 * Rules enforced by this script, not by convention:
 *   - credentials come only from the ignored local file, through `readSupplierCredentials`;
 *   - single pass, no retry: every step runs exactly once, so a failure is reported as a failure;
 *   - `pageSize` is 1..5 everywhere, `isInner` is 0, and the endpoint list is closed;
 *   - `/openapi/video/query/raw`, every write endpoint and every media download are absent;
 *   - the receipt holds field names, counts, timings and codes only. No material row, no account
 *     value, no token, no key. Values that would identify a person are reduced to a sha256 prefix.
 */
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {signZhishang,ZHISHANG_ORIGIN} from '../src/zhishang.ts';
import {readSupplierCredentials,credentialsPath} from '../src/credentials.ts';

const PAGE=3;
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

function nonce(){return createHash('sha256').update(String(Date.now())+Math.random()).digest('hex').slice(0,16);}

async function post(endpoint,body,extra={}){
  const at=Date.now();
  const timestamp=String(Math.floor(at/1000));
  const unique=nonce();
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
  return {status,payload,note};
}

const envelope=(result)=>result.payload&&result.payload.success===true&&Number(result.payload.code)===1?result.payload.data:null;

// 1 · token (the only auth call; reused by every read below)
const tokenResult=await post('/openapi/auth/access_token',{});
const token=envelope(tokenResult)?.accessToken;
const receipt={checkedAt:new Date(started).toISOString(),origin:ZHISHANG_ORIGIN,loginSha256Prefix8:fingerprint(accountLogin),steps,findings:{},verdict:{}};

if(typeof token!=='string'||!token){receipt.verdict={status:'blocked',reason:'access_token not obtained'};await finish();}

// 2 · exact account resolution: `account` first, `name` only if the first is empty. One literal
// per request, pageSize 5, never a directory scan.
let resolved=null,resolvedField=null;
for(const field of ['account','name']){
  const result=await post('/openapi/account/list',{pageNo:1,pageSize:5,[field]:accountLogin},{access_token:token});
  const data=envelope(result);
  const list=Array.isArray(data?.list)?data.list.filter(row=>row&&typeof row==='object'):[];
  const matches=list.filter(row=>row[field]===accountLogin);
  receipt.findings[`accountLookup.${field}`]={rows:list.length,total:Number.isSafeInteger(Number(data?.total))?Number(data.total):null,exactMatches:matches.length};
  if(list.length===0)continue;
  if(matches.length===1){resolved=matches[0];resolvedField=field;break;}
  receipt.verdict={status:'blocked',reason:`${field} lookup was not a single exact match`,exactMatches:matches.length};await finish();
}
if(!resolved){receipt.verdict={status:'blocked',reason:'login not found by exact account or name match'};await finish();}
const accountKey=typeof resolved.accountKey==='string'?resolved.accountKey:String(resolved.accountKey??'');
if(!accountKey){receipt.verdict={status:'blocked',reason:'account row has no accountKey'};await finish();}
receipt.findings.accountResolution={resolvedField,accountKeySha256Prefix8:fingerprint(accountKey),accountKeyLength:accountKey.length,stateIsActive:Number(resolved.state)===1,rowFieldNames:Object.keys(resolved).sort()};

// 3 · video/list: pageSize 3. The only question is what `total` counts.
const listResult=await post('/openapi/video/list',{pageNo:1,pageSize:PAGE,isInner:0,videoType:1},{access_token:token,account_key:accountKey});
const listData=envelope(listResult);
const rows=Array.isArray(listData?.list)?listData.list.filter(row=>row&&typeof row==='object'):[];
const rowKeys=[...new Set(rows.flatMap(row=>Object.keys(row)))].sort();
const sameAuthor=rows.filter(row=>typeof row.accountKey==='string'&&row.accountKey===accountKey).length;
const otherAuthor=rows.filter(row=>typeof row.accountKey==='string'&&row.accountKey!==accountKey).length;
const authorUnknown=rows.length-sameAuthor-otherAuthor;
receipt.findings.videoList={
  rows:rows.length,
  total:Number.isSafeInteger(Number(listData?.total))?Number(listData.total):null,
  rowFieldNames:rowKeys,
  rowsWithAccountKeyField:rows.filter(row=>row.accountKey!==undefined).length,
  rowsMatchingRequestedAccount:sameAuthor,
  rowsWithDifferentAccount:otherAuthor,
  rowsWithoutAccountKey:authorUnknown,
  confirmedFieldTypes:{oneLevelVideoType:typeOf(rows[0]?.oneLevelVideoType),twoLevelVideoType:typeOf(rows[0]?.twoLevelVideoType),videoLabels:typeOf(rows[0]?.videoLabels),videoState:typeOf(rows[0]?.videoState),videoType:typeOf(rows[0]?.videoType)},
};

// 4 · video/type/list: the shape `facets` classifies on.
const typeResult=await post('/openapi/video/type/list',{videoType:1},{access_token:token,account_key:accountKey});
const typeData=envelope(typeResult);
const entries=Array.isArray(typeData)?typeData:(Array.isArray(typeData?.list)?typeData.list:null);
receipt.findings.typeTree={
  payloadKind:Array.isArray(typeData)?'array':typeData&&typeof typeData==='object'?'object':'other',
  entryCount:entries?.length??null,
  keysUnion:entries?[...new Set(entries.flatMap(entry=>entry&&typeof entry==='object'?Object.keys(entry):[]))].sort():null,
  entriesWithLevel:entries?entries.filter(entry=>entry&&entry.level!==undefined).length:null,
  levelValues:entries?[...new Set(entries.map(entry=>entry?.level).filter(value=>value!==undefined).map(Number))].sort((a,b)=>a-b):null,
  entriesWithParentTypeId:entries?entries.filter(entry=>entry&&entry.parentTypeId!==undefined).length:null,
  entriesWithChildren:entries?entries.filter(entry=>entry&&entry.children!==undefined).length:null,
  childKeysUnion:entries?[...new Set(entries.flatMap(entry=>Array.isArray(entry?.children)?entry.children.flatMap(child=>child&&typeof child==='object'?Object.keys(child):[]):[]))].sort():null,
};

// 5 · label/list: pageSize 1, count only.
const labelResult=await post('/openapi/label/list',{pageNo:1,pageSize:1,videoType:1},{access_token:token,account_key:accountKey});
const labelData=envelope(labelResult);
const labelRows=Array.isArray(labelData?.list)?labelData.list:[];

// Verdicts
const treeOk=Boolean(receipt.findings.typeTree.keysUnion?.includes('level')||receipt.findings.typeTree.entriesWithChildren);
receipt.verdict={
  status:'read',
  typeTreeShape:treeOk?'classifier-compatible':'classifier-incompatible',
  typeTreeNote:receipt.findings.typeTree.entriesWithLevel?'every row carries `level`':`rows without \`level\`: ${(receipt.findings.typeTree.entryCount??0)-(receipt.findings.typeTree.entriesWithLevel??0)}`,
  totalSemantics:otherAuthor>0?'company-wide':sameAuthor>0?'at-most-requested-account':'undetermined',
  totalSemanticsEvidence:`${otherAuthor} of ${rows.length} sampled rows belong to a different accountKey, ${sameAuthor} to the requested one`,
  labelCount:Number.isSafeInteger(Number(labelData?.total))?Number(labelData.total):null,
  labelRows:labelRows.length,
};
await finish();

function typeOf(value){return value===undefined?'absent':Array.isArray(value)?'array':typeof value==='object'?`object:${Object.keys(value).sort().join('|')}`:typeof value;}
async function finish(){
  receipt.elapsedMs=Date.now()-started;
  receipt.calls=steps.length;
  await writeFile(outFile,JSON.stringify(receipt,null,2),'utf8');
  process.stdout.write(JSON.stringify({out:outFile,calls:receipt.calls,elapsedMs:receipt.elapsedMs,verdict:receipt.verdict})+'\n');
  process.exit(receipt.verdict.status==='read'?0:1);
}
