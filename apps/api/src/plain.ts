// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The contract layer's last step: unwrap the supplier's `{sourceType,source}` numbers into plain
 * values for the routes whose UI contract says `number` / `string`.
 *
 * The transport keeps numbers as their literal lexeme (`{sourceType:'number',source:'1234.50'}`)
 * because rounding must not happen while a value is still wire data. The `list` route publishes that
 * shape deliberately (`videoId`, `observation`), but `facets` and `labels` are consumed as plain
 * numbers and strings by the editor's `OneLevelCategory` / `TwoLevelCategory` / label types, so they
 * are unwrapped here — once, at the boundary, with no second interpretation anywhere else.
 *
 * Unwrapping failures are **not** dropped silently: an object that is neither a number wrapper nor a
 * plain value is reported as `provider-response-unconfirmed`, the same code used for any other
 * supplier payload this service cannot interpret. Silence would turn a broken category tree into an
 * empty panel, which is exactly the failure mode this layer exists to prevent.
 */
import {fail} from './errors.ts';

export type PlainValue=string|number|boolean|null;
export type PlainTree=PlainValue|readonly PlainTree[]|{readonly [key:string]:PlainTree};
export type PlainRow=Readonly<Record<string,PlainTree>>;
export type PlainCell=PlainTree;

const isWrapper=(value:unknown):value is {sourceType:'number';source:string}=>
  !!value&&typeof value==='object'&&(value as {sourceType?:unknown}).sourceType==='number'&&typeof (value as {source?:unknown}).source==='string';

/** One supplier value as the contract wants it: number, text, boolean or null. */
export function plainValue(value:unknown):PlainValue {
  if(value===null||value===undefined)return null;
  if(typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(isWrapper(value)){
    const parsed=Number(value.source);
    if(!Number.isFinite(parsed))return fail('provider-response-unconfirmed');
    return parsed;
  }
  // Objects that are not a number wrapper, and arrays where a scalar belongs, are shapes this
  // contract cannot publish: report them instead of quietly emitting `[object Object]`.
  return fail('provider-response-unconfirmed');
}

/** One supplier row as a plain row; array-valued cells keep their order with plain elements. */
export function plainRow(value:unknown):PlainRow {
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('provider-response-unconfirmed');
  const out:Record<string,PlainCell>={};
  for(const [key,cell] of Object.entries(value as Record<string,unknown>)){
    // An array cell is either a list of scalars or a list of nested rows (children), and both are
    // unwrapped the same way.
    if(Array.isArray(cell))out[key]=Object.freeze(cell.map(entry=>entry&&typeof entry==='object'&&!isWrapper(entry)?plainRow(entry):plainValue(entry)));
    else out[key]=plainValue(cell);
  }
  return Object.freeze(out);
}

export function plainRows(values:unknown):readonly PlainRow[] {
  if(!Array.isArray(values))return fail('provider-response-unconfirmed');
  return Object.freeze(values.map(entry=>plainRow(entry)));
}
