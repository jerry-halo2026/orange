// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryGrantStore,decide,grantKey,type Access} from './authorization.ts';

const SELF='fixture-self-account-key',COMPANY='fixture-company-account-key',GRANTED='fixture-granted-account-key',FOREIGN='fixture-foreign-account-key';
const full:Access={selfAccountKey:SELF,companyAccountKey:COMPANY,grants:[GRANTED]};

test('layer 1 public: the company view is labelled public and resolved to the company key',()=>{
  const decision=decide({kind:'company'},full);
  assert.equal(decision.allowed,true);
  assert.equal(decision.allowed&&decision.accountKey,COMPANY);
  assert.deepEqual(decision.authorization,{layer:'public',reason:'company-view'});
});

test('layer 2 self: only the exact own key is self, and whitespace or case variants are not',()=>{
  const own=decide({kind:'own'},full);
  assert.deepEqual(own.authorization,{layer:'self',reason:'own-account-key'});
  assert.equal(own.allowed&&own.accountKey,SELF);
  const explicit=decide({kind:'account',accountKey:SELF},full);
  assert.deepEqual(explicit.authorization,{layer:'self',reason:'own-account-key'});
  for(const variant of [` ${SELF}`,`${SELF} `,`\t${SELF}`]){
    const denial=decide({kind:'account',accountKey:variant},full);
    assert.equal(denial.allowed,false,`${JSON.stringify(variant)} is not header-safe`);
    assert.deepEqual(denial.authorization,{layer:null,reason:'account-key-invalid'});
  }
  for(const variant of [SELF.toUpperCase(),`${SELF}0`,`${SELF.slice(0,-1)}`]){
    const denial=decide({kind:'account',accountKey:variant},full);
    assert.equal(denial.allowed,false,`${JSON.stringify(variant)} is not the own key`);
    assert.deepEqual(denial.authorization,{layer:null,reason:'not-self-and-not-granted'});
  }
});

test('layer 3 granted: only an explicitly listed key is granted, and revocation is immediate',()=>{
  const granted=decide({kind:'account',accountKey:GRANTED},full);
  assert.deepEqual(granted.authorization,{layer:'granted',reason:'explicit-account-grant'});
  assert.equal(granted.allowed&&granted.accountKey,GRANTED);
  const store=createMemoryGrantStore([GRANTED]);
  assert.equal(decide({kind:'account',accountKey:GRANTED},{...full,grants:store.list()}).authorization.layer,'granted');
  assert.equal(store.remove(GRANTED),true);
  assert.equal(decide({kind:'account',accountKey:GRANTED},{...full,grants:store.list()}).allowed,false);
  assert.equal(store.remove(GRANTED),false);
  assert.deepEqual(store.list(),[]);
});

test('negative: any key that is neither own nor granted is denied with a fixed reason',()=>{
  for(const scope of [{kind:'account',accountKey:''},{kind:'account',accountKey:'   '},{kind:'account',accountKey:'key with space'},{kind:'account',accountKey:'k\n'},{kind:'account',accountKey:'x'.repeat(600)},{kind:'account'},{kind:'account',accountKey:42},{kind:'account',accountKey:null}] as const){
    const decision=decide(scope,full);
    assert.equal(decision.allowed,false,JSON.stringify(scope));
    assert.deepEqual(decision.authorization,{layer:null,reason:'account-key-invalid'});
    assert.equal(decision.allowed===false&&decision.code,'invalid-query');
  }
  const denied=decide({kind:'account',accountKey:FOREIGN},full);
  assert.deepEqual(denied.authorization,{layer:null,reason:'not-self-and-not-granted'});
  assert.equal(denied.allowed===false&&denied.code,'authorization-denied');
});

test('negative: an unbound subject or an unresolved company key cannot borrow a layer',()=>{
  assert.deepEqual(decide({kind:'own'},{grants:[GRANTED]}).authorization,{layer:null,reason:'self-binding-required'});
  assert.deepEqual(decide({kind:'account',accountKey:SELF},{grants:[GRANTED]}).authorization,{layer:null,reason:'not-self-and-not-granted'});
  assert.deepEqual(decide({kind:'own'},{selfAccountKey:'',grants:[]}).authorization,{layer:null,reason:'self-binding-required'});
  assert.deepEqual(decide({kind:'company'},{selfAccountKey:SELF,grants:[]}).authorization,{layer:null,reason:'company-view-unavailable'});
  const grantedOnly=decide({kind:'account',accountKey:GRANTED},{grants:[GRANTED]});
  assert.equal(grantedOnly.authorization.layer,'granted','a grant does not need an own binding');
  assert.equal(grantedOnly.allowed&&grantedOnly.accountKey,GRANTED);
});

test('negative: a malformed scope is refused instead of defaulting to something readable',()=>{
  for(const scope of [undefined,null,{},[], 'company',{kind:'COMPANY'},{kind:'everything'},{kind:null}]){
    const decision=decide(scope as never,full);
    assert.equal(decision.allowed,false,JSON.stringify(scope));
    assert.deepEqual(decision.authorization,{layer:null,reason:'scope-invalid'});
    assert.equal(decision.allowed===false&&decision.code,'invalid-query');
  }
});

test('grants are compared by identity: a huge list still cannot admit a foreign key',()=>{
  const many=Array.from({length:2000},(_,index)=>`filler-key-${index}`);
  assert.equal(decide({kind:'account',accountKey:FOREIGN},{selfAccountKey:SELF,companyAccountKey:COMPANY,grants:[...many,GRANTED]}).allowed,false);
  assert.equal(decide({kind:'account',accountKey:FOREIGN},{selfAccountKey:FOREIGN,companyAccountKey:COMPANY,grants:[]}).authorization.layer,'self','own key wins as self, not as a grant');
});

test('the prototype grant store refuses unusable keys instead of storing them',()=>{
  const store=createMemoryGrantStore();
  for(const bad of ['',' key','key ','','key\ttab','x'.repeat(600),42,null])assert.throws(()=>store.add(bad as never),(error:unknown)=>(error as {code?:string}).code==='invalid-query');
  assert.equal(store.has('anything'),false);
  for(const bad of ['',' key',42])assert.throws(()=>store.remove(bad as never),(error:unknown)=>(error as {code?:string}).code==='invalid-query');
  assert.throws(()=>createMemoryGrantStore(['']),(error:unknown)=>(error as {code?:string}).code==='invalid-query');
  assert.equal(grantKey(`${'k'}`),true);
  assert.equal(grantKey(' '),false);
  assert.equal(store.add(GRANTED),true);
  assert.equal(store.add(GRANTED),false);
  assert.equal(Object.isFrozen(store.list()),true);
});
