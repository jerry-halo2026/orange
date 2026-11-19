// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {resolveIsolationProfile,isolationEnvironment} from './development-isolation.mjs';
import {getMedia} from '../studio/client.mjs';
import {nearest} from './library-semantic.mjs';
import {libraryGet,libraryVerbs} from './library-search.mjs';

const base=process.env.ORANGE_SERVICES_TEST_ROOT;
/* 这个用例要一个**显式归属的测试根**（隔离运行时不允许落在别人的目录里）。CI 不给这个变量，
   所以这里跳过而不是失败 —— 失败信号要留给真正的问题，不该被一个缺环境变量的前置检查吃掉。 */
const missing=!(base&&resolve(base)===base);
if(!missing) await mkdir(base,{recursive:true});

test('isolated CLI uses local keywords whether Studio is absent or rejects; direct semantic calls stay offline',{skip:missing},async()=>{
 const baseRoot=await mkdtemp(join(base,'semantic-'));
 const profile=resolveIsolationProfile({baseRoot,instanceId:'fixture',taskId:'T01',attemptId:'a1',ports:{studio:19601,film:19602}},{approvedBaseRoot:baseRoot});
 const env=isolationEnvironment(profile),original={};for(const [key,value] of Object.entries(env)){original[key]=process.env[key];process.env[key]=value;}
 const previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(input,init)=>{
   const url=String(input);calls.push(url);
   if(url.endsWith('/api/health'))return new Response(JSON.stringify({product:'openfilm-studio',home:createHash('sha256').update(profile.paths.home).digest('hex'),filmOrigin:'http://localhost:19602'}));
   throw Error('unexpected remote network');
 };
 try{
   await mkdir(profile.paths.home,{recursive:true});
   const before=await readdir(baseRoot,{recursive:true});
   const take=await getMedia(['sfx-search','--take','sounds/whoosh.m4a']);assert.equal(take.code,1);
   const direct=await libraryGet('sfx-search',{take:'sounds/whoosh.m4a'});assert.equal(direct.code,1);
   assert.deepEqual(await readdir(baseRoot,{recursive:true}),before);assert.deepEqual(calls,[]);
   for(const argv of [[],['--help'],['help'],...libraryVerbs().map(({verb})=>[verb,'--help'])]) {
     const help=await getMedia(argv);const text=help.lines.join('\n');assert.equal(help.code,0);assert.match(text,/local keyword search only/i);assert.doesNotMatch(text,/--take|openfilm get music|connected service|--yes/i);
   }
   assert.equal((await getMedia(['tts','--help'])).code,1);assert.deepEqual(calls,[]);
   const none=await getMedia(['music-search','--prompt','qwzxv']);assert.match(none.lines.join('\n'),/Nothing in OpenFilm.s local library/);assert.doesNotMatch(none.lines.join('\n'),/openfilm get music/);
   const absent=await getMedia(['transition','--prompt','glitch']);assert.equal(absent.code,0);assert.match(absent.lines.join('\n'),/glitch/i);assert.match(absent.lines.join('\n'),/Taking a library item.*unavailable/);assert.doesNotMatch(absent.lines.join('\n'),/--take <id>/);assert.deepEqual(calls,[]);
   await writeFile(join(profile.paths.home,'run.json'),JSON.stringify({origin:'http://127.0.0.1:19601',filmOrigin:'http://localhost:19602',key:'fixture'}));
   let posts=0;const denied=await getMedia(['transition','--prompt','glitch'],undefined,{postLibrary:async(_run,path)=>{posts++;assert.equal(path,'/api/get/library');return {error:'unavailable'};}});assert.equal(posts,1);assert.deepEqual(denied,absent);
   assert.deepEqual(calls,['http://127.0.0.1:19601/api/health']);
   const beforeTake=await readdir(baseRoot,{recursive:true});assert.equal((await getMedia(['sfx-search','--take','sounds/whoosh.m4a'])).code,1);assert.deepEqual(await readdir(baseRoot,{recursive:true}),beforeTake);
   assert.equal(await nearest('private synthetic query','sound'),null);assert.equal(calls.length,1);
   process.env.OPENFILM_ISOLATION_PROFILE='invalid';assert.equal(await nearest('invalid isolation','sound'),null);delete process.env.OPENFILM_ISOLATION_PROFILE;assert.equal(await nearest('partial isolation','sound'),null);assert.equal(calls.length,1);
 }finally{
   globalThis.fetch=previous;for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});

/* 第二条原来断言"语义检索会去调配置的服务"—— 那是云端时代的实现。现在检索在本机做，
   `nearest` 任何情况下都不发网络请求。所以改成断言"不发"，并把 CLI 仍然成立的要求留下。 */
test('unprofiled semantic search never touches the network; CLI still demands an explicit --take',async()=>{
  const oldHome=process.env.OPENFILM_HOME;
  delete process.env.OPENFILM_ISOLATION_PROFILE; delete process.env.OPENFILM_ISOLATION_ROOT;
  process.env.OPENFILM_HOME=await mkdtemp(join(tmpdir(),'unprofiled-'));
  const previous=globalThis.fetch; let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('本机检索不该发请求');};
  try {
    const answer=await nearest('fixture unprofiled','sound');
    assert.equal(calls,0,'本机向量检索不发网络请求');
    if(answer) assert.ok(Array.isArray(answer) && answer.length>0,'有向量包就该给结果');
    assert.equal((await libraryGet('sfx-search',{take:'not-a-real-fixture'})).code,2);
    assert.match(libraryVerbs('music-search')[0].help,/--take <id>/);
    /* 本机语义检索之后，查不到词也会给"意思最近的几个"，所以这里断言的是那句提示，而不是"没有" */
    const noMatch=await libraryGet('music-search',{prompt:'qwzxv'});
    assert.equal(noMatch.code,0);
    assert.match(noMatch.lines.join(String.fromCharCode(10)),/nearest in meaning/);
    const normal=await libraryGet('transition',{prompt:'glitch'});
    assert.match(normal.lines.join(String.fromCharCode(10)),/openfilm\/transitions\//);
    assert.equal(normal.code,0);
  } finally {
    globalThis.fetch=previous;
    if(oldHome===undefined) delete process.env.OPENFILM_HOME; else process.env.OPENFILM_HOME=oldHome;
  }
});
