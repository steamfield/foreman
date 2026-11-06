import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  type FileSystem,
  type Path,
  PlatformError,
  Predicate,
  Schema,
  Scope,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { CodexRequestTimeout, CodexRpcError } from "../codex/client";
import { AppConfig } from "../config";
import * as Store from "../core/runs/store";
import { CodexUnavailable, failure, RunConflict } from "../errors";
import { defectTrace } from "../logging";
import * as Codex from "../schemas/codex";
import { activeStates, type DaemonRequestBody, type DaemonResult } from "../schemas/daemon";
import { Host } from "../services/host";
import { type AppServer, makeAppServer } from "./app-server";
import { handleNotification } from "./notifications";
import { makeQuestions } from "./questions";
import { makeRegistry } from "./registry";
import { makeTurns } from "./turns";
import { acceptedCursor, groupFor, wait } from "./wait";

const requestFailure = (error: unknown) => {
  if (error instanceof CodexRequestTimeout)
    return new CodexUnavailable({
      detail: `${error.method} timed out after ${error.timeoutMs} ms`,
    });
  if (error instanceof CodexRpcError)
    return new RunConflict({
      detail:
        "Codex refused the request; check the requested model and settings, then read status before retrying.",
    });
  if (PlatformError.isPlatformError(error))
    return new RunConflict({
      detail: `Daemon answered, but cannot access run data or a required process (${error.reason._tag}); check the data directory, file permissions and installed commands.`,
    });
  if (Schema.isSchemaError(error))
    return new RunConflict({
      detail:
        "Daemon answered, but cannot decode run data; inspect the run directory for damaged records before retrying.",
    });
  return failure(Cause.fail(error));
};

const rejectRequest = Effect.fnUntraced(function* (
  body: DaemonRequestBody,
  cause: Cause.Cause<unknown>,
) {
  if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
  const error = cause.reasons.find(Cause.isFailReason)?.error;
  const platform = PlatformError.isPlatformError(error) ? error.reason : undefined;
  let reasonTag = "Unknown";
  if (Cause.hasDies(cause)) reasonTag = "Defect";
  else if (Predicate.hasProperty(error, "_tag") && typeof error._tag === "string")
    reasonTag = error._tag;
  yield* Effect.logError("supervisor.request.failed").pipe(
    Effect.annotateLogs({
      request: body._tag,
      name: "name" in body ? body.name : null,
      reasonTag,
      method: platform?.method ?? null,
      path: platform && "pathOrDescriptor" in platform ? (platform.pathOrDescriptor ?? null) : null,
      ...(Cause.hasDies(cause) ? { trace: defectTrace(Cause.squash(cause)) } : {}),
    }),
  );
  return yield* Effect.fail(Cause.hasDies(cause) ? failure(cause) : requestFailure(error));
});

const buildSupervisor = Effect.fn("supervisor.build")(function* () {
  const config = yield* AppConfig;
  const host = yield* Host;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const registry = yield* makeRegistry(config.home);
  // threadId is saved before turn/start; the run lock orders its reply and early notifications.
  const route = (threadId: string) =>
    Effect.sync(() => [...registry.runs.values()].find((run) => run.record.threadId === threadId));
  const notification = Effect.fnUntraced(function* (
    server: AppServer,
    message: typeof Codex.RpcNotification.Type,
  ): Effect.fn.Return<
    void,
    unknown,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    const identity = yield* Schema.decodeUnknownEffect(Schema.Struct({ threadId: Schema.String }))(
      message.params,
    ).pipe(Effect.result);
    if (identity._tag === "Failure")
      return yield* Effect.logDebug("supervisor.notification.unrouted").pipe(
        Effect.annotateLogs({ method: message.method }),
      );
    const run = yield* route(identity.success.threadId);
    if (!run)
      return yield* Effect.logDebug("supervisor.thread.unknown").pipe(
        Effect.annotateLogs({ method: message.method }),
      );
    yield* registry.enqueue(
      run,
      Effect.suspend(() =>
        registry.isCurrent(run)
          ? handleNotification(registry, turns, run, server, message)
          : Effect.void,
      ),
    );
  });
  const request = Effect.fnUntraced(function* (
    server: AppServer,
    message: typeof Codex.RpcServerRequest.Type,
  ) {
    if (message.method !== Codex.Method.toolCall)
      return yield* server.connection.respondError(message.id, -32601, "unsupported method");
    const params = yield* Schema.decodeUnknownEffect(Codex.ToolCallParams)(message.params).pipe(
      Effect.result,
    );
    if (params._tag === "Failure")
      return yield* server.connection.respondError(message.id, -32602, "invalid tool call");
    const run = yield* route(params.success.threadId);
    if (!run) return yield* server.connection.respondError(message.id, -32601, "unknown thread");
    yield* registry.enqueue(
      run,
      Effect.gen(function* () {
        if (!registry.isCurrent(run))
          return yield* server.connection.respondError(message.id, -32601, "unknown thread");
        yield* Store.appendCodexMessage(run.dir, message);
        yield* questions.receive(run, server, message, params.success);
      }),
    );
  });
  const servers = yield* makeAppServer(config, host.version, registry, notification, request);
  const questions = yield* makeQuestions(registry);
  const turns = yield* makeTurns(registry, servers, config);
  let stopping = false;
  const acceptingStarts = Effect.gen(function* () {
    if (stopping)
      return yield* new RunConflict({ detail: "Daemon is stopping; retry after it exits." });
  });
  const dispatch = Effect.fnUntraced(function* (
    body: DaemonRequestBody,
  ): Effect.fn.Return<
    DaemonResult,
    unknown,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    switch (body._tag) {
      case "Shutdown":
        return yield* registry.starts.withPermits(1)(
          Effect.gen(function* () {
            const active = [...registry.runs.values()]
              .filter((run) => activeStates.has(run.record.state))
              .map((run) => run.record.name);
            if (active.length > 0)
              return yield* new RunConflict({ detail: `Active runs: ${active.join(", ")}` });
            stopping = true;
            return { _tag: "Ok" as const };
          }),
        );
      case "Start":
        return yield* turns.start(body, acceptingStarts);
      case "Followup": {
        const run = yield* registry.lookup(body.name);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* run.lock.takeScoped(1);
            const threadId = yield* registry.starts.withPermits(1)(
              Effect.gen(function* () {
                yield* acceptingStarts;
                yield* registry.requireCurrent(run);
                return yield* turns.reserveFollowup(run);
              }),
            );
            yield* turns
              .followup(run, body, threadId)
              .pipe(Effect.tapCause((cause) => registry.recover(run, cause)));
            return { _tag: "Accepted" as const, cursor: yield* acceptedCursor(run) };
          }),
        );
      }
      case "Wait":
        return yield* wait(registry, body);
      case "Archive":
        return yield* registry.archive(body.name);
      case "Status": {
        const group = body.name === undefined ? yield* groupFor(body.cwd) : "";
        const runs =
          body.name === undefined
            ? [...registry.runs.values()].filter((run) => run.record.group === group)
            : [yield* registry.lookup(body.name)];
        return {
          _tag: "Digests",
          digests: (yield* Effect.forEach(runs, (run) =>
            run.lock.withPermits(1)(
              Effect.gen(function* () {
                if (body.name === undefined && !registry.isCurrent(run)) return [];
                return [yield* registry.digest(run, true)];
              }),
            ),
          )).flat(),
        };
      }
      default: {
        if (!("name" in body)) return yield* Effect.die("Supervisor received an unhandled request");
        const run = yield* registry.lookup(body.name);
        return yield* run.lock.withPermits(1)(
          Effect.gen(function* (): Effect.fn.Return<
            DaemonResult,
            unknown,
            FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
          > {
            yield* registry.requireCurrent(run);
            switch (body._tag) {
              case "Events":
                return yield* Store.readEvents(run.dir, body.after, body.limit);
              case "Result": {
                const handoff = yield* Store.readHandoff(run.dir, run.record.turns);
                return {
                  _tag: "Result",
                  digest: yield* registry.digest(run, true),
                  ...handoff,
                  latestTurnWithoutHandoff:
                    !activeStates.has(run.record.state) && handoff.latestTurnWithoutHandoff,
                };
              }
              case "Steer":
                yield* turns.steer(run, body.message);
                break;
              case "Interrupt":
                yield* turns.interrupt(run, yield* servers.get, "orchestrator");
                break;
              case "Answer":
                yield* questions.resolve(
                  run,
                  yield* servers.get,
                  body.question,
                  body.text,
                  "answered",
                );
                break;
            }
            return { _tag: "Accepted", cursor: yield* acceptedCursor(run) };
          }),
        );
      }
    }
  });
  return {
    handler: (body: DaemonRequestBody) =>
      Effect.gen(function* () {
        const work = dispatch(body).pipe(
          Effect.catchCause((cause) => rejectRequest(body, cause)),
          Effect.provide(context),
        );
        if (body._tag === "Start" || body._tag === "Followup") {
          const exit = yield* Fiber.join(yield* registry.fork(Effect.exit(work)));
          return Exit.isFailure(exit) ? yield* Effect.failCause(exit.cause) : exit.value;
        }
        return yield* work;
      }),
    busy: registry.busy,
    failed: registry.failed.pipe(Effect.mapError((error) => failure(Cause.fail(error)))),
  };
});

// daemon() calls busy only after it owns the socket lock. A losing launcher must not rebuild runs.
export const makeSupervisor = Effect.fn("supervisor.make")(function* () {
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<
    AppConfig | Host | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const ready = yield* Deferred.make<Effect.Success<ReturnType<typeof buildSupervisor>>, unknown>();
  const initialize = yield* Effect.cached(
    buildSupervisor().pipe(
      Effect.provide(context),
      Scope.provide(scope),
      Effect.tap((value) => Deferred.succeed(ready, value)),
      Effect.tapCause((cause) => Deferred.failCause(ready, cause)),
    ),
  );
  return {
    handler: (body: DaemonRequestBody) =>
      initialize.pipe(
        Effect.catchCause((cause) => rejectRequest(body, cause)),
        Effect.flatMap((value) => value.handler(body)),
      ),
    busy: initialize.pipe(
      Effect.flatMap((value) => value.busy),
      Effect.orDie,
    ),
    failed: Deferred.await(ready).pipe(
      Effect.flatMap((value) => value.failed),
      Effect.mapError((error) => failure(Cause.fail(error))),
    ),
  };
});
