// @ts-check
/**
 * Versions saved on their own while a project is worked on, when the person turned Auto versions on (prefs.mjs
 * `autoVersions`). Only for projects open in Studio (the ones someone watches), and only when something changed since
 * the last version (history.mjs saveVersion gives null otherwise). The moments:
 *
 *   an app's agent starts a turn     what was there before it ('agent'), to come back to if the turn goes wrong
 *   that turn ends                   what it did ('auto')
 *   the folder rests for IDLE_MS     after the person's edits, or an agent's that the app does not run ('auto'); at
 *                                    most MAX_MS after the first change of a stretch of work that never rests
 *   the project is closed            what changed since the last version, if a rest was still awaited ('auto')
 *
 *   const auto = createAutoVersions({ on: () => readPrefs().autoVersions, working: agentIn, roots: watchers.roots, save });
 *   auto.changed(root)   // on each change of the folder
 *   auto.start() … await auto.stop()
 */

export const IDLE_MS = 2 * 60_000;
export const MAX_MS = 10 * 60_000;
/** How often whether an app's agent is working is looked at. */
export const POLL_MS = 3_000;

/**
 * @param {{ on: () => boolean, working: (root: string) => boolean, roots: () => string[],
 *   save: (root: string, kind: 'auto' | 'agent') => Promise<unknown>, idleMs?: number, maxMs?: number, pollMs?: number }} o
 */
export function createAutoVersions({ on, working, roots, save, idleMs = IDLE_MS, maxMs = MAX_MS, pollMs = POLL_MS }) {
  /** @type {Map<string, { timer: NodeJS.Timeout | null, since: number | null, agent: boolean }>} per project */
  const projects = new Map();
  /** @type {NodeJS.Timeout | null} */
  let polling = null;
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  let generation = 0;
  // Initially active: callers have always been able to use changed/poll before start.
  let active = true;
  /** @type {Promise<void> | null} */
  let stopping = null;
  let stopped = false;
  const current = (/** @type {number} */ epoch) => active && generation === epoch;

  const of = (/** @type {string} */ root, /** @type {number} */ epoch) => {
    let p = projects.get(root);
    if (!p) {
      const agent = working(root);
      if (!current(epoch)) return;
      p = { timer: null, since: null, agent };
      projects.set(root, p);
    }
    return p;
  };
  const saveNow = (/** @type {string} */ root, /** @type {'auto' | 'agent'} */ kind, /** @type {number} */ epoch) => {
    if (!current(epoch)) return;
    const p = projects.get(root);
    if (p) { if (p.timer) clearTimeout(p.timer); p.timer = null; p.since = null; }
    // Register before invoking save: even save -> stop reentry must see this task.
    /** @type {() => void} */
    let finish;
    /** @type {Promise<void>} */
    const task = new Promise((resolve) => { finish = resolve; });
    pending.add(task);
    const release = () => { pending.delete(task); finish(); };
    try { void Promise.resolve(save(root, kind)).then(release, release); }
    catch { release(); } // Preserve best-effort saving without leaking private errors.
  };

  /** Wait for returned save promises, including their cleanup; never a timer or timeout proxy. */
  const drain = async () => {
    while (pending.size) await Promise.all([...pending]);
  };

  const poll = (epoch = generation) => {
    if (!current(epoch)) return;
    const watched = roots();
    if (!current(epoch)) return;
    const open = new Set(watched);
    for (const [root, p] of projects) {
      if (open.has(root)) continue;
      if (p.timer) {
        const enabled = on();
        if (!current(epoch)) return;
        if (enabled) saveNow(root, 'auto', epoch);
        else clearTimeout(p.timer);
        if (!current(epoch)) return;
      }
      projects.delete(root);
    }
    const enabled = on();
    if (!current(epoch) || !enabled) return;
    for (const root of open) {
      const p = of(root, epoch);
      if (!current(epoch) || !p) return;
      const now = working(root);
      if (!current(epoch)) return;
      if (now === p.agent) continue;
      p.agent = now;
      saveNow(root, now ? 'agent' : 'auto', epoch);
      if (!current(epoch)) return;
    }
  };

  return {
    /** The folder at `root` changed: a version once it rests, unless an app's agent is mid-turn (saved when it ends). */
    changed(/** @type {string} */ root) {
      const epoch = generation;
      if (!current(epoch)) return;
      const enabled = on();
      if (!current(epoch) || !enabled) return;
      const p = of(root, epoch);
      if (!current(epoch) || !p || p.agent) return;
      p.since ??= Date.now();
      if (p.timer) clearTimeout(p.timer);
      const wait = Math.max(0, Math.min(idleMs, p.since + maxMs - Date.now()));
      const timer = setTimeout(() => {
        if (current(epoch) && projects.get(root) === p && p.timer === timer) saveNow(root, 'auto', epoch);
      }, wait);
      p.timer = timer;
      p.timer.unref?.();
    },
    poll: () => poll(),
    start() {
      if (!active) {
        if (!stopped) return; // Busy: a previous lifecycle still owns unfinished IO.
        generation++;
        active = true;
        stopping = null;
        stopped = false;
      }
      const epoch = generation;
      polling ??= setInterval(() => poll(epoch), pollMs);
      polling.unref?.();
    },
    /** Close admission synchronously, then wait for every save already invoked in this lifecycle. */
    stop() {
      if (stopping) return stopping;
      active = false;
      if (polling) clearInterval(polling);
      polling = null;
      for (const p of projects.values()) if (p.timer) clearTimeout(p.timer);
      projects.clear();
      stopping = drain().then(() => { stopped = true; });
      return stopping;
    },
    drain,
  };
}
