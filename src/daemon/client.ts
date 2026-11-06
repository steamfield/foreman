import { Effect, FileSystem, Option, Path, Predicate, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Socket } from "effect/socket";
import { type AppError, DaemonUnavailable, Defect } from "../errors";
import type { DaemonRequestBody, DaemonResult } from "../schemas/daemon";
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
        detail: "No executable configured to start the daemon.",
      });
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(executable, [...args, "daemon"], {
            cwd: dataDir,
            env: {
              FORMAN_HOME: dataDir,
              ...(options.codexBin === undefined ? {} : { CODEX_BIN: options.codexBin }),
              ...(options.codexHome === undefined ? {} : { CODEX_HOME: options.codexHome }),
              ...(options.logFile === undefined ? {} : { [`${prefix}_LOG_FILE`]: options.logFile }),
            },
            extendEnv: true,
            detached: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        yield* child.unref;
      }),
    );
  },
  Effect.mapError(
    () => new DaemonUnavailable({ detail: "Could not spawn the daemon executable." }),
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
          detail: `Socket path exceeds 104 bytes: ${socketPath}. Set FORMAN_HOME to a shorter absolute path.`,
        }),
      )
    : Effect.void;

const connect = Effect.fn("daemon.connect")(
  function* (socketPath: string, options: CallOptions) {
    const initial = yield* Effect.result(open(socketPath));
    if (initial._tag === "Success") return initial.success;
    if (options.connectOnly || !absent(initial.failure)) {
      return yield* new DaemonUnavailable({
        detail: `Could not connect to daemon socket: ${socketPath}`,
      });
    }
    yield* spawn(options);
    while (true) {
      yield* Effect.sleep(100);
      const attempt = yield* Effect.result(open(socketPath));
      if (attempt._tag === "Success") return attempt.success;
      if (!absent(attempt.failure)) {
        return yield* new DaemonUnavailable({
          detail: `Could not connect to daemon socket: ${socketPath}`,
        });
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
              detail: `Daemon did not connect or start within ${options.startupTimeoutMs ?? 10_000} ms: ${socketPath}`,
            }),
          ),
      }),
    ),
);

const connectionClosed = "Daemon connection closed during the request.";

// Diagnostics never launch or replace a daemon; only a missing/refused socket is absence.
export const probe = Effect.fn("daemon.probe")(function* (dataDir: string) {
  const path = yield* Path.Path;
  const socketPath = path.join(dataDir, "forman.sock");
  yield* validateSocketPath(socketPath);
  const opened = yield* open(socketPath).pipe(Effect.result);
  if (opened._tag === "Failure") {
    if (absent(opened.failure)) return null;
    return yield* new DaemonUnavailable({
      detail: "Could not read daemon socket; check home and socket permissions.",
    });
  }
  return yield* exchange({ _tag: "Ping" }, opened.success.socket, opened.success.reader);
}, Effect.scoped);

const exchange = Effect.fn("daemon.exchange")(
  function* (body: DaemonRequestBody, socket: Socket.Socket, reader: Socket.Reader) {
    const writer = yield* socket.writer;
    const json = yield* Schema.encodeEffect(requestJson)({ id: 1, body });
    const receive = lines(reader).pipe(
      Stream.mapEffect((line) => Schema.decodeUnknownEffect(responseJson)(line)),
      Stream.filter((response) => response.id === 1),
      Stream.runHead,
      Effect.flatMap((response) => {
        if (Option.isNone(response))
          return Effect.fail(new DaemonUnavailable({ detail: connectionClosed }));
        return "error" in response.value
          ? Effect.fail(errorFromResponse(response.value.error))
          : Effect.succeed(response.value.result);
      }),
    );
    // Observe EOF even when a write to a closed socket is waiting for drain.
    const [, response] = yield* Effect.all([writer.write(`${json}\n`), receive], {
      concurrency: "unbounded",
    });
    return response;
  },
  Effect.catchTag("SocketError", () =>
    Effect.fail(new DaemonUnavailable({ detail: connectionClosed })),
  ),
  Effect.catchTag("SchemaError", () =>
    Effect.fail(
      new DaemonUnavailable({
        detail: "Could not decode daemon reply; daemon build differs.",
      }),
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
                  detail: `${body._tag} reply timed out after 10 seconds. Inspect FORMAN_HOME/logs/daemon.jsonl and the daemon process; ${body._tag === "Shutdown" ? "shutdown may have been accepted. Confirm daemon state before retrying." : "the command was not sent."}`,
                }),
              ),
          }),
        )
      : effect,
);

const exchangeRunRequest = Effect.fn("daemon.exchangeRunRequest")(function* (
  body: DaemonRequestBody,
  socket: Socket.Socket,
  reader: Socket.Reader,
  outdated: boolean,
) {
  if (outdated && body._tag === "Defer")
    return yield* new DaemonUnavailable({
      detail:
        "Outdated daemon cannot defer questions; finish its active runs and restart the daemon.",
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
        detail:
          "Outdated daemon cannot route late answers or corrections; finish its active runs and restart the daemon.",
      });
  }
  if (outdated && body._tag === "Start" && body.newWorktree)
    return yield* new DaemonUnavailable({
      detail:
        "Outdated busy daemon cannot safely create managed worktrees; finish its active runs and restart the daemon before starting this run.",
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
      detail:
        "Outdated daemon cannot provide a wait cursor; the request was not sent. Finish its active runs and restart the daemon.",
    });
  const result = yield* exchange(body, socket, reader);
  return result._tag === "Ok" ? { _tag: "Accepted" as const, cursor: before.cursor } : result;
});

const outdated = (
  pong: Extract<DaemonResult, { _tag: "Pong" }>,
  build: string,
  options: CallOptions,
) =>
  pong.build !== build ||
  (options.codexBin !== undefined &&
    pong.codexBin !== undefined &&
    options.codexBin !== pong.codexBin) ||
  (options.codexHome !== undefined &&
    pong.codexHome !== undefined &&
    options.codexHome !== pong.codexHome);

export const call = Effect.fn("daemon.call")(function* (
  body: DaemonRequestBody,
  options: CallOptions,
) {
  const path = yield* Path.Path;
  const host = yield* Host;
  const socketPath = path.join(options.dataDir, "forman.sock");
  yield* validateSocketPath(socketPath);
  let connection = yield* connect(socketPath, options);
  const check = Effect.gen(function* () {
    const pong = yield* exchange({ _tag: "Ping" }, connection.socket, connection.reader);
    if (pong._tag !== "Pong") return yield* new Defect();
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
        if (error.detail !== connectionClosed) return yield* error;
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
    if (result._tag !== "Ok") return yield* new Defect();
    yield* Effect.gen(function* () {
      while (true) {
        const current = yield* fs
          .stat(lock)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
        if (
          current === null &&
          !(yield* fs.exists(path.join(dataDir, "forman.sock"))) &&
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
              detail: "Daemon accepted shutdown but did not finish cleanup within 10 seconds.",
            }),
          ),
      }),
    );
    return true;
  },
  Effect.catchTag("PlatformError", () =>
    Effect.fail(new DaemonUnavailable({ detail: "Could not confirm daemon shutdown cleanup." })),
  ),
);

// Only a missing/refused socket means there is no daemon. Other failures remain visible.
export const shutdown = Effect.fn("daemon.shutdown")(function* (dataDir: string) {
  const path = yield* Path.Path;
  yield* validateSocketPath(path.join(dataDir, "forman.sock"));
  const opened = yield* Effect.result(open(path.join(dataDir, "forman.sock"))).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new DaemonUnavailable({
            detail: `Could not connect to daemon within 10 seconds: ${path.join(dataDir, "forman.sock")}. Inspect the daemon process and ${path.join(dataDir, "logs/daemon.jsonl")}; no Shutdown request was sent.`,
          }),
        ),
    }),
  );
  if (opened._tag === "Failure") {
    if (absent(opened.failure)) return false;
    return yield* new DaemonUnavailable({
      detail: `Could not connect to daemon socket: ${path.join(dataDir, "forman.sock")}`,
    });
  }
  return yield* stopConnected(dataDir, opened.success.socket, opened.success.reader);
}, Effect.scoped);
