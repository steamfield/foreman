import {
  Cause,
  Deferred,
  Effect,
  Exit,
  type FileSystem,
  Path,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { checkProtocol } from "../codex/check";
import { openConnection } from "../codex/client";
import { appServerEnvironment } from "../codex/environment";
import { supportedCodex } from "../codex/protocol";
import type { AppConfig } from "../config";
import { probeSsh } from "../core/preflight/ssh";
import { CodexUnavailable } from "../errors";
import { causeFields, makeLogAppender, redactDiagnosticText } from "../logging";
import type * as Codex from "../schemas/codex";
import type { Registry } from "./registry";

export type Connection = Effect.Success<ReturnType<typeof openConnection>>;
export interface AppServer {
  readonly generation: symbol;
  readonly scope: Scope.Closeable;
  readonly connection: Connection;
  readonly loaded: Set<string>;
}

export const makeAppServer = Effect.fn("supervisor.appServer")(function* (
  config: AppConfig["Service"],
  version: string,
  registry: Registry,
  notify: (
    server: AppServer,
    message: typeof Codex.RpcNotification.Type,
  ) => Effect.Effect<
    void,
    unknown,
    | FileSystem.FileSystem
    | Path.Path
    | import("effect/process").ChildProcessSpawner.ChildProcessSpawner
  >,
  request: (
    server: AppServer,
    message: typeof Codex.RpcServerRequest.Type,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>,
) {
  const owner = yield* Effect.scope;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const lock = yield* Semaphore.make(1);
  const path = yield* Path.Path;
  const append = yield* makeLogAppender(path.join(config.home, "logs/app-server.log"));
  let stderrWarning: string | undefined;
  const env = yield* Effect.cached(
    probeSsh(config.inheritedEnvironment).pipe(
      Effect.map((ssh) => appServerEnvironment(config.inheritedEnvironment, ssh)),
    ),
  );
  const protocolWarning = yield* Effect.cached(
    Effect.gen(function* () {
      const result = yield* checkProtocol(config.codexBin, yield* env).pipe(
        Effect.scoped,
        Effect.timeout("5 seconds"),
        Effect.result,
      );
      const action = `Install Codex ${supportedCodex.version} or correct CODEX_BIN, then run foreman doctor to check compatibility.`;
      if (result._tag === "Failure")
        return `Could not check the Codex protocol for ${JSON.stringify(config.codexBin)}: ${result.failure instanceof CodexUnavailable ? result.failure.detail : "probe timed out after 5 seconds"}. ${action}`;
      return result.success.matches
        ? null
        : `Codex protocol differs from the supported version for ${JSON.stringify(config.codexBin)}; compatibility is unverified. ${action}`;
    }),
  );
  let current: AppServer | undefined;
  const cleanup = new WeakMap<AppServer, Effect.Effect<void>>();
  const close = Effect.fnUntraced(function* (server: AppServer) {
    yield* Scope.close(server.scope, Exit.void);
    const completed = cleanup.get(server);
    if (completed) yield* completed;
  });
  const disconnected = Effect.fnUntraced(function* (
    server: AppServer,
    cause: Cause.Cause<unknown>,
  ) {
    if (current !== server) return;
    current = undefined;
    const error = cause.reasons.find(Cause.isFailReason)?.error;
    if (
      Cause.hasInterruptsOnly(cause) ||
      (error instanceof CodexUnavailable && error.detail === "app server connection closed")
    )
      return;
    const affected = [...registry.runs.values()].filter(
      (run) => run.serverGeneration === server.generation,
    );
    const reason =
      error instanceof CodexUnavailable
        ? (error.detail ?? "app server unavailable")
        : "app server supervision failed";
    yield* Effect.logError("supervisor.appServer.ended").pipe(
      Effect.annotateLogs({
        names: affected.map((run) => run.record.name).join(", "),
        ...causeFields(cause),
        lossReason: reason,
      }),
    );
    yield* close(server);
    for (const run of affected)
      yield* registry.enqueue(
        run,
        Effect.gen(function* () {
          if (run.serverGeneration === server.generation && registry.isCurrent(run))
            yield* registry.lost(run, reason);
        }),
      );
  });
  const get = lock.withPermits(1)(
    Effect.gen(function* () {
      if (current) return current;
      stderrWarning = undefined;
      const generation = Symbol();
      const scope = yield* Scope.fork(owner);
      const completed = yield* Deferred.make<void>();
      // Registered before the process resources, so this runs after their finalizers.
      yield* Scope.addFinalizer(scope, Deferred.succeed(completed, undefined));
      let privateKeyBlock = false;
      const opened = yield* openConnection({
        codexBin: config.codexBin,
        env: yield* env,
        version,
        stderr: (line) => {
          if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(line)) privateKeyBlock = true;
          const redacted = privateKeyBlock ? "[redacted private key]" : redactDiagnosticText(line);
          if (/-----END [^-]*PRIVATE KEY-----/.test(line)) privateKeyBlock = false;
          return append(`${redacted}\n`).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (stderrWarning !== undefined) return;
                const warning = `Codex stderr log ${path.join(config.home, "logs/app-server.log")} is unavailable (${error.reason.method}: ${error.reason._tag}). Check the path and directory permissions before relying on this log.`;
                stderrWarning = warning;
                yield* Effect.logWarning("supervisor.appServer.stderr.unavailable").pipe(
                  Effect.annotateLogs({
                    path: path.join(config.home, "logs/app-server.log"),
                    reason: error.reason._tag,
                    method: error.reason.method,
                  }),
                );
                for (const run of registry.runs.values()) {
                  if (run.serverGeneration === generation)
                    yield* registry.enqueue(
                      run,
                      Effect.gen(function* () {
                        if (registry.isCurrent(run) && !run.record.warnings.includes(warning))
                          yield* registry.save(run, {
                            warnings: [...run.record.warnings, warning],
                          });
                      }),
                    );
                }
              }).pipe(Effect.provide(context)),
            ),
          );
        },
      }).pipe(
        Scope.provide(scope),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
      );
      const rpcRequest: Connection["request"] = (method, params, schema, options) =>
        opened.request(method, params, schema, options).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.fail(
              new CodexUnavailable({
                detail: `Codex reply to ${method} did not match the supported protocol; run foreman doctor and check the Codex version.`,
              }),
            ),
          ),
        );
      const connection = { ...opened, request: rpcRequest };
      const server: AppServer = { connection, generation, scope, loaded: new Set() };
      cleanup.set(server, Deferred.await(completed));
      current = server;
      yield* connection.notifications.pipe(
        Stream.runForEach((message) => notify(server, message)),
        Effect.matchCauseEffect({
          onFailure: (cause) => disconnected(server, cause),
          onSuccess: () =>
            connection.termination.pipe(Effect.flatMap((cause) => disconnected(server, cause))),
        }),
        registry.fork,
      );
      yield* connection.serverRequests.pipe(
        Stream.runForEach((message) => request(server, message)),
        Effect.catchCause((cause) => disconnected(server, cause)),
        registry.fork,
      );
      return server;
    }),
  );
  const retire = (server: AppServer) =>
    disconnected(
      server,
      Cause.fail(
        new CodexUnavailable({ detail: "app server retired after unconfirmed execution" }),
      ),
    ).pipe(Effect.andThen(close(server)), Effect.provide(context));
  return {
    get,
    retire,
    protocolWarning,
    warnings: Effect.sync(() => (stderrWarning === undefined ? [] : [stderrWarning])),
    environment: env,
  };
});
export type AppServers = Effect.Success<ReturnType<typeof makeAppServer>>;
