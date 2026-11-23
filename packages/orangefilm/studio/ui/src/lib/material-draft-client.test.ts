// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaterialDraftClient} from './material-draft-client.ts';

const lease='A'.repeat(32);
const local={source:'local',projectId:'A',path:'assets/01 场景/a.mp4',title:'a.mp4',mediaKind:'video',role:'video',group:'01 场景'};
const cloud={source:'cloud',videoId:'123',title:'cloud',role:'video',group:''};
const clone=value=>structuredClone(value);
function mock(){
  let current={lease,revision:0,items:[]},listeners=new Set(),changes=0;
  const bridge={
    async read(){return clone(current);},
    async change({lease:provided,baseRevision,operation}){
      changes++;if(provided!==current.lease)throw Error('stale-session');
      if(baseRevision!==current.revision)return {code:'revision-conflict'};
      if(operation.type==='add'&&!current.items.some(item=>JSON.stringify(item)===JSON.stringify(operation.item))){current={...current,revision:current.revision+1,items:[...current.items,clone(operation.item)]};}
      for(const listener of listeners)listener({generation:1,revision:current.revision,items:clone(current.items)});
      return clone(current);
    },
    onChange(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  };
  return {bridge,get current(){return current;},set current(value){current=value;},get changes(){return changes;},emit(event){for(const listener of listeners)listener(event);}};
}

test('two tabs share only intent, and stale generation events cannot overwrite it',async()=>{
  const m=mock(),statesA=[],statesB=[],a=createMaterialDraftClient(m.bridge,1,state=>statesA.push(state)),b=createMaterialDraftClient(m.bridge,1,state=>statesB.push(state));
  assert.equal(await a.resume(),true);assert.equal(await b.resume(),true);
  assert.equal(await a.change({type:'add',item:local}),true);
  assert.deepEqual(statesB.at(-1).items,[local]);
  m.emit({generation:0,revision:99,items:[cloud]});
  assert.deepEqual(statesB.at(-1).items,[local]);
  assert.doesNotMatch(JSON.stringify(statesA),new RegExp(lease));
  a.dispose();b.dispose();
});

test('a conflict reloads and replays the explicit user operation at most once',async()=>{
  const m=mock(),states=[];let first=true;
  const original=m.bridge.change;
  m.bridge.change=async input=>{
    if(first){first=false;m.current={lease,revision:1,items:[local]};return {code:'revision-conflict'};}
    return original(input);
  };
  const c=createMaterialDraftClient(m.bridge,1,state=>states.push(state));
  await c.resume();assert.equal(await c.change({type:'add',item:cloud}),true);
  assert.deepEqual(states.at(-1).items,[local,cloud]);assert.equal(m.changes,1);c.dispose();
});

test('retirement invalidates delayed reads and cannot adopt another session lease',async()=>{
  let resolveRead,states=[];
  const bridge={read:()=>new Promise(resolve=>{resolveRead=resolve;}),change:async()=>{throw Error('unused')},onChange:()=>()=>{}};
  const c=createMaterialDraftClient(bridge,1,state=>states.push(state));
  const read=c.resume();c.suspend(true);resolveRead({lease,revision:0,items:[local]});
  assert.equal(await read,false);assert.deepEqual(states.at(-1).items,[]);assert.equal(states.at(-1).ready,false);c.dispose();
});

test('temporary lock preserves hidden intent and a later different lease is never adopted',async()=>{
  const m=mock(),states=[],c=createMaterialDraftClient(m.bridge,1,state=>states.push(state));
  await c.resume();await c.change({type:'add',item:local});c.suspend(false);
  assert.equal(states.at(-1).ready,false);assert.deepEqual(states.at(-1).items,[local]);
  assert.equal(await c.resume(),true);c.suspend(true);
  m.current={lease:'B'.repeat(32),revision:0,items:[cloud]};
  assert.equal(await c.resume(),false);assert.deepEqual(states.at(-1).items,[]);assert.equal(states.at(-1).ready,false);c.dispose();
});

test('untrusted URLs or duplicate items in events never enter the draft',async()=>{
  const m=mock(),states=[],c=createMaterialDraftClient(m.bridge,1,state=>states.push(state));await c.resume();
  m.emit({generation:1,revision:1,items:[{...cloud,videoId:'https://bad.invalid/video'}]});
  assert.deepEqual(states.at(-1).items,[]);
  m.emit({generation:1,revision:1,items:[local,local]});assert.deepEqual(states.at(-1).items,[]);c.dispose();
});


test('a newer event arriving before initial read completes is retained',async()=>{
  let resolveRead,listener,state;
  const bridge={read:()=>new Promise(resolve=>{resolveRead=resolve;}),change:async()=>{throw Error('unused')},onChange:fn=>{listener=fn;return()=>{};}};
  const c=createMaterialDraftClient(bridge,1,value=>{state=value}),loading=c.resume();
  listener({generation:1,revision:1,items:[local]});
  resolveRead({lease,revision:0,items:[]});assert.equal(await loading,true);
  assert.equal(state.revision,1);assert.deepEqual(state.items,[local]);c.dispose();
});
test('retirement discards a delayed mutation response and never republishes old items',async()=>{
  let resolveChange,state;
  const bridge={read:async()=>({lease,revision:0,items:[]}),change:()=>new Promise(resolve=>{resolveChange=resolve;}),onChange:()=>()=>{}};
  const c=createMaterialDraftClient(bridge,1,value=>{state=value});await c.resume();
  const mutation=c.change({type:'add',item:local});await Promise.resolve();
  c.suspend(true);resolveChange({lease,revision:1,items:[local]});
  assert.equal(await mutation,false);assert.deepEqual(state.items,[]);assert.equal(state.ready,false);c.dispose();
});
test('a second revision conflict stops instead of retrying indefinitely',async()=>{
  let calls=0,state;
  const bridge={read:async()=>({lease,revision:0,items:[]}),change:async()=>{calls++;return {code:'revision-conflict'};},onChange:()=>()=>{}};
  const c=createMaterialDraftClient(bridge,1,value=>{state=value});await c.resume();
  assert.equal(await c.change({type:'add',item:local}),false);assert.equal(calls,2);assert.equal(state.reason,'conflict');assert.equal(state.ready,true);c.dispose();
});


test('same revision compares semantic fields rather than object property insertion order',async()=>{
  const m=mock(),states=[],c=createMaterialDraftClient(m.bridge,1,state=>states.push(state));await c.resume();await c.change({type:'add',item:local});
  const reordered={group:'01 场景',role:'video',mediaKind:'video',title:'a.mp4',path:'assets/01 场景/a.mp4',projectId:'A',source:'local'};
  m.emit({generation:1,revision:1,items:[reordered]});
  assert.equal(states.at(-1).ready,true);assert.equal(states.at(-1).items[0].title,'a.mp4');c.dispose();
});
test('inconsistent same-revision events buffered during read fail closed',async()=>{
  let resolveRead,listener,state;
  const bridge={read:()=>new Promise(resolve=>{resolveRead=resolve;}),change:async()=>{throw Error('unused')},onChange:fn=>{listener=fn;return()=>{};}};
  const c=createMaterialDraftClient(bridge,1,value=>{state=value}),loading=c.resume();
  listener({generation:1,revision:1,items:[local]});listener({generation:1,revision:1,items:[cloud]});
  resolveRead({lease,revision:0,items:[]});assert.equal(await loading,false);assert.deepEqual(state.items,[]);assert.equal(state.ready,false);c.dispose();
});
test('old account cannot read or mutate after a different generation is active',async()=>{
  let active=1,current={lease,revision:0,items:[local]},listeners=new Set(),statesA=[],statesB=[];
  const bridge={read:async({generation})=>{if(generation!==active)throw Error('stale');return clone(current);},change:async({generation})=>{if(generation!==active)throw Error('stale');return clone(current);},onChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
  const a=createMaterialDraftClient(bridge,1,state=>statesA.push(state));await a.resume();a.suspend(true);
  active=2;current={lease:'B'.repeat(32),revision:0,items:[cloud]};
  const b=createMaterialDraftClient(bridge,2,state=>statesB.push(state));assert.equal(await b.resume(),true);
  assert.equal(await a.resume(),false);assert.deepEqual(statesA.at(-1).items,[]);
  for(const listener of listeners)listener({generation:2,revision:1,items:[cloud]});
  assert.deepEqual(statesA.at(-1).items,[]);a.dispose();b.dispose();
});
