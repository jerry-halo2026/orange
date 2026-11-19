// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAccountResolver,type AccountLookupResult} from './accounts.ts';

const here=dirname(fileURLToPath(import.meta.url));
const failure=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;
const found=(field:'account'|'name',accountKey:string,account='fixture_login'):AccountLookupResult=>({status:'found',field,grants:false,account:{account,accountKey:{value:accountKey,sourceType:'string',source:accountKey},observation:{accountKey:accountKey as never}}});
const empty:AccountLookupResult={status:'not-found',grants:false};

function fixture(options:{answers?:{[value:string]:AccountLookupResult[]};authorize?:(value:string)=>boolean;now?:()=>number;ttlMs?:number;capacity?:number}={}){
  const calls:Array<{field:string;value:string}>=[];const answers={...options.answers};
  const resolver=createAccountResolver({
    now:options.now,
    ttlMs:options.ttlMs,
    capacity:options.capacity,
    authorize:(_context:unknown,value:string)=>options.authorize?options.authorize(value):true,
    lookup:async(_context:unknown,request:{field:'account'|'name';value:string})=>{calls.push({...request});const queue=answers[request.value];const next=queue?.shift();assert.ok(next,`unexpected lookup ${request.field}=${request.value}`);return next;},
  });
  return {resolver,calls};
}

test('account is matched first and name only after an empty account result',async()=>{
  const s=fixture({answers:{fixture_login:[empty,found('name','fixture-person-key')]}});
  const resolved=await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
  assert.deepEqual(s.calls,[{field:'account',value:'fixture_login'},{field:'name',value:'fixture_login'}]);
  assert.equal(resolved.status,'found');
  assert.equal(resolved.status==='found'&&resolved.field,'name');
  assert.equal(resolved.status==='found'&&resolved.accountKey,'fixture-person-key');
  assert.equal(resolved.status==='found'&&resolved.cached,false);
});

test('an exact account hit stops at one bounded request and grants nothing by itself',async()=>{
  const s=fixture({answers:{fixture_login:[found('account','fixture-person-key')]}});
  const resolved=await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
  assert.equal(s.calls.length,1);
  assert.equal(s.calls[0].field,'account');
  assert.equal(resolved.status,'found');
  assert.equal(resolved.status==='found'&&resolved.accountKey,'fixture-person-key');
});

test('a found result is cached in memory, and only a found result is cached',async()=>{
  const s=fixture({answers:{fixture_login:[found('account','fixture-person-key')],fixture_missing:[empty,empty,empty,empty]}});
  const first=await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
  assert.equal(first.status==='found'&&first.cached,false);
  const second=await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
  assert.equal(second.status==='found'&&second.cached,true);
  assert.equal(s.calls.length,1,'the cached hit performs no supplier call');
  assert.equal(s.resolver.cached(),1);

  const missing=await s.resolver.resolve({subjectId:'fixture'},'fixture_missing');
  assert.deepEqual({...missing},{status:'not-found',cached:false});
  const again=await s.resolver.resolve({subjectId:'fixture'},'fixture_missing');
  assert.deepEqual({...again},{status:'not-found',cached:false});
  assert.equal(s.calls.length,5,'not-found is re-asked, not remembered');
  assert.equal(s.resolver.cached(),1,'nothing was stored for the empty answer');
});

test('ambiguous and disabled results are preserved and never cached as usable',async()=>{
  for(const status of ['ambiguous','disabled'] as const){
    const s=fixture({answers:{fixture_login:[{status,grants:false},{status,grants:false}]}});
    const first=await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
    assert.deepEqual({...first},{status,cached:false});
    const second=await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
    assert.deepEqual({...second},{status,cached:false});
    assert.equal(s.calls.length,2);
    assert.equal(s.resolver.cached(),0);
  }
});

test('authorization is re-checked on every resolve, including cached hits',async()=>{
  let allow=true;
  const s=fixture({answers:{fixture_login:[found('account','fixture-person-key')]},authorize:()=>allow});
  await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
  allow=false;
  await assert.rejects(()=>s.resolver.resolve({subjectId:'fixture'},'fixture_login'),failure('lookup-not-authorized'));
  assert.equal(s.calls.length,1,'the denial did not reach the supplier');
  const throwing=createAccountResolver({authorize:()=>{throw Error('fixture_secret policy');},lookup:async()=>assert.fail('no transport')});
  await assert.rejects(()=>throwing.resolve({subjectId:'fixture'},'fixture_login'),(error:unknown)=>(error as {code?:string}).code==='lookup-not-authorized'&&!/fixture_secret/.test(String(error)));
});

test('cache expiry is bounded and stale entries are re-resolved',async()=>{
  let now=1000;
  const s=fixture({answers:{fixture_login:[found('account','k1'),found('account','k2')]},now:()=>now,ttlMs:60000});
  const first=await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
  const second=await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
  assert.equal(first.status==='found'&&first.cached,false);
  assert.equal(second.status==='found'&&second.cached,true);
  now+=59999;
  const fresh=await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
  assert.equal(fresh.status==='found'&&fresh.cached,true);
  now+=1;
  const stale=await s.resolver.resolve({subjectId:'fixture'},'fixture_login');
  assert.equal(stale.status==='found'&&stale.cached,false);
  assert.equal(stale.status==='found'&&stale.accountKey,'k2');
  assert.equal(s.calls.length,2);
  const clamped=createAccountResolver({ttlMs:7*24*3600*1000,now:()=>now,authorize:()=>true,lookup:async()=>found('account','k')});
  await clamped.resolve({subjectId:'fixture'},'fixture_login');
  now+=24*3600*1000;
  const expired=await clamped.resolve({subjectId:'fixture'},'fixture_login');
  assert.equal(expired.status==='found'&&expired.cached,false,'a TTL above 24h is clamped, never trusted');
});

test('unsafe lookup values are refused before any supplier call',async()=>{
  const s=fixture();
  for(const value of ['',' ',' fixture_login','fixture_login ','fixture*','fixture%','fixture\u0000login','x'.repeat(257),'fixture_login\n'])await assert.rejects(()=>s.resolver.resolve({subjectId:'fixture'},value as string),failure('invalid-query'));
  assert.equal(s.calls.length,0);
});

test('the cache is bounded and evicts the oldest entry first',async()=>{
  const answers:{[value:string]:AccountLookupResult[]}={};
  for(const value of ['a','b','c'])answers[value]=[found('account','k-'+value)];
  answers.a.push(found('account','k-a'));
  const s=fixture({answers,capacity:2});
  await s.resolver.resolve({subjectId:'fixture'},'a');
  await s.resolver.resolve({subjectId:'fixture'},'b');
  await s.resolver.resolve({subjectId:'fixture'},'c');
  assert.equal(s.resolver.cached(),2);
  await s.resolver.resolve({subjectId:'fixture'},'a');
  const afterA=s.calls.length;
  await s.resolver.resolve({subjectId:'fixture'},'c');
  assert.deepEqual(s.calls.map(c=>c.value),['a','b','c','a'],'c survived, a was evicted and re-resolved, c stayed cached');
  assert.equal(s.calls.length,afterA,'the second c resolve was a cached hit');
});

test('the resolver cannot persist an account directory: it has no filesystem surface at all',()=>{
  const source=readFileSync(join(here,'accounts.ts'),'utf8');
  for(const forbidden of ['node:fs','writeFile','mkdir','appendFile','createWriteStream','node:sqlite','localStorage']){
    assert.equal(source.includes(forbidden),false,`accounts.ts must not reference ${forbidden}`);
  }
  assert.doesNotMatch(source,/pageSize\s*:\s*(?!5\b)\d+/,'the only lookup page size is the transport bound');
});
