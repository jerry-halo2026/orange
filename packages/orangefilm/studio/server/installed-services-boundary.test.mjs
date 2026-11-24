// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const base=process.env.ORANGE_SERVICES_TEST_ROOT;
assert.ok(base&&resolve(base)===base,'explicit owned test root required');
await mkdir(base,{recursive:true});
const root=await mkdtemp(join(base,'installed-services-'));
const env={ORANGE_HOME:join(root,'home'),ORANGE_SHARED_HOME:join(root,'shared'),ORANGE_LIBRARY:join(root,'projects'),ORANGE_LIBRARY_CACHE:join(root,'cache'),ORANGE_SAVED:join(root,'saved'),ORANGE_SKILLS:join(root,'skills'),ORANGE_EXPORTS:join(root,'exports'),ORANGE_ISOLATION_PROFILE:undefined,ORANGE_ISOLATION_ROOT:undefined};
for(const [key,value] of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
for(const path of Object.values(env).filter(Boolean))await mkdir(path,{recursive:true});
const editorDir=join(root,'editor');await mkdir(editorDir);await writeFile(join(editorDir,'index.html'),'<html>fixture</html>');
const shared=join(env.ORANGE_HOME,'providers.json');const original=JSON.stringify({keys:{openai:'fixture-global-1234'}});await writeFile(shared,original);
const {startStudio}=await import('./server.mjs');
const {createProject}=await import('./projects.mjs');
const project=await createProject('Synthetic account boundary');
const nativeFetch=globalThis.fetch;let remoteFetches=0;
globalThis.fetch=async()=>{remoteFetches++;return new Response('{}',{status:503});};
const auth={assertActive(){return {subjectId:actor}},runNative:async work=>work(),onState:()=>()=>{},getPublicState:()=>({kind:'active'}),authorizeProjectId(){},authorizeProject(){},withProjectMaterialAccess:async(_id,_purpose,work)=>work(undefined)};let actor='a';
async function call(studio,path,method='GET',body){const r=await nativeFetch(studio.origin+path,{method,headers:{'x-studio-key':studio.key,connection:'close',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,value:await r.json()};}

test('installed account A and B cannot read or change shared providers or local models',async()=>{
 const studio=await startStudio({port:0,key:'fixture-key',editorDir,advertise:false,desktopAuth:auth});
 try{
  // Services answers from the account's own store (services-store.mjs). This fixture account cannot
  // name its environment, so it has no store at all: 403, never the shared file.
  for(actor of ['a','b'])for(const [path,method,body] of [['/api/providers','GET'],['/api/providers/openai/key','PUT',{key:'fixture-change'}],['/api/local-models','GET']]){
   const response=await call(studio,path,method,body);
   assert.equal(response.status,403,'no account identity, no Services store');
   assert.equal(response.value.code,'authentication-required');
  }
  for(actor of ['a','b'])for(const operation of ['subtitles/transcribe','subtitles/translate','caption-tracks/translate','canvas-write','subtitles%2Ftranslate','canvas-write']){
   const response=await call(studio,'/api/projects/'+project.id+'/'+operation,'POST',{});
   /* The account routes are reachable now: each operation reports its own readable error instead of a
      route-level 503. What must stay closed is the shared provider/model store, asserted above. */
   assert.notEqual(response.status,503,'no route-level account-resource blanket');
   assert.notEqual(response.value.code,'account-resource-unavailable');
  }
  const local=await call(studio,'/api/projects/'+project.id+'/subtitles');assert.equal(local.status,200);
  const update=await call(studio,'/api/projects/'+project.id+'/subtitles','PUT',{style:{}});assert.equal(update.status,200);
  assert.equal(remoteFetches,0,'account startup and denied model operations must not request the network');
  assert.equal(await readFile(shared,'utf8'),original);
 }finally{await studio.close();}
});
test('without desktop authentication the original provider route remains available',async()=>{
 let asked=0;const studio=await startStudio({port:0,key:'fixture-key',editorDir,advertise:false,askAgent:async()=>{asked++;return 'fixture result';}});
 try{const response=await call(studio,'/api/providers');assert.equal(response.status,200);assert.equal(response.value.providers.find(p=>p.id==='openai').source,'file');assert.equal(await readFile(shared,'utf8'),original);const result=await call(studio,'/api/projects/'+project.id+'/canvas-write','POST',{prompt:'fixture'});assert.equal(result.status,200);assert.equal(asked,1);}
 finally{await studio.close();globalThis.fetch=nativeFetch;}
});

test('Saved left the "not yet connected" list, and is owned instead', async () => {
 const source=await readFile(new URL('./server.mjs',import.meta.url),'utf8');
 const list=/if \(\[([^\]]*)\]\.includes\(parts\[0\]\)/.exec(source);
 assert.ok(list,'the private-resource name list is still where it was');
 assert.ok(!list[1].includes("'saved'"),'saved must not be answered by the generic 503 list any more');
 assert.match(source,/savedAccess\.assertOwned\(\)/,'the library has its own ownership gate');
 const studio=await startStudio({port:0,key:'fixture-key',editorDir,advertise:false,desktopAuth:{...auth,getPublicState:()=>({kind:'active'})}});
 try{
  const response=await call(studio,'/api/saved/files');
  assert.notEqual(response.status,503,'a saved read is no longer "account services unavailable"');
  assert.equal(response.value.code,'authentication-required','a session without the library claim is refused as a session problem, not a missing route');
 }finally{await studio.close();}
});

