import { assert, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { openActing } from "../src/core/monitor/acting";
import { RunName } from "../src/schemas/daemon";
import { successfulTurn } from "./fixtures/fake-app-server/scenarios";
import { eventsFixture, eventsPlatform as platform } from "./helpers/events";

const fixture = Effect.fnUntraced(function* (running = false) {
  const f = yield* eventsFixture({
    rules: [
      ...successfulTurn().rules.map((rule) =>
        rule.method === "turn/start"
          ? {
              ...rule,
              repeat: true,
              ...(running
                ? {
                    steps: [
                      { awaitRequest: "turn/interrupt" },
                      {
                        notify: "turn/completed",
                        params: {
                          threadId: "{{thread}}",
                          turn: { id: "{{turn}}", status: "interrupted", items: [], error: null },
                        },
                      },
                    ],
                  }
                : {}),
            }
          : { ...rule, repeat: true },
      ),
      { method: "turn/steer", repeat: true, respond: { result: { turnId: "{{turn}}" } } },
      { method: "turn/interrupt", repeat: true, respond: { result: {} } },
    ],
  });
  yield* f.untilState(running ? "running" : "idle");
  const session = yield* openActing(f.env.FOREMAN_HOME);
  const fs = yield* FileSystem.FileSystem;
  const wire = fs.readFileString(`${f.root}/received.jsonl`).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(
            Schema.fromJsonString(
              Schema.Struct({
                method: Schema.optionalKey(Schema.String),
                params: Schema.optionalKey(Schema.Unknown),
              }),
            ),
          )(line),
        ),
    ),
  );
  return { ...f, session, fs, wire };
});

it.live("steer sends UTF-8 text to the active turn and reports bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    expect(yield* f.session.send({ kind: "steer", name: f.name, text: "café 🐈" })).toBe(
      "steered unit · 10 bytes",
    );
    expect((yield* f.wire).filter((entry) => entry.method === "turn/steer")).toEqual([
      {
        method: "turn/steer",
        params: {
          threadId: expect.any(String),
          expectedTurnId: expect.any(String),
          input: [{ type: "text", text: "café 🐈" }],
        },
      },
    ]);
  }).pipe(Effect.provide(platform)),
);

it.live("followup starts the next turn and reports success without an absent reply turn", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(yield* f.session.send({ kind: "followup", name: f.name, text: "Continue with B" })).toBe(
      "followed up unit",
    );
    yield* f.untilState("idle");
    const status = yield* f.request({ _tag: "Status", name: f.name, cwd: `${f.root}/repo` });
    assert(status._tag === "Digests");
    expect(status.digests[0]?.turn).toBe(2);
    expect(
      (yield* f.wire).filter((entry) => entry.method === "turn/start").at(-1)?.params,
    ).toMatchObject({ input: [{ type: "text", text: "Continue with B" }] });
  }).pipe(Effect.provide(platform)),
);

it.live("review marks the run reviewed and returns the outcome line", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(yield* f.session.send({ kind: "review", name: f.name })).toBe("marked unit reviewed");
    const live = yield* f.request({ _tag: "Overview" });
    assert(live._tag === "Overview");
    expect(live.runs[0]?.reviewedAt).not.toBeNull();
  }).pipe(Effect.provide(platform)),
);

it.live("interrupt ends the active turn and attributes the event to the monitor", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    expect(yield* f.session.send({ kind: "interrupt", name: f.name })).toBe("interrupted unit");
    yield* f.untilState("interrupted");
    const events = yield* f.request({ _tag: "Events", name: f.name });
    assert(events._tag === "Events");
    expect(events.events.map(({ event }) => event)).toContainEqual({
      _tag: "Interrupted",
      by: "monitor",
    });
  }).pipe(Effect.provide(platform)),
);

it.live.each([false, true])(
  "archive moves an idle run into the archive, keepWorktree=%s",
  (keepWorktree) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const name = Schema.decodeUnknownSync(RunName)("managed");
      const started = yield* f.request({
        _tag: "Start",
        name,
        worktree: `${f.root}/repo`,
        newWorktree: true,
        contract: "Read the repo.",
        write: false,
        skipDepsCheck: false,
      });
      assert(started._tag === "Started" && started.worktree !== undefined);
      while (true) {
        const status = yield* f.request({ _tag: "Status", name, cwd: `${f.root}/repo` });
        if (status._tag === "Digests" && status.digests[0]?.state === "idle") break;
        yield* Effect.yieldNow;
      }
      expect(yield* f.session.send({ kind: "archive", name, keepWorktree })).toBe(
        keepWorktree ? "archived managed · worktree kept" : "archived managed",
      );
      expect(yield* f.fs.exists(started.worktree)).toBe(keepWorktree);
      expect(yield* f.fs.exists(`${f.env.FOREMAN_HOME}/runs/managed`)).toBe(false);
      expect(
        (yield* f.request({ _tag: "Status", name, cwd: `${f.root}/repo` }).pipe(Effect.flip))._tag,
      ).toBe("RunNotFound");
      expect(yield* f.fs.readDirectory(`${f.env.FOREMAN_HOME}/runs/.archive`)).toHaveLength(1);
    }).pipe(Effect.provide(platform)),
);

it.live.each(["steer", "followup", "archive"] as const)(
  "invalid-state %s preserves the daemon's RunConflict",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture(kind !== "steer");
      const error = yield* f.session
        .send(
          kind === "archive"
            ? { kind, name: f.name, keepWorktree: false }
            : { kind, name: f.name, text: "B" },
        )
        .pipe(Effect.flip);
      expect(error._tag).toBe("RunConflict");
    }).pipe(Effect.provide(platform)),
);
