import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('./auth-service.mjs').catch(() => null);
test('01 capability: local factory exists without any injected real network', () => {
  assert.equal(typeof module?.createAuthService, 'function');
});
const config = () => ({
  environmentId: 'synthetic-env',
  authOrigin: 'https://auth.invalid',
  publishableKey: 'synthetic-public-key',
  instanceId: 'synthetic-instance',
  epoch: 1,
});
const deps = () => ({
  fetch: async () => {
    throw new Error('synthetic offline');
  },
  monotonicNow: () => 0,
  requestTimeoutMs: 50,
});
test('02 configuration: rejects insecure origin before any transport use', () => {
  assert.throws(() => module.createAuthService({ ...config(), authOrigin: 'http://auth.invalid' }, deps()), {
    message: 'invalid-configuration',
  });
});
import { createProjectAccessPolicy } from '../../../packages/openfilm/studio/server/project-access.mjs';
const { createAuthService } = module;
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const credentials = () => ({ email: 'synthetic@example.invalid', password: ' synthetic 密码 ' });
const user = (extra = {}) => ({ id: A, is_anonymous: false, ...extra });
const session = (extra = {}) => ({
  access_token: 'synthetic-access-sentinel',
  refresh_token: 'synthetic-refresh-sentinel',
  token_type: 'bEaReR',
  expires_in: 10,
  user: { id: A },
  ...extra,
});
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(sequence = [() => json(session()), () => json(user())], options = {}) {
  let now = 100;
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, init });
    const handler = sequence.shift();
    if (!handler) throw new Error('unexpected synthetic request');
    return handler(url, init);
  };
  const service = createAuthService(
    { ...config(), ...options.config },
    { fetch, monotonicNow: () => now, requestTimeoutMs: 30, ...options.deps }
  );
  return {
    service,
    calls,
    setNow: (value) => {
      now = value;
    },
    sequence,
  };
}
const exactState = (actual, kind, reason = null) => {
  assert.deepEqual(actual, { kind, reason });
  assert.ok(Object.isFrozen(actual));
};

test('material registration private capability sends actual binary only to the existing fixed endpoint without changing Auth6',async()=>{
 let request;const h=setup(undefined,{deps:{business:{origin:'http://127.0.0.1:18621',bind:value=>request=value}}});await h.service.signIn(credentials());
 const payload=Uint8Array.from([0,1,255,42]);let sent;
 h.sequence.push(async(url,init)=>{assert.equal(url,'http://127.0.0.1:18621/api/materials/local');assert.equal(init.headers.authorization,'Bearer synthetic-access-sentinel');assert.equal(init.headers['content-type'],'application/octet-stream');assert.equal(init.headers['idempotency-key'],'00000000-0000-4000-8000-000000000003');assert.equal(init.headers['x-material-name'],encodeURIComponent('茶.wav'));assert.equal(init.duplex,'half');const chunks=[];for await(const chunk of init.body)chunks.push(Buffer.from(chunk));sent=Buffer.concat(chunks);return json({assetId:A,versionId:B,registration:'registered',licensed:false});});
 const body=(async function*(){yield payload;})();const result=await request('register',{key:'00000000-0000-4000-8000-000000000003',name:'茶.wav',body},h.service.getVerifiedEvidence());assert.deepEqual(sent,Buffer.from(payload));assert.equal(result.status,200);assert.deepEqual(Object.keys(h.service).sort(),['dispose','getPublicState','getVerifiedEvidence','revalidate','signIn','signOut']);h.service.dispose();
});
const exactResult = (actual, ok, code, kind, reason = null) => {
  assert.deepEqual(Object.keys(actual).sort(), ['code', 'ok', 'state']);
  assert.ok(Object.isFrozen(actual));
  assert.equal(actual.ok, ok);
  assert.equal(actual.code, code);
  exactState(actual.state, kind, reason);
};

test('business capability is private, fixed-origin and accepts only the current evidence and four backend operations', async () => {
  let request;
  const h=setup(undefined,{deps:{business:{origin:'http://127.0.0.1:18572',bind:value=>{request=value;}}}});
  assert.equal(typeof request,'function','trusted construction binds a private request, not a seventh Auth method');
  assert.deepEqual(Object.keys(h.service).sort(),['dispose','getPublicState','getVerifiedEvidence','revalidate','signIn','signOut']);
  await h.service.signIn(credentials());const evidence=h.service.getVerifiedEvidence();
  h.sequence.push((url,init)=>{assert.equal(url,'http://127.0.0.1:18572/api/materials/resolve');assert.equal(init.headers.authorization,'Bearer synthetic-access-sentinel');assert.equal(init.headers.apikey,undefined);assert.equal(init.redirect,'error');return json({materials:[]});});
  assert.deepEqual(await request('resolve',{purpose:'studio',versionIds:[]},evidence),{status:200,data:{materials:[]}});
  await assert.rejects(request('resolve',{}, {...evidence}),e=>/superseded|authentication/.test(e.code));
  await assert.rejects(request('https://foreign.invalid',{},evidence),e=>/invalid-business/.test(e.code));
  assert.doesNotMatch(JSON.stringify(h.service.getPublicState())+JSON.stringify(evidence),/sentinel/);
  h.service.dispose();
});

test('business origins reject normalization tricks and redirects; permission denial alone does not revoke Auth',async()=>{
  for(const origin of ['http://localhost:18572','http://127.1:18572','http://2130706433:18572','https://user:pass@backend.invalid','https://backend.invalid/path',' https://backend.invalid','https://backend.invalid?x','https://backend.invalid#x','https://backend.invalid\\evil'])
    assert.throws(()=>createAuthService(config(),{...deps(),business:{origin,bind(){}}}),/invalid-configuration/);
  let request;const h=setup(undefined,{deps:{business:{origin:'https://backend.invalid',bind:r=>request=r}}});await h.service.signIn(credentials());const evidence=h.service.getVerifiedEvidence();
  h.sequence.push(()=>json({code:'material-access-denied'},403));assert.equal((await request('resolve',{},evidence)).status,403);assert.equal(h.service.getPublicState().kind,'active');
  h.sequence.push(()=>json({},302));await assert.rejects(request('resolve',{},evidence),e=>e.code==='redirect-rejected');
  h.sequence.push(()=>json({code:'authentication-rejected'},403));await assert.rejects(request('resolve',{},evidence),e=>e.code==='authentication-rejected');assert.equal(h.service.getPublicState().kind,'revoked');
});

test('business invalidation aborts synchronously but awaits actual ignored-abort transport and refuses its late response',async()=>{
  let request,signal;const transport=deferred();let entered;const ready=new Promise(r=>entered=r);
  const h=setup(undefined,{deps:{business:{origin:'https://backend.invalid',bind:r=>request=r}}});await h.service.signIn(credentials());const evidence=h.service.getVerifiedEvidence();
  h.sequence.push((url,init)=>{signal=init.signal;entered();return transport.promise;});
  let settled=false;const work=request('claim',{},evidence);void work.then(()=>settled=true,()=>settled=true);await ready;
  h.service.dispose();assert.equal(signal.aborted,true);await pause(5);assert.equal(settled,false,'abort is not actual transport drain');
  transport.resolve(json({status:'reserved'}));await assert.rejects(work,e=>/superseded|disposed/.test(e.code));
});

test('business completion samples expiry before admitting a late successful response',async()=>{
  let request;const h=setup(undefined,{deps:{business:{origin:'https://backend.invalid',bind:r=>request=r}}});await h.service.signIn(credentials());const evidence=h.service.getVerifiedEvidence();
  h.sequence.push(()=>{h.setNow(10100);return json({materials:[]});});await assert.rejects(request('resolve',{},evidence),e=>/expired|superseded/.test(e.code));assert.equal(h.service.getPublicState().kind,'expired');
});

test('business invalid response still awaits actual body cancellation before it can retire',async()=>{
 let request,finish,cancelled=false;const drained=new Promise(r=>finish=r);
 const h=setup(undefined,{deps:{business:{origin:'https://backend.invalid',bind:r=>request=r}}});await h.service.signIn(credentials());
 h.sequence.push(()=>new Response(new ReadableStream({cancel(){cancelled=true;return drained;}}),{headers:{'content-type':'text/plain'}}));
 let settled=false;const work=request('resolve',{},h.service.getVerifiedEvidence());const rejected=assert.rejects(work,e=>e.code==='invalid-response');void work.then(()=>settled=true,()=>settled=true);
 await pause(5);assert.equal(cancelled,true,'entered unread response body must be cancelled');assert.equal(settled,false);finish();await rejected;h.service.dispose();
});

test('business authentication-required rejection is authoritative, unlike a material permission denial',async()=>{
 let request;const h=setup(undefined,{deps:{business:{origin:'https://backend.invalid',bind:r=>request=r}}});await h.service.signIn(credentials());
 h.sequence.push(()=>json({code:'authentication-required'},403));await assert.rejects(request('resolve',{},h.service.getVerifiedEvidence()),e=>e.code==='authentication-rejected');assert.equal(h.service.getPublicState().kind,'revoked');
});

test('03 configuration snapshots refuse traps, unknown fields, unsafe headers and origins', async (t) => {
  for (const [label, changes] of [
    ['userinfo', { authOrigin: 'https://name:pass@auth.invalid' }],
    ['path', { authOrigin: 'https://auth.invalid/x' }],
    ['query', { authOrigin: 'https://auth.invalid/?x' }],
    ['fragment', { authOrigin: 'https://auth.invalid/#x' }],
    ['invisible URL normalization', { authOrigin: ' https://auth.invalid' }],
    ['empty identity', { instanceId: '' }],
    ['epoch zero', { epoch: 0 }],
    ['epoch fractional', { epoch: 1.5 }],
    ['unknown config', { owner: A }],
    ['header newline', { publishableKey: 'synthetic\r\ninjection' }],
    ['secret prefix', { publishableKey: 'sb_secret_synthetic-not-a-key' }],
    [
      'legacy privileged role',
      {
        publishableKey:
          'synthetic.' +
          Buffer.from('{"role":"service_role","fixture":"synthetic-only"}').toString('base64url') +
          '.synthetic',
      },
    ],
    ['oversize header', { publishableKey: 'x'.repeat(8193) }],
  ])
    await t.test(label, () =>
      assert.throws(() => createAuthService({ ...config(), ...changes }, deps()), {
        message: 'invalid-configuration',
      })
    );
  for (const changes of [
    { fetch: undefined },
    { monotonicNow: undefined },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 30001 },
    { requestTimeoutMs: 1.5 },
    { other: 1 },
  ])
    assert.throws(() => createAuthService(config(), { ...deps(), ...changes }), {
      message: 'invalid-configuration',
    });
  let accessed = 0;
  const c = config();
  Object.defineProperty(c, 'authOrigin', {
    get() {
      accessed++;
      return 'https://auth.invalid';
    },
  });
  assert.throws(() => createAuthService(c, deps()), { message: 'invalid-configuration' });
  assert.equal(accessed, 0);
  const proxy = new Proxy(config(), {
    ownKeys() {
      throw new Error('sentinel');
    },
  });
  assert.throws(() => createAuthService(proxy, deps()), { message: 'invalid-configuration' });
  const mutable = config();
  const injected = deps();
  const s = createAuthService(mutable, injected);
  mutable.authOrigin = 'http://wrong.invalid';
  injected.monotonicNow = () => NaN;
  exactState(s.getPublicState(), 'signed-out');
  assert.equal(s.getVerifiedEvidence(), null);
});

test('04 happy chain uses fixed endpoints, preserves password, and feeds actual same-tree policy', async () => {
  const c = config();
  c.authOrigin += '/';
  const h = setup(undefined, { config: c });
  const s = h.service;
  assert.deepEqual(Object.keys(s).sort(), [
    'dispose',
    'getPublicState',
    'getVerifiedEvidence',
    'revalidate',
    'signIn',
    'signOut',
  ]);
  assert.ok(Object.isFrozen(s));
  exactState(s.getPublicState(), 'signed-out');
  const result = await s.signIn(credentials());
  exactResult(result, true, 'ok', 'active');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, 'https://auth.invalid/auth/v1/token?grant_type=password');
  assert.equal(h.calls[0].init.method, 'POST');
  assert.equal(h.calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(h.calls[0].init.body), credentials());
  assert.deepEqual(h.calls[0].init.headers, {
    apikey: 'synthetic-public-key',
    accept: 'application/json',
    'content-type': 'application/json',
  });
  assert.equal(h.calls[1].url, 'https://auth.invalid/auth/v1/user');
  assert.equal(h.calls[1].init.method, 'GET');
  assert.deepEqual(h.calls[1].init.headers, {
    apikey: 'synthetic-public-key',
    accept: 'application/json',
    authorization: 'Bearer synthetic-access-sentinel',
  });
  assert.equal(h.calls[1].init.body, undefined);
  const evidence = s.getVerifiedEvidence();
  assert.deepEqual(evidence, {
    environmentId: 'synthetic-env',
    subjectId: A,
    instanceId: 'synthetic-instance',
    epoch: 1,
    establishedAtMs: 100,
    expiresAtMs: 10100,
  });
  assert.ok(Object.isFrozen(evidence));
  const policy = createProjectAccessPolicy(evidence, { monotonicNow: () => 100 });
  const bound = policy.bindProject({
    environmentId: 'synthetic-env',
    ownerSubjectId: A,
    projectId: '原生id_not_uuid',
    ownership: 'controlled',
    material: { kind: 'metadata-only' },
  });
  assert.equal(bound.allowed, true);
  assert.equal(
    policy.decide(
      {
        environmentId: 'synthetic-env',
        subjectId: A,
        instanceId: 'synthetic-instance',
        epoch: 1,
        projectId: '原生id_not_uuid',
      },
      bound.handle,
      'metadata'
    ).allowed,
    true
  );
});

test('05 input is own-data-only, bounded, snapshotted and never coerced', async (t) => {
  const bad = [
    null,
    [],
    { email: '', password: 'x' },
    { email: 'x'.repeat(321), password: 'x' },
    { email: 'a\nb', password: 'x' },
    { email: 'a', password: '' },
    { email: 'a', password: '密'.repeat(1366) },
    { email: 'a', password: 1 },
    { ...credentials(), owner: A },
    { ...credentials(), epoch: 2 },
  ];
  for (let i = 0; i < bad.length; i++)
    await t.test(`invalid ${i}`, async () => {
      const h = setup();
      const r = await h.service.signIn(bad[i]);
      assert.equal(r.code, 'invalid-input');
      assert.equal(h.calls.length, 0);
    });
  let reads = 0;
  const input = credentials();
  Object.defineProperty(input, 'password', {
    get() {
      reads++;
      return 'x';
    },
  });
  const h = setup();
  assert.equal((await h.service.signIn(input)).code, 'invalid-input');
  assert.equal(reads, 0);
  const d = deferred();
  const h2 = setup([() => d.promise, () => json(user())]);
  const live = credentials();
  const p = h2.service.signIn(live);
  live.password = 'changed';
  d.resolve(json(session()));
  await p;
  assert.equal(JSON.parse(h2.calls[0].init.body).password, ' synthetic 密码 ');
});

test('06 response limits, JSON shape, headers and redirect failures deny activation', async (t) => {
  const cases = [
    [
      'bad JSON',
      () => new Response('{', { headers: { 'content-type': 'application/json' } }),
      'invalid-response',
    ],
    ['non JSON', () => new Response('{}', { headers: { 'content-type': 'text/html' } }), 'invalid-response'],
    [
      'large',
      () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
      'response-too-large',
    ],
    [
      'redirect status',
      () => new Response(null, { status: 302, headers: { location: 'https://other.invalid' } }),
      'redirect-rejected',
    ],
    [
      'redirect flag',
      () => Object.defineProperty(json(session()), 'redirected', { value: true }),
      'redirect-rejected',
    ],
    ['empty access', () => json(session({ access_token: '' })), 'invalid-response'],
    ['unsafe access', () => json(session({ access_token: 'x\ny' })), 'invalid-response'],
    ['large access', () => json(session({ access_token: 'x'.repeat(8193) })), 'invalid-response'],
    ['empty refresh', () => json(session({ refresh_token: '' })), 'invalid-response'],
    ['wrong bearer', () => json(session({ token_type: 'bearer extra' })), 'invalid-response'],
    ['zero lifetime', () => json(session({ expires_in: 0 })), 'invalid-response'],
    ['string lifetime', () => json(session({ expires_in: '10' })), 'invalid-response'],
    ['overflow', () => json(session({ expires_in: 1e308 })), 'invalid-response'],
    ['bad exchange id', () => json(session({ user: { id: 'not-a-provider-subject' } })), 'invalid-response'],
    ['array', () => json([]), 'invalid-response'],
    ['null transport response', () => null, 'invalid-response'],
  ];
  for (const [label, reply, code] of cases)
    await t.test(label, async () => {
      const h = setup([reply]);
      assert.equal((await h.service.signIn(credentials())).code, code);
      assert.equal(h.service.getVerifiedEvidence(), null);
      assert.equal(h.calls.length, 1);
    });
  const encoder = new TextEncoder();
  const prefix = JSON.stringify(session());
  const bytes = encoder.encode(prefix + ' '.repeat(65536 - encoder.encode(prefix).length));
  const h = setup([
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes.slice(0, 65000));
            c.enqueue(bytes.slice(65000));
            c.close();
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      ),
    () => json(user()),
  ]);
  assert.equal((await h.service.signIn(credentials())).ok, true);
  let cancelled = 0;
  const unread = setup([
    () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled++;
            return new Promise(() => {});
          },
        }),
        { headers: { 'content-type': 'text/html' } }
      ),
  ]);
  assert.equal((await unread.service.signIn(credentials())).code, 'invalid-response');
  assert.equal(unread.calls[0].init.signal.aborted, true);
  assert.equal(cancelled, 1);
});

test('07 verified identity, explicit nonanonymous and optional factor rules ignore metadata roles', async (t) => {
  const cases = [
    ['mismatch', user({ id: B }), 'identity-mismatch'],
    ['anonymous', user({ is_anonymous: true }), 'anonymous-user'],
    ['absent anonymous', { id: A }, 'invalid-response'],
    ['wrong anonymous', user({ is_anonymous: 'false' }), 'invalid-response'],
    ['wrong user', [], 'invalid-response'],
    [
      'verified MFA',
      user({ factors: [{ id: 'synthetic-factor', status: 'verified' }] }),
      'unsupported-auth-flow',
    ],
    ['unknown status', user({ factors: [{ status: 'pending' }] }), 'unsupported-auth-flow'],
    ['bad factors', user({ factors: {} }), 'unsupported-auth-flow'],
    ['bad factor', user({ factors: [null] }), 'unsupported-auth-flow'],
  ];
  for (const [label, u, code] of cases)
    await t.test(label, async () => {
      const h = setup([() => json(session()), () => json(u)]);
      assert.equal((await h.service.signIn(credentials())).code, code);
      assert.equal(h.service.getVerifiedEvidence(), null);
    });
  for (const extra of [
    {},
    { factors: [] },
    { factors: [{ status: 'unverified' }] },
    { user_metadata: { role: 'service_role', owner: B }, app_metadata: { role: 'admin' } },
  ]) {
    const h = setup([() => json(session()), () => json(user(extra))]);
    assert.equal((await h.service.signIn(credentials())).ok, true);
    assert.equal(h.service.getVerifiedEvidence().subjectId, A);
  }
  for (const code of ['captcha_failed', 'captcha_required', 'mfa_required']) {
    const h = setup([() => json({ code, message: 'synthetic-prose-not-parsed' }, 400)]);
    assert.equal((await h.service.signIn(credentials())).code, 'unsupported-auth-flow');
    assert.equal(h.calls.length, 1);
  }
  for (const status of [401, 403]) {
    const h = setup([() => json({ message: 'synthetic' }, status)]);
    assert.equal((await h.service.signIn(credentials())).code, 'authentication-rejected');
  }
});

test('08 exchange-start monotonic deadline spends both request latencies and never uses expires_at', async () => {
  const d = deferred(),
    e = deferred();
  const h = setup([() => d.promise, () => e.promise]);
  const p = h.service.signIn(credentials());
  h.setNow(1100);
  d.resolve(json(session({ expires_in: 2, expires_at: 999999999999 })));
  await pause(0);
  assert.equal(h.calls.length, 2);
  h.setNow(2099);
  e.resolve(json(user()));
  assert.equal((await p).ok, true);
  assert.deepEqual(h.service.getVerifiedEvidence(), {
    environmentId: 'synthetic-env',
    subjectId: A,
    instanceId: 'synthetic-instance',
    epoch: 1,
    establishedAtMs: 100,
    expiresAtMs: 2100,
  });
  h.setNow(2100);
  exactState(h.service.getPublicState(), 'expired', 'expired');
  assert.equal(h.service.getVerifiedEvidence(), null);
  const d2 = deferred();
  const h2 = setup([() => d2.promise, () => json(user())]);
  const p2 = h2.service.signIn(credentials());
  h2.setNow(1100);
  d2.resolve(json(session({ expires_in: 1 })));
  assert.equal((await p2).code, 'expired');
  assert.equal(h2.calls.length, 1);
  const d3 = deferred();
  const h3 = setup([() => json(session({ expires_in: 1 })), () => d3.promise]);
  const p3 = h3.service.signIn(credentials());
  await pause(0);
  h3.setNow(1100);
  d3.resolve(json(user()));
  assert.equal((await p3).code, 'expired');
  assert.equal(h3.service.getVerifiedEvidence(), null);
});

test('09 timeout covers ignored-abort fetch and stalled/oversize stream without waiting on cancel', async () => {
  const d = deferred();
  const h = setup([() => d.promise, () => json(user())], { deps: { requestTimeoutMs: 5 } });
  const p = h.service.signIn(credentials());
  assert.equal((await p).code, 'request-timeout');
  assert.equal(h.calls[0].init.signal.aborted, true);
  d.resolve(json(session()));
  await pause(10);
  assert.equal(h.calls.length, 1);
  assert.equal(h.service.getVerifiedEvidence(), null);
  let cancelled = 0;
  const hanging = () =>
    new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled++;
          return new Promise(() => {});
        },
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  const h2 = setup([hanging], { deps: { requestTimeoutMs: 5 } });
  assert.equal((await h2.service.signIn(credentials())).code, 'request-timeout');
  assert.equal(cancelled, 1);
  const h3 = setup([
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(65537));
          },
          cancel() {
            return new Promise(() => {});
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      ),
  ]);
  assert.equal((await h3.service.signIn(credentials())).code, 'response-too-large');
  const h4 = setup([
    () => {
      throw new Error('synthetic-raw-sentinel');
    },
  ]);
  assert.equal((await h4.service.signIn(credentials())).code, 'verification-unconfirmed');
});

test('10 single flight and generation fences reject late sign-in, permit fresh failed-attempt retry', async () => {
  const d = deferred();
  const h = setup([() => d.promise, () => json(session()), () => json(user())]);
  const first = h.service.signIn(credentials());
  exactState(h.service.getPublicState(), 'signing-in');
  assert.equal((await h.service.signIn(credentials())).code, 'busy');
  assert.equal((await h.service.revalidate()).code, 'busy');
  const out = h.service.signOut();
  exactState(h.service.getPublicState(), 'signed-out');
  assert.equal(h.service.getVerifiedEvidence(), null);
  assert.equal((await out).remote, 'not-attempted');
  assert.equal((await first).code, 'superseded');
  const second = h.service.signIn(credentials());
  d.resolve(json(session({ user: { id: B } })));
  assert.equal((await second).ok, true);
  assert.equal(h.service.getVerifiedEvidence().subjectId, A);
  assert.equal(h.calls.length, 3);
  const d2 = deferred();
  const h2 = setup([() => d2.promise]);
  const pending = h2.service.signIn(credentials());
  h2.service.dispose();
  assert.equal((await pending).code, 'disposed');
  d2.resolve(json(session()));
  await pause(0);
  assert.equal(h2.calls.length, 1);
  exactState(h2.service.getPublicState(), 'disposed', 'disposed');
});

test('11 every public clock check is finite, monotonic and sticky; clock reentry cannot revive', async (t) => {
  for (const value of [NaN, Infinity, -1, 99])
    await t.test(String(value), async () => {
      const h = setup();
      await h.service.signIn(credentials());
      h.setNow(value);
      exactState(h.service.getPublicState(), 'clock-anomaly', 'clock-anomaly');
      h.setNow(100);
      assert.equal(h.service.getVerifiedEvidence(), null);
      assert.equal((await h.service.signIn(credentials())).code, 'clock-anomaly');
    });
  let service;
  let recursive = false;
  const h = setup(undefined, {
    deps: {
      monotonicNow: () => {
        if (recursive) service.getPublicState();
        return 100;
      },
    },
  });
  service = h.service;
  await service.signIn(credentials());
  recursive = true;
  exactState(service.getPublicState(), 'clock-anomaly', 'clock-anomaly');
  let s;
  let disposeNow = false;
  const h2 = setup(undefined, {
    deps: {
      monotonicNow: () => {
        if (disposeNow) s.dispose();
        return 100;
      },
    },
  });
  s = h2.service;
  await s.signIn(credentials());
  disposeNow = true;
  exactState(s.getPublicState(), 'disposed', 'disposed');
  const h3 = setup(undefined, {
    deps: {
      monotonicNow: () => {
        throw new Error('synthetic-clock-sentinel');
      },
    },
  });
  assert.equal((await h3.service.signIn(credentials())).code, 'clock-anomaly');
});

test('12 hostile property/transport reentry cannot overwrite disposal or launch online verification', async () => {
  const h = setup();
  const hostile = new Proxy(credentials(), {
    ownKeys() {
      h.service.dispose();
      return ['email', 'password'];
    },
  });
  assert.equal((await h.service.signIn(hostile)).code, 'disposed');
  assert.equal(h.calls.length, 0);
  let service;
  const h2 = setup([
    () => {
      service.dispose();
      return json(session());
    },
    () => json(user()),
  ]);
  service = h2.service;
  assert.equal((await service.signIn(credentials())).code, 'disposed');
  assert.equal(h2.calls.length, 1);
  const h3 = setup([
    () =>
      Object.defineProperty(json(session()), 'status', {
        get() {
          h3.service.dispose();
          return 200;
        },
      }),
    () => json(user()),
  ]);
  assert.equal((await h3.service.signIn(credentials())).code, 'disposed');
  assert.equal(h3.calls.length, 1);
  const h4 = setup();
  const trap = new Proxy(credentials(), {
    getOwnPropertyDescriptor() {
      throw new Error('synthetic-property-sentinel');
    },
  });
  assert.equal((await h4.service.signIn(trap)).code, 'invalid-input');
  assert.equal(h4.calls.length, 0);
  const h5 = setup();
  let replacement;
  const switching = new Proxy(credentials(), {
    ownKeys() {
      h5.service.signOut();
      replacement = h5.service.signIn(credentials());
      return ['email', 'password'];
    },
  });
  assert.equal((await h5.service.signIn(switching)).code, 'superseded');
  assert.equal((await replacement).ok, true);
  assert.equal(h5.service.getVerifiedEvidence().subjectId, A);
  assert.equal(h5.calls.length, 2);
  const h6 = setup([
    () => {
      const response = json(session({ user: { id: B } }));
      Object.defineProperty(response, 'status', {
        get() {
          h6.service.signOut();
          replacement = h6.service.signIn(credentials());
          return 200;
        },
      });
      return response;
    },
    () => json(session()),
    () => json(user()),
  ]);
  assert.equal((await h6.service.signIn(credentials())).code, 'superseded');
  assert.equal((await replacement).ok, true);
  assert.equal(h6.calls.length, 3);
  assert.equal(h6.service.getVerifiedEvidence().subjectId, A);
});

test('13 revalidation unknown retains only finite old rights; known rejection revokes and cannot revive', async (t) => {
  const unknown = [
    [
      'offline',
      () => {
        throw new Error('synthetic');
      },
    ],
    ['timeout', () => new Promise(() => {})],
    ['429', () => json({}, 429)],
    ['500', () => json({}, 500)],
    ['malformed', () => json({ id: A })],
    ['bad JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
    ['factor malformed', () => json(user({ factors: {} }))],
  ];
  for (const [label, reply] of unknown)
    await t.test(label, async () => {
      const h = setup([() => json(session()), () => json(user()), reply], { deps: { requestTimeoutMs: 5 } });
      await h.service.signIn(credentials());
      const old = h.service.getVerifiedEvidence();
      h.setNow(9000);
      const r = await h.service.revalidate();
      assert.equal(r.code, 'verification-unconfirmed');
      assert.equal(r.state.kind, 'active');
      assert.deepEqual(h.service.getVerifiedEvidence(), old);
      h.setNow(10100);
      assert.equal(h.service.getVerifiedEvidence(), null);
      assert.equal((await h.service.revalidate()).code, 'expired');
      assert.equal(h.calls.length, 3);
    });
  const known = [
    ['401', () => new Response(null, { status: 401 }), 'authentication-rejected'],
    [
      '401 stalled body',
      () =>
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        ),
      'authentication-rejected',
    ],
    [
      '403 oversized body',
      () => new Response('x'.repeat(65537), { status: 403, headers: { 'content-type': 'application/json' } }),
      'authentication-rejected',
    ],
    ['403', () => json({}, 403), 'authentication-rejected'],
    ['other subject', () => json(user({ id: B })), 'identity-mismatch'],
    ['anonymous', () => json(user({ is_anonymous: true })), 'anonymous-user'],
    ['verified factor', () => json(user({ factors: [{ status: 'verified' }] })), 'unsupported-auth-flow'],
  ];
  for (const [label, reply, code] of known)
    await t.test(label, async () => {
      const h = setup([() => json(session()), () => json(user()), reply]);
      await h.service.signIn(credentials());
      assert.equal((await h.service.revalidate()).code, code);
      assert.equal(h.service.getPublicState().kind, 'revoked');
      assert.equal(h.service.getVerifiedEvidence(), null);
      assert.equal((await h.service.revalidate()).code, 'not-active');
      assert.equal((await h.service.signIn(credentials())).code, 'switch-required');
    });
  const h = setup([() => json(session()), () => json(user()), () => json(user())]);
  await h.service.signIn(credentials());
  h.setNow(8000);
  assert.equal((await h.service.revalidate()).ok, true);
  assert.equal(h.service.getVerifiedEvidence().expiresAtMs, 10100);
  assert.equal(h.calls[2].url, 'https://auth.invalid/auth/v1/user');
  assert.equal(h.calls[2].init.method, 'GET');
  for (const valid of [true, false]) {
    const d = deferred();
    const pending = setup([() => json(session()), () => json(user()), () => d.promise]);
    await pending.service.signIn(credentials());
    const p = pending.service.revalidate();
    assert.equal((await pending.service.revalidate()).code, 'busy');
    pending.setNow(10100);
    d.resolve(valid ? json(user()) : json({}, 500));
    assert.equal((await p).code, 'expired');
    assert.equal(pending.service.getVerifiedEvidence(), null);
    exactState(pending.service.getPublicState(), 'expired', 'expired');
  }
  const d = deferred();
  const signedOut = setup([
    () => json(session()),
    () => json(user()),
    () => d.promise,
    () => new Response(null, { status: 204 }),
  ]);
  await signedOut.service.signIn(credentials());
  const p = signedOut.service.revalidate();
  await signedOut.service.signOut();
  d.resolve(json(user()));
  assert.equal((await p).code, 'superseded');
  assert.equal(signedOut.service.getVerifiedEvidence(), null);
});

test('14 local logout invalidates synchronously, is idempotent, terminal disposal and latch forbid replacement', async () => {
  const d = deferred();
  const h = setup([() => json(session()), () => json(user()), () => d.promise]);
  await h.service.signIn(credentials());
  const out = h.service.signOut();
  exactState(h.service.getPublicState(), 'signed-out');
  assert.equal(h.service.getVerifiedEvidence(), null);
  assert.equal((await h.service.signIn(credentials())).code, 'switch-required');
  assert.equal((await h.service.signOut()).remote, 'not-attempted');
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].url, 'https://auth.invalid/auth/v1/logout?scope=local');
  assert.equal(h.calls[2].init.method, 'POST');
  d.resolve(new Response(null, { status: 204 }));
  const result = await out;
  assert.deepEqual(result, { state: { kind: 'signed-out', reason: null }, remote: 'acknowledged' });
  assert.ok(Object.isFrozen(result));
  const h2 = setup([() => json(session()), () => json(user()), () => json({}, 500)]);
  await h2.service.signIn(credentials());
  assert.equal((await h2.service.signOut()).remote, 'unconfirmed');
  assert.equal((await h2.service.signIn(credentials())).code, 'switch-required');
  const h3 = setup();
  await h3.service.signIn(credentials());
  h3.setNow(10100);
  assert.equal((await h3.service.signIn(credentials())).code, 'switch-required');
  assert.equal(h3.calls.length, 2);
  const d2 = deferred();
  const h4 = setup([() => json(session()), () => json(user()), () => d2.promise]);
  await h4.service.signIn(credentials());
  const p = h4.service.signOut();
  h4.service.dispose();
  h4.service.dispose();
  d2.resolve(new Response(null, { status: 204 }));
  const r = await p;
  assert.equal(r.state.kind, 'disposed');
  assert.equal(r.remote, 'unconfirmed');
  assert.equal((await h4.service.signOut()).remote, 'not-attempted');
  assert.equal((await h4.service.revalidate()).code, 'disposed');
  assert.equal((await h4.service.signIn(credentials())).code, 'disposed');
});

test('15 public outputs contain no credentials, URL, upstream prose, user, metadata or complete session', async () => {
  const secrets = [
    'synthetic-access-sentinel',
    'synthetic-refresh-sentinel',
    'synthetic-public-key',
    'synthetic@example.invalid',
    ' synthetic 密码 ',
    'https://auth.invalid',
    A,
    'synthetic-raw-error-sentinel',
    'synthetic-private-meta',
  ];
  const h = setup([
    () => json(session()),
    () => json(user({ app_metadata: { private: 'synthetic-private-meta' } })),
    () => {
      throw new Error('synthetic-raw-error-sentinel');
    },
    () => new Response(null, { status: 204 }),
  ]);
  const outputs = [
    h.service.getPublicState(),
    await h.service.signIn(credentials()),
    await h.service.revalidate(),
    await h.service.signIn(credentials()),
    await h.service.signOut(),
    h.service.dispose(),
  ];
  const encoded = JSON.stringify(outputs);
  for (const secret of secrets) assert.equal(encoded.includes(secret), false);
  assert.equal(h.calls.length, 4);
});

test('16 invalidation hook is optional own-data only and is snapshotted', () => {
  let reads = 0;
  for (const value of [undefined, null, 1, {}, 'callback'])
    assert.throws(() => createAuthService(config(), { ...deps(), onInvalidated: value }), { message: 'invalid-configuration' });
  const getter = deps();
  Object.defineProperty(getter, 'onInvalidated', { get() { reads++; return () => {}; } });
  assert.throws(() => createAuthService(config(), getter), { message: 'invalid-configuration' });
  assert.throws(() => createAuthService(config(), Object.assign(Object.create({ onInvalidated() {} }), deps())), { message: 'invalid-configuration' });
  assert.throws(() => createAuthService(config(), { ...deps(), onInvalidated() {}, extra: true }), { message: 'invalid-configuration' });
  assert.equal(reads, 0);
  let notified = 0;
  const d = { ...deps(), onInvalidated() { notified++; } };
  const s = createAuthService(config(), d);
  d.onInvalidated = () => { throw new Error('replacement must not run'); };
  exactState(s.dispose(), 'disposed', 'disposed');
  assert.equal(notified, 1);
});

for (const status of [401, 403]) test(`17 definitive ${status} retires actual policy before abort and body cancellation`, async () => {
  const observations = [];
  let policy, handle, context;
  const observe = (event) => observations.push({ event, allowed: policy.decide(context, handle, 'metadata').allowed });
  const h = setup(undefined, { deps: { onInvalidated(state) {
    exactState(state, 'revoked', 'authentication-rejected');
    assert.equal(h.service.getVerifiedEvidence(), null);
    policy.dispose();
    observe('hook');
  } } });
  assert.equal((await h.service.signIn(credentials())).ok, true);
  policy = createProjectAccessPolicy(h.service.getVerifiedEvidence(), { monotonicNow: () => 100 });
  handle = policy.bindProject({ environmentId: 'synthetic-env', ownerSubjectId: A, projectId: 'synthetic-native-id', ownership: 'controlled', material: { kind: 'metadata-only' } }).handle;
  context = { environmentId: 'synthetic-env', subjectId: A, instanceId: 'synthetic-instance', epoch: 1, projectId: 'synthetic-native-id' };
  assert.equal(policy.decide(context, handle, 'metadata').allowed, true);
  h.sequence.push((_url, init) => {
    init.signal.addEventListener('abort', () => observe('abort'));
    return { status, redirected: false, body: { cancel() { observe('body'); } } };
  });
  const result = await h.service.revalidate();
  exactResult(result, false, 'authentication-rejected', 'revoked', 'authentication-rejected');
  assert.deepEqual(observations, [{ event: 'hook', allowed: false }, { event: 'abort', allowed: false }, { event: 'body', allowed: false }]);
});

for (const action of ['signOut', 'dispose', 'expiry', 'clock']) test(`18 ${action} clears evidence synchronously and notifies before pending abort`, async () => {
  const seen = [];
  const waiting = deferred();
  let notifications = 0;
  let policy, handle, context;
  const h = setup(undefined, { deps: { onInvalidated(state) {
    notifications++;
    policy.dispose();
    assert.ok(Object.isFrozen(state));
    assert.deepEqual(Object.keys(state).sort(), ['kind', 'reason']);
    assert.equal(h.service.getVerifiedEvidence(), null);
    seen.push('hook');
  } } });
  await h.service.signIn(credentials());
  policy = createProjectAccessPolicy(h.service.getVerifiedEvidence(), { monotonicNow: () => 100 });
  handle = policy.bindProject({ environmentId: 'synthetic-env', ownerSubjectId: A, projectId: 'synthetic-native-id', ownership: 'controlled', material: { kind: 'metadata-only' } }).handle;
  context = { environmentId: 'synthetic-env', subjectId: A, instanceId: 'synthetic-instance', epoch: 1, projectId: 'synthetic-native-id' };
  assert.equal(policy.decide(context, handle, 'metadata').allowed, true);
  const abortRights = [];
  h.sequence.push((_url, init) => { init.signal.addEventListener('abort', () => {
    seen.push('abort');
    abortRights.push(policy.decide(context, handle, 'metadata').allowed);
  }); return waiting.promise; });
  const pending = h.service.revalidate();
  if (action === 'signOut') { h.sequence.push(() => new Response(null, { status: 204 })); await h.service.signOut(); }
  if (action === 'dispose') h.service.dispose();
  if (action === 'expiry') { h.setNow(10100); h.service.getPublicState(); }
  if (action === 'clock') { h.setNow(99); h.service.getPublicState(); }
  await pending;
  assert.deepEqual(seen, ['hook', 'abort']);
  assert.deepEqual(abortRights, [false]);
  assert.equal(notifications, 1);
  waiting.resolve(json(user()));
  await pause(0);
  assert.notEqual(h.service.getPublicState().kind, 'active');
});

test('19 unknown revalidation failure keeps original deadline without notifying', async () => {
  let notifications = 0;
  const h = setup(undefined, { deps: { onInvalidated() { notifications++; } } });
  await h.service.signIn(credentials());
  const original = h.service.getVerifiedEvidence();
  h.sequence.push(() => { throw new Error('synthetic offline'); });
  exactResult(await h.service.revalidate(), false, 'verification-unconfirmed', 'active');
  assert.equal(h.service.getVerifiedEvidence(), original);
  assert.equal(notifications, 0);
  h.setNow(10100);
  assert.equal(h.service.getVerifiedEvidence(), null);
  assert.equal(notifications, 1);
});

for (const mode of ['throw', 'rejected-promise', 'thenable']) test(`20 callback ${mode} cannot escape, suppress cancel, or grant rights`, async () => {
  let reads = 0, aborted = 0, notifications = 0;
  const waiting = deferred();
  const h = setup(undefined, { deps: { onInvalidated() {
    notifications++;
    if (mode === 'throw') throw new Error('synthetic-raw-hook-sentinel');
    if (mode === 'rejected-promise') return Promise.reject(new Error('synthetic-raw-hook-sentinel'));
    return { get then() { reads++; throw new Error('synthetic-raw-hook-sentinel'); } };
  } } });
  await h.service.signIn(credentials());
  h.sequence.push((_url, init) => { init.signal.addEventListener('abort', () => aborted++); return waiting.promise; });
  const pending = h.service.revalidate();
  exactState(h.service.dispose(), 'disposed', 'disposed');
  assert.equal((await pending).code, 'disposed');
  await pause(0);
  assert.equal(aborted, 1);
  assert.equal(notifications, 1);
  assert.equal(reads, 0);
  assert.equal(h.service.getVerifiedEvidence(), null);
  waiting.resolve(json(user()));
});

for (const nested of ['dispose', 'signOut', 'clock']) test(`21 nested ${nested} advances terminal state without recursive notification or login`, async () => {
  let calls = 0;
  const outcomes = [];
  const h = setup(undefined, { deps: { onInvalidated() {
    calls++;
    outcomes.push(h.service.signIn(credentials()), h.service.revalidate());
    if (nested === 'dispose') h.service.dispose();
    if (nested === 'signOut') outcomes.push(h.service.signOut());
    if (nested === 'clock') { h.setNow(99); h.service.getPublicState(); }
  } } });
  await h.service.signIn(credentials());
  h.sequence.push(() => ({ status: 401, redirected: false, body: { cancel() {} } }));
  const result = await h.service.revalidate();
  assert.equal(result.ok, false);
  assert.equal(h.service.getPublicState().kind, nested === 'dispose' ? 'disposed' : nested === 'clock' ? 'clock-anomaly' : 'signed-out');
  assert.equal(calls, 1);
  const results = await Promise.all(outcomes);
  assert.equal(results[0].code, 'busy');
  assert.equal(results[1].code, 'busy');
  assert.equal(h.calls.length, 3);
  assert.equal(h.service.getVerifiedEvidence(), null);
});

test('22 notification during preactivation blocks reentrant login and ignores late success', async () => {
  const pendingResponse = deferred();
  const outcomes = [];
  const h = setup([() => pendingResponse.promise], { deps: { onInvalidated() { outcomes.push(h.service.signIn(credentials()), h.service.revalidate()); } } });
  const first = h.service.signIn(credentials());
  await h.service.signOut();
  assert.equal((await first).code, 'superseded');
  assert.equal(outcomes.length, 2);
  for (const r of await Promise.all(outcomes)) assert.equal(r.code, 'busy');
  assert.equal(h.calls.length, 1);
  pendingResponse.resolve(json(session()));
  await pause(0);
  exactState(h.service.getPublicState(), 'signed-out');
});
test('23 native promise rejection sink never reads an overridden then getter', async () => {
  let reads = 0, notifications = 0;
  const s = createAuthService(config(), { ...deps(), onInvalidated() {
    notifications++;
    const p = Promise.reject(new Error('synthetic-raw-hook-sentinel'));
    Object.defineProperty(p, 'then', { get() { reads++; throw new Error('synthetic-raw-hook-sentinel'); } });
    return p;
  } });
  exactState(s.dispose(), 'disposed', 'disposed');
  await pause(0);
  assert.equal(notifications, 1);
  assert.equal(reads, 0);
});

for (const status of [401, 403]) test(`24 initial online ${status} notifies before cancellation and preserves rejection`, async () => {
  const events = [];
  const h = setup([() => json(session()), (_url, init) => {
    init.signal.addEventListener('abort', () => events.push('abort'));
    return { status, redirected: false, body: { cancel() { events.push('body'); } } };
  }], { deps: { onInvalidated(state) {
    exactState(state, 'signed-out', 'authentication-rejected');
    events.push('hook');
  } } });
  exactResult(await h.service.signIn(credentials()), false, 'authentication-rejected', 'signed-out', 'authentication-rejected');
  assert.deepEqual(events, ['hook', 'abort', 'body']);
  assert.equal(h.service.getVerifiedEvidence(), null);
});

for (const [response, reason] of [
  [user({ id: B }), 'identity-mismatch'],
  [user({ is_anonymous: true }), 'anonymous-user'],
  [user({ factors: [{ status: 'verified' }] }), 'unsupported-auth-flow'],
]) test(`25 definitive ${reason} notifies synchronously with no token or evidence`, async () => {
  const states = [];
  const h = setup(undefined, { deps: { onInvalidated(state) {
    states.push(state);
    assert.equal(h.service.getVerifiedEvidence(), null);
  } } });
  await h.service.signIn(credentials());
  h.sequence.push(() => json(response));
  exactResult(await h.service.revalidate(), false, reason, 'revoked', reason);
  assert.deepEqual(states, [{ kind: 'revoked', reason }]);
  assert.equal(JSON.stringify(states).includes('synthetic-access-sentinel'), false);
});

test('26 nested dispose during signOut prevents remote launch and preserves stronger terminal', async () => {
  let notifications = 0;
  const h = setup(undefined, { deps: { onInvalidated() { notifications++; h.service.dispose(); } } });
  await h.service.signIn(credentials());
  const r = await h.service.signOut();
  exactState(r.state, 'disposed', 'disposed');
  assert.equal(r.remote, 'not-attempted');
  assert.equal(h.calls.length, 2);
  assert.equal(notifications, 1);
});
