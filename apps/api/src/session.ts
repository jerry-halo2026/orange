// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Session verification for the materials service.
 *
 * There is exactly one source of per-user identity: the Studio server's branded session. A browser
 * never signs anything, and this process never talks to Supabase in the default mode.
 *
 * `hmac` (default) — Studio sends two headers:
 *
 *     x-materials-principal: base64url(JSON {environmentId,subjectId,instanceId,epoch,exp})
 *     x-materials-signature: hex(HMAC-SHA256(MATERIALS_SECRET, canonical))
 *
 *   canonical = "v1\n" + <principal header value, exactly as sent> + "\n" + <METHOD> + "\n" +
 *               <path> + "\n" + <query>
 *
 *   Method, path and raw query are all inside the signature, so a captured request cannot be
 *   replayed against another route, another verb, or another filter set. `exp` is unix seconds;
 *   `epoch` is a positive integer the issuer increments, so a stale generation is distinguishable
 *   from a fresh one even before `exp` passes.
 *
 * `supabase` — the process verifies a bearer token with `verifyBearer` instead. It requires an
 * origin and a publishable key in the environment and refuses to start without them; there is no
 * silent fallback to another mode.
 *
 * Every rejection is `authentication-required` (403), is decided before any supplier traffic, and
 * never reflects the reason in the response body.
 */
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {adoptVerifiedSession, verifyBearer, type VerifiedSession} from './supabase.ts';
import {fail} from './errors.ts';
import type {Verify, VerifyRequest} from './server.ts';

export type SessionMode='hmac'|'supabase';
export const PRINCIPAL_HEADER='x-materials-principal';
export const SIGNATURE_HEADER='x-materials-signature';
export const CANONICAL_VERSION='v1';

export type HmacPrincipal=Readonly<{environmentId:string;subjectId:string;instanceId:string;epoch:number;exp:number}>;

/** What a refused request may report: the request line and the principal's shape, nothing else. */
export type SessionDiagnostics=(info:Readonly<{mode:'hmac';reason:string;method:string;path:string;query:string;principalLength:number;principalSha8:string|null;hasSignature:boolean}>)=>void;

const PRINCIPAL_KEYS='environmentId,epoch,exp,instanceId,subjectId';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const BASE64URL=/^[A-Za-z0-9_-]{1,2048}$/;
const MAX_QUERY=4096;

const denied=():never=>fail('authentication-required',403);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;

/** The exact bytes Studio must sign. Exported so P1-B can assert against it instead of guessing. */
export function canonicalRequest(input:Readonly<{principal:string;method:string;path:string;query:string}>):string {
  return [CANONICAL_VERSION,input.principal,input.method.toUpperCase(),input.path,input.query].join('\n');
}

export function signRequest(secret:string,input:Readonly<{principal:string;method:string;path:string;query:string}>):string {
  return createHmac('sha256',secret).update(canonicalRequest(input),'utf8').digest('hex');
}

function decodePrincipal(header:string|undefined):HmacPrincipal {
  if(typeof header!=='string')return denied();
  // A client encoder may pad base64url with trailing '='. The padding is not part of the value, so
  // it is accepted here; the signature still covers the header bytes exactly as they were sent.
  const core=header.replace(/=+$/,'');
  if(!BASE64URL.test(core))return denied();
  let decoded:unknown;
  try{decoded=JSON.parse(Buffer.from(core,'base64url').toString('utf8'));}catch{return denied();}
  if(!plain(decoded))return denied();
  if(Object.keys(decoded).sort().join()!==PRINCIPAL_KEYS)return denied();
  const {environmentId,subjectId,instanceId,epoch,exp}=decoded as Record<string,unknown>;
  if(typeof environmentId!=='string'||!/^[\x21-\x7e]{1,256}$/.test(environmentId))return denied();
  if(typeof subjectId!=='string'||!UUID.test(subjectId))return denied();
  if(typeof instanceId!=='string'||!UUID.test(instanceId))return denied();
  if(!Number.isSafeInteger(epoch)||(epoch as number)<1)return denied();
  if(!Number.isSafeInteger(exp)||(exp as number)<1)return denied();
  return Object.freeze({environmentId,subjectId,instanceId,epoch:epoch as number,exp:exp as number});
}

function signatureMatches(provided:string|undefined,expected:string):boolean {
  if(typeof provided!=='string'||!/^[a-f0-9]{64}$/.test(provided))return false;
  const left=Buffer.from(provided,'hex'),right=Buffer.from(expected,'hex');
  if(left.length!==right.length)return false;
  return timingSafeEqual(left,right);
}

/**
 * The `hmac` verifier. `now` is injectable so the clock boundary is testable without sleeping.
 * Order: structure → signature → freshness. The signature is checked before the timestamp so a
 * forged principal cannot probe for a valid expiry window.
 *
 * `diagnostics` is optional and exists for one reason: a client that signs correctly but is still
 * refused has to be able to see *which* input differed. It receives the request line and the shape
 * of the principal — never the secret, never the signature, never a principal value.
 */
export function createHmacVerifier(options:Readonly<{secret:string;now?:()=>number;diagnostics?:SessionDiagnostics}>):Verify {
  if(!options||typeof options.secret!=='string'||options.secret.length<32)return fail('configuration-required');
  const now=options.now??Date.now;
  const report=(reason:string,request:VerifyRequest,principalHeader:string|undefined,signature:string|undefined)=>{
    if(!options.diagnostics)return;
    try{
      const value=typeof principalHeader==='string'?principalHeader:'';
      options.diagnostics(Object.freeze({
        mode:'hmac' as const,
        reason,
        method:request.method,
        path:request.path,
        query:request.query,
        principalLength:value.length,
        principalSha8:value.length?createHash('sha256').update(value,'utf8').digest('hex').slice(0,8):null,
        hasSignature:typeof signature==='string'&&signature.length>0,
      }));
    }catch{/* a diagnostic must never change the outcome */}
  };
  return async (request:VerifyRequest):Promise<VerifiedSession>=>{
    const principalHeader=request.header(PRINCIPAL_HEADER);
    const signatureHeader=request.header(SIGNATURE_HEADER);
    let principal:HmacPrincipal;
    try{principal=decodePrincipal(principalHeader);}
    catch{report('principal-unusable',request,principalHeader,signatureHeader);throw fail('authentication-required',403);}
    if(Buffer.byteLength(request.query,'utf8')>MAX_QUERY){report('query-too-long',request,principalHeader,signatureHeader);return denied();}
    const expected=signRequest(options.secret,{principal:principalHeader as string,method:request.method,path:request.path,query:request.query});
    if(!signatureMatches(signatureHeader,expected)){report('signature-mismatch',request,principalHeader,signatureHeader);return denied();}
    const nowMs=now();
    if(!Number.isSafeInteger(nowMs)||nowMs<0){report('clock-unusable',request,principalHeader,signatureHeader);return denied();}
    const expiresAtMs=principal.exp*1000;
    if(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=nowMs){report('expired',request,principalHeader,signatureHeader);return denied();}
    return adoptVerifiedSession({subjectId:principal.subjectId,sessionId:principal.instanceId,expiresAtMs,environmentId:principal.environmentId});
  };
}

/** The `supabase` verifier: the original bearer path, untouched. */
export function createSupabaseVerifier(options:Readonly<{environmentId:string;supabaseOrigin:string;publishableKey:string}>):Verify {
  if(!options||typeof options.environmentId!=='string'||typeof options.supabaseOrigin!=='string'||typeof options.publishableKey!=='string')return fail('configuration-required');
  return async (request:VerifyRequest)=>verifyBearer({environmentId:options.environmentId,supabaseOrigin:options.supabaseOrigin,publishableKey:options.publishableKey},request.authorization);
}
