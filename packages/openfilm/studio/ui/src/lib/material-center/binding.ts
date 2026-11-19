// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Claiming one cloud-steward account for "my materials".
 *
 * The cloud-steward token is the company's; it says nothing about *who* is asking. "My materials" therefore needs the
 * person's own `account_key`, and the one thing that knows it is a claim they make once — no cloud-steward login.
 *
 * Routes (frozen with P1-A): `GET/POST/DELETE /api/materials/binding`; `POST` takes `{account}`. This module is the only
 * place the page talks to them, and it is called by an explicit button press — never by a render, a hover or a filter.
 */
import type {MaterialCopy} from './copy.ts';

export const BINDING_ROUTE = '/api/materials/binding';

/** A claimed account: what "my materials" is scoped to. `status` is the server's word for "this claim is held". */
export type MaterialBinding = {readonly account: string; readonly accountKey: string; readonly status: 'claimed'};

/** A binding failure keeps the server's status and code, so the page can pick its sentence. */
export type BindingFailure = Error & {readonly status: number; readonly code: string};

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const asFailure = (status: number, code: string, message: string): BindingFailure =>
  Object.assign(new Error(message), {status, code});

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The account a person typed: trimmed, 1..200 characters, no control characters; `null` when it is not that. */
export function normalizeBindingAccount(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const account = raw.trim();
  if (!account || account.length > 200 || /[\u0000-\u001f\u007f]/.test(account)) return null;
  return account;
}

function bindingOf(value: unknown): MaterialBinding | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw asFailure(502, 'provider-response-unconfirmed', '绑定结果无法确认，本次不作数。');
  const {account, accountKey, status} = value;
  if (typeof account !== 'string' || !account || typeof accountKey !== 'string' || !accountKey || status !== 'claimed') {
    throw asFailure(502, 'provider-response-unconfirmed', '绑定结果无法确认，本次不作数。');
  }
  return {account, accountKey, status: 'claimed'};
}

export type MaterialBindingClient = {
  /** The claim this Studio holds, or `null` when nobody has claimed one here. */
  read(signal?: AbortSignal): Promise<MaterialBinding | null>;
  /** Claim `account`; resolves with what the server keeps. */
  claim(account: string): Promise<MaterialBinding>;
  /** Drop the claim; resolves with `null` (the unbound state). */
  release(): Promise<null>;
};

export function createMaterialBinding(options: {readonly fetch?: Fetcher; readonly route?: string} = {}): MaterialBindingClient {
  const fetcher: Fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const route = options.route ?? BINDING_ROUTE;

  async function request(method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<MaterialBinding | null> {
    let response: Response;
    try {
      response = await fetcher(route, {
        method,
        ...(body === undefined ? {} : {headers: {'content-type': 'application/json', accept: 'application/json'}, body: JSON.stringify(body)}),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal,
      });
    } catch {
      throw asFailure(503, 'material-service-unavailable', '绑定服务没有响应，本次没有改变绑定。');
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = isRecord(parsed) && typeof parsed.code === 'string' ? parsed.code : 'internal-error';
      throw asFailure(response.status, code, '绑定请求失败（' + response.status + '）。');
    }
    if (!isRecord(parsed) || !('binding' in parsed)) throw asFailure(502, 'provider-response-unconfirmed', '绑定结果无法确认，本次不作数。');
    return bindingOf(parsed.binding);
  }

  return {
    read: signal => request('GET', undefined, signal),
    claim: async account => {
      const clean = normalizeBindingAccount(account);
      /* Nothing typed is not a request: it is the form's own 400-class error, said before any socket. */
      if (!clean) throw asFailure(400, 'invalid-query', '请输入云管家账号。');
      const binding = await request('POST', {account: clean});
      if (!binding) throw asFailure(502, 'provider-response-unconfirmed', '绑定结果无法确认，本次不作数。');
      return binding;
    },
    release: async () => {
      await request('DELETE');
      return null;
    },
  };
}

/** Whether "my materials" can be used: only once an account was claimed. */
export function ownScopeAvailable(binding: MaterialBinding | null | undefined): boolean {
  return binding?.status === 'claimed' && typeof binding.accountKey === 'string' && binding.accountKey.length > 0;
}

/** What a binding change costs: one list refresh, or one forced scope change (which refreshes itself). */
export type BindingRefreshPlan = 'none' | 'refresh' | 'force-company';

/**
 * After a claim or a release: refresh once — and if the person was looking at "my materials" when it went away, move
 * them to the company view first (that `setFilters` is the one refresh; doing both would read twice).
 */
export function bindingRefreshPlan(previous: MaterialBinding | null, next: MaterialBinding | null, author: 'own' | 'company' | {readonly accountKey: string}): BindingRefreshPlan {
  const before = ownScopeAvailable(previous);
  const after = ownScopeAvailable(next);
  if (before === after) return 'none';
  if (!after && author === 'own') return 'force-company';
  return 'refresh';
}

/** The sentence a binding failure earns: the same tiers as the rest of the library, with the account's own 400. */
export function bindingFailureCopy(copy: MaterialCopy, failure: {readonly status?: number; readonly code?: string} | null): string {
  if (!failure) return copy.error;
  if (failure.status === 400 || failure.code === 'invalid-query') return copy.bindingAccountNotFound;
  if (failure.status === 401 || failure.code === 'authentication-required') return copy.authRequired;
  /* Not mounted (an older Studio, or the service is down) is "not connected", not a failure of the person's action. */
  if (failure.status === 501 || failure.status === 404 || failure.status === 405 || failure.code === 'material-service-unavailable') return copy.unavailable;
  return copy.error;
}

/**
 * The sentence for a claim that could not be *read*. It never says "sign in to read cloud materials": the cloud list
 * may have answered 200, and a claim that cannot be read is about "my materials" alone.
 */
export function bindingReadCopy(copy: MaterialCopy, failure: {readonly status?: number; readonly code?: string} | null): string {
  if (!failure) return copy.bindingReadUnknown;
  if (failure.status === 401 || failure.code === 'authentication-required') return copy.bindingReadAuth;
  if (failure.status === 501 || failure.status === 404 || failure.status === 405 || failure.code === 'material-service-unavailable') return copy.bindingReadOffline;
  return copy.bindingReadUnknown;
}

/** The status and code of a binding failure, whether the error carried them or not. */
export function bindingFailureOf(error: unknown): {readonly status: number; readonly code: string} {
  const at = error as {status?: unknown; code?: unknown} | null;
  return {
    status: typeof at?.status === 'number' ? at.status : 500,
    code: typeof at?.code === 'string' ? at.code : 'internal-error',
  };
}

/** What both places that show the claim read: the library's own-scope gate, and Settings → 云管家. */
export type BindingState = {
  /** Whether the claim has been read yet: nothing is claimed or refused before that. */
  readonly known: boolean;
  readonly value: MaterialBinding | null;
  /** The claim could not be read (401/501/…): said about the claim, never about reading cloud material. */
  readonly loadFailure: {readonly status: number; readonly code: string} | null;
  /** The last claim/release was refused: the form says why. */
  readonly actionFailure: {readonly status: number; readonly code: string} | null;
  readonly busy: boolean;
};

export type BindingStore = {
  getState(): BindingState;
  subscribe(listener: (state: BindingState) => void): () => void;
  /** Read the claim once; a second call while one is out shares it. */
  read(signal?: AbortSignal): Promise<void>;
  claim(account: string): Promise<boolean>;
  release(): Promise<boolean>;
  destroy(): void;
};

/**
 * One claim, one store: the material library reads it to decide whether "my materials" exists, and Settings → 云管家
 * claims or releases it. They are two components in two different trees, so the state lives here and both follow it.
 */
export function createBindingStore(client: MaterialBindingClient = createMaterialBinding()): BindingStore {
  const listeners = new Set<(state: BindingState) => void>();
  let state: BindingState = {known: false, value: null, loadFailure: null, actionFailure: null, busy: false};
  let reading: Promise<void> | null = null;
  let live = true;
  const setState = (patch: Partial<BindingState>) => {
    if (!live) return;
    state = {...state, ...patch};
    for (const listener of listeners) listener(state);
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read(signal) {
      if (reading) return reading;
      reading = (async () => {
        setState({loadFailure: null});
        try {
          const value = await client.read(signal);
          setState({known: true, value, loadFailure: null});
        } catch (error) {
          setState({known: true, value: null, loadFailure: bindingFailureOf(error)});
        } finally {
          reading = null;
        }
      })();
      return reading;
    },
    async claim(account) {
      setState({busy: true, actionFailure: null});
      try {
        setState({known: true, value: await client.claim(account), loadFailure: null, busy: false});
        return true;
      } catch (error) {
        setState({busy: false, actionFailure: bindingFailureOf(error)});
        return false;
      }
    },
    async release() {
      setState({busy: true, actionFailure: null});
      try {
        await client.release();
        setState({known: true, value: null, busy: false, loadFailure: null});
        return true;
      } catch (error) {
        setState({busy: false, actionFailure: bindingFailureOf(error)});
        return false;
      }
    },
    destroy() {
      live = false;
      listeners.clear();
    },
  };
}

/** The one store this window shares; a client may be injected before anything else reads it (tests). */
let shared: BindingStore | null = null;
export function sharedBindingStore(client?: MaterialBindingClient): BindingStore {
  shared ??= createBindingStore(client ?? createMaterialBinding());
  return shared;
}
