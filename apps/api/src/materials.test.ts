// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyBearer} from './supabase.ts';
import {createZhishangReadOnly,ZHISHANG_ORIGIN} from './zhishang.ts';
import {createMaterialsReadOnly} from './materials.ts';
import {createMemoryGrantStore,decide} from './authorization.ts';
import {toPublicError} from './errors.ts';

const here=dirname(fileURLToPath(import.meta.url));
const ORIGIN=ZHISHANG_ORIGIN;
const SUBJECT='11111111-1111-4111-8111-111111111111';
const SELF='fixture-self-account-key',COMPANY='fixture-company-account-key',GRANTED='fixture-granted-account-key',FOREIGN='fixture-foreign-account-key';
const config={environmentId:'fixture-env',companyKey:'fixture_company',companySecret:'fixture_secret'};
const failure=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;

async function principal(subject=SUBJECT){
  const claims={sub:subject,session_id:'33333333-3333-4333-8333-333333333333',exp:Math.floor(Date.now()/1000)+600,role:'authenticated',aud:'authenticated',iss:'https://fixture.supabase.co/auth/v1'};
  const token='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture-signature';
  return verifyBearer({environmentId:'fixture-env',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'fixture-public'},'Bearer '+token,async()=>Response.json({id:subject,is_anonymous:false}));
}

const reply=(data:unknown)=>Response.json({success:true,code:1,data});
const wire=(text:string)=>new Response(text,{headers:{'content-type':'application/json'}});

type Call={url:string;init:RequestInit;headers:Headers;body:unknown};
type Options={now?:()=>number;grants?:readonly string[];access?:(context:unknown)=>Promise<{selfAccountKey?:string;companyAccountKey?:string;grants:readonly string[]}>};

function fixture(options:Options={}){
  const grants=options.grants??[GRANTED];
  const access=options.access??(async()=>({selfAccountKey:SELF,companyAccountKey:COMPANY,grants:createMemoryGrantStore(grants).list()}));
  const calls:Call[]=[];const bindingExpiry=Date.now()+7200000;
  const queue:Array<(url:string,init:RequestInit)=>Response|Promise<Response>>=[];
  const policy=(context:unknown,accountKey:string)=>decide({kind:'account',accountKey},(options.access?{selfAccountKey:SELF,companyAccountKey:COMPANY,grants}:{selfAccountKey:SELF,companyAccountKey:COMPANY,grants})).allowed||accountKey===COMPANY;
  const transport=createZhishangReadOnly(config,{
    fetch:async(url:string|URL|Request,init?:RequestInit)=>{const next=queue.shift();assert.ok(next,'unexpected supplier request');calls.push({url:String(url),init:init!,headers:new Headers(init!.headers),body:init!.body===undefined?undefined:JSON.parse(String(init!.body))});return next(String(url),init!);},
    nonce:()=> '0011223344556677',
    now:options.now,
    authorizeLookup:async()=>true,
    bindingFor:async(context:{subjectId:string},providerScope:string)=>({subjectId:context.subjectId,environmentId:'fixture-env',providerScope,bindingId:'44444444-4444-4444-8444-444444444444',revision:1,accountKey:SELF,status:'active',expiresAtMs:bindingExpiry}),
    authorizeAccount:async(context:unknown,accountKey:string)=>policy(context,accountKey),
  });
  const materials=createMaterialsReadOnly({transport,access});
  return {materials,calls,queue,transport,token:()=>queue.unshift(()=>reply({accessToken:'fixture-private-token'}))};
}

test('list defaults to the self layer and sends only the reviewed body with isInner fixed at 0',async()=>{
  const s=fixture();s.token();s.queue.push((url)=>{
    assert.equal(url,ORIGIN+'/openapi/video/list');
    return reply({list:[{videoId:'opaque-1',duration:1234.5,accountKey:SELF}],total:1});
  });
  const result=await s.materials.list(await principal(),{scope:{kind:'own'}});
  assert.deepEqual(result.authorization,{layer:'self',reason:'own-account-key'});
  assert.deepEqual(s.calls[1].body,{pageNo:1,pageSize:20,isInner:0,videoType:1});
  assert.equal(s.calls[1].headers.get('account_key'),SELF);
  assert.equal(s.calls[1].headers.has('company_secret'),false);
  assert.equal(result.pageSize,20);
  assert.equal(result.grants,false);
  assert.deepEqual(result.items[0].videoId,{value:'opaque-1',sourceType:'string',source:'opaque-1'});
  assert.deepEqual(result.filtered,{inspected:1,dropped:0});
  assert.equal(result.totalIsProviderTotal,true);
  assert.equal(result.providerTotal,1);
  assert.deepEqual(result.total,{sourceType:'number',source:'1'});
  assert.doesNotMatch(JSON.stringify(result),/fixture_secret|fixture_company|fixture-private-token/);
});

test('the company view is the public layer and the granted whitelist is the granted layer',async()=>{
  const own=fixture();own.token();own.queue.push(()=>reply({list:[]}));
  const company=await own.materials.list(await principal(),{scope:{kind:'company'}});
  assert.deepEqual(company.authorization,{layer:'public',reason:'company-view'});
  assert.equal(own.calls[1].headers.get('account_key'),COMPANY);

  const granted=fixture();granted.token();granted.queue.push(()=>reply({list:[]}));
  const shared=await granted.materials.list(await principal(),{scope:{kind:'account',accountKey:GRANTED}});
  assert.deepEqual(shared.authorization,{layer:'granted',reason:'explicit-account-grant'});
  assert.equal(granted.calls[1].headers.get('account_key'),GRANTED);
});

test('negative: a foreign key, an unbound subject and an unresolved company key never reach the supplier',async()=>{
  const foreign=fixture();foreign.token();
  await assert.rejects(async()=>foreign.materials.list(await principal(),{scope:{kind:'account',accountKey:FOREIGN}}),failure('authorization-denied'));
  await assert.rejects(async()=>foreign.materials.facets(await principal(),{scope:{kind:'account',accountKey:FOREIGN}}),failure('authorization-denied'));
  await assert.rejects(async()=>foreign.materials.labels(await principal(),{scope:{kind:'account',accountKey:FOREIGN}}),failure('authorization-denied'));
  assert.equal(foreign.calls.length,0);

  const unbound=fixture({access:async()=>({grants:createMemoryGrantStore([GRANTED]).list()})});
  await assert.rejects(async()=>unbound.materials.list(await principal(),{}),(error:unknown)=>{
    assert.equal((error as {code?:string}).code,'authorization-denied');
    assert.deepEqual((error as {authorization?:unknown}).authorization,{layer:null,reason:'self-binding-required'});
    return true;
  });
  const noCompany=fixture({access:async()=>({selfAccountKey:SELF,grants:[]})});
  await assert.rejects(async()=>noCompany.materials.list(await principal(),{scope:{kind:'company'}}),(error:unknown)=>JSON.stringify((error as {authorization?:unknown}).authorization)==='{"layer":null,"reason":"company-view-unavailable"}');
  assert.equal(unbound.calls.length,0);
  assert.equal(noCompany.calls.length,0);

  const revoked=fixture();revoked.token();revoked.queue.push(()=>reply({list:[]}));
  await revoked.materials.list(await principal(),{scope:{kind:'account',accountKey:GRANTED}});
  const empty=fixture({grants:[]});empty.token();
  await assert.rejects(async()=>empty.materials.list(await principal(),{scope:{kind:'account',accountKey:GRANTED}}),failure('authorization-denied'));
  assert.equal(empty.calls.length,0);
});

test('row-level narrowing: self keeps only the own author, public keeps everyone, granted keeps the allow-list',async()=>{
  const page=()=>({list:[{videoId:'own',accountKey:SELF},{videoId:'granted',accountKey:GRANTED},{videoId:'foreign',accountKey:FOREIGN},{videoId:'unattributed'}],total:4});
  const self=fixture();self.token();self.queue.push(()=>reply(page()));
  const selfResult=await self.materials.list(await principal(),{scope:{kind:'own'}});
  assert.deepEqual(selfResult.authorization,{layer:'self',reason:'own-account-key'});
  assert.deepEqual(selfResult.items.map(item=>item.videoId.value),['own']);
  assert.deepEqual(selfResult.filtered,{inspected:4,dropped:3});
  assert.equal(selfResult.providerTotal,4,'the supplier total is reported as-is, not as an own count');

  const company=fixture();company.token();company.queue.push(()=>reply(page()));
  const publicResult=await company.materials.list(await principal(),{scope:{kind:'company'}});
  assert.deepEqual(publicResult.items.map(item=>item.videoId.value),['own','granted','foreign','unattributed']);
  assert.deepEqual(publicResult.filtered,{inspected:4,dropped:0});

  const granted=fixture();granted.token();granted.queue.push(()=>reply(page()));
  const grantedResult=await granted.materials.list(await principal(),{scope:{kind:'account',accountKey:GRANTED}});
  assert.deepEqual(grantedResult.authorization,{layer:'granted',reason:'explicit-account-grant'});
  assert.deepEqual(grantedResult.items.map(item=>item.videoId.value),['granted'],'a granted read shows the allow-listed author only');
  assert.deepEqual(grantedResult.filtered,{inspected:4,dropped:3});
});

test('negative: a self page of three foreign rows is short, honestly reported, never refilled',async()=>{
  const s=fixture();s.token();
  s.queue.push(()=>reply({list:[{videoId:'a',accountKey:FOREIGN},{videoId:'b',accountKey:FOREIGN},{videoId:'c',accountKey:FOREIGN}],total:178391}));
  const result=await s.materials.list(await principal(),{pageSize:3,scope:{kind:'own'}});
  assert.deepEqual(result.items,[],'no foreign author is shown in the self layer');
  assert.deepEqual(result.filtered,{inspected:3,dropped:3});
  assert.equal(result.providerTotal,178391);
  assert.equal(s.calls.length,2,'a short page is not refilled by another request');
});

test('negative: an empty grant list cannot be reached as a granted read',async()=>{
  const s=fixture({grants:[]});s.token();
  await assert.rejects(async()=>s.materials.list(await principal(),{scope:{kind:'account',accountKey:GRANTED}}),(error:unknown)=>{
    assert.equal((error as {code?:string}).code,'authorization-denied');
    assert.deepEqual((error as {authorization?:unknown}).authorization,{layer:null,reason:'not-self-and-not-granted'});
    return true;
  });
  assert.equal(s.calls.length,0,'refused before any supplier call');
});

test('pageSize is capped at 100 and every out-of-contract query fails before any supplier call',async()=>{
  const capped=fixture();capped.token();capped.queue.push(()=>reply({list:[]}));
  const result=await capped.materials.list(await principal(),{pageSize:100,scope:{kind:'own'}});
  assert.equal(result.pageSize,100);
  assert.equal(capped.calls[1].body instanceof Object,true);
  assert.equal((capped.calls[1].body as {pageSize:number}).pageSize,100);

  const rejected=fixture();
  for(const query of [{pageSize:101},{pageSize:0},{pageSize:1.5},{pageNo:0},{pageNo:1000001},{videoType:5},{videoType:-1},{name:''},{name:'x'.repeat(129)},{videoIds:''},{isInner:1},{account_key:'forged'},{accountKeys:['a']},{endpoint:'/openapi/video/query/raw'},{page:'1'},[],[1]] as const){
    await assert.rejects(async()=>rejected.materials.list(await principal(),query as never),failure('invalid-query'),JSON.stringify(query));
  }
  await assert.rejects(async()=>rejected.materials.labels(await principal(),{pageSize:101}),failure('invalid-query'));
  await assert.rejects(async()=>rejected.materials.facets(await principal(),{videoType:9}),failure('invalid-query'));
  assert.equal(rejected.calls.length,0);
});

test('facets splits the tree structurally: oneLevel is the top array, twoLevel is the flattened children',async()=>{
  const s=fixture();s.token();
  s.queue.push((url,init)=>{assert.equal(url,ORIGIN+'/openapi/video/type/list');assert.deepEqual(JSON.parse(String(init.body)),{videoType:1});return wire('{"success":true,"code":1,"data":[{"categoryId":1,"categoryName":"一级A","id":11,"level":1,"name":"一级A","videoType":1,"weight":1,"children":[{"id":12,"level":2,"name":"二级B","parentTypeId":11,"videoType":1,"weight":2},{"id":13,"level":2,"name":"二级C","parentTypeId":11,"videoType":1,"weight":3}]},{"categoryId":2,"categoryName":"一级D","id":14,"level":1,"name":"一级D","videoType":1,"weight":2,"children":[]}]}');});
  s.queue.push((url)=>{assert.equal(url,ORIGIN+'/openapi/video/state/list');return wire('{"success":true,"code":1,"data":[{"id":1,"name":"启用","frontColor":"#ffffff","backgroundColor":"#000000","isDefault":true,"weight":1}]}');});
  s.queue.push((url,init)=>{assert.equal(url,ORIGIN+'/openapi/label/list');assert.deepEqual(JSON.parse(String(init.body)),{pageNo:1,pageSize:100,videoType:1});return wire('{"success":true,"code":1,"data":{"list":[{"id":1,"name":"标签A"}],"total":33}}');});
  const facets=await s.materials.facets(await principal(),{scope:{kind:'own'}});
  assert.deepEqual(facets.authorization,{layer:'self',reason:'own-account-key'});
  assert.equal(facets.oneLevel.length,2,'the top array is the one-level list, verbatim');
  assert.equal(facets.twoLevel.length,2,'children are flattened');
  assert.equal((facets.twoLevel[0] as {parentTypeId:unknown}).parentTypeId,11,'parentTypeId is a plain number in the contract');
  assert.equal((facets.oneLevel[1] as {children:unknown[]}).children.length,0,'an empty children array is legal');
  assert.equal(facets.states.length,1);
  assert.equal(facets.publicLabels.length,1);
  assert.deepEqual(facets.labelTotal,{sourceType:'number',source:'33'});
  assert.equal(s.calls.length,4,'one token plus three facet reads');
  for(const call of s.calls.slice(1))assert.equal(call.headers.get('account_key'),SELF);
});

test('facets reproduces the live 81 one-level / 888 two-level counts from the real shape',async()=>{
  // Live distribution (receipts/facet-shape-20261112-111826.json): 81 top rows with 888 children
  // in total, and the first five children counts are 3, 2, 16, 1, 6 — never uniform, one child is
  // a legal size. The remainder is spread to keep the documented total.
  const sizes=[3,2,16,1,6];
  let remaining=888-sizes.reduce((sum,size)=>sum+size,0);
  const base=Math.floor(remaining/76),extra=remaining-base*76;
  for(let index=0;index<76;index++)sizes.push(base+(index<extra?1:0));
  assert.equal(sizes.length,81);
  assert.equal(sizes.reduce((sum,size)=>sum+size,0),888);
  const tops:{[key:string]:unknown}[]=[];
  let assigned=0;
  for(let index=0;index<81;index++){
    const children=[];
    for(let child=0;child<sizes[index];child++){
      children.push({id:1000+assigned,level:2,name:'二级'+assigned,parentTypeId:index+1,videoType:1,weight:child});
      assigned+=1;
    }
    tops.push({categoryId:index+1,categoryName:'一级'+index,id:index+1,level:1,name:'一级'+index,videoType:1,weight:index,children});
  }
  const s=fixture();s.token();
  s.queue.push(()=>wire(JSON.stringify({success:true,code:1,data:tops})));
  s.queue.push(()=>wire('{"success":true,"code":1,"data":[]}'));
  s.queue.push(()=>wire('{"success":true,"code":1,"data":{"list":[],"total":33}}'));
  const facets=await s.materials.facets(await principal(),{scope:{kind:'own'}});
  assert.equal(facets.oneLevel.length,81);
  assert.equal(facets.twoLevel.length,888);
  assert.equal(new Set(facets.twoLevel.map(child=>(child as {id:number}).id)).size,888,'every child appears exactly once');
});

test('facets refuses any tree it does not fully understand, never answering with an empty level',async()=>{
  for(const [label,payload] of [
    ['top row without children','{"success":true,"code":1,"data":[{"id":9,"name":"无层级"}]}'],
    ['children not an array','{"success":true,"code":1,"data":[{"id":9,"name":"x","children":"nope"}]}'],
    ['non-object child','{"success":true,"code":1,"data":[{"id":9,"name":"x","children":["flat"]}]}'],
    ['empty top array','{"success":true,"code":1,"data":[]}'],
  ] as const){
    const s=fixture();s.token();s.queue.push(()=>wire(payload));
    await assert.rejects(async()=>s.materials.facets(await principal(),{}),failure('provider-response-unconfirmed'),label);
    assert.equal(s.calls.length,2,label+': refused after the type tree, before the other two reads');
  }
});

test('the supplier filter dimensions pass through as strings, and a bad value never reaches the wire',async()=>{
  const s=fixture();
  s.token();s.queue.push((url,init)=>{
    const body=JSON.parse(String(init.body)) as Record<string,unknown>;
    assert.equal(body.twoLevelTypeIds,'271500,271501','the id list is sent exactly as given');
    assert.equal(body.oneLevelTypeId,5908,'a single id is a number');
    assert.equal(body.videoStateId,1);
    assert.equal(body.includeLabelIds,'7,8');
    assert.equal(body.excludeLabelIds,'9');
    assert.equal(body.accountKeys,'fixture-key-a,fixture-key-b');
    assert.equal(body.teamIds,'2549');
    assert.equal(body.groupIds,'16817,16818');
    assert.equal(body.isInner,0);
    return reply({list:[],total:0});
  });
  const result=await s.materials.list(await principal(),{scope:{kind:'own'},twoLevelTypeIds:'271500,271501',oneLevelTypeId:5908,videoStateId:1,includeLabelIds:'7,8',excludeLabelIds:'9',accountKeys:'fixture-key-a,fixture-key-b',teamIds:'2549',groupIds:'16817,16818'} as never);
  assert.equal(result.authorization.layer,'self');
});

test('a filter value that is not a plain id list is refused before any request',async()=>{
  const tooMany=Array.from({length:51},(_,index)=>String(271500+index)).join(',');
  for(const bad of [{twoLevelTypeIds:'abc'},{twoLevelTypeIds:''},{twoLevelTypeIds:'271500,'},{twoLevelTypeIds:'271500,271501,'},{twoLevelTypeIds:tooMany},{twoLevelTypeIds:['271500']},{twoLevelTypeIds:'271500 271501'},{oneLevelTypeId:'x'},{oneLevelTypeId:'1.5'},{videoStateId:'-1'},{includeLabelIds:'a,b'},{accountKeys:''},{accountKeys:'a b'},{teamIds:'1,,2'}]){
    const s=fixture();s.token();
    await assert.rejects(async()=>s.materials.list(await principal(),{scope:{kind:'own'},...bad} as never),failure('invalid-query'),JSON.stringify(bad));
    assert.equal(s.calls.length,0,'nothing is sent for a refused value');
  }
});
test('orderByType and the date range reach the supplier body with their own shapes',async()=>{
  const s=fixture();
  s.token();s.queue.push((url,init)=>{
    const body=JSON.parse(String(init.body)) as Record<string,unknown>;
    assert.equal(body.orderByType,1,'an ordering code is a number');
    assert.equal(body.esUpdateStartTime,'2026-11-01');
    assert.equal(body.esUpdateEndTime,'2026-11-13');
    assert.equal(body.uploadStartTime,'2026-10-01');
    assert.equal(body.uploadEndTime,'2026-10-31');
    return reply({list:[],total:0});
  });
  const result=await s.materials.list(await principal(),{
    scope:{kind:'own'},orderByType:'1',
    esUpdateStartTime:'2026-11-01',esUpdateEndTime:'2026-11-13',
    uploadStartTime:'2026-10-01',uploadEndTime:'2026-10-31',
  } as never);
  assert.equal(result.authorization.layer,'self');
});

test('an ordering code outside the reviewed set, or a one-sided or impossible date range, is refused',async()=>{
  for(const bad of [
    {orderByType:'7'},{orderByType:'abc'},{orderByType:''},{orderByType:['1']},
    {esUpdateStartTime:'2026-11-01'},{esUpdateEndTime:'2026-11-13'},
    {esUpdateStartTime:'2026-11-13 10:00:00',esUpdateEndTime:'2026-11-14'},
    {esUpdateStartTime:'2026-13-01',esUpdateEndTime:'2026-13-02'},
    {esUpdateStartTime:'2026-02-31',esUpdateEndTime:'2026-03-01'},
    {esUpdateStartTime:'2026-11-13',esUpdateEndTime:'2026-11-01'},
    {uploadStartTime:'2026-10-01'},{uploadEndTime:'2026-10-31'},
    {uploadStartTime:'01/10/2026',uploadEndTime:'2026-10-31'},
    {uploadStartTime:'2026-10-31',uploadEndTime:'2026-10-01'},
  ]){
    const s=fixture();s.token();
    await assert.rejects(async()=>s.materials.list(await principal(),{scope:{kind:'own'},...bad} as never),failure('invalid-query'),JSON.stringify(bad));
    assert.equal(s.calls.length,0,'a refused filter never reaches the supplier');
  }
});

test('an unknown query key is still refused',async()=>{
  const s=fixture();s.token();
  await assert.rejects(async()=>s.materials.list(await principal(),{scope:{kind:'own'},twoLevelTypeId:'1'} as never),failure('invalid-query'));
  assert.equal(s.calls.length,0);
});

test('labels is paged, capped and reports the supplier total without leaking credentials',async()=>{
  const s=fixture();s.token();
  s.queue.push((url,init)=>{assert.equal(url,ORIGIN+'/openapi/label/list');assert.deepEqual(JSON.parse(String(init.body)),{pageNo:2,pageSize:100,videoType:2});return wire('{"success":true,"code":1,"data":{"list":[{"id":7,"name":"标签B"}],"total":41}}');});
  const labels=await s.materials.labels(await principal(),{pageNo:2,pageSize:100,videoType:2,scope:{kind:'own'}});
  assert.deepEqual(labels.authorization,{layer:'self',reason:'own-account-key'});
  assert.equal(labels.labels.length,1);
  assert.deepEqual(labels.total,{sourceType:'number',source:'41'});
  assert.doesNotMatch(JSON.stringify(labels),/fixture_secret|fixture_company|fixture-private-token/);
});

test('the token is single-flight across contract calls, refreshed before 24h, and never retried',async()=>{
  let now=1_700_000_000_000;const s=fixture({now:()=>now});
  s.token();s.queue.push(()=>reply({list:[]}));
  await s.materials.list(await principal(),{});
  s.queue.push(()=>reply({list:[]}));
  await s.materials.list(await principal(),{});
  const tokens=()=>s.calls.filter(call=>call.url.endsWith('/openapi/auth/access_token')).length;
  assert.equal(tokens(),1,'the cached token is reused inside the hour');

  now+=3_599_999;
  s.queue.push(()=>reply({list:[]}));
  await s.materials.list(await principal(),{});
  assert.equal(tokens(),1,'still cached just under the hour');

  now+=1;s.token();s.queue.push(()=>reply({list:[]}));
  await s.materials.list(await principal(),{});
  assert.equal(tokens(),2,'refreshed at the cache ceiling, well inside the 24h token lifetime');
  const stamp=Number(s.calls.filter(call=>call.url.endsWith('/access_token'))[0].headers.get('timestamp'));
  assert.equal(Number.isSafeInteger(stamp),true);
  assert.ok(stamp<Date.now()/1000+86400,'the signature timestamp is seconds, not milliseconds');

  const failing=fixture();failing.queue.push(()=>wire('{"success":false,"code":20001}'));
  await assert.rejects(async()=>failing.materials.list(await principal(),{}),failure('provider-timeout'));
  assert.equal(failing.calls.length,1,'a failed token acquisition is not retried');
});

test('supplier codes surface as the fixed first-party errors through the contract layer',async()=>{
  for(const [code,expected,status] of [[20000,'provider-response-unconfirmed',502],[20001,'provider-timeout',504],[20002,'provider-rate-limited',429],[20010,'provider-company-unconfirmed',503],[20011,'provider-unavailable',502],[20012,'provider-state-unconfirmed',503],[20013,'provider-credential-expired',401],[20014,'provider-credential-rejected',403],[20015,'provider-signature-rejected',502],[20020,'account-not-found',404],[20022,'authorization-denied',403],[777,'provider-unconfirmed',503]] as const){
    const s=fixture();s.token();
    s.queue.push(()=>wire(JSON.stringify({success:false,code,message:'fixture_secret must not escape'})));
    await assert.rejects(async()=>s.materials.list(await principal(),{}),(error:unknown)=>{
      assert.equal((error as {code?:string}).code,expected,`supplier ${code}`);
      assert.equal((error as {status?:number}).status,status);
      assert.doesNotMatch(String(error)+JSON.stringify(toPublicError(error)),/fixture_secret|fixture_company/);
      return true;
    });
  }
});

test('exactly one function reaches query/raw, and neither the read contract nor the download layer can',()=>{
  // Comments may name what is deliberately not implemented; only code counts here.
  const code=(source:string)=>source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
  const source=readFileSync(join(here,'zhishang.ts'),'utf8');
  const body=code(source);
  assert.equal((body.match(/request\('\/openapi\/video\/query\/raw'/g)??[]).length,1,'one call site, inside rawVideoUrl');
  assert.match(body,/async function rawVideoUrl/,'and it is the raw download entry point');
  const endpoints=[...source.matchAll(/'(\/openapi\/[a-z/_]+)'/g)].map(match=>match[1]);
  assert.deepEqual([...new Set(endpoints)].sort(),['/openapi/account/list','/openapi/auth/access_token','/openapi/label/list','/openapi/video/list','/openapi/video/query/raw','/openapi/video/state/list','/openapi/video/type/list']);
  const contract=code(readFileSync(join(here,'materials.ts'),'utf8'));
  for(const forbidden of ['/openapi/','multipart','query/raw'])assert.equal(contract.includes(forbidden),false,`materials.ts code must not reach ${forbidden}`);
  const download=code(readFileSync(join(here,'raw.ts'),'utf8'));
  for(const forbidden of ['/openapi/','query/raw'])assert.equal(download.includes(forbidden),false,`raw.ts goes through the transport, not ${forbidden}`);
  assert.match(source,/pageSize<1\|\|pageSize>100/,'the transport also caps pageSize on its own');
  assert.match(contract,/PAGE_SIZE_MAX=100/,'the contract layer caps pageSize before the transport sees it');
  const accounts=code(readFileSync(join(here,'accounts.ts'),'utf8'));
  assert.equal(/writeFile|mkdir|node:fs|sqlite/.test(accounts),false,'account resolution has no persistence surface');
});
