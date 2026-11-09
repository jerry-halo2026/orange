import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base=process.env.ORANGE_LOGIN_TEST_ROOT;
assert.ok(base&&resolve(base)===base,'explicit owned scratch is required');await mkdir(base,{recursive:true});
const cli=fileURLToPath(new URL('./openfilm.mjs',import.meta.url));
async function run(command,marker='project',scenario=null){
 const root=await mkdtemp(join(base,'cli-')),project=join(root,'project');await mkdir(join(project,'.film'),{recursive:true});
 await writeFile(join(project,'film.html'),'<!doctype html><html><body></body></html>');await writeFile(join(project,'.film','opened'),'synthetic');
 if(marker!=='none')await writeFile(join(marker==='ancestor'?root:project,'.openfilm-control.json'),JSON.stringify({version:1,domainId:'synthetic'}));
 const argv=[command];
 if(scenario){
  const owned=join(root,'controlled-A');await mkdir(join(owned,'.film'),{recursive:true});await writeFile(join(owned,'film.html'),'<!doctype html><html><body></body></html>');await writeFile(join(owned,'.film','opened'),'synthetic');await writeFile(join(owned,'.openfilm-control.json'),JSON.stringify({version:1,domainId:'controlled-A'}));
  if(scenario==='folder')argv.push(owned);
  else if(scenario==='html')argv.push(join(owned,'film.html'));
  else if(scenario==='last-path')argv.push(join(project,'film.html'),'0-2',join(owned,'film.html'));
  else if(scenario==='out')argv.push(join(project,'film.html'),'--out',join(owned,'output.mp4'));
  else throw Error('unknown test scenario');
 }
 const fixture=join(root,'deny-capabilities.mjs');
 await writeFile(fixture,`import child from 'node:child_process';import http from 'node:http';import https from 'node:https';import net from 'node:net';import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';const user=os.userInfo();os.userInfo=()=>({...user,homedir:${JSON.stringify(join(root,'own-os-home'))}});const blocked=()=>{process.stderr.write('FORBIDDEN_NATIVE_CAPABILITY\\n');throw Error('fixture refuses native execution before authentication');};for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[k]=blocked;http.createServer=blocked;http.request=blocked;https.request=blocked;net.connect=blocked;net.createConnection=blocked;globalThis.fetch=blocked;syncBuiltinESMExports();`);
 const env={...process.env};for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','XDG_CONFIG_HOME']){env[key]=join(root,key);await mkdir(env[key]);}
 delete env.OPENFILM_ISOLATION_PROFILE;delete env.OPENFILM_ISOLATION_ROOT;
 env.OPENFILM_HOME=join(root,'home');env.OPENFILM_SHARED_HOME=env.OPENFILM_HOME;env.OPENFILM_NO_UPDATE_CHECK='1';env.OPENFILM_NO_BROWSER='1';
 const child=spawn(process.execPath,['--import',pathToFileURL(fixture).href,cli,...argv],{cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',exit;const timer=setTimeout(()=>child.kill(),5000);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('exit',(code,signal)=>exit={code,signal});
 await new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{clearTimeout(timer);assert.equal(code,exit.code);assert.equal(signal,exit.signal);done();});});
 return {stdout,stderr,exit,files:await readdir(join(project,'.film'))};
}
for(const command of ['look','render'])for(const marker of ['project','ancestor'])test(`original CLI ${command} refuses ${marker} controlled ownership before host or native capabilities`,async()=>{
 const result=await run(command,marker);assert.equal(result.exit.code,1);assert.equal(result.exit.signal,null);
 assert.match(result.stderr,/logged-in Studio/);assert.doesNotMatch(result.stderr,/FORBIDDEN_NATIVE_CAPABILITY/);
 assert.deepEqual(result.files,['opened']);
});
test('original CLI help and version retain native availability without account activation',async()=>{
 for(const command of ['--help','--version']){const result=await run(command,'none');assert.equal(result.exit.code,0);assert.doesNotMatch(result.stderr,/FORBIDDEN_NATIVE_CAPABILITY/);assert.ok(result.stdout.length);}
});
for(const command of ['look','render'])for(const scenario of command==='render'?['folder','html','last-path','out']:['folder','html','last-path'])test(`original CLI ${command} from unmarked cwd refuses controlled ${scenario} before native execution`,async()=>{
 const result=await run(command,'none',scenario);assert.equal(result.exit.code,1);assert.equal(result.exit.signal,null);
 assert.match(result.stderr,/logged-in Studio/);assert.doesNotMatch(result.stderr,/FORBIDDEN_NATIVE_CAPABILITY/);
 assert.deepEqual(result.files,['opened']);
});
