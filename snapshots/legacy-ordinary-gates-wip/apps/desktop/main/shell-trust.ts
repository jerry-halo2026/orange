// Native-owned base URL only. Route identity never supplies authentication.
// Literal equality intentionally rejects queries, encoded aliases and arbitrary hashes.
export function isTrustedShellUrl(url: unknown, trustedFileUrl: string): boolean {
  return url === trustedFileUrl || url === trustedFileUrl + '#/workspace' || url === trustedFileUrl + '#/studio';
}
