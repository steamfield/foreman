import { PACE_MINUTES } from "../schemas/monitor";

/** A bounded event window ending in the named epoch minute. */
export interface PaceWindow {
  readonly minute: number;
  readonly buckets: readonly number[];
}

/** Create an empty window ending in the current minute. */
export function emptyPace(now: number): PaceWindow {
  return { minute: Math.floor(now / 60_000), buckets: Array(PACE_MINUTES).fill(0) };
}

/** Slide the window to now, dropping expired buckets and filling new minutes with zeros. */
export function advancePace(window: PaceWindow, now: number): PaceWindow {
  const minute = Math.floor(now / 60_000);
  if (minute <= window.minute) return window;
  const shift = minute - window.minute;
  return {
    minute,
    buckets: Array.from({ length: PACE_MINUTES }, (_, index) => window.buckets[index + shift] ?? 0),
  };
}

/** Count one event when its timestamp falls inside the window. */
export function countPace(window: PaceWindow, at: number): PaceWindow {
  const index = PACE_MINUTES - 1 - (window.minute - Math.floor(at / 60_000));
  if (index < 0 || index >= PACE_MINUTES) return window;
  return {
    ...window,
    buckets: window.buckets.map((count, position) => count + (position === index ? 1 : 0)),
  };
}
