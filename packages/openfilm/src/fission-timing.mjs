// @ts-check
/** Pure arithmetic shared by the original native importer and pre-execution mapping.
 * No IO, IDs, Film/Op creation, ownership or business authority is installed here.
 * @typedef {{source:number,startSec:number,durationSec:number,speed:number,hflip:boolean}} NativeVisual
 * @typedef {{visualIndex:number,source:number,at:number,length:number,rate:number,fromSec:number,toSec:number,still:boolean,hflip:boolean}} VisualSpan
 */
/** @param {{readonly durationSec:number,readonly alignment:{readonly action:string,readonly outputDurationSec:number,readonly tempo:number,readonly loops:number},readonly visuals:readonly NativeVisual[],readonly sources:readonly {readonly kind:string}[]}} p
 * @returns {{readonly target:number,readonly spans:readonly Readonly<VisualSpan>[]}}
 */
export function alignedVisualSpans(p) {
 const invalid=()=>{throw new RangeError('Invalid native visual timing facts.');};
 if(!p||!Number.isFinite(p.durationSec)||p.durationSec<=0||!p.alignment||!['trim','speed','loop'].includes(p.alignment.action)
  ||!Number.isFinite(p.alignment.outputDurationSec)||p.alignment.outputDurationSec<=0||!Number.isFinite(p.alignment.tempo)||p.alignment.tempo<=0
  ||!Array.isArray(p.visuals)||!p.visuals.length||!Array.isArray(p.sources))invalid();
 const target=Math.min(p.durationSec,p.alignment.outputDurationSec);
 const tempo=p.alignment.action==='speed'?p.alignment.tempo:1;
 for(const v of p.visuals)if(!Number.isSafeInteger(v.source)||!['video','still'].includes(p.sources[v.source]?.kind)
  ||!Number.isFinite(v.startSec)||v.startSec<0||!Number.isFinite(v.durationSec)||v.durationSec<=0||!Number.isFinite(v.speed)||v.speed<=0||typeof v.hflip!=='boolean')invalid();
 const one=p.visuals.reduce((n,v)=>n+v.durationSec/v.speed/tempo,0);
 const loops=p.alignment.action==='loop'?Math.ceil(target/one):1;
 if(!Number.isSafeInteger(loops)||loops<1||loops*p.visuals.length>10000)invalid();
 /** @type {Readonly<VisualSpan>[]} */ const spans=[];let at=0;
 for(let loop=0;loop<loops;loop++)for(let visualIndex=0;visualIndex<p.visuals.length;visualIndex++){
  if(at>=target-1e-9)break;
  const v=p.visuals[visualIndex],rate=v.speed*tempo,length=Math.min(v.durationSec/rate,target-at),still=p.sources[v.source].kind==='still';
  if(!Number.isFinite(rate)||!Number.isFinite(length)||length<=0)invalid();
  spans.push(Object.freeze({visualIndex,source:v.source,at,length,rate,fromSec:still?0:v.startSec,toSec:still?length:v.startSec+length*rate,still,hflip:v.hflip}));at+=length;
 }
 return Object.freeze({target,spans:Object.freeze(spans)});
}
