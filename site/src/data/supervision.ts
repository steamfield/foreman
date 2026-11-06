import type { Run, RunEvent, RunState } from "./runs";

export interface TimePoint {
  playback: number;
  run: number;
}

export interface ConsoleStep {
  id: string;
  t: number;
  kind: "user" | "prose" | "tool" | "output" | "question" | "note";
  text: string;
  label?: string;
  backgroundUntil?: number;
}

export type ConsoleEvent =
  | Exclude<RunEvent, { kind: "command" }>
  | Omit<Extract<RunEvent, { kind: "command" }>, "output">;

export interface ConsoleSnapshot {
  t: number;
  state: Exclude<RunState, "idle"> | "done" | "interrupted";
  commands: number;
  failed: number;
  files: number;
}

export interface ConsoleScript {
  name: string;
  durationMs: number;
  playbackMs: number;
  timeline: TimePoint[];
  holds: { label: string; t: number }[];
  steps: ConsoleStep[];
  events: ConsoleEvent[];
  snapshots: ConsoleSnapshot[];
  tokens: Run["tokens"];
}

/** A plateau lasts 2.5s; the remaining time follows square-root-weighted gaps.
 * Quiet stretches pass faster than dense activity without dropping chronology.
 */
export function buildTimeMap(times: number[], holds: number[]): TimePoint[] {
  const marks = [...new Set([0, ...times, ...holds])].sort((a, b) => a - b);
  const held = new Set(holds);
  const weights = marks.map((t, i) => Math.sqrt(t - (marks[i - 1] ?? 0)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const movingMs = 60_000 - held.size * 2500;
  const timeline: TimePoint[] = [];
  let playback = 0;
  marks.forEach((run, i) => {
    playback += totalWeight ? ((weights[i] ?? 0) / totalWeight) * movingMs : 0;
    timeline.push({ playback, run });
    if (held.has(run)) {
      playback += 2500;
      timeline.push({ playback, run });
    }
  });
  return timeline;
}

export function playbackToRun(timeline: TimePoint[], ms: number): number {
  const end = timeline.at(-1);
  if (!end) return 0;
  if (ms >= end.playback) return end.run;
  const index = timeline.findIndex((point) => point.playback >= ms);
  const right = timeline[index];
  const left = timeline[index - 1];
  if (!right || !left) return right?.run ?? 0;
  const fraction = (ms - left.playback) / (right.playback - left.playback);
  return left.run + fraction * (right.run - left.run);
}

/** The first playback instant at a run timestamp, before any reading hold. */
export function runToPlayback(timeline: TimePoint[], ms: number): number {
  const index = timeline.findIndex((point) => point.run >= ms);
  const right = timeline[index];
  const left = timeline[index - 1];
  if (!right) return timeline.at(-1)?.playback ?? 0;
  if (!left) return right.playback;
  const fraction = (ms - left.run) / (right.run - left.run);
  return left.playback + fraction * (right.playback - left.playback);
}

export function snapshotAt(script: ConsoleScript, t: number): ConsoleSnapshot {
  return (
    script.snapshots.findLast((snapshot) => snapshot.t <= t) ?? {
      t: 0,
      state: "starting",
      commands: 0,
      failed: 0,
      files: 0,
    }
  );
}

function digestLines(digest: string, prefixes: string[]): string {
  return digest
    .split("\n")
    .filter((line) => prefixes.some((prefix) => line.startsWith(prefix)))
    .join("\n");
}

export function buildConsoleScript(run: Run): ConsoleScript {
  // The last journal event is 1ms past durationMs in this recording.
  const durationMs = Math.max(
    run.durationMs,
    ...run.events.map((event) => event.t),
  );
  const completion = run.events.find(
    (event) => event.kind === "turn-completed",
  );
  const steps: ConsoleStep[] = [
    {
      id: "request",
      t: 0,
      kind: "user",
      text: "Fix part B of the release findings: supervisor state, persistence and recovery. Hand it to Codex.",
    },
    {
      id: "delegate",
      t: 0,
      kind: "prose",
      text: "I wrote a contract and am starting Codex in its own worktree, with the wait running in the background.",
    },
    {
      id: "start",
      t: 0,
      kind: "tool",
      text: `forman start ${run.name} --new-worktree --setup "bun install" --contract ${run.name}.md --write --wait`,
      backgroundUntil:
        run.questions.find((question) => question._tag === "Asked")?.t ??
        durationMs,
    },
    {
      id: "identity",
      t: 0,
      kind: "output",
      label: "Recorded status digest",
      text: digestLines(run.digest, ["run:", "worktree:", "branch:"]),
    },
  ];
  const holds = run.questions.map((question) => {
    // Hold after the matching state event, a few journal milliseconds later,
    // so both panes reach the same question/answer before the reading pause.
    const state = run.events.find(
      (event) => event.kind === "state" && event.t >= question.t,
    );
    return {
      label: `${question.id} ${question._tag}`,
      t: state?.t ?? question.t,
    };
  });
  holds.push({ label: "done", t: durationMs });

  for (const question of run.questions) {
    if (question._tag === "Asked") {
      steps.push({
        id: `${question.id}-asked`,
        t: question.t,
        kind: "question",
        label: question.id,
        text: question.question,
      });
    } else if (question.resolution === "answered") {
      steps.push({
        id: `${question.id}-answer`,
        t: question.t,
        kind: "tool",
        text: `forman answer ${run.name} ${question.id} "${question.text}" --wait`,
        backgroundUntil:
          run.questions.find(
            (next) => next._tag === "Asked" && next.t > question.t,
          )?.t ?? durationMs,
      });
      steps.push({
        id: `${question.id}-ok`,
        t: question.t,
        kind: "output",
        text: "ok",
      });
    } else {
      steps.push({
        id: `${question.id}-auto`,
        t: question.t,
        kind: "output",
        label: `${question.id} auto-answer`,
        text: question.text,
      });
      steps.push({
        id: `${question.id}-timeout`,
        t: question.t,
        kind: "note",
        text: "The 15-minute question timeout expired. forman told Codex to proceed and record its choice.",
      });
    }
  }
  steps.push(
    {
      id: "done",
      t: completion?.t ?? durationMs,
      kind: "output",
      label: "done",
      text: digestLines(run.digest, ["commands:"]),
    },
    {
      id: "review",
      t: completion?.t ?? durationMs,
      kind: "prose",
      text: "I’ll read the hand-off, review the diff and run the checks before committing.",
    },
  );

  const commands = run.events.filter((event) => event.kind === "command");
  const selected = new Set(
    commands.filter((_, i) => i % 12 === 0).map((event) => event.seq),
  );
  for (const { t } of holds) {
    const before = commands.filter((event) => event.t <= t).slice(-2);
    const after = commands.filter((event) => event.t > t).slice(0, 2);
    for (const event of [...before, ...after]) selected.add(event.seq);
  }
  const events: ConsoleEvent[] = run.events
    .filter((event) => event.kind !== "command" || selected.has(event.seq))
    .map((event) =>
      event.kind === "command"
        ? {
            kind: event.kind,
            seq: event.seq,
            t: event.t,
            command: event.command,
            exitCode: event.exitCode,
          }
        : event,
    );

  const files = new Set<string>();
  let count = 0;
  let failed = 0;
  let state: ConsoleSnapshot["state"] = "starting";
  let turnStatus = "";
  const snapshots = run.events.map((event) => {
    if (event.kind === "command") {
      count++;
      if (event.exitCode !== null && event.exitCode !== 0) failed++;
    }
    if (event.kind === "files") event.paths.forEach((path) => files.add(path));
    if (event.kind === "turn-completed") turnStatus = event.status;
    if (event.kind === "state") {
      state =
        event.to === "idle"
          ? turnStatus === "completed"
            ? "done"
            : "interrupted"
          : event.to;
    }
    return { t: event.t, state, commands: count, failed, files: files.size };
  });
  const timeline = buildTimeMap(
    [
      ...events.map((event) => event.t),
      ...steps.map((step) => step.t),
      durationMs,
    ],
    holds.map((hold) => hold.t),
  );
  return {
    name: run.name,
    durationMs,
    playbackMs: timeline.at(-1)?.playback ?? 0,
    timeline,
    holds,
    steps,
    events,
    snapshots,
    tokens: run.tokens,
  };
}
