import cliTruncate from "cli-truncate";
import { DateTime } from "effect";
import type { RunView } from "../../schemas/monitor";
import type { DetailFeed } from "./detail-feed";
import type { MonitorFeed } from "./feed";
import type { Tone } from "./model-types";

/** Formats an elapsed interval as a compact, bounded terminal duration. */
export function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds >= 365 * 86400) return `${Math.min(9999, Math.floor(seconds / (365 * 86400)))}y`;
  if (seconds >= 10 * 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 10 * 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/** Width of the list's model cell, shared by the row label and the column layout. */
export const MODEL_CELL_WIDTH = 16;

/** The provider's short tag for non-Codex runs, or null when the run needs none. */
export function providerTag(run: Pick<RunView, "provider">): string | null {
  return run.provider === undefined || run.provider === "codex" ? null : run.provider;
}

/** Effort as the list shows it: medium reads `med`, and a fixed-effort model has none. */
export function effortLabel(effort: string): string | null {
  if (effort === "none") return null;
  return effort === "medium" ? "med" : effort;
}

/** Builds the tagged model cell, clipping only the model so the tag and effort stay readable. */
export function taggedModelLabel(tag: string, model: string, effort: string | null): string {
  const suffix = effort === null ? "" : ` · ${effort}`;
  // One cell stays free so the label never touches the status column.
  const room = Math.max(1, MODEL_CELL_WIDTH - 1 - tag.length - 1 - suffix.length);
  return `${tag} ${cliTruncate(model.replace(/^gemini-/, ""), room)}${suffix}`;
}

const epoch = DateTime.toEpochMillis;
/** Replaces terminal control characters in visible text. */
export const cleanText = (text: string) => text.replace(/\p{Cc}/gu, " ");
/** Keeps the first line and replaces terminal control characters. */
export const oneLine = (text: string) => text.split(/\r?\n/, 1)[0]?.replace(/\p{Cc}/gu, " ") ?? "";
/** Formats the age of a timestamp. */
export const age = (at: DateTime.Utc, now: number) => duration(now - epoch(at));
const two = (value: number) => String(value).padStart(2, "0");
/** Local wall-clock time, HH:MM:SS. */
export function clockTime(at: DateTime.Utc): string {
  const date = new Date(epoch(at));
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
/** Local time with the date when it is not today, then the age. */
export function stamp(at: DateTime.Utc, now: number): string {
  const date = new Date(epoch(at));
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return `${sameDay ? "" : `${day} `}${clockTime(at)} · ${age(at, now)} ago`;
}
/** Formats a count with its singular or plural label. */
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
/** Maps run states to monitor tones. */
export function stateTone(state: RunView["state"]): Tone {
  switch (state) {
    case "running":
      return "running";
    case "waiting":
      return "signal";
    case "idle":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
    case "unknown":
      return "interrupted";
    case "starting":
    case "lost":
      return "muted";
  }
}
/** Identifies saved feeds without an active daemon. */
export const unsupervised = (feed: MonitorFeed | DetailFeed | null | undefined) =>
  feed?._tag === "Saved" && feed.reason === "no-daemon";
