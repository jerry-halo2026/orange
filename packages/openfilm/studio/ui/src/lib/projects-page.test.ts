// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opensOnClick, posterRetryDelay, posterTry, within } from './projects-page.ts';

test('a list that never comes fails in its own time; one that comes or fails is passed on as it is', async () => {
  assert.equal(await within(Promise.resolve(3), 50), 3);
  await assert.rejects(within(Promise.reject(new Error('refused')), 50), /refused/);
  const t0 = Date.now();
  await assert.rejects(within(new Promise(() => {}), 50), /no answer within/);
  assert.ok(Date.now() - t0 < 1000);
});

test('a poster still being drawn is asked for again, less often each time, then given up on', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(posterRetryDelay), [4000, 8000, 16000, 32000, null]);
  assert.equal(posterTry('/api/projects/a/poster', 0), '/api/projects/a/poster');
  assert.equal(posterTry('/api/projects/a/poster', 2), '/api/projects/a/poster?try=2');
  assert.equal(posterTry('/api/projects/a/poster?cover=5', 1), '/api/projects/a/poster?cover=5&try=1');
});

test('a card opens on a click or a key press, not on the second click of a double-click', () => {
  /* a key press (Enter, Space) is a click of detail 0 */
  assert.equal(opensOnClick({ detail: 0 }), true);
  assert.equal(opensOnClick({ detail: 1 }), true);
  /* the first click already opened a folder; what is under the pointer now was not aimed at */
  assert.equal(opensOnClick({ detail: 2 }), false);
  assert.equal(opensOnClick({ detail: 3 }), false);
});

import * as nativeHome from './projects-page.ts';
import { readFileSync } from 'node:fs';
test('native home keeps the actual editor mounted while the original page alone is foreground',()=>{
 assert.equal(typeof nativeHome.homePresentation,'function');
 assert.deepEqual(nativeHome.homePresentation(null,false),{home:true,mounted:false,foreground:false});
 assert.deepEqual(nativeHome.homePresentation('original-project',false),{home:false,mounted:true,foreground:true});
 assert.deepEqual(nativeHome.homePresentation('original-project',true),{home:true,mounted:true,foreground:false});
});
test('native recent/all projects retain original API order, identities and honest missing-state metadata',()=>{
 assert.equal(typeof nativeHome.homeProjects,'function');
 const projects=Array.from({length:9},(_,i)=>({id:'native-'+i,name:'project '+i,missing:i===1}));
 assert.deepEqual(nativeHome.homeProjects(projects,'recent'),projects.slice(0,6));
 assert.equal(nativeHome.homeProjects(projects,'all'),projects);
 assert.equal(nativeHome.homeProjects(projects,'recent')[1],projects[1]);
 assert.deepEqual(nativeHome.homeProjects([],'recent'),[]);
});
test('original App root is a full home and cannot silently auto-resume the last project',()=>{
 const app=readFileSync(new URL('../App.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(app,/const last = projects\.find/);
 assert.match(app,/homePresentation\(/);
 assert.match(app,/foreground=\{presentation\.foreground\}/);
 assert.match(app,/onHome=\{/);
 const launcher=readFileSync(new URL('../components/Launcher.tsx',import.meta.url),'utf8');
 for(const key of ['homeCards.fission','homeCards.studio','homeCards.catalog','homeCards.settings'])assert(launcher.includes(key));
 assert.match(launcher,/embedded/);
});
test('original hidden editor explicitly fences foreground keys and pauses transient presentation, not the batch',()=>{
 const view=readFileSync(new URL('../components/ProjectView.tsx',import.meta.url),'utf8');
 assert.match(view,/foregroundRef\.current = foreground/);
 assert.match(view,/if \(!foregroundRef\.current\) return;/);
 assert.match(view,/shown=\{canvasOpen && foreground\}/);
 assert.match(view,/open=\{foreground && settingsOpen !== null\}/);
 assert.match(view,/open=\{foreground && projectsOpen !== false\}/);
});
import { en } from '../i18n/en.ts';
import { zhCN } from '../i18n/zh-CN.ts';
test('home entry requests belong only to the already mounted original project, never another tab',()=>{
 assert.equal(typeof nativeHome.homeEntryForProject,'function');
 const request={projectId:'original-a',entry:'fission' as const,nonce:1};
 assert.equal(nativeHome.homeEntryForProject('original-a',request),request);
 assert.equal(nativeHome.homeEntryForProject('original-b',request),null);
 assert.equal(nativeHome.homeEntryForProject(null,request),null);
 assert.equal(nativeHome.homeEntryForProject('original-a',null),null);
});
test('both original language objects expose the confirmed three names and real-list states',()=>{
 assert.equal((zhCN as any).homeCards?.fission,'超级混剪');
 assert.equal((zhCN as any).homeCards?.studio,'创作中心');
 assert.equal((zhCN as any).homeCards?.catalog,'素材中心');
 for(const words of [en,zhCN])for(const key of ['recent','all','loading','empty','myProjects'])assert.equal(typeof (words as any).homeCards?.[key],'string');
});
test('actual foreground callback ignores Home keys then resumes on the same mutable ref',()=>{
 assert.equal(typeof nativeHome.whenProjectForeground,'function');
 const ref={current:true},target=new EventTarget();let calls=0;
 const listener=nativeHome.whenProjectForeground(ref,()=>calls++);
 target.addEventListener('keydown',listener);target.dispatchEvent(new Event('keydown'));assert.equal(calls,1);
 ref.current=false;target.dispatchEvent(new Event('keydown'));assert.equal(calls,1);
 ref.current=true;target.dispatchEvent(new Event('keydown'));assert.equal(calls,2);
 target.removeEventListener('keydown',listener);
});
test('native Home keeps Canvas portal gates and Agent consent notifications distinct',()=>{
 const canvas=readFileSync(new URL('../components/canvas/CanvasView.tsx',import.meta.url),'utf8');
 for(const pattern of [/shown && redraw/,/shown && \(modal === 'styles'/,/shown && modal === 'characters'/,/shown && modal === 'history'/])assert(pattern.test(canvas),'Canvas transient portal must be gated while board remains mounted');
 const app=readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),view=readFileSync(new URL('../components/ProjectView.tsx',import.meta.url),'utf8');
 assert(app.includes('presentation.mounted &&'),'Home cannot replace/unmount the current editor');assert(app.includes('key={id!}'));
 assert(view.includes('<SpendAsks projectId={projectId} />'),'Agent approvals keep original subscription and can never be auto-approved');
 assert(view.includes('whenProjectForeground(foregroundRef'));
 assert(!app.includes('document.body.style'),'Home must not blanket-mask global Auth/connection notices');
});
test('Home never requests exitFullscreen for two absent elements',()=>{
 assert.equal(typeof nativeHome.isCurrentFullscreen,'function');const stage={};
 assert.equal(nativeHome.isCurrentFullscreen(null,null),false);
 assert.equal(nativeHome.isCurrentFullscreen(stage,stage),true);
 assert.equal(nativeHome.isCurrentFullscreen({},stage),false);
});
test('Home Escape cannot close underneath Settings and foreground native pick cannot wake the hidden editor',()=>{
 const lib=readFileSync(new URL('../components/ProjectsLibrary.tsx',import.meta.url),'utf8'),view=readFileSync(new URL('../components/ProjectView.tsx',import.meta.url),'utf8');
 assert(lib.includes('if (embedded && document.querySelector('),'Embedded Home must defer Escape to an active modal');
 const app=readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),launcher=readFileSync(new URL('../components/Launcher.tsx',import.meta.url),'utf8');
 assert(app.includes("setWorkspace(entry)") && launcher.includes("entry!=='studio'&&onEntry"),'independent entries do not require an open project');
 assert.match(app,/const onPop = \(\) => \{setWorkspace\(null\)/,'browser navigation clears the transient workspace');
 assert.match(view,/aria-label=\{t\('homeCards.settings'\)\} onClick=\{\(\)=>setSettingsOpen\('general'\)\}/,'editor exposes native settings');
 assert(view.includes('onPick(() => { if (foregroundRef.current)'),'Background editor cannot queue a project modal');
});
test('service status translations exist in both supported languages',()=>{
 for(const file of ['en.ts','zh-CN.ts']){
  const source=readFileSync(new URL('../i18n/'+file,import.meta.url),'utf8');
  for(const key of ['servicesLimited','servicesUnavailable','servicesLoading','servicesRetry'])assert.match(source,new RegExp(key+':'));
 }
});
test('home and project media use the same center without unverified preview requests',()=>{
 const standalone=readFileSync(new URL('../components/StandaloneWorkspace.tsx',import.meta.url),'utf8');
 const pool=readFileSync(new URL('../components/MediaPool.tsx',import.meta.url),'utf8');
 const center=readFileSync(new URL('../components/MaterialCenter.tsx',import.meta.url),'utf8');
 assert(standalone.includes('<MaterialCenter') && pool.includes('<MaterialCenter'));
 assert(pool.includes("await bringFrom('copy',false,at,true)") && pool.includes('<MaterialCenter'));
 assert(!/onUseLocal|localRefreshKey/.test(pool),'the centre is the catalogue: the pane\'s own files are not handed to it as a source');
 assert(!center.includes('<LocalVideoPreview') && !center.includes('/media?what=poster'));
});
