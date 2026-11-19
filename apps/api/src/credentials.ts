// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Read-only credential intake for the Zhishang supplier.
 *
 * The only accepted source is the ignored file `.dev/zhishang/credentials.local.json`
 * (ignored by `.gitignore:11`). Nothing here accepts a credential from a parameter, an
 * environment variable, argv, or a caller-supplied object, and no value is ever returned in an
 * error message, logged, or written back.
 *
 * Returned shape is exactly what the transport needs; `origin` is validated against the fixed
 * supplier origin and then dropped, so a tampered file cannot redirect company credentials.
 */
import {open, lstat, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, normalize, parse, resolve, sep} from 'node:path';
import {fail} from './errors.ts';

/** The one supplier origin this package talks to. */
export const SUPPLIER_ORIGIN='https://sucaiwang-open-api.zhishangsoft.com';

export type SupplierCredentials=Readonly<{
  environmentId:string;
  companyKey:string;
  companySecret:string;
  /** Optional company service account. */
  accountKey?:string;
  /** Optional raw-download host allow-list; main.ts owns its validation and error code. */
  rawHosts?:unknown;
}>;

const MAX_FILE_BYTES=32768;
// Required keys. `note` is an operator annotation the local file carries: it is read, validated,
// then dropped. It is not a credential and never leaves this function; any other extra key is
// still refused.
const REQUIRED:readonly string[]=Object.freeze(['companyKey','companySecret','environmentId','origin']);
// ccountKey is the company service account the public pool is read as. It is a mapping value, not
// a credential, but it lives here because the company-level token has no user identity of its own.
const OPTIONAL:readonly string[]=Object.freeze(['accountKey','note','rawHosts']);

const printable=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);

/** The default ignored location, relative to a checkout root. Not a secret. */
export function credentialsPath(checkoutRoot:string):string {
  return resolve(checkoutRoot,'.dev','zhishang','credentials.local.json');
}

/**
 * The file must live in an ignored `.dev` tree with the fixed name: a tilde/symlinked or
 * relocated file is refused before it is opened, so a stray copy under a tracked directory
 * cannot become the source by accident.
 */
export function assertIgnoredLocation(file:string):string {
  if(!isAbsolute(file))return fail('configuration-required');
  const normalized=normalize(file);
  if(normalized===parse(normalized).root)return fail('configuration-required');
  const segments=normalized.split(sep);
  if(!segments.includes('.dev'))return fail('configuration-required');
  if(!/^credentials\.local\.json$/.test(segments[segments.length-1]??''))return fail('configuration-required');
  return normalized;
}

export async function readSupplierCredentials(file:unknown):Promise<SupplierCredentials> {
  try{
    if(typeof file!=='string')return fail('configuration-required');
    const target=assertIgnoredLocation(file);
    for(let p=target;;p=dirname(p)){
      const stat=await lstat(p);
      if(stat.isSymbolicLink())return fail('configuration-required');
      if(p===target?!(stat.isFile()&&stat.nlink===1&&stat.size>0&&stat.size<=MAX_FILE_BYTES):!stat.isDirectory())return fail('configuration-required');
      if(p===dirname(p))break;
    }
    // Resolve the parent first: this tolerates an 8.3 short path prefix while still refusing a
    // file that resolves out of its own directory (symlink or junction redirection).
    const parent=await realpath(dirname(target));
    const actual=await realpath(target);
    if(actual.toLowerCase()!==resolve(parent,target.slice(target.lastIndexOf(sep)+1)).toLowerCase())return fail('configuration-required');
    const handle=await open(target,'r');
    let raw:unknown;
    try{
      const stat=await handle.stat();
      if(!stat.isFile()||stat.nlink!==1||stat.size<=0||stat.size>MAX_FILE_BYTES)return fail('configuration-required');
      let parsed:unknown;
      try{
        // A Windows editor may save the file with a UTF-8 BOM; the BOM is not part of the JSON.
        const text=await handle.readFile('utf8');
        parsed=JSON.parse(text.charCodeAt(0)===0xfeff?text.slice(1):text);
      }catch{return fail('configuration-required');}
      raw=parsed;
    }finally{await handle.close();}
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.getPrototypeOf(raw)!==Object.prototype)return fail('configuration-required');
    const record=raw as Record<string,unknown>;
    const keys=Object.keys(record);
    if(keys.some(key=>!REQUIRED.includes(key)&&!OPTIONAL.includes(key)))return fail('configuration-required');
    if(REQUIRED.some(key=>!keys.includes(key)))return fail('configuration-required');
    if(!printable(record.environmentId,256))return fail('configuration-required');
    if(!printable(record.companyKey,8192))return fail('configuration-required');
    if(!printable(record.companySecret,8192))return fail('configuration-required');
    if(record.note!==undefined&&!printable(record.note,256))return fail('configuration-required');
    // Shape only: main.ts validates it and reports company-key-invalid, so an operator sees the
    // reason instead of a generic configuration error.
    if(record.accountKey!==undefined&&!printable(record.accountKey,512))return fail('configuration-required');
    // rawHosts is passed through as-is so main.ts can report raw-hosts-invalid for a bad entry
    // instead of a generic configuration error.
    if(record.origin!==SUPPLIER_ORIGIN)return fail('configuration-required');
    return Object.freeze({environmentId:record.environmentId,companyKey:record.companyKey,companySecret:record.companySecret,...(record.accountKey===undefined?{}:{accountKey:record.accountKey as string}),...(record.rawHosts===undefined?{}:{rawHosts:record.rawHosts})});
  }catch(error){
    // Re-thrown errors carry the code only: no path, no value, no parse detail.
    if(error&&typeof error==='object'&&(error as {code?:unknown}).code==='configuration-required')throw error;
    return fail('configuration-required');
  }
}
