import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAccessPolicy } from './project-access.mjs';

const denied = (reason) => ({allowed:false, reason, view:'lock-hide', recovery:'retain'});

test('missing session evidence creates an inert policy and dispose is terminal', () => {
  const policy = createProjectAccessPolicy(undefined, {monotonicNow: () => 10});
  assert.ok(Object.isFrozen(policy));
  for (const invoke of [() => policy.bindProject({}), () => policy.decide({}, {}, 'metadata'),
    () => policy.revoke({}), () => policy.beginSwitch({}), () => policy.completeSwitch({}, {})]) {
    assert.deepEqual(invoke(), denied('invalid-policy'));
  }
  assert.deepEqual(policy.dispose(), denied('disposed'));
  assert.deepEqual(policy.bindProject({}), denied('disposed'));
});

const session = (overrides = {}) => ({environmentId:'synthetic-development', subjectId:'synthetic-a', instanceId:'synthetic-process', epoch:1, establishedAtMs:0, expiresAtMs:100, ...overrides});
const project = (overrides = {}) => ({environmentId:'synthetic-development', ownerSubjectId:'synthetic-a', projectId:'native_片段-id', ownership:'controlled', material:{kind:'applicable', expiresAtMs:80}, ...overrides});
const context = (overrides = {}) => ({environmentId:'synthetic-development', subjectId:'synthetic-a', instanceId:'synthetic-process', epoch:1, projectId:'native_片段-id', ...overrides});
const sessionContext = (overrides = {}) => ({environmentId:'synthetic-development', subjectId:'synthetic-a', instanceId:'synthetic-process', epoch:1, ...overrides});
const allowed = {allowed:true, reason:'allowed', view:'retain', recovery:'retain'};
function fixture(evidence = session()) {
  let now = 10;
  let calls = 0;
  const policy = createProjectAccessPolicy(evidence, {monotonicNow:() => { calls++; if (now instanceof Error) throw now; return now; }});
  return {policy, setNow:value => {now = value;}, calls:() => calls, bind:evidence => policy.bindProject(evidence ?? project())};
}
function resultIs(result, expected) { assert.deepEqual(result, expected); assert.ok(Object.isFrozen(result)); }
function bound(f = fixture(), evidence = project()) { const result = f.bind(evidence); assert.equal(result.allowed, true); assert.ok(Object.isFrozen(result.handle)); return {...f, handle:result.handle}; }

test('valid original opaque project ID binds and permits exact metadata and restricted contexts', () => {
  const f = bound();
  resultIs(f.policy.decide(context(), f.handle, 'metadata'), allowed);
  resultIs(f.policy.decide(context(), f.handle, 'restricted'), allowed);
  assert.deepEqual(Object.keys(f.policy).sort(), ['beginSwitch','bindProject','completeSwitch','decide','dispose','revoke']);
  assert.deepEqual(Object.keys(f.handle), []);
});

for (const [name, evidence] of [
  ['empty', {}], ['cached', {cached:true}], ['verified flag', {verified:true}],
  ['extra flag', session({verified:true})], ['old cached shape', session({cached:true})],
  ['empty environment', session({environmentId:''})], ['empty subject', session({subjectId:''})],
  ['empty instance', session({instanceId:''})], ['wrong identity type', session({subjectId:5})],
  ['epoch zero', session({epoch:0})], ['epoch fraction', session({epoch:1.5})],
  ['epoch unsafe', session({epoch:Number.MAX_SAFE_INTEGER+1})], ['epoch string', session({epoch:'1'})],
  ['negative establishment', session({establishedAtMs:-1})], ['future establishment', session({establishedAtMs:11})],
  ['expired at initial now', session({expiresAtMs:10})], ['infinite expiry', session({expiresAtMs:Infinity})],
  ['NaN expiry', session({expiresAtMs:NaN})], ['deadline string', session({expiresAtMs:'100'})],
  ['missing expiry', (() => {const s=session(); delete s.expiresAtMs; return s;})()],
]) test(`factory rejects ${name} evidence without treating scalars as authentication`, () => {
  const f = fixture(evidence);
  resultIs(f.bind(), denied('invalid-policy'));
  resultIs(f.policy.beginSwitch(sessionContext()), denied('invalid-policy'));
});

for (const field of ['environmentId','subjectId','instanceId','epoch']) test(`request ${field} mismatch cannot grant or mutate policy`, () => {
  const f = bound(); const value = field === 'epoch' ? 2 : 'synthetic-other';
  resultIs(f.policy.decide(context({[field]:value}), f.handle, 'restricted'), denied('identity-mismatch'));
  resultIs(f.policy.revoke(sessionContext({[field]:value})), denied('identity-mismatch'));
  resultIs(f.policy.beginSwitch(sessionContext({[field]:value})), denied('identity-mismatch'));
  resultIs(f.policy.decide(context(), f.handle, 'restricted'), allowed);
});

test('old instance and epoch cannot use a newly established policy or transfer old handles', () => {
  const old = bound(); const fresh = bound(fixture(session({instanceId:'synthetic-next', epoch:2})));
  resultIs(fresh.policy.decide(context(), fresh.handle, 'restricted'), denied('identity-mismatch'));
  resultIs(fresh.policy.revoke(sessionContext()), denied('identity-mismatch'));
  resultIs(fresh.policy.decide(context({instanceId:'synthetic-next',epoch:2}), old.handle, 'restricted'), denied('unknown-project'));
  resultIs(fresh.policy.decide(context({instanceId:'synthetic-next',epoch:2}), fresh.handle, 'restricted'), allowed);
});

for (const [name, evidence, reason] of [
  ['unknown ownership', project({ownership:'unknown'}), 'ownership-unproven'],
  ['other owner', project({ownerSubjectId:'synthetic-b'}), 'owner-mismatch'],
  ['other environment', project({environmentId:'synthetic-other'}), 'identity-mismatch'],
  ['missing owner', project({ownerSubjectId:undefined}), 'invalid-input'],
  ['empty ID', project({projectId:''}), 'invalid-input'],
  ['wrong ownership', project({ownership:true}), 'invalid-input'],
  ['extra field', project({expiresAtMs:1000}), 'invalid-input'],
]) test(`binding rejects ${name}`, () => { resultIs(fixture().bind(evidence), denied(reason)); });

for (const [name, material] of [
  ['missing', undefined], ['null', null], ['empty', {}], ['wrong discriminator key', {type:'applicable',expiresAtMs:80}],
  ['unknown kind', {kind:'unlimited'}], ['nested deadline', {kind:'applicable',deadline:{expiresAtMs:80}}],
  ['TTL', {kind:'applicable',ttlMs:80}], ['extra applicable key', {kind:'applicable',expiresAtMs:80,ttlMs:80}],
  ['missing applicable expiry', {kind:'applicable'}], ['string expiry', {kind:'applicable',expiresAtMs:'80'}],
  ['negative expiry', {kind:'applicable',expiresAtMs:-1}], ['NaN expiry', {kind:'applicable',expiresAtMs:NaN}],
  ['infinite expiry', {kind:'applicable',expiresAtMs:Infinity}], ['metadata deadline', {kind:'metadata-only',expiresAtMs:80}],
  ['array', []],
]) test(`material ${name} fails closed`, () => { resultIs(fixture().bind(project({material})), denied('material-required')); });

test('metadata-only permits metadata but never restricted access', () => {
  const f = bound(fixture(), project({material:{kind:'metadata-only'}}));
  resultIs(f.policy.decide(context(), f.handle, 'metadata'), allowed);
  resultIs(f.policy.decide(context(), f.handle, 'restricted'), denied('material-required'));
  f.setNow(99); resultIs(f.policy.decide(context(), f.handle, 'metadata'), allowed);
});

test('bindings are idempotent only for identical snapshots and cannot renew or shorten deadlines', () => {
  const f = bound();
  assert.equal(f.bind(project()).handle, f.handle);
  for (const evidence of [project({material:{kind:'applicable',expiresAtMs:81}}), project({material:{kind:'applicable',expiresAtMs:79}}), project({material:{kind:'metadata-only'}})]) {
    resultIs(f.bind(evidence), denied('invalid-input'));
  }
  f.setNow(80); resultIs(f.policy.decide(context(), f.handle, 'restricted'), denied('expired'));
  resultIs(f.bind(project({material:{kind:'applicable',expiresAtMs:90}})), denied('invalid-input'));
});

test('session, project, material and request mutation cannot change captured rights', () => {
  const s = session(); const p = project(); const f = bound(fixture(s),p); const c = context();
  s.expiresAtMs=1000; s.subjectId='synthetic-b'; p.ownerSubjectId='synthetic-b'; p.material.expiresAtMs=1000; p.material.kind='metadata-only';
  resultIs(f.policy.decide(c, f.handle, 'restricted'), allowed);
  c.epoch=2; resultIs(f.policy.decide(c, f.handle, 'restricted'), denied('identity-mismatch'));
  f.setNow(80); resultIs(f.policy.decide(context(), f.handle, 'restricted'), denied('expired'));
});

test('frozen results, policy methods and handles cannot be changed into a grant', () => {
  const f=bound(); const no=f.policy.decide(context(), {}, 'restricted');
  assert.throws(() => {no.allowed=true;}, TypeError);
  assert.throws(() => {f.handle.projectId='forged';}, TypeError);
  assert.throws(() => {f.policy.decide=() => allowed;}, TypeError);
  resultIs(f.policy.decide(context(), {...f.handle}, 'restricted'), denied('unknown-project'));
  resultIs(f.policy.decide(context({projectId:'other-native'}), f.handle, 'restricted'), denied('identity-mismatch'));
  const other=bound(); resultIs(f.policy.decide(context(), other.handle, 'restricted'), denied('unknown-project'));
});

for (const access of [undefined, '', 'media', {}, true]) test(`unknown access ${typeof access}:${String(access)} cannot grant`, () => {
  const f=bound(); resultIs(f.policy.decide(context(), f.handle, access), denied('invalid-input'));
});
for (const [name, c] of [['missing',{}],['extra',context({expiresAtMs:1000})],['wrong epoch',context({epoch:'1'})],['missing ID',sessionContext()],['array',[]]]) test(`malformed request ${name} rejected without renewal`, () => {
  const f=bound(); resultIs(f.policy.decide(c, f.handle, 'restricted'), denied('invalid-input'));
});

test('earliest absolute material cutoff expires only its project at equality', () => {
  const f=bound(); const unrelated=f.bind(project({projectId:'second-native',material:{kind:'applicable',expiresAtMs:95}})).handle;
  f.setNow(79); resultIs(f.policy.decide(context(), f.handle, 'restricted'), allowed);
  f.setNow(80); resultIs(f.policy.decide(context(), f.handle, 'metadata'), denied('expired'));
  resultIs(f.policy.decide(context({projectId:'second-native'}), unrelated, 'restricted'), allowed);
  assert.equal(f.bind(project({projectId:'third-native',material:{kind:'metadata-only'}})).allowed,true);
});

test('session expiry wins over later material expiry and remains terminal', () => {
  const f=bound(fixture(),project({material:{kind:'applicable',expiresAtMs:200}}));
  f.setNow(99); resultIs(f.policy.decide(context(), f.handle, 'restricted'), allowed);
  f.setNow(100); resultIs(f.policy.decide(context(), f.handle, 'restricted'), denied('expired'));
  f.setNow(10); resultIs(f.policy.decide(context(), f.handle, 'metadata'), denied('expired'));
  resultIs(f.policy.beginSwitch(sessionContext()), denied('expired'));
});

test('already expired material cannot bind and metadata absence never defaults unlimited', () => {
  resultIs(fixture().bind(project({material:{kind:'applicable',expiresAtMs:10}})),denied('expired'));
});

for (const [name, time] of [['rollback',9],['negative',-1],['NaN',NaN],['infinity',Infinity],['string','11'],['throw',new Error('SYNTHETIC_SENSITIVE_SENTINEL')]]) test(`clock ${name} is sticky and never leaks its input`, () => {
  const f=bound(); f.setNow(time);
  resultIs(f.policy.decide(context(), f.handle, 'restricted'), denied('clock-anomaly'));
  f.setNow(11); resultIs(f.policy.decide(context(), f.handle, 'metadata'), denied('clock-anomaly'));
  resultIs(f.policy.revoke(sessionContext()), denied('clock-anomaly'));
  resultIs(f.policy.beginSwitch(sessionContext()), denied('clock-anomaly'));
});

test('same monotonic reading is allowed and each active call samples once', () => {
  const f=fixture(); assert.equal(f.calls(),1); const before=f.calls(); const b=f.bind(); assert.equal(f.calls(),before+1);
  resultIs(f.policy.decide(context(),b.handle,'restricted'),allowed); assert.equal(f.calls(),before+2);
  resultIs(f.policy.revoke(sessionContext({epoch:2})),denied('identity-mismatch')); assert.equal(f.calls(),before+3);
  const barrier=f.policy.beginSwitch(sessionContext()); assert.equal(f.calls(),before+4);
  const done=f.policy.completeSwitch(sessionContext(),barrier.handle); assert.equal(done.allowed,true); assert.equal(f.calls(),before+5);
});

test('known revoke locks and hides immediately, preserves recovery and cannot be undone', () => {
  const f=bound(); resultIs(f.policy.revoke(sessionContext()),denied('revoked'));
  resultIs(f.policy.decide(context(), f.handle, 'metadata'),denied('revoked'));
  resultIs(f.bind(),denied('revoked')); resultIs(f.policy.beginSwitch(sessionContext()),denied('revoked'));
});

test('switch blocks all normal access until trusted matching one-use completion retires A', () => {
  const f=bound(); const b=f.policy.beginSwitch(sessionContext()); assert.equal(b.allowed,true); assert.ok(Object.isFrozen(b.handle));
  resultIs(f.policy.decide(context(),f.handle,'restricted'),denied('switching'));
  resultIs(f.bind(project({projectId:'not-yet-bound'})),denied('switching'));
  resultIs(f.policy.beginSwitch(sessionContext()),denied('switching'));
  resultIs(f.policy.completeSwitch(sessionContext(),{...b.handle}),denied('switch-not-ready'));
  resultIs(f.policy.completeSwitch(sessionContext({epoch:2}),b.handle),denied('identity-mismatch'));
  resultIs(f.policy.completeSwitch(sessionContext(),b.handle),{allowed:true,reason:'retired',view:'lock-hide',recovery:'retain'});
  resultIs(f.policy.completeSwitch(sessionContext(),b.handle),denied('retired'));
  resultIs(f.policy.decide(context(),f.handle,'metadata'),denied('retired'));
  const next=bound(fixture(session({subjectId:'synthetic-b',epoch:2})),project({ownerSubjectId:'synthetic-b'}));
  resultIs(next.policy.decide(context({subjectId:'synthetic-b',epoch:2}),f.handle,'restricted'),denied('unknown-project'));
});

test('switch requires a real local barrier, not preserved or forced fields or cross-policy handles', () => {
  const f=bound(); resultIs(f.policy.completeSwitch(sessionContext(),{}),denied('switch-not-ready'));
  const b=f.policy.beginSwitch(sessionContext());
  resultIs(f.policy.completeSwitch(sessionContext({preserved:true}),b.handle),denied('invalid-input'));
  const other=bound(); const otherBarrier=other.policy.beginSwitch(sessionContext());
  resultIs(f.policy.completeSwitch(sessionContext(),otherBarrier.handle),denied('switch-not-ready'));
  resultIs(f.policy.decide(context(),f.handle,'metadata'),denied('switching'));
});

for (const [name, expiry] of [['material',80],['session',100]]) test(`switch completion at ${name} expiry cannot activate B or discard barrier`, () => {
  const f=bound(fixture(),project({material:{kind:'applicable',expiresAtMs:name==='session'?200:80}}));
  const b=f.policy.beginSwitch(sessionContext()); f.setNow(expiry);
  resultIs(f.policy.completeSwitch(sessionContext(),b.handle),denied('expired'));
  resultIs(f.policy.decide(context(),f.handle,'restricted'),denied(name==='session'?'expired':'switching'));
  resultIs(f.policy.completeSwitch(sessionContext(),b.handle),denied('expired'));
});

test('all bound applicable grants must survive switch completion, even an unselected project', () => {
  const f=bound(); f.bind(project({projectId:'earlier-native',material:{kind:'applicable',expiresAtMs:20}}));
  const b=f.policy.beginSwitch(sessionContext()); f.setNow(20);
  resultIs(f.policy.completeSwitch(sessionContext(),b.handle),denied('expired'));
});

test('revoke during switch prevents trusted completion and dispose is terminal in every phase', () => {
  const f=bound(); const b=f.policy.beginSwitch(sessionContext()); f.policy.revoke(sessionContext());
  resultIs(f.policy.completeSwitch(sessionContext(),b.handle),denied('revoked'));
  resultIs(f.policy.dispose(),denied('disposed'));
  for (const op of [() => f.policy.decide(context(),f.handle,'metadata'), () => f.bind(), () => f.policy.revoke(sessionContext()), () => f.policy.beginSwitch(sessionContext()), () => f.policy.completeSwitch(sessionContext(),b.handle), () => f.policy.dispose()]) resultIs(op(),denied('disposed'));
});

const hostile = () => [
  Object.defineProperty({}, 'environmentId', {get() {throw new Error('SYNTHETIC_SENSITIVE_SENTINEL');}, enumerable:true}),
  new Proxy({}, {ownKeys() {throw new Error('SYNTHETIC_SENSITIVE_SENTINEL');}}),
  new Proxy({}, {getPrototypeOf() {throw new Error('SYNTHETIC_SENSITIVE_SENTINEL');}}),
  Object.create({environmentId:'inherited'}),
];
for (let i=0;i<4;i++) test(`hostile evidence ${i} never leaks exceptions and cannot grant`, () => {
  const bad=hostile()[i]; const f=bound();
  resultIs(createProjectAccessPolicy(bad,{monotonicNow:()=>10}).bindProject(project()),denied('invalid-policy'));
  resultIs(f.bind(bad),denied('invalid-input'));
  resultIs(f.policy.decide(bad,f.handle,'restricted'),denied('invalid-input'));
  resultIs(f.policy.revoke(bad),denied('invalid-input'));
  resultIs(f.policy.beginSwitch(bad),denied('invalid-input'));
  const b=f.policy.beginSwitch(sessionContext()); resultIs(f.policy.completeSwitch(bad,b.handle),denied('invalid-input'));
});

test('hostile option and nested material accessors produce only safe fixed outcomes', () => {
  const options=Object.defineProperty({},'monotonicNow',{get(){throw new Error('SYNTHETIC_SENSITIVE_SENTINEL');},enumerable:true});
  resultIs(createProjectAccessPolicy(session(),options).bindProject(project()),denied('invalid-policy'));
  const f=fixture(); const material=Object.defineProperty({kind:'applicable'},'expiresAtMs',{get(){throw new Error('SYNTHETIC_SENSITIVE_SENTINEL');},enumerable:true});
  resultIs(f.bind(project({material})),denied('material-required'));
});

test('hostile snapshot traps cannot grant after synchronous trusted revocation', () => {
  const f=bound(); let once=false;
  const c=new Proxy(context(),{getOwnPropertyDescriptor(target,key){if(!once){once=true; f.policy.revoke(sessionContext());} return Reflect.getOwnPropertyDescriptor(target,key);}});
  resultIs(f.policy.decide(c,f.handle,'restricted'),denied('revoked'));
  resultIs(f.policy.decide(context(),f.handle,'metadata'),denied('revoked'));
});

test('hostile snapshot traps cannot retire or bind after synchronous disposal', () => {
  for (const operation of ['bind','complete']) {
    const f=bound(); const barrier=f.policy.beginSwitch(sessionContext());
    const input=operation==='bind'?project({projectId:'new-native'}):sessionContext(); let once=false;
    const hostile=new Proxy(input,{getOwnPropertyDescriptor(target,key){if(!once){once=true;f.policy.dispose();}return Reflect.getOwnPropertyDescriptor(target,key);}});
    if(operation==='bind') resultIs(f.policy.bindProject(hostile),denied('switching'));
    else resultIs(f.policy.completeSwitch(hostile,barrier.handle),denied('disposed'));
    if(operation==='complete') resultIs(f.policy.decide(context(),f.handle,'metadata'),denied('disposed'));
  }
});

test('malformed session-only contexts cannot smuggle project IDs or force flags into mutators', () => {
  const f=bound();
  resultIs(f.policy.revoke(context()),denied('invalid-input'));
  resultIs(f.policy.beginSwitch(sessionContext({force:true})),denied('invalid-input'));
  resultIs(f.policy.decide(context(),f.handle,'restricted'),allowed);
});

test('initial hostile clocks and missing clock options never create an active policy', () => {
  for(const options of [undefined,{}, {monotonicNow:3}, {monotonicNow:()=>-1}, {monotonicNow:()=>Infinity}, {monotonicNow:()=>{throw new Error('SYNTHETIC_SENSITIVE_SENTINEL');}}]) {
    resultIs(createProjectAccessPolicy(session(),options).bindProject(project()),denied('invalid-policy'));
  }
});

test('clock callback reentrancy cannot undo terminal disposal even with an expired reading', () => {
  let policy; let disposeFromClock=false;
  policy=createProjectAccessPolicy(session(),{monotonicNow:()=>{
    if(disposeFromClock) {disposeFromClock=false;policy.dispose();return 100;}
    return 10;
  }});
  const b=policy.bindProject(project()); disposeFromClock=true;
  resultIs(policy.decide(context(),b.handle,'restricted'),denied('disposed'));
  resultIs(policy.decide(context(),b.handle,'metadata'),denied('disposed'));
});

test('captured session expiry cannot be renewed by changing the original evidence', () => {
  const s=session(); const f=bound(fixture(s),project({material:{kind:'applicable',expiresAtMs:200}}));
  s.expiresAtMs=1000; f.setNow(100);
  resultIs(f.policy.decide(context(),f.handle,'restricted'),denied('expired'));
});

test('metadata-only grants do not prevent valid switch completion before session expiry', () => {
  const f=bound(fixture(),project({material:{kind:'metadata-only'}})); const b=f.policy.beginSwitch(sessionContext());
  f.setNow(99); resultIs(f.policy.completeSwitch(sessionContext(),b.handle),{allowed:true,reason:'retired',view:'lock-hide',recovery:'retain'});
});
