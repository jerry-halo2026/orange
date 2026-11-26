// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A Saved take that meets another account's library: ask the host to confirm adding this account, claim the
 * record, and take once more. `confirm` is injected so the decision is the window's, not this module's.
 */
export async function takeSavedWithClaim<T>(
  path: string,
  options: {
    take: (path: string) => Promise<T>;
    ownership: () => Promise<{ refs: readonly { ref: string; current: boolean }[] }>;
    claim: (ref: string) => Promise<unknown>;
    confirm: (message: string) => boolean;
  },
): Promise<T> {
  try {
    return await options.take(path);
  } catch (error) {
    if ((error as { code?: string }).code !== 'saved-access-denied') throw error;
    const ownership = await options.ownership();
    const ref = ownership.refs.find((record) => !record.current)?.ref;
    if (!ref || !options.confirm('这个素材库属于另一个账号。把当前账号加入这个素材库后重试？')) throw error;
    await options.claim(ref);
    return options.take(path);
  }
}
