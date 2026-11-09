import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAdmission,BusinessError} from './admission.ts';
import {createSupabase,readConfiguration,type VerifiedSession} from './supabase.ts';

type Admission=ReturnType<typeof createAdmission>;
const send=(res:ServerResponse,status:number,body:unknown)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
async function body(req:IncomingMessage):Promise<unknown>{
 if(!(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new BusinessError('json-required',415);
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw new BusinessError('request-too-large',413);chunks.push(Buffer.from(chunk));}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new BusinessError('invalid-json');}
}
/** Trusted composition root only; HTTP/config cannot install a prepare/verifier/provider. */
export function createApiServer({verify,admission}:{verify:(authorization:unknown)=>Promise<VerifiedSession>;admission:Admission}){
 let stopping=false,closing:Promise<void>|null=null;
 const entered=new Set<Promise<void>>();
 async function handle(req:IncomingMessage,res:ServerResponse){
  if(stopping)return send(res,503,{code:'stopping'});
  const path=new URL(req.url||'/','http://127.0.0.1').pathname;
  if(path==='/health'&&req.method==='GET')return send(res,200,{service:'orange-business',...admission.integration});
  const context=await verify(req.headers.authorization);
  if(path==='/api/materials/resolve'&&req.method==='POST'){
   const value=await body(req) as any;
   if(!value||Object.keys(value).sort().join()!=='purpose,versionIds'||!Array.isArray(value.versionIds)||!['studio','fission','export'].includes(value.purpose))throw new BusinessError('invalid-input');
   return send(res,200,{materials:await admission.resolve(context,value.versionIds,value.purpose)});
  }
  if(path==='/api/fission/claims'&&req.method==='POST'){
   const result=await admission.prepareAndClaim(context,await body(req));
   return send(res,result.status==='duplicate'?409:200,result);
  }
  const match=/^\/api\/fission\/claims\/([^/]+)(?:\/(cancel))?$/.exec(path);
  if(match&&req.method==='GET'&&!match[2])return send(res,200,await admission.status(context,match[1]));
  if(match&&req.method==='POST'&&match[2]==='cancel'){
   const value=await body(req);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length)throw new BusinessError('invalid-input');
   return send(res,200,await admission.cancel(context,match[1]));
  }
  // Start/verified delivery are internal dispatcher/verifier methods, not user JSON endpoints.
  return send(res,404,{code:'not-found'});
 }
 const server=createServer((req,res)=>{
  const task=handle(req,res).catch(error=>{
   const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:500;
   const code=typeof error?.code==='string'&&/^[a-z][a-z0-9-]{0,80}$/.test(error.code)?error.code:'internal-error';send(res,status,{code});
  });
  entered.add(task);void task.then(()=>entered.delete(task),()=>entered.delete(task));
 });
 return {
  async listen(port:number){
   if(!Number.isSafeInteger(port)||port<1||port>65535||stopping)throw new BusinessError('invalid-port');
   await new Promise<void>((yes,no)=>{const failed=(error:Error)=>{server.removeListener('listening',ready);no(error);},ready=()=>{server.removeListener('error',failed);yes();};server.once('error',failed);server.once('listening',ready);server.listen(port,'127.0.0.1');});
  },
  close(){
   stopping=true;if(closing)return closing;
   const active=[...entered];const network=server.listening?new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes())):Promise.resolve();
   server.closeIdleConnections();
   closing=Promise.all([...active,network]).then(()=>{});return closing;
  },
 };
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new BusinessError('configuration-required',503);
  const configuration=await readConfiguration(process.env.ORANGE_API_CONFIG_FILE),supabase=createSupabase(configuration);
  const admission=createAdmission({rpc:supabase.rpc}),api=createApiServer({verify:supabase.verify,admission});
  await api.listen(configuration.port);
  const stop=()=>{void api.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  process.stdout.write(JSON.stringify({service:'orange-business',host:'loopback',port:configuration.port,...admission.integration})+'\n');
 }catch{process.stderr.write('orange-business configuration or startup unavailable\n');process.exitCode=1;}
}