// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Small rules of the Projects page: how long its list is waited for, and when a card asks again for a poster that is
 * still being drawn.
 */

/** How long the list is waited for before the page says it could not load it (and offers to try again). */
export const LIST_WAIT_MS = 15_000;

/** What `promise` gives, or a failure once `ms` have passed without it. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`no answer within ${ms / 1000} s`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); done(value); },
      (error: unknown) => { clearTimeout(timer); fail(error); },
    );
  });
}

/**
 * A card's poster that did not come (still being drawn, which Studio answers at once rather than hold the browser's
 * connection): asked for again after this many ms, `tried` times so far; null: given up (the card keeps its face).
 */
export function posterRetryDelay(tried: number): number | null {
  return tried < 4 ? 4000 * 2 ** tried : null;
}

/** The poster's address for try `n` (0: the first), so the browser asks Studio again rather than its cache. */
export function posterTry(url: string, n: number): string {
  return n ? `${url}${url.includes('?') ? '&' : '?'}try=${n}` : url;
}

/**
 * Whether a click on a card opens it: not the second click of a double-click (`detail` 2 or more). The first click
 * opened something already, a folder say, and what stands under the pointer now was not aimed at. A key press (Enter,
 * Space: `detail` 0) opens.
 */
export function opensOnClick(event: { detail: number }): boolean {
  return event.detail < 2;
}

/** Local presentation only: a home visit never destroys the original editor instance. */
export function homePresentation(projectId: string | null, home: boolean) {
  return { home: !projectId || home, mounted: Boolean(projectId), foreground: Boolean(projectId) && !home };
}
/** Original API order is recent-first; retain the actual project objects, including missing-state metadata. */
export function homeProjects<T>(projects: T[], view: 'recent' | 'all'): T[] {
  return view === 'recent' ? projects.slice(0, 6) : projects;
}
export type HomeEntry = 'fission' | 'studio' | 'catalog';

/** A local card action belongs to one existing mounted project, not a tab-opening protocol. */
export interface HomeEntryRequest {projectId:string;entry:HomeEntry;nonce:number}
export function homeEntryForProject(projectId:string|null, request:HomeEntryRequest|null|undefined):HomeEntryRequest|null {
 return request && projectId!==null && request.projectId===projectId ? request : null;
}
/** The same listener stays installed while the preserved editor is not foreground. */
export function whenProjectForeground<Args extends unknown[]>(ref:{current:boolean},action:(...args:Args)=>void):(...args:Args)=>void {
 return (...args)=>{if(ref.current)action(...args);};
}
/** A hidden/loading project has no fullscreen element: null never counts as ownership. */
export function isCurrentFullscreen<T>(fullscreen:T|null,stage:T|null):boolean {return stage!==null && fullscreen===stage;}
