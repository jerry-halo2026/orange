// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import { useT } from '@/i18n';
import { createPreviewAttestation, createPreviewController, previewKeyIntent, previewMustStopForAuth } from '@/lib/local-preview';

type NativeAuth={onAuth?:(listener:(state:{kind:string})=>void)=>()=>void;authUiState?:()=>Promise<{active:boolean;uiGeneration:number}>};

/** Local project video only. The native film origin enforces current account, project and material access. */
export function LocalVideoPreview(props:{src:string|null;poster:string|null;generation?:number}) {
  return <LocalVideoPreviewSession key={String(props.generation??'none')+'|'+(props.src??'none')} {...props}/>;
}
function LocalVideoPreviewSession({src,poster,generation}:{src:string|null;poster:string|null;generation?:number}) {
  const t=useT(),video=React.useRef<HTMLVideoElement>(null),pending=React.useRef(false);
  const [enabled,setEnabled]=React.useState(false),[failed,setFailed]=React.useState(false),[playing,setPlaying]=React.useState(false);
  const native=typeof window==='undefined'?undefined:(window as unknown as {openfilmNative?:NativeAuth}).openfilmNative;
  const controller=React.useMemo(()=>createPreviewController(()=>video.current,()=>setFailed(true)),[]);
  const attestation=React.useMemo(()=>createPreviewAttestation(async()=>await native?.authUiState?.(),generation),[native,generation]);
  const stop=React.useCallback(()=>{attestation.cancel();pending.current=false;controller.stop();},[attestation,controller]);
  React.useLayoutEffect(()=>()=>{stop();},[stop]);
  React.useEffect(()=>{
    const unsubscribe=native?.onAuth?.(state=>{if(previewMustStopForAuth(state.kind)){stop();setEnabled(false);}});
    return()=>unsubscribe?.();
  },[native,stop]);
  React.useEffect(()=>{if(enabled&&pending.current){pending.current=false;void controller.start();}},[enabled,controller]);
  const start=async()=>{
    if(!src||generation===undefined||!native?.authUiState){setFailed(true);return;}
    const result=await attestation.authorize();
    if(result==='cancelled')return;
    if(result!=='allowed'){stop();setEnabled(false);setFailed(true);return;}
    setFailed(false);
    if(enabled)void controller.start();else{pending.current=true;setEnabled(true);}
  };
  const available=Boolean(src&&generation!==undefined&&native?.authUiState);
  return <button type="button" disabled={!available} aria-label={t('workspace.previewVideo')} aria-pressed={playing}
    onMouseEnter={()=>void start()} onMouseLeave={stop} onFocus={()=>void start()} onBlur={stop}
    onClick={()=>{if(playing)stop();else void start();}} onKeyDown={event=>{const intent=previewKeyIntent(event.key);if(!intent)return;event.preventDefault();if(intent==='stop'||playing)stop();else void start();}}
    className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px]">
    <video ref={video} src={enabled&&src?src:undefined} poster={poster??undefined} muted playsInline preload="none" aria-hidden="true"
      onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onError={()=>{stop();setFailed(true);}} className="h-full w-full object-cover"/>
    {(!available||failed)&&<span className="absolute inset-0 flex items-center justify-center bg-[var(--bg-hover)] text-[12px] text-[var(--text-muted)]">{t('workspace.previewUnavailable')}</span>}
  </button>;
}
