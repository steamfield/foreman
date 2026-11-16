import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Schema } from "effect";
import { QUIET_AFTER_MS, quiet } from "../src/core/monitor/attention";

const Timing = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  startedAtMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  completedAtMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const Raw = Schema.Struct({
  method: Schema.String,
  params: Schema.Struct({
    item: Schema.optionalKey(Timing),
    turn: Schema.optionalKey(
      Schema.Struct({
        startedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        completedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        items: Schema.optionalKey(Schema.Array(Timing)),
      }),
    ),
  }),
});
const Event = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  event: Schema.Struct({
    _tag: Schema.String,
    to: Schema.optionalKey(Schema.String),
  }),
});
type Span = { start: number; end: number };
const contains = (span: Span, at: number) => span.start <= at && at < span.end;

/** Receipt times were not saved in codex.jsonl. Never invent delta timestamps:
 * exclude their enclosing raw timestamp gaps unless an open command proves quiet false.
 * Journal timestamps and embedded item/turn times are the remaining activity anchors.
 */
export function replay(codex: string, journal: string) {
  const events = journal
    .split("\n")
    .filter(Boolean)
    .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Event))(line));
  const times: number[] = [];
  const turnEnds: number[] = [];
  const running: Span[] = [];
  let start: number | null = null;
  for (const { at, event } of events) {
    const time = at.epochMilliseconds;
    times.push(time);
    if (event._tag === "TurnCompleted") turnEnds.push(time);
    if (event._tag === "StateChanged") {
      if (start !== null) running.push({ start, end: time });
      start = event.to === "running" ? time : null;
    } else if (event._tag === "TurnStarted" && start === null) start = time;
    else if (event._tag === "TurnCompleted" && start !== null) {
      running.push({ start, end: time });
      start = null;
    }
  }
  const end = times.at(-1);
  // An incomplete turn has no known end; its observed prefix is still measurable.
  if (start !== null && end !== undefined) running.push({ start, end });
  const commands: Span[] = [];
  const unknown: Span[] = [];
  let previous: number | null = null;
  let untimed = false;
  let untimedMessages = 0;
  for (const line of codex.split("\n").filter(Boolean)) {
    const raw = Schema.decodeUnknownSync(Schema.fromJsonString(Raw))(line);
    const turn = raw.params.turn;
    const anchors: number[] = [];
    if (turn?.startedAt != null) anchors.push(turn.startedAt * 1000);
    if (turn?.completedAt != null) anchors.push(turn.completedAt * 1000);
    const items = raw.params.item === undefined ? [] : [raw.params.item];
    for (const item of [...items, ...(turn?.items ?? [])]) {
      if (item.startedAtMs != null) anchors.push(item.startedAtMs);
      if (item.completedAtMs != null) anchors.push(item.completedAtMs);
      if (item.type === "commandExecution" && item.startedAtMs != null)
        commands.push({
          start: item.startedAtMs,
          end: item.completedAtMs ?? Number.POSITIVE_INFINITY,
        });
    }
    // A completed item often repeats its start time. The notification's anchor is its end.
    const time = anchors.length === 0 ? undefined : Math.max(...anchors);
    if (time === undefined) {
      untimed = true;
      untimedMessages++;
    } else {
      if (untimed) unknown.push({ start: previous ?? Number.NEGATIVE_INFINITY, end: time });
      times.push(...anchors);
      previous = time;
      untimed = false;
    }
  }
  if (untimed)
    unknown.push({ start: previous ?? Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY });
  // Replace incomplete command spans when a later completion supplies the same start.
  const closed = commands.filter((span) => Number.isFinite(span.end));
  const spans = commands
    .filter(
      (span) => Number.isFinite(span.end) || !closed.some((done) => done.start === span.start),
    )
    .map((span) => ({
      start: span.start,
      end: Math.min(
        span.end,
        turnEnds.find((end) => end >= span.start) ?? Number.POSITIVE_INFINITY,
      ),
    }));
  const anchors = [...new Set(times)].sort((a, b) => a - b);
  let totalMs = 0;
  let anchoredMs = 0;
  let quietMs = 0;
  let falsePositiveMs = 0;
  let episodes = 0;
  const stretches: Span[] = [];
  for (const window of running) {
    totalMs += window.end - window.start;
    const cuts = [
      ...new Set(
        [
          window.start,
          window.end,
          ...anchors.flatMap((time) => [time, time + QUIET_AFTER_MS]),
          ...spans.flatMap((span) => [span.start, span.end]),
          ...unknown.flatMap((span) => [span.start, span.end]),
        ].filter((time) => window.start <= time && time <= window.end),
      ),
    ].sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      const from = cuts[i - 1];
      const to = cuts[i];
      if (from === undefined || to === undefined) continue;
      const command = spans.some((span) => contains(span, from));
      if (!command && unknown.some((span) => contains(span, from))) continue;
      anchoredMs += to - from;
      const lastActivity = anchors.findLast((time) => time <= from) ?? null;
      const flagged = quiet(
        "running",
        command ? { type: "commandExecution", command: null, startedAt: from } : null,
        lastActivity,
        from,
      );
      if (!flagged) continue;
      quietMs += to - from;
      if (command || (lastActivity !== null && from - lastActivity < QUIET_AFTER_MS))
        falsePositiveMs += to - from;
      const previousStretch = stretches.at(-1);
      if (previousStretch?.end === from) previousStretch.end = to;
      else {
        stretches.push({ start: from, end: to });
        episodes++;
      }
    }
  }
  return { totalMs, anchoredMs, quietMs, falsePositiveMs, episodes, untimedMessages, stretches };
}

if (import.meta.main) {
  const archive = process.argv[2] ?? join(homedir(), ".foreman/runs/.archive");
  const results: (ReturnType<typeof replay> & { name: string })[] = [];
  for (const entry of await readdir(archive, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(archive, entry.name);
    const [codex, events] = await Promise.all([
      readFile(join(dir, "codex.jsonl"), "utf8"),
      readFile(join(dir, "events.jsonl"), "utf8"),
    ]);
    results.push({ name: basename(dir), ...replay(codex, events) });
  }
  const sum = (
    key: "totalMs" | "anchoredMs" | "quietMs" | "falsePositiveMs" | "episodes" | "untimedMessages",
  ) => results.reduce((total, run) => total + run[key], 0);
  const percentage = (value: number, total: number) => (total === 0 ? null : (100 * value) / total);
  console.log(
    JSON.stringify(
      {
        estimate:
          "Untimed notification gaps excluded unless a command was open; recent deltas cannot be timed. False positives are checked against the same rule, so near zero is expected, not independent validation.",
        runs: results.length,
        totalRunningMinutes: sum("totalMs") / 60000,
        anchoredRunningMinutes: sum("anchoredMs") / 60000,
        coveragePercent: percentage(sum("anchoredMs"), sum("totalMs")),
        quietMinutes: sum("quietMs") / 60000,
        quietPercent: percentage(sum("quietMs"), sum("anchoredMs")),
        falsePositiveMinutes: sum("falsePositiveMs") / 60000,
        falsePositivePercent: percentage(sum("falsePositiveMs"), sum("anchoredMs")),
        quietEpisodes: sum("episodes"),
        runsWithQuiet: results.filter((run) => run.quietMs > 0).length,
        untimedMessages: sum("untimedMessages"),
        longestQuietStretches: results
          .flatMap((run) =>
            run.stretches.map((span) => ({
              run: run.name,
              start: new Date(span.start).toISOString(),
              minutes: (span.end - span.start) / 60000,
            })),
          )
          .sort((a, b) => b.minutes - a.minutes)
          .slice(0, 10),
      },
      null,
      2,
    ),
  );
}
