// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The supplier-side change clock is unreliable: `lastModifyTime` is a dead field (every sampled row
 * carried 0), and `esUpdateStartTime/EndTime` only accepts a calendar day. So "did this row change?"
 * cannot be answered by the supplier — it is answered here, by comparing a content fingerprint of the
 * fields the material centre actually shows.
 *
 * The fingerprint is deliberately narrow: two rows that differ only in a field nobody displays should
 * not be rewritten on every sync, and a change to anything a card shows must be rewritten.
 */
import {createHash} from 'node:crypto';

export type HashFields=Readonly<{
  name?:unknown;
  size?:unknown;
  duration?:unknown;
  category2?:unknown;
  labels?:unknown;
  createTime?:unknown;
  account?:unknown;
}>;

const normalize=(value:unknown):string=>{
  if(value===null||value===undefined)return '';
  if(Array.isArray(value))return value.map(entry=>normalize(entry)).sort().join(',');
  if(typeof value==='object'){
    const record=value as {source?:unknown;sourceType?:unknown};
    // A supplier number arrives as `{sourceType:'number',source}`; the literal is the value.
    if(record.sourceType==='number'&&typeof record.source==='string')return record.source;
    return JSON.stringify(record);
  }
  return String(value);
};

/** sha256 over the displayed fields, in a fixed order so the hash is stable across runs. */
export function contentHash(fields:HashFields):string {
  const parts=[fields.name,fields.size,fields.duration,fields.category2,fields.labels,fields.createTime,fields.account].map(normalize);
  return createHash('sha256').update(parts.join('\u0000'),'utf8').digest('hex');
}
