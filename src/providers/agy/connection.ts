/**
 * The agy `ProviderConnection`: one `agy acp` child speaking the Agent Client Protocol over a
 * JSON-RPC channel, with sessions, turns, permission answers and decoded updates.
 *
 * Owns each session's turn state (turns.ts) and tool calls (events.ts), the prompt fibers that
 * end turns, and the inbound queue the supervisor reads. Questions, steering and resume arrive
 * in later phases. docs/rfcs/0002-providers.md "The agy adapter" is the design.
 */
import {
  type Cause,
  Deferred,
  type Duration,
  Effect,
  FileSystem,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { AgyUnavailable } from "../../errors";
import * as Acp from "../../schemas/acp";
import {
  type Inbound,
  type ProviderConnection,
  QuestionRefused,
  type SessionId,
  type SessionSettings,
  SteerRefused,
  type TurnRequest,
} from "../contract";
import {
  type Channel,
  type ChannelEnd,
  openChannel,
  type RpcError,
  RpcRequestTimeout,
  type RpcServerRequest,
} from "../jsonrpc";
import { type AgySessionState, readNotification } from "./events";
import { agyHookTrust } from "./hooks";
import { decidePermission, pickOption, refusalMessage } from "./permissions";
import {
  activeTurn,
  beginTurn,
  finishPrompt,
  openedSession,
  type PromptOutcome,
  recordRefusal,
  tokensOf,
  turnIdFor,
} from "./turns";

/** The ACP version foreman speaks. */
export const ACP_PROTOCOL_VERSION = 1;

const INITIALIZE_TIMEOUT = "60 seconds";
const SESSION_NEW_TIMEOUT = "180 seconds";
const CANCEL_TIMEOUT_MS = 30_000;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const SIGNED_OUT = "agy isn't signed in. Run agy once and sign in, then run foreman doctor.";
const RESUME_UNAVAILABLE =
  "Resuming an agy session after a daemon restart isn't available yet; start a new run.";

/** Settings for one `agy acp` child. */
export interface AgyConnectionOptions {
  readonly agyBin: string;
  /** foreman's home: the ACP log and agy's empty launch directory live under it. */
  readonly home: string;
  /** The complete child environment. */
  readonly env: Readonly<Record<string, string>>;
  /** foreman's version, sent in the initialize handshake. */
  readonly version: string;
  readonly stderr: (line: string) => Effect.Effect<void>;
}

/** A live connection and the agy version its initialize reply reported. */
export interface AgyConnection {
  readonly connection: ProviderConnection;
  /** null when agy didn't report one. */
  readonly agentVersion: string | null;
}

type AgyChannel = Channel<AgyUnavailable>;

/** What every part of one live connection shares. */
interface Live {
  readonly channel: AgyChannel;
  /** Closes with the connection; prompt fibers and readers run in it. */
  readonly scope: Scope.Scope;
  /** Sessions this connection opened, with their turn state and tool calls. */
  readonly sessions: Map<SessionId, AgySessionState>;
  /** Per session, one signal per outstanding prompt, completed once its reply is handled. */
  readonly prompts: Map<SessionId, Set<Deferred.Deferred<void>>>;
  readonly inbound: Queue.Queue<Inbound, AgyUnavailable | Cause.Done>;
}

function endDetail(agyBin: string, end: ChannelEnd): string {
  if (end._tag === "Closed") return "agy connection closed";
  if (end.reason === "launch") {
    return `could not launch agy (${end.detail}). Install agy or set AGY_BIN, then run foreman doctor.`;
  }
  if (end.reason === "exit") return `agy exited with code ${end.exitCode}`;
  return `agy ${JSON.stringify(agyBin)}: ${end.detail}`;
}

const mismatchDetail = (method: string) =>
  `agy's reply to ${method} did not match the supported protocol; run foreman doctor and check the agy version.`;

const replyMismatch = (method: string) => new AgyUnavailable({ detail: mismatchDetail(method) });

const mentionsAuth = (message: string) => /auth/i.test(message);

/**
 * Sends a session request. A refusal stays an RpcError unless it is about signing in; a reply
 * that doesn't decode becomes AgyUnavailable.
 */
const sessionRequest = <A, I>(
  channel: AgyChannel,
  method: string,
  params: unknown,
  result: Schema.Codec<A, I>,
  timeout?: Duration.Input,
) =>
  channel.request(method, params, result, timeout === undefined ? {} : { timeout }).pipe(
    Effect.catchTag("SchemaError", () => Effect.fail(replyMismatch(method))),
    Effect.catchTag("RpcError", (error: RpcError) =>
      Effect.fail(mentionsAuth(error.message) ? new AgyUnavailable({ detail: SIGNED_OUT }) : error),
    ),
  );

/** Completes the handshake and returns agy's version; refuses any other protocol version. */
const initialize = Effect.fnUntraced(function* (channel: AgyChannel, version: string) {
  const reply = yield* channel
    .request(
      Acp.Method.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "foreman", version },
      },
      Acp.InitializeResult,
      { timeout: INITIALIZE_TIMEOUT },
    )
    .pipe(
      Effect.catchTag("SchemaError", () => Effect.fail(replyMismatch(Acp.Method.initialize))),
      Effect.catchTag("RpcError", (error) =>
        Effect.fail(
          new AgyUnavailable({
            detail: `agy refused initialize (${error.message}); run foreman doctor and check the agy version.`,
          }),
        ),
      ),
      Effect.catchTag("RpcRequestTimeout", (error) =>
        Effect.fail(
          new AgyUnavailable({
            detail: `agy did not answer initialize within ${error.timeoutMs} ms; run foreman doctor before retrying.`,
          }),
        ),
      ),
    );
  if (reply.protocolVersion !== ACP_PROTOCOL_VERSION) {
    return yield* new AgyUnavailable({
      detail: `agy speaks ACP protocol ${reply.protocolVersion}; foreman supports ${ACP_PROTOCOL_VERSION}. Install agy 1.5.14 or a compatible version, then run foreman doctor.`,
    });
  }
  return reply.agentInfo?.version ?? null;
});

/** The effort routing records for agy models that have no thinking levels. */
const NO_EFFORT = "none";

/**
 * agy takes model and thinking level as one id: `gemini-4-neon-low`. Models without thinking
 * levels (`claude-opus-5-5`) go as they are.
 */
export function modelValue(settings: SessionSettings): string {
  const suffix = `-${settings.effort}`;
  if (settings.effort === NO_EFFORT || settings.model.endsWith(suffix)) return settings.model;
  return `${settings.model}${suffix}`;
}

/** Reads a prompt reply into the outcome that ends the turn. */
function replyOutcome(raw: unknown): PromptOutcome {
  const decoded = Schema.decodeUnknownOption(Acp.PromptResult)(raw);
  if (decoded._tag === "None")
    return { _tag: "Failed", message: mismatchDetail(Acp.Method.prompt) };
  const { stopReason, usage } = decoded.value;
  return { _tag: "Replied", stopReason, usage: usage === undefined ? null : tokensOf(usage) };
}

const refusedTurn = (message: string): PromptOutcome => ({
  _tag: "Failed",
  message: mentionsAuth(message) ? SIGNED_OUT : `agy refused the turn: ${message}`,
});

/**
 * Starts `agy acp` and completes the handshake. The connection closes with the caller's scope.
 * @throws {AgyUnavailable} When agy can't be launched, refuses or times out on initialize,
 * speaks another ACP protocol, or its directories under foreman's home can't be created.
 */
export const connectAgy = Effect.fn("agy.connect")(function* (options: AgyConnectionOptions) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = `${options.home}/providers/agy/cwd`;
  const logs = `${options.home}/logs`;
  yield* Effect.forEach([cwd, logs], (directory) =>
    fs
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.mapError(
          (error) =>
            new AgyUnavailable({ detail: `could not create ${directory}: ${error.message}` }),
        ),
      ),
  );
  const channel = yield* openChannel({
    command: options.agyBin,
    args: ["acp", "--disable-telemetry", "--log-file", `${logs}/agy-acp.log`],
    cwd,
    env: options.env,
    stderr: options.stderr,
    unavailable: (end) => new AgyUnavailable({ detail: endDetail(options.agyBin, end) }),
  });
  const agentVersion = yield* initialize(channel, options.version);
  const connection = yield* makeConnection(channel, fs);
  return { connection, agentVersion } satisfies AgyConnection;
});

/** Wires the channel into the provider contract and starts its background readers. */
const makeConnection = Effect.fnUntraced(function* (
  channel: AgyChannel,
  fs: FileSystem.FileSystem,
) {
  const live: Live = {
    channel,
    scope: yield* Effect.scope,
    sessions: new Map(),
    prompts: new Map(),
    inbound: yield* Queue.unbounded<Inbound, AgyUnavailable | Cause.Done>(),
  };
  yield* readNotifications(live).pipe(Effect.forkIn(live.scope));
  // A failed answer means the channel ended; `termination` and `inbound` report that.
  yield* channel.serverRequests.pipe(
    Stream.runForEach((request) => answerServerRequest(live, request)),
    Effect.ignore,
    Effect.forkIn(live.scope),
  );
  const connection: ProviderConnection = {
    provider: "agy",
    generation: Symbol("agy"),
    inbound: Stream.fromQueue(live.inbound),
    questions: Stream.empty,
    termination: channel.termination,
    open: (_run, settings) => openSession(live, settings),
    nameSession: () => Effect.succeed([]),
    resume: () => Effect.fail(new AgyUnavailable({ detail: RESUME_UNAVAILABLE })),
    isLoaded: (session) => live.sessions.has(session),
    startTurn: (session, request) => startTurn(live, session, request),
    steer: () => Effect.fail(new SteerRefused({ reason: "agy steering is not available yet" })),
    interrupt: (session) => interruptSession(live, session),
    ask: () =>
      Effect.fail(
        new QuestionRefused({ reason: "agy questions arrive in a later foreman version" }),
      ),
    hookTrust: (mainCheckout, worktree) =>
      agyHookTrust(mainCheckout, worktree).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
  };
  return connection;
});

/** Decodes agy's notifications in arrival order into `inbound`, ending it with the channel. */
const readNotifications = (live: Live) =>
  live.channel.notifications.pipe(
    Stream.runForEach((message) => {
      const session = Schema.is(Acp.SessionEnvelope)(message.params)
        ? message.params.sessionId
        : null;
      const known = session === null ? undefined : live.sessions.get(session);
      const read = readNotification(message, known);
      if (session !== null && read.state !== undefined) live.sessions.set(session, read.state);
      return Queue.offer(live.inbound, read.inbound);
    }),
    Effect.matchCauseEffect({
      onFailure: (cause) => Queue.failCause(live.inbound, cause),
      onSuccess: () => Queue.end(live.inbound),
    }),
  );

/** `session/new`, then the model with its thinking level, then default mode. */
const openSession = Effect.fnUntraced(function* (live: Live, settings: SessionSettings) {
  const { sessionId } = yield* sessionRequest(
    live.channel,
    Acp.Method.sessionNew,
    { cwd: settings.cwd, mcpServers: [] },
    Acp.SessionNewResult,
    SESSION_NEW_TIMEOUT,
  );
  live.sessions.set(sessionId, { turn: openedSession(settings.access), tools: new Map() });
  const model = { sessionId, configId: "model", value: modelValue(settings) };
  yield* sessionRequest(live.channel, Acp.Method.setConfigOption, model, Schema.Unknown);
  const mode = { sessionId, modeId: "default" };
  yield* sessionRequest(live.channel, Acp.Method.setMode, mode, Schema.Unknown);
  return { session: sessionId, warnings: [] };
});

/** Reports the turn started, then sends its prompt on a fiber that ends the turn on reply. */
const startTurn = Effect.fnUntraced(function* (
  live: Live,
  session: SessionId,
  request: TurnRequest,
) {
  const state = live.sessions.get(session) ?? {
    turn: openedSession(request.settings.access),
    tools: new Map(),
  };
  const turn = turnIdFor(request.turn);
  live.sessions.set(session, { ...state, turn: beginTurn(state.turn, request) });
  yield* Queue.offer(live.inbound, {
    session,
    method: Acp.Method.prompt,
    raw: null,
    events: [{ _tag: "TurnStarted", turn }],
  });
  const handled = yield* Deferred.make<void>();
  const outstanding = live.prompts.get(session) ?? new Set();
  live.prompts.set(session, outstanding.add(handled));
  const release = Effect.sync(() => outstanding.delete(handled)).pipe(
    Effect.andThen(Deferred.succeed(handled, undefined)),
  );
  yield* sendPrompt(live, session, request.input).pipe(
    Effect.ensuring(release),
    Effect.forkIn(live.scope),
  );
  return turn;
});

/** Sends a prompt and, once it replies, completes the turn unless another is outstanding. */
const sendPrompt = (live: Live, session: SessionId, input: string) =>
  live.channel
    .request(
      Acp.Method.prompt,
      { sessionId: session, prompt: [{ type: "text", text: input }] },
      Schema.Unknown,
      { timeout: "none" },
    )
    .pipe(
      Effect.map((raw) => ({ raw, outcome: replyOutcome(raw) })),
      Effect.catchTag("RpcError", (error) =>
        Effect.succeed({
          raw: { error: { code: error.code, message: error.message } },
          outcome: refusedTurn(error.message),
        }),
      ),
      // Updates sent before the reply are already queued; let the reader apply them first.
      Effect.tap(() => Effect.yieldNow),
      Effect.flatMap(({ raw, outcome }) => finishTurn(live, session, raw, outcome)),
      // A lost channel fails the run through `termination`; there is no turn left to end.
      Effect.catchTag(["AgyUnavailable", "RpcRequestTimeout", "SchemaError"], () => Effect.void),
    );

/** Applies a prompt's reply to the session and reports the events it produces. */
function finishTurn(live: Live, session: SessionId, raw: unknown, outcome: PromptOutcome) {
  const state = live.sessions.get(session);
  if (state === undefined) return Effect.void;
  const finished = finishPrompt(state.turn, outcome);
  live.sessions.set(session, { ...state, turn: finished.state });
  const events = finished.events;
  return Queue.offer(live.inbound, { session, method: Acp.Method.prompt, raw, events });
}

/**
 * Cancels the session's turn and waits for its prompts to reply.
 * @throws {RpcRequestTimeout} When they haven't replied within 30 seconds.
 */
const interruptSession = Effect.fnUntraced(function* (live: Live, session: SessionId) {
  yield* live.channel.notify(Acp.Method.cancel, { sessionId: session });
  const outstanding = [...(live.prompts.get(session) ?? [])];
  yield* Effect.forEach(outstanding, Deferred.await, { discard: true }).pipe(
    Effect.timeoutOrElse({
      duration: CANCEL_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new RpcRequestTimeout({ method: Acp.Method.cancel, timeoutMs: CANCEL_TIMEOUT_MS }),
        ),
    }),
  );
});

/** Answers permission requests by policy; agy's fs/* and terminal/* requests are refused. */
const answerServerRequest = Effect.fnUntraced(function* (live: Live, request: RpcServerRequest) {
  if (request.method !== Acp.Method.requestPermission) {
    return yield* live.channel.respondError(request.id, METHOD_NOT_FOUND, "unsupported method");
  }
  if (!Schema.is(Acp.PermissionRequest)(request.params)) {
    const detail = `invalid ${request.method} params`;
    return yield* live.channel.respondError(request.id, INVALID_PARAMS, detail);
  }
  const decision = yield* decide(live, request, request.params);
  const optionId = pickOption(request.params.options, decision);
  yield* live.channel.respond(request.id, {
    outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId },
  });
});

/**
 * Decides a permission request. For a session this connection opened, records a refusal on
 * its turn and reports the decision as a Permission event.
 */
const decide = Effect.fnUntraced(function* (
  live: Live,
  request: RpcServerRequest,
  params: Acp.PermissionRequest,
) {
  const { sessionId, toolCall } = params;
  const state = live.sessions.get(sessionId);
  const kind = toolCall.kind ?? "other";
  const title = toolCall.title ?? toolCall.name ?? kind;
  const turnKind = state?.turn.turnKind ?? "start";
  const decision = decidePermission({
    kind,
    name: toolCall.name ?? null,
    access: state?.turn.access ?? "read-only",
    turnKind,
    known: state !== undefined,
  });
  if (state === undefined) return decision;
  if (decision === "rejected") {
    const refusal = refusalMessage(title, kind, turnKind);
    live.sessions.set(sessionId, { ...state, turn: recordRefusal(state.turn, refusal) });
  }
  const turn = activeTurn(state.turn);
  yield* Queue.offer(live.inbound, {
    session: sessionId,
    method: request.method,
    raw: request,
    events: turn === null ? [] : [{ _tag: "Permission", turn, kind, title, decision }],
  });
  return decision;
});
