// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.

/**
 * Saved library ownership is per account. A `saved/take` 403 is not "sign in again": it means this
 * machine's library was claimed by another account, and the person may explicitly add the current
 * one. This one helper classifies that refusal and performs the one confirmed retry.
 */

export type SavedClaimNeed = 'claim' | null;

/** The body code Studio puts on a Saved refusal, wherever the caller caught it. */
export function savedClaimNeedOf(error: unknown): SavedClaimNeed {
  const candidate = error as { code?: unknown; body?: { code?: unknown } } | null;
  const code = typeof candidate?.code === 'string'
    ? candidate.code
    : typeof candidate?.body?.code === 'string' ? candidate.body.code : '';
  return code === 'saved-access-denied' || code === 'saved-claim-takeover-required' ? 'claim' : null;
}

/** The owner ref a person must echo back; the first not-current record is the one they are taking over. */
export async function savedClaimRef(api: {
  savedOwnership: () => Promise<{ refs: Array<{ ref: string; current: boolean }> }>;
}): Promise<string | null> {
  const ownership = await api.savedOwnership();
  return ownership.refs.find((record) => !record.current)?.ref ?? null;
}
