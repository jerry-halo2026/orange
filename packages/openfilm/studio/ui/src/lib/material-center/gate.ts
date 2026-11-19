// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿/**
 * The one door every material request goes through.
 *
 * The supplier counts requests per account; a page that opens a hundred lists at once is throttled (`429`
 * `provider-rate-limited`) and then nothing works — every list and every download waits behind the same account. So the
 * client spaces requests (QPS) and caps how many are out at once, whatever the UI above it asks for.
 *
 * Deterministic in tests: the clock and the sleep are injected, so a test reads the wait it asked for instead of
 * spending it.
 */
export type RequestGateStats = {
  readonly started: number;
  readonly inFlight: number;
  readonly maxInFlight: number;
  /** The pauses the gate imposed before starting, in ms — the QPS spacing, made visible. */
  readonly waits: readonly number[];
};

export type RequestGate = {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Hold every new request (a throttle answer): `run` waits until `resume`. */
  pause(): void;
  resume(): void;
  paused(): boolean;
  stats(): RequestGateStats;
};

export type RequestGateOptions = {
  /** Requests per second the gate allows to start; defaults to 6. */
  readonly qps?: number;
  /** Most requests out at once; defaults to 6. */
  readonly concurrency?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

export function createRequestGate(options: RequestGateOptions = {}): RequestGate {
  const qps = Math.max(1, options.qps ?? 6);
  const limit = Math.max(1, options.concurrency ?? 6);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const spacing = Math.ceil(1000 / qps);
  let nextAt = 0;
  let inFlight = 0;
  let started = 0;
  let maxInFlight = 0;
  let paused = false;
  const waits: number[] = [];
  const waiting: Array<() => void> = [];
  const slots: Array<() => void> = [];

  const holdResume = () => (paused ? new Promise<void>(resolve => waiting.push(resolve)) : Promise.resolve());
  /* The slot is booked at the moment it is granted, not when the request starts: the spacing wait must not let a
     second request slip past the cap. */
  const acquire = async () => {
    if (inFlight < limit) { inFlight += 1; return; }
    await new Promise<void>(resolve => slots.push(resolve));
  };
  const release = () => {
    inFlight -= 1;
    const next = slots.shift();
    if (next) { inFlight += 1; next(); }
  };

  return {
    async run(task) {
      await holdResume();
      await acquire();
      await holdResume();
      const at = Math.max(now(), nextAt);
      const wait = at - now();
      if (wait > 0) {
        waits.push(wait);
        await sleep(wait);
      }
      nextAt = at + spacing;
      started += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await task();
      } finally {
        release();
      }
    },
    pause() { paused = true; },
    resume() {
      paused = false;
      for (const resolve of waiting.splice(0)) resolve();
    },
    paused: () => paused,
    stats: () => ({started, inFlight, maxInFlight, waits: [...waits]}),
  };
}
