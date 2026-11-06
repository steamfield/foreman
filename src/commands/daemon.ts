import { type Cause, Effect, Fiber, Logger, Path, Queue, References, Stream } from "effect";
import { Command } from "effect/cli";
import { AppConfig } from "../config";
import { shutdown } from "../daemon/client";
import { daemon } from "../daemon/server";
import { entry, makeLogAppender } from "../logging";
import { Host } from "../services/host";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";
import { makeSupervisor } from "../supervisor";

const stopCommand = Command.make(
  "stop",
  {},
  Effect.fn(function* () {
    yield* Effect.flatMap(Invocation, (invocation) => invocation.named("daemon stop"));
    const config = yield* AppConfig;
    const stopped = yield* shutdown(config.home);
    yield* (yield* Output).result(
      { _tag: "Ok" },
      stopped ? "Daemon stopped." : "Daemon: not running.",
    );
  }),
).pipe(Command.withDescription("Stop an inactive daemon without starting one."));

export const withDaemonLogging = Effect.fn("daemon.logging")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const config = yield* AppConfig;
  const path = yield* Path.Path;
  const settings = yield* config.logging;
  const append = yield* makeLogAppender(
    settings.file || path.join(config.home, "logs/daemon.jsonl"),
  );
  const records = yield* Queue.unbounded<string, Cause.Done>();
  const output = yield* Output;
  let sinkUnavailable = false;
  const write = (line: string) =>
    sinkUnavailable
      ? Effect.void
      : append(line).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              sinkUnavailable = true;
              yield* output
                .note("Daemon log file unavailable; continuing without file logging.")
                .pipe(Effect.ignoreCause);
            }),
          ),
        );
  const logger = Logger.make((input) => {
    Queue.offerUnsafe(
      records,
      `${JSON.stringify(
        entry({
          date: input.date,
          level: input.logLevel,
          message: input.message,
          annotations: input.fiber.getRef(References.CurrentLogAnnotations),
        }),
      )}\n`,
    );
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const writer = yield* Stream.fromQueue(records).pipe(
        Stream.runForEach(write),
        Effect.forkScoped,
      );
      return yield* program.pipe(
        Effect.ensuring(Queue.end(records).pipe(Effect.andThen(Fiber.join(writer)))),
      );
    }),
  ).pipe(
    Effect.provide(Logger.layer([logger])),
    // Daemon lifecycle records must survive the CLI's default Warn threshold.
    Effect.provideService(
      References.MinimumLogLevel,
      settings.level === "Warn" ? "Info" : settings.level,
    ),
  );
});

export const daemonCommand = Command.make(
  "daemon",
  {},
  Effect.fn(function* () {
    yield* Effect.flatMap(Invocation, (invocation) => invocation.named("daemon"));
    yield* withDaemonLogging(
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* AppConfig;
          const host = yield* Host;
          const supervisor = yield* makeSupervisor();
          yield* Effect.raceFirst(
            supervisor.failed,
            daemon({
              dataDir: config.home,
              version: host.version,
              codexBin: config.codexBin,
              codexHome: config.codexHome,
              ...supervisor,
            }),
          );
        }),
      ),
    );
  }),
).pipe(
  Command.withDescription("Run the background supervisor."),
  Command.withSubcommands([stopCommand]),
);
