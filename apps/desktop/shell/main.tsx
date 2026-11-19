// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The app's window: Studio's editor, as the open-source Studio is (its App, unchanged), and the chat in the column
 * Studio leaves for it (lib/host.ts `panel`). One page, one theme, one layer of dialogs over both.
 */
import { host } from './bridge';
import { Fragment, StrictMode, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from 'openfilm/studio-ui/App.tsx';
import { FocusNav } from 'openfilm/studio-ui/components/FocusNav.tsx';
import { applyStudioHost, type HostWritingModel } from 'openfilm/studio-ui/lib/host.ts';
import { mountChat } from '../chat/src/mount';
import { CanvasModelPicker, canvasWritingModel } from '../chat/src/components/ModelPopover';
import './shell.css';
import '../chat/src/chat.css';
import { Login, type LoginState } from './Login';
import { AccountExit } from './AccountExit';
import { accountPresentation, createAuthEventGate } from './auth-generation';

/* the canvas's words written by the agent the chat has picked, with its own settings: the chat's agents include two
   Studio's own canvas cannot be written by (`openfilm`, `antigravity`), so one of those is no writing model at all */
host.canvasWriting = {
  Picker: CanvasModelPicker,
  selection: (): HostWritingModel | null => {
    const picked = canvasWritingModel();
    if (!picked || picked.agent === 'openfilm' || picked.agent === 'antigravity') return null;
    return { agent: picked.agent, options: picked.options };
  },
};
applyStudioHost();
const native=(window as unknown as {openfilmNative:{onAuth?:(listener:(state:LoginState)=>void)=>()=>void;authUiState?:()=>Promise<{active:boolean;uiGeneration:number}>}}).openfilmNative;
function DesktopGate(){
  const [state,setState]=useState<LoginState>({kind:'signed-out',reason:null});
  const [opened,setOpened]=useState(false);
  const [chatReady,setChatReady]=useState<number|null>(null);
  const {active,generation,chatVisible}=accountPresentation(state,chatReady);
  const gate=useMemo(()=>createAuthEventGate(async()=>await native.authUiState?.(),setState),[]);
  const refresh=()=>gate.http(async()=>{const response=await fetch('/api/auth/state');if(!response.ok)throw Error();return await response.json() as LoginState;});
  useEffect(()=>{const stop=native.onAuth?.(next=>{void gate.native(next);});void refresh();return()=>{stop?.();gate.dispose();};},[gate]);
  useEffect(()=>{
    if(active&&!opened){setOpened(true);history.replaceState(history.state,'',location.href);}
  },[active,opened]);
  useEffect(()=>{
    if(!opened)return;
    const abort=new AbortController();
    let dispose:(()=>void)|null=null;
    void mountChat(document.getElementById('of-chat')!,abort.signal).then(stop=>{
      if(abort.signal.aborted)stop();
      else{dispose=stop;setChatReady(generation);}
    },()=>{if(!abort.signal.aborted)setChatReady(null);});
    return()=>{abort.abort();dispose?.();};
  },[opened,generation]);
  useLayoutEffect(()=>{
    const show=chatVisible;
    for(const id of ['of-chat','of-chat-layer'])document.getElementById(id)!.style.visibility=show?'':'hidden';
  },[active,chatReady,generation]);
  return <>
    {(opened||active)&&<div style={{visibility:active?'visible':'hidden',height:'100%',width:'100%'}} inert={!active} aria-hidden={!active}>
      <Fragment key={generation}><FocusNav /><App authGeneration={generation} /></Fragment>
      <AccountExit onSignOut={()=>void fetch('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})} />
    </div>}
    {!active&&<Login state={state} onSignedIn={()=>void refresh()} />}
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><DesktopGate /></StrictMode>);
