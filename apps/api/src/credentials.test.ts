// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, symlink, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertIgnoredLocation,credentialsPath,readSupplierCredentials,SUPPLIER_ORIGIN} from './credentials.ts';

const failure=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;

async function scratch():Promise<string>{
  const root=await mkdtemp(join(tmpdir(),'orange-cred-'));
  await mkdir(join(root,'.dev','zhishang'),{recursive:true});
  return root;
}

const valid={environmentId:'fixture-env',companyKey:'fixture_company_key',companySecret:'fixture_company_secret',origin:SUPPLIER_ORIGIN};

test('the ignored local file is the only accepted source and its origin is pinned',async()=>{
  const root=await scratch();
  try{
    const file=credentialsPath(root);
    assert.equal(file,join(root,'.dev','zhishang','credentials.local.json'));
    await writeFile(file,JSON.stringify(valid),'utf8');
    const read=await readSupplierCredentials(file);
    assert.deepEqual(read,{environmentId:'fixture-env',companyKey:'fixture_company_key',companySecret:'fixture_company_secret'});
    assert.equal(Object.isFrozen(read),true);
    assert.equal('origin' in read,false,'origin is validated then dropped');

    for(const [label,body] of [
      ['foreign origin',{...valid,origin:'https://example.invalid'}],
      ['extra key',{...valid,extra:'fixture'}],
      ['missing key',{environmentId:'fixture-env',companyKey:'k',origin:SUPPLIER_ORIGIN}],
      ['array',[valid]],
      ['empty secret',{...valid,companySecret:''}],
      ['newline secret',{...valid,companySecret:'fixture\nsecret'}],
      ['unprintable note',{...valid,note:'fixture\nnote'}],
      ['oversized note',{...valid,note:'n'.repeat(300)}],
      ['not json','not-json'],
    ] as const){
      await writeFile(file,typeof body==='string'?body:JSON.stringify(body),'utf8');
      await assert.rejects(()=>readSupplierCredentials(file),failure('configuration-required'),label);
    }

    // The operator's real file carries a descriptive `note`; it is tolerated, validated, dropped,
    // and must not appear anywhere in the returned configuration.
    await writeFile(file,JSON.stringify({...valid,note:'fixture operator annotation'}),'utf8');
    const annotated=await readSupplierCredentials(file);
    assert.deepEqual(Object.keys(annotated).sort(),['companyKey','companySecret','environmentId']);
    assert.doesNotMatch(JSON.stringify(annotated),/annotation/);

    // A Windows editor may save the same file with a UTF-8 BOM; the BOM is not part of the JSON.
    await writeFile(file,'\ufeff'+JSON.stringify(valid),'utf8');
    const bommed=await readSupplierCredentials(file);
    assert.deepEqual(bommed,{environmentId:'fixture-env',companyKey:'fixture_company_key',companySecret:'fixture_company_secret'});
    // Stripping the BOM must not weaken the key-set check: an extra key after the BOM is still refused.
    for(const body of [{...valid,extra:'fixture'},{...valid,origin:'https://example.invalid'}]){
      await writeFile(file,'\ufeff'+JSON.stringify(body),'utf8');
      await assert.rejects(()=>readSupplierCredentials(file),failure('configuration-required'),'BOM + invalid key set');
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('paths outside the ignored .dev tree or with a different file name are refused before opening',async()=>{
  const root=await scratch();
  try{
    assert.throws(()=>assertIgnoredLocation(join(root,'packages','credentials.local.json')),failure('configuration-required'));
    assert.throws(()=>assertIgnoredLocation(join(root,'.dev','zhishang','credentials.json')),failure('configuration-required'));
    assert.throws(()=>assertIgnoredLocation('.dev/zhishang/credentials.local.json'),failure('configuration-required'),'relative paths are refused');
    await assert.rejects(()=>readSupplierCredentials(join(root,'.dev','zhishang','credentials.local.json')),failure('configuration-required'),'missing file');
    await assert.rejects(()=>readSupplierCredentials(undefined),failure('configuration-required'));
    const tracked=join(root,'packages');
    await mkdir(tracked,{recursive:true});
    await writeFile(join(tracked,'credentials.local.json'),JSON.stringify(valid),'utf8');
    await assert.rejects(()=>readSupplierCredentials(join(tracked,'..','.dev','zhishang','credentials.local.json')),failure('configuration-required'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a symlinked credential file is refused and no error ever carries a value or a path',async t=>{
  const root=await scratch();
  try{
    const real=join(root,'.dev','zhishang','credentials.local.json');
    const link=join(root,'.dev','zhishang','link.local.json');
    await writeFile(real,JSON.stringify(valid),'utf8');
    try{await symlink(real,link,'file');}catch{t.skip('symlink unavailable on this host');return;}
    let caught:unknown;
    try{await readSupplierCredentials(link);}catch(error){caught=error;}
    assert.ok(caught,'a link is not a credential source');
    assert.match(String((caught as Error).message),/^configuration-required$/);
    assert.doesNotMatch(String(caught)+JSON.stringify(caught),/fixture_company|orange-cred-|\.dev/);
    await assert.rejects(()=>readSupplierCredentials('C:\\.dev\\zhishang\\credentials.local.json'),error=>{
      assert.doesNotMatch(String(error),/fixture_company|fixture_company_secret/);
      return true;
    });
  }finally{await rm(root,{recursive:true,force:true});}
});
