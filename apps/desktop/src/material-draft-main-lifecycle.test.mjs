// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createMaterialDraftStore} from './material-draft-store.mjs';

test('actual main Auth callbacks seal drafts on lock and refuse a different scope until retirement',async()=>{
  const source=await readFile(new URL('./main.mjs',import.meta.url),'utf8');
  const start=source.indexOf('    onAuth: (next, scope) => {'),end=source.indexOf('\n    onAuthRetire:',start);
  const retired=source.match(/onAuthRetired:\s*(\(\) => \{[^\n]+\}),/);
  assert.ok(start>=0&&end>start&&retired,'actual native callback boundaries exist');
  const onAuth=source.slice(start,end).trim().replace(/^onAuth:\s*/,'').replace(/,\s*$/,'');
  const setup="const materialDraftStore=store,DATA='fixture',HOME='home';"+
    "let draftSessionOpen=false,authUiGeneration=0,desktopAuthActive=false,accountStateDir=null,state={},agentRetirement=null,authRetirementConfirmed=false,studio=null,win=null;"+
    "const events=[],resumeAgentAdmission=()=>{},localAgents={resume(){}},readWindowState=()=>({tabs:[]}),openTabs=()=>{},saveState=()=>{},broadcast=(name,value)=>events.push({name,value}),showPage=()=>{},startMaterialIndexBootstrap=()=>{};";
  const build=new Function('store','join',setup+'const auth='+onAuth+';const retire='+retired[1]+';return {auth,retire,events,current:()=>({desktopAuthActive,authUiGeneration})};');
  let n=0;const store=createMaterialDraftStore({createLease:()=>('fixture-'+(++n))}),h=build(store,join),a='a'.repeat(64),b='b'.repeat(64);
  h.auth({kind:'active',reason:null},a);
  const first=store.read({generation:0});
  const item={source:'cloud',videoId:'123',title:'fixture',role:'video',group:''};
  store.change({generation:0,lease:first.lease,baseRevision:0,operation:{type:'add',item}});
  h.auth({kind:'locked',reason:'verification-unconfirmed'},null);
  assert.throws(()=>store.read({generation:0}),/inactive/);
  h.auth({kind:'active',reason:null},a);
  assert.equal(store.read({generation:0}).items.length,1,'temporary lock preserves the same account intent');
  h.auth({kind:'locked',reason:'expired'},null);
  h.auth({kind:'active',reason:null},b);
  assert.equal(h.current().desktopAuthActive,false,'a different scope cannot resume the previous session');
  assert.throws(()=>store.read({generation:0}),/inactive/);
  h.retire();
  h.auth({kind:'active',reason:null},b);
  assert.equal(h.current().authUiGeneration,1);
  assert.deepEqual(store.read({generation:1}).items,[]);
  assert.throws(()=>store.change({generation:1,lease:first.lease,baseRevision:0,operation:{type:'clear'}}),/stale-session/);
});

test('actual main exit callback removes old views before restart after retirement',async()=>{
  const source=await readFile(new URL('./main.mjs',import.meta.url),'utf8');
  const start=source.indexOf('    onExit: (code) => {'),end=source.indexOf('\n    },',start);
  assert.ok(start>=0&&end>start);
  const callback=source.slice(start,end+6).trim().replace(/^onExit:\s*/,'').replace(/,\s*$/,'');
  const setup="let quitting=false,desktopAuthActive=true,authRetirementConfirmed=true,pagePresentation={},restartWait=0,startedAt=0;"+
    "const events=[],views=new Map([['home',{}],['project',{}]]),env={};"+
    "const broadcast=()=>events.push('locked'),destroyView=id=>{events.push('destroy:'+id);views.delete(id)},runStudio=()=>{events.push('restart:'+views.size);return Promise.resolve()},sealAgentAdmission=()=>events.push('sealed'),log=()=>{},restartDelay=()=>0;";
  const h=new Function(setup+'const exit='+callback+';return {exit,events,views};')();
  h.exit(0);
  assert.deepEqual(h.events,['locked','destroy:home','destroy:project','restart:0']);
  assert.equal(h.views.size,0);
});
