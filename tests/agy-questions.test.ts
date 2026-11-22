// Questions on agy (RFC 0002 "Questions on agy"): the agy connection holding bridge calls
// against the fake ACP agent; the supervisor's handling of an abandoned call when it races an
// answer or overtakes its QuestionCall; and agy's question timeout cap through the real
// daemon. The daemon tests send the `Ask` request the `foreman mcp-question` bridge sends.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { ChildProcess } from "effect/process";
import { AppConfig } from "../src/config";
import { commandResult } from "../src/core/process";
import * as Store from "../src/core/runs/store";
import { AgyUnavailable, RunConflict } from "../src/errors";
import { connectAgy } from "../src/providers/agy/connection";
import { type HeldOutcome, questionCall } from "../src/providers/agy/questions";
import {
  type Inbound,
  type ProviderConnection,
  QuestionCallEnded,
  QuestionCancelled,
  QuestionRefused,
} from "../src/providers/contract";
import { QuestionId, RunRecord } from "../src/schemas/daemon";
import { Host } from "../src/services/host";
import { makeConnections } from "../src/supervisor/connections";
import { handleNotification } from "../src/supervisor/notifications";
import { deferral } from "../src/supervisor/prompts";
import { makeQuestions, questionTimeout } from "../src/supervisor/questions";
import { makeRegistry } from "../src/supervisor/registry";
import { makeTurns } from "../src/supervisor/turns";
import {
  type AcpScenario,
  AcpScenario as AcpScenarioSchema,
} from "./fixtures/fake-acp-agent/scenario";
import { type Gate, prompt } from "./fixtures/fake-acp-agent/scenarios";
import { agyFixture, agyPlatform } from "./helpers/agy";

const fake = fileURLToPath(new URL("./fixtures/fake-acp-agent/main.mjs", import.meta.url));
const EXECUTABLE = ["/opt/foreman/bin/foreman", "--quiet"];
const QUESTION = "Should I use option A or option B?";
const q1 = Schema.decodeUnknownSync(QuestionId)("q1");

/** A turn that stays outstanding until foreman cancels it, then replies `cancelled`. */
const heldTurn: AcpScenario = {
  rules: [prompt([{ awaitRequest: "session/cancel" }], "cancelled")],
};

/** A turn that replies at once. */
const quickTurn: AcpScenario = { rules: [prompt([])] };

/** Connects to the fake agent playing `scenario` and opens a session for run `unit`. */
const fakeAgy = Effect.fnUntraced(function* (
  scenario: AcpScenario,
  executable: readonly string[] = EXECUTABLE,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-agyq-" });
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
    executable,
    stderr: () => Effect.void,
  });
  const settings = { cwd: root, model: "gemini-4-neon", effort: "low", tier: null };
  const { session } = yield* connection.open("unit", { ...settings, access: "write" });
  const startTurn = connection.startTurn(session, {
    turn: 1,
    kind: "start",
    input: "Create result.txt.",
    settings: { ...settings, access: "write" },
  });
  const received = fs.readFileString(log).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line)),
    ),
  );
  return { connection, session, startTurn, root, received };
});

const ask = (connection: ProviderConnection, session: string, callId = "call-1") =>
  connection.ask(session, {
    question: QUESTION,
    kind: "question",
    callId,
    raw: { callId },
  });

/** The next question call the connection hands the supervisor. */
const nextCall = (connection: ProviderConnection) =>
  connection.questions.pipe(
    Stream.runHead,
    Effect.flatMap((head) =>
      head._tag === "Some" ? Effect.succeed(head.value) : Effect.die("questions ended"),
    ),
  );

const completes = (inbound: Inbound) =>
  inbound.events.some((event) => event._tag === "TurnCompleted");

const provide = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("passes the question bridge for the run in session/new", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(quickTurn);
      const sessionNew = (yield* agy.received).find(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          message.method === "session/new",
      );
      expect(sessionNew).toMatchObject({
        params: {
          cwd: agy.root,
          mcpServers: [
            {
              name: "foreman",
              command: "/opt/foreman/bin/foreman",
              args: ["--quiet", "mcp-question", "--run", "unit"],
              env: [{ name: "FOREMAN_HOME", value: join(agy.root, "home") }],
            },
          ],
        },
      });
    }),
  ),
);

it.effect("refuses to connect when foreman has no executable path for the bridge", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* fakeAgy(quickTurn, []).pipe(Effect.flip);
      expect(error).toEqual(
        new AgyUnavailable({
          detail:
            "foreman doesn't know its own executable path, so agy can't launch the question bridge; reinstall foreman and retry.",
        }),
      );
    }),
  ),
);

it.effect("refuses an ask before the first turn and after the turn ended", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(quickTurn);
      const refused = new QuestionRefused({ reason: "turn is no longer active" });
      expect(yield* ask(agy.connection, agy.session).pipe(Effect.flip)).toEqual(refused);
      yield* agy.startTurn;
      yield* agy.connection.inbound.pipe(Stream.takeUntil(completes), Stream.runDrain);
      expect(yield* ask(agy.connection, agy.session).pipe(Effect.flip)).toEqual(refused);
    }),
  ),
);

it.effect("hands the supervisor a call stamped with the turn and returns its answer", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(heldTurn);
      yield* agy.startTurn;
      const asking = yield* ask(agy.connection, agy.session).pipe(Effect.forkScoped);
      const call = yield* nextCall(agy.connection);
      expect(call).toMatchObject({
        session: agy.session,
        turn: "t1",
        callId: "call-1",
        question: QUESTION,
        kind: "question",
        raw: { callId: "call-1" },
      });
      yield* call.respond("Use B.");
      expect(yield* Fiber.join(asking)).toBe("Use B.");
    }),
  ),
);

for (const { outcome, expected } of [
  {
    outcome: "reject",
    expected: new QuestionRefused({ reason: "turn is no longer active" }),
  },
  { outcome: "cancel", expected: new QuestionCancelled() },
] as const)
  it.effect(`fails the ask when the supervisor's call is ${outcome}ed`, () =>
    provide(
      Effect.gen(function* () {
        const agy = yield* fakeAgy(heldTurn);
        yield* agy.startTurn;
        const asking = yield* ask(agy.connection, agy.session).pipe(Effect.forkScoped);
        const call = yield* nextCall(agy.connection);
        yield* outcome === "reject" ? call.reject("turn is no longer active") : call.cancel;
        expect(yield* Fiber.join(asking).pipe(Effect.flip)).toEqual(expected);
      }),
    ),
  );

it.effect("refuses a second ask with a callId that is still held", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(heldTurn);
      yield* agy.startTurn;
      yield* ask(agy.connection, agy.session).pipe(Effect.forkScoped);
      yield* nextCall(agy.connection);
      expect(yield* ask(agy.connection, agy.session).pipe(Effect.flip)).toEqual(
        new QuestionRefused({
          reason:
            "question call-1 is already waiting for an answer; wait for it instead of asking again.",
        }),
      );
    }),
  ),
);

it.effect("reports an ask whose waiter went away as abandoned, once", () =>
  provide(
    Effect.gen(function* () {
      const agy = yield* fakeAgy(heldTurn);
      yield* agy.startTurn;
      const asking = yield* ask(agy.connection, agy.session).pipe(Effect.forkScoped);
      const call = yield* nextCall(agy.connection);
      yield* Fiber.interrupt(asking);
      expect(Exit.hasInterrupts(yield* Fiber.await(asking))).toBe(true);
      // The supervisor answering afterwards reaches nobody, says so, and reports nothing more.
      expect(yield* call.respond("Use B.").pipe(Effect.flip)).toEqual(
        new QuestionCallEnded({ callId: "call-1" }),
      );
      expect(yield* call.reject("turn is no longer active").pipe(Effect.flip)).toEqual(
        new QuestionCallEnded({ callId: "call-1" }),
      );
      yield* agy.connection.interrupt(agy.session, "t1");
      const inbound = yield* agy.connection.inbound.pipe(
        Stream.takeUntil(completes),
        Stream.runCollect,
      );
      const abandoned = inbound.filter((message) =>
        message.events.some((event) => event._tag === "QuestionAbandoned"),
      );
      expect(abandoned).toEqual([
        {
          session: agy.session,
          method: "mcp_foreman_ask_orchestrator",
          raw: null,
          events: [{ _tag: "QuestionAbandoned", turn: "t1", callId: "call-1" }],
        },
      ]);
    }),
  ),
);

const CAP_WARNING = "agy holds a question for at most 180 seconds; deferring after 100 seconds.";

it("caps agy's question timeout below its MCP hold, warning only for an explicit request", () => {
  expect(questionTimeout("agy", 900_000, 900_000)).toEqual({
    timeoutMs: 100_000,
    warning: CAP_WARNING,
  });
  expect(questionTimeout("agy", undefined, 900_000)).toEqual({
    timeoutMs: 100_000,
    warning: null,
  });
  expect(questionTimeout("agy", 100_000, 900_000)).toEqual({ timeoutMs: 100_000, warning: null });
  expect(questionTimeout("agy", undefined, 30_000)).toEqual({ timeoutMs: 30_000, warning: null });
  expect(questionTimeout("codex", 900_000, 900_000)).toEqual({
    timeoutMs: 900_000,
    warning: null,
  });
});

const baseRecord = Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord))(
  readFileSync(new URL("./fixtures/runs/run.json", import.meta.url), "utf8"),
);

// agy's child process is the third party here; these cases never call it.
const unusedConnection: ProviderConnection = {
  provider: "agy",
  generation: Symbol("agy"),
  inbound: Stream.empty,
  questions: Stream.empty,
  termination: Effect.never,
  open: () => Effect.die("unused"),
  nameSession: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  isLoaded: () => true,
  startTurn: () => Effect.die("unused"),
  steer: () => Effect.die("unused"),
  interrupt: () => Effect.die("unused"),
  ask: () => Effect.die("unused"),
  hookTrust: () => Effect.die("unused"),
};

const supervisorServices = Layer.mergeAll(
  NodeServices.layer,
  Host.layer({
    name: "foreman",
    version: "test",
    build: "test",
    platform: "node",
    compiled: false,
    executable: [process.execPath],
    pid: process.pid,
  }),
);

/**
 * An agy run in turn t1 with the supervisor's question operations, and the bridge call the agy
 * connection would hand them. The run loads idle (an active run would be recovered as lost)
 * and is then moved into its turn.
 */
const supervisedRun = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  const worktree = join(home, "worktree");
  yield* fs.makeDirectory(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  const record: RunRecord = {
    ...baseRecord,
    provider: "agy",
    worktree,
    state: "idle",
    activeTurnId: null,
  };
  yield* Store.createRun(home, record, "contract");
  const config = yield* AppConfig.pipe(
    Effect.provide(AppConfig.layer({ HOME: home, FOREMAN_HOME: home })),
  );
  const registry = yield* makeRegistry(home);
  const connections = yield* makeConnections(
    config,
    "test",
    registry,
    () => Effect.void,
    () => Effect.void,
  );
  const turns = yield* makeTurns(registry, connections, config);
  const questions = yield* makeQuestions(registry);
  const run = yield* registry.lookup(record.name);
  yield* registry.save(run, { activeTurnId: "t1" });
  yield* registry.state(run, "running");
  const outcome: HeldOutcome = yield* Deferred.make<string, QuestionRefused | QuestionCancelled>();
  const question = { question: QUESTION, kind: "question" as const, callId: "c1", raw: null };
  const call = questionCall(record.threadId ?? "thread-a", "t1", question, outcome);
  const generation = unusedConnection.generation;
  const abandoned: Inbound = {
    session: call.session,
    method: "mcp_foreman_ask_orchestrator",
    raw: null,
    events: [{ _tag: "QuestionAbandoned", turn: "t1", callId: "c1" }],
  };
  /** What the agy connection does when the bridge's socket closes: settle, then report. */
  const bridgeLeaves = Deferred.fail(outcome, new QuestionCancelled());
  const applyAbandoned = handleNotification(
    registry,
    turns,
    run,
    unusedConnection,
    { hookEvents: false, displayName: "agy", hookBypassMessage: () => "unused" },
    abandoned,
  );
  const journal = Store.readEvents(run.dir).pipe(
    Effect.map((page) => page.events.map((entry) => entry.event)),
  );
  const questionLines = Store.readQuestions(run.dir);
  return {
    run,
    call,
    generation,
    questions,
    bridgeLeaves,
    applyAbandoned,
    journal,
    questionLines,
  };
});

const questionEvents = (events: readonly { readonly _tag: string }[]) =>
  events.filter((event) => event._tag.startsWith("Question"));

it.effect(
  "an answer that reaches an abandoned call first cancels the question and asks for a late answer",
  () =>
    Effect.gen(function* () {
      const s = yield* supervisedRun();
      yield* s.questions.receive(s.run, s.generation, s.call);
      expect(s.run.record.state).toBe("waiting");
      yield* s.bridgeLeaves;
      const error = yield* s.questions
        .resolve(s.run, s.generation, q1, "Use B.", "answered")
        .pipe(Effect.flip);
      expect(error).toEqual(
        new RunConflict({
          detail: `q1 in run ${s.run.record.name} was cancelled: the agent's tool call ended before the answer arrived, so nothing was delivered. Run foreman answer ${s.run.record.name} q1 "<answer>" again to send it as a late answer.`,
        }),
      );
      // The QuestionAbandoned message arriving afterwards changes nothing more.
      yield* s.applyAbandoned;
      expect(s.run.record.state).toBe("running");
      expect(s.run.calls.size).toBe(0);
      expect(questionEvents(yield* s.journal)).toEqual([
        { _tag: "QuestionAsked", id: "q1", kind: "question", question: QUESTION },
        { _tag: "QuestionResolved", id: "q1", resolution: "cancelled" },
      ]);
      expect((yield* s.questionLines).map((line) => line._tag)).toEqual(["Asked", "Resolved"]);
      expect((yield* s.questionLines)[1]).toMatchObject({ resolution: "cancelled", text: null });
    }).pipe(Effect.scoped, Effect.provide(supervisorServices)),
);

it.effect("a timeout deferral that reaches an abandoned call records only the cancellation", () =>
  Effect.gen(function* () {
    const s = yield* supervisedRun();
    yield* s.questions.receive(s.run, s.generation, s.call);
    yield* s.bridgeLeaves;
    yield* s.questions.resolve(s.run, s.generation, q1, deferral, "deferred", "timeout");
    expect(s.run.record.state).toBe("running");
    expect(questionEvents(yield* s.journal)).toEqual([
      { _tag: "QuestionAsked", id: "q1", kind: "question", question: QUESTION },
      { _tag: "QuestionResolved", id: "q1", resolution: "cancelled" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(supervisorServices)),
);

it.effect("a QuestionAbandoned that overtakes its call keeps the run off a dead question", () =>
  Effect.gen(function* () {
    const s = yield* supervisedRun();
    yield* s.bridgeLeaves;
    yield* s.applyAbandoned;
    yield* s.questions.receive(s.run, s.generation, s.call);
    expect(s.run.record.state).toBe("running");
    expect(s.run.calls.size).toBe(0);
    expect(questionEvents(yield* s.journal)).toEqual([]);
    expect(yield* s.questionLines).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(supervisorServices)),
);

/** A gate whose release is a FIFO, so the fake blocks until the test opens it. */
const makeGate = Effect.fnUntraced(function* (directory: string, label: string) {
  const gate: Gate = {
    ready: `${directory}/${label}-ready`,
    release: `${directory}/${label}-release`,
  };
  const made = yield* commandResult(ChildProcess.make("mkfifo", [gate.release]));
  if (made.code !== 0) return yield* Effect.die(`mkfifo failed: ${made.stderr}`);
  return gate;
});

it.live(
  "an abandoned question is cancelled, the run resumes and a later answer is late",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const gates = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-gate-" });
      const resume = yield* makeGate(gates, "resume");
      const f = yield* agyFixture({
        rules: [prompt([{ gate: resume }]), prompt([], "end_turn", true)],
      });
      yield* f.start(true);
      yield* f.until("running", 1);
      // The default 15-minute timeout is capped silently when the run starts.
      const started = yield* f.runJson;
      expect(started).toMatchObject({ questionTimeoutMs: 100_000 });
      expect(started).not.toMatchObject({ warnings: expect.arrayContaining([CAP_WARNING]) });
      const asking = yield* f
        .request({ _tag: "Ask", name: f.name, question: QUESTION, kind: "question", callId: "c1" })
        .pipe(Effect.forkScoped);
      const waiting = yield* f.until("waiting");
      expect(waiting.questions).toEqual([
        { id: "q1", kind: "question", question: QUESTION, pendingMs: expect.any(Number) },
      ]);
      // The bridge's socket closing interrupts the daemon's Ask, as a killed bridge does.
      yield* Fiber.interrupt(asking);
      const running = yield* f.until("running");
      expect(running.questions).toEqual([]);
      expect(yield* f.events).toContainEqual({
        _tag: "QuestionResolved",
        id: "q1",
        resolution: "cancelled",
      });
      const answer = yield* f
        .request({ _tag: "Answer", name: f.name, question: q1, text: "Use B." })
        .pipe(Effect.forkScoped);
      yield* fs.writeFileString(resume.release, "go");
      expect(yield* Fiber.join(answer)).toMatchObject({
        _tag: "Accepted",
        delivery: expect.stringMatching(/^(steer|followup)$/),
      });
      yield* f.until("idle", 2);
      expect(yield* f.events).toContainEqual(
        expect.objectContaining({ _tag: "QuestionResolved", id: "q1", resolution: "late" }),
      );
    }).pipe(Effect.provide(agyPlatform)),
  30_000,
);

it.live(
  "an explicit question timeout above agy's cap is capped at start with a warning",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(quickTurn);
      yield* f.start(true, { questionTimeoutMs: 900_000 });
      yield* f.until("idle", 1);
      expect(yield* f.runJson).toMatchObject({
        questionTimeoutMs: 100_000,
        warnings: expect.arrayContaining([CAP_WARNING]),
      });
    }).pipe(Effect.provide(agyPlatform)),
  30_000,
);
