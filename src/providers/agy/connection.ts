/**
 * The agy `ProviderConnection`: sessions and turns over one `agy acp` child.
 *
 * One reader applies everything agy writes in wire order: session updates, permission
 * requests (answered inline) and prompt replies, which end turns. Because a reply is handled
 * only after the updates agy sent before it, a turn's hand-off and events are complete when
 * it ends. Bridge questions are held in questions.ts. docs/rfcs/0002-providers.md "The agy
 * adapter" is the design.
 */
import { Deferred, Effect, FileSystem, Queue, Schema, Stream } from "effect";
import { AgyUnavailable } from "../../errors";
import * as Acp from "../../schemas/acp";
import {
  type ProviderConnection,
  type SessionId,
  type SessionSettings,
  SteerRefused,
  type TurnRequest,
} from "../contract";
import { type RpcMessage, type RpcNotification, RpcRequestTimeout } from "../jsonrpc";
import { readNotification } from "./events";
import { agyHookTrust } from "./hooks";
import { type AgyLaunchOptions, launchAgy, sessionRequest } from "./launch";
import { type Live, makeLive } from "./live";
import { answerServerRequest } from "./permission-requests";
import { askQuestion, bridgeFor } from "./questions";
import {
  abandonPrompts,
  beginTurn,
  finishPrompt,
  openedSession,
  type PromptOutcome,
  promptOutcome,
  turnIdFor,
} from "./turns";

const SESSION_NEW_TIMEOUT = "180 seconds";
const CANCEL_TIMEOUT_MS = 30_000;
/** The effort routing records for agy models that have no thinking levels. */
const NO_EFFORT = "none";
const RESUME_UNAVAILABLE =
  "Resuming an agy session after a daemon restart isn't available yet; start a new run.";

/** Settings for one `agy acp` child and the question bridge its sessions get. */
export interface AgyConnectionOptions extends AgyLaunchOptions {
  /** foreman's own command line (Host.executable), which agy runs as the question bridge. */
  readonly executable: readonly string[];
}

/** A live connection and the agy version its initialize reply reported. */
export interface AgyConnection {
  readonly connection: ProviderConnection;
  /** null when agy didn't report one. */
  readonly agentVersion: string | null;
}

/**
 * agy takes model and thinking level as one id: `gemini-4-neon-low`. Models without thinking
 * levels (`claude-opus-5-5`) go as they are.
 */
export function modelValue(settings: SessionSettings): string {
  const suffix = `-${settings.effort}`;
  if (settings.effort === NO_EFFORT || settings.model.endsWith(suffix)) return settings.model;
  return `${settings.model}${suffix}`;
}

/**
 * Starts `agy acp` and wraps it in the provider contract. Closes with the caller's scope.
 * @throws {AgyUnavailable} When foreman has no executable path for the question bridge, agy
 * can't be launched, refuses or times out on initialize, speaks another ACP protocol, or its
 * directories under foreman's home can't be created.
 */
export const connectAgy = Effect.fn("agy.connect")(function* (options: AgyConnectionOptions) {
  const fs = yield* FileSystem.FileSystem;
  const bridge = yield* bridgeFor(options.executable, options.home);
  const { channel, agentVersion } = yield* launchAgy(options);
  const connection = yield* makeConnection(yield* makeLive(channel, bridge), fs);
  return { connection, agentVersion } satisfies AgyConnection;
});

/** Wires the channel into the provider contract and starts the reader. */
const makeConnection = Effect.fnUntraced(function* (live: Live, fs: FileSystem.FileSystem) {
  yield* readMessages(live).pipe(Effect.forkScoped);
  const connection: ProviderConnection = {
    provider: "agy",
    generation: Symbol("agy"),
    inbound: Stream.fromQueue(live.inbound),
    questions: Stream.fromQueue(live.questions),
    termination: live.channel.termination,
    open: (run, settings) => openSession(live, run, settings),
    nameSession: () => Effect.succeed([]),
    resume: () => Effect.fail(new AgyUnavailable({ detail: RESUME_UNAVAILABLE })),
    isLoaded: (session) => live.sessions.has(session),
    startTurn: (session, request) => startTurn(live, session, request),
    steer: () => Effect.fail(new SteerRefused({ reason: "agy steering is not available yet" })),
    interrupt: (session) => interruptSession(live, session),
    ask: (session, question) => askQuestion(live, session, question),
    hookTrust: (mainCheckout, worktree) =>
      agyHookTrust(mainCheckout, worktree).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
  };
  return connection;
});

/** Applies agy's messages in wire order, ending `inbound` and `questions` with the channel. */
const readMessages = (live: Live) =>
  live.channel.messages.pipe(
    Stream.runForEach((message) => applyMessage(live, message)),
    Effect.matchCauseEffect({
      onFailure: (cause) => Queue.failCause(live.inbound, cause),
      onSuccess: () => Queue.end(live.inbound),
    }),
    // inbound carries any failure; the supervisor learns of a lost connection from it.
    Effect.ensuring(Queue.end(live.questions)),
  );

function applyMessage(live: Live, message: RpcMessage) {
  switch (message._tag) {
    case "Notification":
      return applyNotification(live, message.message);
    case "ServerRequest":
      return answerServerRequest(live, message.message);
    case "Reply":
      return applyReply(live, message);
  }
}

function applyNotification(live: Live, message: RpcNotification) {
  const session = Schema.is(Acp.SessionEnvelope)(message.params) ? message.params.sessionId : null;
  const known = session === null ? undefined : live.sessions.get(session);
  const read = readNotification(message, known);
  if (session !== null && read.state !== undefined) live.sessions.set(session, read.state);
  return Queue.offer(live.inbound, read.inbound);
}

/** `session/new` with the run's question bridge, then the model and thinking level, then mode. */
const openSession = Effect.fnUntraced(function* (
  live: Live,
  run: string,
  settings: SessionSettings,
) {
  const { sessionId } = yield* sessionRequest(
    live.channel,
    Acp.Method.sessionNew,
    { cwd: settings.cwd, mcpServers: [live.bridge(run)] },
    Acp.SessionNewResult,
    SESSION_NEW_TIMEOUT,
  );
  live.sessions.set(sessionId, {
    turn: openedSession(settings.access),
    tools: new Map(),
    cwd: settings.cwd,
  });
  const model = { sessionId, configId: "model", value: modelValue(settings) };
  yield* sessionRequest(live.channel, Acp.Method.setConfigOption, model, Schema.Unknown);
  const mode = { sessionId, modeId: "default" };
  yield* sessionRequest(live.channel, Acp.Method.setMode, mode, Schema.Unknown);
  return { session: sessionId, warnings: [] };
});

/** Reports the turn started and sends its prompt; the reader ends the turn on the reply. */
const startTurn = Effect.fnUntraced(function* (
  live: Live,
  session: SessionId,
  request: TurnRequest,
) {
  const state = live.sessions.get(session) ?? {
    turn: openedSession(request.settings.access),
    tools: new Map(),
    cwd: request.settings.cwd,
  };
  const turn = turnIdFor(request.turn);
  live.sessions.set(session, { ...state, turn: beginTurn(state.turn, request) });
  yield* Queue.offer(live.inbound, {
    session,
    method: Acp.Method.prompt,
    raw: null,
    events: [{ _tag: "TurnStarted", turn }],
  });
  const prompt = [{ type: "text", text: request.input }];
  // Registered before the write: the reader may see the reply before this fiber resumes.
  yield* live.channel.requestOrdered(Acp.Method.prompt, { sessionId: session, prompt }, (id) =>
    live.prompts.set(id, session),
  );
  return turn;
});

/** Ends a prompt's turn, unless the prompt was abandoned or another one is outstanding. */
function applyReply(live: Live, reply: Extract<RpcMessage, { _tag: "Reply" }>) {
  const session = live.prompts.get(reply.id);
  if (session === undefined) return Effect.void;
  live.prompts.delete(reply.id);
  const raw =
    reply.error === null
      ? reply.result
      : { error: { code: reply.error.code, message: reply.error.message } };
  const outcome = promptOutcome(reply.result, reply.error);
  return finishTurn(live, session, raw, outcome).pipe(Effect.andThen(settleIfIdle(live, session)));
}

/** Applies a prompt's reply to the session and reports the events it produces. */
function finishTurn(live: Live, session: SessionId, raw: unknown, outcome: PromptOutcome) {
  const state = live.sessions.get(session);
  if (state === undefined) return Effect.void;
  const finished = finishPrompt(state.turn, outcome);
  live.sessions.set(session, { ...state, turn: finished.state });
  const events = finished.events;
  return Queue.offer(live.inbound, { session, method: Acp.Method.prompt, raw, events });
}

const hasPrompts = (live: Live, session: SessionId) => [...live.prompts.values()].includes(session);

/** Releases an interrupt waiting on the session once none of its prompts is outstanding. */
function settleIfIdle(live: Live, session: SessionId) {
  const waiting = live.settled.get(session);
  if (waiting === undefined || hasPrompts(live, session)) return Effect.void;
  live.settled.delete(session);
  return Deferred.succeed(waiting, undefined);
}

/** Forgets the session's prompts, so late replies are ignored and the next turn can end. */
function abandonSession(live: Live, session: SessionId) {
  for (const [id, owner] of live.prompts) if (owner === session) live.prompts.delete(id);
  const state = live.sessions.get(session);
  if (state !== undefined)
    live.sessions.set(session, { ...state, turn: abandonPrompts(state.turn) });
  return settleIfIdle(live, session);
}

/**
 * Cancels the session's turn and waits for its prompts to reply.
 * @throws {RpcRequestTimeout} When they haven't replied within 30 seconds; the prompts are
 * then abandoned.
 */
const interruptSession = Effect.fnUntraced(function* (live: Live, session: SessionId) {
  yield* live.channel.notify(Acp.Method.cancel, { sessionId: session });
  if (!hasPrompts(live, session)) return;
  const settled = live.settled.get(session) ?? (yield* Deferred.make<void>());
  live.settled.set(session, settled);
  yield* Deferred.await(settled).pipe(
    Effect.timeoutOrElse({
      duration: CANCEL_TIMEOUT_MS,
      orElse: () =>
        abandonSession(live, session).pipe(
          Effect.andThen(
            Effect.fail(
              new RpcRequestTimeout({ method: Acp.Method.cancel, timeoutMs: CANCEL_TIMEOUT_MS }),
            ),
          ),
        ),
    }),
  );
});
