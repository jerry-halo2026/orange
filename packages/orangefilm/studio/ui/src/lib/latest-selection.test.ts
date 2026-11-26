// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatestSelection,switchSelectionTab} from './latest-selection.ts';

test('changing or clearing a local source aborts old reads and discards late responses',async()=>{
  const pending=new Map<string,(value:string)=>void>(),signals=new Map<string,AbortSignal>(),shown:(string|null)[]=[];
  const loader=createLatestSelection<string>((id,signal)=>new Promise(resolve=>{signals.set(id,signal);pending.set(id,resolve);}),value=>shown.push(value),()=>assert.fail('unexpected failure'));
  const first=loader.select('A'),second=loader.select('B');
  assert.equal(signals.get('A')?.aborted,true);
  pending.get('A')!('A files');await first;assert.equal(shown.at(-1),null);
  pending.get('B')!('B files');await second;assert.equal(shown.at(-1),'B files');
  const third=loader.select('C');await loader.select('');
  assert.equal(signals.get('C')?.aborted,true);
  pending.get('C')!('C files');await third;assert.equal(shown.at(-1),null);
});

test('clicking the selected materials tab keeps its current listing; switching clears it once',()=>{
  let clears=0;
  assert.equal(switchSelectionTab('local','local',()=>clears++),false);
  assert.equal(clears,0);
  assert.equal(switchSelectionTab('local','cloud',()=>clears++),true);
  assert.equal(clears,1);
});
