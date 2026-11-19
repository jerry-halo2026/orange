// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The filter parameters the supplier's `video/list` accepts (contract 8.1), validated once here so
 * the router, the contract layer and the transport cannot drift apart: the outer whitelist decides
 * which keys a caller may use, this module decides what a legal value looks like.
 *
 * Every value is a **string on the wire**, which is why an array or a JSON body is refused instead of
 * being coerced: the supplier would answer a meaningless `total` rather than an error.
 *
 * The change clock is `esUpdateStartTime`/`esUpdateEndTime` with `yyyy-MM-dd` only: `lastModifyTime`
 * is a dead field on the supplier side (1000/1000 rows were 0), and a timestamp with hours is
 * refused by the supplier. `orderByType` exists because the default ordering is *not* newest-first.
 */
import {fail} from './errors.ts';

/** Up to 50 numeric ids, separated by a single comma. */
const ID_LIST=/^[0-9]{1,12}(?:,[0-9]{1,12}){0,49}$/;
/** A single numeric id (a one-level category, a state). */
const SINGLE_ID=/^[0-9]{1,12}$/;
/** A calendar date, and nothing else: no time, no timezone, no separators other than `-`. */
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS=50;

export const ID_LIST_KEYS:readonly string[]=Object.freeze(['twoLevelTypeIds','includeLabelIds','excludeLabelIds','teamIds','groupIds']);
export const ACCOUNT_LIST_KEYS:readonly string[]=Object.freeze(['accountKeys']);
export const ID_NUMBER_KEYS:readonly string[]=Object.freeze(['oneLevelTypeId','videoStateId']);
export const ORDER_KEYS:readonly string[]=Object.freeze(['orderByType']);
/** The only ordering the supplier has been verified to honour: newest first by creation time. */
export const ORDER_VALUES:readonly number[]=Object.freeze([1]);
/** Date pairs; a half pair is refused, and a start after its end is refused. */
export const DATE_PAIRS:readonly (readonly [string,string])[]=Object.freeze([
  Object.freeze(['esUpdateStartTime','esUpdateEndTime'] as const),
  Object.freeze(['uploadStartTime','uploadEndTime'] as const),
]);
export const DATE_KEYS:readonly string[]=Object.freeze(DATE_PAIRS.flat());

/** A comma-separated numeric id list, returned exactly as the caller wrote it. */
export function idList(value:unknown):string {
  if(typeof value!=='string'||!ID_LIST.test(value))return fail('invalid-query',422);
  return value;
}

/** A comma-separated list of account keys; each one a single printable token. */
export function accountKeyList(value:unknown):string {
  if(typeof value!=='string'||!value.length)return fail('invalid-query',422);
  const parts=value.split(',');
  if(parts.length>MAX_ITEMS)return fail('invalid-query',422);
  for(const part of parts){
    if(!part.length||part.length>512||!/^[\x21-\x7e]+$/.test(part))return fail('invalid-query',422);
  }
  return value;
}

/** A single numeric id as a number; `1.5`, text and arrays are refused. */
export function idNumber(value:unknown):number {
  // Over HTTP the value is always a string; an in-process caller may hand the number it parsed.
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?value:fail('invalid-query',422);
  if(typeof value!=='string'||!SINGLE_ID.test(value))return fail('invalid-query',422);
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed))return fail('invalid-query',422);
  return parsed;
}

/** A real calendar day in `yyyy-MM-dd` form; `2026-13-01` and `2026-02-31` are refused. */
export function day(value:unknown):string {
  if(typeof value!=='string'||!DATE.test(value))return fail('invalid-query',422);
  const [year,month,date]=value.split('-').map(Number);
  const stamp=Date.UTC(year,month-1,date);
  const parsed=new Date(stamp);
  if(parsed.getUTCFullYear()!==year||parsed.getUTCMonth()!==month-1||parsed.getUTCDate()!==date)return fail('invalid-query',422);
  return value;
}

/** An ordering code from the reviewed set; the supplier's other codes are not used by this service. */
export function orderByType(value:unknown):number {
  const parsed=typeof value==='number'?value:(typeof value==='string'&&SINGLE_ID.test(value)?Number(value):Number.NaN);
  if(!Number.isSafeInteger(parsed)||!ORDER_VALUES.includes(parsed))return fail('invalid-query',422);
  return parsed;
}

/** Normalize one filter key; `undefined` for an absent key so callers can spread conditionally. */
export function filterValue(key:string,value:unknown):string|number|undefined {
  if(value===undefined)return undefined;
  if(ID_LIST_KEYS.includes(key))return idList(value);
  if(ACCOUNT_LIST_KEYS.includes(key))return accountKeyList(value);
  if(ID_NUMBER_KEYS.includes(key))return idNumber(value);
  if(ORDER_KEYS.includes(key))return orderByType(value);
  if(DATE_KEYS.includes(key))return day(value);
  return undefined;
}

/**
 * Normalize the whole filter set at once, because the date pairs are only legal together.
 * Unknown keys are the caller's whitelist's business, not this module's.
 */
export function filterValues(record:Readonly<Record<string,unknown>>):Record<string,string|number> {
  const out:Record<string,string|number>={};
  for(const key of FILTER_KEYS){
    const value=filterValue(key,record[key]);
    if(value!==undefined)out[key]=value;
  }
  for(const [startKey,endKey] of DATE_PAIRS){
    const start=out[startKey],end=out[endKey];
    if(start===undefined&&end===undefined)continue;
    // A half-open range would quietly mean "everything since/until", so both ends are required.
    if(start===undefined||end===undefined)return fail('invalid-query',422);
    // `yyyy-MM-dd` is ordered lexicographically, so a plain comparison is a date comparison.
    if(String(start)>String(end))return fail('invalid-query',422);
  }
  return out;
}

export const FILTER_KEYS:readonly string[]=Object.freeze([...ID_LIST_KEYS,...ACCOUNT_LIST_KEYS,...ID_NUMBER_KEYS,...ORDER_KEYS,...DATE_KEYS]);
