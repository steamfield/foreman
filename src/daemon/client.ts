import {
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Predicate,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Socket } from "effect/socket";
import { type AppError, DaemonUnavailable, PermissionDenied } from "../errors";
import type { DaemonRequestBody, DaemonResult, RunName } from "../schemas/daemon";
import { Host } from "../services/host";
import { takeLock } from "./lock";
import { errorFromResponse, lines, requestJson, responseJson } from "./protocol";
import { DaemonSockets } from "./sockets";

export interface CallOptions {
  readonly dataDir: string;
  readonly connectOnly?: boolean;
  readonly startupTimeoutMs?: number;
  readonly onOutdated?: Effect.Effect<void, AppError>;
  readonly codexBin?: string;
  readonly agyBin?: string;
  readonly codexHome?: string;
  readonly logFile?: string;
}

const absent = (error: Socket.SocketError) => {
  if (error.reason._tag !== "SocketOpenError") return false;
  const cause = error.reason.cause;
  return (
    Predicate.hasProperty(cause, "code") &&
    ["ENOENT", "ECONNREFUSED", "ECONNRESET"].some((code) => code === cause.code)
  );
};

const socketFailure = (socketPath: string, error: Socket.SocketError) => {
  const cause = error.reason.cause;
  if (Predicate.hasProperty(cause, "code") && (cause.code === "EACCES" || cause.code === "EPERM"))
    return new PermissionDenied({
      detail: `Cannot connect to daemon socket ${socketPath}. Check the socket and directory permissions, then retry.`,
    });
  return new DaemonUnavailable({
    detail: `Could not connect to daemon socket ${socketPath} (${Predicate.hasProperty(cause, "code") && typeof cause.code === "string" ? cause.code : error.reason._tag}). Check the socket, daemon process and FOREMAN_HOME/logs/daemon.jsonl, then retry.`,
  });
};

const spawn = Effect.fn("daemon.spawn")(
  function* (options: CallOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = path.resolve(options.dataDir);
    yield* fs.makeDirectory(dataDir, { recursive: true, mode: 0o700 });
    yield* fs.chmod(dataDir, 0o700);
    const host = yield* Host;
    const prefix = host.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const [executable, ...args] = host.executable;
    if (executable === undefined) {
      return yield* new DaemonUnavailable({
        detail: "No executable configured to start the daemon; reinstall foreman and retry.",
      });
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner
          .spawn(
            ChildProcess.make(executable, [...args, "daemon"], {
              cwd: dataDir,
              env: {
                FOREMAN_HOME: dataDir,
                ...(options.codexBin === undefined ? {} : { CODEX_BIN: options.codexBin }),
                ...(options.agyBin === undefined ? {} : { AGY_BIN: options.agyBin }),
                ...(options.codexHome === undefined ? {} : { CODEX_HOME: options.codexHome }),
                ...(options.logFile === undefined
                  ? {}
                  : { [`${prefix}_LOG_FILE`]: options.logFile }),
              },
              extendEnv: true,
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.mapError(
              () =>
                new DaemonUnavailable({
                  detail: `Could not spawn daemon executable ${JSON.stringify(executable)}. Check that it is executable or reinstall foreman, then retry.`,
                }),
            ),
          );
        yield* child.unref;
      }),
    );
  },
  (effect, options) =>
    effect.pipe(
      Effect.mapError((error) => {
        if (error instanceof DaemonUnavailable || error instanceof PermissionDenied) return error;
        if (PlatformError.isPlatformError(error) && error.reason._tag === "PermissionDenied")
          return new PermissionDenied({
            detail: `Cannot prepare daemon home ${options.dataDir}: ${error.reason.method}${"pathOrDescriptor" in error.reason ? ` at ${error.reason.pathOrDescriptor}` : ""}. Check directory permissions and retry.`,
          });
        return new DaemonUnavailable({
          detail: `Could not prepare daemon home ${options.dataDir}${PlatformError.isPlatformError(error) ? `: ${error.reason.method} (${error.reason._tag})` : ""}. Check its path and permissions, then retry.`,
        });
      }),
    ),
);

const open = Effect.fnUntraced(function* (socketPath: string) {
  const socket = yield* (yield* DaemonSockets).connect(socketPath);
  return { socket, reader: yield* socket.reader };
});

const validateSocketPath = (socketPath: string) =>
  new TextEncoder().encode(socketPath).length > 104
    ? Effect.fail(
        new DaemonUnavailable({
          detail: `Socket path exceeds 104 bytes: ${socketPath}. Set FOREMAN_HOME to a shorter absolute path.`,
        }),
      )
    : Effect.void;

const connect = Effect.fn("daemon.connect")(
  function* (socketPath: string, options: CallOptions) {
    const initial = yield* Effect.result(open(socketPath));
    if (initial._tag === "Success") return initial.success;
    if (options.connectOnly || !absent(initial.failure)) {
      return yield* socketFailure(socketPath, initial.failure);
    }
    yield* spawn(options);
    while (true) {
      yield* Effect.sleep(100);
      const attempt = yield* Effect.result(open(socketPath));
      if (attempt._tag === "Success") return attempt.success;
      if (!absent(attempt.failure)) {
        return yield* socketFailure(socketPath, attempt.failure);
      }
    }
  },
  (effect, socketPath, options) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: options.startupTimeoutMs ?? 10_000,
        orElse: () =>
          Effect.fail(
            new DaemonUnavailable({
              detail: `Daemon did not connect or start within ${options.startupTimeoutMs ?? 10_000} ms: ${socketPath}. Inspect FOREMAN_HOME/logs/daemon.jsonl and the daemon process; the command was not sent.`,
            }),
          ),
      }),
    ),
);

const connectionClosed = "Daemon connection closed during the request.";
const closedRequest = (body: DaemonRequestBody) =>
  new DaemonUnavailable({
    detail: `${connectionClosed} ${body._tag}${"name" in body && body.name !== undefined ? ` for run ${body.name}` : ""}: ${body._tag === "Ping" ? "the command was not sent" : "the request may have been accepted; confirm its state before retrying"}. Run foreman doctor and inspect the daemon log.`,
  });

// Diagnostics never launch or replace a daemon; only a missing/refused socket is absence.
export const probe = Effect.fn("daemon.probe")(function* (dataDir: string, passive?: true) {
  const path = yield* Path.Path;
  const socketPath = path.join(dataDir, "foreman.sock");
  yield* validateSocketPath(socketPath);
  const opened = yield* open(socketPath).pipe(Effect.result);
  if (opened._tag === "Failure") {
    if (absent(opened.failure)) return null;
    return yield* socketFailure(socketPath, opened.failure);
  }
  return yield* exchange({ _tag: "Ping" }, opened.success.socket, opened.success.reader, passive);
}, Effect.scoped);

const exchange = Effect.fn("daemon.exchange")(
  function* (
    body: DaemonRequestBody,
    socket: Socket.Socket,
    reader: Socket.Reader,
    passive?: true,
  ) {
    const writer = yield* socket.writer;
    const json = yield* Schema.encodeEffect(requestJson)({
      id: 1,
      body,
      ...(passive ? { passive } : {}),
    });
    const receive = lines(reader).pipe(
      Stream.mapEffect((line) => Schema.decodeUnknownEffect(responseJson)(line)),
      Stream.filter((response) => response.id === 1),
      Stream.runHead,
      Effect.flatMap((response) => {
        if (Option.isNone(response)) return Effect.fail(closedRequest(body));
        if (!("error" in response.value)) return Effect.succeed(response.value.result);
        const known = errorFromResponse(response.value.error);
        return Effect.fail(
          known ??
            new DaemonUnavailable({
              detail: `Daemon returned an unrecognized error to ${body._tag}${"name" in body && body.name !== undefined ? ` for run ${body.name}` : ""}. ${body._tag === "Ping" ? "The command was not sent." : "The request may have been accepted; confirm its state before retrying."} Run foreman doctor and inspect the daemon log.`,
            }),
        );
      }),
    );
    // Observe EOF even when a write to a closed socket is waiting for drain.
    const [, response] = yield* Effect.all([writer.write(`${json}\n`), receive], {
      concurrency: "unbounded",
    });
    return response;
  },
  (effect, body) =>
    effect.pipe(Effect.catchTag("SocketError", () => Effect.fail(closedRequest(body)))),
  (effect, body) =>
    effect.pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(
          new DaemonUnavailable({
            detail: `Could not decode daemon reply to ${body._tag}${"name" in body && body.name !== undefined ? ` for run ${body.name}` : ""}. ${body._tag === "Ping" ? "The command was not sent." : "The request may have been accepted; confirm its state before retrying."} Run foreman doctor and inspect the daemon log.`,
          }),
        ),
      ),
    ),
  (effect, body) =>
    body._tag === "Ping" || body._tag === "Shutdown"
      ? effect.pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              Effect.fail(
                new DaemonUnavailable({
                  detail: `${body._tag} reply timed out after 10 seconds. Inspect FOREMAN_HOME/logs/daemon.jsonl and the daemon process; ${body._tag === "Shutdown" ? "shutdown may have been accepted. Confirm daemon state before retrying." : "the command was not sent."}`,
                }),
              ),
          }),
        )
      : effect,
);

// A monitor may read an older protocol, but must never invoke call's replacement path.
// Only the old protocol's request-decoding refusal means unsupported.
const requestNotUnderstood = (error: { readonly tag: string; readonly detail?: string }) =>
  error.tag === "DaemonUnavailable" &&
  error.detail?.startsWith("Request not understood; daemon build ") === true;

export const OVERVIEW_REQUEST_TIMEOUT_MS = 20_000; // Default 15 s long-poll plus transport headroom.
export const passiveOverview = Effect.fn("daemon.passiveOverview")(
  function* (dataDir: string, after?: number) {
    const path = yield* Path.Path;
    const socketPath = path.join(dataDir, "foreman.sock");
    yield* validateSocketPath(socketPath);
    const { socket, reader } = yield* open(socketPath).pipe(
      Effect.mapError((error) => socketFailure(socketPath, error)),
    );
    const body = { _tag: "Overview" as const, ...(after === undefined ? {} : { after }) };
    const writer = yield* socket.writer;
    const json = yield* Schema.encodeEffect(requestJson)({ id: 1, body, passive: true });
    yield* writer.write(`${json}\n`);
    const response = yield* lines(reader).pipe(
      Stream.mapEffect((line) => Schema.decodeUnknownEffect(responseJson)(line)),
      Stream.filter((reply) => reply.id === 1),
      Stream.runHead,
      Effect.catchTag("SchemaError", () =>
        Effect.fail(
          new DaemonUnavailable({
            detail: "Invalid daemon Overview reply; reconnect and inspect the daemon log.",
          }),
        ),
      ),
    );
    if (Option.isNone(response)) return yield* closedRequest(body);
    if ("error" in response.value) {
      const error = response.value.error;
      if (requestNotUnderstood(error)) return null;
      return yield* new DaemonUnavailable({
        detail: `Daemon Overview failed (${error.tag}): ${error.detail ?? "inspect the daemon log and retry."}`,
      });
    }
    if (response.value.result._tag === "Overview") return response.value.result;
    return yield* new DaemonUnavailable({
      detail: "Unexpected daemon Overview reply; reconnect and inspect the daemon log.",
    });
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: OVERVIEW_REQUEST_TIMEOUT_MS,
    orElse: () =>
      Effect.fail(
        new DaemonUnavailable({
          detail: `Daemon Overview reply timed out after ${OVERVIEW_REQUEST_TIMEOUT_MS} ms. Reconnect and inspect the daemon log.`,
        }),
      ),
  }),
  Effect.catchTag("SocketError", () => Effect.fail(closedRequest({ _tag: "Overview" }))),
);

const passiveRead = Effect.fn("daemon.passiveRead")(
  function* (dataDir: string, body: DaemonRequestBody, timeoutMs: number) {
    const path = yield* Path.Path;
    const socketPath = path.join(dataDir, "foreman.sock");
    yield* validateSocketPath(socketPath);
    const { socket, reader } = yield* open(socketPath).pipe(
      Effect.mapError((error) => socketFailure(socketPath, error)),
    );
    const writer = yield* socket.writer;
    const json = yield* Schema.encodeEffect(requestJson)({ id: 1, body, passive: true });
    yield* writer.write(`${json}\n`);
    const response = yield* lines(reader).pipe(
      Stream.mapEffect((line) => Schema.decodeUnknownEffect(responseJson)(line)),
      Stream.filter((reply) => reply.id === 1),
      Stream.runHead,
      Effect.catchTag("SchemaError", () =>
        Effect.fail(
          new DaemonUnavailable({
            detail: `Invalid daemon ${body._tag} reply; reconnect and inspect the daemon log.`,
          }),
        ),
      ),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new DaemonUnavailable({
              detail: `Daemon ${body._tag} reply timed out; reconnect and inspect the daemon log.`,
            }),
          ),
      }),
    );
    if (Option.isNone(response)) return yield* closedRequest(body);
    if ("result" in response.value) return response.value.result;
    if (requestNotUnderstood(response.value.error)) return null;
    const error = errorFromResponse(response.value.error);
    if (error?._tag === "RunNotFound") return yield* error;
    return yield* new DaemonUnavailable({
      detail: `Daemon ${body._tag} failed (${response.value.error.tag}): ${response.value.error.detail ?? "inspect the daemon log and retry."}`,
    });
  },
  Effect.scoped,
  Effect.catchTag("SocketError", () =>
    Effect.fail(new DaemonUnavailable({ detail: "Passive daemon connection closed; reconnect." })),
  ),
);

export const passiveDetail = Effect.fn("daemon.passiveDetail")(function* (
  home: string,
  name: RunName,
  after?: number,
) {
  const result = yield* passiveRead(
    home,
    { _tag: "Detail", name, ...(after === undefined ? {} : { after }) },
    OVERVIEW_REQUEST_TIMEOUT_MS,
  );
  if (result === null || result._tag === "Detail") return result;
  return yield* new DaemonUnavailable({
    detail: "Unexpected daemon Detail reply; reconnect and inspect the daemon log.",
  });
});

export const passiveEvents = Effect.fn("daemon.passiveEvents")(function* (
  home: string,
  name: RunName,
  after: number,
  waitMs: number,
  limit?: number,
) {
  const result = yield* passiveRead(
    home,
    { _tag: "Events", name, after, waitMs, ...(limit === undefined ? {} : { limit }) },
    waitMs + 5000,
  );
  if (result === null || result._tag === "Events") return result;
  return yield* new DaemonUnavailable({
    detail: "Unexpected daemon Events reply; reconnect and inspect the daemon log.",
  });
});

const exchangeRunRequest = Effect.fn("daemon.exchangeRunRequest")(function* (
  body: DaemonRequestBody,
  socket: Socket.Socket,
  reader: Socket.Reader,
  outdated: boolean,
) {
  if (outdated && body._tag === "Defer")
    return yield* new DaemonUnavailable({
      detail: `Outdated daemon cannot defer ${body.question} in run ${body.name}; the request was not sent. Finish or interrupt its active runs, then restart the daemon.`,
    });
  if (outdated && body._tag === "Answer") {
    const status = yield* exchange({ _tag: "Status", name: body.name, cwd: "" }, socket, reader);
    if (
      status._tag !== "Digests" ||
      !status.digests.some((digest) =>
        digest.questions.some((question) => question.id === body.question),
      )
    )
      return yield* new DaemonUnavailable({
        detail: `Outdated daemon cannot route a late answer or correction for ${body.question} in run ${body.name}; the request was not sent. Finish or interrupt its active runs, then restart the daemon.`,
      });
  }
  if (outdated && body._tag === "Start" && body.newWorktree)
    return yield* new DaemonUnavailable({
      detail: `Outdated busy daemon cannot safely create managed worktrees for run ${body.name}; the request was not sent. Finish or interrupt its active runs, then restart the daemon before starting this run.`,
    });
  if (
    !outdated ||
    (body._tag !== "Answer" &&
      body._tag !== "Followup" &&
      body._tag !== "Steer" &&
      body._tag !== "Interrupt")
  )
    return yield* exchange(body, socket, reader);
  // Busy older builds acknowledge with Ok. Capture their position before sending the
  // mutation, so even an immediate continuation is visible to the subsequent wait.
  const before = yield* exchange(
    { _tag: "Wait", names: [body.name], all: false, cwd: "", timeoutMs: 0 },
    socket,
    reader,
  );
  if (before._tag !== "Waited")
    return yield* new DaemonUnavailable({
      detail: `Outdated daemon cannot provide a wait cursor for run ${body.name}; the request was not sent. Finish or interrupt its active runs, then restart the daemon.`,
    });
  const result = yield* exchange(body, socket, reader);
  return result._tag === "Ok" ? { _tag: "Accepted" as const, cursor: before.cursor } : result;
});

export const outdated = (
  pong: Extract<DaemonResult, { _tag: "Pong" }>,
  build: string,
  options: CallOptions,
) =>
  pong.build !== build ||
  (options.codexBin !== undefined &&
    pong.codexBin !== undefined &&
    options.codexBin !== pong.codexBin) ||
  (options.agyBin !== undefined && pong.agyBin !== undefined && options.agyBin !== pong.agyBin) ||
  (options.codexHome !== undefined &&
    pong.codexHome !== undefined &&
    options.codexHome !== pong.codexHome);

const actingRequirement =
  "Acting needs a running foreman daemon of this build; foreman status <name> starts supervision.";

const activeConnection = Effect.fn("daemon.activeConnection")(function* (home: string) {
  const path = yield* Path.Path;
  const host = yield* Host;
  const socketPath = path.join(home, "foreman.sock");
  yield* validateSocketPath(socketPath);
  const connection = yield* open(socketPath).pipe(
    Effect.mapError(
      (error) =>
        new DaemonUnavailable({
          detail: `${socketFailure(socketPath, error).detail} ${actingRequirement}`,
        }),
    ),
  );
  const pong = yield* exchange({ _tag: "Ping" }, connection.socket, connection.reader);
  if (pong._tag !== "Pong" || outdated(pong, host.build, { dataDir: home }))
    return yield* new DaemonUnavailable({ detail: actingRequirement });
  return connection;
});

/**
 * Holds an active connection to a running daemon of this build until the scope closes.
 *
 * @throws {DaemonUnavailable} When connecting or checking the daemon build fails.
 */
export const openActive = Effect.fn("daemon.openActive")(function* (home: string) {
  const { reader } = yield* activeConnection(home);
  const reading = yield* lines(reader).pipe(
    Stream.runDrain,
    // A transport failure ends the held connection just like EOF.
    Effect.catchTag("SocketError", () => Effect.void),
    Effect.forkScoped,
  );
  return { closed: Fiber.join(reading) };
});

/**
 * Sends an active request to a running daemon of this build without starting or replacing it.
 *
 * @throws {DaemonUnavailable} When the daemon cannot accept the request or its build differs.
 * @throws {AppError} When the daemon rejects the request with a tagged application error.
 */
export const activeRequest = Effect.fn("daemon.activeRequest")(function* (
  home: string,
  body: DaemonRequestBody,
) {
  const { socket, reader } = yield* activeConnection(home);
  return yield* exchange(body, socket, reader);
}, Effect.scoped);

export const call = Effect.fn("daemon.call")(function* (
  body: DaemonRequestBody,
  options: CallOptions,
) {
  const path = yield* Path.Path;
  const host = yield* Host;
  const socketPath = path.join(options.dataDir, "foreman.sock");
  yield* validateSocketPath(socketPath);
  let connection = yield* connect(socketPath, options);
  const check = Effect.gen(function* () {
    const pong = yield* exchange({ _tag: "Ping" }, connection.socket, connection.reader);
    if (pong._tag !== "Pong")
      return yield* new DaemonUnavailable({
        detail: `Daemon returned ${pong._tag} to Ping at ${socketPath}; the command was not sent. Run foreman doctor and inspect the daemon log before retrying.`,
      });
    // Diagnostics must inspect an old daemon without replacing or launching one.
    if (body._tag === "Ping" && options.connectOnly) return pong;
    if (outdated(pong, host.build, options)) {
      const stopped = yield* stopConnected(
        options.dataDir,
        connection.socket,
        connection.reader,
      ).pipe(
        Effect.catchTag("RunConflict", () =>
          Effect.gen(function* () {
            if (options.onOutdated !== undefined) yield* options.onOutdated;
            return false;
          }),
        ),
      );
      if (stopped) return null;
    }
    return pong;
  });
  const pong = yield* check.pipe(
    Effect.catchTag("DaemonUnavailable", (error) =>
      Effect.gen(function* () {
        if (!error.detail?.startsWith(connectionClosed)) return yield* error;
        // Idle exit or replacement can close a just-accepted connection. The command
        // has not been sent, so retry only this handshake, once.
        connection = yield* connect(socketPath, options);
        return yield* check;
      }),
    ),
  );
  if (pong === null) {
    connection = yield* connect(socketPath, { ...options, connectOnly: false });
    return yield* exchange(body, connection.socket, connection.reader);
  }
  return body._tag === "Ping"
    ? pong
    : yield* exchangeRunRequest(
        body,
        connection.socket,
        connection.reader,
        outdated(pong, host.build, options),
      );
}, Effect.scoped);

const stopConnected = Effect.fn("daemon.stopConnected")(
  function* (dataDir: string, socket: Socket.Socket, reader: Socket.Reader) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const lock = path.join(dataDir, "daemon.lock");
    const original = yield* fs
      .stat(lock)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    const result = yield* exchange({ _tag: "Shutdown" }, socket, reader);
    if (result._tag !== "Ok")
      return yield* new DaemonUnavailable({
        detail: `Daemon returned ${result._tag} to Shutdown at ${path.join(dataDir, "foreman.sock")}; shutdown may have been accepted. Run foreman doctor and inspect the daemon log before retrying.`,
      });
    yield* Effect.gen(function* () {
      while (true) {
        const current = yield* fs
          .stat(lock)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
        if (
          current === null &&
          !(yield* fs.exists(path.join(dataDir, "foreman.sock"))) &&
          (yield* Effect.scoped(takeLock(dataDir)))
        )
          return;
        if (
          original !== null &&
          current !== null &&
          (original.dev !== current.dev ||
            (Option.isSome(original.ino) &&
              Option.isSome(current.ino) &&
              original.ino.value !== current.ino.value))
        )
          return;
        yield* Effect.sleep(25);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () =>
          Effect.fail(
            new DaemonUnavailable({
              detail: `Daemon accepted shutdown but did not finish cleanup within 10 seconds in ${dataDir}. Run foreman doctor and inspect the daemon process and ${path.join(dataDir, "logs/daemon.jsonl")} before retrying.`,
            }),
          ),
      }),
    );
    return true;
  },
  (effect, dataDir) =>
    effect.pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          new DaemonUnavailable({
            detail: `Could not confirm daemon shutdown cleanup in ${dataDir}: ${error.reason.method} (${error.reason._tag})${"pathOrDescriptor" in error.reason ? `: ${error.reason.pathOrDescriptor}` : ""}. Run foreman doctor and inspect the daemon process before retrying.`,
          }),
        ),
      ),
    ),
);

// Only a missing/refused socket means there is no daemon. Other failures remain visible.
export const shutdown = Effect.fn("daemon.shutdown")(function* (dataDir: string) {
  const path = yield* Path.Path;
  yield* validateSocketPath(path.join(dataDir, "foreman.sock"));
  const opened = yield* Effect.result(open(path.join(dataDir, "foreman.sock"))).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new DaemonUnavailable({
            detail: `Could not connect to daemon within 10 seconds: ${path.join(dataDir, "foreman.sock")}. Inspect the daemon process and ${path.join(dataDir, "logs/daemon.jsonl")}; no Shutdown request was sent.`,
          }),
        ),
    }),
  );
  if (opened._tag === "Failure") {
    if (absent(opened.failure)) return false;
    return yield* socketFailure(path.join(dataDir, "foreman.sock"), opened.failure);
  }
  return yield* stopConnected(dataDir, opened.success.socket, opened.success.reader);
}, Effect.scoped);
