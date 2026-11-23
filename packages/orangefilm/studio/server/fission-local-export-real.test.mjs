// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {resolveIsolationProfile,isolationEnvironment} from '../../src/development-isolation.mjs';

const baseRoot=process.env.ORANGE_FISSION_EXPORT_ROOT,sample=process.env.ORANGE_FISSION_EXPORT_PLAN,browser=process.env.ORANGE_FISSION_EXISTING_BROWSER;
assert.ok(baseRoot&&path.isAbsolute(baseRoot)&&sample&&path.isAbsolute(sample)&&browser&&path.isAbsolute(browser),'explicit isolated root, actual sidecar and existing browser are required');
const profile=resolveIsolationProfile({baseRoot,instanceId:'export',taskId:'T_FISSION',attemptId:'a-'+Date.now()+'-'+process.pid,ports:{studio:19901,film:19902}},{approvedBaseRoot:baseRoot});
for(const dir of [...Object.values(profile.paths),path.join(profile.paths.userData,'appdata'),path.join(profile.paths.cache,'appdata'),path.join(profile.paths.cache,'browsers'),path.join(profile.paths.temp,'trash')])await mkdir(dir,{recursive:true});
await cp(browser,path.join(profile.paths.cache,'browsers',path.basename(browser)),{recursive:true,errorOnExist:true,force:false});Object.assign(process.env,isolationEnvironment(profile));
const {importFissionEditPlan}=await import('./fission-import.mjs');
const {createExports}=await import('./exports.mjs');
const {readProjectFilm}=await import('./film.mjs');
const exec=promisify(execFile);

test('actual Fission sidecar becomes a Studio video export with audio', {timeout:180000},async()=>{
 const stage=path.join(profile.paths.cache,'selected');await mkdir(stage);const plan=JSON.parse(await readFile(sample,'utf8'));
 for(let i=0;i<plan.sources.length;i++){
  const source=plan.sources[i],target=path.join(stage,'source-'+i+path.extname(source.path));await copyFile(source.path,target);
  assert.equal(createHash('sha256').update(await readFile(target)).digest('hex'),source.sha256);source.path=target;
 }
 if(plan.transitions.shader){const item=plan.transitions.shader,target=path.join(stage,'transition'+path.extname(item.path));await copyFile(item.path,target);item.path=target;}
 const made=await importFissionEditPlan(JSON.stringify(plan),{sourceRoots:[stage],approvedBaseRoot:baseRoot,internalDraft:true,nativeAudioProfile:'fission-v1',ffprobePath:process.env.ORANGE_FISSION_FFPROBE});
 assert.equal(made.equivalenceVerified,false);const film=await readProjectFilm(made.project.path);assert.equal(film.problems.length,0);assert.ok(film.value.tracks.length>=2);
 let finish;const finished=new Promise(resolve=>{finish=resolve;});
 const exports=createExports({onChange:job=>{if(job.status==='done'||job.status==='failed'||job.status==='cancelled')finish(job);}});let timer;
 try{
  exports.start(made.project,{kind:'video',codec:'h264',shortEdge:720,hardware:false,fps:30},{folder:profile.paths.exports});
  const job=await Promise.race([finished,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Studio export timed out')),160000);timer.unref();})]);
  assert.equal(job.status,'done',JSON.stringify({status:job.status,error:job.error}));assert.equal(job.outputs.length,1);
  const {stdout}=await exec('ffprobe',['-v','error','-show_entries','stream=codec_type,width,height','-of','json',job.outputs[0]],{windowsHide:true});const info=JSON.parse(stdout),video=info.streams.find(s=>s.codec_type==='video');
  assert.ok(video&&Math.min(video.width,video.height)===720,'actual output is 720p');assert.ok(info.streams.some(s=>s.codec_type==='audio'),'actual output includes audio');
 }finally{clearTimeout(timer);await exports.stopAll();}
});
