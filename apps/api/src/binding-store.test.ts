// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBindingService} from './binding-store.ts';

const SUBJECT='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const KEY='fixture-account-key-000001';
const failure=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;

async function scratch(){
  const root=await mkdtemp(join(tmpdir(),'orange-bind-store-'));
  const directory=join(root,'.dev','zhishang');
  await mkdir(directory,{recursive:true});
  const file=join(directory,'bindings.local.json');
  await writeFile(file,JSON.stringify({version:1,bindings:{}}),'utf8');
  return {root,file,cleanup:()=>rm(root,{recursive:true,force:true})};
}

const readDocument=async(file:string)=>JSON.parse(await readFile(file,'utf8')) as {bindings:Record<string,Record<string,unknown>>;history?:Record<string,unknown>[]};

test('a claim is written atomically, 0600, with the claim metadata and no temp file left behind',async()=>{
  const s=await scratch();
  try{
    const store=createBindingService({mode:'server',file:s.file,now:()=>Date.parse('2026-11-13T00:00:00Z')});
    const claimed=await store.claim(SUBJECT,{account:'fixture_login',accountKey:KEY,teamId:7,groupId:9});
    assert.deepEqual(claimed,{account:'fixture_login',accountKey:KEY,teamId:7,groupId:9,boundAt:'2026-11-13T00:00:00.000Z',status:'claimed'});

    const document=await readDocument(s.file);
    assert.deepEqual(document.bindings[SUBJECT],{
      account:'fixture_login',boundAt:'2026-11-13T00:00:00.000Z',grantedAccountKeys:[],groupId:9,selfAccountKey:KEY,status:'claimed',teamId:7,
    });
    assert.equal(document.history,undefined,'nothing to remember yet');

    const names=await readdir(join(s.root,'.dev','zhishang'));
    assert.deepEqual(names,['bindings.local.json'],'the temp file is gone after the rename');
    assert.equal(await readFile(s.file,'utf8')===JSON.stringify(document,null,2),true);

    const info=await stat(s.file);
    if(process.platform!=='win32')assert.equal(info.mode&0o777,0o600,'the file is owner-only');
  }finally{await s.cleanup();}
});

test('re-binding to another key keeps the old one in history',async()=>{
  const s=await scratch();
  try{
    const store=createBindingService({mode:'server',file:s.file,now:()=>Date.parse('2026-11-13T00:00:00Z')});
    await store.claim(SUBJECT,{account:'first',accountKey:KEY});
    await store.claim(SUBJECT,{account:'second',accountKey:'fixture-account-key-000002'});
    assert.equal(store.read(SUBJECT)?.account,'second');
    const history=store.history();
    assert.equal(history.length,1);
    assert.equal(history[0].reason,'rebound');
    assert.equal(history[0].accountKey,KEY);
    assert.equal(history[0].subjectId,SUBJECT);

    const document=await readDocument(s.file);
    assert.equal(document.history?.length,1);
    assert.equal(document.bindings[SUBJECT].account,'second');
  }finally{await s.cleanup();}
});

test('releasing removes the binding, keeps a released entry, and is idempotent',async()=>{
  const s=await scratch();
  try{
    const store=createBindingService({mode:'server',file:s.file,now:()=>Date.parse('2026-11-13T00:00:00Z')});
    await store.claim(SUBJECT,{account:'fixture_login',accountKey:KEY});
    assert.equal(await store.release(SUBJECT),true);
    assert.equal(store.read(SUBJECT),null);
    assert.equal(store.history()[0].reason,'released');
    assert.equal(await store.release(SUBJECT),false,'releasing twice is not an error');
    const document=await readDocument(s.file);
    assert.deepEqual(document.bindings,{});
    assert.equal(document.history?.length,1);
  }finally{await s.cleanup();}
});

test('local mode refuses writes and leaves the file untouched',async()=>{
  const s=await scratch();
  try{
    const before=await readFile(s.file,'utf8');
    const store=createBindingService({mode:'local',file:s.file});
    await assert.rejects(()=>store.claim(SUBJECT,{account:'x',accountKey:KEY}),failure('binding-store-readonly'));
    await assert.rejects(()=>store.release(SUBJECT),failure('binding-store-readonly'));
    assert.equal(await readFile(s.file,'utf8'),before);
    assert.equal(store.read(SUBJECT),null);
  }finally{await s.cleanup();}
});

test('server mode without a writable file refuses instead of pretending to save',async()=>{
  const store=createBindingService({mode:'server',file:null});
  await assert.rejects(()=>store.claim(SUBJECT,{account:'x',accountKey:KEY}),failure('binding-store-unavailable'));
  await assert.rejects(()=>store.release(SUBJECT),failure('binding-store-unavailable'));
});

test('a failed write leaves no half file and does not change the in-memory state',async()=>{
  const s=await scratch();
  try{
    const store=createBindingService({mode:'server',file:s.file});
    await store.claim(SUBJECT,{account:'first',accountKey:KEY});
    // Turn the target into a directory: the rename cannot replace it.
    await rm(s.file,{force:true});
    await mkdir(s.file,{recursive:true});
    await assert.rejects(()=>store.claim(OTHER,{account:'second',accountKey:'fixture-account-key-000003'}),failure('binding-store-write-failed'));
    assert.equal(store.read(OTHER),null,'the failed claim is rolled back');
    const leftovers=(await readdir(join(s.root,'.dev','zhishang'))).filter(name=>name.includes('.tmp-'));
    assert.deepEqual(leftovers,[],'no temp file survives the failure');
  }finally{await s.cleanup();}
});

test('concurrent claims are serialized into one valid document',async()=>{
  const s=await scratch();
  try{
    const store=createBindingService({mode:'server',file:s.file});
    await Promise.all([
      store.claim(SUBJECT,{account:'a',accountKey:KEY}),
      store.claim(OTHER,{account:'b',accountKey:'fixture-account-key-000004'}),
      store.claim('33333333-3333-4333-8333-333333333333',{account:'c',accountKey:'fixture-account-key-000005'}),
    ]);
    const document=await readDocument(s.file);
    assert.deepEqual(Object.keys(document.bindings).sort(),[SUBJECT,OTHER,'33333333-3333-4333-8333-333333333333'].sort());
    assert.equal(store.table().size,3);
  }finally{await s.cleanup();}
});
