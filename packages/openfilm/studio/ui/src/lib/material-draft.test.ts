// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {materialDraftKey,materialGroupFromPath,toggleMaterialDraft,localMaterialDraft,cloudMaterialDraft,materialDraftSession} from './material-draft.ts';

test('selection identity preserves source and project boundaries without using a URL as authority',()=>{
  const a={source:'local' as const,projectId:'A',path:'assets/01 Scene/a.mp4',title:'a',mediaKind:'video',role:'video' as const,group:'01 Scene'};
  const b={...a,projectId:'B'};
  const cloud={source:'cloud' as const,videoId:'123',title:'a',role:'video' as const,group:''};
  assert.notEqual(materialDraftKey(a),materialDraftKey(b));
  assert.notEqual(materialDraftKey(a),materialDraftKey(cloud));
  let draft=toggleMaterialDraft([],a);draft=toggleMaterialDraft(draft,b);draft=toggleMaterialDraft(draft,cloud);
  assert.equal(draft.length,3);
  draft=toggleMaterialDraft(draft,a);assert.deepEqual(draft,[b,cloud]);
  assert.equal(materialGroupFromPath(a.path),'01 Scene');
  assert.equal(materialGroupFromPath('assets/root.mp4'),'');
});


test('draft references reject paths outside project assets and do not accept a media URL as a cloud identity',()=>{
  assert.equal(localMaterialDraft('A','assets/file.txt','other'),null);
  assert.equal(localMaterialDraft('A','assets/../private.mp4','video'),null);
  assert.equal(localMaterialDraft('A','C:\\private.mp4','video'),null);
  assert.equal(cloudMaterialDraft('https://example.invalid/media','bad'),null);
  assert.equal(cloudMaterialDraft('123','video')?.source,'cloud');
  assert.equal(localMaterialDraft('A','assets/01 场景/a.wav','audio')?.role,'voice');
});


test('draft session preserves a temporary lock, clears on logout or account change, and ignores late old events',()=>{
  let state=materialDraftSession(null,{kind:'active',uiGeneration:0});assert.deepEqual(state,{generation:0,clear:false});
  state=materialDraftSession(state.generation,{kind:'locked',uiGeneration:0});assert.equal(state.clear,false);
  state=materialDraftSession(state.generation,{kind:'signed-out',uiGeneration:0});assert.equal(state.clear,true);
  state=materialDraftSession(state.generation,{kind:'active',uiGeneration:1});assert.equal(state.clear,true);
  state=materialDraftSession(state.generation,{kind:'signed-out',uiGeneration:0});assert.deepEqual(state,{generation:1,clear:false});
  state=materialDraftSession(state.generation,{kind:'revoked'});assert.equal(state.clear,true);
});
