import {
  Cause,
  Clock,
  Effect,
  Fiber,
  Logger,
  Path,
  PlatformError,
  Predicate,
  Queue,
  References,
  Stream,
} from "effect";
import { Command } from "effect/cli";
import { AppConfig } from "../config";
import { shutdown } from "../daemon/client";
import { daemon } from "../daemon/server";
import { DaemonUnavailable } from "../errors";
import { defectTrace, entry, makeLogAppender } from "../logging";
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
  const file = settings.file || path.join(config.home, "logs/daemon.jsonl");
  const append = yield* makeLogAppender(file);
  const records = yield* Queue.unbounded<string, Cause.Done>();
  const output = yield* Output;
  let sinkUnavailable = false;
  const write = (line: string) =>
    sinkUnavailable
      ? Effect.void
      : append(line).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              sinkUnavailable = true;
              const warning = entry({
                date: new Date(yield* Clock.currentTimeMillis),
                level: "warn",
                message: `Daemon log file unavailable: ${file} (${error.reason._tag}). Check the path and directory permissions; continuing without file logging.`,
              });
              yield* output
                .note(output.json ? JSON.stringify(warning) : warning.msg)
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
        Effect.tapCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void;
          const error = cause.reasons.find(Cause.isFailReason)?.error;
          const platform = PlatformError.isPlatformError(error) ? error.reason : undefined;
          return Effect.logError("daemon.failed").pipe(
            Effect.annotateLogs({
              reason:
                platform?._tag ??
                (Predicate.hasProperty(error, "_tag") && typeof error._tag === "string"
                  ? error._tag
                  : "Defect"),
              method: platform?.method ?? null,
              path: platform && "pathOrDescriptor" in platform ? platform.pathOrDescriptor : null,
              ...(error instanceof DaemonUnavailable ? { operationDetail: error.detail } : {}),
              ...(Cause.hasDies(cause) ? { trace: defectTrace(Cause.squash(cause)) } : {}),
            }),
          );
        }),
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
  Command.withDescription("Run the supervisor in the foreground (normally started automatically)."),
  Command.withSubcommands([stopCommand]),
);
