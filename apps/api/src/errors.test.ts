// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SupplierError,fail,knownCodes,messageOf,statusOf,supplierFailure,supplierStatus,toPublicError} from './errors.ts';

const here=dirname(fileURLToPath(import.meta.url));

test('the supplier status table is frozen to the transcript and unknown codes stay generic',()=>{
  assert.deepEqual(supplierStatus,{
    '0':'provider-unconfirmed',
    '20000':'provider-response-unconfirmed',
    '20001':'provider-timeout',
    '20002':'provider-rate-limited',
    '20010':'provider-company-unconfirmed',
    '20011':'provider-unavailable',
    '20012':'provider-state-unconfirmed',
    '20013':'provider-credential-expired',
    '20014':'provider-credential-rejected',
    '20015':'provider-signature-rejected',
    '20020':'account-not-found',
    '20022':'provider-permission-denied',
  });
  assert.equal(Object.isFrozen(supplierStatus),true);
  for(const unknown of [1,7,99,501,20021,20023,-1,1.5,undefined,null,'20020',NaN,Infinity])assert.equal(supplierFailure(unknown),'provider-unconfirmed',String(unknown));
  assert.equal(supplierFailure(20000),'provider-response-unconfirmed','a supplier parameter rejection is our bug, not a caller mistake');
  assert.equal(supplierFailure(20022),'provider-permission-denied');
});

test('the HTTP mapping is fixed for every code this package can throw',()=>{
  const expected:{[code:string]:number}={
    'invalid-query':422,'unsupported-operation':422,
    'authentication-required':403,'authentication-rejected':403,'lookup-not-authorized':403,
    'binding-required':403,'binding-changed':403,'account-not-authorized':403,'authorization-denied':403,
    'account-disabled':403,'provider-permission-denied':403,'provider-credential-rejected':403,
    'account-not-found':404,'account-ambiguous':409,'provider-rate-limited':429,'provider-credential-expired':401,
    'provider-signature-rejected':502,'provider-redirect-rejected':502,'provider-response-too-large':502,
    'provider-response-unconfirmed':502,'provider-unavailable':502,
    'invalid-configuration':503,'configuration-required':503,'authentication-unconfirmed':503,
    'provider-unconfirmed':503,'provider-auth-unconfirmed':503,'provider-clock-unconfirmed':503,
    'provider-company-unconfirmed':503,'provider-state-unconfirmed':503,'server-credential-required':503,
    'backend-unconfirmed':503,'result-unknown':503,'provider-timeout':504,
  };
  for(const [code,status] of Object.entries(expected))assert.equal(statusOf(code),status,code);
  assert.equal(statusOf('not-a-code'),503);
  assert.equal(new SupplierError('authorization-denied').status,403);
  assert.equal(new SupplierError('provider-response-unconfirmed').status,502);
  assert.equal(new SupplierError('invalid-query',599).status,599);
});

test('every error code the sources can raise is registered, and every registered code has a message',()=>{
  const registered=new Set(knownCodes());
  const raised=new Set<string>();
  for(const file of readdirSync(here).filter(name=>name.endsWith('.ts')&&!name.endsWith('.test.ts'))){
    const source=readFileSync(join(here,file),'utf8');
    for(const match of source.matchAll(/(?:fail|SupplierError)\(\s*'([a-z][a-z-]*)'/g))raised.add(match[1]);
    for(const match of source.matchAll(/error\(\s*'([a-z][a-z-]*)'/g))raised.add(match[1]);
  }
  assert.ok(raised.size>10,'the scan found the raised codes');
  for(const code of raised)assert.ok(registered.has(code),`${code} is raised but not registered`);
  for(const code of knownCodes())assert.notEqual(messageOf(code),'请求失败',`${code} has its own message`);
});

test('a public error carries a code, a status and a fixed message but never the thrown text',()=>{
  const leaky=Object.assign(new SupplierError('provider-unconfirmed'),{message:'secret_company_key pageNo=7 fixture-user'});
  const body=toPublicError(leaky);
  assert.deepEqual(Object.keys(body).sort(),['code','message','status']);
  assert.equal(body.code,'provider-unconfirmed');
  assert.equal(body.status,503);
  assert.doesNotMatch(JSON.stringify(body),/secret_company_key|pageNo|fixture-user/);
  const unknown=toPublicError(new Error('boom fixture-secret'));
  assert.equal(unknown.code,'provider-unconfirmed');
  assert.doesNotMatch(JSON.stringify(unknown),/boom|fixture-secret/);
  assert.throws(()=>fail('account-ambiguous'),(error:unknown)=>(error as {code?:string}).code==='account-ambiguous'&&(error as {status?:number}).status===409);
});
