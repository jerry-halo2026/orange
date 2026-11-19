// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
/*
 * the brand, in one place at the repository root: the name and the mark, generated from brand.json into ordinary
 * source (scripts/brand-codegen.mjs), so the tests, the Vite build and the packaged app read the same words
 */
import { brand as brandData } from '../../../../../../brand.generated.ts';
/* the product's name: brand.json's productName, and the name a build without brand.json keeps (lib/brand-name.ts) */
import { brandName } from '@/lib/brand-name';
/* the mark this package ships: apps/desktop/build/icon.png, copied beside these pages, so Vite hands back a URL a page
 * can load (a source route in `vite dev`, a hashed file beside the bundle in `vite build`) instead of a repository path */
import markAsset from '@/assets/brand-mark.png';

/** What brand.json (schema orange/brand/1) names, as much of it as a logo needs. */
export interface Brand {
  schema?: string;
  productName?: string;
  companyName?: string;
  windowTitle?: string;
  appId?: string;
  logo?: { mark?: string; wordmark?: string };
}

/* the fallback label: the window's own title, only while brand.json names none */
const FALLBACK_LABEL = '橙子创作中心';

export const brand: Brand = brandData;

/** The product's name, from brand.json: its product name, else the name this build's words carry. */
export { brandName };

/** The mark brand.json names, if it is something a page can load (an http(s)/data URL, or a rooted path). */
export const brandMark: string = brand.logo?.mark?.trim() ?? '';

const LOADABLE = /^(?:https?:|data:|file:|\/)/i;

/**
 * The image the logo shows: brand.json's own `logo.mark` when it is an address a page can load (an http(s)/data/file
 * URL, or a rooted path — that is how a deployment overrides the mark without rebuilding), else the file this package
 * ships beside its pages (`assets/brand-mark.png`; a package-relative name in brand.json names that same file and is
 * not an address, so it never wins over the bundled asset).
 */
export const brandMarkUrl: string = brandMark && LOADABLE.test(brandMark) ? brandMark : markAsset;

/*
 * The mark, drawn: three orange rounded bars rising left to right on a near-black rounded square — the app icon's own
 * shape (#F3BF9C / #F0A06A / #ED7B2D on #0B0B0C, bars tilted 8°, bottom edge level), so this and the shipped PNG are the
 * same mark. Drawn when the image cannot load; the aria label is always the brand's name.
 */
const VIEWBOX = '0 0 1024 1024';
const BARS: ReadonlyArray<readonly [number, number, number, number, string]> = [
  /* x, y, height, corner radius, fill — each bar rotates about its own centre, which is what keeps their bottoms level */
  [187, 470, 320, 45, '#F3BF9C'],
  [426, 355, 435, 45, '#F0A06A'],
  [665, 225, 565, 45, '#ED7B2D'],
];

export function BrandMark({ size = 18, label = FALLBACK_LABEL }: { size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox={VIEWBOX} className="block shrink-0" role="img" aria-label={label}>
      <rect width="1024" height="1024" rx="220" fill="#0B0B0C" />
      {BARS.map(([x, y, height, radius, fill]) => (
        <rect
          key={fill}
          x={x}
          y={y}
          width="154"
          height={height}
          rx={radius}
          fill={fill}
          transform={`rotate(8 ${x + 77} ${y + height / 2})`}
        />
      ))}
    </svg>
  );
}

export function BrandLogo({ size = 18, name = brandName }: { size?: number; name?: string }) {
  const [broken, setBroken] = React.useState(false);
  const label = name?.trim() || FALLBACK_LABEL;
  if (broken) return <BrandMark size={size} label={label} />;
  return (
    <img
      src={brandMarkUrl}
      width={size}
      height={size}
      alt={label}
      className="block shrink-0"
      onError={() => setBroken(true)}
    />
  );
}
