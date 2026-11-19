// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {syncCatalog,toMaterialRow,type CatalogItem} from './catalog.ts';
import {contentHash} from './hash.ts';
import {createLimiter} from './rate.ts';
import type {MaterialRow,MaterialStore,SyncState} from './store.ts';

const COMPANY='company-a';
const ENV='production';
const target={companyKey:COMPANY,envId:ENV};

const item=(id:string,overrides:Record<string,unknown>={}):CatalogItem=>Object.freeze({
  videoId:id,
  observation:Object.freeze({
    videoId:`{${id}}`,
    name:`name-${id}`,
    fileSize:1000,
    duration:2000,
    createTime:`2026-11-${id.padStart(2,'0')}T00:00:00Z`,
    accountKey:'acct-a',
    videoType:1,
    videoLabels:[{id:1,name:'l1'}],
    ...overrides,
  }),
});

/** An in-memory store: records every call so a test can assert on writes, not on internals. */
function memoryStore(seed:MaterialRow[]=[]){
  const rows=new Map(seed.map(row=>[`${row.company_key}/${row.env_id}/${row.video_id}`,row]));
  const states=new Map<string,SyncState>();
  const calls={hashes:0,upsert:0,upsertRows:0,prune:0,writeState:0};
  const store:MaterialStore=Object.freeze({
    async hashes(companyKey,envId,videoIds){
      calls.hashes+=1;
      const map=new Map<string,string|null>();
      for(const id of videoIds){const row=rows.get(`${companyKey}/${envId}/${id}`);if(row)map.set(id,row.content_hash);}
      return map;
    },
    async upsert(incoming){calls.upsert+=1;calls.upsertRows+=incoming.length;for(const row of incoming)rows.set(`${row.company_key}/${row.env_id}/${row.video_id}`,row);return incoming.length;},
    async pruneMissing(companyKey,envId,seen,at){
      calls.prune+=1;
      const seenSet=new Set(seen);let count=0;
      for(const [key,row] of rows){
        if(row.company_key!==companyKey||row.env_id!==envId)continue;
        if(!seenSet.has(row.video_id)){rows.delete(key);count+=1;}
      }
      void at;
      return count;
    },
    async readState(companyKey,envId,mode){return states.get(`${companyKey}/${envId}/${mode}`)??null;},
    async writeState(state){calls.writeState+=1;states.set(`${state.company_key}/${state.env_id}/${state.mode}`,state);},
  });
  return {store,rows,states,calls};
}

/** Pages are served in order; an absent page is the empty page the loop must stop on. */
function readerOf(pages:CatalogItem[][],options:{onPage?:(index:number)=>void;total?:number}={}){
  const requests:Array<{pageNo:number;pageSize:number;filter:Record<string,string|number>}>=[];
  return {
    requests,
    async page(request:{pageNo:number;pageSize:number;filter:Record<string,string|number>}){
      requests.push({...request});
      options.onPage?.(request.pageNo);
      const items=pages[request.pageNo-1]??[];
      // A real out-of-range page carries `total=0`; the sync must not look at it either way.
      return {items,total:options.total??0} as unknown as {items:CatalogItem[]};
    },
  };
}

test('paging stops on an empty page even when the supplier reports a total',async()=>{
  const s=memoryStore();
  const full=(offset:number)=>Array.from({length:200},(_,index)=>item(String(offset+index).padStart(3,'0')));
  // Both pages are exactly pageSize long, so only an empty page can end the loop; the reported
  // 	otal is deliberately a huge number that a naive loop would trust.
  const reader=readerOf([full(1),full(201)],{total:178310});
  const report=await syncCatalog({reader,store:s.store,target,mode:'day',now:()=>Date.parse('2026-11-13T00:00:00Z')});
  assert.equal(report.pages,3,'two full pages plus the empty one that stops the loop');
  assert.equal(report.seen,400);
  assert.equal(report.upserted,400);
  assert.equal(s.rows.size,400);
});

test('a day run asks for one overlapping day, newest first',async()=>{
  const s=memoryStore();
  const reader=readerOf([[]]);
  await syncCatalog({reader,store:s.store,target,mode:'day',now:()=>Date.parse('2026-11-13T05:00:00Z')});
  assert.deepEqual(reader.requests[0].filter,{orderByType:1,esUpdateStartTime:'2026-11-12',esUpdateEndTime:'2026-11-13'});
  assert.equal(reader.requests[0].pageSize,200);
});

test('a failed page leaves the watermark where it was',async()=>{
  const s=memoryStore();
  let calls=0;
  const reader={
    async page(request:{pageNo:number;pageSize:number}){
      calls+=1;
      if(calls===1)return {items:Array.from({length:200},(_,index)=>item(String(500+index)))};
      throw new Error('supplier down');
    },
  };
  await assert.rejects(()=>syncCatalog({reader:reader as never,store:s.store,target,mode:'day',now:()=>0,attempts:1}),(error:unknown)=>{
    const report=(error as {report:{status:string;cursor:{createTime:string|null}}}).report;
    assert.equal(report.status,'failed');
    assert.equal(report.cursor.createTime,null,'the cursor did not move past the failed page');
    return true;
  });
  const state=s.states.get(`${COMPANY}/${ENV}/day`);
  assert.equal(state?.status,'failed');
  assert.equal(state?.cursor.createTime,null);
});

test('an unchanged fingerprint is not written again',async()=>{
  const row=toMaterialRow(item('07'),target)!;
  const s=memoryStore([row]);
  const reader=readerOf([[item('07')],[]]);
  const report=await syncCatalog({reader,store:s.store,target,mode:'day',now:()=>0});
  assert.equal(report.seen,1);
  assert.equal(report.upserted,0);
  assert.equal(report.skipped,1);
  assert.equal(s.calls.upsert,0,'nothing was rewritten');
});

test('a changed fingerprint is written once',async()=>{
  const row=toMaterialRow(item('08'),target)!;
  const s=memoryStore([row]);
  const reader=readerOf([[item('08',{name:'renamed'})],[]]);
  const report=await syncCatalog({reader,store:s.store,target,mode:'day',now:()=>0});
  assert.equal(report.upserted,1);
  assert.equal(s.calls.upsert,1);
  assert.notEqual(row.content_hash,toMaterialRow(item('08',{name:'renamed'}),target)!.content_hash);
});

test('dryRun reads everything and writes nothing',async()=>{
  const s=memoryStore();
  const reader=readerOf([[item('09'),item('10')],[]]);
  const report=await syncCatalog({reader,store:s.store,target,mode:'day',dryRun:true,now:()=>0});
  assert.equal(report.seen,2);
  assert.equal(report.upserted,0);
  assert.equal(s.calls.upsert,0);
  assert.equal(s.calls.writeState,0,'a dry run does not even record that it ran');
  assert.equal(s.rows.size,0);
});

test('two tenants never see each other through the store',async()=>{
  const s=memoryStore();
  const readerA=readerOf([[item('11')],[]]);
  const readerB=readerOf([[item('12')],[]]);
  await syncCatalog({reader:readerA,store:s.store,target,mode:'day',now:()=>0});
  await syncCatalog({reader:readerB,store:s.store,target:{companyKey:'company-b',envId:ENV},mode:'day',now:()=>0});
  assert.equal(s.rows.size,2);
  assert.equal(s.rows.get(`${COMPANY}/${ENV}/11`)?.company_key,COMPANY);
  assert.equal(s.rows.get(`company-b/${ENV}/12`)?.company_key,'company-b');
  assert.equal(s.states.size,2,'each tenant keeps its own cursor');
});

test('a full run tombstones only the ids it did not see',async()=>{
  const rows=[toMaterialRow(item('13'),target)!,toMaterialRow(item('14'),target)!];
  const s=memoryStore(rows);
  const reader=readerOf([[item('14')],[]]);
  const report=await syncCatalog({reader,store:s.store,target,mode:'full',now:()=>0});
  assert.equal(report.deleted,1);
  assert.equal(s.rows.has(`${COMPANY}/${ENV}/13`),false);
  assert.equal(s.rows.has(`${COMPANY}/${ENV}/14`),true,'the seen row stays');
});

test('the watermark walk stops as soon as a page is older than the cursor',async()=>{
  const s=memoryStore();
  s.states.set(`${COMPANY}/${ENV}/watermark`,Object.freeze({
    company_key:COMPANY,env_id:ENV,mode:'watermark',account_key:'',cursor:{createTime:'2026-11-10T00:00:00Z',videoId:null},
    last_run:'2026-11-11T00:00:00Z',drift:{seen:0,upserted:0,skipped:0,deleted:0},pages:0,requests:0,status:'ok' as const,error:null,
  }));
  const stale=[item('03'),item('04')];
  const reader=readerOf([stale,[item('30')],[]]);
  const report=await syncCatalog({reader,store:s.store,target,mode:'watermark',now:()=>0});
  assert.equal(report.pages,1,'the older page ends the run without being written');
  assert.equal(report.upserted,0);
});

test('the fingerprint covers exactly the fields a card shows',async()=>{
  const base=toMaterialRow(item('15'),target)!;
  assert.equal(base.content_hash,toMaterialRow(item('15'),target)!.content_hash,'stable');
  const renamed=toMaterialRow(item('15',{name:'other'}),target)!;
  assert.notEqual(base.content_hash,renamed.content_hash);
  const resized=toMaterialRow(item('15',{fileSize:2000}),target)!;
  assert.notEqual(base.content_hash,resized.content_hash);
  const relabelled=toMaterialRow(item('15',{videoLabels:[{id:1,name:'l1'},{id:2,name:'l2'}]}),target)!;
  assert.notEqual(base.content_hash,relabelled.content_hash);
  assert.equal(contentHash({name:'x',labels:['b','a']}),contentHash({name:'x',labels:['a','b']}),'label order is not a change');
});
test('a day increment costs one page request per 200 rows plus the empty one that ends it',async()=>{
  const s=memoryStore();
  const rows150=Array.from({length:150},(_,index)=>item(String(700+index)));
  const small=readerOf([rows150]);
  const report=await syncCatalog({reader:small,store:s.store,target,mode:'day',now:()=>0});
  assert.equal(report.pages,1,'150 rows is a short page, and a short page is itself the end of the window');
  assert.equal(report.requests,1);
  assert.equal(small.requests.length,1);

  const full=Array.from({length:200},(_,index)=>item(String(800+index)));
  const exact=readerOf([full,[item('999')]]);
  const second=await syncCatalog({reader:exact,store:s.store,target,mode:'day',now:()=>0});
  assert.equal(second.pages,2,'200 rows exactly fills page one, so page two is asked for and ends the window');
  assert.equal(exact.requests[1].pageNo,2);
});

test('a limiter paces the pages and reports how many requests went out',async()=>{
  const s=memoryStore();
  const clock={current:0,sleeps:[] as number[],now(){return this.current;},async sleep(ms:number){this.sleeps.push(ms);this.current+=ms;}};
  const limiter=createLimiter({qps:1,burst:1,maxConsecutive:100,now:()=>clock.current,sleep:(ms)=>clock.sleep(ms)});
  const page200=Array.from({length:200},(_,index)=>item(String(900+index)));
  const reader=readerOf([page200]);
  const report=await syncCatalog({reader,store:s.store,target,mode:'day',now:()=>0,limiter,sleep:(ms)=>clock.sleep(ms)});
  assert.equal(report.pages,2,'a full page, then the empty page that ends the window');
  assert.equal(limiter.stats().requests,2,'both pages went through the limiter');
  assert.equal(clock.sleeps.length>=1,true,'the second page waited for a token');
});
