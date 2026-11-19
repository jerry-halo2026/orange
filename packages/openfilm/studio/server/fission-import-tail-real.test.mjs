// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {resolveIsolationProfile,isolationEnvironment} from '../../src/development-isolation.mjs';

const baseRoot=process.env.ORANGE_FISSION_EXPORT_ROOT,sample=process.env.ORANGE_FISSION_EXPORT_PLAN;
assert.ok(baseRoot&&path.isAbsolute(baseRoot)&&sample&&path.isAbsolute(sample),'explicit isolated root and actual worker sidecar are required');
const profile=resolveIsolationProfile({baseRoot,instanceId:'tail',taskId:'T_FISSION',attemptId:'a-'+Date.now()+'-'+process.pid,ports:{studio:19911,film:19912}},{approvedBaseRoot:baseRoot});for(const dir of Object.values(profile.paths))await mkdir(dir,{recursive:true});Object.assign(process.env,isolationEnvironment(profile));
const {importFissionEditPlan}=await import('./fission-import.mjs');
const {readProjectFilm}=await import('./film.mjs');
const {listProjects}=await import('./projects.mjs');

test('actual worker packet tail is represented in editable tracks without claiming equivalence',async()=>{
 const stage=path.join(profile.paths.cache,'selected');await mkdir(stage);const plan=JSON.parse(await readFile(sample,'utf8'));
 assert.equal(plan.alignment.action,'trim');assert.ok(plan.durationSec>plan.alignment.outputDurationSec+1/plan.fps,'the actual worker output has a packet tail exceeding one frame');assert.ok(plan.durationSec<=plan.alignment.outputDurationSec+plan.transitions.tailPaddingSec+1/plan.fps);
 for(let i=0;i<plan.sources.length;i++){const source=plan.sources[i],target=path.join(stage,'source-'+i+path.extname(source.path));await copyFile(source.path,target);assert.equal(createHash('sha256').update(await readFile(target)).digest('hex'),source.sha256);source.path=target;}
 const options={sourceRoots:[stage],approvedBaseRoot:baseRoot,internalDraft:true,nativeAudioProfile:'fission-v1',ffprobePath:process.env.ORANGE_FISSION_FFPROBE};
 await assert.rejects(importFissionEditPlan(JSON.stringify(plan),{...options,ffprobePath:undefined}),{code:'FISSION_IMPORT_INVALID'});
 assert.equal((await listProjects()).length,0,'missing trusted probe cannot create a project');
 const made=await importFissionEditPlan(JSON.stringify(plan),options),film=await readProjectFilm(made.project.path);
 assert.equal(film.problems.length,0);assert.ok(made.blockingCapabilities.includes('fission-trim-tail-equivalence-unverified'));assert.equal(made.equivalenceVerified,false);
 const videos=film.value.tracks.flatMap(t=>t.clips??[]).filter(c=>c.src.endsWith('.mp4'));assert.ok(videos.length);const end=Math.max(...videos.map(video=>(video.at??0)+(video.time[1]-video.time[0])/(video.speed??1)));
 assert.ok(end<=plan.durationSec+.001&&plan.durationSec-end<=1/plan.fps+.001,'native clip stays within one video frame of the actual output');
 if(plan.durationSec-end>.001)assert.ok(made.blockingCapabilities.includes('fission-video-stream-tail-truncated'),'a shortened native stream is explicit');
 const count=(await listProjects()).length;
 for(const change of [p=>{p.durationSec=p.alignment.outputDurationSec+p.transitions.tailPaddingSec+2/p.fps;},p=>{p.transitions.tailPaddingSec=5;p.durationSec=p.alignment.outputDurationSec+2/p.fps;},p=>{p.alignment.inputDurationSec=p.alignment.outputDurationSec;p.durationSec=p.alignment.outputDurationSec+2/p.fps;},p=>{for(const visual of p.visuals)visual.durationSec=0.001; }]){
  const invalid=structuredClone(plan);change(invalid);await assert.rejects(importFissionEditPlan(JSON.stringify(invalid),options),{code:'FISSION_IMPORT_INVALID'});assert.equal((await listProjects()).length,count);
 }
 const oneFrame=structuredClone(plan);oneFrame.durationSec=oneFrame.alignment.outputDurationSec+1/oneFrame.fps;const boundary=await importFissionEditPlan(JSON.stringify(oneFrame),options);assert.equal(boundary.blockingCapabilities.includes('fission-trim-tail-equivalence-unverified'),false);assert.equal((await listProjects()).length,count+1);
 const first=plan.visuals.find(v=>plan.sources[v.source]?.kind==='video');
 const probed=JSON.parse(execFileSync(process.env.ORANGE_FISSION_FFPROBE,['-v','error','-select_streams','v:0','-show_entries','stream=duration,duration_ts,time_base','-of','json',plan.sources[first.source].path],{encoding:'utf8',windowsHide:true})).streams[0];
 const fraction=/^(\d+)\/(\d+)$/.exec(probed.time_base??''),streamDuration=fraction&&Number.isSafeInteger(Number(probed.duration_ts))?Number(probed.duration_ts)*Number(fraction[1])/Number(fraction[2]):Number(probed.duration);
 const excess=plan.durationSec-streamDuration;
 if(first.speed===1&&plan.fps===30&&excess>1/plan.fps&&excess<1/plan.fps+.0005){
  assert.ok(made.blockingCapabilities.includes('fission-video-stream-tail-truncated'),'rounded one-frame stream tail remains disclosed');
  const tooLong=structuredClone(plan);tooLong.durationSec=streamDuration+1/plan.fps+.002;
  assert.ok(tooLong.durationSec<=tooLong.alignment.outputDurationSec+tooLong.transitions.tailPaddingSec+1/tooLong.fps,'negative case reaches actual stream bound');
  await assert.rejects(importFissionEditPlan(JSON.stringify(tooLong),options),{code:'FISSION_IMPORT_INVALID'});assert.equal((await listProjects()).length,count+1);
 }
});
