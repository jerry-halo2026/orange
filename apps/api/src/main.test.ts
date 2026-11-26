// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {readEnvironment, runMain, startMaterialsService, wireShutdown, withinRoot, type Logger} from './main.ts';
import {SUPPLIER_ORIGIN} from './credentials.ts';
import {INTERNAL_SECRET_HEADER} from './server.ts';
import {signRequest, PRINCIPAL_HEADER, SIGNATURE_HEADER} from './session.ts';

const SECRET='fixture-internal-secret-0123456789abcdef';
const CDN='cdn.fixture.test';
const VIDEO='v-1';
const SUBJECT='11111111-1111-4111-8111-111111111111';
const OTHER='44444444-4444-4444-8444-444444444444';
const INSTANCE='22222222-2222-4222-8222-222222222222';
const SELF='fixture-self-account-key',GRANTED='fixture-granted-account-key',FOREIGN='fixture-foreign-account-key',COMPANY='fixture-company-account-key';
const FIXTURE={environmentId:'fixture-env',companyKey:'fixture_company_key',companySecret:'fixture_company_secret',origin:SUPPLIER_ORIGIN,note:'fixture annotation'};

/** Counts anything the service would have sent to the supplier, without changing behaviour. */
function trackSupplier(){
  const original=globalThis.fetch;
  const hits:string[]=[];
  const wrapped=(async (input:unknown,...rest:unknown[])=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:String((input as {url?:unknown}).url??'');
    if(url.startsWith(SUPPLIER_ORIGIN))hits.push(url);
    return (original as (...args:unknown[])=>Promise<Response>)(input,...rest);
  }) as typeof fetch;
  globalThis.fetch=wrapped;
  return {hits,restore:()=>{globalThis.fetch=original;}};
}

/** The headers Studio will send: a signed principal for exactly this method/path/query. */
function sessionHeaders(options:{secret?:string;method?:string;path?:string;query?:string;principal?:Record<string,unknown>}={}){
  const body=Buffer.from(JSON.stringify({environmentId:'fixture-env',subjectId:SUBJECT,instanceId:INSTANCE,epoch:3,exp:Math.floor(Date.now()/1000)+600,...options.principal}),'utf8').toString('base64url');
  const line={principal:body,method:options.method??'GET',path:options.path??'/api/materials/list',query:options.query??''};
  return {[PRINCIPAL_HEADER]:body,[SIGNATURE_HEADER]:signRequest(options.secret??SECRET,line)};
}

/** Records every line so a test can prove what was — and was not — logged. */
function recording(){
  const lines:string[]=[];
  const logger:Logger={info:(line)=>{lines.push(line);},error:(line)=>{lines.push(line);}};
  return {logger,lines,text:()=>lines.join('\n')};
}

async function scratch(){
  const root=await mkdtemp(join(tmpdir(),'orange-materials-'));
  const directory=join(root,'.dev','zhishang');
  await mkdir(directory,{recursive:true});
  const credentials=join(directory,'credentials.local.json');
  await writeFile(credentials,JSON.stringify(FIXTURE),'utf8');
  const bindings=join(directory,'bindings.local.json');
  await writeFile(bindings,JSON.stringify({version:1,bindings:{[SUBJECT]:{selfAccountKey:SELF,grantedAccountKeys:[GRANTED]}}}),'utf8');
  const staging=join(root,'staging');
  await mkdir(staging,{recursive:true});
  return {root,credentials,bindings,staging,env:(overrides:Record<string,string|undefined>={})=>({MATERIALS_PORT:'0',MATERIALS_SECRET:SECRET,MATERIALS_CREDENTIALS:credentials,MATERIALS_BINDINGS:bindings,MATERIALS_STAGING:staging,...overrides}),cleanup:()=>rm(root,{recursive:true,force:true})};
}

/** A supplier stand-in: records what the service asked for and answers plausibly. */
function stubSupplier(options:{accountRow?:Record<string,unknown>|null;rawUrl?:string}={}){
  const original=globalThis.fetch;
  const calls:{path:string;accountKey:string|null;body:unknown}[]=[];
  const wrapped=(async (input:unknown,...rest:unknown[])=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:String((input as {url?:unknown}).url??'');
    // The download host is served locally too: a test never reaches the network.
    if(url.startsWith('https://'+CDN))return new Response('fixture-video-bytes',{status:200});
    // Any other download host is answered too, so a refusal test measures the allow-list rather than
    // the network. The service checks the host before it ever fetches, so this is only a backstop.
    if(url.startsWith('https://origin.example'))return new Response('fixture-video-bytes',{status:200});
    if(!url.startsWith(SUPPLIER_ORIGIN))return (original as (...args:unknown[])=>Promise<Response>)(input,...rest);
    const init=rest[0] as RequestInit|undefined;
    const path=new URL(url).pathname;
    const headers=new Headers(init?.headers as HeadersInit|undefined);
    if(path==='/openapi/auth/access_token')return Response.json({success:true,code:1,data:{accessToken:'fixture-supplier-token'}});
    if(path==='/openapi/account/list'){const row=options.accountRow===null?null:(options.accountRow??{account:'fixture_login',accountKey:'fixture-claimed-account-key',groupId:9,name:'Fixture Login',state:1,teamId:7});return Response.json({success:true,code:1,data:{list:row?[row]:[],total:row?1:0}});}
    calls.push({path,accountKey:headers.get('account_key'),body:init?.body?JSON.parse(String(init.body)):null});
    // Facet reads have their own shapes; the generic video/list answer below would not decode.
    if(path==='/openapi/video/type/list')return Response.json({success:true,code:1,data:[{id:11,level:1,name:'L1',videoType:1,weight:1,children:[]}]});
    if(path==='/openapi/video/state/list')return Response.json({success:true,code:1,data:[{id:1,name:'on',weight:1}]});
    if(path==='/openapi/label/list')return Response.json({success:true,code:1,data:{list:[],total:0}});
    if(path==='/openapi/video/query/raw')return Response.json({success:true,code:1,data:{rawUrl:options.rawUrl??'https://'+CDN+'/videos/clip.mp4'}});
    const key=headers.get('account_key')??'unknown';
    const asked=(rest[0] as RequestInit|undefined)?.body?JSON.parse(String((rest[0] as RequestInit).body)):null;
    return Response.json({success:true,code:1,data:{list:[{videoId:asked?.videoIds??'v1',accountKey:key}],total:1}});
  }) as typeof fetch;
  globalThis.fetch=wrapped;
  return {calls,restore:()=>{globalThis.fetch=original;}};
}

test('missing environment is refused with exit code 2 for each required key',async()=>{
  const s=await scratch();
  try{
    const cases:[string,Record<string,string|undefined>,string][]=[
      ['port',{MATERIALS_PORT:undefined},'port-missing'],
      ['secret',{MATERIALS_SECRET:undefined},'secret-missing'],
      ['credentials',{MATERIALS_CREDENTIALS:undefined},'credentials-missing'],
    ];
    for(const [label,patch,code] of cases){
      const decided=readEnvironment(s.env(patch));
      assert.equal(decided.ok,false,label);
      assert.deepEqual(decided.ok===false&&decided.refusal,{code,exitCode:2},label);
      const recorder=recording();
      const exitCode=await runMain({env:s.env(patch),logger:recorder.logger,stayAlive:false});
      assert.equal(exitCode,2,`${label} exits 2`);
      assert.match(recorder.text(),new RegExp(`^\\[materials-api\\] refusing: ${code}$`,'m'));
      assert.equal(recorder.lines.filter(line=>line.includes('refusing:')).length,1,`${label} prints exactly one refusal line`);
    }
  }finally{await s.cleanup();}
});

test('a malformed environment is refused before anything is opened',async()=>{
  const s=await scratch();
  try{
    const cases:[string,Record<string,string|undefined>,string][]=[
      ['non-numeric port',s.env({MATERIALS_PORT:'eighty'}),'port-invalid'],
      ['empty port',s.env({MATERIALS_PORT:'  '}),'port-missing'],
      ['quiet secret',s.env({MATERIALS_SECRET:'short-secret'}),'secret-too-short'],
      ['secret with a space',s.env({MATERIALS_SECRET:'has a space '+'x'.repeat(32)}),'secret-invalid'],
      ['relative credentials',s.env({MATERIALS_CREDENTIALS:'.dev/zhishang/credentials.local.json'}),'credentials-not-absolute'],
      ['origin with a path',s.env({MATERIALS_ORIGINS:'http://127.0.0.1:5173/app'}),'origins-invalid'],
      ['relative allowed root',s.env({MATERIALS_ALLOWED_ROOT:'relative/root'}),'allowed-root-invalid'],
    ];
    for(const [label,env,code] of cases){
      const decided=readEnvironment(env);
      assert.equal(decided.ok,false,label);
      assert.deepEqual(decided.ok===false&&decided.refusal,{code,exitCode:2},label);
      const started=await startMaterialsService({env,logger:recording().logger});
      assert.equal(started.ok,false,label);
    }
  }finally{await s.cleanup();}
});

test('the self-check refuses an unreadable credential file or one outside the allowed root',async()=>{
  const s=await scratch();
  try{
    const missing=await startMaterialsService({env:s.env({MATERIALS_CREDENTIALS:join(s.root,'.dev','zhishang','absent.json')}),logger:recording().logger});
    assert.deepEqual(missing.ok===false&&missing.refusal,{code:'credentials-unreadable',exitCode:1});

    const outsider=await mkdtemp(join(tmpdir(),'orange-elsewhere-'));
    try{
      const outside=await startMaterialsService({env:s.env({MATERIALS_ALLOWED_ROOT:outsider}),logger:recording().logger});
      assert.deepEqual(outside.ok===false&&outside.refusal,{code:'credentials-outside-root',exitCode:1});
      const inside=await startMaterialsService({env:s.env({MATERIALS_ALLOWED_ROOT:s.root}),logger:recording().logger});
      assert.equal(inside.ok,true,'a root that contains the credentials file is accepted');
      if(inside.ok)await inside.service.close();
    }finally{await rm(outsider,{recursive:true,force:true});}

    assert.equal(withinRoot('C:\\a\\b\\c.json','C:\\a\\b'),true);
    assert.equal(withinRoot('C:\\a\\b2\\c.json','C:\\a\\b'),false,'a sibling prefix is not inside');
  }finally{await s.cleanup();}
});

test('the shared secret never reaches a log line, on any path',async()=>{
  const s=await scratch();
  try{
    const recorder=recording();
    const started=await startMaterialsService({env:s.env(),logger:recorder.logger});
    assert.equal(started.ok,true);
    if(started.ok){
      const base='http://127.0.0.1:'+started.service.port;
      await fetch(base+'/api/materials/list',{headers:{[INTERNAL_SECRET_HEADER]:SECRET,authorization:'Bearer fixture'}});
      await fetch(base+'/api/materials/list',{headers:{[INTERNAL_SECRET_HEADER]:'wrong-'+SECRET}});
      await started.service.close();
    }
    for(const patch of [{MATERIALS_SECRET:'short'},{MATERIALS_SECRET:undefined}]){
      const refusing=recording();
      await runMain({env:s.env(patch),logger:refusing.logger,stayAlive:false});
      assert.doesNotMatch(refusing.text(),/fixture-internal-secret-0123456789abcdef/);
      assert.doesNotMatch(refusing.text(),/fixture_company_key|fixture_company_secret/);
    }
    assert.ok(recorder.lines.length>=1,'something was logged');
    for(const forbidden of [SECRET,'fixture_company_key','fixture_company_secret','fixture annotation']){
      assert.equal(recorder.text().includes(forbidden),false,`log must not contain ${forbidden}`);
    }
    assert.equal(recorder.text().includes('ready service=materials'),true,'the ready line is logged');
  }finally{await s.cleanup();}
});

test('no session mode means hmac: a signed principal passes the gate, every forgery does not',async()=>{
  const s=await scratch();
  const tracker=trackSupplier();
  try{
    const started=await startMaterialsService({env:s.env(),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    const call=async (headers:Record<string,string>,query='')=>{
      const response=await fetch(base+'/api/materials/list'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...headers}});
      return {status:response.status,code:((await response.json()) as {code:string}).code};
    };
    try{
      // The one positive case: the gate passes, and the answer comes from the next layer. The signed
      // subject deliberately has no binding entry here, so the answer is `authorization-denied` and
      // nothing is dispatched — the binding-backed read is covered in its own test below.
      const accepted=await call(sessionHeaders({principal:{subjectId:OTHER}}));
      assert.equal(accepted.status,403);
      assert.equal(accepted.code,'authorization-denied','a correctly signed session reaches the layer decision');

      const negatives:[string,Record<string,string>][]=[
        ['no headers',{}],
        ['wrong secret',sessionHeaders({secret:'another-secret-0123456789abcdef'})],
        // The signature is kept while the payload behind it is rewritten: a real tamper.
        ['tampered principal',(()=>{const headers=sessionHeaders();const body=JSON.parse(Buffer.from(headers[PRINCIPAL_HEADER],'base64url').toString('utf8'));body.subjectId='33333333-3333-4333-8333-333333333333';headers[PRINCIPAL_HEADER]=Buffer.from(JSON.stringify(body),'utf8').toString('base64url');return headers;})()],
        ['expired',sessionHeaders({principal:{exp:Math.floor(Date.now()/1000)-60}})],
        ['epoch zero',sessionHeaders({principal:{epoch:0}})],
        ['missing field',(()=>{const headers=sessionHeaders();const body=JSON.parse(Buffer.from(headers[PRINCIPAL_HEADER],'base64url').toString('utf8'));delete body.instanceId;headers[PRINCIPAL_HEADER]=Buffer.from(JSON.stringify(body),'utf8').toString('base64url');return headers;})()],
      ];
      for(const [label,headers] of negatives){
        const answer=await call(headers);
        assert.equal(answer.code,'authentication-required',label);
      }

      // A signature made for `/list` replayed onto `/facets` is refused, because the path is signed.
      const replayed=await fetch(base+'/api/materials/facets',{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders()}});
      assert.equal(((await replayed.json()) as {code:string}).code,'authentication-required','tampered path');
      // And a signature that covers the query cannot be reused with a different filter.
      const narrowed=await fetch(base+'/api/materials/list?pageSize=5',{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders()}});
      assert.equal(((await narrowed.json()) as {code:string}).code,'authentication-required','tampered query');

      assert.equal(tracker.hits.length,0,'no rejection path ever reached the supplier');
    }finally{await started.service.close();}
  }finally{tracker.restore();await s.cleanup();}
});

test('the supabase mode refuses to start without its configuration instead of falling back',async()=>{
  const s=await scratch();
  try{
    const missing=readEnvironment(s.env({MATERIALS_SESSION_MODE:'supabase'}));
    assert.deepEqual(missing.ok===false&&missing.refusal,{code:'supabase-config-missing',exitCode:2});

    const partial=await startMaterialsService({env:s.env({MATERIALS_SESSION_MODE:'supabase',MATERIALS_SUPABASE_ORIGIN:'https://fixture.supabase.co'}),logger:recording().logger});
    assert.deepEqual(partial.ok===false&&partial.refusal,{code:'supabase-config-missing',exitCode:2});

    const invalid=readEnvironment(s.env({MATERIALS_SESSION_MODE:'trust-me'}));
    assert.deepEqual(invalid.ok===false&&invalid.refusal,{code:'session-mode-invalid',exitCode:2});

    const complete=await startMaterialsService({env:s.env({MATERIALS_SESSION_MODE:'supabase',MATERIALS_SUPABASE_ORIGIN:'https://fixture.supabase.co',MATERIALS_SUPABASE_PUBLISHABLE_KEY:'fixture-public'}),logger:recording().logger});
    assert.equal(complete.ok,true,'with both settings the supabase mode starts');
    if(complete.ok)await complete.service.close();
  }finally{await s.cleanup();}
});

test('bindings decide the read: own uses the self key, grants widen it, a stranger gets nothing',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    const recorder=recording();
    const started=await startMaterialsService({env:s.env(),logger:recorder.logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    const read=async (scope:string|undefined,subject=SUBJECT)=>{
      const query=scope===undefined?'pageSize=5':'pageSize=5&scope='+encodeURIComponent(scope);
      const response=await fetch(base+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({principal:{subjectId:subject},query})}});
      return {status:response.status,body:await response.json() as {code?:string;items?:unknown[];authorization?:unknown}};
    };
    try{
      const own=await read(undefined);
      assert.equal(own.status,200,JSON.stringify(own.body));
      assert.deepEqual(own.body.authorization,{layer:'self',reason:'own-account-key'});
      assert.equal(supplier.calls[0].accountKey,SELF,'the self key comes from the binding file');

      const viaSelfKey=await read('account:'+SELF);
      assert.equal(viaSelfKey.status,200,JSON.stringify(viaSelfKey.body));
      assert.equal(supplier.calls[supplier.calls.length-1].accountKey,SELF);

      const granted=await read('account:'+GRANTED);
      assert.equal(granted.status,200,JSON.stringify(granted.body));
      assert.deepEqual(granted.body.authorization,{layer:'granted',reason:'explicit-account-grant'});
      assert.equal(supplier.calls[supplier.calls.length-1].accountKey,GRANTED);

      const before=supplier.calls.length;
      assert.equal((await read('account:'+FOREIGN)).status,403,'a key outside the file is refused');
      assert.equal((await read(undefined,OTHER)).status,403,'a subject with no binding has no self key');
      assert.equal((await read('account:'+GRANTED,OTHER)).status,403,'and inherits no grant either');
      assert.equal((await read('company',OTHER)).status,403,'nor a company view it was never given');
      assert.equal(supplier.calls.length,before,'no refused read reached the supplier');

      assert.equal((await read('account:'+FOREIGN)).body.code,'authorization-denied');
      assert.match(recorder.text(),/bindings loaded count=1/);
      for(const forbidden of [SELF,GRANTED,SUBJECT])assert.equal(recorder.text().includes(forbidden),false,`log must not contain ${forbidden}`);
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('no binding file means an empty table: the service starts, own is refused, nothing is sent',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    const recorder=recording();
    const started=await startMaterialsService({env:s.env({MATERIALS_BINDINGS:undefined}),logger:recorder.logger});
    assert.equal(started.ok,true,'a desktop install without a binding file still starts');
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    try{
      assert.equal((await fetch(base+'/health')).status,200);
      assert.match(recorder.text(),/bindings absent: own and account scopes unavailable/);
      assert.doesNotMatch(recorder.text(),/bindings loaded/);

      const query='pageSize=5';
      const denied=await fetch(base+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query})}});
      assert.equal(denied.status,403);
      assert.equal((await denied.json() as {code:string}).code,'authorization-denied');

      const accountQuery=query+'&scope=account:'+GRANTED;
      const explicit=await fetch(base+'/api/materials/list?'+accountQuery,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query:accountQuery})}});
      assert.equal(explicit.status,403,'an account scope has nothing to resolve against');
      assert.equal(supplier.calls.length,0,'an empty table never reaches the supplier');
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('a binding path that does not exist is treated exactly like an absent file',async()=>{
  const s=await scratch();
  try{
    const recorder=recording();
    const started=await startMaterialsService({env:s.env({MATERIALS_BINDINGS:join(s.root,'.dev','zhishang','nope.local.json')}),logger:recorder.logger});
    assert.equal(started.ok,true,'a missing file is not a broken installation');
    if(started.ok){
      assert.match(recorder.text(),/bindings absent/);
      await started.service.close();
    }
  }finally{await s.cleanup();}
});

test('the company view still works on an empty table when a company key is configured',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    const started=await startMaterialsService({env:s.env({MATERIALS_BINDINGS:undefined,MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    try{
      const query='pageSize=5&scope=company';
      const response=await fetch('http://127.0.0.1:'+started.service.port+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query})}});
      assert.equal(response.status,200,'the public pool does not depend on a per-subject binding');
      const body=await response.json() as {authorization:unknown};
      assert.deepEqual(body.authorization,{layer:'public',reason:'company-view'});
      assert.equal(supplier.calls[supplier.calls.length-1].accountKey,COMPANY);
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('a binding file that exists but is broken still refuses startup',async()=>{
  const s=await scratch();
  try{
    const cases:[string,string,()=>Promise<void>][]=[
      ['malformed json','bindings-invalid',async()=>{await writeFile(s.bindings,'{not json','utf8');}],
      ['unknown top-level key','bindings-invalid',async()=>{await writeFile(s.bindings,JSON.stringify({version:1,bindings:{},extra:true}),'utf8');}],
      ['directory','bindings-unreadable',async()=>{await rm(s.bindings,{force:true});await mkdir(s.bindings,{recursive:true});}],
    ];
    for(const [label,code,prepare] of cases){
      await prepare();
      const started=await startMaterialsService({env:s.env(),logger:recording().logger});
      assert.deepEqual(started.ok===false&&started.refusal,{code,exitCode:2},label);
    }
  }finally{await s.cleanup();}
});

test('a symlinked binding file refuses startup instead of reading through the link',async()=>{
  const s=await scratch();
  const link=join(s.root,'.dev','zhishang','link.local.json');
  try{
    try{await symlink(s.bindings,link,'file');}
    catch{return;}
    const started=await startMaterialsService({env:s.env({MATERIALS_BINDINGS:link}),logger:recording().logger});
    assert.deepEqual(started.ok===false&&started.refusal,{code:'bindings-unreadable',exitCode:2});
  }finally{await s.cleanup();}
});
test('the company view needs its own key: absent stays 403, present is used, unusable refuses startup',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    const withoutKey=await startMaterialsService({env:s.env(),logger:recording().logger});
    assert.equal(withoutKey.ok,true);
    if(withoutKey.ok){
      const base='http://127.0.0.1:'+withoutKey.service.port;
      try{
        const query='pageSize=5&scope=company';
        const response=await fetch(base+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query})}});
        assert.equal(response.status,403);
        const body=await response.json() as {code:string};
        assert.equal(body.code,'authorization-denied','the company view is honestly unavailable');
        assert.equal(supplier.calls.length,0,'and nothing is dispatched');
      }finally{await withoutKey.service.close();}
    }

    const withKey=await startMaterialsService({env:s.env({MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}),logger:recording().logger});
    assert.equal(withKey.ok,true);
    if(withKey.ok){
      const base='http://127.0.0.1:'+withKey.service.port;
      try{
        const query='pageSize=5&scope=company';
        const response=await fetch(base+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query})}});
        assert.equal(response.status,200);
        const body=await response.json() as {authorization:unknown};
        assert.deepEqual(body.authorization,{layer:'public',reason:'company-view'});
        assert.equal(supplier.calls.length,1);
        assert.equal(supplier.calls[0].accountKey,COMPANY,'the company view uses the configured key');
        assert.notEqual(supplier.calls[0].accountKey,SELF,'never the caller\'s own key');
      }finally{await withKey.service.close();}
    }

    for(const value of ['has space','x'.repeat(600)]){
      const invalid=readEnvironment(s.env({MATERIALS_COMPANY_ACCOUNT_KEY:value}));
      assert.deepEqual(invalid.ok===false&&invalid.refusal,{code:'company-key-invalid',exitCode:2},value.slice(0,12));
    }
  }finally{supplier.restore();await s.cleanup();}
});

test('the smoke guard refuses to start without a local fetch stand-in',async()=>{
  const s=await scratch();
  const pristine=globalThis.fetch;
  try{
    const refused=await startMaterialsService({env:s.env({MATERIALS_SMOKE_NO_NET:'1'}),logger:recording().logger});
    assert.deepEqual(refused.ok===false&&refused.refusal,{code:'smoke-net-guard',exitCode:2});
    const code=await runMain({env:s.env({MATERIALS_SMOKE_NO_NET:'1'}),logger:recording().logger,stayAlive:false});
    assert.equal(code,2);

    const supplier=stubSupplier();
    try{
      const allowed=await startMaterialsService({env:s.env({MATERIALS_SMOKE_NO_NET:'1'}),logger:recording().logger});
      assert.equal(allowed.ok,true,'a stand-in satisfies the guard');
      if(allowed.ok)await allowed.service.close();
      assert.equal(supplier.calls.length,0);
    }finally{supplier.restore();}
    assert.equal(globalThis.fetch,pristine,'the stand-in was removed again');
  }finally{await s.cleanup();}
});

test('a claim binds the caller to an exact account and the next own read uses that key',async()=>{
  const s=await scratch();
  const claims=join(s.root,'.dev','zhishang','claims.local.json');
  const supplier=stubSupplier();
  try{
    const started=await startMaterialsService({env:s.env({MATERIALS_BINDINGS:claims}),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    const token=(options?:{method?:string;path?:string;query?:string})=>sessionHeaders(options);
    try{
      const before=await fetch(base+'/api/materials/binding',{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...token({method:'GET',path:'/api/materials/binding'})}});
      assert.deepEqual(await before.json(),{binding:null},'nothing claimed yet');

      const claimed=await fetch(base+'/api/materials/binding',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...token({method:'POST',path:'/api/materials/binding'})},body:JSON.stringify({account:'fixture_login'})});
      assert.equal(claimed.status,200);
      const body=await claimed.json() as {binding:Record<string,unknown>};
      assert.equal(body.binding.accountKey,'fixture-claimed-account-key');
      assert.equal(body.binding.account,'fixture_login');
      assert.equal(body.binding.teamId,7);
      assert.equal(body.binding.groupId,9);
      assert.equal(body.binding.status,'claimed');

      // The very next own read uses the claimed key.
      const query='pageSize=5';
      const listed=await fetch(base+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...token({query})}});
      const listedBody=await listed.json() as {code?:string};
      assert.equal(listed.status,200,JSON.stringify(listedBody));
      assert.equal(supplier.calls[supplier.calls.length-1].accountKey,'fixture-claimed-account-key');
      assert.deepEqual(JSON.parse(await readFile(claims,'utf8')).bindings[SUBJECT].selfAccountKey,'fixture-claimed-account-key');
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('a claim for an account the supplier does not know is 400, and one without a login is 422',async()=>{
  const s=await scratch();
  const claims=join(s.root,'.dev','zhishang','claims.local.json');
  const missing=stubSupplier({accountRow:null});
  try{
    const started=await startMaterialsService({env:s.env({MATERIALS_BINDINGS:claims}),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    try{
      const unknown=await fetch(base+'/api/materials/binding',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'POST',path:'/api/materials/binding'})},body:JSON.stringify({account:'nobody'})});
      assert.equal(unknown.status,400);
      assert.equal((await unknown.json() as {code:string}).code,'binding-account-not-found');

      const keyOnly=await fetch(base+'/api/materials/binding',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'POST',path:'/api/materials/binding'})},body:JSON.stringify({accountKey:'fixture-key'})});
      assert.equal(keyOnly.status,422,'a key alone cannot be verified, so it is refused');
      assert.equal((await keyOnly.json() as {code:string}).code,'binding-account-required');
    }finally{await started.service.close();}
  }finally{missing.restore();await s.cleanup();}
});

test('release returns to 403, and local mode refuses to claim at all',async()=>{
  const s=await scratch();
  const claims=join(s.root,'.dev','zhishang','claims.local.json');
  const supplier=stubSupplier();
  try{
    const started=await startMaterialsService({env:s.env({MATERIALS_BINDINGS:claims}),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    try{
      await fetch(base+'/api/materials/binding',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'POST',path:'/api/materials/binding'})},body:JSON.stringify({account:'fixture_login'})});
      const released=await fetch(base+'/api/materials/binding',{method:'DELETE',headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'DELETE',path:'/api/materials/binding'})}});
      assert.deepEqual(await released.json(),{binding:null,released:true});
      const query='pageSize=5';
      const denied=await fetch(base+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query})}});
      assert.equal(denied.status,403,'after release own is refused again');
    }finally{await started.service.close();}

    const local=await startMaterialsService({env:s.env({MATERIALS_BINDINGS:claims,MATERIALS_BINDINGS_MODE:'local'}),logger:recording().logger});
    assert.equal(local.ok,true);
    if(!local.ok)return;
    try{
      const refused=await fetch('http://127.0.0.1:'+local.service.port+'/api/materials/binding',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'POST',path:'/api/materials/binding'})},body:JSON.stringify({account:'fixture_login'})});
      assert.equal(refused.status,409);
      assert.equal((await refused.json() as {code:string}).code,'binding-store-readonly');
    }finally{await local.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('the company key falls back to the credential file when the environment does not set one',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    await writeFile(s.credentials,JSON.stringify({...FIXTURE,accountKey:COMPANY}),'utf8');
    const recorder=recording();
    const started=await startMaterialsService({env:s.env(),logger:recorder.logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    try{
      const query='pageSize=5&scope=company';
      const response=await fetch(base+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query})}});
      assert.equal(response.status,200);
      assert.equal(supplier.calls[supplier.calls.length-1].accountKey,COMPANY,'the credential file is the source of the company key');
      assert.match(recorder.text(),/company view: credentials/);
      assert.equal(recorder.text().includes(COMPANY),false,'the key itself is never logged');
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('the environment company key wins over the credential file one',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    await writeFile(s.credentials,JSON.stringify({...FIXTURE,accountKey:'fixture-credentials-account-key'}),'utf8');
    const recorder=recording();
    const started=await startMaterialsService({env:s.env({MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}),logger:recorder.logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    try{
      const query='pageSize=5&scope=company';
      await fetch('http://127.0.0.1:'+started.service.port+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query})}});
      assert.equal(supplier.calls[supplier.calls.length-1].accountKey,COMPANY);
      assert.match(recorder.text(),/company view: env/);
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('with no company key anywhere the view stays unavailable and nothing is sent',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    const recorder=recording();
    const started=await startMaterialsService({env:s.env(),logger:recorder.logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    try{
      const query='pageSize=5&scope=company';
      const response=await fetch('http://127.0.0.1:'+started.service.port+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query})}});
      assert.equal(response.status,403);
      assert.equal((await response.json() as {code:string}).code,'authorization-denied');
      assert.equal(supplier.calls.length,0);
      assert.match(recorder.text(),/company view: none/);
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('an unusable accountKey in the credential file refuses startup',async()=>{
  const s=await scratch();
  try{
    await writeFile(s.credentials,JSON.stringify({...FIXTURE,accountKey:'has a space'}),'utf8');
    const recorder=recording();
    const code=await runMain({env:s.env(),logger:recorder.logger,stayAlive:false});
    assert.equal(code,2);
    assert.match(recorder.text(),/refusing: company-key-invalid/);
  }finally{await s.cleanup();}
});

test('a principal from another application environment still reaches company, binding and raw',async()=>{
  const s=await scratch();
  const claims=join(s.root,'.dev','zhishang','claims.local.json');
  const supplier=stubSupplier();
  try{
    await writeFile(s.credentials,JSON.stringify({...FIXTURE,accountKey:COMPANY}),'utf8');
    const recorder=recording();
    const started=await startMaterialsService({env:s.env({MATERIALS_BINDINGS:claims,MATERIALS_RAW_HOSTS:CDN}),logger:recorder.logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    // The desktop signs with its own application environment; the credential file names the supplier
    // environment. They are different layers and must not be compared.
    const desktop={environmentId:'orange-test-desktop'};
    try{
      const listQuery='pageSize=5&scope=company';
      const listed=await fetch(base+'/api/materials/list?'+listQuery,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({principal:desktop,query:listQuery})}});
      assert.equal(listed.status,200,'a company read works even when the two environmentIds differ');
      assert.equal(supplier.calls[supplier.calls.length-1].accountKey,COMPANY);

      const facetsQuery='scope=company';
      const facets=await fetch(base+'/api/materials/facets?'+facetsQuery,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({principal:desktop,path:'/api/materials/facets',query:facetsQuery})}});
      const facetsBody=await facets.json() as {code?:string};
      assert.equal(facets.status,200,JSON.stringify(facetsBody));

      const claimed=await fetch(base+'/api/materials/binding',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'POST',path:'/api/materials/binding',principal:desktop})},body:JSON.stringify({account:'fixture_login'})});
      assert.equal(claimed.status,200,'claiming works from the same desktop session');

      const raw=await fetch(base+'/api/materials/raw',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'POST',path:'/api/materials/raw',principal:desktop})},body:JSON.stringify({videoId:'v-1',scope:'company'})});
      const rawBody=await raw.json() as {code?:string};
      assert.equal(raw.status,200,JSON.stringify(rawBody));
      assert.equal(supplier.calls.filter(entry=>entry.path==='/openapi/video/query/raw').length,1,'query/raw exactly once');

      // The session gate itself still refuses what it should.
      const noSignature=await fetch(base+'/api/materials/list?'+listQuery,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,[PRINCIPAL_HEADER]:sessionHeaders({principal:desktop,query:listQuery})[PRINCIPAL_HEADER]}});
      assert.equal(noSignature.status,403);
      assert.equal((await noSignature.json() as {code:string}).code,'authentication-required');
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('the raw host allow-list can come from the credential file, and env wins over it',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    await writeFile(s.credentials,JSON.stringify({...FIXTURE,accountKey:COMPANY,rawHosts:[CDN]}),'utf8');
    const rec=recording();
    const started=await startMaterialsService({env:s.env(),logger:rec.logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    try{
      const response=await fetch('http://127.0.0.1:'+started.service.port+'/api/materials/raw',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'POST',path:'/api/materials/raw'})},body:JSON.stringify({videoId:VIDEO,scope:'company'})});
      assert.equal(response.status,200,'a host from the credential file allows the download');
      assert.match(rec.text(),/raw hosts: credentials count=1/);
    }finally{await started.service.close();}

    // env wins over the credential file.
    const rec2=recording();
    const second=await startMaterialsService({env:s.env({MATERIALS_RAW_HOSTS:CDN,MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}),logger:rec2.logger});
    assert.equal(second.ok,true);
    if(!second.ok)return;
    try{assert.match(rec2.text(),/raw hosts: env count=1/);}
    finally{await second.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('an unusable rawHosts in the credential file refuses startup',async()=>{
  const s=await scratch();
  try{
    for(const rawHosts of [['not a host'],['ok.test','bad host'],'cdn.fixture.test',[1,2]]){
      await writeFile(s.credentials,JSON.stringify({...FIXTURE,rawHosts}),'utf8');
      const rec=recording();
      const code=await runMain({env:s.env(),logger:rec.logger,stayAlive:false});
      assert.equal(code,2,JSON.stringify(rawHosts));
      assert.match(rec.text(),/refusing: raw-hosts-invalid/,JSON.stringify(rawHosts));
    }
  }finally{await s.cleanup();}
});

test('with no raw host anywhere the download is refused and nothing is fetched',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    const started=await startMaterialsService({env:s.env({MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY}),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    try{
      const response=await fetch('http://127.0.0.1:'+started.service.port+'/api/materials/raw',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'POST',path:'/api/materials/raw'})},body:JSON.stringify({videoId:VIDEO,scope:'company'})});
      assert.equal(response.status,403);
      assert.equal((await response.json() as {code:string}).code,'raw-host-not-allowed');
      assert.equal(supplier.calls.filter(entry=>entry.path==='/openapi/video/query/raw').length,1,'the URL has to be asked for before it can be rejected');
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('an unscoped list reads the company view by default, and scope=own still narrows to self',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    await writeFile(s.credentials,JSON.stringify({...FIXTURE,accountKey:COMPANY}),'utf8');
    const started=await startMaterialsService({env:s.env(),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    try{
      const plain='pageSize=5';
      const byDefault=await fetch(base+'/api/materials/list?'+plain,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query:plain})}});
      assert.equal(byDefault.status,200);
      assert.deepEqual((await byDefault.json() as {authorization:unknown}).authorization,{layer:'public',reason:'company-view'},'the public pool is the default');

      const own='pageSize=5&scope=own';
      const narrowed=await fetch(base+'/api/materials/list?'+own,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query:own})}});
      assert.equal(narrowed.status,200);
      assert.deepEqual((await narrowed.json() as {authorization:unknown}).authorization,{layer:'self',reason:'own-account-key'},'an explicit own scope still narrows to the caller');
      assert.equal(supplier.calls[supplier.calls.length-1].accountKey,SELF);
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('MATERIALS_IS_INNER accepts only 0 or 1, and the conclusion is logged without any host',async()=>{
  const s=await scratch();
  try{
    for(const value of ['yes','2','-1','true']){
      const rec=recording();
      const code=await runMain({env:s.env({MATERIALS_IS_INNER:value}),logger:rec.logger,stayAlive:false});
      assert.equal(code,2,value);
      assert.match(rec.text(),/refusing: is-inner-invalid/,value);
    }
    for(const [value,expected] of [['1','on'],['0','off'],[undefined,'off']] as const){
      const rec=recording();
      const started=await startMaterialsService({env:s.env({MATERIALS_IS_INNER:value}),logger:rec.logger});
      assert.equal(started.ok,true,String(value));
      if(!started.ok)continue;
      await started.service.close();
      assert.match(rec.text(),new RegExp('inner mode: '+expected),String(value));
      for(const leak of ['sucaicloud','192.168.']){
        assert.equal(rec.text().includes(leak),false,'the log must not carry a host or an address');
      }
    }
  }finally{await s.cleanup();}
});

test('the list route accepts twoLevelTypeIds and the other filter dimensions over HTTP',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    const started=await startMaterialsService({env:s.env(),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    try{
      const query='pageSize=5&twoLevelTypeIds=271500,271501&oneLevelTypeId=5908&videoStateId=1&includeLabelIds=7,8&excludeLabelIds=9&teamIds=2549&groupIds=16817';
      const response=await fetch(base+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query})}});
      assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
      const body=supplier.calls[supplier.calls.length-1].body as Record<string,unknown>;
      assert.equal(body.twoLevelTypeIds,'271500,271501','the drill-down id list reaches the supplier as a string');
      assert.equal(body.oneLevelTypeId,5908);
      assert.equal(body.videoStateId,1);
      assert.equal(body.includeLabelIds,'7,8');
      assert.equal(body.excludeLabelIds,'9');
      assert.equal(body.teamIds,'2549');
      assert.equal(body.groupIds,'16817');
      assert.equal(body.isInner,0);

      for(const bad of ['abc','','271500,','271500,271501,','1 2']){
        const badQuery='twoLevelTypeIds='+encodeURIComponent(bad);
        const before=supplier.calls.length;
        const refused=await fetch(base+'/api/materials/list?'+badQuery,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query:badQuery})}});
        assert.equal(refused.status,422,bad);
        assert.equal(supplier.calls.length,before,'a refused value never reaches the supplier');
      }
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('a wildcard raw host allows the whole CDN family, and an illegal one refuses startup',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    const started=await startMaterialsService({env:s.env({MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY,MATERIALS_RAW_HOSTS:'*.fixture.test'}),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    try{
      const response=await fetch('http://127.0.0.1:'+started.service.port+'/api/materials/raw',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'POST',path:'/api/materials/raw'})},body:JSON.stringify({videoId:VIDEO,scope:'company'})});
      assert.equal(response.status,200,'a subdomain of the wildcard entry is allowed');
    }finally{await started.service.close();}

    for(const bad of ['su*.cai.com','*','*.*.com']){
      const rec=recording();
      const code=await runMain({env:s.env({MATERIALS_RAW_HOSTS:bad}),logger:rec.logger,stayAlive:false});
      assert.equal(code,2,bad);
      assert.match(rec.text(),/refusing: raw-hosts-invalid/,bad);
    }
  }finally{supplier.restore();await s.cleanup();}
});

test('MATERIALS_DEBUG_RAW_HOST names the refused host and nothing else',async()=>{
  const s=await scratch();
  const supplier=stubSupplier({rawUrl:'https://origin.example/videos/clip.mp4'});
  try{
    for(const [flag,expected] of [['1',true],[undefined,false]] as const){
      const rec=recording();
      const started=await startMaterialsService({env:s.env({MATERIALS_COMPANY_ACCOUNT_KEY:COMPANY,MATERIALS_RAW_HOSTS:CDN,...(flag===undefined?{}:{MATERIALS_DEBUG_RAW_HOST:flag})}),logger:rec.logger});
      assert.equal(started.ok,true);
      if(!started.ok)continue;
      try{
        const response=await fetch('http://127.0.0.1:'+started.service.port+'/api/materials/raw',{method:'POST',headers:{'content-type':'application/json',[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({method:'POST',path:'/api/materials/raw'})},body:JSON.stringify({videoId:VIDEO,scope:'company'})});
        assert.equal(response.status,403,'the host is not in the allow-list');
        assert.equal((await response.json() as {code:string}).code,'raw-host-not-allowed');
        const lines=rec.text();
        assert.equal(lines.includes('raw host refused host='),expected);
        if(expected){
          assert.match(lines,/raw host refused host=origin\.example/);
          for(const leak of ['http','/videos/','clip.mp4','?']){
            assert.equal(lines.includes(leak),false,'the line must not carry that');
          }
        }
      }finally{await started.service.close();}
    }
  }finally{supplier.restore();await s.cleanup();}
});

test('the list route forwards orderByType and a date range over HTTP',async()=>{
  const s=await scratch();
  const supplier=stubSupplier();
  try{
    const started=await startMaterialsService({env:s.env(),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    try{
      const query='pageSize=5&orderByType=1&esUpdateStartTime=2026-11-01&esUpdateEndTime=2026-11-13';
      const ok=await fetch(base+'/api/materials/list?'+query,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query})}});
      assert.equal(ok.status,200);
      const body=supplier.calls[supplier.calls.length-1].body as Record<string,unknown>;
      assert.equal(body.orderByType,1,'the ordering code is a number on the wire');
      assert.equal(body.esUpdateStartTime,'2026-11-01');
      assert.equal(body.esUpdateEndTime,'2026-11-13');

      for(const bad of ['orderByType=7','orderByType=abc','esUpdateStartTime=2026-11-01','esUpdateEndTime=2026-11-13','esUpdateStartTime=2026-11-13%2010%3A00%3A00&esUpdateEndTime=2026-11-14','esUpdateStartTime=2026-11-13&esUpdateEndTime=2026-11-01']){
        const before=supplier.calls.length;
        const refused=await fetch(base+'/api/materials/list?'+bad,{headers:{[INTERNAL_SECRET_HEADER]:SECRET,...sessionHeaders({query:bad})}});
        assert.equal(refused.status,422,bad);
        assert.equal(supplier.calls.length,before,'nothing is sent for a refused filter');
      }
    }finally{await started.service.close();}
  }finally{supplier.restore();await s.cleanup();}
});

test('health is open, answers exactly {ok,version}, and leaks no configuration',async()=>{
  const s=await scratch();
  try{
    const started=await startMaterialsService({env:s.env(),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    try{
      const response=await fetch('http://127.0.0.1:'+started.service.port+'/health');
      assert.equal(response.status,200);
      assert.equal(response.headers.get('cache-control'),'no-store');
      const body=await response.json() as Record<string,unknown>;
      assert.deepEqual(Object.keys(body).sort(),['ok','version']);
      assert.equal(body.ok,true);
      assert.equal(body.version,'0.0.0');
      const text=JSON.stringify(body);
      for(const forbidden of [String(started.service.port),SECRET,'credentials','fixture_company']){
        assert.equal(text.includes(forbidden),false,`health must not expose ${forbidden}`);
      }
    }finally{await started.service.close();}
  }finally{await s.cleanup();}
});

test('a browser origin is refused by default, and the internal hop needs the exact secret',async()=>{
  const s=await scratch();
  try{
    const started=await startMaterialsService({env:s.env(),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    const base='http://127.0.0.1:'+started.service.port;
    try{
      const browser=await fetch(base+'/api/materials/list',{headers:{origin:'http://127.0.0.1:5173',[INTERNAL_SECRET_HEADER]:SECRET}});
      assert.equal(browser.status,403);
      assert.equal((await browser.json() as {code:string}).code,'origin-rejected');

      const absent=await fetch(base+'/api/materials/list');
      assert.equal(absent.status,403);
      assert.equal((await absent.json() as {code:string}).code,'internal-auth-required');

      const wrong=await fetch(base+'/api/materials/list',{headers:{[INTERNAL_SECRET_HEADER]:SECRET+'x'}});
      assert.equal(wrong.status,403);
      assert.equal((await wrong.json() as {code:string}).code,'internal-auth-required');

      // With the right secret the gate passes and the (still unwired) identity seam answers, which
      // is the proof that the hop check itself succeeded.
      const passed=await fetch(base+'/api/materials/list',{headers:{[INTERNAL_SECRET_HEADER]:SECRET}});
      assert.equal(passed.status,403);
      assert.equal((await passed.json() as {code:string}).code,'authentication-required');
    }finally{await started.service.close();}
  }finally{await s.cleanup();}
});

test('an allow-listed origin reaches the same hop check',async()=>{
  const s=await scratch();
  try{
    const started=await startMaterialsService({env:s.env({MATERIALS_ORIGINS:'http://127.0.0.1:5173,https://app.example'}),logger:recording().logger});
    assert.equal(started.ok,true);
    if(!started.ok)return;
    try{
      const response=await fetch('http://127.0.0.1:'+started.service.port+'/api/materials/list',{headers:{origin:'http://127.0.0.1:5173',[INTERNAL_SECRET_HEADER]:SECRET}});
      assert.equal((await response.json() as {code:string}).code,'authentication-required','origin passed, so the answer came from the next gate');
    }finally{await started.service.close();}
  }finally{await s.cleanup();}
});

test('parent EOF on stdio closes the server once and exits 0',async()=>{
  const stdin=new EventEmitter() as EventEmitter & {resume?:()=>void};
  const exits:number[]=[];
  let closes=0;
  wireShutdown({close:async()=>{closes+=1;},stdin,exit:(code)=>{exits.push(code);},logger:recording().logger});
  stdin.emit('end');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closes,1);
  assert.deepEqual(exits,[0]);
  stdin.emit('end');
  stdin.emit('close');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closes,1,'a second reason does not close twice');
  assert.deepEqual(exits,[0],'and does not exit twice');
});

test('SIGTERM and SIGINT take the same orderly path',async()=>{
  for(const signal of ['SIGTERM','SIGINT'] as const){
    const handlers:Record<string,()=>void>={};
    const exits:number[]=[];let closes=0;
    wireShutdown({close:async()=>{closes+=1;},stdin:null,onSignal:(name,handler)=>{handlers[name]=handler;},exit:(code)=>{exits.push(code);},logger:recording().logger});
    assert.equal(typeof handlers[signal],'function',`${signal} is wired`);
    handlers[signal]();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(closes,1,signal);
    assert.deepEqual(exits,[0],signal);
  }
});

test('a closing failure still leaves the process, with a non-zero code',async()=>{
  const exits:number[]=[];
  wireShutdown({close:async()=>{throw new Error('fixture close failure');},stdin:null,onSignal:(_name,handler)=>{handler();},exit:(code)=>{exits.push(code);},logger:recording().logger});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(exits,[1]);
});

test('the entry point refuses rather than throwing when the environment is unusable',async()=>{
  const recorder=recording();
  const code=await runMain({env:{},logger:recorder.logger,stayAlive:false});
  assert.equal(code,2);
  assert.match(recorder.text(),/^\[materials-api\] refusing: port-missing$/m);
  assert.doesNotMatch(recorder.text(),/at .*main\.ts/,'no raw stack trace');
});
