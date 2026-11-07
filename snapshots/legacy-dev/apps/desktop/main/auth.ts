import type { AuthError, AuthState, LoginInput, LoginResult } from '../auth-contract.ts';

type SupabaseConfig = { origin: string; publishableKey: string };
type Request = (url: string, options: RequestInit) => Promise<Response>;
type Session = { access: string; expiresAt: number };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function readSupabaseConfig(env: NodeJS.ProcessEnv): SupabaseConfig | null {
  const origin = env.ORANGE_SUPABASE_URL?.trim().replace(/\/$/, '');
  const publishableKey = env.ORANGE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!origin || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(origin) ||
    !publishableKey || !/^sb_publishable_[A-Za-z0-9_-]{16,128}$/.test(publishableKey)) return null;
  return { origin, publishableKey };
}

function credentials(value: unknown): LoginInput | null {
  const input = record(value);
  if (!input || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'email') ||
    !Object.hasOwn(input, 'password') || typeof input.email !== 'string' || typeof input.password !== 'string') return null;
  const email = input.email.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !input.password || input.password.length > 512) return null;
  return { email, password: input.password };
}

async function json(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  const text = await response.text();
  if (text.length > 65_536) return null;
  try { return record(JSON.parse(text)); } catch { return null; }
}

export function createDesktopAuth(
  config: SupabaseConfig | null,
  request: Request = (url, options) => fetch(url, options),
  now = () => performance.now(),
  clock: { set: (callback: () => void, delay: number) => unknown; clear: (timer: unknown) => void } = {
    set: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; },
    clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  },
) {
  let session: Session | undefined;
  let generation = 0;
  let pending = false;
  let disposed = false;
  let expiry: unknown;
  const listeners = new Set<(state: AuthState) => void>();
  const state = (): AuthState => ({ kind: !config ? 'unavailable' : session ? 'signed-in' : 'signed-out' });
  function notify() {
    for (const listener of listeners) {
      try { listener(state()); } catch { /* One observer cannot prevent native revocation. */ }
    }
  }
  function revoke() {
    if (expiry !== undefined) clock.clear(expiry);
    expiry = undefined;
    const changed = session !== undefined;
    session = undefined;
    if (changed) notify();
  }
  function armExpiry() {
    if (expiry !== undefined) clock.clear(expiry);
    if (!session) return;
    expiry = clock.set(() => {
      expiry = undefined;
      if (session && session.expiresAt <= now()) revoke();
      else armExpiry();
    }, Math.max(1, session.expiresAt - now()));
  }

  function getState(): AuthState {
    if (session && session.expiresAt <= now()) revoke();
    return { kind: !config ? 'unavailable' : session ? 'signed-in' : 'signed-out' };
  }
  function result(error: AuthError | null): LoginResult { return { state: getState(), error }; }

  const send = (project: SupabaseConfig, route: string, method: 'GET' | 'POST', access?: string, body?: string) =>
    request(project.origin + '/auth/v1/' + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(8_000), body,
      headers: {
        apikey: project.publishableKey,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(access === undefined ? {} : { authorization: 'Bearer ' + access }),
      },
    });

  async function signIn(value: unknown): Promise<LoginResult> {
    if (!config || disposed) return result('unavailable');
    if (pending || getState().kind === 'signed-in') return result('busy');
    const input = credentials(value);
    if (!input) return result('invalid-input');
    const attempt = ++generation;
    pending = true;
    const exchangeStarted = now();
    try {
      const exchanged = await send(config, 'token?grant_type=password', 'POST', undefined, JSON.stringify(input));
      if (attempt !== generation) return result(null);
      const data = await json(exchanged);
      if (attempt !== generation) return result(null);
      if (!exchanged.ok) {
        return result(data?.code === 'invalid_credentials' || data?.code === 'email_not_confirmed' ? 'credentials' : 'service');
      }
      const access = data?.access_token;
      const lifetime = data?.expires_in;
      if (typeof access !== 'string' || !/^[A-Za-z0-9_.-]{10,8192}$/.test(access) ||
        typeof lifetime !== 'number' || !Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > 604_800) {
        return result('verification');
      }
      if (attempt !== generation) return result(null);
      // Local validity cannot be longer than the time remaining at exchange completion.
      const expiresAt = exchangeStarted + lifetime * 1000;
      const verified = await send(config, 'user', 'GET', access);
      const account = verified.ok ? await json(verified) : null;
      if (attempt !== generation) return result(null);
      if (!account || typeof account.id !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(account.id) ||
        (Object.hasOwn(account, 'is_anonymous') && account.is_anonymous !== false) ||
        now() >= expiresAt) return result('verification');
      if (Object.hasOwn(account, 'factors')) {
        if (!Array.isArray(account.factors)) return result('verification');
        const statuses = account.factors.map(f => record(f)?.status);
        if (statuses.some(status => status !== 'verified' && status !== 'unverified')) return result('verification');
        if (statuses.includes('verified')) return result('mfa-required');
      }
      session = { access, expiresAt };
      armExpiry();
      notify();
      return result(null);
    } catch {
      return result(attempt === generation ? 'service' : null);
    } finally {
      pending = false;
    }
  }

  async function signOut(): Promise<AuthState> {
    ++generation;
    getState();
    const previous = session;
    revoke();
    if (config && previous) {
      try { await send(config, 'logout?scope=local', 'POST', previous.access); }
      catch { /* Local access remains closed even if the provider is unreachable. */ }
    }
    return getState();
  }

  function subscribe(listener: (state: AuthState) => void) {
    if (!disposed) listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  function dispose() {
    ++generation;
    disposed = true;
    revoke();
    listeners.clear();
  }
  return { getState, signIn, signOut, subscribe, dispose };
}
