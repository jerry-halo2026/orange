// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createZhishangReadOnly} from './zhishang.ts';
import {adoptVerifiedSession} from './supabase.ts';

/**
 * `isInner` is a supplier request parameter: `0` asks for the public address family, `1` for the
 * inner-network one. It has to reach both bodies that accept it, and a network failure in inner mode
 * has to be distinguishable from a supplier business error.
 */
const config={environmentId:'fixture-env',companyKey:'fixture_company',companySecret:'fixture_secret'};
const failure=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;
const reply=(data:unknown)=>Response.json({success:true,code:1,data});

function fixture(options:{isInner?:0|1;fail?:(url:string)=>Error|Response}={}){
  const calls:Array<{path:string;body:unknown}>=[];
  const queue:Array<()=>Response>=[()=>reply({accessToken:'fixture-token'})];
  const expiry=Date.now()+3600000;
  const transport=createZhishangReadOnly(config,{
    isInner:options.isInner,
    fetch:async(url:string|URL|Request,init?:RequestInit)=>{
      const path=new URL(String(url)).pathname;
      const failure=options.fail?.(path);
      if(failure instanceof Error)throw failure;
      if(failure)return failure;
      calls.push({path,body:init?.body?JSON.parse(String(init.body)):null});
      const next=queue.shift();
      assert.ok(next,`unexpected supplier request: ${path}`);
      return next();
    },
    nonce:()=>'0011223344556677',
    authorizeLookup:async()=>true,
    bindingFor:async(context:{subjectId:string},providerScope:string)=>({subjectId:context.subjectId,environmentId:'fixture-env',providerScope,bindingId:'44444444-4444-4444-8444-444444444444',revision:1,accountKey:'fixture-self-key',status:'active',expiresAtMs:expiry}),
    authorizeAccount:async()=>true,
  });
  const session=adoptVerifiedSession({subjectId:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',expiresAtMs:Date.now()+600000,environmentId:'fixture-env'});
  return {transport,session,calls,queue};
}

test('isInner defaults to 0 in both bodies that accept it',async()=>{
  const s=fixture();
  s.queue.push(()=>reply({list:[],total:0}),()=>reply({rawUrl:'https://cdn.fixture.test/v/1.mp4'}));
  await s.transport.listMaterials(s.session,{pageSize:1});
  await s.transport.rawVideoUrl(s.session,'fixture-self-key','33777574');
  const list=s.calls.find(call=>call.path==='/openapi/video/list');
  const raw=s.calls.find(call=>call.path==='/openapi/video/query/raw');
  assert.equal((list?.body as {isInner:number}).isInner,0);
  assert.equal((raw?.body as {isInner:number}).isInner,0);
});

test('isInner=1 is sent in both bodies, and nowhere that does not take it',async()=>{
  const s=fixture({isInner:1});
  s.queue.push(()=>reply({list:[],total:0}),()=>reply({rawUrl:'https://cdn.fixture.test/v/1.mp4'}));
  await s.transport.listMaterials(s.session,{pageSize:1});
  await s.transport.rawVideoUrl(s.session,'fixture-self-key','33777574');
  const list=s.calls.find(call=>call.path==='/openapi/video/list');
  const raw=s.calls.find(call=>call.path==='/openapi/video/query/raw');
  assert.equal((list?.body as {isInner:number}).isInner,1);
  assert.equal((raw?.body as {isInner:number}).isInner,1);
});

test('a network failure in inner mode is material-inner-unreachable, not a generic supplier error',async()=>{
  const s=fixture({isInner:1,fail:()=>Object.assign(new TypeError('fetch failed'),{cause:{code:'ENOTFOUND'}})});
  await assert.rejects(async()=>s.transport.listMaterials(s.session,{pageSize:1}),(error:unknown)=>{
    assert.equal((error as {code?:string}).code,'material-inner-unreachable');
    assert.equal((error as {status?:number}).status,503);
    return true;
  });
});

test('a supplier business code in inner mode keeps its own mapping',async()=>{
  const s=fixture({isInner:1});
  s.queue.push(()=>Response.json({success:false,code:20000}));
  await assert.rejects(async()=>s.transport.listMaterials(s.session,{pageSize:1}),(error:unknown)=>{
    assert.equal((error as {code?:string}).code,'provider-response-unconfirmed','a business code is not a reachability problem');
    return true;
  });
});
