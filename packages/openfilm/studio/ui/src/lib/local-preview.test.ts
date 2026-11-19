// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {projectVideoPreviewUrl,createPreviewController,previewKeyIntent,previewMustStopForAuth,createPreviewAttestation} from './local-preview.ts';

test('local preview accepts only an original localhost film-origin and project-relative assets',()=>{
  assert.equal(projectVideoPreviewUrl('http://localhost:19182/p/token/','assets/01 场景/a b.mp4'),'http://localhost:19182/p/token/assets/01%20%E5%9C%BA%E6%99%AF/a%20b.mp4');
  for(const folder of ['https://external.invalid/p/token/','http://127.0.0.1:19182/p/token/','http://localhost:19182/other/','http://localhost:19182/p/token/?key=x'])
    assert.equal(projectVideoPreviewUrl(folder,'assets/a.mp4'),null);
  for(const path of ['../private.mp4','assets/../private.mp4','C:\\private.mp4','https://example.invalid/a.mp4'])
    assert.equal(projectVideoPreviewUrl('http://localhost:19182/p/token/',path),null);
});
test('preview mutes on start, stops and rewinds on exit; late aborted playback is not reported as failure',async()=>{
  let rejectPlay,failures=0,pauses=0;
  const media={muted:false,currentTime:4,paused:true,play:()=>new Promise((_,reject)=>{rejectPlay=reject;}),pause:()=>{pauses++;}};
  const controller=createPreviewController(()=>media,()=>failures++);
  const started=controller.start();assert.equal(media.muted,true);
  controller.stop();assert.equal(pauses,1);assert.equal(media.currentTime,0);
  rejectPlay(new Error('interrupted'));await started;assert.equal(failures,0);
});
test('a current playback failure is reported without exposing its URL',async()=>{
  let failures=0;const media={muted:false,currentTime:0,paused:true,play:async()=>{throw Error('private detail')},pause(){}};
  const controller=createPreviewController(()=>media,()=>failures++);
  await controller.start();assert.equal(failures,1);
});


test('keyboard preview and every non-active auth state have explicit stop behavior',()=>{
  assert.equal(previewKeyIntent('Enter'),'toggle');assert.equal(previewKeyIntent(' '),'toggle');
  assert.equal(previewKeyIntent('Escape'),'stop');assert.equal(previewKeyIntent('Tab'),null);
  for(const kind of ['signed-out','locked','revoked','expired'])assert.equal(previewMustStopForAuth(kind),true);
  assert.equal(previewMustStopForAuth('active'),false);
});


test('changing project, logout or revocation cancels a delayed preview proof',async()=>{
  for(const cause of ['project-change','signed-out','revoked']){
    let resolveProof;const pending=new Promise(resolve=>{resolveProof=resolve});
    const guard=createPreviewAttestation(()=>pending,4),result=guard.authorize();
    guard.cancel();resolveProof({active:true,uiGeneration:4});
    assert.equal(await result,'cancelled',cause);
  }
});
test('preview attestation refuses inactive or mismatched account and allows only current generation',async()=>{
  assert.equal(await createPreviewAttestation(async()=>({active:false,uiGeneration:4}),4).authorize(),'denied');
  assert.equal(await createPreviewAttestation(async()=>({active:true,uiGeneration:5}),4).authorize(),'denied');
  assert.equal(await createPreviewAttestation(async()=>({active:true,uiGeneration:4}),4).authorize(),'allowed');
  assert.equal(await createPreviewAttestation(async()=>{throw Error('private')},4).authorize(),'denied');
});
