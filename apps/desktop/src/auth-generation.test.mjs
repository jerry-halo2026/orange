// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import { accountPresentation, reconcileHttpAuth, reconcileNativeAuth, createAuthEventGate } from '../shell/auth-generation.ts';

test('temporary lock hides chat without changing editor generation; confirmed retirement remounts before new chat is shown',()=>{
  assert.deepEqual(accountPresentation({kind:'active',uiGeneration:0},0),{active:true,generation:0,chatVisible:true});
  assert.deepEqual(accountPresentation({kind:'locked',uiGeneration:0},0),{active:false,generation:0,chatVisible:false});
  assert.deepEqual(accountPresentation({kind:'active',uiGeneration:0},0),{active:true,generation:0,chatVisible:true});
  assert.deepEqual(accountPresentation({kind:'active',uiGeneration:1},0),{active:true,generation:1,chatVisible:false});
  assert.deepEqual(accountPresentation({kind:'active',uiGeneration:1},1),{active:true,generation:1,chatVisible:true});
});

test('B HTTP active before native attestation stays hidden; delayed or missing IPC cannot reveal A',()=>{
  const a={kind:'active',reason:null,uiGeneration:0};
  const pending=reconcileHttpAuth(a,{kind:'active',reason:null},{active:false,uiGeneration:1});
  assert.deepEqual(pending,{kind:'locked',reason:'verification-unconfirmed',uiGeneration:1});
  assert.equal(accountPresentation(pending,0).chatVisible,false);
  const b=reconcileHttpAuth(pending,{kind:'active',reason:null},{active:true,uiGeneration:1});
  assert.deepEqual(b,{kind:'active',reason:null,uiGeneration:1});
  assert.equal(accountPresentation(b,0).chatVisible,false);
  assert.deepEqual(reconcileHttpAuth(b,{kind:'active',reason:null},{active:true,uiGeneration:0}),{kind:'locked',reason:'verification-unconfirmed',uiGeneration:1});
  const temporary=reconcileHttpAuth(a,{kind:'locked',reason:'verification-unconfirmed'},{active:false,uiGeneration:0});
  assert.equal(temporary.uiGeneration,0);
});
test('late or malformed native auth events cannot roll a newer account back',()=>{
  const b={kind:'active',reason:null,uiGeneration:1};
  assert.deepEqual(reconcileNativeAuth(b,{kind:'active',reason:null,uiGeneration:0}),b);
  assert.deepEqual(reconcileNativeAuth(b,{kind:'locked',reason:'expired',uiGeneration:0}),b);
  assert.deepEqual(reconcileNativeAuth(b,{kind:'locked',reason:'verification-unconfirmed'}),{kind:'locked',reason:'verification-unconfirmed',uiGeneration:1});
  assert.deepEqual(reconcileNativeAuth(b,{kind:'active',reason:null}),{kind:'locked',reason:'verification-unconfirmed',uiGeneration:1});
  assert.deepEqual(reconcileNativeAuth(b,{kind:'active',reason:null,uiGeneration:-1}),{kind:'locked',reason:'verification-unconfirmed',uiGeneration:1});
});

test('a same-generation active event delayed past a lock cannot reveal the previous session',async()=>{
  let resolveProof;
  const proof=new Promise(resolve=>{resolveProof=resolve});
  let state={kind:'active',reason:null,uiGeneration:0};
  const gate=createAuthEventGate(()=>proof,update=>{state=update(state)});
  const oldActive=gate.native({kind:'active',reason:null,uiGeneration:0});
  await gate.native({kind:'locked',reason:'expired',uiGeneration:0});
  resolveProof({active:true,uiGeneration:0});
  await oldActive;
  assert.deepEqual(state,{kind:'locked',reason:'expired',uiGeneration:0});
  assert.equal(accountPresentation(state,0).chatVisible,false);
});
test('active notification requires matching current native proof',async()=>{
  let state={kind:'locked',reason:'expired',uiGeneration:0};
  const gate=createAuthEventGate(async()=>({active:false,uiGeneration:0}),update=>{state=update(state)});
  await gate.native({kind:'active',reason:null,uiGeneration:0});
  assert.deepEqual(state,{kind:'locked',reason:'verification-unconfirmed',uiGeneration:0});
});

test('a new active generation hides A immediately while native proof is delayed or fails',async()=>{
  let resolveProof;
  const proof=new Promise(resolve=>{resolveProof=resolve});
  let state={kind:'active',reason:null,uiGeneration:0};
  const gate=createAuthEventGate(()=>proof,update=>{state=update(state)});
  const next=gate.native({kind:'active',reason:null,uiGeneration:1});
  assert.deepEqual(state,{kind:'locked',reason:'verification-unconfirmed',uiGeneration:0});
  assert.equal(accountPresentation(state,0).chatVisible,false);
  await gate.native({kind:'locked',reason:'expired',uiGeneration:1});
  resolveProof({active:true,uiGeneration:1});await next;
  assert.deepEqual(state,{kind:'locked',reason:'expired',uiGeneration:1});
  const failed=createAuthEventGate(async()=>{throw Error('offline')},update=>{state=update(state)});
  await failed.native({kind:'active',reason:null,uiGeneration:1});
  assert.equal(state.kind,'locked');
});
test('older native notifications neither hide B nor cancel B proof already in flight',async()=>{
  let resolveProof,calls=0,state={kind:'locked',reason:'verification-unconfirmed',uiGeneration:0};
  const proof=new Promise(resolve=>{resolveProof=resolve});
  const gate=createAuthEventGate(()=>{calls++;return proof},update=>{state=update(state)});
  const b=gate.native({kind:'active',reason:null,uiGeneration:1});
  await gate.native({kind:'locked',reason:'expired',uiGeneration:0});
  resolveProof({active:true,uiGeneration:1});await b;
  assert.deepEqual(state,{kind:'active',reason:null,uiGeneration:1});
  await gate.native({kind:'active',reason:null,uiGeneration:0});
  assert.deepEqual(state,{kind:'active',reason:null,uiGeneration:1});
  assert.equal(calls,1);
});
