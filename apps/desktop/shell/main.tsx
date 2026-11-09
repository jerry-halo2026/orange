/**
 * The app's window: Studio's editor, as the open-source Studio is (its App, unchanged), and the chat in the column
 * Studio leaves for it (lib/host.ts `panel`). One page, one theme, one layer of dialogs over both.
 */
import './bridge';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from 'openfilm/studio-ui/App.tsx';
import { FocusNav } from 'openfilm/studio-ui/components/FocusNav.tsx';
import { applyStudioHost } from 'openfilm/studio-ui/lib/host.ts';
import { mountChat } from '../chat/src/mount';
import './shell.css';
import '../chat/src/chat.css';
import { Login, type LoginState } from './Login';

applyStudioHost();
const native=(window as unknown as {openfilmNative:{onAuth?:(listener:(state:LoginState)=>void)=>()=>void}}).openfilmNative;
function DesktopGate(){
  const [state,setState]=useState<LoginState>({kind:'signed-out',reason:null});
  const [opened,setOpened]=useState(false);
  const active=state.kind==='active';
  async function refresh(){
    try{const response=await fetch('/api/auth/state');if(!response.ok)throw Error();setState(await response.json() as LoginState);}
    catch{setState({kind:'signed-out',reason:'verification-unconfirmed'});}
  }
  useEffect(()=>{const stop=native.onAuth?.(setState);void refresh();return stop;},[]);
  useEffect(()=>{
    for(const id of ['of-chat','of-chat-layer'])document.getElementById(id)!.style.visibility=active?'':'hidden';
    if(active&&!opened){
      setOpened(true);void mountChat(document.getElementById('of-chat')!);
      history.replaceState(history.state,'',location.href);
    }
  },[active,opened]);
  return <>
    {(opened||active)&&<div style={{visibility:active?'visible':'hidden',height:'100%',width:'100%'}} inert={!active} aria-hidden={!active}>
      <FocusNav /><App />
      <button className="orange-account-exit" onClick={()=>void fetch('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})}>退出登录</button>
    </div>}
    {!active&&<Login state={state} onSignedIn={()=>void refresh()} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><DesktopGate /></StrictMode>);
