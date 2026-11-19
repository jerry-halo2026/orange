// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, symlink, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {accessFor, providerBindingFor, readBindingTable} from './bindings.ts';

const SUBJECT='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const SELF='fixture-self-account-key',GRANTED='fixture-granted-account-key',FOREIGN='fixture-foreign-account-key';

const failure=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;
const table=(bindings:Record<string,unknown>={[SUBJECT]:{selfAccountKey:SELF,grantedAccountKeys:[GRANTED]}})=>({version:1,bindings});

async function scratch(content?:unknown,raw?:string){
  const root=await mkdtemp(join(tmpdir(),'orange-bindings-'));
  const directory=join(root,'.dev','zhishang');
  await mkdir(directory,{recursive:true});
  const file=join(directory,'bindings.local.json');
  if(raw!==undefined)await writeFile(file,raw,'utf8');
  else if(content!==undefined)await writeFile(file,JSON.stringify(content),'utf8');
  return {root,file,cleanup:()=>rm(root,{recursive:true,force:true})};
}

test('a valid file loads into a frozen table, and only the count is ever reportable',async()=>{
  const s=await scratch(table());
  try{
    const loaded=await readBindingTable(s.file);
    assert.equal(loaded.size,1);
    const entry=loaded.get(SUBJECT);
    assert.deepEqual(entry,{selfAccountKey:SELF,grantedAccountKeys:[GRANTED]});
    assert.equal(Object.isFrozen(entry),true);
    assert.equal(Object.isFrozen(entry?.grantedAccountKeys),true);
  }finally{await s.cleanup();}
});

test('an empty binding map is a valid file with zero bindings',async()=>{
  const s=await scratch(table({}));
  try{
    const loaded=await readBindingTable(s.file);
    assert.equal(loaded.size,0);
  }finally{await s.cleanup();}
});

test('negative: missing, relocated, oversized and symlinked files are unreadable',async()=>{
  const s=await scratch(table());
  try{
    await assert.rejects(()=>readBindingTable(join(s.root,'.dev','zhishang','absent.local.json')),failure('bindings-unreadable'));
    await assert.rejects(()=>readBindingTable(join(s.root,'packages','bindings.local.json')),failure('bindings-unreadable'),'outside .dev');
    await assert.rejects(()=>readBindingTable('relative/bindings.local.json'),failure('bindings-unreadable'),'relative path');
    await assert.rejects(()=>readBindingTable(undefined),failure('bindings-unreadable'));

    const huge=join(s.root,'.dev','zhishang','bindings.local.json');
    await writeFile(huge,JSON.stringify({version:1,bindings:{[SUBJECT]:{selfAccountKey:SELF,grantedAccountKeys:[]}},pad:'x'.repeat(70*1024)}),'utf8');
    await assert.rejects(()=>readBindingTable(huge),failure('bindings-unreadable'),'over 64 KiB');

    const link=join(s.root,'.dev','zhishang','link.local.json');
    try{
      await writeFile(huge,JSON.stringify(table()),'utf8');
      await symlink(huge,link,'file');
      await assert.rejects(()=>readBindingTable(link),failure('bindings-unreadable'),'symlink');
    }catch(error){
      if((error as {code?:string})?.code!=='EPERM')throw error;
    }
  }finally{await s.cleanup();}
});

test('negative: every shape violation is refused instead of being ignored',async()=>{
  const cases:[string,unknown][]=[
    ['version 2',{version:2,bindings:{}}],
    ['version missing',{bindings:{}}],
    ['unknown top-level key',{version:1,bindings:{},extra:true}],
    ['bindings not an object',{version:1,bindings:[]}],
    ['subject not a uuid',{version:1,bindings:{'not-a-uuid':{selfAccountKey:SELF,grantedAccountKeys:[]}}}],
    ['entry not an object',{version:1,bindings:{[SUBJECT]:'nope'}}],
    ['unknown entry key',{version:1,bindings:{[SUBJECT]:{selfAccountKey:SELF,grantedAccountKeys:[],extra:1}}}],
    ['missing selfAccountKey',{version:1,bindings:{[SUBJECT]:{grantedAccountKeys:[]}}}],
    ['empty selfAccountKey',{version:1,bindings:{[SUBJECT]:{selfAccountKey:'',grantedAccountKeys:[]}}}],
    ['selfAccountKey with a space',{version:1,bindings:{[SUBJECT]:{selfAccountKey:'has space',grantedAccountKeys:[]}}}],
    ['grantedAccountKeys not an array',{version:1,bindings:{[SUBJECT]:{selfAccountKey:SELF,grantedAccountKeys:SELF}}}],
    ['grantedAccountKeys with a number',{version:1,bindings:{[SUBJECT]:{selfAccountKey:SELF,grantedAccountKeys:[1]}}}],
    ['grantedAccountKeys with an empty string',{version:1,bindings:{[SUBJECT]:{selfAccountKey:SELF,grantedAccountKeys:['']}}}],
  ];
  for(const [label,content] of cases){
    const s=await scratch(content);
    try{await assert.rejects(()=>readBindingTable(s.file),failure('bindings-invalid'),label);}
    finally{await s.cleanup();}
  }

  const notJson=await scratch(undefined,'{not json');
  try{await assert.rejects(()=>readBindingTable(notJson.file),failure('bindings-invalid'),'not json');}
  finally{await notJson.cleanup();}
});

test('a UTF-8 BOM is tolerated, and the key-set check still applies after it',async()=>{
  const s=await scratch(undefined,'\ufeff'+JSON.stringify(table()));
  try{
    assert.equal((await readBindingTable(s.file)).size,1);
    await writeFile(s.file,'\ufeff'+JSON.stringify({version:1,bindings:{},extra:1}),'utf8');
    await assert.rejects(()=>readBindingTable(s.file),failure('bindings-invalid'),'BOM + unknown top-level key');
  }finally{await s.cleanup();}
});

test('accessFor: the self key and the grants come from the file, and a stranger gets neither',async()=>{
  const s=await scratch(table());
  try{
    const loaded=await readBindingTable(s.file);
    const access=accessFor(loaded);
    assert.deepEqual(access(SUBJECT),{selfAccountKey:SELF,grants:[GRANTED]});
    assert.deepEqual(access(OTHER),{grants:[]},'an unknown subject has no self key and no grants');
    assert.equal('companyAccountKey' in access(OTHER),false,'and no company view is borrowed for it');

    const withCompany=accessFor(loaded,{companyAccountKey:'fixture-company-account-key'});
    assert.equal(withCompany(OTHER).companyAccountKey,'fixture-company-account-key');
    assert.equal(withCompany(SUBJECT).selfAccountKey,SELF);
  }finally{await s.cleanup();}
});

test('providerBindingFor: stable identity, file account key, and nothing for a stranger',async()=>{
  const s=await scratch(table());
  try{
    const loaded=await readBindingTable(s.file);
    const bindingFor=providerBindingFor(loaded,{environmentId:'fixture-env',now:()=>1_700_000_000_000});
    const first=bindingFor({subjectId:SUBJECT},'scope-1');
    const second=bindingFor({subjectId:SUBJECT},'scope-1');
    assert.ok(first,'the bound subject has a binding');
    assert.equal(first.accountKey,SELF);
    assert.equal(first.environmentId,'fixture-env');
    assert.equal(first.status,'active');
    assert.deepEqual(first,second,'the same subject yields the same binding twice');
    assert.match(first.bindingId,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(bindingFor({subjectId:OTHER},'scope-1'),null,'a stranger has no binding');
  }finally{await s.cleanup();}
});

test('the derived bookkeeping fields are deterministic across restarts, and never hardcoded',async()=>{
  const s=await scratch(table());
  try{
    const loaded=await readBindingTable(s.file);
    const start=(at:number)=>providerBindingFor(loaded,{environmentId:'fixture-env',now:()=>at})({subjectId:SUBJECT},'scope-1');
    const first=start(1_700_000_000_000),second=start(1_800_000_000_000);
    assert.ok(first&&second);
    assert.equal(first.bindingId,second.bindingId,'the same (subject, account key) yields the same id after a restart');
    assert.equal(first.revision,1);
    assert.equal(second.revision,1,'revision is always 1');
    assert.notEqual(first.expiresAtMs,second.expiresAtMs,'the expiry is re-derived from the clock, not baked in');
    assert.equal(first.expiresAtMs,1_700_000_000_000+12*3600*1000,'exactly ttl after composition time');
    assert.equal(second.expiresAtMs,1_800_000_000_000+12*3600*1000);

    const changed=providerBindingFor(loaded,{environmentId:'fixture-env',now:()=>1_700_000_000_000,ttlMs:60_000})({subjectId:SUBJECT},'scope-1');
    assert.equal(changed?.expiresAtMs,1_700_000_000_000+60_000,'the ttl is a parameter, still not a constant');

    // Determinism is per (subject, account key) pair only.
    const other=providerBindingFor(loaded,{environmentId:'fixture-env',now:()=>1_700_000_000_000});
    const otherTable=await scratch({version:1,bindings:{[OTHER]:{selfAccountKey:GRANTED,grantedAccountKeys:[]}}});
    try{
      const otherLoaded=await readBindingTable(otherTable.file);
      const otherBinding=providerBindingFor(otherLoaded,{environmentId:'fixture-env',now:()=>1_700_000_000_000})({subjectId:OTHER},'scope-1');
      assert.notEqual(other({subjectId:SUBJECT},'scope-1')?.bindingId,otherBinding?.bindingId,'different pairs differ');
    }finally{await otherTable.cleanup();}
  }finally{await s.cleanup();}
});
