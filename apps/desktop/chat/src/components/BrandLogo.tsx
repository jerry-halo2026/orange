// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

'use client';

import React from 'react';
/* the brand's words, from the repository root (scripts/brand-codegen.mjs): the mark's label, and the address a
 * deployment can name instead of the file this tree ships */
import { brand as brandData } from '../../../../../brand.generated.ts';
/* the same mark as Studio's: apps/desktop/build/icon.png, copied into this app's own assets so Vite returns a URL */
import markAsset from '@/assets/brand-mark.png';

const LOADABLE = /^(?:https?:|data:|file:|\/)/i;

/** brand.json's own address for the mark, when it is one a page can load (an http(s)/data/file URL or a rooted path). */
const saidMark = typeof brandData.logo?.mark === 'string' ? brandData.logo.mark.trim() : '';
const MARK_URL = saidMark && LOADABLE.test(saidMark) ? saidMark : markAsset;
const MARK_LABEL = (typeof brandData.productName === 'string' ? brandData.productName.trim() : '') || '橙子创作中心';

/*
 * The mark: three orange rounded bars rising left to right on a near-black rounded square — the app icon's own shape
 * (#F3BF9C / #F0A06A / #ED7B2D on #0B0B0C, bars tilted 8°, bottom edge level), drawn only when the image cannot load.
 */
const VIEWBOX = '0 0 1024 1024';
const BARS: ReadonlyArray<readonly [number, number, number, string]> = [
  [187, 470, 320, '#F3BF9C'],
  [426, 355, 435, '#F0A06A'],
  [665, 225, 565, '#ED7B2D'],
];

export function BrandMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={VIEWBOX}
      className={`block shrink-0 ${className ?? ''}`.trim()}
      role="img"
      aria-label={MARK_LABEL}
    >
      <rect width="1024" height="1024" rx="220" fill="#0B0B0C" />
      {BARS.map(([x, y, height, fill]) => (
        <rect
          key={fill}
          x={x}
          y={y}
          width="154"
          height={height}
          rx="45"
          fill={fill}
          transform={`rotate(8 ${x + 77} ${y + height / 2})`}
        />
      ))}
    </svg>
  );
}

export function BrandLogo({ size = 18, className }: { size?: number; className?: string }) {
  const [broken, setBroken] = React.useState(false);
  if (broken) return <BrandMark size={size} className={className} />;
  return (
    <img
      src={MARK_URL}
      width={size}
      height={size}
      alt={MARK_LABEL}
      className={`block shrink-0 ${className ?? ''}`.trim()}
      onError={() => setBroken(true)}
    />
  );
}
