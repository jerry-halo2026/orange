// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaterialDraftStore} from './material-draft-store.mjs';
import {createMaterialDraftBridge} from './material-draft-ipc.mjs';

test('only a current active window and generation can read or change the shared intent',()=>{
  let serial=0,active=true,generation=0;
  const store=createMaterialDraftStore({createLease:()=>('fixture-'+(++serial))}),events=[];
  const bridge=createMaterialDraftBridge({store,isAllowed:event=>active&&event==='current',generation:()=>generation,broadcast:value=>events.push(value)});
  store.startSession(0,'a'.repeat(64));
  assert.throws(()=>bridge.read('other',{generation:0}),/authentication-required/);
  const a=bridge.read('current',{generation:0});
  const item={source:'local',projectId:'p',path:'assets/a.mp4',title:'a.mp4',mediaKind:'video',role:'video',group:''};
  const changed=bridge.change('current',{generation:0,lease:a.lease,baseRevision:0,operation:{type:'add',item}});
  assert.equal(changed.items.length,1);assert.equal(events.length,1);assert.equal(events[0].generation,0);assert.equal('lease' in events[0],false);
  assert.deepEqual(bridge.change('current',{generation:0,lease:a.lease,baseRevision:0,operation:{type:'clear'}}),{code:'revision-conflict'});
  assert.equal(events.length,1);
  active=false;store.lock();assert.throws(()=>bridge.read('current',{generation:0}),/authentication-required/);
  store.retire();generation=1;store.startSession(1,'b'.repeat(64));active=true;
  assert.throws(()=>bridge.read('current',{generation:0}),/authentication-required/);
  assert.throws(()=>bridge.change('current',{generation:1,lease:a.lease,baseRevision:0,operation:{type:'clear'}}),/stale-session/);
  assert.deepEqual(bridge.read('current',{generation:1}).items,[]);
});

test('broadcast failure cannot hide the committed revision or let another tab overwrite it',()=>{
  const store=createMaterialDraftStore({createLease:()=> 'fixture-lease'});store.startSession(0,'a'.repeat(64));
  const bridge=createMaterialDraftBridge({store,isAllowed:()=>true,generation:()=>0,broadcast:()=>{throw Error('synthetic disconnected window')}});
  const first=bridge.read('tab-A',{generation:0}),second=bridge.read('tab-B',{generation:0});
  const item={source:'cloud',videoId:'123',title:'fixture',role:'video',group:''};
  const saved=bridge.change('tab-A',{generation:0,lease:first.lease,baseRevision:first.revision,operation:{type:'add',item}});
  assert.equal(saved.revision,1);
  assert.deepEqual(bridge.change('tab-B',{generation:0,lease:second.lease,baseRevision:second.revision,operation:{type:'clear'}}),{code:'revision-conflict'});
  assert.equal(bridge.read('tab-B',{generation:0}).items.length,1);
});
