const CONFIG = ['environmentId', 'authOrigin', 'publishableKey', 'instanceId', 'epoch'];
const DEPS = ['fetch', 'monotonicNow', 'requestTimeoutMs'];
const MAX_BYTES = 65536;
const nativeThen = Promise.prototype.then;
const encoder = new TextEncoder();
const finiteTime = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const stableId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x20\x7f]/.test(value);
const subject = (value) =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const header = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Reject accessors and inherited/unknown fields, rather than reading/coercing them.
function snapshot(value, keys) {
  if (!record(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some((key) => !keys.includes(key))) return null;
  const copy = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) return null;
    copy[key] = field.value;
  }
  return copy;
}

function privilegedKey(value) {
  if (value.startsWith('sb_secret_')) return true;
  // Negative validation only. A decoded client assertion never establishes identity.
  try {
    const parts = value.split('.');
    return (
      parts.length === 3 &&
      JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role'
    );
  } catch {
    return false;
  }
}

class Failure {
  constructor(code) {
    this.code = code;
  }
}
const fail = (code) => {
  throw new Failure(code);
};
const unsupportedCode = (data) =>
  record(data) &&
  [data.code, data.error_code].some(
    (code) => typeof code === 'string' && /^(captcha_(failed|required)|mfa_[a-z_]+)$/.test(code)
  );

function inspectUser(data) {
  if (!record(data) || !subject(data.id)) return 'invalid-response';
  if (data.is_anonymous === true) return 'anonymous-user';
  if (data.is_anonymous !== false) return 'invalid-response';
  if (Object.hasOwn(data, 'factors')) {
    if (!Array.isArray(data.factors)) return 'unsupported-auth-flow';
    for (const factor of data.factors) {
      if (!record(factor) || factor.status !== 'unverified') return 'unsupported-auth-flow';
    }
  }
  return null;
}

/**
 * Trusted-native, process-local Auth boundary; not a renderer/IPC API.
 * Requires injected transport and monotonic clock. No environment, persistence,
 * refresh, SDK, background timer or network defaults. Public results omit secrets.
 * Exported scalar evidence cannot revoke copies: policy/view retirement belongs to
 * the future trusted controller. JavaScript string memory is not securely erased.
 */
export function createAuthService(configuration, dependencies) {
  let config, deps, origin;
  try {
    config = snapshot(configuration, CONFIG);
    deps = snapshot(dependencies, DEPS) || snapshot(dependencies, [...DEPS, 'onInvalidated']);
    if (
      !config ||
      !deps ||
      !stableId(config.environmentId) ||
      !stableId(config.instanceId) ||
      !Number.isSafeInteger(config.epoch) ||
      config.epoch <= 0 ||
      typeof config.authOrigin !== 'string' ||
      /[\s\\]/.test(config.authOrigin) ||
      !header(config.publishableKey) ||
      privilegedKey(config.publishableKey) ||
      (Object.hasOwn(deps, 'onInvalidated') && typeof deps.onInvalidated !== 'function') ||
      typeof deps.fetch !== 'function' ||
      typeof deps.monotonicNow !== 'function' ||
      !Number.isInteger(deps.requestTimeoutMs) ||
      deps.requestTimeoutMs < 1 ||
      deps.requestTimeoutMs > 30000
    )
      throw 0;
    const url = new URL(config.authOrigin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !/^https:\/\/[^/?#]+\/?$/.test(config.authOrigin)
    )
      throw 0;
    origin = url.origin;
  } catch {
    throw new Error('invalid-configuration');
  }

  let state = Object.freeze({ kind: 'signed-out', reason: null });
  let generation = 0;
  let flight = null;
  const requests = new Set();
  let session = null;
  let everActivated = false;
  let lastNow;
  let sampling = false;
  let notifying = false;
  const setState = (kind, reason = null) => {
    state = Object.freeze({ kind, reason });
  };
  const hardTerminal = () => state.kind === 'disposed' || state.kind === 'clock-anomaly';

  function invalidate(kind, reason) {
    generation++;
    session = null;
    flight = null;
    setState(kind, reason);
    try {
      if (!notifying && deps.onInvalidated) {
        notifying = true;
        try {
          const returned = deps.onInvalidated(state);
          // Trusted void notification. Do not inspect/assimilate thenables.
          // Native promises get only a defensive rejection sink; species hooks
          // are not a security boundary, so keep reentrancy guarded throughout.
          try {
            nativeThen.call(returned, undefined, () => {});
          } catch {
            /* Not a native promise. */
          }
        } catch {
          /* Notification failure cannot restore authority or escape. */
        } finally {
          notifying = false;
        }
      }
    } finally {
      for (const cancel of [...requests]) cancel();
    }
  }

  function tick() {
    if (hardTerminal() || (sampling && notifying)) return;
    if (sampling) {
      invalidate('clock-anomaly', 'clock-anomaly');
      return;
    }
    sampling = true;
    try {
      const now = deps.monotonicNow();
      // A reentrant clock may have disposed or invalidated the service.
      if (hardTerminal()) return;
      if (!finiteTime(now) || (lastNow !== undefined && now < lastNow))
        invalidate('clock-anomaly', 'clock-anomaly');
      else {
        lastNow = now;
        if (session && now >= session.evidence.expiresAtMs) invalidate('expired', 'expired');
      }
    } catch {
      if (!hardTerminal()) invalidate('clock-anomaly', 'clock-anomaly');
    } finally {
      sampling = false;
    }
  }

  function stopped(operation) {
    tick();
    if (hardTerminal()) return state.kind;
    if (state.kind === 'expired') return 'expired';
    if (operation.generation !== generation)
      return operation.rejectedGeneration === generation ? 'authentication-rejected' : 'superseded';
    return null;
  }
  function check(operation) {
    const code = stopped(operation);
    if (code) fail(code);
  }
  const result = (ok, code) => Object.freeze({ ok, code, state });
  const publicState = () => {
    tick();
    return state;
  };
  const evidence = () => {
    tick();
    return state.kind === 'active' ? session.evidence : null;
  };

  // A separate raced boundary covers transport AND body. Ignored abort/cancel
  // promises cannot hold the caller open, nor can late completion grant rights.
  async function request(operation, path, method, token, body) {
    check(operation);
    const controller = new AbortController();
    let reader;
    let finished = false;
    let rejectBoundary;
    const boundary = new Promise((_, reject) => {
      rejectBoundary = reject;
    });
    const stopReader = () => {
      try {
        Promise.resolve(reader?.cancel()).catch(() => {});
      } catch {
        /* Untrusted stream. */
      }
    };
    const cancel = (code = 'superseded') => {
      if (finished) return;
      finished = true;
      // Settle before invoking callbacks, which may synchronously reenter.
      rejectBoundary(new Failure(code));
      try {
        controller.abort();
      } catch {
        /* Never propagate listener failures. */
      }
      stopReader();
    };
    const invalidateRequest = () =>
      cancel(operation.rejectedGeneration === generation ? 'authentication-rejected' : 'superseded');
    requests.add(invalidateRequest);
    const timer = setTimeout(() => cancel('request-timeout'), deps.requestTimeoutMs);
    const work = (async () => {
      check(operation);
      const headers = { apikey: config.publishableKey, accept: 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await deps.fetch(origin + path, {
        method,
        headers,
        redirect: 'error',
        signal: controller.signal,
        ...(body !== undefined ? { body } : {}),
      });
      check(operation);
      if (finished) fail('superseded');
      if (!record(response)) fail('invalid-response');
      const redirected = response.redirected;
      const status = response.status;
      check(operation);
      if (redirected || (status >= 300 && status <= 399)) fail('redirect-rejected');
      if (!Number.isInteger(status) || status < 100 || status > 599) fail('invalid-response');
      if (status === 204) return { status, data: null };
      // An online 401/403 is definitive even if its error body never completes.
      if (path === '/auth/v1/user' && (status === 401 || status === 403)) {
        // Definitive rejection must retire scalar-evidence consumers BEFORE
        // abort/body callbacks, not later in revalidate's awaited continuation.
        operation.rejectedGeneration = generation + 1;
        invalidate(session ? 'revoked' : 'signed-out', 'authentication-rejected');
        try {
          Promise.resolve(response.body?.cancel()).catch(() => {});
        } catch {
          /* Do not await cancellation. */
        }
        return { status, data: null };
      }
      const contentType = response.headers.get('content-type');
      check(operation);
      // A definitive status is still useful if its body is absent/malformed.
      if (
        typeof contentType !== 'string' ||
        !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)
      ) {
        controller.abort();
        try {
          Promise.resolve(response.body?.cancel()).catch(() => {});
        } catch {
          /* Do not retain or await an unread invalid body. */
        }
        return { status, malformed: true };
      }
      reader = response.body?.getReader();
      check(operation);
      if (!reader) return { status, malformed: true };
      const chunks = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        check(operation);
        if (finished) fail('superseded');
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) fail('invalid-response');
        length += chunk.value.byteLength;
        if (length > MAX_BYTES) fail('response-too-large');
        chunks.push(chunk.value.slice());
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        return { status, data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
      } catch {
        return { status, malformed: true };
      }
    })();
    try {
      const response = await Promise.race([work, boundary]);
      check(operation);
      return response;
    } catch (error) {
      // Preserve only our fixed failure code; upstream exceptions never escape.
      cancel(error instanceof Failure ? error.code : 'verification-unconfirmed');
      throw error instanceof Failure ? error : new Failure('verification-unconfirmed');
    } finally {
      finished = true;
      clearTimeout(timer);
      requests.delete(invalidateRequest);
      try {
        reader?.releaseLock();
      } catch {
        /* A detached late read may still exist. */
      }
    }
  }

  function exchangeData(response, m0) {
    if (unsupportedCode(response.data)) fail('unsupported-auth-flow');
    if (response.status === 401 || response.status === 403) fail('authentication-rejected');
    if (response.status < 200 || response.status >= 300) fail('verification-unconfirmed');
    const data = response.data;
    if (
      response.malformed ||
      !record(data) ||
      !header(data.access_token) ||
      !header(data.refresh_token) ||
      typeof data.token_type !== 'string' ||
      data.token_type.toLowerCase() !== 'bearer' ||
      typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      !record(data.user) ||
      !subject(data.user.id)
    )
      fail('invalid-response');
    const deadline = m0 + 1000 * data.expires_in;
    if (!finiteTime(deadline) || deadline <= m0) fail('invalid-response');
    return { token: data.access_token, subjectId: data.user.id, deadline };
  }

  async function signIn(input) {
    if (notifying) return result(false, 'busy');
    tick();
    if (hardTerminal()) return result(false, state.kind);
    if (everActivated) return result(false, 'switch-required');
    if (flight) return result(false, 'busy');
    const operation = { generation: ++generation };
    flight = operation;
    try {
      const value = snapshot(input, ['email', 'password']);
      check(operation);
      if (
        !value ||
        typeof value.email !== 'string' ||
        value.email.length === 0 ||
        value.email.length > 320 ||
        /[\x00-\x1f\x7f]/.test(value.email) ||
        typeof value.password !== 'string' ||
        value.password.length === 0 ||
        encoder.encode(value.password).byteLength > 4096
      )
        fail('invalid-input');
      const m0 = lastNow;
      setState('signing-in');
      const response = await request(
        operation,
        '/auth/v1/token?grant_type=password',
        'POST',
        null,
        JSON.stringify(value)
      );
      check(operation);
      const candidate = exchangeData(response, m0);
      if (lastNow >= candidate.deadline) {
        invalidate('expired', 'expired');
        fail('expired');
      }
      const online = await request(operation, '/auth/v1/user', 'GET', candidate.token);
      check(operation);
      if (online.status === 401 || online.status === 403) fail('authentication-rejected');
      if (online.status < 200 || online.status >= 300)
        fail(unsupportedCode(online.data) ? 'unsupported-auth-flow' : 'verification-unconfirmed');
      const error = online.malformed ? 'invalid-response' : inspectUser(online.data);
      if (error) fail(error);
      if (online.data.id !== candidate.subjectId) fail('identity-mismatch');
      if (lastNow >= candidate.deadline) {
        invalidate('expired', 'expired');
        fail('expired');
      }
      const verified = Object.freeze({
        environmentId: config.environmentId,
        subjectId: candidate.subjectId,
        instanceId: config.instanceId,
        epoch: config.epoch,
        establishedAtMs: m0,
        expiresAtMs: candidate.deadline,
      });
      session = { token: candidate.token, evidence: verified };
      everActivated = true;
      setState('active');
      return result(true, 'ok');
    } catch (error) {
      const code = stopped(operation) || (error instanceof Failure ? error.code : 'invalid-input');
      if (operation.generation === generation && !hardTerminal() && state.kind !== 'expired')
        setState('signed-out', code);
      return result(false, code);
    } finally {
      if (flight === operation) flight = null;
    }
  }

  async function revalidate() {
    if (notifying) return result(false, 'busy');
    tick();
    if (hardTerminal()) return result(false, state.kind);
    if (flight) return result(false, 'busy');
    if (state.kind !== 'active') return result(false, state.kind === 'expired' ? 'expired' : 'not-active');
    const operation = { generation };
    const previous = session;
    flight = operation;
    try {
      const response = await request(operation, '/auth/v1/user', 'GET', previous.token);
      check(operation);
      let code;
      if (response.status === 401 || response.status === 403) code = 'authentication-rejected';
      else if (
        response.status >= 200 &&
        response.status < 300 &&
        !response.malformed &&
        record(response.data)
      ) {
        if (subject(response.data.id) && response.data.id !== previous.evidence.subjectId)
          code = 'identity-mismatch';
        else if (response.data.is_anonymous === true) code = 'anonymous-user';
        else if (
          Array.isArray(response.data.factors) &&
          response.data.factors.some((factor) => record(factor) && factor.status === 'verified')
        )
          code = 'unsupported-auth-flow';
        else if (!inspectUser(response.data)) return result(true, 'ok');
      }
      if (code) {
        invalidate('revoked', code);
        return result(false, code);
      }
      return result(false, 'verification-unconfirmed');
    } catch {
      return result(false, stopped(operation) || 'verification-unconfirmed');
    } finally {
      if (flight === operation) flight = null;
    }
  }

  async function signOut() {
    // Local invalidation occurs before any await, transport or clock callback.
    const token = session?.token;
    // A repeated local logout must not cancel the first remote acknowledgement.
    if (!token && !flight && state.kind === 'signed-out')
      return Object.freeze({ state: publicState(), remote: 'not-attempted' });
    const logoutGeneration = generation + 1;
    if (!hardTerminal()) invalidate('signed-out', null);
    else {
      session = null;
      generation++;
      for (const cancel of [...requests]) cancel();
    }
    if (!token || hardTerminal() || generation !== logoutGeneration)
      return Object.freeze({ state: publicState(), remote: 'not-attempted' });
    const operation = { generation };
    let remote = 'unconfirmed';
    try {
      const response = await request(operation, '/auth/v1/logout?scope=local', 'POST', token);
      check(operation);
      if (response.status === 204) remote = 'acknowledged';
    } catch {
      /* Local logout is final regardless of remote acknowledgement. */
    }
    return Object.freeze({ state: publicState(), remote });
  }

  function dispose() {
    if (state.kind !== 'disposed') invalidate('disposed', 'disposed');
    return state;
  }

  return Object.freeze({
    getPublicState: publicState,
    signIn,
    revalidate,
    getVerifiedEvidence: evidence,
    signOut,
    dispose,
  });
}
