import { Effect, Option, Path, Predicate, Schema, Stream } from "effect";
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

export const call = Effect.fn("daemon.call")(
  function* (body: DaemonRequestBody, options: CallOptions) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { socket, reader } = yield* connect(
          path.join(options.dataDir, "forman.sock"),
          options,
        );
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
      }),
    );
  },
  Effect.catchTag("SocketError", () =>
    Effect.fail(new DaemonUnavailable({ detail: "Daemon connection closed during the request." })),
  ),
  Effect.catchTag("SchemaError", () => Effect.fail(new Defect())),
);
