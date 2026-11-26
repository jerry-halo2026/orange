// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The product's name in the native modules is brand.json's own: this fails the moment the two disagree, so the word the
 * command, Studio's server and doctor print is the word the pages say.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRODUCT_NAME } from './product-name.mjs';

test('the native word is brand.json\'s productName', () => {
  const brand = JSON.parse(readFileSync(fileURLToPath(new URL('../../../brand.json', import.meta.url)), 'utf8'));
  assert.equal(PRODUCT_NAME, brand.productName, 'packages/orangefilm/src/product-name.mjs and brand.json name two things');
  assert.equal(PRODUCT_NAME, 'OrangeFilm', 'the product this tree ships is OrangeFilm');
});
