import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { resolveIsolationProfile, isolationEnvironment } from '../../src/development-isolation.mjs';
import { createDesktopAuth } from '../../../../apps/desktop/src/desktop-auth.mjs';

const baseRoot=resolve(process.env.ORANGE_LOGIN_TEST_ROOT,'native-profile');
const profile=resolveIsolationProfile({baseRoot,instanceId:'desktop-login',taskId:'T03_LOGIN',attemptId:'a-'+Date.now()+'-'+process.pid,ports:{studio:18485,film:18486}},{approvedBaseRoot:baseRoot});
for(const path of Object.values(profile.paths))await mkdir(path,{recursive:true});
Object.assign(process.env,isolationEnvironment(profile));
const {startStudio}=await import('./server.mjs');
const {createProjectControlGuard}=await import('./project-control-guard.mjs');
const {withProjectControlGuard,createProject,listProjects}=await import('./projects.mjs');
const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const configuration={environmentId:'test-native',authOrigin:'https://auth.invalid',publishableKey:'public-fixture'};
const guard=createProjectControlGuard({coordinationRoot:join(profile.root,'ordinary-coord')});
const unknown=await withProjectControlGuard(guard,()=>createProject('Unknown historical native'));
let subject=A,now=10;
const transport=async url=>url.includes('/token?')?Response.json({access_token:'synthetic',refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:60,user:{id:subject}}):url.endsWith('/auth/v1/user')?Response.json({id:subject,is_anonymous:false}):new Response(null,{status:204});
let retirementCount=0;
const auth=createDesktopAuth({configuration,home:profile.paths.home,sharedHome:profile.paths.sharedHome,projects:profile.paths.projects,coordinationRoot:join(profile.root,'auth-coord'),instanceId:'native-instance'},{fetch:transport,monotonicNow:()=>now,retire:async()=>{retirementCount++;},onState:()=>{}});
const editorDir=join(profile.root,'editor');await mkdir(editorDir);await writeFile(join(editorDir,'index.html'),'<html>native login shell fixture</html>');
const options={port:18485,key:'synthetic-local-launch-key',isolation:true,advertise:false,editorDir,desktopAuth:auth,openBrowser:()=>assert.fail('no browser in author fixture')};
async function call(studio,path,method='GET',body,origin=studio.origin){
 const response=await fetch(studio.origin+path,{method,headers:{'x-studio-key':studio.key,origin,connection:'close',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(4000)});
 const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:response.status,value};
}
async function wsDenied(studio){
 return new Promise((resolve,reject)=>{
  const socket=connect({host:'127.0.0.1',port:18485});let text='';const timer=setTimeout(()=>socket.destroy(Error('WS fixture deadline')),4000);
  socket.on('connect',()=>socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:18485\r\nOrigin: ${studio.origin}\r\nx-studio-key: ${studio.key}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: c3ludGhldGljLXRlc3Q=\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  socket.on('data',bytes=>text+=bytes);socket.on('error',reject);socket.on('close',()=>{clearTimeout(timer);resolve(text);});
 });
}

test('original Studio enforces desktop login across native HTTP WS film and CLI, then original create/edit round trip stays owned',async()=>{
 let studio;
 try{
  studio=await withProjectControlGuard(guard,()=>startStudio(options));
  const pre=await call(studio,'/api/projects');assert.equal(pre.status,403,'a launch key is not first-party login');
  assert.match(await wsDenied(studio),/^HTTP\/1\.1 403/);
  const preFilm=await fetch(studio.filmOrigin+'/p/unknown/film.html');assert.equal(preFilm.status,403);await preFilm.text();
  assert.equal((await call(studio,'/api/auth/state')).value.kind,'signed-out');
  assert.equal((await call(studio,'/api/auth/sign-in','POST',{email:'x@example.invalid',password:'synthetic'},'https://foreign.invalid')).status,403);
  assert.equal((await call(studio,'/api/auth/sign-in','POST',{email:'x@example.invalid',password:'synthetic'})).value.ok,true);
  assert.deepEqual((await call(studio,'/api/projects')).value.projects,[],'unknown history is not claimed');
  assert.equal((await call(studio,`/api/projects/${unknown.id}`)).status,403);
  const created=await call(studio,'/api/projects','POST',{name:'Owned original'});assert.equal(created.status,200);
  const project=created.value.project;assert.ok(project.id);assert.ok(project.path.startsWith(profile.paths.projects));
  const historicalId=await readFile(join(unknown.path,'.film','id'),'utf8');
  assert.equal((await call(studio,`/api/projects/${project.id}/locate`,'POST',{path:unknown.path})).status,403,'locate cannot silently claim or overwrite unknown history');
  assert.equal(await readFile(join(unknown.path,'.film','id'),'utf8'),historicalId);
  assert.equal((await call(studio,'/api/kept?folder='+encodeURIComponent(unknown.path))).status,503,'unmapped path-based shared state is explicitly unavailable');
  const initial=await call(studio,`/api/projects/${project.id}`);assert.equal(initial.status,200);assert.equal(typeof initial.value.rev,'string');
  const edit=await call(studio,`/api/projects/${project.id}/edit`,'POST',{base:initial.value.rev,ops:[{op:'stage',w:720,h:1280}]});
  assert.equal(edit.status,200);
  const reopen=await call(studio,`/api/projects/${project.id}`);assert.equal(reopen.value.value.stage.w,720);assert.equal(reopen.value.value.stage.h,1280);
  await assert.rejects(withProjectControlGuard(guard,()=>listProjects()),error=>error.code==='control-required'||error.code==='control-busy','separate native CLI context cannot use a controlled HOME');
  const filmAddress=initial.value.folder+'film.html';const film=await fetch(filmAddress);assert.equal(film.status,200);await film.text();
  const logout=await call(studio,'/api/auth/sign-out','POST',{});assert.equal(logout.status,200);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await call(studio,`/api/projects/${project.id}`)).status,403);
  const lockedFilm=await fetch(filmAddress);assert.equal(lockedFilm.status,403);await lockedFilm.text();
  assert.match(await wsDenied(studio),/^HTTP\/1\.1 403/);
  assert.ok((await readFile(join(project.path,'film.html'),'utf8')).includes('720'));
  subject=B;assert.equal((await call(studio,'/api/auth/sign-in','POST',{email:'b@example.invalid',password:'synthetic'})).value.ok,true);
  assert.deepEqual((await call(studio,'/api/projects')).value.projects,[]);
  assert.equal((await call(studio,`/api/projects/${project.id}`)).status,403);
  assert.equal(retirementCount,1);
 }finally{await studio?.close();await auth.dispose();}
});

test('original logout HTTP completes its own admission before real Studio.close retirement, without a request-close cycle',async()=>{
 let studio,retired=false,resolveRetired;
 const actualRetired=new Promise(resolve=>resolveRetired=resolve);
 const controller=createDesktopAuth({configuration,home:profile.paths.home,sharedHome:profile.paths.sharedHome,projects:profile.paths.projects,coordinationRoot:join(profile.root,'close-coord'),instanceId:'close-instance'},{
  fetch:transport,monotonicNow:()=>now,onState:()=>{},retire:async()=>{await studio.close();retired=true;resolveRetired();},
 });
 let timer;
 try{
  studio=await startStudio({...options,desktopAuth:controller});
  assert.equal((await call(studio,'/api/auth/sign-in','POST',{email:'x@example.invalid',password:'synthetic'})).value.ok,true);
  // Closing may retire the response socket; the critical proof is actual native close,
  // not whether this client received the entire pending acknowledgement.
  const response=call(studio,'/api/auth/sign-out','POST',{}).catch(()=>null);
  await Promise.race([actualRetired,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('logout route and actual close formed a cycle')),4000);})]);
  assert.equal(retired,true);await response;
 }finally{clearTimeout(timer);await studio?.close();await controller.dispose();}
});
