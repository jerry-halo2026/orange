// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** Build only the same local film-origin source used by Studio, never a cloud URL or an absolute file path. */
export function projectVideoPreviewUrl(folder:string,path:string):string|null {
  const parts=path.split('/');
  if(parts[0]!=='assets'||parts.length<2||parts.some(part=>!part||part==='.'||part==='..'||/[\\\x00-\x1f\x7f]/.test(part)))return null;
  try {
    const base=new URL(folder);
    if(base.protocol!=='http:'||base.hostname!=='localhost'||!base.port||base.username||base.password||base.search||base.hash||!/^\/p\/[\w-]+\/(?:.*\/)?$/.test(base.pathname))return null;
    return base.href+parts.map(encodeURIComponent).join('/');
  } catch {return null;}
}
type PreviewMedia={muted:boolean;currentTime:number;paused:boolean;play:()=>Promise<void>;pause:()=>void};
/** Ignore an expected late play rejection after the pointer, focus or account leaves. */
export function createPreviewController(media:()=>PreviewMedia|null,onFailure:()=>void) {
  let sequence=0;
  return {
    async start():Promise<void> {
      const video=media();if(!video)return;const ticket=++sequence;video.muted=true;
      try{await video.play();}catch{if(ticket===sequence)onFailure();}
    },
    stop():void {
      sequence+=1;const video=media();if(!video)return;video.pause();try{video.currentTime=0;}catch{}
    },
  };
}


export function previewKeyIntent(key:string):'toggle'|'stop'|null {
  return key==='Escape'?'stop':key==='Enter'||key===' '?'toggle':null;
}
export function previewMustStopForAuth(kind:string):boolean {return kind!=='active';}


type PreviewProof={active:boolean;uiGeneration:number};
export function createPreviewAttestation(readProof:()=>Promise<PreviewProof|undefined>,generation:number|undefined) {
  let sequence=0;
  return {
    async authorize():Promise<'allowed'|'denied'|'cancelled'> {
      const ticket=++sequence;
      try {
        const proof=await readProof();
        if(ticket!==sequence)return 'cancelled';
        return generation!==undefined&&proof?.active===true&&proof.uiGeneration===generation?'allowed':'denied';
      } catch {return ticket===sequence?'denied':'cancelled';}
    },
    cancel():void {sequence+=1;},
  };
}
