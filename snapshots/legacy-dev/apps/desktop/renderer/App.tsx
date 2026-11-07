import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AuthError, AuthState, DesktopAuthBridge } from '../auth-contract.ts';
import { isStudioState, type DesktopStudioBridge, type StudioState } from '../studio-contract.ts';

declare global {
  interface Window { orangeAuth?: DesktopAuthBridge; orangeStudio?: DesktopStudioBridge }
}

const unavailable: AuthState = { kind: 'unavailable' };
const studioClosed: StudioState = { kind: 'closed', error: null };
const studioMessages = {
  'auth-required': '会话已失效，请重新登录。',
  unavailable: 'Studio 当前不可用，请重试或返回工作区。',
  failed: '未能连接 Studio，请重试或返回工作区。',
};

async function readStudio(method: keyof DesktopStudioBridge): Promise<StudioState> {
  let timeout: number | undefined;
  try {
    const bridge = window.orangeStudio;
    if (!bridge || typeof bridge[method] !== 'function') return { kind: 'closed', error: 'unavailable' };
    const answer = await Promise.race([
      bridge[method](),
      new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error('Studio timed out')), 10_000); }),
    ]);
    return isStudioState(answer) ? answer : { kind: 'closed', error: 'failed' };
  } catch { return { kind: 'closed', error: 'failed' }; }
  finally { if (timeout !== undefined) window.clearTimeout(timeout); }
}

function closeStudioWithoutWaiting() {
  // Logout must revoke Auth even if the native client never answers.
  void readStudio('close');
}
const messages: Record<AuthError, string> = {
  unavailable: '登录服务尚未配置。',
  'invalid-input': '请输入有效的邮箱和密码。',
  busy: '正在验证，请稍候。',
  credentials: '登录失败。请检查邮箱、密码及账号确认状态。',
  verification: '未能验证会话，请重新登录。',
  'mfa-required': '此账号需要多因素验证，当前版本尚未支持。',
  service: '暂时无法连接登录服务，请检查网络后重试。',
};

export function App() {
  const [state, setState] = useState<AuthState>(unavailable);
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<AuthError | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const [studioRoute, setStudioRoute] = useState(false);
  const [studio, setStudio] = useState<StudioState>(studioClosed);
  const [returning, setReturning] = useState(false);
  const studioEpoch = useRef(0);
  const opening = useRef(false);
  const closing = useRef(false);
  const routeRef = useRef(false);
  const studioStateRef = useRef<StudioState>(studioClosed);
  const ownedHash = useRef<string | null>(null);
  const signedIn = state.kind === 'signed-in';
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;
  routeRef.current = studioRoute;
  studioStateRef.current = studio;

  function displayStudio(next: StudioState) {
    studioStateRef.current = next;
    setStudio(next);
  }

  function setRouteHash(hash: string) {
    if (window.location.hash === hash) return;
    ownedHash.current = hash;
    window.location.hash = hash;
  }

  function resetStudio() {
    ++studioEpoch.current;
    opening.current = false;
    closing.current = false;
    routeRef.current = false;
    setStudioRoute(false);
    displayStudio(studioClosed);
    setReturning(false);
  }

  async function openStudio() {
    if (!signedInRef.current || pending.current || opening.current || closing.current) return;
    if (routeRef.current && studioStateRef.current.kind !== 'closed') return;
    const epoch = ++studioEpoch.current;
    opening.current = true;
    routeRef.current = true;
    setStudioRoute(true);
    displayStudio({ kind: 'opening', error: null });
    setRouteHash('#/studio');
    const answer = await readStudio('open');
    if (epoch !== studioEpoch.current || !signedInRef.current) return;
    opening.current = false;
    ++studioEpoch.current;
    displayStudio(answer);
  }

  async function returnToWorkspace() {
    if (!signedInRef.current || closing.current) return;
    if (!routeRef.current) { setRouteHash('#/workspace'); return; }
    const epoch = ++studioEpoch.current;
    opening.current = false;
    closing.current = true;
    setReturning(true);
    const answer = await readStudio('close');
    if (epoch !== studioEpoch.current || !signedInRef.current) return;
    closing.current = false;
    setReturning(false);
    if (answer.kind === 'closed' && (answer.error === null || answer.error === 'unavailable')) {
      resetStudio();
      setRouteHash('#/workspace');
    } else {
      displayStudio({ kind: 'closed', error: answer.kind === 'closed' ? answer.error ?? 'failed' : 'failed' });
      setRouteHash('#/studio');
    }
  }

  useEffect(() => {
    if (!signedIn) {
      if (routeRef.current) closeStudioWithoutWaiting();
      resetStudio();
      return;
    }
    const navigate = () => {
      if (window.location.hash === '#/studio') void openStudio();
      else if (window.location.hash === '#/workspace') void returnToWorkspace();
    };
    // A verified session is still required before a bookmarked Studio route is opened.
    navigate();
    const onHashChange = () => {
      const ownChange = ownedHash.current === window.location.hash;
      ownedHash.current = null;
      if (!ownChange) navigate();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => { window.removeEventListener('hashchange', onHashChange); };
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn || !studioRoute || returning || studio.kind === 'closed') return;
    let mounted = true;
    let reading = false;
    const update = async () => {
      if (reading) return;
      const epoch = studioEpoch.current;
      reading = true;
      const answer = await readStudio('getState');
      reading = false;
      if (!mounted || epoch !== studioEpoch.current || !signedInRef.current) return;
      // A just-dispatched open may not yet be reflected by the native host.
      if (opening.current && answer.kind === 'closed' && answer.error === null) return;
      if (answer.kind === 'closed') { ++studioEpoch.current; opening.current = false; }
      displayStudio(answer);
    };
    const timer = window.setInterval(() => { void update(); }, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [signedIn, studioRoute, studio.kind, returning]);

  useEffect(() => () => { ++studioEpoch.current; }, []);

  useEffect(() => {
    let mounted = true;
    let reading = false;
    const update = async () => {
      if (pending.current || reading) return;
      const snapshot = revision.current;
      reading = true;
      try {
        const actual = await window.orangeAuth?.getState() ?? unavailable;
        if (mounted && snapshot === revision.current) setState(actual);
      } catch {
        if (mounted && snapshot === revision.current) setState(unavailable);
      } finally {
        reading = false;
      }
    };
    void update();
    const timer = window.setInterval(() => { void update(); }, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.orangeAuth || pending.current || state.kind !== 'signed-out') return;
    pending.current = true;
    ++revision.current;
    setBusy(true);
    setError(null);
    const submitted = { email, password };
    setPassword('');
    try {
      const answer = await window.orangeAuth.signIn(submitted);
      setState(answer.state);
      setError(answer.error);
      if (answer.state.kind === 'signed-in') {
        setShowForm(false);
        setEmail('');
      }
    } catch {
      setState(unavailable);
      setError('service');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function signOut() {
    if (!window.orangeAuth || pending.current) return;
    pending.current = true;
    ++revision.current;
    signedInRef.current = false;
    closeStudioWithoutWaiting();
    resetStudio();
    setRouteHash('#/workspace');
    setState({ kind: 'signed-out' });
    setShowForm(false);
    setError(null);
    setBusy(true);
    try { setState(await window.orangeAuth.signOut()); }
    catch { setState(unavailable); }
    finally { pending.current = false; setBusy(false); }
  }

  return (
    <>
      <header className="shell">
        <div className="brand"><span className="mark" aria-hidden="true">橙</span><h1>橙子创作中心</h1></div>
        {signedIn && (
          <nav className="nav" aria-label="主导航">
            <a href="#/workspace" aria-current={!studioRoute ? 'page' : undefined}
              onClick={event => { event.preventDefault(); void returnToWorkspace(); }}>工作区</a>
            <a href="#/studio" aria-current={studioRoute ? 'page' : undefined}
              aria-disabled={returning || studio.kind === 'opening'}
              onClick={event => { event.preventDefault(); void openStudio(); }}>Studio</a>
            <button className="secondary" type="button" onClick={() => void signOut()}>退出登录</button>
          </nav>
        )}
      </header>
      {signedIn && studioRoute ? (
        <main className="studio-route" aria-label="Studio">
          <section className="studio-status" aria-label="Studio 状态">
            <div className="studio-summary">
              <strong>演示工程 · 仅本次打开 · 关闭丢弃</strong>
              <p role="status" aria-live="polite">{returning ? '正在关闭 Studio…' : studio.kind === 'opening' ? '正在打开 Studio…'
                : studio.kind === 'open' ? 'Studio 已打开'
                : studio.error ? studioMessages[studio.error] : 'Studio 已关闭，可重试或返回工作区。'}</p>
            </div>
            <div className="studio-controls">
              {studio.kind === 'closed' && !returning && <button type="button" onClick={() => void openStudio()}>重试</button>}
              <button type="button" className="secondary" disabled={returning}
                onClick={() => void returnToWorkspace()}>返回工作区</button>
            </div>
          </section>
          {/* The trusted native editor is mounted separately below this 128 DIP band. */}
        </main>
      ) : signedIn ? (
        <main className="workspace">
          <section className="panel" aria-labelledby="workspace-heading">
            <div className="caption"><span aria-hidden="true" />已验证会话</div>
            <h2 id="workspace-heading">创作工作区</h2>
            <p>从演示工程开始，选择、预览并移动两段固定片段。</p>
            <p className="workspace-note">演示工程 · 仅本次打开 · 关闭丢弃</p>
            <div className="actions"><button type="button" onClick={() => void openStudio()}>打开 Studio</button></div>
            <p className="workspace-limit">当前仅供本次体验，不支持个人工程保存、导入或导出。</p>
          </section>
        </main>
      ) : (
        <main className="landing">
          <section className="panel" aria-labelledby="startup-heading">
            <div className="caption"><span aria-hidden="true" />启动状态</div>
            <h2 id="startup-heading">尚未验证会话</h2>
            <p className="notice" role="status"><span>尚无经过验证的橙子会话。</span><span>请联网登录后再进入创作工作区。</span></p>
            {showForm && state.kind === 'signed-out' ? (
              <form className="login" onSubmit={event => void signIn(event)}>
                <label>邮箱<input type="email" name="email" autoComplete="username" value={email}
                  onChange={event => setEmail(event.target.value)} required maxLength={254} disabled={busy} /></label>
                <label>密码<input type="password" name="password" autoComplete="current-password" value={password}
                  onChange={event => setPassword(event.target.value)} required maxLength={512} disabled={busy} /></label>
                {error && <p className="error" role="alert">{messages[error]}</p>}
                <div className="actions">
                  <button type="submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => {
                    setShowForm(false); setPassword(''); setError(null);
                  }}>返回</button>
                </div>
              </form>
            ) : (
              <div className="actions">
                <button type="button" disabled={state.kind === 'unavailable' || busy}
                  aria-describedby={state.kind === 'unavailable' ? 'auth-config-status' : undefined}
                  onClick={() => { setShowForm(true); setError(null); }}>登录</button>
                {state.kind === 'unavailable' && <p id="auth-config-status">登录服务当前不可用。</p>}
              </div>
            )}
          </section>
        </main>
      )}
    </>
  );
}
