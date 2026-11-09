import test from 'node:test';
import assert from 'node:assert/strict';

test('native prepare output mapper exists without running a worker or installing authority', async () => {
 const api = await import('./admission.ts');
 assert.equal(typeof (api as any).mapPreparedFissionOutput, 'function');
});
test('the original importer and mapper have one pure aligned visual timing implementation', async () => {
 const helper = await import(new URL('../../../packages/openfilm/src/fission-timing.mjs', import.meta.url).href);
 assert.equal(typeof helper.alignedVisualSpans, 'function');
});

import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const clone=<T>(v:T):T=>structuredClone(v);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const data=async()=>{
 const snapshot=JSON.parse(await readFile(process.env.FISSION_MAPPING_PREPARED_SAMPLE!,'utf8'));
 const job=JSON.parse(await readFile(process.env.FISSION_MAPPING_ORIGINAL_JOB!,'utf8'));
 return {snapshot,context:{projectId:'native_非UUID',filmRev:'0123456789abcdef',job}};
};
const associations=(snapshot:any)=>{
 const sources=new Map<string,any>();for(const o of snapshot.outputs)for(const s of o.sources)sources.set(s.path,s);
 return [...sources].map(([path,s],i)=>({filePath:path,fileIdentity:snapshot.versions.find((v:any)=>v.path===path).identity,contentSha256:s.sha256,
  resolvedMeta:{versionId:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,contentSha256:s.sha256,kind:s.kind,durationSec:s.durationSec}}));
};
const mapper=async()=>{const m=await import('./admission.ts');assert.equal(typeof (m as any).mapPreparedFissionOutput,'function');return (m as any).mapPreparedFissionOutput;};
const map=async(snapshot:any,index:number,context:any,rows=associations(snapshot))=>(await mapper())(snapshot,index,context,rows);
const alter=(snapshot:any,index=0)=>snapshot.outputs.find((o:any)=>o.index===index);
const timed=async(p:any)=>{const h=await import(new URL('../../../packages/openfilm/src/fission-timing.mjs',import.meta.url).href);return h.alignedVisualSpans(p).spans;};

test('actual frozen CLI prepare Count3 maps original noncontiguous indices without modifying job/snapshot or licensing',async()=>{
 const {snapshot,context}=await data();assert.equal(snapshot.outputs.length,3);assert.equal(snapshot.measuredAssemblyClock,false);
 const before=hash({snapshot,context}),plans=await Promise.all([2,0].map(i=>map(snapshot,i,context)));
 for(const p of plans){assert.deepEqual(Object.keys(p).sort(),['version','projectId','filmRev','job','durationSec','aspect','fps','materials','scenes','audio','captions','transition'].sort());assert.equal(p.job.Count,3);assert.equal(p.durationSec,4);assert.deepEqual(p.aspect,[1080,1920]);assert.equal(p.scenes.length,2);assert(p.scenes.every((s:any)=>s.clips.every((c:any)=>c.framing==='contain-center')));assert(!('authorizesBusiness' in p));}
 assert.equal(hash({snapshot,context}),before);assert.equal(context.job.Count,3);assert.notEqual(plans[0].scenes[0].clips[0].versionId,plans[1].scenes[0].clips[0].versionId);
 const {contentKey}=await import('./admission.ts');assert.notEqual(contentKey(plans[0]),contentKey(plans[1]),'the real frozen outputs have different visible source byte sequences');
 const aliases=clone(plans[0]),ids=new Map<string,string>();for(const m of aliases.materials){const next=m.versionId.replace(/^1/,'2');ids.set(m.versionId,next);m.versionId=next;}for(const scene of aliases.scenes)for(const clip of scene.clips)clip.versionId=ids.get(clip.versionId);aliases.audio.voice.versionId=ids.get(aliases.audio.voice.versionId);if(aliases.audio.music)aliases.audio.music.versionId=ids.get(aliases.audio.music.versionId);assert.equal(contentKey(aliases),contentKey(plans[0]),'reference IDs alone are not content or rights');
 if(process.env.FISSION_MAPPING_EVIDENCE_OUT)await writeFile(process.env.FISSION_MAPPING_EVIDENCE_OUT,JSON.stringify({sourceSnapshotSHA256:createHash('sha256').update(await readFile(process.env.FISSION_MAPPING_PREPARED_SAMPLE!)).digest('hex'),nativeSnapshotDigest:snapshot.digest,originalIndices:[2,0],plans,contentKeys:plans.map((p:any)=>contentKey(p)),snapshotAndJobUnchanged:hash({snapshot,context})===before,syntheticMetadataAssociations:true,businessGrant:false,measuredClock:false},null,2),{flag:'wx'});
});

test('single native timing helper preserves trim/speed/loop source-domain arithmetic and frame fractions',async()=>{
 const visuals=[{source:0,role:'intro',group:'x',startSec:1,durationSec:3,speed:1.5,hflip:true},{source:1,role:'outro',group:'y',startSec:2,durationSec:2,speed:1,hflip:false}],sources=[{kind:'video'},{kind:'video'}];
 const speed=await timed({durationSec:2,alignment:{action:'speed',outputDurationSec:2,tempo:2,loops:1},visuals,sources});
 assert.equal(speed[0].at,0);assert.equal(speed[0].rate,3);assert.equal(speed[0].fromSec,1);assert.equal(speed[0].toSec,4);assert.equal(speed[1].at,1);assert.equal(speed[1].toSec,4);
 const loop=await timed({durationSec:9,alignment:{action:'loop',outputDurationSec:9,tempo:1,loops:3},visuals,sources});
 assert.equal(loop.length,5);assert.equal(loop.at(-1).at,8);assert.equal(loop.at(-1).toSec,2.5);assert.equal(loop.at(-1).length,1);
 const fraction=await timed({durationSec:1/3,alignment:{action:'trim',outputDurationSec:1/3,tempo:1,loops:1},visuals,sources});assert.equal(fraction[0].length,1/3);assert.equal(fraction[0].toSec,1.5);
});

test('mapping retains alignment trims, whole-composition speed, loop order, role/group and hflip',async()=>{
 for(const action of ['trim','speed','loop']){
  const {snapshot,context}=await data(),o=alter(snapshot);o.cuts[0].decision.role='intro';o.cuts[1].decision.role='outro';o.cuts[0].decision.hflip=true;
  o.alignmentIntent={action,inputDurationSec:4,outputDurationSec:action==='loop'?6:2,tempo:action==='speed'?2:1,loops:action==='loop'?2:1};
  const p=await map(snapshot,0,context);assert.equal(p.durationSec,o.alignmentIntent.outputDurationSec);assert(p.scenes[0].name.includes('intro'));assert.equal(p.scenes[0].clips[0].hflip,true);
  if(action==='trim')assert.equal(p.scenes.length,1);if(action==='speed'){assert.equal(p.scenes.length,2);assert.equal(p.scenes[0].clips[0].speed,2);assert.equal(p.scenes[1].clips[0].atSec,1);}if(action==='loop'){assert.equal(p.scenes.length,3);assert.equal(p.scenes[2].clips[0].atSec,4);}
 }
});

test('still intrinsic zero stays separate from selected hold/speed/global alignment exposure',async()=>{
 const {snapshot,context}=await data(),o=alter(snapshot),i=o.cuts[0].decision.source;for(const out of snapshot.outputs)for(const s of out.sources)if(s.path===o.sources[i].path){s.kind='still';s.durationSec=0;}
 o.cuts[0].normalization.imageHoldSec=2;o.cuts[0].decision.speed=2;o.alignmentIntent={action:'speed',inputDurationSec:3,outputDurationSec:1.5,tempo:2,loops:1};
 const p=await map(snapshot,0,context),still=p.materials.find((m:any)=>m.kind==='still'),clip=p.scenes[0].clips[0];assert.equal(still.durationSec,0);assert.equal(clip.fromSec,0);assert.equal(clip.toSec,.5);assert.equal(clip.speed,1);assert.equal(p.durationSec,1.5);
 const changed=clone(snapshot);alter(changed).cuts[0].normalization.imageHoldSec=1;await assert.rejects(map(changed,0,context),/native/i);
});

test('audio fingerprints retain full voice/BGM source context rather than native Ops target clips',async()=>{
 const {snapshot,context}=await data(),o=alter(snapshot);o.alignmentIntent={action:'trim',inputDurationSec:4,outputDurationSec:2,tempo:1,loops:1};
 const sound=clone(o.sources[o.audio.voice.source]);sound.path+='-music';sound.sha256='b'.repeat(64);sound.durationSec=9;o.sources.push(sound);const v=clone(snapshot.versions.find((x:any)=>x.path===o.voicePath));v.path=sound.path;v.sha256=sound.sha256;snapshot.versions.push(v);o.musicPath=sound.path;o.audio.music={source:o.sources.length-1,volume:.35,loop:true};
 const p=await map(snapshot,0,context);assert.equal(p.durationSec,2);assert.equal(p.audio.voice.toSec,4);assert.equal(p.audio.music.toSec,9);assert.equal(p.audio.music.loop,true);assert.deepEqual(p.audio.postmix,{kind:'loudnorm',integratedLUFS:-14,truePeakDBTP:-1.5,loudnessRangeLU:11});
});

test('known subtitle/GLSL intent and fade fields are fingerprinted without inventing applied/equivalence',async()=>{
 const {snapshot,context}=await data(),o=alter(snapshot);context.job.SubtitleEnabled=true;context.job.TransitionSec=.3;
 o.subtitleIntent={requested:true,outcome:'prepared-intent',timingSource:'sentence-weighted-approximation',cues:[{startSec:0,endSec:3,text:'甲。'},{startSec:3,endSec:5,text:'乙。'}],style:{preset:'white-outline',position:'bottom',fontSize:60,assStyle:'Style: Default,Microsoft YaHei,60',fadeInSec:.12,fadeOutSec:.12}};
 const shader={path:snapshot.workRoot+'-read\\fade.glsl',sha256:'c'.repeat(64)};snapshot.versions.push({...clone(snapshot.versions[0]),path:shader.path,sha256:shader.sha256,owned:false});o.transitionIntent={requestedName:'fade',durationSec:.3,selectedName:'fade',shader,outcome:'prepared-intent',tailPaddingSec:.2};
 const p=await map(snapshot,0,context);assert.equal(p.captions.cues[1].toSec,4);assert.equal(JSON.parse(p.captions.style).fadeInSec,.12);assert.deepEqual(p.transition,{name:'fade',durationSec:.3,shaderSha256:'c'.repeat(64)});
 const changed=clone(snapshot);alter(changed).subtitleIntent.style.fadeInSec=.2;await assert.rejects(map(changed,0,context),/native/i);
});

test('valid native one-frame source tail remains an explicit recoverable business mapping incompatibility',async()=>{
 const {snapshot,context}=await data(),o=alter(snapshot),cut=o.cuts[0];cut.decision.durationSec+=1/30;cut.normalization.durationSec+=1/30;o.alignmentIntent.inputDurationSec+=1/30;
 assert(cut.decision.durationSec<=o.sources[cut.decision.source].durationSec+1/30);const before=hash(snapshot);
 await assert.rejects(map(snapshot,0,context),(e:any)=>e.code==='native-source-frame-boundary-pending'&&e.status===422);assert.equal(hash(snapshot),before);
});

test('staging associations must match exact Windows identity/path/SHA and never derive UUIDs from content',async()=>{
 const {snapshot,context}=await data();for(const kind of ['missing','duplicate','path','identity','sha','meta-sha','meta-kind','uuid']){const rows=associations(snapshot);if(kind==='missing')rows.length=0;else if(kind==='duplicate')rows.push(clone(rows[0]));else if(kind==='path')rows[0].filePath+='wrong';else if(kind==='identity')rows[0].fileIdentity='12345';else if(kind==='sha')rows[0].contentSha256='d'.repeat(64);else if(kind==='meta-sha')rows[0].resolvedMeta.contentSha256='d'.repeat(64);else if(kind==='meta-kind')rows[0].resolvedMeta.kind='sound';else rows[0].resolvedMeta.versionId='not-a-version';await assert.rejects(map(snapshot,0,context,rows));}
});

test('unknown or post-execution facts never become preparation or silently disabled effects',async()=>{
 const {snapshot,context}=await data();for(const change of [(s:any)=>s.measuredAssemblyClock=true,(s:any)=>s.authorizesBusiness=true,(s:any)=>alter(s).transitionIntent.outcome='applied',(s:any)=>alter(s).subtitleIntent={requested:true,outcome:'missing-text',timingSource:'sentence-weighted-approximation',cues:[],style:null},(s:any)=>alter(s).audio.loudnorm.integratedLUFS=-18]){const copy=clone(snapshot);change(copy);await assert.rejects(map(copy,0,context));}
 const receipt=JSON.parse(await readFile(process.env.FISSION_MAPPING_RECEIPT!,'utf8'));await assert.rejects(map(receipt,0,context,[]));await assert.rejects(map(snapshot,99,context));
});

for(const field of ['music-path','voice-item','generated-origin'])test('inconsistent native '+field+' facts cannot fingerprint different execution inputs',async()=>{
 const {snapshot,context}=await data(),o=alter(snapshot);if(field==='music-path')o.musicPath=o.voicePath;else if(field==='voice-item')o.audioItem.path+='-different';else o.generatedVoice={unrecognized:true};
 await assert.rejects(map(snapshot,0,context),/native/i);
});

test('synthetic generated-origin facts still need an existing exact material association and preserve physical full audio',async()=>{
 const {snapshot,context}=await data(),o=alter(snapshot),voiceIndex=o.audio.voice.source,staged=clone(snapshot.versions.find((v:any)=>v.path===o.voicePath));
 const generatedPath=o.voicePath.replace(/[^\\/]+$/,'gen_001.mp3'),proofPath=generatedPath+'.prepared-generated.json';o.voicePath=generatedPath;o.audioItem.path=generatedPath;o.sources[voiceIndex].path=generatedPath;
 snapshot.versions.push({...staged,path:generatedPath},{...staged,path:proofPath,sha256:'d'.repeat(64)});
 o.generatedVoice={path:generatedPath,proofPath,proofSha256:'d'.repeat(64),purpose:'native-offline-lavfi-voice/v1'};
 const rows=associations(snapshot);rows.find((r:any)=>r.filePath===generatedPath)!.resolvedMeta.durationSec=4.049;
 const p=await map(snapshot,0,context,rows);assert.equal(p.audio.voice.toSec,4.049);assert.equal(p.durationSec,4);assert(!('license' in p));
 await assert.rejects(map(snapshot,0,context,rows.filter((r:any)=>r.filePath!==generatedPath)),/native/i);
});
