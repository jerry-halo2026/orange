// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/*
 * The product's name, in one place: brand.json at the repository root (schema orange/brand/1), generated into ordinary
 * source (scripts/brand-codegen.mjs), so the chat, the tests and the build read the same words. A rename is that file.
 *
 * A sentence that names the product says `{brand}`; the chat's `say()` puts this name in (`../index.ts`), once for every
 * language. The `brand.*` keys are there for anything that asks for the name itself.
 */
import { brand as brandData } from '../../../../../brand.generated.ts';

/** The name a build without brand.json keeps: this product's own. */
export const FALLBACK_NAME = 'OrangeFilm';

function readBrand(): { product: string; company: string } {
  const product = typeof brandData.productName === 'string' ? brandData.productName.trim() : '';
  const company = typeof brandData.companyName === 'string' ? brandData.companyName.trim() : '';
  return { product: product || company || FALLBACK_NAME, company: company || product || FALLBACK_NAME };
}

export const BRAND = readBrand();
