// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import type { Language } from '@/i18n';
import { brand } from '@/components/BrandLogo';

/*
 * The app menu's public destinations. They are ours now, so they come from brand.json's `links` rather than from
 * upstream's addresses; the third-party notices (ffmpeg, qwen-code, copilot) live in THIRD_PARTY_NOTICES.md and are
 * untouched. A build whose brand.json names no link falls back to nothing rather than to someone else's page.
 */
type BrandLinks = { docs?: string; github?: string; issues?: string; discussions?: string; community?: string };
const links = ((brand as { links?: BrandLinks }).links ?? {}) as BrandLinks;

export const PRODUCT_LINKS = {
  docs: links.docs?.trim() ?? '',
  github: links.github?.trim() ?? '',
  feedback: links.issues?.trim() ?? '',
} as const;

export function communityChannels(language: Language) {
  void language;
  return [
    { id: 'discord', href: links.community?.trim() ?? '' },
    { id: 'github', href: links.discussions?.trim() ?? '' },
  ] as const;
}

export const CREATOR_HANDLE = 'riverisbuilding';

/** Direct profile URLs. Douyin's account ID was resolved from the creator's share link. */
export const CREATOR_CHANNELS = [
  { id: 'rednote', href: 'https://www.xiaohongshu.com/user/profile/695bfa62000000003700029d' },
  { id: 'bilibili', href: 'https://space.bilibili.com/1229893183' },
  { id: 'douyin', href: 'https://www.douyin.com/user/MS4wLjABAAAALPQoqnSDKNMQsR5GNnnx_nwq-rI1MsAyqcZRNuOzKjs' },
  { id: 'instagram', href: `https://www.instagram.com/${CREATOR_HANDLE}/` },
  { id: 'youtube', href: `https://www.youtube.com/@${CREATOR_HANDLE}` },
] as const;
