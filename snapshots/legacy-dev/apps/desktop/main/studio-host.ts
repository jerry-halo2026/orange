import { studioShellInset, type StudioState } from '../studio-contract.ts';
import type { AuthState } from '../auth-contract.ts';
import type { OnBeforeRequestListenerDetails, WebFrameMain } from 'electron';

type MountedStudio = { close(): Promise<void> };
type NativeAuth = {
  getState(): AuthState;
  subscribe(listener: (state: AuthState) => void): () => void;
};

// Main-only lifecycle. The injected factory is an internal native dependency,
// never a renderer capability or alternate authentication source.
export function createStudioController(auth: NativeAuth,
  mount: (authorized: () => boolean, onFailure: () => void, onInvalidate: (revoke: () => void) => void) => Promise<MountedStudio>) {
  let epoch = 0;
  let disposed = false;
  let state: StudioState = { kind: 'closed', error: null };
  let active: MountedStudio | undefined;
  let cancelMount: (() => void) | undefined;
  let opening: Promise<StudioState> | undefined;
  const authorized = () => !disposed && auth.getState().kind === 'signed-in';
  const stop = (error: Extract<StudioState, {kind:'closed'}>['error'] = null) => {
    ++epoch;
    state = { kind: 'closed', error };
    opening = undefined;
    const revoke = cancelMount;
    cancelMount = undefined;
    try { revoke?.(); } catch { /* Continue closing all native resources. */ }
    const previous = active;
    active = undefined;
    try { return previous ? Promise.resolve(previous.close()).catch(() => {}) : Promise.resolve(); }
    catch { return Promise.resolve(); }
  };
  const unsubscribe = auth.subscribe(next => {
    if (next.kind !== 'signed-in') void stop('auth-required');
  });
  function getState(): StudioState {
    if (!authorized() && state.kind !== 'closed') void stop('auth-required');
    return { ...state };
  }
  function open(): Promise<StudioState> {
    if (!authorized()) { void stop(disposed ? 'unavailable' : 'auth-required'); return Promise.resolve(getState()); }
    if (opening) return opening;
    if (active) return Promise.resolve(getState());
    const attempt = ++epoch;
    state = { kind: 'opening', error: null };
    const current = () => attempt === epoch && authorized();
    const failed = () => { if (attempt === epoch) void stop('failed'); };
    // Capture even synchronous factory throws; the factory starts immediately.
    let mounting: Promise<MountedStudio>;
    try { mounting = mount(current, failed, revoke => { if (current()) cancelMount = revoke; else revoke(); }); } catch { mounting = Promise.reject(Error()); }
    const result = (async (): Promise<StudioState> => {
      try {
        const mounted = await mounting;
        if (!current()) { await mounted.close(); return getState(); }
        active = mounted;
        state = { kind: 'open', error: null };
      } catch {
        if (attempt === epoch) await stop(authorized() ? 'failed' : 'auth-required');
      } finally {
        if (attempt === epoch) opening = undefined;
      }
      return getState();
    })();
    if (attempt === epoch) opening = result;
    return result;
  }
  async function close(): Promise<StudioState> { await stop(); return getState(); }
  async function dispose() { disposed = true; unsubscribe(); await stop(); }
  return { getState, open, close, dispose };
}

export function studioBounds(bounds: { width: number; height: number }) {
  if (!Number.isSafeInteger(bounds.width) || !Number.isSafeInteger(bounds.height) ||
    bounds.width <= 0 || bounds.height <= studioShellInset) return null;
  return { x: 0, y: studioShellInset, width: bounds.width, height: Math.max(0, bounds.height - studioShellInset) };
}

type TransportPolicy = {
  studioOrigin: string;
  previewOrigin: string;
  route(url: string, method: string): string | undefined;
};
type Request = Pick<OnBeforeRequestListenerDetails, 'url' | 'method' | 'webContentsId' |
  'resourceType' | 'initiatorOrigin' | 'frame'>;
export function studioRequestAllowed(request: Request, policy: {
  transport: TransportPolicy; main: WebFrameMain; webContentsId: number; bootstrap: boolean; authorized: boolean;
}): boolean {
  if (!policy.authorized || request.webContentsId !== policy.webContentsId) return false;
  const { transport, main, bootstrap } = policy;
  const same = (a: WebFrameMain | undefined | null, b: WebFrameMain) =>
    a?.processId === b.processId && a.routingId === b.routingId;
  const { frame, resourceType: type, initiatorOrigin: initiator, method } = request;
  const route = transport.route(request.url, method);
  if (route === 'document') return bootstrap && method === 'GET' && type === 'mainFrame' &&
    initiator === undefined && (!frame || same(frame, main));
  const fromMain = same(frame, main) && initiator === transport.studioOrigin;
  const fromPreview = !!frame && same(frame.parent, main) &&
    transport.route(frame.url, 'GET') === 'preview' && initiator === transport.previewOrigin;
  if (route === 'preview') return method === 'GET' && type === 'subFrame' &&
    initiator === transport.studioOrigin && (same(frame, main) || same(frame?.parent, main));
  if (route === 'preview-film') return fromPreview && method === 'GET' && type === 'xhr';
  if (route === 'preview-runtime') return fromPreview && method === 'GET' && type === 'script';
  if (route === 'preview-asset') return (fromMain || fromPreview) &&
    ((method === 'GET' && type === 'image') || (method === 'HEAD' && type === 'xhr'));
  if (!fromMain) return false;
  return (route === 'asset' && method === 'GET' && (type === 'script' || type === 'stylesheet' || type === 'font')) ||
    (route === 'api' && type === 'xhr') || (route === 'ws' && type === 'webSocket');
}
