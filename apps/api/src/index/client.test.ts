// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createIndexClient,RPC_NAMES} from './client.ts';

/**
 * The client is the only thing that may talk to the index, and the tenant is the only thing it may not be told.
 *
 * These tests pin what would break isolation silently rather than loudly:
 *  - an RPC name that the contract does not declare (drift between client and `docs/sql/contract.json`);
 *  - a tenant that travels as a header, or that a caller lifts to the top level of a body;
 *  - a session token that is not passed through verbatim, so the database reads a different tenant than the person.
 */
const here=dirname(fileURLToPath(import.meta.url)); // .../apps/api/src/index
const contract=JSON.parse(readFileSync(join(here,'../../../../docs/sql/contract.json'),'utf8')) as {rpc:Record<string,unknown>};
const contractRpc=Object.keys(contract.rpc);
/** Assembled at runtime so this guard does not match itself (the repository-wide grep must stay at zero). */
const TENANT_HEADER='x-'+'company-key';

const b64url=(value:unknown):string=>Buffer.from(JSON.stringify(value),'utf8').toString('base64url');
/** A session token shaped like the one the auth service issues: the tenant is a claim, not a header. */
const session=(company:string):string=>[
  b64url({alg:'ES256',typ:'JWT'}),
  b64url({sub:'user-1',app_metadata:{company_key:company}}),
  'signature-not-checked-here',
].join('.');
const JWT=session('company-a');

type Call={url:string;headers:Record<string,string>;body:Record<string,unknown>};
function fakeFetch(fail?:{status:number;body:string}){
  const calls:Call[]=[];
  const fetchImpl=(async (url:string,init:RequestInit)=>{
    calls.push({url:String(url),headers:{...(init.headers as Record<string,string>)},body:JSON.parse(String(init.body)) as Record<string,unknown>});
    if(fail)return new Response(fail.body,{status:fail.status});
    const name=String(url).split('/').pop()??'';
    if(name==='search_materials')return Response.json([{video_id:'v1',name:'n',score:0.9,category2_id:'271500',labels:['a'],create_time:null,account_key:'k'}]);
    if(name.startsWith('wiki_'))return Response.json({video_id:'v1',shots:2});
    return Response.json(null);
  }) as unknown as typeof fetch;
  return {calls,fetchImpl};
}
const client=(fetchImpl:typeof fetch,extra:Record<string,unknown>={})=>createIndexClient({baseUrl:'https://db.fixture.test',jwt:JWT,fetch:fetchImpl,...extra} as never);

test('the client knows exactly the RPC names docs/sql/contract.json declares, and no other',()=>{
  // Drift in either direction is a failure: a name the contract does not declare is never sent, and a declared
  // function the client does not know is a hole in the only client.
  assert.deepEqual([...RPC_NAMES].sort(),[...contractRpc].sort());
  for(const name of RPC_NAMES)assert.equal(Object.hasOwn(contract.rpc,name),true,`${name} is declared by the contract`);
  for(const name of contractRpc)assert.equal(RPC_NAMES.includes(name),true,`the contract's ${name} has a client method or is reachable`);
});

test('every RPC name the eight methods send is one the contract declares',async()=>{
  const f=fakeFetch();
  const c=client(f.fetchImpl);
  await c.searchMaterials({query:'warehouse'});
  await c.upsertSummary({video_id:'v1'});
  await c.upsertSource({video_id:'v1'});
  await c.upsertEntity({entity_id:'e1'});
  await c.recordEvent({event_id:'ev1'});
  await c.wikiVideo({videoId:'v1'});
  await c.wikiTimeline({videoId:'v1',from:0,to:12});
  await c.wikiShot({videoId:'v1',index:0});
  assert.equal(f.calls.length,8);
  for(const call of f.calls){
    const name=call.url.split('/').pop() as string;
    assert.equal(contractRpc.includes(name),true,`${name} exists in docs/sql/contract.json`);
    assert.equal(call.url,`https://db.fixture.test/rest/v1/rpc/${name}`);
  }
  assert.deepEqual(f.calls.map(call=>call.url.split('/').pop()),[
    'search_materials','upsert_wiki_summary','upsert_wiki_source','upsert_wiki_entity',
    'record_wiki_event','wiki_video','wiki_timeline','wiki_shot',
  ]);
});

test('no request carries a tenant header: the headers are the token, the content type and the accept',async()=>{
  const f=fakeFetch();
  const c=client(f.fetchImpl);
  await c.searchMaterials({query:'q'});
  await c.wikiVideo({videoId:'v1'});
  await c.upsertSummary({video_id:'v1'});
  for(const call of f.calls){
    assert.deepEqual(Object.keys(call.headers).sort(),['accept','authorization','content-type']);
    assert.equal(TENANT_HEADER in call.headers,false,'a tenant never travels as a header');
    assert.equal('apikey' in call.headers,false,'the anon key is not a tenant');
    assert.doesNotMatch(JSON.stringify(call.headers).toLowerCase(),/company|tenant/);
    assert.equal(call.headers['content-type'],'application/json');
    assert.equal(call.headers.accept,'application/json');
  }
});

test('a body carries p_company_key and parameters only: no company_key, no tenant at the top level',async()=>{
  const f=fakeFetch();
  const c=client(f.fetchImpl);
  await c.searchMaterials({query:'q',filters:{category1:1}});
  await c.upsertSummary({video_id:'v1',company_key:'company-b',tenant:'company-b'});
  await c.wikiTimeline({videoId:'v1',from:1,to:2});
  const shapes:Record<number,string[]>={
    0:['p_company_key','p_filters','p_limit','p_query'],
    1:['p_company_key','p_row'],
    2:['p_company_key','p_from','p_to','p_video_id'],
  };
  for(const [index,keys] of Object.entries(shapes)){
    const body=f.calls[Number(index)].body;
    assert.deepEqual(Object.keys(body).sort(),keys);
    assert.equal('company_key' in body,false,'the tenant is p_company_key or it is nowhere');
    assert.equal('tenant' in body,false);
  }
  // A row is nested under p_row, so a row that names a tenant cannot lift it into the body.
  assert.deepEqual(Object.keys(f.calls[1].body.p_row as Record<string,unknown>).sort(),['company_key','tenant','video_id']);
  assert.equal(f.calls[1].body.p_company_key,'company-a');
});

test('the authorization header is the session token, verbatim',async()=>{
  const f=fakeFetch();
  const token=session('company-a');
  const c=createIndexClient({baseUrl:'https://db.fixture.test',jwt:` ${token} `,fetch:f.fetchImpl});
  await c.searchMaterials({query:'q'});
  assert.equal(f.calls[0].headers.authorization,'Bearer '+token,'the token is not re-encoded, re-cased or replaced');
  assert.equal(f.calls[0].headers.authorization,'Bearer '+JWT);
});

test('the tenant is read from the token, and a caller cannot name another one',async()=>{
  const f=fakeFetch();
  await client(f.fetchImpl).searchMaterials({query:'q'});
  await createIndexClient({baseUrl:'https://db.fixture.test',jwt:session('company-b'),fetch:f.fetchImpl}).searchMaterials({query:'q'});
  // A caller that tries to name a tenant — the shape the old `companyKey` option had — changes nothing at all.
  await createIndexClient({baseUrl:'https://db.fixture.test',jwt:JWT,fetch:f.fetchImpl,companyKey:'company-service'} as never).searchMaterials({query:'q'});
  assert.deepEqual(f.calls.map(call=>call.body.p_company_key),['company-a','company-b','company-a'],
    'the token decides the tenant; an extra option is ignored, not honoured');
  assert.deepEqual(f.calls.map(call=>call.headers.authorization),['Bearer '+JWT,'Bearer '+session('company-b'),'Bearer '+JWT],
    'the credential is never derived from a parameter');
});

test('a session without a tenant claim is refused before anything is sent',async()=>{
  const f=fakeFetch();
  const anonymous=createIndexClient({baseUrl:'https://db.fixture.test',jwt:'not-a-jwt',fetch:f.fetchImpl});
  await assert.rejects(()=>anonymous.searchMaterials({query:'q'}),(error:unknown)=>{
    assert.equal((error as {code?:string}).code,'tenant-context-required');
    return true;
  });
  assert.equal(f.calls.length,0);
});

test('missing configuration throws configuration-required instead of posting',async()=>{
  const f=fakeFetch();
  for(const options of [{jwt:JWT},{baseUrl:'https://db.fixture.test'},{baseUrl:'https://db.fixture.test',jwt:''}]){
    assert.throws(()=>createIndexClient({...options,fetch:f.fetchImpl} as never),(error:unknown)=>{
      assert.equal((error as {code?:string}).code,'configuration-required');
      return true;
    });
  }
  assert.equal(f.calls.length,0);
});

test('the limit is clamped to [1,100] and filters are mapped, nothing else is forwarded',async()=>{
  const f=fakeFetch();
  const c=client(f.fetchImpl);
  await c.searchMaterials({query:'q',limit:1000,filters:{category1:5908,category2:[271500],labels:[7],createdFrom:'2026-11-01',minDurationMs:1000,maxDurationMs:9000,accountKey:'acct',evil:'nope'} as never});
  await c.searchMaterials({limit:0});
  await c.searchMaterials({});
  assert.deepEqual(f.calls.map(call=>call.body.p_limit),[100,1,20]);
  assert.deepEqual(f.calls[0].body.p_filters,{
    category1:5908,category2:[271500],labels:[7],
    created_from:'2026-11-01',min_duration_ms:1000,max_duration_ms:9000,account_key:'acct',
  });
  assert.equal(f.calls[2].body.p_query,null,'an empty query is null, not the empty string');
});

test('an over-long query is refused with invalid-query/422 before it is sent',async()=>{
  const f=fakeFetch();
  await assert.rejects(()=>client(f.fetchImpl).searchMaterials({query:'x'.repeat(201)}),(error:unknown)=>{
    assert.equal((error as {code?:string}).code,'invalid-query');
    assert.equal((error as {status?:number}).status,422);
    return true;
  });
  assert.equal(f.calls.length,0);
});

test('a failed RPC is rpc-failed with its status and at most 512 characters of detail',async()=>{
  const f=fakeFetch({status:403,body:'x'.repeat(900)});
  await assert.rejects(()=>client(f.fetchImpl).upsertSource({video_id:'v1'}),(error:unknown)=>{
    const failure=error as {code?:string;status?:number;detail?:string;message?:string};
    assert.equal(failure.code,'rpc-failed');
    assert.equal(failure.status,403);
    assert.equal(failure.message,'rpc upsert_wiki_source failed');
    assert.equal(failure.detail?.length,512);
    return true;
  });
});

test('the SQL is not copied into the client: the implementation carries no DDL string at all',async()=>{
  const module=await import('./client.ts');
  assert.equal('INDEX_RPC_DDL' in module,false,'the DDL copy was removed, not renamed');
  // The re-export shell cannot prove this; the implementation is what a packaged app runs, so read that.
  const implementation=readFileSync(join(here,'../../../../packages/orangefilm/src/index-client.mjs'),'utf8');
  assert.doesNotMatch(implementation,/create\s+or\s+replace\s+function/i,
    'docs/sql/contract.json is the shape; a SQL string is not kept in the client');
  assert.doesNotMatch(implementation,/from\s+material\s|join\s+wiki_summary|vector\(\d+\)/i,
    'no query text and no vector dimension lives here — the database owns both');
});
