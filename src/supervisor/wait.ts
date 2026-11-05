import { Effect, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { commandResult } from "../core/preflight/command";
import { readEvents } from "../core/runs/store";
import { Usage } from "../errors";
import {
  activeStates,
  Cursor,
  type DaemonRequestBody,
  type DaemonResult,
  RunName,
  type WaitOutcome,
} from "../schemas/daemon";
import type { Registry, Run } from "./registry";

// This internal schema belongs to the supervisor; Cursor stays opaque to the public protocol.
const Positions = Schema.Record(RunName, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
const CursorJson = Schema.fromJsonString(Positions);
const encode = (positions: typeof Positions.Type) =>
  Schema.decodeUnknownSync(Cursor)(
    btoa(Schema.encodeSync(CursorJson)(positions))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
  );
const decodeCursor = Effect.fnUntraced(function* (cursor: Cursor | undefined) {
  if (cursor === undefined) return {};
  const text = yield* Effect.try({
    try: () => atob(cursor.replaceAll("-", "+").replaceAll("_", "/")),
    catch: () => new Usage(),
  });
  return yield* Schema.decodeUnknownEffect(CursorJson)(text).pipe(
    Effect.mapError(() => new Usage()),
  );
});

export const groupFor = Effect.fn("supervisor.groupFor")(function* (cwd: string) {
  const result = yield* commandResult(
    ChildProcess.make("git", ["worktree", "list", "--porcelain", "-z"], { cwd, stderr: "ignore" }),
  ).pipe(Effect.catch(() => Effect.succeed({ code: 1, stdout: "" })));
  const first = result.stdout.split("\0")[0];
  return result.code === 0 && first?.startsWith("worktree ") ? first.slice(9) : "";
});

const attention = Effect.fnUntraced(function* (registry: Registry, run: Run, after: number) {
  const page = yield* readEvents(run.dir, after, Number.MAX_SAFE_INTEGER);
  const relevant = page.events.filter(
    ({ event }) =>
      event._tag === "QuestionAsked" ||
      event._tag === "TurnCompleted" ||
      (event._tag === "StateChanged" && event.to === "lost"),
  );
  const outcomes: (typeof WaitOutcome.Type)[] = [];
  const digest = yield* registry.digest(run);
  for (const { event } of relevant) {
    if (event._tag === "QuestionAsked") {
      if (digest.questions.some((question) => question.id === event.id))
        outcomes.push({
          name: run.record.name,
          kind: "question",
          summary: `${event.id} (${event.kind}): ${event.question}`,
          digest,
        });
    } else if (event._tag === "TurnCompleted") {
      // The interrupted working turn belongs to the budget transition, not a hand-off yet.
      if (run.record.turnKind === "handoff" && activeStates.has(run.record.state)) continue;
      let kind: "done" | "failed" | "interrupted" = "done";
      if (event.status === "failed" || digest.state === "failed") kind = "failed";
      else if (event.status === "interrupted" || digest.state === "interrupted")
        kind = "interrupted";
      outcomes.push({ name: run.record.name, kind, summary: `turn ${event.turn}`, digest });
    } else if (event._tag === "StateChanged")
      outcomes.push({
        name: run.record.name,
        kind: "lost",
        summary: "app server or daemon went away",
        digest,
      });
  }
  return { outcomes, next: page.next };
});

export const wait = Effect.fn("supervisor.wait")(function* (
  registry: Registry,
  body: Extract<DaemonRequestBody, { _tag: "Wait" }>,
): Effect.fn.Return<
  Extract<DaemonResult, { _tag: "Waited" }>,
  unknown,
  | import("effect").FileSystem.FileSystem
  | import("effect").Path.Path
  | import("effect/process").ChildProcessSpawner.ChildProcessSpawner
> {
  if (!body.all && body.names.length === 0) return yield* new Usage();
  const positions = yield* decodeCursor(body.after);
  const group = body.all ? yield* groupFor(body.cwd) : "";
  const consider = Effect.gen(function* () {
    while (true) {
      const change = yield* registry.change;
      const runs = body.all
        ? [...registry.runs.values()].filter((run) => run.record.group === group)
        : yield* Effect.forEach(body.names, registry.lookup);
      const next = { ...positions };
      const outcomes: (typeof WaitOutcome.Type)[] = [];
      let active = false;
      for (const run of runs)
        yield* run.lock.withPermits(1)(
          Effect.gen(function* () {
            const result = yield* attention(registry, run, positions[run.record.name] ?? 0);
            next[run.record.name] = result.next;
            outcomes.push(...result.outcomes);
            active ||= activeStates.has(run.record.state);
          }),
        );
      if (outcomes.length > 0)
        return {
          _tag: "Waited" as const,
          outcome: "events" as const,
          runs: outcomes,
          cursor: encode(next),
        };
      if (body.all && !active)
        return {
          _tag: "Waited" as const,
          outcome: "none" as const,
          runs: [],
          cursor: encode(next),
        };
      yield* change;
    }
  });
  return yield* consider.pipe(
    Effect.timeoutOrElse({
      duration: body.timeoutMs,
      orElse: () =>
        Effect.succeed({
          _tag: "Waited" as const,
          outcome: "timeout" as const,
          runs: [],
          cursor: body.after ?? encode(positions),
        }),
    }),
  );
});
