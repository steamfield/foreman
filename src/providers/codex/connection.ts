/**
 * The Codex `ProviderConnection`: thread and turn requests over one app-server channel,
 * decoded notifications and question calls.
 *
 * Owns the per-session turn items the hand-off is chosen from and the set of threads this
 * app server has loaded. Request failures stay the transport's `RpcError` and
 * `RpcRequestTimeout`; a reply that doesn't match the supported protocol becomes
 * `CodexUnavailable`.
 */
import { type Duration, Effect, type FileSystem, type Path, Schema, Stream } from "effect";
import { CodexUnavailable, RepoHooksUntrusted } from "../../errors";
import * as Codex from "../../schemas/codex";
import {
  type ProviderConnection,
  QuestionRefused,
  type SessionId,
  type SessionSettings,
  SteerRefused,
  type TurnRequest,
} from "../contract";
import type { RpcError, RpcRequestTimeout } from "../jsonrpc";
import { type CodexChannel, type ConnectionOptions, openCodexChannel } from "./client";
import { type CodexTurnItems, decodeNotification } from "./events";
import { hasRepoHooks, inspectHookTrust } from "./hooks";
import { questionCalls } from "./questions";

const THREAD_START_TIMEOUT = "180 seconds";
const NO_ITEMS: CodexTurnItems = { turn: null, items: [] };

const replyMismatch = (method: string) =>
  new CodexUnavailable({
    detail: `Codex reply to ${method} did not match the supported protocol; run foreman doctor and check the Codex version.`,
  });

function threadSettings(settings: SessionSettings) {
  return {
    cwd: settings.cwd,
    model: settings.model,
    serviceTier: settings.tier,
    approvalPolicy: "never",
    sandbox: settings.access === "write" ? "danger-full-access" : "read-only",
  };
}

// A hand-off turn runs read-only whatever the run's access, so it can only report.
function turnPolicy(request: TurnRequest) {
  return request.kind === "handoff" || request.settings.access === "read-only"
    ? { type: "readOnly", networkAccess: false }
    : { type: "dangerFullAccess" };
}

const textInput = (text: string) => [{ type: "text", text }];

/** Sends a request and turns a reply outside the supported protocol into CodexUnavailable. */
const makeRequest =
  (channel: CodexChannel) =>
  <A, I, R>(
    method: string,
    params: unknown,
    result: Schema.Codec<A, I, R>,
    options: { timeout?: Duration.Input } = {},
  ): Effect.Effect<A, CodexUnavailable | RpcError | RpcRequestTimeout, R> =>
    channel
      .request(method, params, result, options)
      .pipe(Effect.catchTag("SchemaError", () => Effect.fail(replyMismatch(method))));

type Request = ReturnType<typeof makeRequest>;

// Codex and the ChatGPT app title an unnamed thread by its first message, which opens with
// the same preamble for every run. A refused title is cosmetic, so it becomes a warning; a
// lost app server is reported by the turn that follows.
const nameThread = (request: Request, session: SessionId, title: string) =>
  request(Codex.Method.threadNameSet, { threadId: session, name: title }, Codex.ThreadNameSet).pipe(
    Effect.as<readonly string[]>([]),
    Effect.catch((error) => Effect.succeed([titleWarning(titleFailure(error))])),
  );

function titleFailure(error: CodexUnavailable | RpcError | RpcRequestTimeout): string {
  if (error._tag === "RpcError") return error.message;
  if (error._tag === "RpcRequestTimeout") return `timed out after ${error.timeoutMs} ms`;
  return error.detail ?? "Codex is unavailable";
}

const titleWarning = (reason: string) =>
  `Codex did not accept the thread title (${reason}); the Codex app lists this run under its first message.`;

/** Decodes notifications in order, keeping each session's turn items between them. */
function inboundFrom(channel: CodexChannel) {
  const items = new Map<SessionId, CodexTurnItems>();
  return channel.notifications.pipe(
    Stream.map((message) => {
      const session = sessionOf(message.params);
      const previous = session === null ? NO_ITEMS : (items.get(session) ?? NO_ITEMS);
      const decoded = decodeNotification(message, previous);
      if (session !== null) items.set(session, decoded.items);
      return decoded.inbound;
    }),
  );
}

const SessionEnvelope = Schema.Struct({ threadId: Schema.String });
function sessionOf(params: unknown): SessionId | null {
  return Schema.is(SessionEnvelope)(params) ? params.threadId : null;
}

/**
 * Opens a Codex connection: starts the app server and wraps its channel in the provider
 * contract. Closed with the caller's scope.
 * @throws {CodexUnavailable} When Codex can't be launched, refuses or times out on initialize,
 * or exits.
 */
export const connectCodex = Effect.fn("codex.connect")(function* (options: ConnectionOptions) {
  const channel = yield* openCodexChannel(options).pipe(
    Effect.catchTag("RpcError", (error) =>
      Effect.fail(
        new CodexUnavailable({
          detail: `Codex refused initialize (${error.message}); run foreman doctor and check the Codex version.`,
        }),
      ),
    ),
    Effect.catchTag("RpcRequestTimeout", (error) =>
      Effect.fail(
        new CodexUnavailable({
          detail: `Codex did not answer initialize within ${error.timeoutMs} ms; run foreman doctor before retrying.`,
        }),
      ),
    ),
    Effect.catchTag("SchemaError", () => Effect.fail(replyMismatch(Codex.Method.initialize))),
  );
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const request = makeRequest(channel);
  const loaded = new Set<SessionId>();
  const connection: ProviderConnection = {
    provider: "codex",
    generation: Symbol("codex"),
    inbound: inboundFrom(channel),
    questions: questionCalls(channel.serverRequests, channel),
    termination: channel.termination,
    open: (_run, settings) =>
      request(
        Codex.Method.threadStart,
        {
          ...threadSettings(settings),
          ephemeral: false,
          dynamicTools: [Codex.askOrchestratorTool],
        },
        Codex.ThreadOpened,
        { timeout: THREAD_START_TIMEOUT },
      ).pipe(
        Effect.tap((opened) => Effect.sync(() => loaded.add(opened.thread.id))),
        Effect.map((opened) => ({ session: opened.thread.id, warnings: [] })),
      ),
    nameSession: (session, title) => nameThread(request, session, title),
    resume: (_run, session, settings) =>
      request(
        Codex.Method.threadResume,
        { threadId: session, ...threadSettings(settings) },
        Codex.ThreadOpened,
      ).pipe(
        Effect.tap(() => Effect.sync(() => loaded.add(session))),
        Effect.map((resumed) => ({ sandbox: resumed.sandbox.type, model: resumed.model })),
      ),
    isLoaded: (session) => loaded.has(session),
    startTurn: (session, turn) =>
      request(
        Codex.Method.turnStart,
        {
          threadId: session,
          input: textInput(turn.input),
          effort: turn.settings.effort,
          sandboxPolicy: turnPolicy(turn),
        },
        Codex.TurnStartResponse,
      ).pipe(Effect.map((response) => response.turn.id)),
    steer: (session, turn, input) =>
      request(
        Codex.Method.turnSteer,
        { threadId: session, expectedTurnId: turn, input: textInput(input) },
        Codex.TurnSteerResponse,
      ).pipe(
        Effect.asVoid,
        Effect.catchTag("RpcError", (error) =>
          Effect.fail(new SteerRefused({ reason: error.message })),
        ),
      ),
    interrupt: (session, turn) =>
      request(Codex.Method.turnInterrupt, { threadId: session, turnId: turn }, Schema.Unknown).pipe(
        Effect.asVoid,
      ),
    // Codex questions are dynamic tool calls on its own wire; nothing outside asks them.
    ask: () =>
      Effect.fail(new QuestionRefused({ reason: "Codex questions arrive from the app server" })),
    hookTrust: (mainCheckout, worktree) =>
      checkTrust(request, mainCheckout, worktree).pipe(Effect.provide(context)),
  };
  return connection;
});

/**
 * Today's start check: hooks must be trusted when the main checkout has a hooks file.
 * A permission failure on that file can only be reported as untrusted hooks here; the
 * supervisor inspects the file first so that case still reports PermissionDenied.
 */
const checkTrust = Effect.fnUntraced(function* (
  request: Request,
  mainCheckout: string,
  worktree: string,
) {
  const required = yield* hasRepoHooks(mainCheckout).pipe(
    Effect.catchTag("PermissionDenied", (error) =>
      Effect.fail(new RepoHooksUntrusted({ detail: error.detail })),
    ),
  );
  if (!required) return { required };
  const result = yield* inspectHookTrust({ request }, mainCheckout, worktree).pipe(
    Effect.catchTag("SchemaError", () => Effect.fail(replyMismatch(Codex.Method.hooksList))),
  );
  if (!result.acceptsStart)
    return yield* new RepoHooksUntrusted({ detail: result.detail ?? undefined });
  return { required };
});
