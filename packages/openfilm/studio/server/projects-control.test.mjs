import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, linkSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createProjectControlGuard } from './project-control-guard.mjs';
import * as projects from './projects.mjs';
const base = mkdtempSync(resolve('.dev/projects-admission/native-'));
const home = join(base,'home'), library = join(base,'library'), coord = join(base,'coord');
mkdirSync(home); mkdirSync(library);
process.env.OPENFILM_HOME = home; process.env.OPENFILM_SHARED_HOME = home; process.env.OPENFILM_LIBRARY = library;
const guard = createProjectControlGuard({ coordinationRoot: coord });
test('actual open refuses a marked target before film/id writes', async () => {
 const target = join(base,'marked'); mkdirSync(target);
 writeFileSync(join(target,'.openfilm-control.json'), JSON.stringify({version:1,domainId:'synthetic'}));
 await projects.withProjectControlGuard(guard, async () => {
  await assert.rejects(projects.openProject(target), { code:'control-required' });
 });
 assert.equal(existsSync(join(target,'.film')),false);
});
test('actual concurrent create chooses distinct original names and IDs', async () => {
 const items = await projects.withProjectControlGuard(guard, () => Promise.all([projects.createProject(), projects.createProject()]));
 assert.equal(new Set(items.map(x=>x.path)).size,2);
 assert.equal(new Set(items.map(x=>x.id)).size,2);
});
test('registration exposes only intermediate deny-marker capabilities and denies reopening native API', async () => {
 await projects.withProjectControlGuard(guard, async () => {
  const handle = await projects.registerProjectControl({environmentId:'synthetic-env',domainId:'synthetic-domain'});
  assert.equal(handle.capabilities.scope,'projects-admission-v1');
  assert.equal(handle.capabilities.ownerAuthorization,false);
  await assert.rejects(projects.readState(), e => e.code === 'control-required' || e.code === 'control-busy');
  await handle.close();
  await assert.rejects(projects.readState(), {code:'control-required'});
  const reopened = await projects.registerProjectControl({environmentId:'synthetic-env',domainId:'synthetic-domain'});
  await reopened.close();
 });
});
function fresh() {
 const root=mkdtempSync(join(base,'api-')); const home=join(root,'home'),library=join(root,'library');mkdirSync(home);mkdirSync(library);
 process.env.OPENFILM_HOME=home;process.env.OPENFILM_SHARED_HOME=home;process.env.OPENFILM_LIBRARY=library;
 return {root,home,library,guard:createProjectControlGuard({coordinationRoot:join(root,'coord')})};
}
const marked=path=>writeFileSync(join(path,'.openfilm-control.json'),JSON.stringify({version:1,domainId:'synthetic'}));
test('all actual public IO APIs deny a controlled home before effects or choose/trash',async()=>{
 const f=fresh();marked(f.home);let chosen=0;
 await projects.withProjectControlGuard(f.guard,async()=>{
  for(const fn of [()=>projects.readState(),()=>projects.openProject(join(f.library,'new')),()=>projects.createProject(),()=>projects.listProjects(),()=>projects.listFolders(),()=>projects.createFolder('new'),()=>projects.renameFolder('id','new'),()=>projects.moveFolder('id',null),()=>projects.deleteFolder('id'),()=>projects.moveProjectToFolder('id',null),()=>projects.projectById('id'),()=>projects.markOpened('id'),()=>projects.locateProject('id',join(f.library,'new')),()=>projects.renameProject('id','new'),()=>projects.deleteProject('id'),()=>projects.forgetProject('id'),()=>projects.moveLibrary(join(f.root,'destination'),{choose:()=>chosen++})]) await assert.rejects(fn(),{code:'control-required'});
  assert.throws(()=>projects.studioKey(),{code:'control-required'});assert.throws(()=>projects.libraryRoot(),{code:'control-required'});
 });assert.equal(chosen,0);assert.equal(existsSync(join(f.home,'key')),false);assert.equal(existsSync(join(f.home,'studio.json')),false);
});
test('list preflights every found project before first ID/gitignore/state write',async()=>{
 const f=fresh(), first=join(f.library,'A'),blocked=join(f.library,'Z');mkdirSync(first);mkdirSync(blocked);writeFileSync(join(first,'film.html'),'synthetic');writeFileSync(join(blocked,'film.html'),'synthetic');marked(blocked);
 await projects.withProjectControlGuard(f.guard,()=>assert.rejects(projects.listProjects(),{code:'control-required'}));
 assert.equal(existsSync(join(first,'.film')),false);assert.equal(existsSync(join(f.home,'studio.json')),false);
});
test('recent compound outer marker is denied before list writes',async()=>{
 const f=fresh(),outer=join(f.root,'outer'),part=join(outer,'parts','part');mkdirSync(part,{recursive:true});writeFileSync(join(outer,'film.html'),'synthetic');mkdirSync(join(outer,'.film'));writeFileSync(join(outer,'.film','control.json'),JSON.stringify({version:1,domainId:'synthetic'}));
 writeFileSync(join(f.home,'studio.json'),JSON.stringify({recent:[{id:'synthetic-id',path:part,openedAt:1}],folders:[]}));
 await projects.withProjectControlGuard(f.guard,()=>assert.rejects(projects.listProjects(),{code:'control-required'}));assert.equal(existsSync(join(part,'.film')),false);
});
test('unmarked happy native APIs preserve IDs, film and folder behavior',async()=>{
 const f=fresh();await projects.withProjectControlGuard(f.guard,async()=>{
 const project=await projects.createProject('Original');assert.match(project.id,/^[\w-]{6,40}$/);const reopened=await projects.openProject(project.path);assert.equal(project.id,reopened.id);
 const folder=await projects.createFolder('Folder');await projects.moveProjectToFolder(project.id,folder.id);assert.equal((await projects.projectById(project.id)).folderId,folder.id);
 await projects.renameFolder(folder.id,'Renamed');await projects.moveFolder(folder.id,null);await projects.markOpened(project.id);assert.equal((await projects.listProjects()).length,1);assert.equal((await projects.listFolders())[0].name,'Renamed');
 const renamed=await projects.renameProject(project.id,'Renamed');assert.equal(renamed.id,project.id);await projects.locateProject(project.id,renamed.path);
 await projects.deleteFolder(folder.id);await projects.forgetProject(project.id);assert.equal((await projects.readState()).recent.length,0);assert.equal(existsSync(join(renamed.path,'film.html')),true);
 const key=projects.studioKey();assert.equal(key===projects.studioKey(),true);
 });
});
test('pending, mismatched and malformed registration stay denied without cleanup',async()=>{
 for(const orangeControl of [{version:1,domainId:'synthetic',environmentId:'synthetic',registration:'pending',roots:[]},null,{version:7}]){
 const f=fresh();writeFileSync(join(f.home,'studio.json'),JSON.stringify({recent:[],folders:[],orangeControl,extra:'preserve'}));
 await projects.withProjectControlGuard(f.guard,async()=>{await assert.rejects(projects.readState(),{code:'control-required'});assert.throws(()=>projects.studioKey(),{code:'control-required'});await assert.rejects(projects.registerProjectControl({domainId:'synthetic',environmentId:'synthetic'}),{code:'control-invalid'});});
 assert.equal(existsSync(join(f.home,'studio.json')),true);assert.equal(existsSync(join(f.home,'key')),false);
 }
});
test('registration preserves unknown state and does not assign historical project IDs',async()=>{
 const f=fresh(),history=join(f.library,'history');mkdirSync(history);writeFileSync(join(history,'film.html'),'synthetic');writeFileSync(join(f.home,'studio.json'),JSON.stringify({recent:[],folders:[],extra:'preserved'}));
 await projects.withProjectControlGuard(f.guard,async()=>{const h=await projects.registerProjectControl({domainId:'synthetic',environmentId:'synthetic'});assert.deepEqual(h.capabilities,{scope:'projects-admission-v1',projectsApiFenced:true,registrationWritesDenyMarkersOnly:true,nativeEntryPointsFenced:false,backgroundIoDrained:false,productionControlledActivation:false,ownerAuthorization:false});await h.close();await assert.rejects(projects.registerProjectControl({domainId:'different',environmentId:'synthetic'}),{code:'control-invalid'});});assert.equal(existsSync(join(history,'.film')),false);
});
test('moveLibrary destination denial precedes choose; locate and rename deny marked destination',async()=>{
 const f=fresh(),destination=join(f.root,'destination');mkdirSync(destination);marked(destination);let count=0;
 await projects.withProjectControlGuard(f.guard,async()=>{
 await assert.rejects(projects.moveLibrary(destination,{choose:()=>count++}),{code:'control-required'});
 const p=await projects.createProject('Original');await assert.rejects(projects.locateProject(p.id,destination),{code:'control-required'});
 const target=join(f.library,'Blocked');mkdirSync(target);marked(target);await assert.rejects(projects.renameProject(p.id,'Blocked'),{code:'control-required'});assert.equal(existsSync(p.path),true);
 });assert.equal(count,0);
});
test('fake guard and guard switching inside active scope fail closed',async()=>{
 const f=fresh();assert.throws(()=>projects.withProjectControlGuard({},()=>{}),{code:'control-invalid'});
 const other=createProjectControlGuard({coordinationRoot:join(f.root,'other-coord')});await f.guard.withNativeAccess({homes:[f.home],roots:[],targets:[]},async()=>{assert.throws(()=>projects.withProjectControlGuard(other,()=>{}),{code:'control-invalid'});});
});
test('open preflights controlled recent paths before initializing a different project',async()=>{
 const f=fresh(),blocked=join(f.root,'blocked'),target=join(f.root,'new');mkdirSync(blocked);marked(blocked);writeFileSync(join(f.home,'studio.json'),JSON.stringify({recent:[{id:'synthetic-id',path:blocked,openedAt:1}],folders:[]}));
 await projects.withProjectControlGuard(f.guard,()=>assert.rejects(projects.openProject(target),{code:'control-required'}));assert.equal(existsSync(target),false);
});
test('actual registration is busy during native work, with no pending registration left',async()=>{
 const f=fresh();await projects.withProjectControlGuard(f.guard,async()=>{
 await f.guard.withNativeAccess({homes:[f.home],roots:[f.library],targets:[]},async()=>{await assert.rejects(projects.registerProjectControl({domainId:'synthetic',environmentId:'synthetic'}),{code:'control-busy'});assert.equal(existsSync(join(f.home,'studio.json')),false);});
 const h=await projects.registerProjectControl({domainId:'synthetic',environmentId:'synthetic'});h.close();
 });
});
test('different home sharing a marked library and missing marked subpath cannot initialize anything',async()=>{
 const f=fresh();marked(f.library);await projects.withProjectControlGuard(f.guard,async()=>{await assert.rejects(projects.createProject(),{code:'control-required'});await assert.rejects(projects.openProject(join(f.library,'missing','tail')),{code:'control-required'});});assert.equal(existsSync(join(f.home,'studio.json')),false);assert.equal(existsSync(join(f.library,'missing')),false);
});
test('moveLibrary preflights marked source projects before invoking choose',async()=>{
 const f=fresh(),source=join(f.library,'blocked');mkdirSync(source);writeFileSync(join(source,'film.html'),'synthetic');marked(source);let count=0;
 await projects.withProjectControlGuard(f.guard,()=>assert.rejects(projects.moveLibrary(join(f.root,'next'),{move:true,choose:()=>count++}),{code:'control-required'}));assert.equal(count,0);assert.equal(existsSync(join(f.root,'next')),false);
});

test('original unmarked project junction preserves real path and ID; controlled target alias is denied',async()=>{
 const f=fresh(),target=join(f.root,'ordinary'),alias=join(f.root,'ordinary-alias');mkdirSync(target);symlinkSync(target,alias,'junction');
 await projects.withProjectControlGuard(f.guard,async()=>{
  const direct=await projects.openProject(target);const throughAlias=await projects.openProject(alias);
  assert.equal(throughAlias.id,direct.id);assert.equal(throughAlias.path,direct.path);assert.equal((await projects.listProjects()).length,1);
  marked(target);
  await assert.rejects(projects.openProject(alias),e=>e.code==='control-required'||e.code==='control-invalid');
 });
});
for (const operation of ['open','list','locate']) test(`fix1 actual ${operation} refuses .film junction before any project or destination write`,async()=>{
 const f=fresh(),target=join(f.library,'Linked'),controlled=join(f.root,'controlled');mkdirSync(target);mkdirSync(controlled);marked(controlled);writeFileSync(join(target,'film.html'),'synthetic-film');writeFileSync(join(controlled,'.gitignore'),'unchanged');symlinkSync(controlled,join(target,'.film'),'junction');
 await projects.withProjectControlGuard(f.guard,async()=>{
  let invoke;
  if(operation==='locate'){const original=await projects.openProject(join(f.root,'original'));invoke=()=>projects.locateProject(original.id,target);}else invoke=()=>operation==='open'?projects.openProject(target):projects.listProjects();
  const stateFile=join(f.home,'studio.json'),before=existsSync(stateFile)?readFileSync(stateFile,'utf8'):null;
  let error;try{await invoke();}catch(e){error=e;}
  assert.equal(readFileSync(join(controlled,'.gitignore'),'utf8'),'unchanged');assert.equal(existsSync(join(controlled,'id')),false);assert.equal(existsSync(stateFile)?readFileSync(stateFile,'utf8'):null,before);assert.ok(error?.code?.startsWith('control-'));
 });
});
for(const leaf of ['.gitignore','id']) test(`fix1 metadata ${leaf} hardlink cannot alter external bytes`,async()=>{
 const f=fresh(),target=join(f.library,'Linked'),external=join(f.root,'external');mkdirSync(join(target,'.film'),{recursive:true});writeFileSync(external,'unchanged');linkSync(external,join(target,'.film',leaf));
 await projects.withProjectControlGuard(f.guard,async()=>{let error;try{await projects.openProject(target);}catch(e){error=e;}assert.equal(readFileSync(external,'utf8'),'unchanged');assert.equal(existsSync(join(target,'film.html')),false);assert.equal(existsSync(join(f.home,'studio.json')),false);assert.ok(error?.code?.startsWith('control-'));});
});
for(const order of ['before','after']) for(const operation of ['open','createFolder']) test(`fix1 corrupt recent ${order} controlled entry ${operation} preserves all state`,async()=>{
 const f=fresh(),blocked=join(f.root,'blocked'),target=join(f.root,'new');mkdirSync(join(blocked,'.film'),{recursive:true});marked(blocked);writeFileSync(join(blocked,'.film','id'),'synthetic-id');const entry={id:'synthetic-id',path:blocked,openedAt:1};const raw=JSON.stringify({recent:order==='before'?[null,entry]:[entry,null],folders:[],extra:'preserved'});writeFileSync(join(f.home,'studio.json'),raw);
 await projects.withProjectControlGuard(f.guard,async()=>{let error;try{await(operation==='open'?projects.openProject(target):projects.createFolder('Folder'));}catch(e){error=e;}assert.equal(readFileSync(join(f.home,'studio.json'),'utf8'),raw);assert.equal(readFileSync(join(blocked,'.film','id'),'utf8'),'synthetic-id');assert.equal(existsSync(target),false);assert.equal(error?.code,'control-invalid');});
});
test('fix1 pending owned reader release recovers through actual registerProjectControl after child unlock',async()=>{
 const f=fresh(),coord=join(f.root,'coord');let child,exited;
 await projects.withProjectControlGuard(f.guard,async()=>{
  try {
   await assert.rejects(f.guard.withNativeAccess({homes:[f.home],roots:[f.library],targets:[]},async()=>{
    const code=`import {openSync,closeSync,unlinkSync} from 'node:fs';const file=${JSON.stringify(join(coord,'meta.lock'))};const fd=openSync(file,'wx');process.stdout.write('ready\\n');await new Promise(r=>process.stdin.once('data',r));closeSync(fd);unlinkSync(file);`;
    child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','ignore']});exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('child exited before ready')));});
   }),{code:'control-busy'});
  } finally {if(child){child.stdin.end('release');assert.equal(await exited,0);}}
  const handle=await projects.registerProjectControl({domainId:'synthetic',environmentId:'synthetic'});assert.equal(handle.capabilities.projectsApiFenced,true);handle.close();assert.equal(JSON.parse(readFileSync(join(coord,'registry.json'))).readers.length,0);
 });
});
