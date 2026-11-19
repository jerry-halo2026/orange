// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * The gate that was missing.
 *
 * `tsc -p apps/api/tsconfig.json` used to include only `src/*.ts`, so `src/wiki/**`, `src/index/**`
 * and `src/sync/**` - the three largest modules - were never type-checked, and `pnpm typecheck` said
 * "Done" while `compile.ts` called a five-argument function with four. A green typecheck that does not
 * look at the code is worse than no typecheck, because it is believed.
 *
 * These tests fail if the include ever narrows again, or if someone silences a real error with a
 * compiler suppression comment instead of fixing it.
 */
const root=dirname(fileURLToPath(import.meta.url)); // .../apps/api/src
const apiRoot=dirname(root);

const readTsconfig=async():Promise<{include?:string[]}>=>JSON.parse(await readFile(join(apiRoot,'tsconfig.json'),'utf8')) as {include?:string[]};

async function sources(dir=root):Promise<string[]> {
  const out:string[]=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(entry.isDirectory())out.push(...await sources(path));
    else if(entry.name.endsWith('.ts'))out.push(path);
  }
  return out;
}

test('the typecheck include covers every source file, not just the top level',async()=>{
  const config=await readTsconfig();
  assert.deepEqual(config.include,['src/**/*.ts'],'the include must be the whole tree');
  const files=(await sources()).map(path=>relative(apiRoot,path).replaceAll('\\','/'));
  for(const required of ['src/wiki/compile.ts','src/index/client.ts','src/sync/catalog.ts']){
    assert.equal(files.includes(required),true,`${required} exists and is covered by src/**/*.ts`);
  }
  const uncovered=files.filter(file=>!file.startsWith('src/')||!file.endsWith('.ts'));
  assert.deepEqual(uncovered,[],'nothing lives outside the include');
});

test('no source file silences the checker',async()=>{
  // Assembled at runtime so this guard does not match itself.
  const mute=new RegExp('@ts'+'-(?:ignore|nocheck|expect-error)');
  const offenders:string[]=[];
  for(const path of await sources()){
    const text=await readFile(path,'utf8');
    if(mute.test(text))offenders.push(relative(apiRoot,path).replaceAll('\\','/'));
  }
  assert.deepEqual(offenders,[],'a type error is fixed, never muted');
});
