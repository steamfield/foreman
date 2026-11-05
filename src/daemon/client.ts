import { Effect, FileSystem, Option, Path, Predicate, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Socket } from "effect/socket";
import { DaemonUnavailable, Defect } from "../errors";
import type { DaemonRequestBody } from "../schemas/daemon";
import { Host } from "../services/host";
import { errorFromResponse, lines, requestJson, responseJson } from "./protocol";
import { DaemonSockets } from "./sockets";

export interface CallOptions {
  readonly dataDir: string;
  readonly connectOnly?: boolean;
  readonly startupTimeoutMs?: number;
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
  function* () {
    const host = yield* Host;
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

const connect = Effect.fn("daemon.connect")(
  function* (socketPath: string, options: CallOptions) {
    const sockets = yield* DaemonSockets;
    const open = Effect.gen(function* () {
      const socket = yield* sockets.connect(socketPath);
      const reader = yield* socket.reader;
      return { socket, reader };
    });
    const initial = yield* Effect.result(open);
    if (initial._tag === "Success") return initial.success;
    if (options.connectOnly || !absent(initial.failure)) {
      return yield* new DaemonUnavailable({
        detail: `Could not connect to daemon socket: ${socketPath}`,
      });
    }
    yield* spawn();
    while (true) {
      yield* Effect.sleep(100);
      const attempt = yield* Effect.result(open);
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

const exchange = Effect.fn("daemon.exchange")(
  function* (body: DaemonRequestBody, socket: Socket.Socket, reader: Socket.Reader) {
    const writer = yield* socket.writer;
    const json = yield* Schema.encodeEffect(requestJson)({ id: 1, body });
    yield* writer.write(`${json}\n`);
    const response = yield* lines(reader).pipe(
      Stream.mapEffect((line) => Schema.decodeUnknownEffect(responseJson)(line)),
      Stream.filter((response) => response.id === 1),
      Stream.runHead,
    );
    if (Option.isNone(response)) return yield* new Defect();
    return "error" in response.value
      ? yield* errorFromResponse(response.value.error)
      : response.value.result;
  },
  Effect.catchTag("SocketError", () =>
    Effect.fail(new DaemonUnavailable({ detail: "Daemon connection closed during the request." })),
  ),
  Effect.catchTag("SchemaError", () => Effect.fail(new Defect())),
);

export const call = Effect.fn("daemon.call")(function* (
  body: DaemonRequestBody,
  options: CallOptions,
) {
  const path = yield* Path.Path;
  const { socket, reader } = yield* connect(path.join(options.dataDir, "forman.sock"), options);
  return yield* exchange(body, socket, reader);
}, Effect.scoped);

// Only a missing/refused socket means there is no daemon. Other failures remain visible.
export const shutdown = Effect.fn("daemon.shutdown")(
  function* (dataDir: string) {
    const path = yield* Path.Path;
    const sockets = yield* DaemonSockets;
    const opened = yield* Effect.result(
      Effect.gen(function* () {
        const socket = yield* sockets.connect(path.join(dataDir, "forman.sock"));
        return { socket, reader: yield* socket.reader };
      }),
    );
    if (opened._tag === "Failure") {
      if (absent(opened.failure)) return false;
      return yield* new DaemonUnavailable({
        detail: `Could not connect to daemon socket: ${path.join(dataDir, "forman.sock")}`,
      });
    }
    const fs = yield* FileSystem.FileSystem;
    const lock = path.join(dataDir, "daemon.lock");
    const original = yield* fs
      .stat(lock)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    const result = yield* exchange(
      { _tag: "Shutdown" },
      opened.success.socket,
      opened.success.reader,
    );
    if (result._tag !== "Ok") return yield* new Defect();
    yield* Effect.gen(function* () {
      while (true) {
        const current = yield* fs
          .stat(lock)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
        if (current === null && !(yield* fs.exists(path.join(dataDir, "forman.sock")))) return;
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
  Effect.scoped,
  Effect.catchTag("PlatformError", () =>
    Effect.fail(new DaemonUnavailable({ detail: "Could not confirm daemon shutdown cleanup." })),
  ),
);
