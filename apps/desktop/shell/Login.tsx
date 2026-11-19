// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { useState, type FormEvent } from 'react';
/*
 * the brand, in one place at the repository root: the words and the mark the sign-in shows. It is generated from
 * brand.json into ordinary source (scripts/brand-codegen.mjs), so the sign-in renders under `node --test` too.
 */
import { brand as brandData } from '../../../brand.generated.ts';

/*
 * The brand's words and mark, from brand.json (schema orange/brand/1). It keeps the words this page had before when
 * brand.json says nothing; a mark only an app can load (not an http(s)/data URL or a rooted path) is left to the
 * sign-in's own type, as this page cannot load it.
 */
const FALLBACK_WORDS = 'Orange 橙子创作中心';
const LOADABLE_MARK = /^(?:https?:|data:|file:|\/)/i;

function readBrandWords(): { words: string; mark: string } {
  const said = [brandData.companyName, brandData.productName].flatMap(w => { const word = typeof w === 'string' ? w.trim() : ''; return word ? [word] : []; });
  const words = said.filter((word, at) => said.indexOf(word) === at).join(' ');
  const mark = typeof brandData.logo?.mark === 'string' ? brandData.logo.mark.trim() : '';
  return { words: words || FALLBACK_WORDS, mark: LOADABLE_MARK.test(mark) ? mark : '' };
}

const BRAND = readBrandWords();

export interface LoginState { kind: string; reason: string | null; uiGeneration?: number }
const messages: Record<string,string> = {
  /* a development checkout with nothing exported yet: the one case where "configure it" is actionable */
  'configuration-required':'尚未配置登录连接。从源码运行请设置登录环境；安装版请重新下载安装包。',
  /* an installed app that was built without its environment: nothing the person in front of it can fix */
  'install-incomplete':'安装包不完整：未携带登录环境配置，无法登录。请重新下载安装包；若问题持续，请联系支持。',
  'install-conflict':'安装包同时配置了两个登录环境，无法登录。请重新下载安装包。',
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
  const locked=state.reason==='configuration-required'||state.reason==='install-incomplete'||state.reason==='install-conflict'||state.reason==='preservation-pending'||state.reason==='preservation-failed'||state.kind==='disposed';
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
      <div className="orange-login-wordmark" style={{ display:'flex', alignItems:'center', gap:8 }}>
        {BRAND.mark?<img src={BRAND.mark} alt="" aria-hidden="true" style={{ width:20, height:20, borderRadius:5 }} />:null}
        {BRAND.words}
      </div>
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
