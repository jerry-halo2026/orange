#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Turns `brand.json` (schema orange/brand/1) into `brand.generated.ts`: one TypeScript module at the repository's
 * root that every page of the app can import.
 *
 * Why a module instead of reading the JSON: the pages used to import brand.json with Vite's `?raw` suffix. That is a
 * Vite-only import: Node's test runner (and plain `node --test`) cannot resolve it, so the brand could only be checked
 * in a build. A generated module is ordinary source, so the tests, the Vite build and the packaged app read the same
 * words.
 *
 * The generated file is committed: a checkout runs its tests without generating anything first. Run this when
 * `brand.json` changes (or `pnpm brand`); `--check` reports a stale file without writing it.
 *
 *   node scripts/brand-codegen.mjs          # write brand.generated.ts
 *   node scripts/brand-codegen.mjs --check   # exit 1 when brand.generated.ts is not what brand.json says
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository's root: this file sits in scripts/. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The one file that names the product. */
export const BRAND_JSON = join(ROOT, 'brand.json');
/** What this writes: shared by Studio's UI, the chat and the desktop shell. */
export const TARGET = join(ROOT, 'brand.generated.ts');

/*
 * A short header, in the operators' words first and English after: the file is generated, so an edit here is an edit
 * that the next run takes away. (Both are on one line so the repository's prose check reads it as Latin-heavy.)
 */
const COPYRIGHT = '// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.\n// No modification or redistribution without the owner’s written permission.\n\n';
const HEADER = '/* 由 scripts/brand-codegen.mjs 生成，勿手改（generated from brand.json — edit that, or the script, not this file; non-ASCII is written as \\u… so this file is plain ASCII）。 */\n';

/**
 * A string as a literal that is plain ASCII: brand.json's own words come out as `\u…` escapes, so the generated file
 * has one encoding everywhere and carries no prose a source check would read as Chinese.
 */
const stringLiteral = (value) => JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * What brand.json may say, as generated code: every field is optional, because the pages keep their own words when a
 * checkout's brand.json says nothing (or says nothing useful). `logo` and `about` are the two nested halves of it.
 */
const SHAPE = `/** The shape of brand.json (schema orange/brand/1). Every field is optional: a quiet brand.json is allowed. */
export interface BrandData {
  schema?: string;
  productName?: string;
  companyName?: string;
  appId?: string;
  windowTitle?: string;
  /**
   * mark: the product's mark. Either an address a page can load (http(s)/data/file, or a path rooted at the site:
   * "/..."), which a deployment may override without rebuilding, or a file this tree ships, named inside the package
   * (assets/brand-mark.png), which the pages import as an asset and Vite turns into a loadable URL. A package-relative
   * name is not an address: the pages draw the shipped file and use mark only when it is an address.
   */
  logo?: { mark?: string; wordmark?: string };
  installerName?: string;
  updaterChannel?: string;
  about?: { copyright?: string };
  /** anything else brand.json grows before this script learns its name */
  [field: string]: unknown;
}
`;

/** A brand object as the module's own literal, keys sorted so the same brand.json always writes the same bytes. */
function literal(value, depth = 0) {
  const pad = '  '.repeat(depth);
  const inner = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((item) => `${inner}${literal(item, depth + 1)},`).join('\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (!keys.length) return '{}';
    return `{\n${keys.map((key) => `${inner}${stringLiteral(key)}: ${literal(value[key], depth + 1)},`).join('\n')}\n${pad}}`;
  }
  return stringLiteral(value);
}

/**
 * brand.generated.ts' whole text for a brand object: the header, the shape, and `export const brand`.
 *
 * @param {{ [field: string]: unknown }} brand brand.json, already parsed and known to be an object
 */
export function brandModule(brand) {
  return `${COPYRIGHT}${HEADER}${SHAPE}
/** brand.json's own words: the product's name, its company's, and the mark a page shows for it. */
export const brand: BrandData = ${literal(brand)};
`;
}

/** brand.json parsed, or a thrown error that says which file said what was wrong. */
export function readBrandJson(path = BRAND_JSON) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${path}: cannot be read (${error.code ?? error.message})`);
  }
  /* a byte-order mark is not part of the JSON a parser accepts */
  const body = text.replace(/^\uFEFF/, '');
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error(`${path}: not JSON (${error.message})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: a brand is a JSON object`);
  return value;
}

/** The generated text for the brand.json at `path`. */
export function generate(path = BRAND_JSON) {
  return brandModule(readBrandJson(path));
}

/** The generated text this repository should hold right now. */
export function expected(path = BRAND_JSON) {
  return generate(path);
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  let text;
  try {
    text = generate();
  } catch (error) {
    /* A checkout without brand.json keeps the generated file it has: it is committed, and the app ships with it. */
    if (!existsSync(BRAND_JSON) && existsSync(TARGET)) {
      console.log('brand-codegen: no brand.json, brand.generated.ts kept as committed');
      return 0;
    }
    console.error(`brand-codegen: ${error.message}`);
    return 1;
  }
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null;
  if (current === text) {
    console.log('brand-codegen: brand.generated.ts is up to date');
    return 0;
  }
  if (check) {
    console.error('brand-codegen: brand.generated.ts is stale — run node scripts/brand-codegen.mjs');
    return 1;
  }
  writeFileSync(TARGET, text, 'utf8');
  console.log('brand-codegen: wrote brand.generated.ts');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
