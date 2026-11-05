import { Effect, Logger, Path, Queue, Stream } from "effect";
import { Command } from "effect/cli";
import { AppConfig } from "../config";
import { daemon } from "../daemon/server";
import { entry } from "../logging";
import { Host } from "../services/host";
import { Invocation } from "../services/invocation";
import { makeSupervisor } from "../supervisor";
import { makeLogAppender } from "../supervisor/app-server";

export const daemonCommand = Command.make(
  "daemon",
  {},
  Effect.fn(function* () {
    yield* Effect.flatMap(Invocation, (invocation) => invocation.named("daemon"));
    const config = yield* AppConfig;
    const host = yield* Host;
    const path = yield* Path.Path;
    const settings = yield* config.logging;
    const append = yield* makeLogAppender(
      settings.file || path.join(config.dataDir, "logs/daemon.jsonl"),
    );
    const records = yield* Queue.unbounded<string>();
    const logger = Logger.make((input) => {
      Queue.offerUnsafe(
        records,
        `${JSON.stringify(entry({ date: input.date, level: input.logLevel, message: input.message }))}\n`,
      );
    });
    yield* Effect.gen(function* () {
      const supervisor = yield* makeSupervisor();
      yield* Effect.raceFirst(
        daemon({ dataDir: config.dataDir, version: host.version, ...supervisor }),
        Stream.fromQueue(records).pipe(Stream.runForEach(append)),
      );
    }).pipe(Effect.provide(Logger.layer([logger])));
  }),
).pipe(Command.withDescription("Run the background supervisor."));
