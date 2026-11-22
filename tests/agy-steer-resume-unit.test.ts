// Steering and resuming on the agy connection, against the fake ACP agent: when a steer is
// accepted or refused, how a steered turn ends and sums its usage, and the requests a resume
// sends. The turn bookkeeping rules behind them are checked as pure functions where the fake
// can't reach a case (a refusal or failure recorded by an earlier prompt).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Schema, type Scope, Stream } from "effect";
import { AgyUnavailable } from "../src/errors";
import { connectAgy } from "../src/providers/agy/connection";
import { SIGNED_OUT } from "../src/providers/agy/launch";
import {
  acceptsSteer,
  appendMessage,
  beginSteer,
  beginTurn,
  finishPrompt,
  openedSession,
  type PromptOutcome,
  recordRefusal,
  startToolCall,
} from "../src/providers/agy/turns";
import {
  type Inbound,
  type ProviderEvent,
  SteerRefused,
  type TurnRequest,
} from "../src/providers/contract";
import {
  type AcpScenario,
  AcpScenario as AcpScenarioSchema,
} from "./fixtures/fake-acp-agent/scenario";
import {
  command,
  message,
  prompt,
  steerRacesReply,
  writeTurn,
} from "./fixtures/fake-acp-agent/scenarios";

const fake = fileURLToPath(new URL("./fixtures/fake-acp-agent/main.mjs", import.meta.url));
/** The fake's usage on every prompt reply, as foreman's token totals. */
const oneReply = { input: 1200, cachedInput: 200, output: 50, reasoningOutput: 10 };
const FINISHED = new SteerRefused({ reason: "the agy turn already finished" });

/** Connects to the fake agent playing `scenario`, in a temp home with a temp worktree. */
const fakeAgy = Effect.fnUntraced(function* (scenario: AcpScenario) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-steer-" });
  const worktree = join(root, "work");
  yield* fs.makeDirectory(worktree);
  const scenarioFile = join(root, "scenario.json");
  yield* fs.writeFileString(
    scenarioFile,
    Schema.encodeSync(Schema.fromJsonString(AcpScenarioSchema))(scenario),
  );
  const log = join(root, "received.jsonl");
  const { connection } = yield* connectAgy({
    agyBin: fake,
    home: join(root, "home"),
    env: { PATH: dirname(process.execPath), FAKE_ACP_SCENARIO: scenarioFile, FAKE_ACP_LOG: log },
    version: "test-version",
    executable: ["/opt/foreman/bin/foreman"],
    stderr: () => Effect.void,
  });
  const received = fs.readFileString(log).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .map((line): { method?: string; params?: unknown } => JSON.parse(line)),
    ),
  );
  return { connection, root, worktree, received };
});

const settings = (cwd: string) => ({
  cwd,
  model: "gemini-4-neon",
  effort: "low",
  tier: null,
  access: "write" as const,
});

const turnOne = (cwd: string): TurnRequest => ({
  turn: 1,
  kind: "start",
  input: "List the files.",
  settings: settings(cwd),
});

const provide = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const eventsOf = (inbounds: readonly Inbound[]): ProviderEvent[] =>
  inbounds.flatMap((inbound) => inbound.events).filter((event) => event._tag !== "Activity");

const ofTag = (events: readonly ProviderEvent[], tag: ProviderEvent["_tag"]) =>
  events.filter((event) => event._tag === tag);

it.effect("a steer joins the running turn, which ends on the steer's reply with summed usage", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({
        rules: [
          prompt([...command("ls", "a.txt\n"), { awaitRequest: "session/prompt" }]),
          prompt([message("Applied the steer.")]),
        ],
      });
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      const lsStarted = yield* Deferred.make<void>();
      const collected = yield* agy.connection.inbound.pipe(
        Stream.tap((inbound) =>
          inbound.events.some((event) => event._tag === "ItemStarted")
            ? Deferred.succeed(lsStarted, undefined)
            : Effect.void,
        ),
        Stream.takeUntil((inbound) => inbound.events.some((e) => e._tag === "TurnCompleted")),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const turn = yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      yield* Deferred.await(lsStarted);
      yield* agy.connection.steer(session, turn, "Also check the log.");
      const events = eventsOf(yield* Fiber.join(collected));

      expect(ofTag(events, "TurnCompleted")).toEqual([
        expect.objectContaining({ turn: "t1", status: "completed", failure: null }),
      ]);
      expect(ofTag(events, "TokenUsage")).toEqual([
        {
          _tag: "TokenUsage",
          turn: "t1",
          totals: {
            input: 2 * oneReply.input,
            cachedInput: 2 * oneReply.cachedInput,
            output: 2 * oneReply.output,
            reasoningOutput: 2 * oneReply.reasoningOutput,
          },
        },
      ]);
      expect(events.at(-1)).toMatchObject({ handoff: "Applied the steer." });
      const prompts = (yield* agy.received).filter((line) => line.method === "session/prompt");
      expect(prompts.map((line) => line.params)).toEqual([
        { sessionId: session, prompt: [{ type: "text", text: "List the files." }] },
        { sessionId: session, prompt: [{ type: "text", text: "Also check the log." }] },
      ]);
    }),
  ),
);

it.effect("a steer sent as the first prompt replies still ends the turn once, on its reply", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(steerRacesReply());
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      const turn = yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      // Nothing has read inbound yet: the first reply may already be on its way.
      yield* agy.connection.steer(session, turn, "And the second part.");
      const inbounds = yield* agy.connection.inbound.pipe(
        Stream.takeUntil((inbound) => inbound.events.some((e) => e._tag === "TurnCompleted")),
        Stream.runCollect,
      );
      const events = eventsOf(inbounds);

      expect(ofTag(events, "TurnCompleted")).toEqual([
        {
          _tag: "TurnCompleted",
          turn: "t1",
          status: "completed",
          failure: null,
          handoff: "First answer.\n\nSecond answer.",
        },
      ]);
      expect(ofTag(events, "TokenUsage")).toEqual([
        expect.objectContaining({
          totals: expect.objectContaining({ output: 2 * oneReply.output }),
        }),
      ]);
      const prompts = (yield* agy.received).filter((line) => line.method === "session/prompt");
      expect(prompts).toHaveLength(2);
    }),
  ),
);

it.effect("refuses a steer once the turn's completion is queued, sending nothing to agy", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({ rules: [prompt([message("Done.")])] });
      const { session } = yield* agy.connection.open("unit", settings(agy.worktree));
      const turn = yield* agy.connection.startTurn(session, turnOne(agy.worktree));
      // The completion has been handed to the supervisor, which hasn't applied it yet.
      yield* agy.connection.inbound.pipe(
        Stream.takeUntil((inbound) => inbound.events.some((e) => e._tag === "TurnCompleted")),
        Stream.runDrain,
      );
      const error = yield* agy.connection.steer(session, turn, "Too late.").pipe(Effect.flip);

      expect(error).toEqual(FINISHED);
      const prompts = (yield* agy.received).filter((line) => line.method === "session/prompt");
      expect(prompts).toHaveLength(1);
    }),
  ),
);

it.effect("refuses a steer for a session this connection hasn't loaded", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(writeTurn());
      const error = yield* agy.connection.steer("unknown", "t1", "Hello.").pipe(Effect.flip);
      expect(error).toEqual(FINISHED);
    }),
  ),
);

const replied: PromptOutcome = { _tag: "Replied", stopReason: "end_turn", usage: oneReply };
const request = turnOne("/work");

it.each([
  { case: "a prompt is outstanding for the turn", outstanding: true, turn: "t1", accepts: true },
  { case: "the steer names another turn", outstanding: true, turn: "t2", accepts: false },
  { case: "the last reply was applied", outstanding: false, turn: "t1", accepts: false },
])("acceptsSteer when $case: $accepts", ({ outstanding, turn, accepts }) => {
  const started = beginTurn(openedSession("write"), request);
  const state = outstanding ? started : finishPrompt(started, replied).state;
  expect(acceptsSteer(state, turn)).toBe(accepts);
});

it.each([
  {
    case: "a refused permission before the steer",
    first: replied,
    record: (state: ReturnType<typeof openedSession>) => recordRefusal(state, "refused edit"),
    failure: "refused edit",
  },
  {
    case: "an error reply to the earlier prompt",
    first: { _tag: "Failed", message: "agy refused the turn: quota" } as PromptOutcome,
    record: (state: ReturnType<typeof openedSession>) => state,
    failure: "agy refused the turn: quota",
  },
])("a steered turn still fails after $case", ({ first, record, failure }) => {
  const steered = beginSteer(record(beginTurn(openedSession("write"), request)));
  const merged = finishPrompt(steered, first);
  expect(merged.events).toEqual([]);
  const ended = finishPrompt(merged.state, replied);
  expect(ended.events.at(-1)).toMatchObject({
    _tag: "TurnCompleted",
    status: "failed",
    failure: { message: failure },
  });
});

it.each([
  {
    case: "text before the merged reply",
    before: "First answer.",
    handoff: "First answer.\n\nSecond.",
  },
  { case: "no text before the merged reply", before: "", handoff: "Second." },
])("the steer's answer after $case", ({ before, handoff }) => {
  const steered = beginSteer(appendMessage(beginTurn(openedSession("write"), request), before));
  const merged = finishPrompt(steered, replied).state;
  const ended = finishPrompt(appendMessage(merged, "Second."), replied);
  expect(ended.events.at(-1)).toMatchObject({ _tag: "TurnCompleted", handoff });
});

it("sets the steer's answer apart in the text since the last tool call too", () => {
  const ran = appendMessage(beginTurn(openedSession("write"), request), "Running ls.");
  const said = appendMessage(startToolCall(ran).state, "Listing done.");
  const merged = finishPrompt(beginSteer(said), replied).state;
  const ended = finishPrompt(appendMessage(merged, "Second."), replied);
  expect(ended.events.at(-1)).toMatchObject({ handoff: "Listing done.\n\nSecond." });
});

it.effect("resumes a session with the bridge, then the model and mode, and loads it", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(writeTurn());
      expect(agy.connection.isLoaded("sess-1")).toBe(false);
      const resumed = yield* agy.connection.resume("unit", "sess-1", {
        ...settings(agy.worktree),
        model: "claude-opus-5-5",
        effort: "none",
      });

      expect(resumed).toEqual({ sandbox: "default", model: "claude-opus-5-5" });
      expect(agy.connection.isLoaded("sess-1")).toBe(true);
      const sent = (yield* agy.received).filter((line) => line.method !== "initialize");
      expect(sent).toEqual([
        expect.objectContaining({
          method: "session/resume",
          params: {
            sessionId: "sess-1",
            cwd: agy.worktree,
            mcpServers: [
              {
                name: "foreman",
                command: "/opt/foreman/bin/foreman",
                args: ["mcp-question", "--run", "unit"],
                env: [{ name: "FOREMAN_HOME", value: `${agy.root}/home` }],
              },
            ],
          },
        }),
        expect.objectContaining({
          method: "session/set_config_option",
          params: { sessionId: "sess-1", configId: "model", value: "claude-opus-5-5" },
        }),
        expect.objectContaining({
          method: "session/set_mode",
          params: { sessionId: "sess-1", modeId: "default" },
        }),
      ]);
    }),
  ),
);

it.effect("reports a session agy can't resume with the run and a next step", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({
        rules: [
          {
            method: "session/resume",
            respond: { error: { code: -32002, message: "session not found" } },
          },
        ],
      });
      const error = yield* agy.connection
        .resume("unit", "sess-1", settings(agy.worktree))
        .pipe(Effect.flip);

      expect(error).toEqual(
        new AgyUnavailable({
          detail:
            "agy could not resume session sess-1 for run unit (session not found); start a new run with foreman start, or run foreman doctor if this keeps happening.",
        }),
      );
      expect(agy.connection.isLoaded("sess-1")).toBe(false);
    }),
  ),
);

it.effect("reports a signed-out agy when session/resume is refused for authentication", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy({
        rules: [
          {
            method: "session/resume",
            respond: { error: { code: -32000, message: "auth_required: sign in first" } },
          },
        ],
      });
      const error = yield* agy.connection
        .resume("unit", "sess-1", settings(agy.worktree))
        .pipe(Effect.flip);

      expect(error).toEqual(new AgyUnavailable({ detail: SIGNED_OUT }));
      expect(agy.connection.isLoaded("sess-1")).toBe(false);
      const methods = (yield* agy.received).map((line) => line.method);
      expect(methods).toEqual(["initialize", "session/resume"]);
    }),
  ),
);
