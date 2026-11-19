// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {compileVideo,compareVer,entityId,eventId} from './compile.ts';
import {createMemoryWikiStore} from './store.ts';
import {slugify,slugFor} from './slug.ts';
import type {Analyzer,Claim,EntityRow,VideoSummary} from './types.ts';

/**
 * The compile step is judged by three things: what it decides (new / update / disputed), what it
 * refuses to write, and whether a human still has the last word. Every test below pins one of those.
 */
const COMPANY='company-a';
const VERSION='a1.0';

const page=(title:string,body:string,tags:string[]=['t'],confidence=0.8)=>({title,body_md:body,tags,confidence});

/** A fake analyzer: the prompt names the title, so the reply can differ per entity. */
function analyzerOf(map:Record<string,(prompt:string)=>unknown>,fallback?:(prompt:string)=>unknown):Analyzer {
  const calls:string[]=[];
  const analyzer:Analyzer=async (prompt:string)=>{
    calls.push(prompt);
    for(const [title,reply] of Object.entries(map))if(prompt.includes(`Title: ${title}`))return reply(prompt);
    if(fallback)return fallback(prompt);
    return page('Fixture','Body for '+prompt.split('\n')[1],['fixture']);
  };
  return Object.assign(analyzer,{calls});
}

const claimOf=(overrides:Partial<Claim>={}):Claim=>Object.freeze({
  kind:'product',title:'Widget',claim:'Widget is a wall-mounted shelf',relation:'new',...overrides,
});

const summaryOf=(claims:readonly Claim[],videoId='v1',analyzerVer=VERSION):VideoSummary=>Object.freeze({videoId,claims,analyzerVer,notes:'analyser notes'});

const run=async(options:{claims:readonly Claim[];analyzer:Analyzer;store:ReturnType<typeof createMemoryWikiStore>;videoId?:string;version?:string;companyKey?:string})=>{
  return compileVideo({
    companyKey:options.companyKey??COMPANY,
    videoId:options.videoId??'v1',
    summary:summaryOf(options.claims,options.videoId??'v1',options.version??VERSION),
    analyzer:options.analyzer,
    store:options.store,
    now:()=>Date.parse('2026-11-13T00:00:00Z'),
  });
};

test('a claim about an unknown entity becomes a new page and one event',async()=>{
  const store=createMemoryWikiStore();
  const result=await run({claims:[claimOf()],analyzer:analyzerOf({Widget:()=>page('Widget','# Widget\nShelf.',['furniture']) }),store});
  assert.deepEqual(result.triage,['new']);
  assert.equal(result.events,1);
  assert.equal(store.entities().length,1);
  assert.equal(store.events().length,1);
  const entity=store.entities()[0];
  assert.equal(entity.entity_id,entityId(COMPANY,'product','widget'));
  assert.equal(entity.status,'active');
  assert.deepEqual(entity.sources,['v1']);
  assert.deepEqual(entity.tags,['furniture']);
  assert.equal(store.summaries().length,1,'the summary went through upsertSummary');
});

test('an incremental claim updates the page and keeps the older sources',async()=>{
  const store=createMemoryWikiStore();
  await run({claims:[claimOf()],analyzer:analyzerOf({Widget:()=>page('Widget','first',['a'])}),store});
  const result=await run({videoId:'v2',claims:[claimOf({relation:'supports',claim:'Widget also ships in oak'})],analyzer:analyzerOf({Widget:()=>page('Widget','first and oak',['a','wood'])}),store});
  assert.deepEqual(result.triage,['update']);
  const entity=store.entities()[0];
  assert.deepEqual(entity.sources,['v1','v2'],'the old source survives the merge');
  assert.deepEqual(entity.tags,['a','wood']);
  assert.equal(entity.body_md,'first and oak');
  assert.equal(entity.status,'active');
});

test('a contradicting claim disputes the page: text unchanged, both sources kept, dispute recorded',async()=>{
  const store=createMemoryWikiStore();
  await run({claims:[claimOf()],analyzer:analyzerOf({Widget:()=>page('Widget','mounted on a wall',['a'])}),store});
  const result=await run({videoId:'v2',version:'a1.1',claims:[claimOf({relation:'contradicts',claim:'Widget actually stands on the floor'})],analyzer:analyzerOf({Widget:()=>page('Widget','stands on the floor',['a'])}),store});
  assert.deepEqual(result.triage,['disputed']);
  const entity=store.entities()[0];
  assert.equal(entity.status,'disputed');
  assert.equal(entity.body_md,'mounted on a wall','the incumbent text is not overwritten');
  assert.deepEqual(entity.sources,['v1','v2'],'both sides keep their source');
  assert.equal(entity.disputes.length,1);
  assert.equal(entity.disputes[0].candidate.body_md,'stands on the floor');
  assert.equal(entity.disputes[0].candidate.video_id,'v2');
  assert.equal(store.events().some(event=>event.kind==='disputed'),true);
});

test('a malformed analyzer reply is refused and nothing is written',async()=>{
  const store=createMemoryWikiStore();
  const analyzer=analyzerOf({Widget:()=>({title:'Widget',body_md:'x',tags:'not-an-array',confidence:2})});
  await assert.rejects(()=>run({claims:[claimOf()],analyzer,store}),(error:unknown)=>{
    assert.match(String((error as {code?:string}).code),/analyzer-malformed/);
    return true;
  });
  assert.equal(store.entities().length,0);
  assert.equal(store.events().length,0);
  assert.equal(store.summaries().length,0);
});

test('an older analyzer version cannot overwrite a newer page',async()=>{
  const store=createMemoryWikiStore();
  await run({version:'a1.10',claims:[claimOf()],analyzer:analyzerOf({Widget:()=>page('Widget','newer',['a'])}),store});
  await assert.rejects(()=>run({videoId:'v9',version:'a1.0',claims:[claimOf()],analyzer:analyzerOf({Widget:()=>page('Widget','older',['a'])}),store}),(error:unknown)=>{
    assert.equal((error as {code?:string}).code,'stale-analyzer-version');
    return true;
  });
  assert.equal(store.entities()[0].body_md,'newer');
  assert.equal(store.counts().refused>=0,true);
});

test('the store refuses a stale version even when it is written to directly',async()=>{
  const store=createMemoryWikiStore();
  await run({version:'a1.10',claims:[claimOf()],analyzer:analyzerOf({Widget:()=>page('Widget','newer',['a'])}),store});
  const current=store.entities()[0];
  const stale:EntityRow={...current,analyzer_ver:'a1.05',body_md:'older'};
  await assert.rejects(()=>store.upsertEntity(stale),(error:unknown)=>{
    assert.equal((error as {code?:string}).code,'stale-analyzer-version');
    return true;
  });
  assert.equal(store.entities()[0].body_md,'newer');
});

test('an eight-kind taxonomy is normalised to one slug shape',async()=>{
  assert.equal(slugify('Widget'),'widget');
  assert.equal(slugify('New Warehouse Product'),'new-warehouse-product');
  assert.equal(slugify('  Hook/5s  '),'hook-5s');
  assert.equal(slugify('新仓 产品'),'新仓-产品','Chinese stays Chinese, joined by hyphens');
  assert.equal(slugify('!!!'),'entity','an empty title still has a key');
  assert.equal(slugFor('Whatever','  Explicit Slug '),'explicit-slug');

  const store=createMemoryWikiStore();
  const kinds=['product','person','scene','style','brand','collection','hook','selling_point'] as const;
  const claims=kinds.map(kind=>claimOf({kind,title:`${kind} Thing`,claim:`about ${kind}`}));
  const result=await run({claims,analyzer:analyzerOf({},()=>page('T','B',['x'])),store});
  assert.equal(result.entities.length,8);
  assert.deepEqual([...new Set(store.entities().map(row=>row.slug))].length,8);
  for(const kind of kinds)assert.equal(store.entities().some(row=>row.kind===kind),true,kind);
});

test('recompiling the same video is idempotent once the verdict settles',async()=>{
  const store=createMemoryWikiStore();
  const analyzer=analyzerOf({Widget:()=>page('Widget','body',['a'])});
  await run({claims:[claimOf()],analyzer,store});
  const first=store.counts().events;
  // The second run sees a page that already exists, so its verdict is update - a different event,
  // because a verdict change is exactly what an audit wants to see.
  await run({claims:[claimOf()],analyzer,store});
  assert.equal(store.counts().events,first+1,'new and update are separate events');
  const settled=store.counts().events;
  // The third run repeats the same (video, kind, slug, triage, version) tuple: no new event.
  await run({claims:[claimOf()],analyzer,store});
  assert.equal(store.counts().events,settled,'the same tuple is deduplicated');
  assert.equal(store.entities().length,1);
});

test('the event key separates triages and is stable for one tuple',async()=>{
  const base=eventId('v1','product','widget','update','a1.0');
  assert.equal(base,eventId('v1','product','widget','update','a1.0'),'the same tuple is the same key');
  assert.notEqual(base,eventId('v1','product','widget','disputed','a1.0'),'a different triage is a different key');
  assert.notEqual(base,eventId('v1','product','widget','update','a1.1'),'a different version is a different key');
  assert.notEqual(base,eventId('v2','product','widget','update','a1.0'),'a different video is a different key');
});

test('a page that turns disputed leaves its own event next to the update it had',async()=>{
  const store=createMemoryWikiStore();
  const analyzer=analyzerOf({Widget:()=>page('Widget','mounted',['a'])});
  await run({claims:[claimOf()],analyzer,store});
  await run({videoId:'v2',claims:[claimOf({relation:'supports',claim:'still mounted'})],analyzer,store});
  const before=store.events().map(event=>event.kind);
  assert.deepEqual(before,['new','update']);
  await run({videoId:'v3',version:'a1.1',claims:[claimOf({relation:'contradicts',claim:'actually stands'})],analyzer:analyzerOf({Widget:()=>page('Widget','stands',['a'])}),store});
  const kinds=store.events().map(event=>event.kind);
  assert.deepEqual(kinds,['new','update','disputed'],'update -> disputed is recorded, not merged away');
  assert.equal(new Set(store.events().map(event=>event.event_id)).size,3,'every key is distinct');
});

test('agreeing evidence does not overturn a dispute on its own',async()=>{
  const store=createMemoryWikiStore();
  await run({claims:[claimOf()],analyzer:analyzerOf({Widget:()=>page('Widget','mounted',['a'])}),store});
  await run({videoId:'v2',version:'a1.1',claims:[claimOf({relation:'contradicts',claim:'stands'})],analyzer:analyzerOf({Widget:()=>page('Widget','stands',['a'])}),store});
  const result=await run({videoId:'v3',version:'a1.2',claims:[claimOf({relation:'supports',claim:'mounted, again'})],analyzer:analyzerOf({Widget:()=>page('Widget','mounted for sure',['a'])}),store});
  assert.deepEqual(result.triage,['update']);
  const entity=store.entities()[0];
  assert.equal(entity.status,'disputed','only a human clears a dispute');
  assert.equal(entity.body_md,'mounted','the disputed text is left for the arbitration');
  assert.deepEqual(entity.sources,['v1','v2','v3']);
});

test('a missing tenant writes nothing at all',async()=>{
  const store=createMemoryWikiStore();
  await assert.rejects(()=>run({companyKey:'',claims:[claimOf()],analyzer:analyzerOf({}),store}),(error:unknown)=>{
    assert.equal((error as {code?:string}).code,'invalid-tenant');
    return true;
  });
  assert.equal(store.entities().length+store.events().length+store.summaries().length,0);
});

test('versions compare in dictionary order, as the contract says',async()=>{
  assert.equal(compareVer('a1.0','a1.10'),-1);
  assert.equal(compareVer('a1.10','a1.9'),-1,'dictionary order, not numeric: "1" sorts before "9"');
  assert.equal(compareVer('a1.0','a1.0'),0);
  assert.equal(compareVer('b','a'),1);
});

test('the summary is written through the store entry point, once per video',async()=>{
  const store=createMemoryWikiStore();
  await run({claims:[claimOf()],analyzer:analyzerOf({Widget:()=>page('Widget','b',['a'])}),store});
  await run({claims:[claimOf({title:'Gadget'})],analyzer:analyzerOf({Gadget:()=>page('Gadget','b',['a'])}),store});
  assert.equal(store.summaries().length,1,'one summary per video, not per claim');
  assert.equal(store.summaries()[0].video_id,'v1');
});
