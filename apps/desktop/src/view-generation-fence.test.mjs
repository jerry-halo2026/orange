// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewGenerationFence} from './view-generation-fence.mjs';
import {createMaterialDraftStore} from './material-draft-store.mjs';
import {createMaterialDraftBridge} from './material-draft-ipc.mjs';

test('a retained old HOME sender cannot guess the new generation or receive its draft event',()=>{
  const oldHome={},newHome={},fence=createViewGenerationFence();let generation=0,active=true,n=0;
  fence.register(oldHome,0);
  assert.throws(()=>fence.register(oldHome,1),/view-generation-rebind-denied/);
  const store=createMaterialDraftStore({createLease:()=>('fixture-'+(++n))});
  const recipients=[],bridge=createMaterialDraftBridge({store,isAllowed:sender=>active&&fence.isCurrent(sender,generation),generation:()=>generation,broadcast:value=>{for(const sender of [oldHome,newHome])if(fence.isCurrent(sender,generation))recipients.push({sender,value});}});
  store.startSession(0,'a'.repeat(64));
  const old=bridge.read(oldHome,{generation:0});
  store.lock();store.retire();generation=1;store.startSession(1,'b'.repeat(64));fence.register(newHome,1);
  assert.throws(()=>bridge.read(oldHome,{generation:1}),/authentication-required/);
  assert.throws(()=>bridge.change(oldHome,{generation:1,lease:old.lease,baseRevision:0,operation:{type:'clear'}}),/authentication-required/);
  const fresh=bridge.read(newHome,{generation:1});
  bridge.change(newHome,{generation:1,lease:fresh.lease,baseRevision:0,operation:{type:'add',item:{source:'cloud',videoId:'123',title:'fixture',role:'video',group:''}}});
  assert.equal(recipients.length,1);assert.equal(recipients[0].sender,newHome);assert.equal('lease' in recipients[0].value,false);
});
