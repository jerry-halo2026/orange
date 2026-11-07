import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { readIsolationProfile, isolationEnvironment } from '../../src/development-isolation.mjs';
import { agentCanvasRoute, canvasRoute, writeCanvas } from './canvas.mjs';
let fixture, profile, studio, fetchOriginal, errorsOriginal;
let outbound = 0;
const errors = [];
const board = { nodes: [{ id: 'secret', x: 0, y: 0, text: 'synthetic outside sentinel' }], edges: [] };
const ops = [{ op: 'add', kind: 'note', id: 'new', text: 'synthetic change' }];
const scratch = fileURLToPath(new URL('../../../../.dev/canvas-p1/', import.meta.url));
function project(path) { mkdirSync(join(path, '.film'), { recursive: true }); writeFileSync(join(path, 'film.html'), '<!doctype html>'); writeFileSync(join(path, '.film', 'canvas.json'), JSON.stringify(board)); return path; }
async function call(folder, write = false) {
  const res = await fetch(studio.origin + '/api/canvas', { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-key': studio.key }, body: JSON.stringify({ folder, ...(write ? { ops } : {}) }) });
  return { status: res.status, body: await res.json() };
}
function denied(result) { assert.equal(result.status, 403); assert.equal(result.body.code, 'isolation-path'); assert.equal(result.body.canvas, undefined); }
before(async () => {
  mkdirSync(scratch, { recursive: true }); fixture = mkdtempSync(join(scratch, 'case-'));
  const config = { baseRoot: join(fixture, 'approved'), instanceId: 'canvas-instance', taskId: 'T01', attemptId: 'attempt-1', ports: { studio: 18775, film: 18776 } };
  profile = readIsolationProfile({ OPENFILM_ISOLATION_PROFILE: Buffer.from(JSON.stringify(config)).toString('base64url'), OPENFILM_ISOLATION_ROOT: config.baseRoot });
  Object.assign(process.env, isolationEnvironment(profile)); for (const dir of Object.values(profile.paths)) mkdirSync(dir, { recursive: true });
  fetchOriginal = globalThis.fetch; errorsOriginal = console.error;
  globalThis.fetch = async (input, options) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (url.origin !== 'http://127.0.0.1:18775' || !url.pathname.startsWith('/api/')) { outbound++; throw new Error('External fetch forbidden.'); } return fetchOriginal(input, options); };
  console.error = (...args) => errors.push(args);
  const { startStudio } = await import('./server.mjs');
  studio = await startStudio({ port: 18775, isolation: true, advertise: true, stays: true, openBrowser: () => assert.fail('Browser forbidden.'), askAgent: async () => assert.fail('Agent forbidden.') });
});
after(async () => { await studio?.close(); globalThis.fetch = fetchOriginal; console.error = errorsOriginal; assert.equal(outbound, 0); assert.equal(errors.length, 0); for (const port of [18775,18776]) { const s=createServer(); await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(port,'127.0.0.1',resolve)}); await new Promise(resolve=>s.close(resolve)); } });
for (const write of [false, true]) test(`actual HTTP refuses outside Canvas ${write ? 'write' : 'read'} without changing bytes`, async () => { const outside=project(join(fixture,write?'outside-write':'outside-read')); const file=join(outside,'.film','canvas.json'); const original=readFileSync(file); denied(await call(outside,write)); assert.deepEqual(readFileSync(file),original); });
for (const kind of ['project','metadata','nested']) test(`actual HTTP refuses ${kind} junction before Canvas access`,async()=>{
  const external=project(join(fixture,`external-${kind}`)); const local=join(profile.paths.projects,kind);
  if(kind==='project')symlinkSync(external,local,'junction');
  else {mkdirSync(local,{recursive:true});writeFileSync(join(local,'film.html'),'<!doctype html>');if(kind==='metadata')symlinkSync(join(external,'.film'),join(local,'.film'),'junction');else {mkdirSync(join(local,'.film'));symlinkSync(join(external,'.film'),join(local,'.film','canvases'),'junction');}}
  const file=join(external,'.film','canvas.json');const original=readFileSync(file);denied(await call(local));denied(await call(local,true));assert.deepEqual(readFileSync(file),original);
});
test('actual HTTP refuses terminal hardlink before leaking or replacing Canvas',async()=>{const external=project(join(fixture,'external-terminal'));const local=join(profile.paths.projects,'terminal');mkdirSync(join(local,'.film'),{recursive:true});writeFileSync(join(local,'film.html'),'<!doctype html>');linkSync(join(external,'.film','canvas.json'),join(local,'.film','canvas.json'));const original=readFileSync(join(external,'.film','canvas.json'));denied(await call(local));denied(await call(local,true));assert.deepEqual(readFileSync(join(external,'.film','canvas.json')),original)});
test('actual HTTP refuses a terminal directory junction rather than swallowing it as empty Canvas',async()=>{const local=join(profile.paths.projects,'terminal-junction');mkdirSync(join(local,'.film'),{recursive:true});writeFileSync(join(local,'film.html'),'<!doctype html>');symlinkSync(join(fixture,'outside-terminal-directory'),join(local,'.film','canvas.json'),'junction');denied(await call(local));});
test('refusal occurs before the agent Canvas changed callback',async()=>{const external=project(join(fixture,'callback-outside'));let changed=0;const req=Object.assign(Readable.from([Buffer.from(JSON.stringify({folder:external,ops}))]),{method:'POST'});await assert.rejects(()=>agentCanvasRoute(req,{writeHead(){},end(){}},()=>changed++),e=>e.status===403&&e.code==='isolation-path');assert.equal(changed,0)});
test('valid native Canvas read/write and selected secondary board remain usable',async()=>{
 const local=project(join(profile.paths.projects,'valid'));assert.equal((await call(local)).body.canvas.nodes[0].id,'secret');assert.equal((await call(local,true)).status,200);
 await writeCanvas(local,{nodes:[],edges:[]},'second');const req={method:'GET'};const res={writeHead(){},end(){}};await canvasRoute(req,res,local,'canvas/second');assert.equal((await call(local,true)).body.canvas.nodes[0].id,'new');assert.equal(JSON.parse(readFileSync(join(local,'.film','canvases','second.json'))).nodes[0].id,'new');
});
test('selected secondary terminal hardlink is refused',async()=>{
 const local=project(join(profile.paths.projects,'selected'));await writeCanvas(local,{nodes:[],edges:[]},'other');await canvasRoute({method:'GET'},{writeHead(){},end(){}},local,'canvas/other');
 const {unlinkSync}=await import('node:fs');unlinkSync(join(local,'.film','canvases','other.json'));const target=join(fixture,'secondary-target.json');writeFileSync(target,JSON.stringify(board));linkSync(target,join(local,'.film','canvases','other.json'));denied(await call(local));denied(await call(local,true));assert.equal(JSON.parse(readFileSync(target)).nodes[0].id,'secret');
});
