import { DateTime } from "effect";
import { activeStates } from "../../schemas/daemon";
import type { RunView } from "../../schemas/monitor";
import type { MonitorFeed } from "./feed";
import { duration } from "./format";
import type { Tone } from "./model-types";

type Segment = { readonly text: string; readonly tone: Tone };
const segment = (text: string, tone: Tone = "fg"): Segment => ({ text, tone });

/** Builds the compact monitor line as text segments with semantic tones. */
export function lineSegments(feed: MonitorFeed, now: number): readonly Segment[] {
  const mark = [segment("››"), segment("›", "signal"), segment("  ")];
  if (feed._tag === "Saved") {
    const daemon = feed.reason === "outdated" ? "daemon outdated" : "no daemon";
    return [...mark, segment(`${daemon} · ${feed.overview.runs.length} runs saved`, "muted")];
  }
  const overview = feed._tag === "Reconnecting" ? feed.last : feed.overview;
  const body = overview === null ? [] : liveSegments(overview.runs, now);
  if (feed._tag === "Reconnecting")
    body.push(segment(`${body.length ? " · " : ""}reconnecting`, "interrupted"));
  return [...mark, ...body];
}

function liveSegments(runs: readonly RunView[], now: number): Segment[] {
  const questions = runs.flatMap((run) => run.questions.map((question) => ({ run, question })));
  questions.sort(
    (a, b) =>
      DateTime.toEpochMillis(a.question.askedAt) - DateTime.toEpochMillis(b.question.askedAt),
  );
  const oldest = questions[0];
  const result: Segment[] = [];
  if (oldest) {
    const age = duration(now - DateTime.toEpochMillis(oldest.question.askedAt));
    const more = questions.length > 1 ? ` +${questions.length - 1} more` : "";
    result.push(
      segment(`■ ${oldest.run.name} ${oldest.question.id} ${age}${more}`, "signal"),
      segment("  ·  ", "muted"),
    );
  }
  result.push(...counts(runs));
  if (!oldest) result.push(segment("  ·  nothing needs you", "muted"));
  return result;
}

function counts(runs: readonly RunView[]): Segment[] {
  const working = runs.filter((run) => activeStates.has(run.state)).length;
  const result = [segment(`⣾ ${working} working`, "running")];
  const finished = [
    { state: "idle", glyph: "✓", label: "done", tone: "done" },
    { state: "failed", glyph: "×", label: "failed", tone: "failed" },
    { state: "interrupted", glyph: "■", label: "interrupted", tone: "interrupted" },
  ] as const;
  for (const { state, glyph, label, tone } of finished) {
    const count = runs.filter((run) => run.state === state).length;
    if (count) result.push(segment("  "), segment(`${glyph} ${count} ${label}`, tone));
  }
  return result;
}
