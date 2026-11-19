// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {compileVideo} from './compile.ts';
import {arbitrate} from './arbitrate.ts';
import {createMemoryWikiStore} from './store.ts';
import type {Analyzer,Claim,VideoSummary} from './types.ts';

/**
 * Arbitration is the only way out of `disputed`, and it must be attributable: every choice leaves an
 * event behind, and adopting the challenger keeps both sources so the history stays auditable.
 */
const COMPANY='company-a';

const analyzerReturning=(body:string):Analyzer=>async (prompt:string)=>({
  title:prompt.includes('Title: Widget')?'Widget':'Widget',
  body_md:body,
  tags:['fixture'],
  confidence:0.7,
});

const claim=(relation:Claim['relation'],text:string):Claim=>Object.freeze({kind:'product',title:'Widget',claim:text,relation});

const summary=(videoId:string,version:string,c:Claim):VideoSummary=>Object.freeze({videoId,claims:[c],analyzerVer:version});

async function disputedStore(){
  const store=createMemoryWikiStore();
  await compileVideo({companyKey:COMPANY,videoId:'v1',summary:summary('v1','a1.0',claim('new','mounted on a wall')),analyzer:analyzerReturning('mounted on a wall'),store,now:()=>Date.parse('2026-11-13T00:00:00Z')});
  await compileVideo({companyKey:COMPANY,videoId:'v2',summary:summary('v2','a1.1',claim('contradicts','stands on the floor')),analyzer:analyzerReturning('stands on the floor'),store,now:()=>Date.parse('2026-11-13T01:00:00Z')});
  const entity=store.entities()[0];
  return {store,entity};
}

test('choosing the incumbent clears the dispute and records the decision',async()=>{
  const {store,entity}=await disputedStore();
  const result=await arbitrate({companyKey:COMPANY,entityId:entity.entity_id,choice:'a',store,now:()=>Date.parse('2026-11-14T00:00:00Z')});
  assert.equal(result.status,'active');
  assert.equal(result.adopted,false);
  const after=store.entities()[0];
  assert.equal(after.status,'active');
  assert.equal(after.body_md,'mounted on a wall','the incumbent text stayed');
  assert.equal(after.disputes.length,1,'the dispute is history, not something to erase');
  const event=store.events().find(entry=>entry.kind==='arbitrate');
  assert.ok(event,'an arbitration leaves an event');
  assert.equal(event?.detail.choice,'a');
});

test('choosing the challenger adopts its text and keeps both sources',async()=>{
  const {store,entity}=await disputedStore();
  const result=await arbitrate({companyKey:COMPANY,entityId:entity.entity_id,choice:'b',store,now:()=>Date.parse('2026-11-14T00:00:00Z')});
  assert.equal(result.status,'active');
  assert.equal(result.adopted,true);
  const after=store.entities()[0];
  assert.equal(after.body_md,'stands on the floor');
  assert.deepEqual(after.sources,['v1','v2'],'the losing side still contributed');
  assert.equal(after.status,'active');
});

test('keeping the dispute leaves the page disputed and still records who decided',async()=>{
  const {store,entity}=await disputedStore();
  const result=await arbitrate({companyKey:COMPANY,entityId:entity.entity_id,choice:'keep',store,by:'reviewer@fixture',now:()=>Date.parse('2026-11-14T00:00:00Z')});
  assert.equal(result.status,'disputed');
  const after=store.entities()[0];
  assert.equal(after.status,'disputed');
  assert.equal(after.body_md,'mounted on a wall');
  const event=store.events().find(entry=>entry.kind==='arbitrate');
  assert.equal(event?.detail.by,'reviewer@fixture');
});

test('arbitrating an unknown entity fails instead of writing anything',async()=>{
  const store=createMemoryWikiStore();
  await assert.rejects(()=>arbitrate({companyKey:COMPANY,entityId:'missing',choice:'a',store}),(error:unknown)=>{
    assert.equal((error as {status?:number}).status,404);
    return true;
  });
  assert.equal(store.events().length,0);
});

test('an active page with no dispute cannot be arbitrated into a resolution',async()=>{
  const store=createMemoryWikiStore();
  await compileVideo({companyKey:COMPANY,videoId:'v1',summary:summary('v1','a1.0',claim('new','x')),analyzer:analyzerReturning('x'),store});
  const entity=store.entities()[0];
  await assert.rejects(()=>arbitrate({companyKey:COMPANY,entityId:entity.entity_id,choice:'b',store}),(error:unknown)=>{
    assert.equal((error as {code?:string}).code,'no-dispute');
    return true;
  });
});
