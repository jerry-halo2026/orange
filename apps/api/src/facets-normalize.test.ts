// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createZhishangReadOnly} from './zhishang.ts';
import {adoptVerifiedSession} from './supabase.ts';
import {createMaterialsReadOnly} from './materials.ts';

/**
 * The editor's facet contract (`OneLevelCategory` / `TwoLevelCategory` / label rows) says number and
 * string, while the supplier sends `{sourceType,source}` wrappers. These fixtures are the live
 * shapes, desensitised: every number stays a wrapper on the wire and must come out plain.
 */
const config={environmentId:'fixture-env',companyKey:'fixture_company',companySecret:'fixture_secret'};
const failure=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;
const wire=(text:string)=>new Response(text,{headers:{'content-type':'application/json'}});
const WRAPPED=(raw:string)=>`{"sourceType":"number","source":${JSON.stringify(raw)}}`;

function fixture(){
  const queue:Array<()=>Response>=[()=>Response.json({success:true,code:1,data:{accessToken:'fixture-token'}})];
  const expiry=Date.now()+3600000;
  const transport=createZhishangReadOnly(config,{
    fetch:async()=>{const next=queue.shift();assert.ok(next,'unexpected supplier request');return next();},
    nonce:()=>'0011223344556677',
    authorizeLookup:async()=>true,
    bindingFor:async(context:{subjectId:string},providerScope:string)=>({subjectId:context.subjectId,environmentId:'fixture-env',providerScope,bindingId:'44444444-4444-4444-8444-444444444444',revision:1,accountKey:'fixture-self-key',status:'active',expiresAtMs:expiry}),
    authorizeAccount:async()=>true,
  });
  const materials=createMaterialsReadOnly({transport,access:async()=>({selfAccountKey:'fixture-self-key',grants:[]})});
  const session=adoptVerifiedSession({subjectId:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',expiresAtMs:Date.now()+600000,environmentId:'fixture-env'});
  return {materials,session,queue};
}

const TYPE_TREE='{"success":true,"code":1,"data":['
 +'{"categoryId":'+WRAPPED('5908')+',"categoryName":"pool","id":'+WRAPPED('1')+',"level":'+WRAPPED('1')+',"name":"one","videoType":'+WRAPPED('1')+',"weight":'+WRAPPED('1')+','
 +'"children":[{"id":'+WRAPPED('271500')+',"level":'+WRAPPED('2')+',"name":"two","parentTypeId":'+WRAPPED('1')+',"videoType":'+WRAPPED('1')+',"weight":'+WRAPPED('2')+'}]},'
 +'{"categoryId":'+WRAPPED('5909')+',"categoryName":"pool2","id":'+WRAPPED('2')+',"level":'+WRAPPED('1')+',"name":"empty","videoType":'+WRAPPED('1')+',"weight":'+WRAPPED('2')+',"children":[]}'
 +']}';
const STATES='{"success":true,"code":1,"data":[{"id":'+WRAPPED('1')+',"name":"on","frontColor":"#ffffff","backgroundColor":"#000000","isDefault":true,"weight":'+WRAPPED('1')+'}]}';
const LABELS='{"success":true,"code":1,"data":{"list":[{"id":'+WRAPPED('7')+',"name":"label"}],"total":33}}';

test('facets and labels publish plain numbers and strings, not wire wrappers',async()=>{
  const s=fixture();
  s.queue.push(()=>wire(TYPE_TREE),()=>wire(STATES),()=>wire(LABELS));
  const facets=await s.materials.facets(s.session,{scope:{kind:'own'}});

  assert.equal(facets.oneLevel.length,2);
  const first=facets.oneLevel[0] as unknown as {id:unknown;name:unknown;level:unknown;categoryId:unknown;children:ReadonlyArray<{id:unknown;name:unknown;parentTypeId:unknown;level:unknown}>};
  assert.equal(typeof first.id,'number','one.id is a number for the editor');
  assert.equal(first.id,1);
  assert.equal(first.name,'one');
  assert.equal(typeof first.level,'number');
  assert.equal(typeof first.categoryId,'number');
  assert.equal(typeof first.children[0].id,'number','a child id is a number too');
  assert.equal(first.children[0].id,271500);
  assert.equal(typeof first.children[0].name,'string');
  assert.equal(typeof first.children[0].parentTypeId,'number');
  assert.equal(first.children[0].level,2);

  const second=facets.oneLevel[1] as unknown as {id:number;children:readonly unknown[]};
  assert.equal(second.id,2);
  assert.deepEqual(second.children,[],'a one-level category with no children is kept, not dropped');

  assert.equal(typeof (facets.states[0] as unknown as {id:unknown}).id,'number');
  assert.equal(typeof (facets.states[0] as unknown as {name:unknown}).name,'string');
  assert.equal(typeof (facets.states[0] as unknown as {frontColor:unknown}).frontColor,'string');
  assert.equal((facets.states[0] as unknown as {isDefault:unknown}).isDefault,true,'booleans survive as booleans');
  assert.equal(typeof (facets.publicLabels[0] as unknown as {id:unknown}).id,'number');
  assert.deepEqual(facets.labelTotal,{sourceType:'number',source:'33'},'labelTotal stays a wire number per the contract');

  s.queue.push(()=>wire('{"success":true,"code":1,"data":{"list":[{"id":'+WRAPPED('9')+',"name":"l2"}],"total":1}}'));
  const page=await s.materials.labels(s.session,{scope:{kind:'own'}});
  assert.equal(typeof (page.labels[0] as unknown as {id:unknown}).id,'number','label ids are numbers as well');
  assert.equal((page.labels[0] as unknown as {id:number}).id,9);
});

test('a facet value the contract cannot publish is reported, never dropped silently',async()=>{
  const s=fixture();
  // All three facet reads are answered; the type tree is the one carrying the unusable value.
  s.queue.push(
    ()=>wire('{"success":true,"code":1,"data":[{"id":{"nested":true},"name":"x","level":'+WRAPPED('1')+',"children":[]}]}'),
    ()=>wire('{"success":true,"code":1,"data":[]}'),
    ()=>wire('{"success":true,"code":1,"data":{"list":[],"total":0}}'),
  );
  await assert.rejects(async()=>s.materials.facets(s.session,{scope:{kind:'own'}}),failure('provider-response-unconfirmed'));
});
