// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Three-layer material authorization: `public` (company view), `self` (own accountKey) and
 * `granted` (an explicit accountKey allow-list).
 *
 * This is an in-memory prototype only. No production migration is written here; the SQL shape a
 * later task would own is:
 *
 *   create table orange_material_grant (
 *     subject_id uuid not null,
 *     account_key text not null,
 *     granted_by uuid not null,
 *     reason text not null,
 *     revoked_at timestamptz,
 *     primary key (subject_id, account_key)
 *   );
 *
 * Single writer: the trusted service. Readers only select rows with `revoked_at is null`.
 * The prototype keeps the same predicate (`has`) so the shape cannot drift silently.
 *
 * `decide` is pure and synchronous: no network, no clock, so every denial is reproducible.
 */
import {fail} from './errors.ts';

export type AuthorizationLayer='public'|'self'|'granted';
export type Authorization=Readonly<{layer:AuthorizationLayer;reason:string}>;
export type DeniedAuthorization=Readonly<{layer:null;reason:string}>;

/** What the caller asked for. Nothing in here is trusted to widen the result on its own. */
export type MaterialScope=Readonly<{kind:'company'}|{kind:'own'}|{kind:'account';accountKey:string}>;

/** What the trusted service knows about this subject right now. */
export type Access=Readonly<{selfAccountKey?:string;companyAccountKey?:string;grants:readonly string[]}>;

export type Decision=
  Readonly<{allowed:true;authorization:Authorization;accountKey:string}>|
  Readonly<{allowed:false;authorization:DeniedAuthorization;code:'authorization-denied'|'invalid-query'}>;

/** A header-safe external id: printable, non-empty, at most 512 characters. */
const KEY=/^[\x21-\x7e]{1,512}$/;
export const grantKey=(value:unknown):value is string=>typeof value==='string'&&KEY.test(value);

const deny=(reason:string,code:'authorization-denied'|'invalid-query'='authorization-denied'):Decision=>Object.freeze({allowed:false as const,authorization:Object.freeze({layer:null as null,reason}),code});

/**
 * Compare by identity only. No trimming, no case folding, no prefix match: `' KEY '` and `'key'`
 * are different keys and therefore both denied unless one of them was granted exactly.
 */
export function decide(scope:unknown,access:Access):Decision {
  if(!scope||typeof scope!=='object'||Array.isArray(scope))return deny('scope-invalid','invalid-query');
  const kind=(scope as {kind?:unknown}).kind;
  if(kind==='company'){
    if(!grantKey(access.companyAccountKey))return deny('company-view-unavailable');
    return Object.freeze({allowed:true as const,authorization:Object.freeze({layer:'public' as const,reason:'company-view'}),accountKey:access.companyAccountKey});
  }
  if(kind==='own'){
    if(!grantKey(access.selfAccountKey))return deny('self-binding-required');
    return Object.freeze({allowed:true as const,authorization:Object.freeze({layer:'self' as const,reason:'own-account-key'}),accountKey:access.selfAccountKey});
  }
  if(kind==='account'){
    const requested=(scope as {accountKey?:unknown}).accountKey;
    if(!grantKey(requested))return deny('account-key-invalid','invalid-query');
    if(grantKey(access.selfAccountKey)&&requested===access.selfAccountKey)return Object.freeze({allowed:true as const,authorization:Object.freeze({layer:'self' as const,reason:'own-account-key'}),accountKey:requested});
    if(access.grants.includes(requested))return Object.freeze({allowed:true as const,authorization:Object.freeze({layer:'granted' as const,reason:'explicit-account-grant'}),accountKey:requested});
    // A subject with no binding at all has nothing to compare against: name that state, so the caller
    // is not told "this key is not granted" when the truth is "you have no binding".
    if(!grantKey(access.selfAccountKey)&&access.grants.length===0)return deny('self-binding-required');
    return deny('not-self-and-not-granted');
  }
  return deny('scope-invalid','invalid-query');
}

export type GrantStore=Readonly<{
  add(accountKey:string):boolean;
  remove(accountKey:string):boolean;
  has(accountKey:string):boolean;
  list():readonly string[];
}>;

/** Prototype store. Only exact, header-safe keys are accepted; a bad key cannot be stored. */
export function createMemoryGrantStore(initial:readonly unknown[]=[]):GrantStore {
  const keys=new Set<string>();
  for(const value of initial){if(grantKey(value))keys.add(value);else fail('invalid-query',422);}
  return Object.freeze({
    add(accountKey:string){if(!grantKey(accountKey))return fail('invalid-query',422);if(keys.has(accountKey))return false;keys.add(accountKey);return true;},
    remove(accountKey:string){if(!grantKey(accountKey))return fail('invalid-query',422);return keys.delete(accountKey);},
    has(accountKey:string){return grantKey(accountKey)&&keys.has(accountKey);},
    list(){return Object.freeze([...keys]);},
  });
}
