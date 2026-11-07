import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AuthError, AuthState, DesktopAuthBridge } from '../auth-contract.ts';

declare global {
  interface Window { orangeAuth?: DesktopAuthBridge }
}

const unavailable: AuthState = { kind: 'unavailable' };
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
    setState({ kind: 'signed-out' });
    setShowForm(false);
    setError(null);
    setBusy(true);
    try { setState(await window.orangeAuth.signOut()); }
    catch { setState(unavailable); }
    finally { pending.current = false; setBusy(false); }
  }

  const signedIn = state.kind === 'signed-in';
  return (
    <>
      <header className="shell">
        <div className="brand"><span className="mark" aria-hidden="true">橙</span><h1>橙子创作中心</h1></div>
        {signedIn && (
          <nav className="nav" aria-label="主导航">
            <a href="#/workspace" aria-current="page">工作区</a>
            <button className="secondary" type="button" onClick={() => void signOut()}>退出登录</button>
          </nav>
        )}
      </header>
      {signedIn ? (
        <main className="workspace">
          <section className="panel" aria-labelledby="workspace-heading">
            <div className="caption"><span aria-hidden="true" />已验证会话</div>
            <h2 id="workspace-heading">创作工作区</h2>
            <p>已登录橙子创作中心。Studio 和业务模块尚未接入。</p>
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
