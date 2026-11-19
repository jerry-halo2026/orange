// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The analyzer's contract: a JSON schema, and a validator that is strict enough to refuse a reply
 * before it reaches the database.
 *
 * The validator is deliberately small - it supports exactly the keywords the page schema uses
 * (`type`, `required`, `properties`, `items`, `enum`, `additionalProperties`, `minLength`, `minimum`,
 * `maximum`) and refuses anything it does not understand rather than passing it through. A schema
 * keyword silently ignored is how a malformed page gets written.
 */

export type Schema=Readonly<Record<string,unknown>>;

export const PAGE_SCHEMA:Schema=Object.freeze({
  type:'object',
  additionalProperties:false,
  required:['title','body_md','tags','confidence'],
  properties:Object.freeze({
    title:Object.freeze({type:'string',minLength:1}),
    body_md:Object.freeze({type:'string',minLength:1}),
    tags:Object.freeze({type:'array',items:Object.freeze({type:'string',minLength:1})}),
    confidence:Object.freeze({type:'number',minimum:0,maximum:1}),
  }),
});

const typeOf=(value:unknown):string=>{
  if(value===null)return 'null';
  if(Array.isArray(value))return 'array';
  if(typeof value==='number')return Number.isInteger(value)?'integer':'number';
  return typeof value;
};

const KNOWN=new Set(['type','required','properties','items','enum','additionalProperties','minLength','minimum','maximum','description','$schema','title']);

/** `null` when the value conforms, otherwise a path-qualified reason. */
export function validate(schema:Schema,value:unknown,path='$'):string|null {
  for(const keyword of Object.keys(schema))if(!KNOWN.has(keyword))return `${path}: unsupported schema keyword "${keyword}"`;

  const declared=schema.type;
  if(typeof declared==='string'){
    const actual=typeOf(value);
    const ok=declared===actual||(declared==='number'&&actual==='integer');
    if(!ok)return `${path}: expected ${declared}, got ${actual}`;
  }

  if(Array.isArray(schema.enum)){
    if(!schema.enum.some(entry=>entry===value))return `${path}: not one of the allowed values`;
  }

  if(typeOf(value)==='string'){
    const text=value as string;
    if(typeof schema.minLength==='number'&&text.length<(schema.minLength as number))return `${path}: shorter than ${schema.minLength}`;
  }

  if(typeof value==='number'){
    if(typeof schema.minimum==='number'&&value<(schema.minimum as number))return `${path}: below ${schema.minimum}`;
    if(typeof schema.maximum==='number'&&value>(schema.maximum as number))return `${path}: above ${schema.maximum}`;
  }

  if(Array.isArray(value)&&schema.items&&typeof schema.items==='object'){
    for(let index=0;index<value.length;index+=1){
      const reason=validate(schema.items as Schema,value[index],`${path}[${index}]`);
      if(reason)return reason;
    }
  }

  if(typeOf(value)==='object'){
    const record=value as Record<string,unknown>;
    const required=Array.isArray(schema.required)?schema.required as string[]:[];
    for(const key of required)if(!(key in record))return `${path}.${key}: required`;
    const properties=(schema.properties??{}) as Record<string,Schema>;
    if(schema.additionalProperties===false){
      for(const key of Object.keys(record))if(!(key in properties))return `${path}.${key}: not allowed`;
    }
    for(const [key,sub] of Object.entries(properties)){
      if(!(key in record))continue;
      const reason=validate(sub,record[key],`${path}.${key}`);
      if(reason)return reason;
    }
  }

  return null;
}
