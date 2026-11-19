// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The raw-download host allow-list.
 *
 * The supplier serves originals from more than one CDN name, all under the same registrable domain,
 * so an entry may be a **suffix wildcard** (`*.sucaicloud.com`). Matching follows domain boundaries:
 * the host must end with `.` + the rest of the entry, which is what stops `evil-sucaicloud.com` (no
 * dot boundary) and `sucaicloud.com.evil.com` (suffix is not at the end) from matching.
 *
 * The apex is **not** covered by `*.sucaicloud.com`: a wildcard entry promises "some subdomain", and
 * an entry for the apex itself is written as `sucaicloud.com`. Wildcards are only allowed as the
 * whole leftmost label (`*.`), so `su*.cai.com`, `*` and `*.*.com` are refused at startup rather than
 * silently never matching.
 */
/** One label-safe hostname: lowercase, dot-separated, no port, path or trailing dot. */
const HOSTNAME=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
/** A hostname, optionally prefixed by exactly `*.`. */
const ENTRY=/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export const isHostname=(value:string):boolean=>HOSTNAME.test(value);

/**
 * Normalize one allow-list entry, or `null` when the matcher cannot honour it. The caller turns
 * `null` into its own refusal (`raw-hosts-invalid`), so this stays a pure helper.
 */
export function hostEntry(value:unknown):string|null {
  if(typeof value!=='string')return null;
  const entry=value.trim().toLowerCase();
  if(!entry||entry.length>253||!ENTRY.test(entry))return null;
  // `*.` alone still has to leave a real hostname behind, which ENTRY guarantees.
  return entry;
}

/** True when `host` is allowed: an exact entry, or a subdomain of a `*.` entry. */
export function hostAllowed(host:string,entries:readonly string[]):boolean {
  const name=host.trim().toLowerCase();
  if(!name)return false;
  for(const entry of entries){
    if(entry===name)return true;
    if(entry.startsWith('*.')){
      const suffix=entry.slice(1); // ".sucaicloud.com"
      if(name.length>suffix.length&&name.endsWith(suffix))return true;
    }
  }
  return false;
}
