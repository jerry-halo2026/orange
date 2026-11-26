// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {existsSync,readdirSync} from 'node:fs';
import {withAccountProviderSettings,readSettings,changeSettings,replaceAccountSettings} from './keys.mjs';
import {providersRoute} from './providers/index.mjs';
import {localModelsRoute} from './local-models.mjs';

const base=process.env.ORANGE_SERVICES_TEST_ROOT;
assert.ok(base&&resolve(base)===base,'explicit owned test root required');
await mkdir(base,{recursive:true});
function request(method,body){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;return req;}
function response(){let status=0,body='';return {res:{writeHead(n){status=n},end(value){body=value}},result:()=>({status,body:JSON.parse(body)})};}
async function call(file,check,method,parts,body){
 const {res,result}=response();
 await withAccountProviderSettings(file,check,()=>providersRoute(request(method,body),res,parts,{openBrowser:()=>assert.fail('unexpected browser'),isolated:true}));
 return result();
}
test('isolated Services reads and writes only the active account; GET and config never use network',async()=>{
 const root=await mkdtemp(join(base,'services-')),a=join(root,'a','providers.json'),b=join(root,'b','providers.json'),old=join(root,'old-providers.json');
 await writeFile(old,JSON.stringify({keys:{openai:'fixture-old-key-1234'}}));let active='a',calls=0;
 const priorFetch=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw Error('network forbidden')};
 const checkA=()=>{if(active!=='a')throw Error('session-expired')},checkB=()=>{if(active!=='b')throw Error('session-expired')};
 try{
  const before=await call(a,checkA,'GET',[]);assert.equal(before.status,200);assert(before.body.providers.length>5);assert.equal(before.body.providers.find(p=>p.id==='openai').source,null);
  assert.equal(before.body.providers.find(p=>p.id==='orangefilm').signIn,false);
  const keyed=await call(a,checkA,'PUT',['orangefilm','key'],{key:'ofk_fixture-1234'});assert.equal(keyed.body.providers.find(p=>p.id==='orangefilm').source,'file');assert.equal(keyed.body.providers.find(p=>p.id==='orangefilm').signIn,false);
  const saved=await call(a,checkA,'PUT',['openai','key'],{key:'fixture-owned-key-1234'});assert.equal(saved.body.providers.find(p=>p.id==='openai').source,'file');
  assert.doesNotMatch(JSON.stringify(saved.body),/fixture-owned-key/);
  active='b';const other=await call(b,checkB,'GET',[]);assert.equal(other.body.providers.find(p=>p.id==='openai').source,null);
  await assert.rejects(async()=>withAccountProviderSettings(a,checkA,()=>readSettings()),/session-expired/);
  assert.match(await readFile(old,'utf8'),/fixture-old-key-1234/);assert.equal(calls,0);
 }finally{globalThis.fetch=priorFetch;}
});
test('revoked account guard prevents local provider setting commit',async()=>{
 const root=await mkdtemp(join(base,'revoked-')),file=join(root,'providers.json');let checks=0;
 await assert.rejects(withAccountProviderSettings(file,()=>{if(++checks>=4)throw Error('session-expired')},()=>changeSettings(s=>{s.keys.openai='fixture-key-1234'})),/session-expired/);
 await assert.rejects(readFile(file,'utf8'),{code:'ENOENT'});
});
test('isolated provider OAuth and model installation stay explicitly unavailable',async()=>{
 const root=await mkdtemp(join(base,'limited-')),file=join(root,'providers.json');
 await assert.rejects(call(file,()=>{},'POST',['orangefilm','sign-in'],{}),e=>e.status===503);
 const {res}=response();await assert.rejects(localModelsRoute(request('POST'),res,['whisper-small','install'],{readOnly:true}),e=>e.status===503);
});

test('account retirement just before replacement prevents a queued write; another account stays separate',async()=>{
 const root=await mkdtemp(join(base,'before-commit-')),a=join(root,'a','providers.json'),b=join(root,'b','providers.json');
 let active='a';
 const checkA=()=>{if(active!=='a')throw Error('session-expired');if(existsSync(join(root,'a'))&&readdirSync(join(root,'a')).some(name=>name.endsWith('.tmp'))){active='b';throw Error('session-expired');}};
 const checkB=()=>{if(active!=='b')throw Error('session-expired')};
 const first=withAccountProviderSettings(a,checkA,()=>changeSettings(s=>{s.keys.openai='fixture-a-1234'}));
 const second=first.catch(()=>{}).then(()=>withAccountProviderSettings(b,checkB,()=>changeSettings(s=>{s.keys.openai='fixture-b-1234'})));
 await assert.rejects(first,/session-expired/);await second;
 await assert.rejects(readFile(a,'utf8'),{code:'ENOENT'});
 assert.match(await readFile(b,'utf8'),/fixture-b-1234/);
});
test('retirement queued at commit is ordered after atomic replacement',async()=>{
 const root=await mkdtemp(join(base,'after-commit-')),file=join(root,'providers.json');let active=true,scheduled=false;
 const check=()=>{if(!active)throw Error('session-expired');if(!scheduled&&readdirSync(root).some(name=>name.endsWith('.tmp'))){scheduled=true;queueMicrotask(()=>{active=false;});}};
 const result=await withAccountProviderSettings(file,check,()=>changeSettings(s=>{s.keys.openai='fixture-committed-1234'}));
 assert.equal(result.keys.openai,'fixture-committed-1234');assert.equal(active,false);
 assert.match(await readFile(file,'utf8'),/fixture-committed-1234/);
 await assert.rejects(async()=>withAccountProviderSettings(file,check,()=>readSettings()),/session-expired/);
});
test('concurrent settings edits for one session are serialized without losing either change',async()=>{
 const root=await mkdtemp(join(base,'concurrent-')),file=join(root,'providers.json');
 const [one,two]=await Promise.all([
  withAccountProviderSettings(file,()=>{},()=>changeSettings(s=>{s.keys.openai='fixture-concurrent-1234'})),
  withAccountProviderSettings(file,()=>{},()=>changeSettings(s=>{s.libraryOff=true}))
 ]);
 assert.equal(one.keys.openai,'fixture-concurrent-1234');assert.equal(two.libraryOff,true);
 const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.keys.openai,'fixture-concurrent-1234');assert.equal(saved.libraryOff,true);
});
test('account commit retries a Windows busy file with a fresh session check',async()=>{
 let active=true,attempts=0,checks=0;const waits=[];
 await replaceAccountSettings('from','to',()=>{checks++;if(!active)throw Error('session-expired')},{windows:true,rename:()=>{attempts++;if(attempts<3)throw Object.assign(Error('busy'),{code:'EBUSY'});},wait:async ms=>{waits.push(ms);}});
 assert.equal(attempts,3);assert.equal(checks,3);assert.deepEqual(waits,[20,40]);
});
test('account retirement during busy wait prevents the next rename',async()=>{
 let active=true,attempts=0;
 await assert.rejects(replaceAccountSettings('from','to',()=>{if(!active)throw Error('session-expired')},{windows:true,rename:()=>{attempts++;throw Object.assign(Error('busy'),{code:'EPERM'});},wait:async()=>{active=false;}}),/session-expired/);
 assert.equal(attempts,1);
});
test('account commit gives up after bounded Windows busy retries',async()=>{
 let attempts=0,waits=0;
 await assert.rejects(replaceAccountSettings('from','to',()=>{},{windows:true,rename:()=>{attempts++;throw Object.assign(Error('busy'),{code:'EACCES'});},wait:async()=>{waits++;}}),{code:'EACCES'});
 assert.equal(attempts,9);assert.equal(waits,8);
});