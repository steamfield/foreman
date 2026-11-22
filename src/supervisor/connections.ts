/**
 * One lazily started connection per provider, and what happens when one goes away.
 *
 * A connection starts on first use and gets a new generation each time; runs and held
 * questions are tied to the generation they used. When a connection ends unexpectedly, every
 * active run on it becomes lost. A deliberate close (retirement or daemon shutdown) loses
 * nothing more. Each child's stderr is redacted into a per-provider log under the home.
 */
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  type FileSystem,
  Path,
  type PlatformError,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { AppConfig } from "../config";
import { AgyUnavailable, CodexUnavailable } from "../errors";
import { causeFields, makeLogAppender } from "../logging";
import { type CodexRequirements, makeCodexProvider } from "../providers/codex/provider";
import type {
  Capabilities,
  Inbound,
  Provider,
  ProviderConnection,
  ProviderId,
  ProviderUnavailable,
  QuestionCall,
} from "../providers/contract";
import { providerOf, type RunRecord } from "../schemas/daemon";
import type { Registry } from "./registry";
import { stderrSink } from "./stderr-log";

/** A started provider connection and the scope that owns its child process. */
export interface LiveConnection extends ProviderConnection {
  readonly scope: Scope.Closeable;
}

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** Applies one routed notification; a failure ends the connection's supervision. */
export type InboundHandler = (
  connection: LiveConnection,
  inbound: Inbound,
) => Effect.Effect<void, unknown, Services>;
/** Takes one held question call; a failure ends the connection's supervision. */
export type QuestionHandler = (
  connection: LiveConnection,
  call: QuestionCall,
) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;

/** How the supervisor names and logs one provider. */
interface Registration {
  readonly provider: Provider<CodexRequirements>;
  readonly displayName: string;
  /** The stderr log, relative to the home. */
  readonly stderrLog: string;
  readonly unavailable: (detail: string) => ProviderUnavailable;
}

const RETIRED = "app server retired after unconfirmed execution";

function lossReason(cause: Cause.Cause<unknown>): string {
  const error = cause.reasons.find(Cause.isFailReason)?.error;
  if (error instanceof CodexUnavailable || error instanceof AgyUnavailable)
    return error.detail ?? "app server unavailable";
  return "app server supervision failed";
}

/** The lifecycle of one provider's connection: start, loss, retirement and diagnostics. */
const makeSlot = Effect.fnUntraced(function* (
  config: AppConfig["Service"],
  registration: Registration,
  registry: Registry,
  inbound: InboundHandler,
  question: QuestionHandler,
) {
  const owner = yield* Effect.scope;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const lock = yield* Semaphore.make(1);
  const path = yield* Path.Path;
  const logFile = path.join(config.home, registration.stderrLog);
  const append = yield* makeLogAppender(logFile);
  let stderrWarning: string | undefined;
  let current: LiveConnection | undefined;
  const cleanup = new WeakMap<LiveConnection, Effect.Effect<void>>();
  const closedDeliberately = new WeakSet<LiveConnection>();

  const close = Effect.fnUntraced(function* (live: LiveConnection) {
    yield* Scope.close(live.scope, Exit.void);
    const completed = cleanup.get(live);
    if (completed) yield* completed;
  });

  const loseRuns = Effect.fnUntraced(function* (live: LiveConnection, cause: Cause.Cause<unknown>) {
    const affected = [...registry.runs.values()].filter(
      (run) => run.serverGeneration === live.generation,
    );
    const reason = lossReason(cause);
    yield* Effect.logError("supervisor.appServer.ended").pipe(
      Effect.annotateLogs({
        names: affected.map((run) => run.record.name).join(", "),
        ...causeFields(cause),
        lossReason: reason,
      }),
    );
    yield* close(live);
    for (const run of affected)
      yield* registry.enqueue(
        run,
        Effect.gen(function* () {
          if (run.serverGeneration === live.generation && registry.isCurrent(run))
            yield* registry.lost(run, reason);
        }),
      );
  });

  const ended = Effect.fnUntraced(function* (live: LiveConnection, cause: Cause.Cause<unknown>) {
    if (current !== live) return;
    current = undefined;
    if (Cause.hasInterruptsOnly(cause) || closedDeliberately.has(live)) return;
    yield* loseRuns(live, cause);
  });

  // Reported once per child: a log that can't be written is a warning on every run using it.
  const stderrUnavailable = (generation: () => symbol | undefined) =>
    Effect.fnUntraced(function* (error: PlatformError.PlatformError) {
      if (stderrWarning !== undefined) return;
      const warning = `${registration.displayName} stderr log ${logFile} is unavailable (${error.reason.method}: ${error.reason._tag}). Check the path and directory permissions before relying on this log.`;
      stderrWarning = warning;
      yield* Effect.logWarning("supervisor.appServer.stderr.unavailable").pipe(
        Effect.annotateLogs({
          path: logFile,
          reason: error.reason._tag,
          method: error.reason.method,
        }),
      );
      for (const run of registry.runs.values()) {
        if (run.serverGeneration !== generation()) continue;
        yield* registry.enqueue(
          run,
          Effect.gen(function* () {
            if (registry.isCurrent(run) && !run.record.warnings.includes(warning))
              yield* registry.save(run, { warnings: [...run.record.warnings, warning] });
          }),
        );
      }
    }, Effect.provide(context));

  const superviseStreams = Effect.fnUntraced(function* (live: LiveConnection) {
    yield* live.inbound.pipe(
      Stream.runForEach((message) => inbound(live, message)),
      Effect.matchCauseEffect({
        onFailure: (cause) => ended(live, cause),
        onSuccess: () => live.termination.pipe(Effect.flatMap((cause) => ended(live, cause))),
      }),
      registry.fork,
    );
    yield* live.questions.pipe(
      Stream.runForEach((call) => question(live, call)),
      Effect.catchCause((cause) => ended(live, cause)),
      registry.fork,
    );
  });

  const start = Effect.gen(function* () {
    stderrWarning = undefined;
    const scope = yield* Scope.fork(owner);
    const completed = yield* Deferred.make<void>();
    // Registered before the process resources, so this runs after their finalizers.
    yield* Scope.addFinalizer(scope, Deferred.succeed(completed, undefined));
    let generation: symbol | undefined;
    const unavailable = stderrUnavailable(() => generation);
    const connection = yield* registration.provider
      .connect(stderrSink((text) => append(text).pipe(Effect.catch(unavailable))))
      .pipe(
        Scope.provide(scope),
        // A failed start closes the child it may have launched.
        Effect.tapCause((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
    generation = connection.generation;
    const live: LiveConnection = { ...connection, scope };
    // Registered last, so it runs first: the streams then see a deliberate close.
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => closedDeliberately.add(live)),
    );
    cleanup.set(live, Deferred.await(completed));
    current = live;
    yield* superviseStreams(live);
    return live;
  });

  return {
    capabilities: registration.provider.capabilities,
    displayName: registration.displayName,
    get: lock.withPermits(1)(Effect.suspend(() => (current ? Effect.succeed(current) : start))),
    retire: (live: LiveConnection) =>
      ended(live, Cause.fail(registration.unavailable(RETIRED))).pipe(
        Effect.andThen(close(live)),
        Effect.provide(context),
      ),
    compatibilityWarning: registration.provider.compatibilityWarning,
    environment: registration.provider.environment,
    warnings: Effect.sync(() => (stderrWarning === undefined ? [] : [stderrWarning])),
  };
});

type Slot = Effect.Success<ReturnType<typeof makeSlot>>;

/**
 * Builds the provider connections. Only Codex is registered; `get` starts a provider's
 * connection on first use and returns the live one after that.
 */
export const makeConnections = Effect.fn("supervisor.connections")(function* (
  config: AppConfig["Service"],
  version: string,
  registry: Registry,
  inbound: InboundHandler,
  question: QuestionHandler,
) {
  const codex = yield* makeCodexProvider({
    codexBin: config.codexBin,
    inheritedEnvironment: config.inheritedEnvironment,
    version,
  });
  const slots: Partial<Record<ProviderId, Slot>> = {
    codex: yield* makeSlot(
      config,
      {
        provider: codex,
        displayName: "Codex",
        stderrLog: "logs/app-server.log",
        unavailable: (detail) => new CodexUnavailable({ detail }),
      },
      registry,
      inbound,
      question,
    ),
  };
  const slot = (provider: ProviderId) => {
    const found = slots[provider];
    // Runs are only ever created for registered providers, so a miss is a bug.
    return found === undefined
      ? Effect.die(new Error(`No ${provider} provider is registered in this daemon`))
      : Effect.succeed(found);
  };
  const get = (provider: ProviderId) => slot(provider).pipe(Effect.flatMap((found) => found.get));
  return {
    get,
    /** The connection for the run's provider, started if needed. */
    forRun: (run: { readonly record: RunRecord }) => get(providerOf(run.record)),
    retire: (live: LiveConnection) =>
      slot(live.provider).pipe(Effect.flatMap((found) => found.retire(live))),
    capabilities: (provider: ProviderId): Effect.Effect<Capabilities> =>
      slot(provider).pipe(Effect.map((found) => found.capabilities)),
    displayName: (provider: ProviderId) =>
      slot(provider).pipe(Effect.map((found) => found.displayName)),
    compatibilityWarning: (provider: ProviderId) =>
      slot(provider).pipe(Effect.flatMap((found) => found.compatibilityWarning)),
    environment: (provider: ProviderId) =>
      slot(provider).pipe(Effect.flatMap((found) => found.environment)),
    warnings: (provider: ProviderId) =>
      slot(provider).pipe(Effect.flatMap((found) => found.warnings)),
  };
});

/** The supervisor's provider connections. */
export type Connections = Effect.Success<ReturnType<typeof makeConnections>>;
