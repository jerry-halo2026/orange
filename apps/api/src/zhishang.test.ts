import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyBearer} from './supabase.ts';

const provider=await import('./zhishang.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return null;throw error;});
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const config={environmentId:'fixture-env',companyKey:'fixture_company',companySecret:'fixture_secret'};
const origin='https://sucaiwang-open-api.zhishangsoft.com';
async function principal(subject=A,seconds=60){
 const claims={sub:subject,session_id:'33333333-3333-4333-8333-333333333333',exp:Math.floor(Date.now()/1000)+seconds,role:'authenticated',aud:'authenticated',iss:'https://fixture.supabase.co/auth/v1'};
 const token='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture-signature';
 return verifyBearer({environmentId:'fixture-env',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'fixture-public'},'Bearer '+token,async()=>Response.json({id:subject,is_anonymous:false}));
}
const reply=(data:unknown)=>Response.json({success:true,code:1,data});
const failure=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
function fixture(overrides:Record<string,unknown>={}){
 assert.equal(typeof provider?.createZhishangReadOnly,'function','real readonly server factory exists');
 const calls:Array<{url:string;init:RequestInit}>=[];let scope='',bindingRevision=1,bindingSubject=A,bindingExpiry=Date.now()+7200000,allow=true;
 const queue:Array<(url:string,init:RequestInit)=>Promise<Response>|Response>=[()=>reply({accessToken:'fixture-private-access'})];
 const client=provider!.createZhishangReadOnly(config,{
  fetch:async(url: string|URL|Request,init?:RequestInit)=>{calls.push({url:String(url),init:init!});const next=queue.shift();assert.ok(next,'unexpected vendor request');return next(String(url),init!);},
  nonce:()=> '0011223344556677',
  authorizeLookup:async()=>allow,
  bindingFor:async(context:{subjectId:string},providerScope:string)=>{scope=providerScope;return {subjectId:bindingSubject,environmentId:'fixture-env',providerScope,bindingId:'44444444-4444-4444-8444-444444444444',revision:bindingRevision,accountKey:'fixture-person-account',status:'active',expiresAtMs:bindingExpiry};},
  ...overrides,
 });
 return {client,calls,queue,scope:()=>scope,denyLookup:()=>{allow=false;},changeBinding:()=>{bindingRevision++;},foreignBinding:()=>{bindingSubject=B;},expireBinding:()=>{bindingExpiry=Date.now()-1;}};
}

test('concrete supplier signer matches both reviewed MD5/RFC3986 golden vectors, no canonical secret is returned',()=>{
 assert.equal(typeof provider?.signZhishang,'function');
 assert.equal(provider!.signZhishang({company_key:'fixture_company',timestamp:1730000000,nonce:'0011223344556677',pageNo:1,pageSize:5,account:'fixture_user'},'fixture_secret'),'27C6775D3A1AF911B52CE68D551186FF');
 assert.equal(provider!.signZhishang({company_key:'fixture_company',timestamp:1730000000,nonce:'0011223344556677',access_token:'fixture_access',account_key:'fixture_account',pageNo:1,pageSize:12,isInner:0,videoType:1,name:'茶 A+!()*'},'fixture secret&+'),'CA301560B78532B86C41BE6F721A6F6B');
 assert.equal(provider!.signZhishang({a:'x',sign:'ignored'},'s'),provider!.signZhishang({a:'x'},'s'));
});

test('forged/foreign principal and missing lookup authorization perform zero supplier calls',async()=>{
 const s=fixture();await assert.rejects(s.client.lookupExactAccount({subjectId:A} as any,'fixture_user'),failure('authentication-required'));
 await assert.rejects(s.client.listMaterials({...await principal()},{}),failure('authentication-required'));
 const ctx=await principal();const no=fixture({authorizeLookup:undefined});await assert.rejects(no.client.lookupExactAccount(ctx,'fixture_user'),failure('lookup-not-authorized'));assert.equal(no.calls.length,0);
 const foreign=provider!.createZhishangReadOnly({...config,environmentId:'other'},{fetch:async()=>assert.fail('no transport')});await assert.rejects(foreign.lookupExactAccount(ctx,'fixture_user'),failure('authentication-required'));
 s.denyLookup();await assert.rejects(s.client.lookupExactAccount(ctx,'fixture_user'),failure('lookup-not-authorized'));assert.equal(s.calls.length,0);
});

test('exact lookup uses only the bounded approved login, token stays private, and found observation grants nothing',async()=>{
 const s=fixture(),ctx=await principal();s.queue.push((url,init)=>{assert.equal(url,origin+'/openapi/account/list');assert.deepEqual(JSON.parse(String(init.body)),{pageNo:1,pageSize:5,account:'fixture_user'});const headers=new Headers(init.headers);assert.equal(headers.get('access_token'),'fixture-private-access');assert.equal(headers.get('account_key'),null);assert.equal(headers.get('nonce')?.length,16);assert.equal(headers.get('content-type'),'application/json');assert.equal(init.redirect,'error');return reply({list:[{account:'fixture_user',accountKey:'external-person-key',state:1,name:'display-only'}],total:1});});
 const value=await s.client.lookupExactAccount(ctx,'fixture_user');assert.equal(value.status,'found');assert.equal(value.account?.accountKey.value,'external-person-key');assert.equal(value.grants,false);
 assert.doesNotMatch(JSON.stringify(value)+JSON.stringify(s.client),/fixture-private-access|fixture_company|fixture_secret/);assert.equal(s.calls.length,2);
});

test('lookup preserves not-found/ambiguous/disabled and malformed distinctions without broader queries',async()=>{
 for(const [rows,status] of [[[],'not-found'],[[{account:'fixture_user',accountKey:'k',state:1},{account:'fixture_user',accountKey:'k2',state:1}],'ambiguous'],[[{account:'fixture_user',accountKey:'k',state:0}],'disabled']] as const){const s=fixture();s.queue.push(()=>reply({list:rows}));assert.equal((await s.client.lookupExactAccount(await principal(),'fixture_user')).status,status);assert.equal(s.calls.length,2);}
 for(const data of [{}, {list:[{account:'other',accountKey:'k',state:1}]},{list:[{account:'fixture_user',state:1}]}]){const s=fixture();s.queue.push(()=>reply(data));await assert.rejects(s.client.lookupExactAccount(await principal(),'fixture_user'),failure('provider-response-unconfirmed'));assert.equal(s.calls.length,2);}
 const s=fixture();await assert.rejects(s.client.lookupExactAccount(await principal(),''),failure('invalid-query'));assert.equal(s.calls.length,0);
});

test('video list uses only the current trusted binding and preserves other legitimate authors plus raw units',async()=>{
 const s=fixture(),ctx=await principal();s.queue.push((url,init)=>{assert.equal(url,origin+'/openapi/video/list');assert.equal(new Headers(init.headers).get('account_key'),'fixture-person-account');assert.deepEqual(JSON.parse(String(init.body)),{pageNo:2,pageSize:12,isInner:0,videoType:1,name:'茶',videoIds:'900719925474099312345'});return new Response('{"success":true,"code":1,"data":{"list":[{"videoId":900719925474099312345,"accountKeys":["another-author"],"duration":1234.50,"videoType":1}],"total":900719925474099312346}}',{headers:{'content-type':'application/json'}});});
 const value=await s.client.listMaterials(ctx,{pageNo:2,pageSize:12,name:'茶',videoIds:'900719925474099312345'});
 assert.deepEqual(value.items[0].videoId,{value:'900719925474099312345',sourceType:'number',source:'900719925474099312345'});assert.deepEqual(value.items[0].observation.duration,{sourceType:'number',source:'1234.50'});assert.deepEqual(value.items[0].observation.accountKeys,['another-author']);assert.deepEqual(value.total,{sourceType:'number',source:'900719925474099312346'});assert.equal(value.grants,false);assert.equal(value.providerScope,s.scope());assert.match(value.providerScope,/^[a-f0-9]{64}$/);
});

test('caller reserved identity/filter collisions are rejected and absent/foreign/revoked bindings make zero calls',async()=>{
 const ctx=await principal();for(const query of [{account_key:'forged'},{accountKeys:['author']},{isInner:1},{endpoint:'/admin'},{pageNo:0},{pageSize:101},{videoType:5},{videoIds:9007199254740992}]){const s=fixture();await assert.rejects(s.client.listMaterials(ctx,query as any),failure('invalid-query'));assert.equal(s.calls.length,0);}
 for(const overrides of [{bindingFor:undefined},{bindingFor:async()=>null}]){const s=fixture(overrides);await assert.rejects(s.client.listMaterials(ctx,{}),failure('binding-required'));assert.equal(s.calls.length,0);}
 for(const change of ['foreignBinding','expireBinding'] as const){const s=fixture();s[change]();await assert.rejects(s.client.listMaterials(ctx,{}),failure('binding-required'));assert.equal(s.calls.length,0);}
});

test('changed binding rejects late supplier results and never caches A metadata for B',async()=>{
 const s=fixture(),ctx=await principal(),response=deferred<Response>(),entered=deferred<void>();s.queue.push(()=>{entered.resolve();return response.promise;});
 const work=s.client.listMaterials(ctx,{});await entered.promise;s.changeBinding();response.resolve(reply({list:[{videoId:'opaque-id'}]}));await assert.rejects(work,failure('binding-changed'));
 await assert.rejects(s.client.listMaterials(await principal(B),{}),failure('binding-required'));assert.equal(s.calls.length,2);
});

test('existing branded principal expiry is checked again before accepting a late supplier response',async t=>{
 const s=fixture(),ctx=await principal(),response=deferred<Response>(),entered=deferred<void>();s.queue.push(()=>{entered.resolve();return response.promise;});const work=s.client.listMaterials(ctx,{});const denied=assert.rejects(work,failure('authentication-required'));await entered.promise;
 t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(61000);response.resolve(reply({list:[]}));await denied;assert.equal(s.calls.length,2);
 const expired=fixture();await assert.rejects(expired.client.listMaterials(ctx,{}),failure('authentication-required'));await assert.rejects(expired.client.lookupExactAccount(ctx,'fixture_user'),failure('authentication-required'));assert.equal(expired.calls.length,0);
});

test('private company token is single-flight, cached no more than one hour, and never retried after failure',async()=>{
 let now=Date.now();const s=fixture({now:()=>now});const ctx=await principal();s.queue.push(()=>reply({list:[]}),()=>reply({list:[]}));await Promise.all([s.client.listMaterials(ctx,{}),s.client.listMaterials(ctx,{})]);assert.equal(s.calls.filter(c=>c.url.endsWith('/access_token')).length,1);
 now+=3600000;s.queue.push(()=>reply({accessToken:'replacement-private-token'}),()=>reply({list:[]}));await s.client.listMaterials(ctx,{});assert.equal(s.calls.filter(c=>c.url.endsWith('/access_token')).length,2);
 s.queue.push(()=>Response.json({success:false,code:99,message:'fixture_secret must not escape'}));await assert.rejects(s.client.listMaterials(ctx,{}),failure('provider-unconfirmed'));assert.equal(s.calls.length,6);
 s.queue.push(()=>reply({accessToken:'third-private-token'}),()=>reply({list:[]}));await s.client.listMaterials(ctx,{});assert.equal(s.calls.length,8);
});

test('supplier forbidden/unknown/redirect/malformed results are never empty success and errors contain no credential',async()=>{
 for(const make of [()=>new Response('secret',{status:403}),()=>Response.json({success:false,code:501,message:'fixture_secret'}),()=>new Response('{}',{status:302}),()=>reply({notList:[]}),()=>new Response('{"success":true,"code":1,"data":{"list":[],"list":[]}}',{headers:{'content-type':'application/json'}})]){const s=fixture();s.queue.push(make);await assert.rejects(s.client.listMaterials(await principal(),{}),error=>{assert.doesNotMatch(String(error),/fixture_secret|fixture_company|fixture-private-access/);return true;});assert.equal(s.calls.length,2);}
});

test('metadata never leaks supplier credentials and unsafe numeric IDs do not round into accepted IDs',async()=>{
 for(const row of [{videoId:1.5},{videoId:'x',note:'fixture-private-access'},{videoId:'x',company_secret:'fixture_secret'}]){const s=fixture();s.queue.push(()=>reply({list:[row]}));await assert.rejects(s.client.listMaterials(await principal(),{}),failure('provider-response-unconfirmed'));}
 const s=fixture();s.queue.push(()=>reply({list:[{videoId:'000123'}]}));assert.deepEqual((await s.client.listMaterials(await principal(),{})).items[0].videoId,{value:'000123',sourceType:'string',source:'000123'});
});

test('unsafe number lexemes cannot round into successful code or active account state',async()=>{
 const code=fixture();code.queue.push(()=>new Response('{"success":true,"code":1.00000000000000000001,"data":{"list":[]}}',{headers:{'content-type':'application/json'}}));await assert.rejects(code.client.listMaterials(await principal(),{}),failure('provider-unconfirmed'));
 const state=fixture();state.queue.push(()=>new Response('{"success":true,"code":1,"data":{"list":[{"account":"fixture_user","accountKey":"key","state":1.00000000000000000001}]}}',{headers:{'content-type':'application/json'}}));await assert.rejects(state.client.lookupExactAccount(await principal(),'fixture_user'),failure('provider-response-unconfirmed'));
});

test('binding namespace/current status and positive immutable UUID/revision reject before company auth',async()=>{
 const ctx=await principal();for(const patch of [{bindingId:'0'},{bindingId:'00000000-0000-0000-0000-000000000000'},{revision:0},{providerScope:'foreign'},{environmentId:'foreign'},{status:'disabled'},{expiresAtMs:Infinity}]){
  const s=fixture({bindingFor:async(context:typeof ctx,providerScope:string)=>({subjectId:context.subjectId,environmentId:'fixture-env',providerScope,bindingId:'44444444-4444-4444-8444-444444444444',revision:1,accountKey:'fixture-person-account',status:'active',expiresAtMs:Date.now()+60000,...patch})});await assert.rejects(s.client.listMaterials(ctx,{}),failure('binding-required'));assert.equal(s.calls.length,0);
 }
});

test('trusted clock and nonce failures are sanitized before any supplier dispatch',async()=>{
 for(const options of [{now:()=>{throw Error('fixture_secret private clock');}},{nonce:()=>{throw Error('fixture_secret private entropy');}}]){const s=fixture(options);await assert.rejects(s.client.lookupExactAccount(await principal(),'fixture_user'),error=>{assert.doesNotMatch(String(error),/fixture_secret|private/);return (error as {code?:string}).code==='provider-clock-unconfirmed'||(error as {code?:string}).code==='configuration-required';});assert.equal(s.calls.length,0);}
});

test('supplier metadata property names cannot expose company credentials or the private token, including nested keys',async()=>{
 for(const secret of ['fixture-private-access','fixture_secret','fixture_company']){
  const list=fixture();list.queue.push(()=>reply({list:[{videoId:'opaque',nested:{['prefix-'+secret+'-suffix']:'metadata'}}]}));
  await assert.rejects(list.client.listMaterials(await principal(),{}),failure('provider-response-unconfirmed'));assert.equal(list.calls.length,2);
  const lookup=fixture();lookup.queue.push(()=>reply({list:[{account:'fixture_user',accountKey:'external-key',state:1,[secret]:'metadata'}]}));
  await assert.rejects(lookup.client.lookupExactAccount(await principal(),'fixture_user'),failure('provider-response-unconfirmed'));assert.equal(lookup.calls.length,2);
 }
});

test('response cap cancels body, and timeout aborts without retry or silently accepted late result',async t=>{
 const s=fixture(),drain=deferred<void>();let cancelled=false,completed=false;s.queue.push(()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(' '.repeat(3*1024*1024+1)));},cancel(){cancelled=true;return drain.promise;}}),{headers:{'content-type':'application/json'}}));const oversized=s.client.listMaterials(await principal(),{});void oversized.then(()=>completed=true,()=>completed=true);const oversizedDenied=assert.rejects(oversized,failure('provider-response-too-large'));await new Promise(r=>setImmediate(r));assert.equal(cancelled,true);assert.equal(completed,false,'actual body cancel acknowledgement is awaited');drain.resolve();await oversizedDenied;
 const slow=fixture(),ctx=await principal();let signal:AbortSignal|undefined;const held=deferred<Response>(),entered=deferred<void>();slow.queue.push((url,init)=>{signal=init.signal!;entered.resolve();return held.promise;});
 t.mock.timers.enable({apis:['setTimeout']});let settled=false;const work=slow.client.listMaterials(ctx,{});void work.then(()=>settled=true,()=>settled=true);const denied=assert.rejects(work,failure('provider-timeout'));await entered.promise;t.mock.timers.tick(10000);assert.equal(signal?.aborted,true);await Promise.resolve();assert.equal(settled,false,'abort is not actual ignored-transport drain');held.resolve(reply({list:[]}));await denied;t.mock.timers.reset();assert.equal(slow.calls.length,2);
});
