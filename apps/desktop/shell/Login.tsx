import { useState, type FormEvent } from 'react';

export interface LoginState { kind: string; reason: string | null }
const messages: Record<string,string> = {
  'configuration-required':'尚未配置隔离开发环境的登录连接。请提供安全本地配置后重新启动。',
  'authentication-rejected':'账号或密码未通过验证，请检查后重试。',
  'verification-unconfirmed':'暂时无法确认登录，请检查网络后重试。',
  'request-timeout':'登录请求超时，请稍后重试。',
  'unsupported-auth-flow':'此账号需要额外验证，当前密码登录不能继续。',
  'preservation-pending':'正在保全原工程并关闭旧会话，请稍候。',
  'preservation-failed':'原会话尚未安全保全。工程文件已保留，暂不允许切换账号。',
  'expired':'登录已到期，原工程已锁定保留。请重新登录。',
  'project-access-denied':'无法安全打开本人工作区，未激活本次登录。',
};

export function Login({state,onSignedIn}:{state:LoginState,onSignedIn:()=>void}) {
  const [email,setEmail]=useState(''),[password,setPassword]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const locked=state.reason==='configuration-required'||state.reason==='preservation-pending'||state.reason==='preservation-failed'||state.kind==='disposed';
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy||locked)return;setBusy(true);setError(null);
    const value={email,password};setPassword('');
    try{
      const response=await fetch('/api/auth/sign-in',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
      const result=await response.json() as {ok?:boolean,code?:string};
      if(response.ok&&result.ok){onSignedIn();return;}
      setError(messages[result.code??'']??'登录未完成，请检查账号或连接后重试。');
    }catch{setError('登录连接暂不可用，请稍后重试。');}
    finally{setBusy(false);}
  }
  return <main className="orange-login" aria-labelledby="orange-login-title">
    <div className="orange-login-drag" aria-hidden="true" />
    <form className="orange-login-card" onSubmit={event=>void submit(event)}>
      <div className="orange-login-wordmark">orangeflim <span>OpenFilm Studio</span></div>
      <h1 id="orange-login-title">登录橙子</h1>
      <p>登录后进入创作中心。工程保存在本机，不会因退出登录被删除。</p>
      <label htmlFor="orange-login-email">邮箱</label>
      <input id="orange-login-email" type="email" name="email" autoComplete="username" required maxLength={320} value={email} disabled={busy||locked} onChange={event=>setEmail(event.target.value)} />
      <label htmlFor="orange-login-password">密码</label>
      <input id="orange-login-password" type="password" name="password" autoComplete="current-password" required value={password} disabled={busy||locked} onChange={event=>setPassword(event.target.value)} />
      {(error||state.reason)&&<p className="orange-login-message" role="alert">{error??messages[state.reason??'']??'当前会话已锁定，请重新登录。'}</p>}
      <button type="submit" disabled={busy||locked}>{busy?'正在验证…':'登录并进入创作中心'}</button>
      <small>使用橙子账号登录；智尚素材账号在登录后单独绑定。</small>
    </form>
  </main>;
}
