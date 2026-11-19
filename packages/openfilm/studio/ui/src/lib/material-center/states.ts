// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * What the page says, and when. Four states have to be reachable and distinguishable:
 * loading, empty, error, and "you may not see this" — the last one is not an error message about the network.
 */
import type {MaterialPage} from './contract.ts';

/** The failures the server reports for a missing or refused authorization (contract §4, 403 rows). */
export const UNAUTHORIZED_CODES = Object.freeze([
  'authentication-required', 'authentication-rejected', 'origin-rejected', 'authorization-denied',
  'account-not-authorized', 'binding-required', 'binding-changed', 'account-disabled', 'lookup-not-authorized',
  'provider-permission-denied', 'provider-credential-rejected',
] as const);

export type ScreenState = 'loading' | 'ready' | 'empty' | 'error' | 'unauthorized';

/**
 * A 403 is "no permission", whatever code came with it (a body the hop could not parse is still a refused request);
 * the authorization layer's own codes say the same thing when the status itself was lost. A 401 is not this screen: it
 * has its own "sign in" sentence, because signing in is something the person can do.
 */
export function classifyFailure(status: number, code: string): 'unauthorized' | 'error' {
  if (status === 401) return 'error';
  if (status === 403 || (UNAUTHORIZED_CODES as readonly string[]).includes(code)) return 'unauthorized';
  return 'error';
}

/**
 * The screen for the current load. A page whose rows were all dropped by the authorization layer is **empty with a
 * reason**, not "no materials": the caller decides whether to fetch the next page (contract §3, short pages).
 */
export function screenOf(input: {
  readonly loading: boolean;
  readonly failure: {readonly status: number; readonly code: string} | null;
  readonly page: MaterialPage | null;
  readonly visibleCount: number;
}): ScreenState {
  if (input.failure) return classifyFailure(input.failure.status, input.failure.code);
  if (input.loading) return 'loading';
  if (!input.page) return 'loading';
  return input.visibleCount > 0 ? 'ready' : 'empty';
}

/** Why a page came back with nothing, when the rows existed but the authorization layer dropped them. */
export function emptyReason(page: MaterialPage | null): string | null {
  if (!page) return null;
  if (page.filtered.inspected === 0) return '这一页供应商没有返回任何素材。';
  return '这一页检查了 ' + page.filtered.inspected + ' 行，全部不在授权范围内：可以翻到下一页再看。';
}

/** "本页已按授权过滤" — said whenever the authorization layer actually dropped rows on this page. */
export function filteredNotice(page: MaterialPage | null): string | null {
  if (!page || page.filtered.dropped <= 0) return null;
  return '本页已按授权过滤：检查 ' + page.filtered.inspected + ' 行，展示 ' + (page.filtered.inspected - page.filtered.dropped)
    + ' 行，丢弃 ' + page.filtered.dropped + ' 行。';
}

/** The supplier's total is the company view's, and the page must not present it as "your count". */
export function providerTotalNote(page: MaterialPage | null): string | null {
  if (!page || page.providerTotal === null) return null;
  return '供应商公司视图总数 ' + page.providerTotal + ' 条（不是本人可见条数，已按授权收窄的只有本页）。';
}

/** A page shorter than asked for means the supplier has no more rows; it never means "fetch again". */
export function hasMorePages(page: MaterialPage | null, pageSize: number): boolean {
  return !!page && page.items.length >= pageSize;
}

/** Said when a short page is not the supplier's end but the authorization layer's doing. */
export function shortPageNote(page: MaterialPage | null): string | null {
  if (!page) return null;
  if (page.items.length > 0 || page.filtered.inspected === 0) return null;
  return '本页 0 条可展示（已丢弃 ' + page.filtered.dropped + ' 行）；不会自动补页，需要继续请手动翻页。';
}
