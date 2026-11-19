// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, randomUUID} from 'node:crypto';
import {createHmacVerifier, canonicalRequest, signRequest, PRINCIPAL_HEADER, SIGNATURE_HEADER} from './session.ts';
import type {VerifyRequest} from './server.ts';
import {isVerifiedSession} from './supabase.ts';

const SECRET='fixture-session-secret-0123456789abcdef';
const ENVIRONMENT='fixture-env';
const NOW=1_800_000_000_000; // 2027-01-15T08:00:00Z, seconds: 1800000000

const encode=(value:unknown)=>Buffer.from(JSON.stringify(value),'utf8').toString('base64url');

function principal(overrides:Record<string,unknown>={}){
  return {environmentId:ENVIRONMENT,subjectId:randomUUID(),instanceId:randomUUID(),epoch:7,exp:Math.floor(NOW/1000)+600,...overrides};
}

function request(headers:Record<string,string|undefined>,line:{method?:string;path?:string;query?:string}={}):VerifyRequest {
  const lowered:Record<string,string|undefined>={};
  for(const [name,value] of Object.entries(headers))lowered[name.toLowerCase()]=value;
  return {
    authorization:lowered.authorization,
    method:line.method??'GET',
    path:line.path??'/api/materials/list',
    query:line.query??'pageSize=5',
    header:(name)=>lowered[name.toLowerCase()],
  };
}

/** A request whose signature is correct for the given principal/line. */
function signed(overrides:{principal?:Record<string,unknown>;method?:string;path?:string;query?:string;secret?:string}={}){
  const body=encode(overrides.principal??principal());
  const line={principal:body,method:overrides.method??'GET',path:overrides.path??'/api/materials/list',query:overrides.query??'pageSize=5'};
  const signature=createHmac('sha256',overrides.secret??SECRET).update(canonicalRequest(line),'utf8').digest('hex');
  return request({[PRINCIPAL_HEADER]:body,[SIGNATURE_HEADER]:signature},line);
}

const failure=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;

test('the canonical string has a fixed shape so P1-B can sign the same bytes',()=>{
  assert.equal(canonicalRequest({principal:'AAA',method:'get',path:'/api/materials/list',query:'pageSize=5'}),'v1\nAAA\nGET\n/api/materials/list\npageSize=5');
  assert.equal(canonicalRequest({principal:'AAA',method:'GET',path:'/health',query:''}),'v1\nAAA\nGET\n/health\n');
  assert.equal(signRequest(SECRET,{principal:'AAA',method:'GET',path:'/p',query:''}),createHmac('sha256',SECRET).update('v1\nAAA\nGET\n/p\n').digest('hex'));
});

test('a correctly signed, unexpired principal becomes a branded session',async()=>{
  const verify=createHmacVerifier({secret:SECRET,now:()=>NOW});
  const body=principal();
  const session=await verify(signed({principal:body}));
  assert.equal(session.subjectId,body.subjectId);
  assert.equal(session.sessionId,body.instanceId);
  assert.equal(session.environmentId,ENVIRONMENT);
  assert.equal(session.expiresAtMs,body.exp*1000);
  assert.equal(isVerifiedSession(session),true,'the transport accepts an adopted session');
  assert.equal(Object.isFrozen(session),true);
});

test('negative: a missing or malformed pair of headers is refused',async()=>{
  const verify=createHmacVerifier({secret:SECRET,now:()=>NOW});
  const body=encode(principal());
  const cases:[string,VerifyRequest][]=[
    ['no headers',request({})],
    ['principal only',request({[PRINCIPAL_HEADER]:body})],
    ['signature only',request({[SIGNATURE_HEADER]:'a'.repeat(64)})],
    ['principal not base64url',request({[PRINCIPAL_HEADER]:'not a base64url value!',[SIGNATURE_HEADER]:'a'.repeat(64)})],
    ['principal not json',request({[PRINCIPAL_HEADER]:Buffer.from('not-json','utf8').toString('base64url'),[SIGNATURE_HEADER]:'a'.repeat(64)})],
    ['signature wrong shape',request({[PRINCIPAL_HEADER]:body,[SIGNATURE_HEADER]:'XYZ'})],
    ['oversized query',request({[PRINCIPAL_HEADER]:body,[SIGNATURE_HEADER]:'a'.repeat(64)}, {query:'q='+'x'.repeat(5000)})],
  ];
  for(const [label,req] of cases)await assert.rejects(()=>verify(req),failure('authentication-required'),label);
});

test('negative: a wrong secret, a tampered principal and a tampered line are all refused',async()=>{
  const verify=createHmacVerifier({secret:SECRET,now:()=>NOW});
  await assert.rejects(()=>verify(signed({secret:'another-secret-0123456789abcdefghij'})),failure('authentication-required'),'signed with another secret');

  // Tampered principal: change the subject, keep the original signature.
  const original=principal();
  const originalBody=encode(original);
  const line={principal:originalBody,method:'GET',path:'/api/materials/list',query:'pageSize=5'};
  const signature=createHmac('sha256',SECRET).update(canonicalRequest(line),'utf8').digest('hex');
  const tamperedBody=encode({...original,subjectId:randomUUID()});
  await assert.rejects(()=>verify(request({[PRINCIPAL_HEADER]:tamperedBody,[SIGNATURE_HEADER]:signature},line)),failure('authentication-required'),'tampered principal');

  // Tampered path: the signature was made for /api/materials/list, replayed onto another route.
  await assert.rejects(()=>verify(request({[PRINCIPAL_HEADER]:originalBody,[SIGNATURE_HEADER]:signature},{...line,path:'/api/materials/facets'})),failure('authentication-required'),'tampered path');
  // Tampered method and query too: the whole request line is inside the signature.
  await assert.rejects(()=>verify(request({[PRINCIPAL_HEADER]:originalBody,[SIGNATURE_HEADER]:signature},{...line,method:'POST'})),failure('authentication-required'),'tampered method');
  await assert.rejects(()=>verify(request({[PRINCIPAL_HEADER]:originalBody,[SIGNATURE_HEADER]:signature},{...line,query:'pageSize=100'})),failure('authentication-required'),'tampered query');
  // Same bytes on the wire are still fine.
  await verify(request({[PRINCIPAL_HEADER]:originalBody,[SIGNATURE_HEADER]:signature},line));
});

test('negative: expired, just-expired and non-positive epochs are refused where the clock says so',async()=>{
  const verify=createHmacVerifier({secret:SECRET,now:()=>NOW});
  const seconds=Math.floor(NOW/1000);
  for(const [label,exp] of [
    ['a minute ago',seconds-60],
    ['exactly now',seconds],
    ['one second from now',seconds+1],
  ] as const){
    const body=principal({exp});
    const work=verify(signed({principal:body}));
    if(label==='one second from now')await work;
    else await assert.rejects(()=>work,failure('authentication-required'),label);
  }

  for(const epoch of [0,-1,1.5,'7',null]){
    await assert.rejects(()=>verify(signed({principal:principal({epoch})})),failure('authentication-required'),`epoch ${String(epoch)}`);
  }

  // Clock boundary from the other side: the same signature is valid now and invalid just after exp.
  const body=principal({exp:seconds+2});
  const fresh=await import('./session.ts').then(module=>module.createHmacVerifier({secret:SECRET,now:()=>NOW+1000}));
  await fresh(signed({principal:body}));
  const stale=await import('./session.ts').then(module=>module.createHmacVerifier({secret:SECRET,now:()=>NOW+2000}));
  await assert.rejects(()=>stale(signed({principal:body})),failure('authentication-required'),'one second past exp');
});

test('negative: a principal missing a field, or carrying an extra one, is refused',async()=>{
  const verify=createHmacVerifier({secret:SECRET,now:()=>NOW});
  for(const key of ['environmentId','subjectId','instanceId','epoch','exp']){
    const body=principal();
    delete (body as Record<string,unknown>)[key];
    await assert.rejects(()=>verify(signed({principal:body})),failure('authentication-required'),`missing ${key}`);
  }
  await assert.rejects(()=>verify(signed({principal:{...principal(),admin:true}})),failure('authentication-required'),'extra field');
  for(const patch of [{subjectId:'not-a-uuid'},{instanceId:'not-a-uuid'},{environmentId:''},{environmentId:'has space'}]){
    await assert.rejects(()=>verify(signed({principal:principal(patch)})),failure('authentication-required'),JSON.stringify(patch));
  }
});

test('a padded base64url principal is accepted, because the signature covers the bytes as sent',async()=>{
  const verify=createHmacVerifier({secret:SECRET,now:()=>NOW});
  const body=encode(principal());
  const padded=body+'=';
  const line={principal:padded,method:'POST',path:'/api/materials/raw',query:''};
  const signature=createHmac('sha256',SECRET).update(canonicalRequest(line),'utf8').digest('hex');
  const session=await verify(request({[PRINCIPAL_HEADER]:padded,[SIGNATURE_HEADER]:signature},line));
  assert.match(session.subjectId,/^[a-f0-9]{8}-/);
  assert.equal(session.environmentId,ENVIRONMENT);

  // The padding is not silently normalised out of the canonical string: a signature made for the
  // unpadded header does not validate the padded one.
  const unpaddedSignature=createHmac('sha256',SECRET).update(canonicalRequest({...line,principal:body}),'utf8').digest('hex');
  await assert.rejects(()=>verify(request({[PRINCIPAL_HEADER]:padded,[SIGNATURE_HEADER]:unpaddedSignature},line)),failure('authentication-required'));
});

test('the diagnostics hook reports which input differed, and never the secret',async()=>{
  const seen:Array<Record<string,unknown>>=[];
  const verify=createHmacVerifier({secret:SECRET,now:()=>NOW,diagnostics:(info)=>{seen.push({...info});}});
  const body=encode(principal());
  const line={principal:body,method:'POST',path:'/api/materials/raw',query:''};

  await assert.rejects(()=>verify(request({[PRINCIPAL_HEADER]:body,[SIGNATURE_HEADER]:'a'.repeat(64)},line)),failure('authentication-required'));
  assert.equal(seen[0].reason,'signature-mismatch');
  assert.equal(seen[0].method,'POST');
  assert.equal(seen[0].path,'/api/materials/raw');
  assert.equal(seen[0].query,'');
  assert.equal(seen[0].hasSignature,true);
  assert.equal(seen[0].principalLength,body.length);
  assert.equal(typeof seen[0].principalSha8,'string');

  seen.length=0;
  await assert.rejects(()=>verify(request({[PRINCIPAL_HEADER]:'==',[SIGNATURE_HEADER]:'a'.repeat(64)},line)),failure('authentication-required'));
  assert.equal(seen[0].reason,'principal-unusable');

  seen.length=0;
  const expired=principal({exp:Math.floor(NOW/1000)-5});
  await assert.rejects(()=>verify(signed({principal:expired})),failure('authentication-required'));
  // The hook is called by the same verifier: a fresh one with diagnostics sees the expiry reason.
  const expiring=createHmacVerifier({secret:SECRET,now:()=>NOW,diagnostics:(info)=>{seen.push({...info});}});
  await assert.rejects(()=>expiring(signed({principal:expired})),failure('authentication-required'));
  assert.equal(seen[0].reason,'expired');

  assert.doesNotMatch(JSON.stringify(seen),new RegExp(SECRET),'the secret never appears in a diagnostic');
});

test('a diagnostic hook that throws cannot change the decision',async()=>{
  const verify=createHmacVerifier({secret:SECRET,now:()=>NOW,diagnostics:()=>{throw new Error('fixture diagnostic failure');}});
  await assert.rejects(()=>verify(request({[PRINCIPAL_HEADER]:'==',[SIGNATURE_HEADER]:'a'.repeat(64)})),failure('authentication-required'));
});
test('a short secret is a configuration error, not a runtime one',()=>{
  assert.throws(()=>createHmacVerifier({secret:'too-short'}),(error:unknown)=>(error as {code?:string}).code==='configuration-required');
  assert.throws(()=>createHmacVerifier(undefined as never),(error:unknown)=>(error as {code?:string}).code==='configuration-required');
});
