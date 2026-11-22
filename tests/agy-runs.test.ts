// Phase 2 of docs/rfcs/0002-providers.md: agy runs end to end through the real daemon and
// supervisor, with the fake ACP agent standing in for `agy acp`.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  cancellableTurn,
  prompt,
  refusedEdit,
  writeTurn,
} from "./fixtures/fake-acp-agent/scenarios";
import { agyFixture, agyPlatform as platform } from "./helpers/agy";

const methodsOf = (messages: readonly unknown[]) =>
  messages.flatMap((message) =>
    typeof message === "object" && message !== null && "method" in message
      ? [String(message.method)]
      : [],
  );
const paramsOf = (messages: readonly unknown[], method: string) =>
  messages.flatMap((message) =>
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    message.method === method &&
    "params" in message
      ? [message.params]
      : [],
  );

it.live(
  "a write run approves agy's tools, records its work and returns the hand-off",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(writeTurn());
      yield* f.start(true);
      const digest = yield* f.until("idle");
      expect(digest).toMatchObject({
        provider: "agy",
        model: "gemini-4-neon",
        effort: "low",
        turn: 1,
        filesWritten: ["result.txt"],
        failure: null,
      });
      expect(yield* f.request({ _tag: "Result", name: f.name })).toMatchObject({
        handoff: { turn: 1, text: "Created result.txt." },
      });
      const events = yield* f.events;
      expect(events).toContainEqual({
        _tag: "Permission",
        kind: "execute",
        title: "git status --short",
        decision: "approved",
      });
      expect(events).toContainEqual({
        _tag: "Permission",
        kind: "edit",
        title: "File result.txt",
        decision: "approved",
      });
      expect(events).toContainEqual(
        expect.objectContaining({ _tag: "Command", command: "git status --short", exitCode: 0 }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          _tag: "FileChange",
          paths: [expect.stringMatching(/\/work\/unit\/result\.txt$/)],
        }),
      );
      expect(events).toContainEqual({
        _tag: "AgentMessage",
        text: "Created result.txt.",
        phase: "final_answer",
      });
      expect(events).toContainEqual({
        _tag: "TokenUsage",
        totals: { input: 1200, cachedInput: 200, output: 50, reasoningOutput: 10 },
      });
      expect(events).toContainEqual(
        expect.objectContaining({ _tag: "TurnCompleted", turn: 1, status: "completed" }),
      );
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "an agy session opens with the model and effort, in default mode, in the worktree",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(writeTurn());
      yield* f.start(true);
      yield* f.until("idle");
      const received = yield* f.received;
      expect(methodsOf(received).slice(0, 4)).toEqual([
        "initialize",
        "session/new",
        "session/set_config_option",
        "session/set_mode",
      ]);
      expect(paramsOf(received, "initialize")[0]).toMatchObject({ protocolVersion: 1 });
      expect(paramsOf(received, "session/new")[0]).toMatchObject({
        cwd: expect.stringMatching(/\/repo\/work\/unit$/),
        mcpServers: [
          {
            name: "foreman",
            command: expect.stringMatching(/bun$/),
            args: [
              expect.stringMatching(/tests\/fixtures\/foreman-cli\/entry\.ts$/),
              "mcp-question",
              "--run",
              "unit",
            ],
            env: [{ name: "FOREMAN_HOME", value: f.home }],
          },
        ],
      });
      expect(paramsOf(received, "session/set_config_option")[0]).toMatchObject({
        configId: "model",
        value: "gemini-4-neon-low",
      });
      expect(paramsOf(received, "session/set_mode")[0]).toMatchObject({ modeId: "default" });
      expect(yield* f.runJson).toMatchObject({ formatVersion: 3, provider: "agy" });
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "agy launches with telemetry off, outside the worktree and without API keys",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(writeTurn());
      yield* f.start(true);
      yield* f.until("idle");
      const [launch, ...more] = yield* f.launches;
      expect(more).toEqual([]);
      expect(launch).toMatchObject({
        argv: [
          "acp",
          "--disable-telemetry",
          "--log-file",
          expect.stringMatching(/\/d\/logs\/agy-acp\.log$/),
        ],
        cwd: expect.stringMatching(/\/d\/providers\/agy\/cwd$/),
        env: expect.objectContaining({ AGY_DELEGATE: "1", STACKS_DELEGATE: "1" }),
      });
      expect(launch).not.toHaveProperty("env.GEMINI_API_KEY");
      expect(launch).not.toHaveProperty("env.FOREMAN_HOME");
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "a read-only run refuses agy's edit and fails with the refusal",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(refusedEdit());
      yield* f.start(false);
      const digest = yield* f.until("failed");
      expect(digest.failure?.message).toContain(
        "foreman refused File result.txt (edit) in a read-only run",
      );
      expect(digest.warnings).toContainEqual(
        expect.stringContaining("read-only on agy blocks agy's edit tools but not shell commands"),
      );
      expect(yield* f.events).toContainEqual({
        _tag: "Permission",
        kind: "edit",
        title: "File result.txt",
        decision: "rejected",
      });
      const answers = (yield* f.received).filter(
        (message) => typeof message === "object" && message !== null && !("method" in message),
      );
      expect(answers).toContainEqual(
        expect.objectContaining({ result: { outcome: { outcome: "selected", optionId: "deny" } } }),
      );
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "interrupt cancels the agy session and the run ends interrupted",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(cancellableTurn());
      yield* f.start(true);
      yield* f.until("running");
      yield* f.request({ _tag: "Interrupt", name: f.name });
      yield* f.until("interrupted");
      expect(methodsOf(yield* f.received)).toContain("session/cancel");
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "a followup prompts the same agy session",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(writeTurn());
      yield* f.start(true);
      yield* f.until("idle");
      yield* f.request({ _tag: "Followup", name: f.name, message: "Say you are done." });
      yield* f.until("idle", 2);
      expect(yield* f.request({ _tag: "Result", name: f.name })).toMatchObject({
        handoff: { turn: 2, text: "Follow-up done." },
      });
      const methods = methodsOf(yield* f.received);
      expect(methods.filter((method) => method === "session/new")).toHaveLength(1);
      expect(methods.filter((method) => method === "session/prompt")).toHaveLength(2);
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "an idle agy run archives",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(writeTurn());
      yield* f.start(true);
      yield* f.until("idle");
      expect(yield* f.request({ _tag: "Archive", name: f.name, keepWorktree: true })).toMatchObject(
        { _tag: "Archived", name: "unit" },
      );
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "an agy start is refused in a repo whose hooks exist only for Codex",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(writeTurn(), { codexHooks: true });
      const error = yield* f.start(true).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "RepoHooksUntrusted",
        detail: expect.stringContaining(".codex/hooks.json"),
      });
      expect(methodsOf(yield* f.received)).not.toContain("session/prompt");
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "an agy start is refused when agy speaks another ACP protocol",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(writeTurn(), { protocol: 2 });
      const error = yield* f.start(true).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AgyUnavailable",
        detail: expect.stringContaining("agy speaks ACP protocol 2; foreman supports 1"),
      });
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "an interrupt agy never confirms leaves the run unknown, not running",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(cancellableTurn());
      const hold = yield* f.gate("hold");
      // agy sees the cancel but never ends the prompt until the test opens the gate.
      yield* f.useScenario({
        rules: [prompt([{ awaitRequest: "session/cancel" }, { gate: hold }], "cancelled")],
      });
      yield* f.start(true);
      yield* f.until("running");
      yield* f.request({ _tag: "Interrupt", name: f.name });
      const digest = yield* f.until("unknown");
      expect(digest.warnings.join(" ")).toContain("was not confirmed by");
      yield* f.openGate(hold);
    }).pipe(Effect.provide(platform)),
  60_000,
);
