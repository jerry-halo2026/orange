// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaterialDraftStore} from './material-draft-store.mjs';

const local={source:'local',projectId:'native-id',path:'assets/01 scene/a.mp4',title:'a.mp4',mediaKind:'video',role:'video',group:'01 scene'};
const cloud={source:'cloud',videoId:'123',title:'cloud fixture',role:'video',group:''};
const key=item=>JSON.stringify(item.source==='local'?['local',item.projectId,item.path]:['cloud',item.videoId]);
const fixture=()=>{let n=0;return createMaterialDraftStore({createLease:()=>('fixture-lease-'+(++n))});};

test('account retirement destroys the old lease and draft, temporary lock preserves it',()=>{
  const s=fixture();s.startSession(0,'a'.repeat(64));const a=s.read({generation:0});
  assert.equal(s.change({generation:0,lease:a.lease,baseRevision:a.revision,operation:{type:'add',item:local}}).items.length,1);
  s.lock();assert.throws(()=>s.read(),/inactive/);assert.throws(()=>s.resume(0,'b'.repeat(64)),/inactive/);s.resume(0,'a'.repeat(64));assert.equal(s.read({generation:0}).items.length,1);
  s.retire();assert.throws(()=>s.startSession(0,'a'.repeat(64)),/stale-session/);s.startSession(1,'b'.repeat(64));assert.throws(()=>s.read({generation:0}),/stale-session/);const b=s.read({generation:1});assert.equal(b.items.length,0);assert.notEqual(b.lease,a.lease);
  assert.throws(()=>s.change({generation:1,lease:a.lease,baseRevision:0,operation:{type:'add',item:cloud}}),/stale-session/);
  assert.deepEqual(s.read({generation:1}).items,[]);
});
test('concurrent tabs cannot silently overwrite one another and can update explicit role/group',()=>{
  const s=fixture();s.startSession(0,'a'.repeat(64));const a=s.read({generation:0}),b=s.read({generation:0});
  const one=s.change({generation:0,lease:a.lease,baseRevision:a.revision,operation:{type:'add',item:local}});
  assert.deepEqual(s.change({generation:0,lease:b.lease,baseRevision:b.revision,operation:{type:'add',item:cloud}}),{code:'revision-conflict'});
  const two=s.change({generation:0,lease:one.lease,baseRevision:one.revision,operation:{type:'setGroup',key:key(local),group:'02'}});
  const three=s.change({generation:0,lease:two.lease,baseRevision:two.revision,operation:{type:'setRole',key:key(local),role:'intro'}});
  assert.equal(three.items[0].group,'02');assert.equal(three.items[0].role,'intro');
  assert.equal(s.change({generation:0,lease:three.lease,baseRevision:three.revision,operation:{type:'remove',key:key(local)}}).items.length,0);
});
test('draft validation rejects arbitrary URLs, absolute or traversal paths and extra fields',()=>{
  const s=fixture();s.startSession(0,'a'.repeat(64));const a=s.read({generation:0});
  for(const item of [{...local,path:'assets/../secret'}, {...local,path:'D:\\private.mp4'}, {...cloud,videoId:'https://example.invalid/a'}, {...cloud,token:'never'}])
    assert.throws(()=>s.change({generation:0,lease:a.lease,baseRevision:0,operation:{type:'add',item}}),/invalid-draft/);
  assert.deepEqual(s.read({generation:0}).items,[]);
});
