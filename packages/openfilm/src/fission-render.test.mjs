import test from 'node:test';
import assert from 'node:assert/strict';
import { mixGraph } from './shared.mjs';

test('Fission native audio is opt-in, preserves original channels, normalizes role buses and applies full-context loudnorm before trim', () => {
  const clips = [
    { clip: 'voice', role: 'voice', file: 'voice.wav', at: 0, from: 0, to: 2, analysisTo: 4, volume: 1, speed: 1, channels: 1 },
    { clip: 'music', role: 'music', file: 'bed.wav', at: 0, from: 0, to: 2, analysisTo: 4, loopSource: true, volume: 0.35, speed: 1, channels: 1 },
  ];
  const original = mixGraph(clips, 2);
  assert.match(original.filter, /normalize=0:dropout_transition=0/);
  const result = mixGraph(clips, 2, { kind: 'fission-v1' });
  assert.match(result.filter, /normalize=1:duration=first:dropout_transition=3/);
  assert.match(result.filter, /loudnorm=I=-14:TP=-1\.5:LRA=11/);
  assert.doesNotMatch(result.filter, /pan=stereo|aresample=48000|aformat=channel_layouts=stereo/);
  assert.doesNotMatch(result.filter, /atrim=0:2/, 'actual whole-output TP RED proves PCM cannot be cut before AAC; native final mux must cut encoded packets');
  assert.match(result.filter, /loudnorm=I=-14:TP=-1\.5:LRA=11,apad=whole_dur=2\[out\]$/);
  assert.match(result.filter, /atrim=start=0:end=4/);
});

test('Fission native music loop fragments form one semantic bus, not normalization by all clip count', () => {
  const result = mixGraph([
    { clip: 'v', role: 'voice', file: 'voice.wav', at: 0, from: 0, to: 4, volume: 1, speed: 1, channels: 1 },
    { clip: 'm1', role: 'music', file: 'bed.wav', at: 0, from: 0, to: 2, volume: 0.35, speed: 1, channels: 1 },
    { clip: 'm2', role: 'music', file: 'bed.wav', at: 2, from: 0, to: 2, volume: 0.35, speed: 1, channels: 1 },
  ], 4, { kind: 'fission-v1' });
  assert.match(result.filter, /\[voice\]\[music\]amix=inputs=2:normalize=1:duration=first:dropout_transition=3/);
  assert.doesNotMatch(result.filter, /amix=inputs=3:normalize=1/);
});
import fs from 'node:fs';
import path from 'node:path';
import { createExports } from '../studio/server/exports.mjs';
import { filmHtml } from './film-doc.mjs';
test('Fission receipt cannot bypass the original queue or partially enter an export batch', async () => {
  const root = path.join(process.env.FISSION_NATIVE_TEST_ROOT, 'gate-project');fs.mkdirSync(path.join(root,'.film'),{recursive:true});
  fs.writeFileSync(path.join(root,'film.html'),filmHtml({stage:{w:1080,h:1920},tracks:[]}));
  fs.writeFileSync(path.join(root,'.film','fission-handoff.json'),JSON.stringify({exportReady:true,equivalenceVerified:true,blockingCapabilities:[]}));
  const exports=createExports();const project={id:'gate',name:'Gate',path:root};
  try {
    assert.throws(()=>exports.start(project,{kind:'video',hardware:false}), error=>error.code==='FISSION_EXPORT_BLOCKED');
    assert.throws(()=>exports.startAll(project,{jobs:[{kind:'project'},{kind:'video'}]}), error=>error.code==='FISSION_EXPORT_BLOCKED');
    assert.deepEqual(exports.list(project.id),[],'all batch eligibility must be checked before any queue side effect');
    assert.equal(fs.existsSync(path.join(root,'exports')),false);
  } finally { await exports.stopAll(); }
});

import { render } from './render.mjs';
test('direct original render rejects a forged Fission receipt before opening a renderer or creating output', async () => {
  const root=path.join(process.env.FISSION_NATIVE_TEST_ROOT,'direct-gate');fs.mkdirSync(path.join(root,'.film'),{recursive:true});
  fs.writeFileSync(path.join(root,'film.html'),filmHtml({stage:{w:1080,h:1920},tracks:[]}));
  fs.writeFileSync(path.join(root,'.film','fission-handoff.json'),'{}');const out=path.join(root,'forbidden','out.mp4');
  await assert.rejects(render([root],{out,workers:1}),error=>error.code==='FISSION_EXPORT_BLOCKED');
  assert.equal(fs.existsSync(path.dirname(out)),false);
});

import { fissionAudioClips, qualifyFissionRender } from './fission-render.mjs';
test('short video keeps nonstationary full voice and looped music context before original loudnorm, without counting loop fragments as buses',()=>{
 const voice=path.resolve('voice.wav'),music=path.resolve('music.wav');const p={kind:'fission-v1',voice:'assets/v.wav',music:'assets/m.wav',sources:{'assets/v.wav':{path:voice,durationSec:4},'assets/m.wav':{path:music,durationSec:1}},fullVoiceSec:4,nativeDurationSec:2};
 const clips=fissionAudioClips([{clip:'v',file:voice,at:0,from:0,to:2,speed:1,volume:1},{clip:'m1',file:music,at:0,from:0,to:1,speed:1,volume:.35},{clip:'m2',file:music,at:1,from:0,to:1,speed:1,volume:.35}],p);
 assert.equal(clips.filter(c=>c.role==='music').length,1);assert.equal(clips.find(c=>c.role==='music').loopSource,true);assert.equal(clips.find(c=>c.role==='music').analysisTo,4);
 const graph=mixGraph(clips,2,p);assert.match(graph.inputs.join(' '),/-stream_loop -1/);assert.equal((graph.filter.match(/atrim=start=0:end=4/g)??[]).length,2);
});

test('a non-Fission native film keeps the original IO behavior instead of acquiring new provenance restrictions',()=>{
 const root=path.join(process.env.FISSION_NATIVE_TEST_ROOT,'normal-native');fs.mkdirSync(root);const original=path.join(root,'native-original.html');fs.writeFileSync(original,filmHtml({stage:{w:1920,h:1080},tracks:[]}));fs.linkSync(original,path.join(root,'film.html'));
 assert.equal(qualifyFissionRender(root),null,'ordinary native projects have no Fission receipt or export-profile restrictions');
});

test('current native music-only bus and an edited short voice are valid, padded after the effect without cutting PCM before AAC',()=>{
 const music=mixGraph([{role:'music',file:'bed.wav',at:0,from:0,to:1,speed:1,volume:.35}],2,{kind:'fission-v1'});assert.match(music.filter,/\[music\]anull,loudnorm=/);assert.match(music.filter,/loudnorm=[^;]+,apad=whole_dur=2\[out\]/);assert.doesNotMatch(music.filter,/atrim=0:2/);
 const voice=mixGraph([{role:'voice',file:'voice.wav',at:.5,from:1,to:2,speed:2,volume:.7,fade:{in:.1,out:.1,length:.5,skip:0}}],2,{kind:'fission-v1'});assert.match(voice.filter,/atempo=2/);assert.match(voice.filter,/volume=0.7/);assert.match(voice.filter,/adelay=500/);assert.match(voice.filter,/apad=whole_dur=2/);
});

test('edited short voice and still-active longer music retain the native composition tail without padding the voice or deleting dropout',()=>{
 const clips=[{role:'voice',file:'voice.wav',at:.5,from:.5,to:2,speed:2,volume:.7},{role:'music',file:'music.wav',at:0,from:0,to:4,speed:1,volume:.35}];
 const edited=mixGraph(clips,4,{kind:'fission-v1',preserveSourceTail:false});assert.match(edited.filter,/amix=inputs=2:normalize=1:duration=longest:dropout_transition=3/);assert.doesNotMatch(edited.filter,/\[voice\]apad|apad[^;]+\[voice\]/,'voice EOF must remain real so dropout still applies');
 const original=mixGraph(clips,4,{kind:'fission-v1',preserveSourceTail:true});assert.match(original.filter,/amix=inputs=2:normalize=1:duration=first:dropout_transition=3/);
});

test('edited faded source keeps its actual mono layout before a stereo music bus negotiates the final mix',()=>{
 const clips=[{role:'voice',file:'voice.wav',at:.5,from:.5,to:2,speed:2,volume:.7,channels:1,fade:{in:.1,out:.1,length:.75,skip:0}},{role:'music',file:'bed.wav',at:0,from:0,to:4,speed:1,volume:.35,channels:2}];
 const edited=mixGraph(clips,4,{kind:'fission-v1',preserveSourceTail:false});assert.match(edited.filter,/aeval=[^;]+:c=mono,aformat=channel_layouts=mono,volume=0.7/,'FFmpeg9 c=same can negotiate stereo over a mono faded input and crash');assert.match(edited.filter,/duration=longest:dropout_transition=3/);
 const original=mixGraph(clips,4,{kind:'fission-v1',preserveSourceTail:true});assert.match(original.filter,/:c=same,volume=0.7/,'unchanged original profile is not modified by the edited-only layout fix');
});

test('edited fades never guess a multichannel source layout',()=>{
 assert.throws(()=>mixGraph([{role:'voice',file:'surround.wav',at:0,from:0,to:2,speed:1,volume:1,channels:6,fade:{in:.1,out:.1,length:2,skip:0}}],2,{kind:'fission-v1',preserveSourceTail:false}),/layout.*not qualified/i);
});
