// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/*
 * The product's name, in one place: brand.json at the repository root (schema orange/brand/1), generated into ordinary
 * source by scripts/brand-codegen.mjs, so the UI, the tests and the build read the same words. A rename is that file.
 */
import { brand } from '../../../../../../brand.generated.ts';

/** The name a build without brand.json keeps: this product's own, never a string in a sentence somewhere else. */
export const FALLBACK_NAME = 'OrangeFilm';

/** brand.json's `productName`: what About, the language setting and every sentence naming the product say. */
export const brandName: string = (typeof brand.productName === 'string' ? brand.productName.trim() : '') || FALLBACK_NAME;
