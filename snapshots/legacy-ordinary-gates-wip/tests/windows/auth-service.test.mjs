import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopAuth, readSupabaseConfig } from '../../apps/desktop/main/auth.ts';

const origin = 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co';
const publishableKey = 'sb_publishable_fixture_only_1234567';
const config = readSupabaseConfig({ ORANGE_SUPABASE_URL: origin, ORANGE_SUPABASE_PUBLISHABLE_KEY: publishableKey });
const creds = { email: ' test@example.invalid ', password: 'fixture-only-password' };
const token = 'fixture-only-access-token';
const session = () => Response.json({ access_token: token, expires_in: 3600, refresh_token: 'must-not-cross-boundary' });
const user = (extra = {}) => Response.json({ id: '39c4c4ae-5e7f-46f3-91e0-6cd246c86d2a', is_anonymous: false, ...extra });
function make(...answers) {
  let now = 1_000_000;
  const requests = [];
  const auth = createDesktopAuth(config, async (url, init) => {
    requests.push({ url: String(url), ...init });
    const next = answers.shift();
    assert.ok(next, 'unexpected request');
    return await next();
  }, () => now);
  return { auth, requests, advance: (delta) => { now += delta; } };
}
test('accepts a hosted Supabase origin and only modern publishable keys', () => {
  assert.deepEqual(config, { origin, publishableKey });
  for (const [url, key] of [
    ['http://aaaaaaaaaaaaaaaaaaaa.supabase.co', publishableKey],
    [origin + '/auth/v1', publishableKey],
    [origin + '?x=1', publishableKey],
    ['https://user@aaaaaaaaaaaaaaaaaaaa.supabase.co', publishableKey],
    ['https://aaaaaaaaaaaaaaaaaaaa.supabase.co.example.invalid', publishableKey],
    [origin, 'sb_secret_should_be_rejected'],
    [origin, 'eyJlegacyCannotTellRole'],
  ]) assert.equal(readSupabaseConfig({ ORANGE_SUPABASE_URL: url, ORANGE_SUPABASE_PUBLISHABLE_KEY: key }), null);
});
test('no configuration or malformed credentials cannot call Auth or open the workspace', async () => {
  const unset = createDesktopAuth(null, () => { throw Error('unexpected transport'); });
  assert.deepEqual(unset.getState(), { kind: 'unavailable' });
  assert.equal((await unset.signIn(creds)).error, 'unavailable');
  const { auth, requests } = make();
  assert.equal((await auth.signIn({ email: 'broken', password: 'x' })).error, 'invalid-input');
  assert.equal((await auth.signIn({ ...creds, role: 'admin' })).error, 'invalid-input');
  assert.deepEqual(requests, []);
});
test('password exchange must be followed by authenticated /user before returning only a public signed-in state', async () => {
  const { auth, requests } = make(session, user, () => new Response(null, { status: 204 }));
  assert.deepEqual(auth.getState(), { kind: 'signed-out' });
  assert.deepEqual(await auth.signIn(creds), { state: { kind: 'signed-in' }, error: null });
  assert.equal(requests[0].url, origin + '/auth/v1/token?grant_type=password');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].body), { email: 'test@example.invalid', password: creds.password });
  assert.equal(requests[0].headers.apikey, publishableKey);
  assert.equal(requests[1].url, origin + '/auth/v1/user');
  assert.equal(requests[1].headers.authorization, 'Bearer ' + token);
  assert.deepEqual(await auth.signOut(), { kind: 'signed-out' });
  assert.equal(requests[2].url, origin + '/auth/v1/logout?scope=local');
});
test('invalid password, provider failure, and invalid user response remain signed out', async () => {
  for (const [answers, expected] of [
    [[() => Response.json({ code: 'invalid_credentials', msg: creds.password }, { status: 400 })], 'credentials'],
    [[() => { throw Error(creds.password); }], 'service'],
    [[session, () => new Response('', { status: 401 })], 'verification'],
    [[session, () => user({ is_anonymous: true })], 'verification'],
    [[session, () => user({ factors: [{ status: 'verified' }] })], 'mfa-required'],
    [[() => Response.json({ access_token: token, expires_in: 0 })], 'verification'],
  ]) {
    const { auth } = make(...answers);
    assert.deepEqual(await auth.signIn(creds), { state: { kind: 'signed-out' }, error: expected });
  }
});
test('expiration and local signout are fail-closed even if logout cannot reach the provider', async () => {
  const good = make(session, user);
  await good.auth.signIn(creds);
  good.advance(3_600_000);
  assert.deepEqual(good.auth.getState(), { kind: 'signed-out' });
  const badLogout = make(session, user, () => { throw Error('network unavailable'); });
  await badLogout.auth.signIn(creds);
  assert.deepEqual(await badLogout.auth.signOut(), { kind: 'signed-out' });
});
test('late authentication cannot undo logout and only one exchange can be in flight', async () => {
  let finish;
  const { auth, requests } = make(() => new Promise(resolve => { finish = resolve; }), user);
  const pending = auth.signIn(creds);
  assert.equal((await auth.signIn(creds)).error, 'busy');
  assert.deepEqual(await auth.signOut(), { kind: 'signed-out' });
  finish(session());
  assert.deepEqual((await pending).state, { kind: 'signed-out' });
  assert.equal(requests.length, 1);
});
test('time spent exchanging a token never extends the maximum local lifetime', async () => {
  const fixture = make(() => {
    fixture.advance(7000);
    return Response.json({ access_token: token, expires_in: 60 });
  }, user);
  assert.equal((await fixture.auth.signIn(creds)).state.kind, 'signed-in');
  fixture.advance(53_000);
  assert.deepEqual(fixture.auth.getState(), { kind: 'signed-out' });
});
test('rejects malformed anonymous or MFA fields rather than opening a workspace', async () => {
  for (const malformed of [
    { is_anonymous: 'true' },
    { factors: { status: 'verified' } },
    { factors: [{ status: true }] },
  ]) {
    const { auth } = make(session, () => user(malformed));
    assert.deepEqual(await auth.signIn(creds), { state: { kind: 'signed-out' }, error: 'verification' });
  }
});

test('main-owned expiry notifies subscribers without renderer polling', async () => {
  let now = 0;
  let timer;
  const auth = createDesktopAuth(config, async url => url.includes('/token?') ? Response.json({access_token: token, expires_in: 1}) : user(), () => now, {
    set: callback => { timer = callback; return 1; }, clear: () => { timer = undefined; },
  });
  assert.equal(typeof auth.subscribe, 'function', 'main Auth must publish authorization revocation');
  const states = [];
  auth.subscribe(state => states.push(state.kind));
  await auth.signIn(creds);
  now = 1000;
  timer();
  assert.deepEqual(states, ['signed-in', 'signed-out']);
});

test('logout revokes subscribers synchronously before remote completion', async () => {
  let finish;
  const fixture = make(session, user, () => new Promise(resolve => { finish = resolve; }));
  assert.equal(typeof fixture.auth.subscribe, 'function');
  await fixture.auth.signIn(creds);
  let revoked = false;
  fixture.auth.subscribe(state => { if (state.kind !== 'signed-in') revoked = true; });
  const pending = fixture.auth.signOut();
  assert.equal(revoked, true);
  assert.equal(fixture.auth.getState().kind, 'signed-out');
  finish(new Response(null, {status: 204}));
  await pending;
});
