import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLog } from './chat-store.mjs';
import { agentProblem, registerLocalAgentIpc, sentError, turnModel } from './local-agents-ipc.mjs';

test("a start that fails is written in the log of the turn it was for, with why", async () => {
  const handlers = new Map();
  registerLocalAgentIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { trusted: () => true });
  const project = mkdtempSync(join(tmpdir(), 'openfilm-ipc-'));
  const event = { sender: { once() {}, isDestroyed: () => false, send() {} } };
  /* the own key with no models set up: refused before anything starts */
  const r = await handlers.get('desktop:local-agents:start')(event, { agent: 'byok', cwd: project, meta: { turnId: 'local:startfail1' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-ready');
  await new Promise((done) => setTimeout(done, 50));
  const start = readLog(project, 'local:startfail1')?.events.find((e) => e.kind === 'start');
  assert.ok(start, 'the turn has a log');
  assert.equal(start.ok, false);
  assert.equal(start.error, r.error);
  assert.equal(start.agent, 'byok');
  assert.equal(start.meta.turnId, 'local:startfail1');
});

test('an agent that failed, as its problem is kept: its name, why, the step, the last of its stderr and its turn\'s log', () => {
  const session = { stderr: 'a\nb\nc\nd\ne\nError: write EPIPE\n' };
  const e = Object.assign(new Error('ACP connection closed'), { code: -32603 });
  assert.deepEqual(agentProblem({ agent: 'codex', cwd: '/p/Film', session }, 'prompt', e, 'local:abc'), {
    area: 'agent', agent: 'Codex', agentId: 'codex', what: 'ACP connection closed', step: 'prompt', code: '-32603',
    project: '/p/Film', log: join('/p/Film', '.film', 'logs', 'local-abc.jsonl'), stderr: 'b\nc\nd\ne\nError: write EPIPE',
  });
  /* a session that says how it failed (agents.mjs `failure()`): its step, program and own logs */
  const told = { failure: () => ({ step: 'session/new', program: '/x/codex', stderr: '', ownLogs: '/h/.codex' }) };
  assert.deepEqual(agentProblem({ agent: 'codex', cwd: '/p/Film', session: told }, 'start', new Error('Internal error')), {
    area: 'agent', agent: 'Codex', agentId: 'codex', what: 'Internal error', step: 'session/new', project: '/p/Film', program: '/x/codex', ownLogs: '/h/.codex',
  });
  assert.equal(agentProblem({ agent: 'byok', cwd: '/p' }, 'start', 'no models').agent, 'Own key');
});

test('the error as the agent sent it, under any rewording on the way; none when it sent none', () => {
  const sent = Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'stream closed' } });
  const reworded = new Error('Codex stopped while answering without saying why.', { cause: new Error('stream closed', { cause: sent }) });
  assert.deepEqual(sentError(reworded), { code: -32603, message: 'Internal error', data: { details: 'stream closed' } });
  assert.equal(sentError(new Error('not installed')), null);
});

test("a Copilot turn's model, read once its usage record has reached the file; another agent's turn doesn't wait", async () => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-copilot-'));
  mkdirSync(join(home, 'session-state', 'cop-24680'), { recursive: true });
  const file = join(home, 'session-state', 'cop-24680', 'events.jsonl');
  const from = Date.now();
  const at = (ms) => new Date(from + ms).toISOString();
  writeFileSync(file, `${JSON.stringify({ type: 'user.message', data: { content: 'Make a title' }, timestamp: at(0) })}
`);
  /* a one-request turn: Copilot writes the request's usage record a moment after the prompt has answered */
  const usage = { type: 'session.usage_record', timestamp: at(50), data: { usage: { model: 'gpt-6-luna', modelDisplayName: 'GPT-6 Luna', apiCallId: 'a1' } } };
  setTimeout(() => appendFileSync(file, `${JSON.stringify(usage)}
`), 200);
  const env = { COPILOT_HOME: home };
  assert.equal(await turnModel({ agent: 'copilot', sessionId: 'cop-24680', from, env }), 'GPT-6 Luna');

  const started = Date.now();
  assert.equal(await turnModel({ agent: 'claude', sessionId: 'cop-24680', from, env }), null);
  assert.ok(Date.now() - started < 100, 'not waited for');
});

test("Studio's own question: answered by the agent's model in a session of its own, its words whole, every permission refused", async () => {
  /* DeepSeek Harness as a fake over ACP: it asks to run a command (refused), then answers in two pieces */
  const { setChosenPaths } = await import('./agents.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'of-ask-'));
  const program = join(dir, 'dsh.mjs');
  writeFileSync(program, `let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let prompt = null;
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      prompt = m;
      send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't1', title: 'rm -rf' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] } });
    } else if (m.id === 900) {
      const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: u } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"lines": ["Hal' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo."], "refused": ' + JSON.stringify(m.result?.outcome?.outcome ?? null) + '}' } });
      send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    }
  }
});
setInterval(() => {}, 1000);
`);
  setChosenPaths({ deepseek: program });
  try {
    const agents = registerLocalAgentIpc({ handle: () => {} }, { trusted: () => true });
    const answer = await agents.ask('deepseek', 'Translate: Hello.');
    assert.deepEqual(JSON.parse(answer), { lines: ['Hallo.'], refused: 'cancelled' });
    await assert.rejects(agents.ask('nobody', 'hi'), /Unknown agent/);
    assert.equal(agents.lastAgent(), null, 'a question of Studio\'s is not the chat\'s conversation');
  } finally {
    setChosenPaths({});
  }
});

// Forward T03.quit: IPC admission is sealed before an async resource dependency can return.
test('closeAll returns an actual pending receipt and blocks late probe/start admission',async()=>{
 let release;const dependency=new Promise(r=>release=r),handlers=new Map();
 const agents=registerLocalAgentIpc({handle:(name,fn)=>handlers.set(name,fn)},{trusted:()=>true,harness:()=>dependency});
 const event={sender:{once(){},isDestroyed:()=>false,send(){}}};
 const pending=handlers.get('desktop:local-agents:probe')(event,{agent:'byok'});
 let done=false;const closing=agents.closeAll();assert.equal(typeof closing?.then,'function');closing.then(()=>done=true,()=>done=true);
 await Promise.resolve();assert.equal(done,false,'entered handler must still be retained');release(null);await pending;await closing;
 await assert.rejects(Promise.resolve().then(()=>handlers.get('desktop:local-agents:start')(event,{agent:'byok',cwd:process.env.TEMP})),/retir|clos|seal/i);
});

test('closeAll awaits an original active prompt and its delayed native turn-record finalization',async()=>{
 const {setChosenPaths}=await import('./agents.mjs');const dir=mkdtempSync(join(tmpdir(),'of-ipc-retire-record-')),program=join(dir,'qwen.mjs');
 writeFileSync(program,`let buf='',prompt=null,ended=false;const timer=setInterval(()=>{},1000);const send=(m,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);if(m.method==='initialize')send(m,{protocolVersion:1,agentCapabilities:{},authMethods:[]});else if(m.method==='session/new')send(m,{sessionId:'s1'});else if(m.method==='session/prompt')prompt=m;else if(m.method==='session/cancel'){if(prompt){send(prompt,{stopReason:'cancelled'});prompt=null;}}else if(m.method&&m.method.endsWith('/close')){ended=true;send(m,{});}}});process.stdin.on('end',()=>{clearInterval(timer);process.exit(ended?0:1);});`);
 setChosenPaths({qwen:program});const handlers=new Map(),agents=registerLocalAgentIpc({handle:(name,fn)=>handlers.set(name,fn)},{trusted:()=>true});const event={sender:{once(){},isDestroyed:()=>false,send(){}}};
 try{
 const start=await handlers.get('desktop:local-agents:start')(event,{agent:'qwen',cwd:dir});assert.equal(start.ok,true);
 const prompt=handlers.get('desktop:local-agents:prompt')(event,{key:start.key,text:'synthetic only',meta:{turnId:'local:retire-record'}});await new Promise(r=>setImmediate(r));
 const at=Date.now(),closing=agents.closeAll();await prompt;await closing;assert.ok(Date.now()-at>=700,'original late keepAgentRecord still settles before receipt');
 const done=readLog(dir,'local:retire-record')?.events.find(e=>e.kind==='done');assert.ok(done,'original turn done record is durable before the receipt');
 }finally{setChosenPaths({});}
});

// Forward P2: original JSONL writer with actual owned descriptors; no equivalent fake log.
async function heldNativeWrites(run) {
 const {createRequire,syncBuiltinESMExports}=await import('node:module'),fs=createRequire(import.meta.url)('node:fs'),original=fs.createWriteStream;
 const writes=[],closes=[],streams=[],fds=[];let finishes=0,closed=0;
 fs.createWriteStream=(file,options)=>{
 const stream=original(file,{...options,fs:{open(file,flags,mode,callback){fs.open(file,flags,mode,(error,fd)=>{if(!error)fds.push(fd);callback(error,fd);});},write(...args){writes.push(()=>fs.write(...args));},writev(...args){writes.push(()=>fs.writev(...args));},close(...args){closes.push(()=>fs.close(...args));}}});streams.push(stream);stream.on('finish',()=>finishes++);stream.on('close',()=>closed++);return stream;
 };syncBuiltinESMExports();
 const releaseWrites=()=>writes.splice(0).forEach(release=>release()),releaseCloses=()=>closes.splice(0).forEach(release=>release()),wait=async test=>{for(let i=0;i<200&&!test();i++)await new Promise(r=>setTimeout(r,5));assert.ok(test(),'actual filesystem barrier was reached');};
 try{return await run({fs,writes,closes,streams,fds,releaseWrites,releaseCloses,wait,finished:()=>finishes,closed:()=>closed});}
 finally{for(const stream of streams)if(!stream.writableEnded)stream.end();for(let i=0;i<200&&closed<streams.length;i++){releaseWrites();releaseCloses();await new Promise(r=>setTimeout(r,5));}fs.createWriteStream=original;syncBuiltinESMExports();}
}
test('original log end waits for real filesystem finish and close, not merely stream.end return',async()=>{
 const {openLog}=await import('./chat-store.mjs');const project=mkdtempSync(join(tmpdir(),'of-log-barrier-'));
 await heldNativeWrites(async h=>{const writer=openLog(project,'local:barrier');writer.write('prompt',{text:'synthetic'});let done=false;const ending=writer.end();assert.equal(typeof ending?.then,'function');ending.then(()=>done=true);await h.wait(()=>h.writes.length>0);assert.equal(done,false);assert.ok(h.fs.fstatSync(h.fds[0]).isFile());h.releaseWrites();await h.wait(()=>h.closes.length>0);assert.equal(h.finished(),1);assert.equal(done,false,'finish is not descriptor close');assert.ok(h.fs.fstatSync(h.fds[0]).isFile());h.releaseCloses();await ending;assert.equal(h.closed(),1);assert.throws(()=>h.fs.fstatSync(h.fds[0]),{code:'EBADF'});});
});
test('original log close promise rejects a genuine owned filesystem open/write failure',async()=>{
 const {openLog}=await import('./chat-store.mjs');const project=mkdtempSync(join(tmpdir(),'of-log-failure-'));mkdirSync(join(project,'.film/logs/local-failure.jsonl'),{recursive:true});let errors=0;
 const log=openLog(project,'local:failure',()=>errors++);log.write('prompt',{text:'synthetic'});await assert.rejects(Promise.resolve(log.end()),/EISDIR|EPERM|EACCES|writer|log|preserv/i);assert.ok(errors>0);
});
async function adoptedNativeFixture(dir,{developer=false}={}) {
 const {setChosenPaths}=await import('./agents.mjs'),program=join(dir,'qwen.mjs');
 writeFileSync(program,`let buf='',ended=false;const timer=setInterval(()=>{},1000);const send=(m,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);if(m.method==='initialize')send(m,{protocolVersion:1,agentCapabilities:{},authMethods:[]});else if(m.method==='session/new')send(m,{sessionId:'s-12345678'});else if(m.method&&m.method.endsWith('/close')){ended=true;send(m,{});}}});process.stdin.on('end',()=>{clearInterval(timer);process.exit(ended?0:1);});`);
 setChosenPaths({qwen:program});const handlers=new Map(),bridge=registerLocalAgentIpc({handle:(name,fn)=>handlers.set(name,fn)},{trusted:()=>true,logDir:()=>developer?join(dir,'vendor-logs'):null}),event={sender:{once(){},isDestroyed:()=>false,send(){}}};const start=await handlers.get('desktop:local-agents:start')(event,{agent:'qwen',cwd:dir});assert.equal(start.ok,true);return {bridge,handlers,event,key:start.key,reset:()=>setChosenPaths({})};
}
test('strict closeAll waits for adopted native log actual descriptor close and late backfill',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'of-adopt-flush-')),f=await adoptedNativeFixture(dir);try{await heldNativeWrites(async h=>{
 await f.handlers.get('desktop:local-agents:adopt')(f.event,{key:f.key,turnId:'local:adopt'});await h.wait(()=>h.writes.length>0);let done=false;const closing=f.bridge.closeAll();closing.then(()=>done=true,()=>done=true);await new Promise(r=>setTimeout(r,150));assert.equal(done,false,'closed Agent process/empty session map is not a log flush receipt');await h.wait(()=>{h.releaseWrites();return h.closes.length>0;});assert.equal(done,false);h.releaseCloses();await closing;assert.equal(h.closed(),1);const log=readLog(dir,'local:adopt');assert.ok(log.events.some(e=>e.kind==='done'&&e.unprompted));
 });}finally{f.reset();}
});
test('adopted native writer failure rejects strict retirement even after Agent close0',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'of-adopt-failure-'));mkdirSync(join(dir,'.film/logs/local-adopt-fail.jsonl'),{recursive:true});const f=await adoptedNativeFixture(dir);
 try{await f.handlers.get('desktop:local-agents:adopt')(f.event,{key:f.key,turnId:'local:adopt-fail'});await new Promise(r=>setTimeout(r,20));await assert.rejects(f.bridge.closeAll(),/retir|log|writer|preserv/i);}finally{f.reset();}
});
test('late vendor record lookup may be absent but entered native model-log IO failure is not swallowed',async()=>{
 const {keepAgentRecord}=await import('./local-agents-ipc.mjs'),{agentRecordCalls}=await import('./agent-records.mjs');const dir=mkdtempSync(join(tmpdir(),'of-backfill-failure-')),vendor=join(dir,'vendor');mkdirSync(vendor);const now=Date.now();
 writeFileSync(join(vendor,'openai-1.json'),JSON.stringify({timestamp:new Date(now).toISOString(),request:{messages:[{role:'user',content:'synthetic'}]},response:null,context:{sessionId:'s-12345678'}}));const agentLog={agent:'qwen',dir:vendor};assert.equal(agentRecordCalls({agent:'qwen',sessionId:'s-12345678',log:agentLog,from:now-1,to:now+1}).calls.length,1,'actual original parser finds the owned fixture');
 mkdirSync(join(dir,'.film/logs/local-backfill.model.jsonl'),{recursive:true});await assert.rejects(keepAgentRecord({agent:'qwen',sessionId:'s-12345678',cwd:dir,turnId:'local:backfill',from:now-1,to:now+1,agentLog,settleMs:0}),/EISDIR|EPERM|EACCES|writer|log|preserv/i);
});

test('strict adopted late model-backfill write failure is retained by the aggregate receipt',async()=>{
 const {readdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'of-adopt-backfill-failure-')),f=await adoptedNativeFixture(dir,{developer:true});
 try{
 await f.handlers.get('desktop:local-agents:adopt')(f.event,{key:f.key,turnId:'local:late-model'});const parent=join(dir,'vendor-logs/qwen'),vendor=join(parent,readdirSync(parent)[0]),now=Date.now();
 writeFileSync(join(vendor,'openai-1.json'),JSON.stringify({timestamp:new Date(now).toISOString(),request:{messages:[{role:'user',content:'synthetic'}]},response:null,context:{sessionId:'s-12345678'}}));mkdirSync(join(dir,'.film/logs/local-late-model.model.jsonl'),{recursive:true});
 await assert.rejects(f.bridge.closeAll(),/retir|preserv|EPERM|EISDIR|EACCES/i);
 }finally{f.reset();}
});