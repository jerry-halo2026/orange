// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Execute the real pane import callbacks with synthetic picker and file inputs.
async function fixture({pick,bring,upload}={}) {
  const source=await readFile(new URL('../components/MediaPool.tsx',import.meta.url),'utf8');
  const start=source.indexOf('  const importFiles = async'),end=source.indexOf('  /** Take cards away',start);
  assert.ok(start>=0&&end>start);
  const ts=createRequire(import.meta.url)('typescript');
  const code=ts.transpile(source.slice(start,end),{target:ts.ScriptTarget.ES2022});
  const state={uploads:[],notices:[],clicked:0};
  const args={
    at:'', uploadSeq:0, inputRef:{current:{click(){state.clicked++;}}},
    setNotice:value=>state.notices.push(value), t:key=>key,
    setUploads:change=>{state.uploads=change(state.uploads);},
    dropUploads:predicate=>{state.uploads=state.uploads.filter(item=>!predicate(item));},
    folderPath:rel=>rel?'assets/'+rel:'assets', resourceKindOf:()=> 'video',
    isSubtitleName:name=>/\.(vtt|srt|ass)$/i.test(String(name)),
    onImport:upload??(async()=>{}),onPick:pick,onBring:bring,
  };
  const invoke=new Function(...Object.keys(args),code+';return {importFiles,bringFrom};');
  return {state,...invoke(...Object.values(args)),source};
}
test('native picker reports partial failure and retains a successful import',async()=>{
  const f=await fixture({pick:async()=>['good.mp4','bad.mp4'],bring:async ([path])=>{if(path==='bad.mp4')throw Error('synthetic failed');return ['assets/good.mp4'];}});
  await assert.rejects(f.bringFrom('copy',false,'',true),/synthetic failed/);
  assert.equal(f.state.uploads.length,1);assert.equal(f.state.uploads[0].landed,'assets/good.mp4');
  assert.ok(f.state.notices.includes('synthetic failed'));
});
test('native picker succeeds, rejects empty results, and cancellation does not import',async()=>{
  const ok=await fixture({pick:async()=>['good.mp4'],bring:async()=>['assets/good.mp4']});
  await ok.bringFrom('copy',false,'',true);assert.equal(ok.state.uploads[0].landed,'assets/good.mp4');
  const missing=await fixture({pick:async()=>['bad.mp4'],bring:async()=>[]});
  await assert.rejects(missing.bringFrom('copy',false,'',true));assert.equal(missing.state.uploads.length,0);
  const cancelled=await fixture({pick:async()=>[],bring:async()=>{throw Error('must not run');}});
  await cancelled.bringFrom('copy',false,'',true);assert.equal(cancelled.state.uploads.length,0);
});
test('browser fallback reports upload failure, progress and retains successfully landed files',async()=>{
  const f=await fixture({upload:async(_files,_folder,progress)=>{progress(0,1,'assets/good.mp4');progress(1,0.5);throw Error('upload failed');}});
  await f.bringFrom('copy',false,'',true);assert.equal(f.state.clicked,1);
  await assert.rejects(f.importFiles([{name:'good.mp4'},{name:'bad.mp4'}],'',true),/upload failed/);
  assert.equal(f.state.uploads.length,1);assert.equal(f.state.uploads[0].landed,'assets/good.mp4');
  assert.ok(f.state.notices.includes('upload failed'));
  assert.match(f.source,/role="alert"[\s\S]*?notice/);assert.match(f.source,/aria-live="polite"/);
});
test('browser success without a landed path stays unconfirmed',async()=>{
  const f=await fixture({upload:async(_files,_folder,progress)=>{progress(0,1,'assets/good.mp4');progress(1,1);}});
  await assert.rejects(f.importFiles([{name:'good.mp4'},{name:'missing.mp4'}],'',true));
  assert.equal(f.state.uploads.length,1);assert.equal(f.state.uploads[0].landed,'assets/good.mp4');
  assert.ok(f.state.notices.includes('assets.uploadFailed'));
});
test('browser success confirms every selected file',async()=>{
  const f=await fixture({upload:async(_files,_folder,progress)=>{progress(0,1,'assets/a.mp4');progress(1,1,'assets/b.mp4');}});
  await f.importFiles([{name:'a.mp4'},{name:'b.mp4'}],'',true);
  assert.deepEqual(f.state.uploads.map(item=>item.landed),['assets/a.mp4','assets/b.mp4']);
});
