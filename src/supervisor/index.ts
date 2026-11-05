import { Cause, Effect, type FileSystem, type Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { AppConfig } from "../config";
import * as Store from "../core/runs/store";
import { failure } from "../errors";
import * as Codex from "../schemas/codex";
import type { DaemonRequestBody, DaemonResult } from "../schemas/daemon";
import { Host } from "../services/host";
import { type AppServer, makeAppServer } from "./app-server";
import { handleNotification } from "./notifications";
import { makeQuestions } from "./questions";
import { makeRegistry } from "./registry";
import { makeTurns } from "./turns";
import { groupFor, wait } from "./wait";

export const makeSupervisor = Effect.fn("supervisor.make")(function* () {
  const config = yield* AppConfig;
  const host = yield* Host;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const registry = yield* makeRegistry(config.dataDir);
  // Serialize lookup with Start registration: Codex can notify before the Start caller returns.
  const route = (threadId: string) =>
    registry.starts.withPermits(1)(
      Effect.sync(() =>
        [...registry.runs.values()].find((run) => run.record.threadId === threadId),
      ),
    );
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
      return yield* Effect.logDebug("supervisor.notification.unrouted", { method: message.method });
    const run = yield* route(identity.success.threadId);
    if (!run)
      return yield* Effect.logDebug("supervisor.thread.unknown", { method: message.method });
    yield* run.lock.withPermits(1)(handleNotification(registry, turns, run, server, message));
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
    yield* run.lock.withPermits(1)(
      Effect.gen(function* () {
        yield* Store.appendCodexMessage(run.dir, message);
        yield* questions.receive(run, server, message, params.success);
      }),
    );
  });
  const servers = yield* makeAppServer(config, host.version, registry, notification, request);
  const questions = yield* makeQuestions(registry);
  const turns = yield* makeTurns(registry, servers, config);
  const dispatch = Effect.fnUntraced(function* (
    body: DaemonRequestBody,
  ): Effect.fn.Return<
    DaemonResult,
    unknown,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    switch (body._tag) {
      case "Ping":
        return { _tag: "Pong", version: host.version, pid: host.pid };
      case "Start":
        return yield* registry.starts.withPermits(1)(turns.start(body));
      case "Wait":
        return yield* wait(registry, body);
      case "Status": {
        const group = body.name === undefined ? yield* groupFor(body.cwd) : "";
        const runs =
          body.name === undefined
            ? [...registry.runs.values()].filter((run) => run.record.group === group)
            : [yield* registry.lookup(body.name)];
        return {
          _tag: "Digests",
          digests: yield* Effect.forEach(runs, (run) =>
            run.lock.withPermits(1)(registry.digest(run, true)),
          ),
        };
      }
      default: {
        const run = yield* registry.lookup(body.name);
        return yield* run.lock.withPermits(1)(
          Effect.gen(function* (): Effect.fn.Return<
            DaemonResult,
            unknown,
            FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
          > {
            switch (body._tag) {
              case "Events":
                return yield* Store.readEvents(run.dir, body.after, body.limit);
              case "Result":
                return {
                  _tag: "Result",
                  digest: yield* registry.digest(run, true),
                  ...(yield* Store.readHandoff(run.dir, run.record.turns)),
                };
              case "Followup":
                yield* turns.followup(run, body);
                break;
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
            return { _tag: "Ok" };
          }),
        );
      }
    }
  });
  return {
    handler: (body: DaemonRequestBody) =>
      dispatch(body).pipe(
        Effect.provide(context),
        Effect.mapError((error) => failure(Cause.fail(error))),
      ),
    busy: registry.busy,
  };
});
