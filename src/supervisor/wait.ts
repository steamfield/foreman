import { Clock, DateTime, Effect, Schema } from "effect";
import { mainCheckout } from "../core/main-checkout";
import { readEvents, readHandoff } from "../core/runs/store";
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
const Positions = Schema.Record(
  RunName,
  Schema.Struct({
    identity: Schema.String,
    seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    minimumTurn: Schema.optionalKey(Schema.Int),
    continuation: Schema.optionalKey(Schema.String),
  }),
);
const GroupPositions = Schema.TaggedStruct("GroupCursor", {
  group: Schema.String,
  positions: Positions,
});
const CursorJson = Schema.fromJsonString(Schema.Union([GroupPositions, Positions]));
const encode = (positions: typeof Positions.Type, group?: string) => {
  const json = Schema.encodeSync(CursorJson)(
    group === undefined ? positions : { _tag: "GroupCursor", group, positions },
  );
  const bytes = new TextEncoder().encode(json);
  const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
  return Schema.decodeUnknownSync(Cursor)(
    `u1.${base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`,
  );
};

const identity = (run: Run) =>
  `${DateTime.formatIso(run.record.createdAt)}:${run.record.threadId ?? ""}`;

// Call with the run lock held, before queued notifications can advance its position.
export const acceptedCursor = Effect.fnUntraced(function* (run: Run, continuation?: string) {
  const page = yield* readEvents(run.dir, 0, Number.MAX_SAFE_INTEGER);
  return {
    cursor: encode(
      {
        [run.record.name]: {
          identity: identity(run),
          seq: page.next,
          ...(continuation === undefined ? {} : { continuation }),
        },
      },
      run.record.group,
    ),
  };
});
const decodeCursor = Effect.fnUntraced(function* (cursor: Cursor | undefined) {
  if (cursor === undefined) return { positions: {} };
  const unicode = cursor.startsWith("u1.");
  const payload = unicode ? cursor.slice(3) : cursor;
  const text = yield* Effect.try({
    try: () => {
      const binary = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
      return unicode
        ? new TextDecoder("utf-8", { fatal: true }).decode(
            Uint8Array.from(binary, (char) => char.charCodeAt(0)),
          )
        : binary;
    },
    catch: () =>
      new Usage({
        detail:
          "Invalid --after cursor. Use a cursor from a previous forman command, or omit --after to start again.",
      }),
  });
  const parsed = yield* Schema.decodeUnknownEffect(CursorJson)(text).pipe(
    Effect.mapError(
      () =>
        new Usage({
          detail:
            "Invalid --after cursor. Use a cursor from a previous forman command, or omit --after to start again.",
        }),
    ),
  );
  return Schema.is(GroupPositions)(parsed)
    ? { positions: parsed.positions, group: parsed.group }
    : { positions: parsed };
});

export const groupFor = Effect.fn("supervisor.groupFor")(function* (cwd: string) {
  return (yield* mainCheckout(cwd)) ?? "";
});

const attention = Effect.fnUntraced(function* (
  registry: Registry,
  run: Run,
  after: number,
  minimumTurn = 0,
  continuation?: string,
) {
  const page = yield* readEvents(run.dir, after, Number.MAX_SAFE_INTEGER);
  const delivered = page.events.flatMap(({ event }) =>
    event._tag === "QuestionResolved" &&
    event.continuation !== undefined &&
    event.continuation.id === continuation
      ? [event.continuation]
      : [],
  )[0];
  const requiredTurn = delivered?.turn ?? minimumTurn;
  const awaitingDelivery = continuation !== undefined && delivered === undefined;
  const position = {
    ...(requiredTurn > 0 ? { minimumTurn: requiredTurn } : {}),
    ...(awaitingDelivery ? { continuation } : {}),
  };
  const relevant = page.events.filter(
    ({ event }) =>
      event._tag === "QuestionAsked" ||
      event._tag === "TurnCompleted" ||
      (event._tag === "StateChanged" && (event.to === "lost" || event.to === "failed")),
  );
  const outcomes: (typeof WaitOutcome.Type)[] = [];
  if (relevant.length === 0) return { outcomes, next: page.next, ...position };
  const digest = yield* registry.digest(run, true);
  for (const { event } of relevant) {
    if (event._tag === "QuestionAsked") {
      if (digest.questions.some((question) => question.id === event.id))
        outcomes.push({
          name: run.record.name,
          kind: "question",
          summary: `${event.id} (${event.kind}): ${event.question}`,
          digest,
          handoff: null,
        });
    } else if (event._tag === "TurnCompleted") {
      if (awaitingDelivery || event.turn < requiredTurn) continue;
      // The interrupted working turn belongs to the budget transition, not a hand-off yet.
      if (run.record.turnKind === "handoff" && activeStates.has(run.record.state)) continue;
      let kind: "done" | "failed" | "interrupted" = "done";
      const current = event.turn === run.record.turns;
      if (event.status === "failed" || (current && digest.state === "failed")) kind = "failed";
      else if (event.status === "interrupted" || (current && digest.state === "interrupted"))
        kind = "interrupted";
      const { handoff } = yield* readHandoff(run.dir, event.turn);
      const unanswered = digest.unansweredQuestions ?? [];
      const blocked = unanswered.find((question) => question.kind === "blocked");
      let summary = `turn ${event.turn}`;
      if (blocked) summary = `blocked on ${blocked.id}`;
      else if (unanswered.length)
        summary = `${kind}, ${unanswered.length} unanswered question${unanswered.length === 1 ? "" : "s"}`;
      outcomes.push({
        name: run.record.name,
        kind,
        summary,
        digest,
        handoff: handoff?.turn === event.turn ? handoff : null,
      });
    } else if (event._tag === "StateChanged") {
      // A normal failed completion already carries its own turn number and hand-off.
      if (
        event.to === "failed" &&
        !awaitingDelivery &&
        page.events.some(
          ({ event }) => event._tag === "TurnCompleted" && event.turn === run.record.turns,
        )
      )
        continue;
      outcomes.push({
        name: run.record.name,
        kind: event.to === "failed" ? "failed" : "lost",
        summary:
          event.to === "failed" ? "supervisor operation failed" : "app server or daemon went away",
        digest,
        handoff: null,
      });
    }
  }
  const latest = outcomes.at(-1);
  return { outcomes: latest ? [latest] : [], next: page.next, ...position };
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
  if (!body.all && body.names.length === 0)
    return yield* new Usage({
      detail: "Provide a run name or use --all to wait for the current repository group.",
    });
  const decoded = yield* decodeCursor(body.after);
  const positions = decoded.positions;
  let group = decoded.group;
  if (body.all) group ??= yield* groupFor(body.cwd);
  else {
    const only = body.names.length === 1 ? body.names[0] : undefined;
    group = only === undefined ? undefined : (yield* registry.lookup(only)).record.group;
  }
  const skipped = body.all ? yield* registry.skipped(group ?? "") : [];
  const deadline = (yield* Clock.currentTimeMillis) + body.timeoutMs;
  const result = (
    outcome: "events" | "timeout" | "none",
    runs: readonly (typeof WaitOutcome.Type)[],
    cursor: Cursor,
  ): Extract<DaemonResult, { _tag: "Waited" }> => {
    const target = runs.flatMap(({ name, digest }) => [
      ...digest.questions.map((question) => ({ name, question, pending: true })),
      ...(digest.unansweredQuestions ?? []).map((question) => ({ name, question, pending: false })),
    ])[0];
    return {
      _tag: "Waited",
      outcome,
      runs,
      ...(skipped.length > 0 ? { skipped } : {}),
      cursor,
      next: target
        ? `forman answer ${target.name} ${target.question.id} "<answer>"`
        : `forman wait ${body.all ? "--all" : body.names.join(" ")} --after ${cursor}`,
      ...(target?.pending
        ? { alternative: `forman defer ${target.name} ${target.question.id}` }
        : {}),
    };
  };
  const encodeNext = (next: typeof Positions.Type) => encode(next, group);
  const timeout = () => result("timeout", [], body.after ?? encodeNext(positions));
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
            if (body.all && !registry.isCurrent(run)) return;
            yield* registry.requireCurrent(run);
            const currentIdentity = identity(run);
            const previous = Object.hasOwn(positions, run.record.name)
              ? positions[run.record.name]
              : undefined;
            const after = previous?.identity === currentIdentity ? previous.seq : 0;
            const minimumTurn =
              previous?.identity === currentIdentity ? previous.minimumTurn : undefined;
            const continuation =
              previous?.identity === currentIdentity ? previous.continuation : undefined;
            const result = yield* attention(registry, run, after, minimumTurn, continuation);
            next[run.record.name] = {
              identity: currentIdentity,
              seq: result.next,
              ...(result.minimumTurn === undefined ? {} : { minimumTurn: result.minimumTurn }),
              ...(result.continuation === undefined ? {} : { continuation: result.continuation }),
            };
            outcomes.push(...result.outcomes);
            active ||= activeStates.has(run.record.state);
          }),
        );
      if (outcomes.length > 0) return result("events", outcomes, encodeNext(next));
      if (body.all && !active) return result("none", [], encodeNext(next));
      // Ready attention includes a worktree refresh; only waiting for a change can time out.
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) return timeout();
      const changed = yield* change.pipe(
        Effect.as(true),
        Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.succeed(false) }),
      );
      if (!changed) return timeout();
    }
  });
  return yield* consider;
});
