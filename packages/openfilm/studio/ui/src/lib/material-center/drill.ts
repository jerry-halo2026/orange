// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A drilled-down group's identity.
 *
 * The panel keeps the drilled group's library mounted while the person is back among the groups, so a second visit to
 * the same group is a visibility change and costs no request (a `list` per visit would be a page of lists by the
 * tenth look). Only a different group, or a different scope, is a different library.
 */
import type {GroupRef, GroupScope} from './groups.ts';

export function drillKey(group: GroupRef, scope: GroupScope): string {
  return scope + '|' + group.key;
}

/** Whether the drill already on screen is the one being opened again. */
export function sameDrill(
  current: {readonly group: GroupRef; readonly scope: GroupScope} | null,
  group: GroupRef,
  scope: GroupScope,
): boolean {
  return Boolean(current && current.group.key === group.key && current.scope === scope);
}
