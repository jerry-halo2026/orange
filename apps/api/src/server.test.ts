// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyBearer} from './supabase.ts';
import {createZhishangReadOnly} from './zhishang.ts';
import {createMaterialsReadOnly} from './materials.ts';
import {createMemoryGrantStore} from './authorization.ts';
import {createMaterialsServer,INTERNAL_SECRET_HEADER} from './server.ts';

const SUBJECT='11111111-1111-4111-8111-111111111111';
const SELF='fixture-self-account-key',GRANTED='fixture-granted-account-key',FOREIGN='fixture-foreign-account-key';
const config={environmentId:'fixture-env',companyKey:'fixture_company',companySecret:'fixture_secret'};
const ALLOWED='http://127.0.0.1:5173';

async function bearer(){
  const claims={sub:SUBJECT,session_id:'33333333-3333-4333-8333-333333333333',exp:Math.floor(Date.now()/1000)+600,role:'authenticated',aud:'authenticated',iss:'https://fixture.supabase.co/auth/v1'};
  const token='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture-signature';
  return 'Bearer '+token;
}

type Harness={base:string;calls:Array<{url:string;body:unknown;accountKey:string|null}>;queue:Array<(url:string)=>Response>;close:()=>Promise<void>};

async function harness(options:{origins?:readonly string[];internal?:Readonly<{header:string;secret:string}>}={}):Promise<Harness>{
  const calls:Harness['calls']=[];const queue:Harness['queue']=[];const bindingExpiry=Date.now()+7200000;
  const transport=createZhishangReadOnly(config,{
    fetch:async(url:string|URL|Request,init?:RequestInit)=>{const headers=new Headers(init!.headers);calls.push({url:String(url),body:init!.body===undefined?undefined:JSON.parse(String(init!.body)),accountKey:headers.get('account_key')});const next=queue.shift();assert.ok(next,'unexpected supplier request');return next(String(url));},
    nonce:()=> '0011223344556677',
    authorizeLookup:async()=>true,
    bindingFor:async(context:{subjectId:string},providerScope:string)=>({subjectId:context.subjectId,environmentId:'fixture-env',providerScope,bindingId:'44444444-4444-4444-8444-444444444444',revision:1,accountKey:SELF,status:'active',expiresAtMs:bindingExpiry}),
    authorizeAccount:async(_context:unknown,accountKey:string)=>accountKey===GRANTED,
  });
  const materials=createMaterialsReadOnly({transport,access:async()=>({selfAccountKey:SELF,grants:createMemoryGrantStore([GRANTED]).list()})});
  const server=createMaterialsServer({
    verify:(request)=>verifyBearer({environmentId:'fixture-env',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'fixture-public'},request.authorization,async()=>Response.json({id:SUBJECT,is_anonymous:false})),
    materials,
    origins:options.origins,
    internal:options.internal,
  });
  const port=await server.listen(0);
  return {base:'http://127.0.0.1:'+port,calls,queue,close:()=>server.close()};
}

const tokenResponse=()=>Response.json({success:true,code:1,data:{accessToken:'fixture-private-token'}});
const reply=(data:unknown)=>Response.json({success:true,code:1,data});

test('when the internal hop is configured, health stays open and every read needs the secret',async()=>{
  const secret='fixture-internal-secret-0123456789abcdef';
  const h=await harness({internal:{header:INTERNAL_SECRET_HEADER,secret}});
  try{
    const health=await fetch(h.base+'/health');
    assert.equal(health.status,200,'health never asks for the internal secret');
    assert.deepEqual(await health.json(),{ok:true,version:'0.0.0'});

    const absent=await fetch(h.base+'/api/materials/list');
    assert.equal(absent.status,403);
    assert.equal((await absent.json()).code,'internal-auth-required');
    const wrong=await fetch(h.base+'/api/materials/list',{headers:{[INTERNAL_SECRET_HEADER]:secret.slice(0,-1)+'x'}});
    assert.equal(wrong.status,403);
    assert.equal((await wrong.json()).code,'internal-auth-required');
    assert.equal(h.calls.length,0,'the hop gate answers before any supplier work');

    const passed=await fetch(h.base+'/api/materials/list',{headers:{[INTERNAL_SECRET_HEADER]:secret}});
    assert.equal((await passed.json()).code,'authentication-required','the hop gate passed, so the identity seam answered');
  }finally{await h.close();}
});

test('health is public, and every material route is closed until a bearer session verifies',async()=>{
  const h=await harness();
  try{
    const health=await fetch(h.base+'/health');
    assert.equal(health.status,200);
    assert.deepEqual(await health.json(),{ok:true,version:'0.0.0'},'health reports liveness and version only');
    for(const route of ['list','facets','labels']){
      const denied=await fetch(h.base+'/api/materials/'+route);
      assert.equal((await denied.json()).code,'authentication-required');
      const forged=await fetch(h.base+'/api/materials/'+route,{headers:{authorization:'Bearer fixture-not-a-jwt'}});
      assert.equal((await forged.json()).code,'authentication-rejected');
    }
    assert.equal(h.calls.length,0,'no supplier call without a verified session');
  }finally{await h.close();}
});

test('a verified session reads through the route and the response carries the authorization layer',async()=>{
  const h=await harness();
  try{
    h.queue.push(()=>tokenResponse(),()=>reply({list:[{videoId:'opaque-1'}],total:1}));
    const response=await fetch(h.base+'/api/materials/list?pageSize=5&videoType=1',{headers:{authorization:await bearer()}});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    const body=await response.json();
    assert.deepEqual(body.authorization,{layer:'self',reason:'own-account-key'});
    assert.equal(body.pageSize,5);
    assert.deepEqual(h.calls[1].body,{pageNo:1,pageSize:5,isInner:0,videoType:1});
    assert.equal(h.calls[1].accountKey,SELF);
    assert.doesNotMatch(JSON.stringify(body),/fixture-private-token|fixture_secret|fixture_company/);
  }finally{await h.close();}
});

test('the company and granted scopes are reachable over the route, a foreign key is refused',async()=>{
  const h=await harness();
  try{
    h.queue.push(()=>tokenResponse(),()=>reply({list:[]}));
    const granted=await fetch(h.base+'/api/materials/list?scope=account:'+GRANTED,{headers:{authorization:await bearer()}});
    assert.equal(granted.status,200);
    assert.deepEqual((await granted.json()).authorization,{layer:'granted',reason:'explicit-account-grant'});
    assert.equal(h.calls[1].accountKey,GRANTED);

    const before=h.calls.length;
    const foreign=await fetch(h.base+'/api/materials/list?scope=account:'+FOREIGN,{headers:{authorization:await bearer()}});
    assert.equal(foreign.status,403);
    assert.equal((await foreign.json()).code,'authorization-denied');
    assert.equal(h.calls.length,before,'the refusal never reached the supplier');
  }finally{await h.close();}
});

test('facets and labels are routed with their own parameter sets',async()=>{
  const h=await harness();
  try{
    h.queue.push(()=>tokenResponse(),()=>reply([{id:11,level:1,name:'一级A',children:[{id:12,level:2,name:'二级B',parentTypeId:11}]},{id:13,level:1,name:'一级C',children:[]}]),()=>reply({list:[{id:1,name:'启用'}]}),()=>reply({list:[{id:3,name:'标签A'}],total:33}));
    const facets=await fetch(h.base+'/api/materials/facets?videoType=1',{headers:{authorization:await bearer()}});
    assert.equal(facets.status,200);
    const facetsBody=await facets.json();
    assert.equal(facetsBody.oneLevel.length,2);
    assert.equal(facetsBody.twoLevel.length,1,'children are flattened by the route exactly as by the contract layer');
    assert.equal(facetsBody.publicLabels.length,1);

    h.queue.push(()=>reply({list:[{id:3,name:'标签B'}],total:33}));
    const labels=await fetch(h.base+'/api/materials/labels?pageNo=2&pageSize=10&videoType=1',{headers:{authorization:await bearer()}});
    assert.equal(labels.status,200);
    assert.equal((await labels.json()).pageNo,2);
    assert.deepEqual(h.calls[h.calls.length-1].body,{pageNo:2,pageSize:10,videoType:1});
  }finally{await h.close();}
});

test('the route table is closed: unknown paths and methods cannot reach the supplier or query/raw',async()=>{
  const h=await harness();
  try{
    const token=await bearer();
    for(const path of ['/api/materials/raws','/api/materials/resolve','/api/video/query/raw','/api/materials','/']){
      const response=await fetch(h.base+path,{headers:{authorization:token}});
      assert.equal(response.status,404,path);
      assert.equal((await response.json()).code,'not-found');
    }
    for(const method of ['POST','PUT','DELETE','PATCH']){
      const response=await fetch(h.base+'/api/materials/list',{method,headers:{authorization:token,'content-type':'application/json'},body:'{}'});
      assert.equal(response.status,405,method);
      assert.equal((await response.json()).code,'method-not-allowed');
    }
    assert.equal(h.calls.length,0,'no closed route reached the supplier');
  }finally{await h.close();}
});

test('a foreign browser origin is refused before the session is even checked',async()=>{
  const h=await harness({origins:[ALLOWED]});
  try{
    const rejected=await fetch(h.base+'/api/materials/list',{headers:{origin:'http://127.0.0.1:9999',authorization:await bearer()}});
    assert.equal(rejected.status,403);
    assert.equal((await rejected.json()).code,'origin-rejected');
    assert.equal(h.calls.length,0);

    h.queue.push(()=>tokenResponse(),()=>reply({list:[]}));
    const allowed=await fetch(h.base+'/api/materials/list',{headers:{origin:ALLOWED,authorization:await bearer()}});
    assert.equal(allowed.status,200);
  }finally{await h.close();}

  const closed=await harness();
  try{
    const noOrigins=await fetch(closed.base+'/api/materials/list',{headers:{origin:ALLOWED,authorization:await bearer()}});
    assert.equal(noOrigins.status,403,'an empty allow-list means no browser origin at all');
  }finally{await closed.close();}
});

test('query strings are parsed strictly: unknown, repeated and out-of-range parameters are refused',async()=>{
  const h=await harness();
  try{
    const token=await bearer();
    for(const query of ['pageSize=101','pageSize=0','pageSize=5x','pageNo=-1','videoType=9','isInner=1','account_key=forged','scope=everyone','scope=account:','pageSize=5&pageSize=6','name=a&name=b']){
      const response=await fetch(h.base+'/api/materials/list?'+query,{headers:{authorization:token}});
      assert.equal(response.status,422,query);
      assert.equal((await response.json()).code,'invalid-query',query);
    }
    const facetsExtra=await fetch(h.base+'/api/materials/facets?pageSize=5',{headers:{authorization:token}});
    assert.equal(facetsExtra.status,422,'facets has no paging parameter');
    assert.equal(h.calls.length,0);
  }finally{await h.close();}
});

test('a supplier failure reaches the client as the fixed code and status, never as supplier text',async()=>{
  const h=await harness();
  try{
    h.queue.push(()=>Response.json({success:false,code:20022,message:'fixture_secret must not escape'}));
    const response=await fetch(h.base+'/api/materials/list',{headers:{authorization:await bearer()}});
    assert.equal(response.status,403);
    const body=await response.json();
    assert.equal(body.code,'provider-permission-denied');
    assert.doesNotMatch(JSON.stringify(body),/fixture_secret|fixture_company|20022/);

    h.queue.push(()=>Response.json({success:false,code:20001}));
    const timeout=await fetch(h.base+'/api/materials/list',{headers:{authorization:await bearer()}});
    assert.equal(timeout.status,504);
    assert.equal((await timeout.json()).code,'provider-timeout');
  }finally{await h.close();}
});
