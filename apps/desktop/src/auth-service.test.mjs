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
const exactResult = (actual, ok, code, kind, reason = null) => {
  assert.deepEqual(Object.keys(actual).sort(), ['code', 'ok', 'state']);
  assert.ok(Object.isFrozen(actual));
  assert.equal(actual.ok, ok);
  assert.equal(actual.code, code);
  exactState(actual.state, kind, reason);
};

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
