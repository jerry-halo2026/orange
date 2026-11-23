// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startMaterialsService, type Logger} from './main.ts';
import {SUPPLIER_ORIGIN} from './credentials.ts';
import {INTERNAL_SECRET_HEADER} from './server.ts';
import {signRequest, PRINCIPAL_HEADER, SIGNATURE_HEADER} from './session.ts';
import {discardStaged} from './raw.ts';

const SECRET='fixture-internal-secret-0123456789abcdef';
const SUBJECT='11111111-1111-4111-8111-111111111111';
const INSTANCE='22222222-2222-4222-8222-222222222222';
const SELF='fixture-self-account-key',FOREIGN='fixture-foreign-account-key',COMPANY='fixture-company-account-key';
const CDN='cdn.fixture.test';
const VIDEO='v-1';

function recording(){
  const lines:string[]=[];
  const logger:Logger={info:(line)=>{lines.push(line);},error:(line)=>{lines.push(line);}};
  return {logger,lines,text:()=>lines.join('\n')};
}

async function scratch(){
  const root=await mkdtemp(join(tmpdir(),'orange-raw-'));
  const directory=join(root,'.dev','zhishang');
  const staging=join(root,'staging');
  await mkdir(directory,{recursive:true});
  await mkdir(staging,{recursive:true});
  const credentials=join(directory,'credentials.local.json');
  await writeFile(credentials,JSON.stringify({environmentId:'fixture-env',companyKey:'fixture_company_key',companySecret:'fixture_company_secret',origin:SUPPLIER_ORIGIN}),'utf8');
  const bindings=join(directory,'bindings.local.json');
  await writeFile(bindings,JSON.stringify({version:1,bindings:{[SUBJECT]:{selfAccountKey:SELF,grantedAccountKeys:[]}}}),'utf8');
  return {
    root,staging,
    env:(overrides:Record<string,string|undefined>={})=>({MATERIALS_PORT:'0',MATERIALS_SECRET:SECRET,MATERIALS_CREDENTIALS:credentials,MATERIALS_BINDINGS:bindings,MATERIALS_STAGING:staging,MATERIALS_RAW_HOSTS:CDN,...overrides}),
    cleanup:()=>rm(root,{recursive:true,force:true}),
  };
}

/** A supplier + CDN stand-in. Records every supplier path and every CDN hit. */
function stub(options:{author?:string;rawUrl?:string;content?:Uint8Array;videoType?:number;row?:Record<string,unknown>}={}){
  const type=options.videoType??1;
  const original=globalThis.fetch;
  const supplier:string[]=[],cdn:string[]=[],sentBody:{path:string;accountKey:string|null;body:unknown}[]=[];
  const content=options.content??new TextEncoder().encode('fixture-video-bytes');
  globalThis.fetch=(async (input:unknown,...rest:unknown[])=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:String((input as {url?:unknown}).url??'');
    if(url.startsWith(SUPPLIER_ORIGIN)){
      const path=new URL(url).pathname;
      supplier.push(path);
      sentBody.push({path,accountKey:new Headers((rest[0] as RequestInit|undefined)?.headers as HeadersInit|undefined).get('account_key'),body:(rest[0] as RequestInit|undefined)?.body?JSON.parse(String((rest[0] as RequestInit).body)):null});
      if(path==='/openapi/auth/access_token')return Response.json({success:true,code:1,data:{accessToken:'fixture-supplier-token'}});
      // The stub honours the supplier's ideoType filter: a video is only listed in its own type.
      if(path==='/openapi/video/list'){const asked=Number((rest[0] as RequestInit|undefined)?.body?JSON.parse(String((rest[0] as RequestInit).body)).videoType:1);return Response.json({success:true,code:1,data:{list:asked===type?[options.row??{videoId:VIDEO,accountKey:options.author??SELF}]:[],total:asked===type?1:0}});}
      if(path==='/openapi/video/query/raw')return Response.json({success:true,code:1,data:{rawUrl:options.rawUrl??`https://${CDN}/videos/clip.mp4`}});
      return Response.json({success:false,code:501});
    }
    if(url.startsWith('https://'+CDN)){cdn.push(url);return new Response(Buffer.from(content) as unknown as BodyInit,{status:200});}
    return (original as (...args:unknown[])=>Promise<Response>)(input,...rest);
  }) as typeof fetch;
  return {supplier,cdn,sentBody,restore:()=>{globalThis.fetch=original;},rawCalls:()=>supplier.filter(path=>path==='/openapi/video/query/raw').length};
}

function headers(options:{secret?:string;subject?:string;query?:string;path?:string;method?:string}={}){
  const body=Buffer.from(JSON.stringify({environmentId:'fixture-env',subjectId:options.subject??SUBJECT,instanceId:INSTANCE,epoch:1,exp:Math.floor(Date.now()/1000)+600}),'utf8').toString('base64url');
  const line={principal:body,method:options.method??'POST',path:options.path??'/api/materials/raw',query:options.query??''};
  return {[INTERNAL_SECRET_HEADER]:options.secret??SECRET,[PRINCIPAL_HEADER]:body,[SIGNATURE_HEADER]:signRequest(options.secret??SECRET,line)};
}

async function running(options:{author?:string;rawUrl?:string;content?:Uint8Array;videoType?:number;row?:Record<string,unknown>;env?:Record<string,string|undefined>}={}){
  const s=await scratch();
  const supplier=stub(options);
  const recorder=recording();
  const started=await startMaterialsService({env:s.env({...options.env,MATERIALS_RAW_HOSTS:options.env?.MATERIALS_RAW_HOSTS??CDN}),logger:recorder.logger});
  assert.equal(started.ok,true,started.ok?'':JSON.stringify((started as {refusal?:unknown}).refusal));
  if(!started.ok)throw new Error('service did not start');
  return {
    s,supplier,recorder,
    base:'http://127.0.0.1:'+started.service.port,
    close:async()=>{await started.service.close();supplier.restore();await s.cleanup();},
  };
}

const post=(context:{base:string},body:unknown,headerSet:Record<string,string>)=>fetch(context.base+'/api/materials/raw',{method:'POST',headers:{'content-type':'application/json',...headerSet},body:JSON.stringify(body)});

test('the raw route is POST only, and unknown paths stay 404',async()=>{
  const h=await running();
  try{
    const get=await fetch(h.base+'/api/materials/raw',{headers:headers()});
    assert.equal(get.status,405);
    assert.equal((await get.json() as {code:string}).code,'method-not-allowed');

    for(const path of ['/api/materials/raws','/api/materials/query/raw','/api/materials/raw/1']){
      const response=await fetch(h.base+path,{method:'POST',headers:{'content-type':'application/json',...headers({path})},body:'{"videoId":"v-1"}'});
      assert.equal(response.status,404,path);
    }
    assert.equal(h.supplier.supplier.length,0);
  }finally{await h.close();}
});

test('negative: every malformed body is 422 before any supplier work',async()=>{
  const h=await running();
  try{
    for(const [label,body] of [
      ['empty object',{}],
      ['missing videoId',{clip:'v-1'}],
      ['extra key',{videoId:VIDEO,extra:1}],
      ['empty string',{videoId:''}],
      ['too long',{videoId:'x'.repeat(65)}],
      ['not a string',{videoId:1}],
      ['array',[VIDEO]],
    ] as const){
      const response=await post(h,body,headers());
      assert.equal(response.status,422,label);
      assert.equal((await response.json() as {code:string}).code,'invalid-query',label);
    }
    const noJson=await fetch(h.base+'/api/materials/raw',{method:'POST',headers:{'content-type':'text/plain',...headers()},body:'videoId=v-1'});
    assert.equal(noJson.status,422);
    assert.equal(h.supplier.supplier.length,0,'no body got as far as the supplier');
  }finally{await h.close();}
});

test('negative: without the hop secret or a signed principal nothing reaches the supplier',async()=>{
  const h=await running();
  try{
    const noSecret=await post(h,{videoId:VIDEO},{});
    assert.equal(noSecret.status,403);
    assert.equal((await noSecret.json() as {code:string}).code,'internal-auth-required');

    const noSignature=await post(h,{videoId:VIDEO},{[INTERNAL_SECRET_HEADER]:SECRET});
    assert.equal(noSignature.status,403);
    assert.equal((await noSignature.json() as {code:string}).code,'authentication-required');

    const badSignature=await post(h,{videoId:VIDEO},{...headers({query:'x'})});
    assert.equal(badSignature.status,403);
    assert.equal(h.supplier.supplier.length,0);
  }finally{await h.close();}
});

test('negative: an author outside the binding is refused with no raw call',async()=>{
  const h=await running({author:FOREIGN});
  try{
    const response=await post(h,{videoId:VIDEO},headers());
    assert.equal(response.status,403);
    assert.equal((await response.json() as {code:string}).code,'authorization-denied');
    assert.equal(h.supplier.rawCalls(),0,'query/raw was never called');
    assert.deepEqual(h.supplier.supplier,['/openapi/auth/access_token','/openapi/video/list'],'only the author lookup happened');
  }finally{await h.close();}
});

test('a visible video downloads exactly once, into staging, with a matching sha256',async()=>{
  const content=new TextEncoder().encode('fixture-video-bytes-0123456789');
  const h=await running({content});
  try{
    const response=await post(h,{videoId:VIDEO},headers());
    assert.equal(response.status,200);
    const body=await response.json() as {path:string;bytes:number;sha256:string;name:string};
    assert.equal(h.supplier.rawCalls(),1,'query/raw exactly once');
    assert.equal(h.supplier.cdn.length,1);

    const info=await stat(body.path);
    assert.equal(info.size,body.bytes);
    assert.equal(body.bytes,content.byteLength);
    assert.match(body.name,/^raw-[a-f0-9]{32}-[a-f0-9]{6}\.mp4$/,'hash prefix for traceability plus a unique suffix');
    assert.equal(join(h.s.staging,body.name),body.path);

    const written=await readFile(body.path);
    assert.equal(createHash('sha256').update(written).digest('hex'),body.sha256,'the digest matches the file on disk');
    assert.deepEqual(Object.keys(body).sort(),['bytes','name','path','sha256'],'no supplier URL, no token');

    const text=JSON.stringify(body);
    assert.equal(text.includes(CDN),false);
    assert.equal(text.includes('fixture-supplier-token'),false);
    assert.equal(text.includes('http'),false);

    assert.match(h.recorder.text(),new RegExp(`raw videoId=${VIDEO} bytes=${content.byteLength}`));
    for(const forbidden of [CDN,'fixture-supplier-token',h.s.staging])assert.equal(h.recorder.text().includes(forbidden),false,`log must not contain ${forbidden}`);
  }finally{await h.close();}
});

test('an over-limit download is aborted and leaves staging clean',async()=>{
  const h=await running({content:new Uint8Array(4096).fill(7),env:{MATERIALS_RAW_MAX_BYTES:'1024'}});
  try{
    const response=await post(h,{videoId:VIDEO},headers());
    assert.equal(response.status,413);
    assert.equal((await response.json() as {code:string}).code,'raw-too-large');
    assert.deepEqual(await readdir(h.s.staging),[],'no partial file survived');
  }finally{await h.close();}
});

test('a host outside the allow-list is refused, and a non-video extension too',async()=>{
  const elsewhere=await running({rawUrl:'https://evil.fixture.test/videos/clip.mp4'});
  try{
    const response=await post(elsewhere,{videoId:VIDEO},headers());
    assert.equal(response.status,403);
    assert.equal((await response.json() as {code:string}).code,'raw-host-not-allowed');
    assert.equal(elsewhere.supplier.cdn.length,0,'nothing was downloaded');
  }finally{await elsewhere.close();}

  const wrongType=await running({rawUrl:`https://${CDN}/videos/clip.zip`});
  try{
    const response=await post(wrongType,{videoId:VIDEO},headers());
    assert.equal(response.status,422);
    assert.equal((await response.json() as {code:string}).code,'raw-type-not-allowed');
    assert.equal(wrongType.supplier.cdn.length,0);
  }finally{await wrongType.close();}
});

test('an empty host allow-list refuses every raw URL (fail closed)',async()=>{
  const h=await running({env:{MATERIALS_RAW_HOSTS:''}});
  try{
    const response=await post(h,{videoId:VIDEO},headers());
    assert.equal(response.status,403);
    assert.equal((await response.json() as {code:string}).code,'raw-host-not-allowed');
  }finally{await h.close();}
});

test('videoType is passed through: a card in its own type downloads, another type stays refused',async()=>{
  // ① the video really is in type 3 and the caller says 3 -> the author is found and one raw call happens.
  const matching=await running({videoType:3});
  try{
    const response=await post(matching,{videoId:VIDEO,videoType:3},headers());
    assert.equal(response.status,200);
    assert.equal(matching.supplier.rawCalls(),1);
    const lookup=matching.supplier.sentBody.filter(entry=>entry.path==='/openapi/video/list');
    assert.equal(lookup.length,1);
    assert.deepEqual(lookup[0].body,{pageNo:1,pageSize:1,isInner:0,videoType:3,videoIds:VIDEO},'the caller\'s type is sent untouched');
    assert.match(matching.recorder.text(),new RegExp(`raw videoId=${VIDEO} bytes=`));
    assert.equal(matching.recorder.text().includes('videoType'),false,'the log still carries only the id and the bytes');
  }finally{await matching.close();}

  // ② the caller says 3 but the video is in type 1 -> the lookup misses, so fail closed with no raw call.
  const mismatch=await running({videoType:1});
  try{
    const response=await post(mismatch,{videoId:VIDEO,videoType:3},headers());
    assert.equal(response.status,200);
    assert.equal(mismatch.supplier.rawCalls(),1,'one raw call once the exact id is found in its own category');
  }finally{await mismatch.close();}
});

test('omitting videoType means 1, which is what the supplier sees',async()=>{
  const h=await running({videoType:1});
  try{
    assert.equal((await post(h,{videoId:VIDEO},headers())).status,200);
    const lookup=h.supplier.sentBody.filter(entry=>entry.path==='/openapi/video/list');
    assert.equal((lookup[0].body as {videoType:number}).videoType,1,'the default is 1, not a guess');
  }finally{await h.close();}
});

test('negative: an out-of-range or non-integer videoType is 422 before any supplier work',async()=>{
  const h=await running();
  try{
    for(const [label,videoType] of [
      ['5',5],
      ['-1',-1],
      ['1.5',1.5],
      ['string','3'],
      ['boolean',true],
      ['null',null],
    ] as const){
      const response=await post(h,{videoId:VIDEO,videoType},headers());
      assert.equal(response.status,422,label);
      assert.equal((await response.json() as {code:string}).code,'invalid-query',label);
    }
    assert.equal(h.supplier.supplier.length,0,'nothing reached the supplier');
  }finally{await h.close();}
});

test('two downloads of the same video land in two different staged files without disturbing the process',async()=>{
  const h=await running();
  try{
    const first=await post(h,{videoId:VIDEO},headers());
    const second=await post(h,{videoId:VIDEO},headers());
    assert.equal(first.status,200);
    assert.equal(second.status,200,'the second download is not an EEXIST failure');
    const a=await first.json() as {name:string;path:string};
    const b=await second.json() as {name:string;path:string};
    assert.notEqual(a.name,b.name,'each download gets its own name');
    assert.notEqual(a.path,b.path);
    assert.match(a.name,/^raw-[a-f0-9]{32}-[a-f0-9]{6}\.mp4$/);
    const names=(await readdir(h.s.staging)).sort();
    assert.deepEqual(names,[a.name,b.name].sort(),'both files exist side by side');
    assert.equal(h.supplier.rawCalls(),2,'one raw call per download, never shared');
    const health=await fetch(h.base+'/health');
    assert.equal(health.status,200,'the process survived both downloads');
  }finally{await h.close();}
});

test('a write-stream error is returned as staging-write-failed and does not kill the process',async()=>{
  const h=await running();
  try{
    // Replace the staging directory with a file: the next write stream fails asynchronously with
    // ENOTDIR/ENOENT, which is exactly the unhandled-`'error'` case this must survive.
    await rm(h.s.staging,{recursive:true,force:true});
    await writeFile(h.s.staging,'not a directory','utf8');

    const response=await post(h,{videoId:VIDEO},headers());
    assert.equal(response.status,500);
    assert.equal((await response.json() as {code:string}).code,'staging-write-failed');

    const health=await fetch(h.base+'/health');
    assert.equal(health.status,200,'the process is still serving after the write error');
    await rm(h.s.staging,{force:true});
    await mkdir(h.s.staging,{recursive:true});
  }finally{await h.close();}
});

test('discardStaged removes a staged file and tolerates a path that is already gone',async()=>{
  const h=await running();
  try{
    const response=await post(h,{videoId:VIDEO},headers());
    const body=await response.json() as {path:string};
    assert.equal((await readdir(h.s.staging)).length,1);
    await discardStaged(body.path);
    assert.deepEqual(await readdir(h.s.staging),[],'the staged file is gone');
    await discardStaged(body.path);
    await discardStaged(join(h.s.staging,'never-existed.mp4'));
    assert.deepEqual(await readdir(h.s.staging),[],'discarding twice is not an error');
  }finally{await h.close();}
});

test('cross-implementation: a signature made by signRequest passes the session gate over real HTTP',async()=>{
  const h=await running();
  try{
    const response=await post(h,{videoId:VIDEO},headers());
    // The regression this pins: a correctly signed request must never come back as a session
    // refusal. Before the padded-base64 fix a client encoder that pads produced exactly that.
    assert.notEqual(response.status,403,'a valid signature is not a session refusal');
    assert.equal(response.status,200);

    // Same signature scheme, padded base64url principal, still accepted end to end.
    const principal=Buffer.from(JSON.stringify({environmentId:'fixture-env',subjectId:SUBJECT,instanceId:INSTANCE,epoch:1,exp:Math.floor(Date.now()/1000)+600}),'utf8').toString('base64url')+'=';
    const signature=signRequest(SECRET,{principal,method:'POST',path:'/api/materials/raw',query:''});
    const padded=await fetch(h.base+'/api/materials/raw',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,[PRINCIPAL_HEADER]:principal,[SIGNATURE_HEADER]:signature},body:JSON.stringify({videoId:VIDEO})});
    assert.equal(padded.status,200,'a padded principal is accepted, not refused');
  }finally{await h.close();}
});

test('a refused session names the reason in the log when the debug switch is on',async()=>{
  const h=await running({env:{MATERIALS_DEBUG_SESSION:'1'}});
  try{
    const principal=headers()[PRINCIPAL_HEADER];
    // Flip the first nibble: a probabilistic edit (e.g. forcing the last char to '0') can produce
    // the same signature by chance and make this test pass as a 200.
    const correct=signRequest(SECRET,{principal,method:'POST',path:'/api/materials/raw',query:''});
    const wrong=(correct[0]==='a'?'b':'a')+correct.slice(1);
    const response=await fetch(h.base+'/api/materials/raw',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,[PRINCIPAL_HEADER]:principal,[SIGNATURE_HEADER]:wrong},body:JSON.stringify({videoId:VIDEO})});
    assert.equal(response.status,403);
    assert.equal((await response.json() as {code:string}).code,'authentication-required');

    const log=h.recorder.text();
    assert.match(log,/session refused reason=signature-mismatch/);
    assert.match(log,/method=POST/);
    assert.match(log,/path=\/api\/materials\/raw/);
    assert.match(log,/query=""/);
    assert.equal(log.includes(SECRET),false,'the secret is never logged, even in the diagnostic');
    assert.equal(h.supplier.supplier.length,0);
  }finally{await h.close();}
});

test('the company scope reads the public pool: another author is allowed and the raw call happens once',async()=>{
  const h=await running({author:FOREIGN,env:{MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}});
  try{
    const response=await post(h,{videoId:VIDEO,scope:'company'},headers());
    assert.equal(response.status,200,'a public-pool video by another author is downloadable');
    const body=await response.json() as {path:string;bytes:number;sha256:string};
    assert.equal(typeof body.sha256,'string');
    assert.equal(h.supplier.rawCalls(),1,'query/raw exactly once');
    const lookup=h.supplier.sentBody.find(entry=>entry.path==='/openapi/video/list');
    assert.equal(lookup?.accountKey,COMPANY,'the company view key is what the supplier sees');

    // And with a company key configured, omitting scope defaults to company.
    const defaulted=await post(h,{videoId:VIDEO},headers());
    assert.equal(defaulted.status,200,'the default scope is company when a company key exists');
    assert.equal(h.supplier.rawCalls(),2);
  }finally{await h.close();}
});

test('the own scope still refuses another author',async()=>{
  const h=await running({author:FOREIGN,env:{MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}});
  try{
    const response=await post(h,{videoId:VIDEO,scope:'own'},headers());
    assert.equal(response.status,403);
    const body=await response.json() as {code:string};
    assert.equal(body.code,'authorization-denied');
    assert.equal(h.supplier.rawCalls(),0,'nothing was downloaded for a video outside the own layer');
  }finally{await h.close();}
});

test('without a company key the default stays own, so another author is refused',async()=>{
  const h=await running({author:FOREIGN});
  try{
    const response=await post(h,{videoId:VIDEO},headers());
    assert.equal(response.status,403);
    const body=await response.json() as {code:string;message:string};
    assert.equal(body.code,'authorization-denied');
    assert.equal(h.supplier.rawCalls(),0);
    assert.equal(h.supplier.supplier.filter(path=>path==='/openapi/video/list').length,1,'only the author lookup happened');
  }finally{await h.close();}
});

test('negative: a malformed scope is 422 before any supplier work',async()=>{
  const h=await running({env:{MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}});
  try{
    for(const scope of ['ownx','account:','anything',`account:${'k'.repeat(600)}`]){
      const response=await post(h,{videoId:VIDEO,scope},headers());
      assert.equal(response.status,422,scope.slice(0,12));
      assert.equal((await response.json() as {code:string}).code,'invalid-query',scope.slice(0,12));
    }
    assert.equal(h.supplier.supplier.length,0,'no supplier call for a malformed scope');
  }finally{await h.close();}
});

test('cross-implementation: a signed company-scope download passes the session gate and downloads',async()=>{
  const h=await running({author:FOREIGN,env:{MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}});
  try{
    const response=await post(h,{videoId:VIDEO,scope:'company'},headers());
    assert.notEqual(response.status,403,'a valid signature + company scope is not a refusal');
    assert.equal(response.status,200);
    assert.equal(h.supplier.rawCalls(),1);
  }finally{await h.close();}
});

test('a real supplier row shape survives the whole raw flow',async()=>{
  // Captured read-only on 2026-11-12 and desensitised; types are exactly the live ones
  // (videoState is an object, fileSize/duration/videoType/videoId are numbers, videoLabels is an array).
  const realRow={
    accountKey:FOREIGN,accountName:'acc',categoryId:1,categoryName:'cat',collectCount:0,
    coverUrl:'https://example.test/1.jpg',createTime:'2024-01-01 00:00:00',desc:'',
    dislikeTime:'2024-01-01 00:00:00',downloadCount:0,duration:12500,fileSize:2110621,
    lastModifyTime:1700000000,lastUseTime:'2024-01-01 00:00:00',name:'clip',
    oneLevelVideoType:{id:11,level:1,name:'L1',videoType:1,weight:1},picRemark:'',
    rawFileSize:2110621,rawMd5:'00000000000000000000000000000000',recycleTime:'',shootTime:'',
    state:1,totalStatCost:0,twoLevelVideoType:{id:12,level:2,name:'L2',parentTypeId:11,videoType:1,weight:2},
    videoId:VIDEO,videoLabels:[{id:1,name:'label'}],
    videoState:{backgroundColor:'#000000',frontColor:'#ffffff',id:1,isDefault:true,name:'on',weight:1},
    videoType:1,videoUrl:'https://example.test/1.mp4',viewCount:0,
  };
  const h=await running({row:realRow,env:{MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}});
  try{
    const response=await post(h,{videoId:VIDEO,scope:'company'},headers());
    assert.equal(response.status,200,'the real row decodes and the download completes');
    const body=await response.json() as {bytes:number;sha256:string};
    assert.equal(typeof body.sha256,'string');
    assert.equal(h.supplier.rawCalls(),1);
  }finally{await h.close();}
});

test('every supplier call of a successful raw flow carries a non-empty account_key',async()=>{
  const h=await running({author:FOREIGN,env:{MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}});
  try{
    const response=await post(h,{videoId:VIDEO,scope:'company'},headers());
    assert.equal(response.status,200);
    const accountScoped=h.supplier.sentBody.filter(entry=>entry.path==='/openapi/video/list'||entry.path==='/openapi/video/query/raw');
    assert.equal(accountScoped.length,2,'the author lookup and the raw call');
    for(const call of accountScoped){
      assert.ok((call.accountKey??'').length>0,`${call.path} must carry an account_key: the supplier answers 20000 without one`);
    }
    assert.equal(accountScoped[0].accountKey,COMPANY);
    // videoIds stays a bare string; an array makes the supplier answer 20015.
    assert.equal(typeof (accountScoped[0].body as {videoIds:unknown}).videoIds,'string');
  }finally{await h.close();}
});

test('a company scope without a usable company key is refused before any supplier call',async()=>{
  const h=await running({author:FOREIGN});
  try{
    const response=await post(h,{videoId:VIDEO,scope:'company'},headers());
    assert.equal(response.status,403);
    const body=await response.json() as {code:string};
    assert.equal(body.code,'authorization-denied');
    assert.equal(h.supplier.supplier.length,0,'an unusable company key never becomes a request');
  }finally{await h.close();}
});

test('the success log carries the id, the byte count and a per-process counter',async()=>{
  const h=await running();
  try{
    const first=await post(h,{videoId:VIDEO},headers());
    assert.equal(first.status,200);
    const second=await post(h,{videoId:VIDEO},headers());
    assert.equal(second.status,200);
    const log=h.recorder.text();
    assert.match(log,new RegExp(`raw videoId=${VIDEO} bytes=\\d+ count=1`));
    assert.match(log,new RegExp(`raw videoId=${VIDEO} bytes=\\d+ count=2`));
    for(const forbidden of [CDN,'fixture-supplier-token',h.s.staging])assert.equal(log.includes(forbidden),false,`the counter log must not contain ${forbidden}`);
  }finally{await h.close();}
});
test('the smoke guard covers this route too: without a stand-in the process will not start',async()=>{
  const s=await scratch();
  const pristine=globalThis.fetch;
  try{
    const refused=await startMaterialsService({env:s.env({MATERIALS_SMOKE_NO_NET:'1'}),logger:recording().logger});
    assert.deepEqual(refused.ok===false&&refused.refusal,{code:'smoke-net-guard',exitCode:2});
    assert.equal(globalThis.fetch,pristine);
  }finally{await s.cleanup();}
});
