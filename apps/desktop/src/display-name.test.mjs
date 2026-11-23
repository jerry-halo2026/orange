// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { brandProductName, brandWindowTitle } from './brand.mjs';

const read=relative=>readFile(new URL(relative,import.meta.url),'utf8');
/* brand.json's own windowTitle: what the window, the launcher's page and the editor's page are titled (kept as it was) */
const expected='\u6a59\u5b50\u521b\u4f5c\u4e2d\u5fc3';
/* brand.json's own productName: the name every word a person reads in the app uses */
const product='OrangeFilm';
/* the name this app carried before brand.json named one: the fallback only a checkout without brand.json keeps */
const fallback='Orange \u6a59\u5b50\u521b\u4f5c\u4e2d\u5fc3';
test('login renders the creation center name and native account inputs',async()=>{
 const source=await read('../shell/Login.tsx'),require=createRequire(import.meta.url),ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};new Function('require','module','exports',compiled)(require,module,module.exports);
 const html=renderToStaticMarkup(React.createElement(module.exports.Login,{state:{kind:'signed-out',reason:null},onSignedIn(){}}));
 /* the product's name, brand.json's own: the sign-in page names the app a person just opened */
 assert.ok(html.includes(product));assert.match(html,/type="email"/);assert.match(html,/type="password"/);assert.doesNotMatch(html,/OpenFilm Studio|orangeflim/);
});
test('window, launcher and editor use the same display name without changing native identity',async()=>{
 const main=await read('./main.mjs'),shell=await read('../shell/index.html'),studioPage=await read('../../../packages/orangefilm/studio/ui/index.html');
 const launcher=await read('../../../packages/orangefilm/studio/ui/src/components/Launcher.tsx'),view=await read('../../../packages/orangefilm/studio/ui/src/components/ProjectView.tsx'),workspace=await read('../../../packages/orangefilm/studio/ui/src/components/StandaloneWorkspace.tsx');
 /* the window's title is brand.json's own windowTitle (brand.mjs); the name they had is the fallback */
 assert.match(main,/const DISPLAY_NAME = brandWindowTitle\(\);/);assert.equal(brandWindowTitle({}),fallback);assert.equal(brandWindowTitle(),expected);
 assert.match(main,/title: DISPLAY_NAME/);assert.match(main,/productName: DISPLAY_NAME/);
 assert.match(main,/app\.setName\(PRODUCT_NAME\)/);assert.match(main,/join\(app\.getPath\('appData'\), PRODUCT_NAME\)/);
 /* the pages' titles keep the window's title; the name drawn inside them is the product's (brand.json's productName) */
 for(const source of [shell,studioPage])assert.ok(source.includes(expected));
 assert.equal(brandProductName(),product);assert.equal(brandProductName({}),product,'the name this build ships, without brand.json');
 for(const source of [launcher,view,workspace]){assert.ok(source.includes('brandName'),'the name comes from brand.json, never a literal');assert.ok(!source.includes(expected),'no page keeps its own copy of a product name')}
});
