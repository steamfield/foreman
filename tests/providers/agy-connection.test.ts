// The agy ProviderConnection against the fake ACP agent (tests/fixtures/fake-acp-agent): the
// handshake and session setup, a turn's events and hand-off, permission answers, interrupts,
// and how a lost or missing agy is reported.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Fiber, FileSystem, Schema, type Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { AgyUnavailable } from "../../src/errors";
import { connectAgy } from "../../src/providers/agy/connection";
import { UNATTENDED_INSTRUCTIONS } from "../../src/providers/agy/launch";
import type { Inbound, ProviderConnection, ProviderEvent } from "../../src/providers/contract";
import {
  type AcpScenario,
  AcpScenario as AcpScenarioSchema,
} from "../fixtures/fake-acp-agent/scenario";
import {
  allowAlwaysOnly,
  cancellableTurn,
  command,
  edit,
  longHandoff,
  message,
  prompt,
  refusedEdit,
  writeTurn,
} from "../fixtures/fake-acp-agent/scenarios";

const fake = fileURLToPath(new URL("../fixtures/fake-acp-agent/main.mjs", import.meta.url));
const usageTotals = { input: 1200, cachedInput: 200, output: 50, reasoningOutput: 10 };

/** Connects to the fake agent playing `scenario`, in a temp home with a temp worktree. */
const fakeAgy = Effect.fnUntraced(function* (
  scenario: AcpScenario,
  options: { protocol?: number; agyBin?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-acp-" });
  const worktree = join(root, "work");
  yield* fs.makeDirectory(worktree);
  const scenarioFile = join(root, "scenario.json");
  yield* fs.writeFileString(
    scenarioFile,
    Schema.encodeSync(Schema.fromJsonString(AcpScenarioSchema))(scenario),
  );
  const log = join(root, "received.jsonl");
  const launches = join(root, "launches.jsonl");
  const connected = yield* connectAgy({
    agyBin: options.agyBin ?? fake,
    home: join(root, "home"),
    env: {
      PATH: dirname(process.execPath),
      FAKE_ACP_SCENARIO: scenarioFile,
      FAKE_ACP_LOG: log,
      FAKE_ACP_ARGS: launches,
      ...(options.protocol === undefined ? {} : { FAKE_ACP_PROTOCOL: String(options.protocol) }),
    },
    version: "test-version",
    executable: ["/opt/foreman/bin/foreman"],
    stderr: () => Effect.void,
  });
  const readLines = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) =>
        text
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line)),
      ),
    );
  return {
    ...connected,
    root,
    worktree,
    received: readLines(log),
    launches: readLines(launches),
  };
});

const settings = (cwd: string, access: "write" | "read-only" = "write") => ({
  cwd,
  model: "gemini-4-neon",
  effort: "low",
  tier: null,
  access,
});

const turnOne = (cwd: string, access: "write" | "read-only" = "write") => ({
  turn: 1,
  kind: "start" as const,
  input: "Create result.txt.",
  settings: settings(cwd, access),
});

const completes = (inbound: Inbound) =>
  inbound.events.some((event) => event._tag === "TurnCompleted");

/** Every Inbound up to and including the one that completes the turn. */
const untilCompleted = (connection: ProviderConnection) =>
  connection.inbound.pipe(Stream.takeUntil(completes), Stream.runCollect);

const eventsOf = (inbounds: readonly Inbound[]): ProviderEvent[] =>
  inbounds.flatMap((inbound) => inbound.events).filter((event) => event._tag !== "Activity");

const methodOf = (message: unknown) =>
  typeof message === "object" && message !== null && "method" in message
    ? message.method
    : undefined;

const provide = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("opens a session in the worktree with the model, effort and default mode", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(writeTurn());
      const opened = yield* agy.connection.open("unit", settings(agy.worktree));

      expect(opened.warnings).toEqual([]);
      expect(agy.connection.isLoaded(opened.session)).toBe(true);
      expect(agy.agentVersion).toBe("1.5.14");
      expect(yield* agy.received).toEqual([
        expect.objectContaining({
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "foreman", version: "test-version" },
          },
        }),
        expect.objectContaining({
          method: "session/new",
          params: {
            cwd: agy.worktree,
            mcpServers: [
              {
                name: "foreman",
                command: "/opt/foreman/bin/foreman",
                args: ["mcp-question", "--run", "unit"],
                env: [{ name: "FOREMAN_HOME", value: `${agy.root}/home` }],
              },
            ],
            _meta: { antigravity: { systemPrompt: { append: UNATTENDED_INSTRUCTIONS } } },
          },
        }),
        expect.objectContaining({
          method: "session/set_config_option",
          params: { sessionId: opened.session, configId: "model", value: "gemini-4-neon-low" },
        }),
        expect.objectContaining({
          method: "session/set_mode",
          params: { sessionId: opened.session, modeId: "default" },
        }),
      ]);
      expect(yield* agy.launches).toEqual([
        expect.objectContaining({
          argv: ["acp", "--disable-telemetry", "--log-file", `${agy.root}/home/logs/agy-acp.log`],
          cwd: expect.stringMatching(/\/home\/providers\/agy\/cwd$/),
        }),
      ]);
    }),
  ),
);

it.effect.each([
  { model: "gemini-4-neon-high", effort: "high", value: "gemini-4-neon-high" },
  { model: "claude-opus-5-5", effort: "none", value: "claude-opus-5-5" },
])("sets model $model with effort $effort as $value", ({ model, effort, value }) =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(writeTurn());
      const { session } = yield* agy.connection.open("unit", {
        ...settings(agy.worktree),
        model,
        effort,
      });
      const configured = (yield* agy.received).filter(
        (line) => methodOf(line) === "session/set_config_option",
      );
      expect(configured).toEqual([
        expect.objectContaining({ params: { sessionId: session, configId: "model", value } }),
      ]);
    }),
  ),
);

it.effect("refuses an agy that speaks another ACP protocol", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* fakeAgy(writeTurn(), { protocol: 2 }).pipe(Effect.flip);
      expect(error).toEqual(
        new AgyUnavailable({
          detail:
            "agy speaks ACP protocol 2; foreman supports 1. Install agy 1.5.14 or a compatible version, then run foreman doctor.",
        }),
      );
    }),
  ),
);

it.effect("reports a signed-out agy when session/new is refused for authentication", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({
        rules: [
          {
            method: "session/new",
            respond: { error: { code: -32000, message: "auth_required: sign in first" } },
          },
        ],
      });
      const error = yield* agy.connection.open("unit", settings(agy.worktree)).pipe(Effect.flip);
      expect(error).toEqual(
        new AgyUnavailable({
          detail: "agy isn't signed in. Run agy once and sign in, then run foreman doctor.",
        }),
      );
    }),
  ),
);

it.effect("a turn reports commands, edits, commentary, usage and the hand-off in order", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({
        rules: [
          prompt([
            message("Looking."),
            ...command("git status --short", " M a.txt\n"),
            ...edit("result.txt", "hello\n"),
            message("Created result.txt."),
          ]),
        ],
      });
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      expect(yield* agy.connection.startTurn(session, turnOne(agy.worktree))).toBe("t1");
      const inbounds = yield* untilCompleted(agy.connection);

      expect(inbounds.every((inbound) => inbound.session === session)).toBe(true);
      expect(eventsOf(inbounds)).toEqual([
        { _tag: "TurnStarted", turn: "t1" },
        { _tag: "AgentMessage", turn: "t1", text: "Looking.", phase: "commentary" },
        {
          _tag: "ItemStarted",
          turn: "t1",
          id: "call_cmd_18",
          kind: "command",
          type: "execute",
          command: "git status --short",
        },
        {
          _tag: "ItemCompleted",
          turn: "t1",
          item: {
            kind: "command",
            id: "call_cmd_18",
            command: "git status --short",
            status: "completed",
            exitCode: 0,
            outputTail: "Command output:\n M a.txt\n",
          },
        },
        {
          _tag: "ItemStarted",
          turn: "t1",
          id: "call_edit_result.txt",
          kind: "fileChange",
          type: "edit",
          command: null,
        },
        {
          _tag: "ItemCompleted",
          turn: "t1",
          item: {
            kind: "fileChange",
            id: "call_edit_result.txt",
            paths: [`${agy.worktree}/result.txt`],
          },
        },
        { _tag: "AgentMessage", turn: "t1", text: "Created result.txt.", phase: "final_answer" },
        { _tag: "TokenUsage", turn: "t1", totals: usageTotals },
        {
          _tag: "TurnCompleted",
          turn: "t1",
          status: "completed",
          failure: null,
          handoff: "Created result.txt.",
        },
      ]);
    }),
  ),
);

it.effect("a write turn approves agy's command and edit with the allow option", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(writeTurn());
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      const events = eventsOf(yield* untilCompleted(agy.connection));

      expect(events.filter((event) => event._tag === "Permission")).toEqual([
        {
          _tag: "Permission",
          turn: "t1",
          kind: "execute",
          title: "git status --short",
          decision: "approved",
        },
        {
          _tag: "Permission",
          turn: "t1",
          kind: "edit",
          title: "File result.txt",
          decision: "approved",
        },
      ]);
      const answers = (yield* agy.received).filter((line) => methodOf(line) === undefined);
      expect(answers).toEqual([
        {
          jsonrpc: "2.0",
          id: "r0",
          result: { outcome: { outcome: "selected", optionId: "allow" } },
        },
        {
          jsonrpc: "2.0",
          id: "r1",
          result: { outcome: { outcome: "selected", optionId: "allow" } },
        },
      ]);
      expect(events.at(-1)).toMatchObject({ _tag: "TurnCompleted", status: "completed" });
    }),
  ),
);

it.effect("a read-only run refuses agy's edit and the turn fails with the refusal", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(refusedEdit());
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree, "read-only"));
      yield* agy.connection.startTurn(session, turnOne(agy.worktree, "read-only"));
      const events = eventsOf(yield* untilCompleted(agy.connection));

      expect(events).toContainEqual({
        _tag: "Permission",
        turn: "t1",
        kind: "edit",
        title: "File result.txt",
        decision: "rejected",
      });
      expect(events.at(-1)).toEqual({
        _tag: "TurnCompleted",
        turn: "t1",
        status: "failed",
        failure: {
          message: expect.stringContaining(
            "foreman refused File result.txt (edit) in a read-only run",
          ),
          codexErrorInfo: null,
        },
        handoff: "Reading first.",
      });
      const answers = (yield* agy.received).filter((line) => methodOf(line) === undefined);
      expect(answers).toEqual([
        {
          jsonrpc: "2.0",
          id: "r0",
          result: { outcome: { outcome: "selected", optionId: "deny" } },
        },
      ]);
    }),
  ),
);

it.effect("a reply written right after thousands of updates ends the turn after all of them", () =>
  provide(
    Effect.gen(function* () {
      const chunks = 3000;
      const agy = yield* fakeAgy(longHandoff(chunks));
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      const inbounds = yield* untilCompleted(agy.connection);
      const text = Array.from({ length: chunks }, (_, index) => `w${index} `).join("");

      const messageChunks = inbounds.filter((inbound) =>
        JSON.stringify(inbound.raw).includes("agent_message_chunk"),
      );
      expect(messageChunks).toHaveLength(chunks);
      expect(inbounds.at(-1)?.events).toEqual([
        { _tag: "AgentMessage", turn: "t1", text, phase: "final_answer" },
        { _tag: "TokenUsage", turn: "t1", totals: usageTotals },
        { _tag: "TurnCompleted", turn: "t1", status: "completed", failure: null, handoff: text },
      ]);
    }),
  ),
);

it.effect("prompts agy answers at once still end their turns, fifty in a row", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({
        rules: [
          {
            method: "session/prompt",
            repeat: true,
            respond: { result: { stopReason: "end_turn" } },
          },
        ],
      });
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      const completed: ProviderEvent[] = [];
      for (let turn = 1; turn <= 50; turn++) {
        yield* agy.connection.startTurn(session, { ...turnOne(agy.worktree), turn });
        completed.push(...eventsOf(yield* untilCompleted(agy.connection)).slice(-1));
      }

      expect(completed).toEqual(
        Array.from({ length: 50 }, (_, index) => ({
          _tag: "TurnCompleted",
          turn: `t${index + 1}`,
          status: "completed",
          failure: null,
          handoff: null,
        })),
      );
    }),
  ),
);

it.effect("a write run refuses an edit when agy offers no one-time allow", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(allowAlwaysOnly());
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      const events = eventsOf(yield* untilCompleted(agy.connection));

      expect(events).toContainEqual({
        _tag: "Permission",
        turn: "t1",
        kind: "edit",
        title: "File result.txt",
        decision: "rejected",
      });
      expect(events.at(-1)).toMatchObject({
        _tag: "TurnCompleted",
        status: "failed",
        failure: {
          message:
            "agy offered no allow_once option for File result.txt (edit), so foreman refused it; check the agy version with foreman doctor.",
        },
      });
      const answers = (yield* agy.received).filter((line) => methodOf(line) === undefined);
      expect(answers).toEqual([
        {
          jsonrpc: "2.0",
          id: "r0",
          result: { outcome: { outcome: "selected", optionId: "deny" } },
        },
      ]);
    }),
  ),
);

it.effect("a stop reason other than end_turn fails the turn naming it", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({ rules: [prompt([message("Partial")], "max_tokens")] });
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      const events = eventsOf(yield* untilCompleted(agy.connection));
      expect(events.at(-1)).toEqual({
        _tag: "TurnCompleted",
        turn: "t1",
        status: "failed",
        failure: { message: "agy stopped the turn: max_tokens", codexErrorInfo: null },
        handoff: "Partial",
      });
    }),
  ),
);

it.effect("a prompt agy refuses fails the turn with its message", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({
        rules: [
          {
            method: "session/prompt",
            respond: { error: { code: -32603, message: "quota exceeded" } },
          },
        ],
      });
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      const events = eventsOf(yield* untilCompleted(agy.connection));
      expect(events.at(-1)).toEqual({
        _tag: "TurnCompleted",
        turn: "t1",
        status: "failed",
        failure: { message: "agy refused the turn: quota exceeded", codexErrorInfo: null },
        handoff: null,
      });
    }),
  ),
);

it.effect("interrupt cancels the session and the turn ends interrupted", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(cancellableTurn());
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      yield* agy.connection.inbound.pipe(
        Stream.takeUntil((inbound) => inbound.events.some((event) => event._tag === "ItemStarted")),
        Stream.runDrain,
      );
      yield* agy.connection.interrupt(session, "t1");
      const events = eventsOf(yield* untilCompleted(agy.connection));

      expect(events.at(-1)).toEqual({
        _tag: "TurnCompleted",
        turn: "t1",
        status: "interrupted",
        failure: null,
        handoff: null,
      });
      expect((yield* agy.received).map(methodOf)).toContainEqual("session/cancel");
    }),
  ),
);

it.effect(
  "an interrupt agy never answers ends the turn interrupted after 30 seconds, and a followup still ends",
  () =>
    provide(
      Effect.gen(function* () {
        const agy = yield* fakeAgy({
          rules: [
            { method: "session/prompt", respond: "none" },
            prompt([message("Follow-up done.")]),
          ],
        });
        const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
        yield* agy.connection.startTurn(session, turnOne(agy.worktree));
        const interrupt = yield* agy.connection.interrupt(session, "t1").pipe(Effect.forkChild);
        while (!(yield* agy.received).map(methodOf).includes("session/cancel"))
          yield* Effect.yieldNow;
        yield* TestClock.adjust("30 seconds");

        // Abandoning the prompt is definite, so the interrupt succeeds and the turn ends.
        yield* Fiber.join(interrupt);
        expect(eventsOf(yield* untilCompleted(agy.connection)).at(-1)).toEqual({
          _tag: "TurnCompleted",
          turn: "t1",
          status: "interrupted",
          failure: {
            message: "agy did not confirm the cancel within 30 seconds; its prompt was abandoned",
            codexErrorInfo: null,
          },
          handoff: null,
        });

        yield* agy.connection.startTurn(session, {
          ...turnOne(agy.worktree),
          turn: 2,
          kind: "followup",
        });
        const events = eventsOf(yield* untilCompleted(agy.connection));
        expect(events.at(-1)).toEqual({
          _tag: "TurnCompleted",
          turn: "t2",
          status: "completed",
          failure: null,
          handoff: "Follow-up done.",
        });
      }),
    ),
);

it.effect("an update with no prompt outstanding carries no events", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({
        rules: [
          {
            method: "session/new",
            respond: { result: { sessionId: "{{session}}" } },
            steps: [message("stray")],
          },
        ],
      });
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      const stray = yield* agy.connection.inbound.pipe(Stream.runHead);

      expect(stray).toEqual(
        expect.objectContaining({
          value: {
            session,
            method: "session/update",
            raw: expect.objectContaining({ method: "session/update" }),
            events: [],
          },
        }),
      );
    }),
  ),
);

it.effect("agy's fs and terminal requests get method not found", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({
        rules: [
          prompt([
            {
              request: "fs/read_text_file",
              label: "read",
              params: { sessionId: "{{session}}", path: "/etc/hosts" },
            },
            { awaitResponse: "read" },
          ]),
        ],
      });
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      const inbounds = yield* untilCompleted(agy.connection);

      expect(inbounds.filter((inbound) => inbound.method === "fs/read_text_file")).toEqual([
        {
          session,
          method: "fs/read_text_file",
          raw: expect.objectContaining({ id: "r0", method: "fs/read_text_file" }),
          events: [],
        },
      ]);
      expect((yield* agy.received).filter((line) => methodOf(line) === undefined)).toEqual([
        { jsonrpc: "2.0", id: "r0", error: { code: -32601, message: "unsupported method" } },
      ]);
    }),
  ),
);

it.effect("a child that exits ends the connection with agy's wording", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({ rules: [prompt([{ exit: 3 }])] });
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      const cause = yield* agy.connection.termination;

      expect(Cause.squash(cause)).toEqual(new AgyUnavailable({ detail: "agy exited with code 3" }));
    }),
  ),
);

it.effect("a missing agy binary fails with the install hint", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* fakeAgy(writeTurn(), { agyBin: "/nonexistent/agy" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(AgyUnavailable);
      expect(error).toMatchObject({
        detail: expect.stringMatching(
          /^could not launch agy \(.*\/nonexistent\/agy.*\)\. Install agy or set AGY_BIN, then run foreman doctor\.$/,
        ),
      });
    }),
  ),
);
