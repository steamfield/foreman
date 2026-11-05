Verified against effect 4.1.2

# Effect API reference

Names below were checked against the installed declarations (`node_modules/effect/dist/**/*.d.ts`, `@effect/platform-bun`, `@effect/platform-node`, `@effect/vitest`, all 4.1.2) and type-checked in a scratch probe. Signatures are not frozen here: open the `.d.ts` for the exact overloads. Where the project already uses an API, the entry points at the file instead of repeating it.

Packages in use: `effect` (core, `effect/cli`, `effect/process`, `effect/socket`, `effect/encoding`, `effect/testing`), `@effect/platform-bun` (runtime), `@effect/platform-node` (tests), `@effect/vitest`. Schema, CLI, child processes, sockets, RPC and MCP all ship inside `effect`; there is no `@effect/schema`, `@effect/cli` or `@effect/platform` to install.

## Imports

| What | Import |
| --- | --- |
| Core modules (`Effect`, `Layer`, `Context`, `Schema`, `Config`, `Queue`, `Stream`, ...) | `import { Effect, Layer } from "effect"` |
| Platform services (`FileSystem`, `Path`, `Stdio`, `Terminal`, `PlatformError`) | `"effect"` (they moved out of `@effect/platform`) |
| CLI | `import { Command, Flag, Argument, CliError, CliConfig, CliOutput, GlobalFlag } from "effect/cli"` |
| Child processes | `import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process"` |
| Sockets | `import { Socket, SocketServer } from "effect/socket"` |
| NDJSON framing | `import { Ndjson } from "effect/encoding"` |
| Test services | `import { TestClock, TestConsole } from "effect/testing"` |
| Bun implementations | `import { BunServices, BunRuntime, BunSocket, BunSocketServer, BunStream } from "@effect/platform-bun"` |
| Node implementations (tests) | `import { NodeServices, NodeSocketServer } from "@effect/platform-node"` |

Resolve through the package `exports` map (`effect/<module>` or a subpath barrel), never `effect/dist/...`.

## Services and layers

- **Service class**: `class X extends Context.Service<X, Shape>()("app/X") {}`. The string is the runtime identity; keep it unique. Examples: `src/services/host.ts`, `src/services/output.ts`, `src/config.ts`. `X.of(impl)` types an implementation, `X.use((x) => ...)` and `X.useSync` access it, `X["Service"]` is the shape type, and the class itself is yieldable (`yield* X`).
- **Constructor on the class**: `Context.Service<X, Shape>()("app/X", { make: effect })` adds a static `X.make`; wire it with `Layer.effect(X, X.make)`.
- **Static layers**: by convention `static layer = Layer.effect(X, Effect.gen(...))`, `Layer.succeed(X, value)` or `Layer.sync(X, () => value)`. A function returning a layer (`static layer = (args) => ...`) is fine when the layer needs inputs (`src/services/host.ts`).
- **References with defaults**: `Context.Reference<A>("app/Key", { defaultValue: () => a })`. Read with `yield* Ref` or `Effect.service(Ref)`, override with `Effect.provideService(Ref, value)`. This replaces `FiberRef`.
- **Composition**: `Layer.mergeAll(a, b)`, `Layer.provide(dep)` (hides the dependency), `Layer.provideMerge(dep)` (keeps it in the output). `src/runtime.ts` builds `AppLayer` this way.
- **Scoped resources**: `Layer.effect` runs its effect in the layer's scope, so `Effect.acquireRelease(acquire, release)` and `Effect.addFinalizer((exit) => ...)` inside it release when the layer is torn down. There is no `Layer.scoped`.
- **Background work in a layer**: `Layer.effectDiscard(Effect.forkScoped(loop))`. The fiber lives as long as the layer.
- **Dynamic layers**: `Layer.unwrap(effectReturningLayer)`.
- **Memoization**: one layer value is built once per build, however many times it appears. `Layer.fresh(layer)` gives each use its own instance. `tests/effect-testkit.test.ts` demonstrates both.
- **Whole app as a layer**: `Layer.launch(layer)` returns an `Effect<never>` that keeps the layer alive until interrupted; a good shape for the daemon.
- **Bridging to non-Effect code**: `ManagedRuntime.make(layer)` then `runtime.runPromise(...)`, `runtime.dispose()`.
- **Test doubles**: `Layer.mock(X, partialImpl)` for partial services.

## Errors

- **Tagged errors**: `class E extends Schema.TaggedError<E>()("E", { field: Schema.String }) {}` (`src/errors.ts`). `Data.TaggedError("E")<{...}>` also exists when no schema is needed. Use `cause: Schema.Defect()` for a field holding an unknown thrown value. Inside `Effect.gen`, `return yield* new E(...)` fails.
- **Catching typed failures**: `Effect.catch(f)` (all typed failures), `Effect.catchTag("E", f)` or `Effect.catchTag(["A", "B"], f)`, `Effect.catchTags({ A: f, B: g })`, `Effect.catchIf(predicate, f)`, `Effect.catchFilter(filter, f)`, `Effect.orElseSucceed(() => a)`, `Effect.mapError`, `Effect.tapError`, `Effect.tapErrorTag`.
- **Errors with a `reason` field**: `Effect.catchReason("Parent", "ReasonTag", f, orElse?)`, `Effect.catchReasons`, `Effect.unwrapReason("Parent")`. `PlatformError` is this shape: its `reason` is `BadArgument` or a `SystemError` whose `_tag` is one of `AlreadyExists | BadResource | Busy | InvalidData | NotFound | PermissionDenied | TimedOut | UnexpectedEof | Unknown | WouldBlock | WriteZero`, so `fs.readFileString(p).pipe(Effect.catchReason("PlatformError", "NotFound", () => ...))` type-checks. `src/config.ts` does the same by checking `error.reason._tag`.
- **Defects and causes**: `Effect.die`, `Effect.orDie`, `Effect.catchDefect`, `Effect.catchCause`, `Effect.tapCause`, `Effect.sandbox`. `Effect.ignore` (optionally `{ log: "Warn" }`) and `Effect.ignoreCause` drop failures. Catch helpers never catch defects or interruption unless they say `Cause`/`Defect`.
- **Result** (replaces `Either`): `Effect.result(self)` gives `Result.Result<A, E>`; `Result.succeed/fail/isSuccess/isFailure/match/getOrElse`.
- **Exit and Cause**: `Effect.exit(self)`, `Exit.isSuccess/isFailure/hasInterrupts/hasDies/hasFails`. A cause exposes `cause.reasons` (a property); filter it with `Cause.isFailReason`, `Cause.isDieReason`, `Cause.isInterruptReason`. Also `Cause.hasInterruptsOnly`, `Cause.hasDies`, `Cause.hasFails`, `Cause.findErrorOption`, `Cause.findDefect`, `Cause.squash`, `Cause.pretty`. `src/errors.ts` (`failure`) and `src/runtime.ts` show the boundary mapping.
- **Built-in error classes** live on `Cause`: `Cause.TimeoutError`, `Cause.NoSuchElementError`, `Cause.IllegalArgumentError`, `Cause.UnknownError` (default for `Effect.tryPromise(thunk)` without a `catch`), `Cause.Done` (queue/stream completion).
- **Interop**: `Effect.try({ try, catch })`, `Effect.tryPromise({ try: (signal) => ..., catch })`. The `signal` aborts when the fiber is interrupted, so pass it to `fetch` and similar.

## Concurrency, fibers and scopes

- **Forking**: `Effect.forkChild` (child of the current fiber, interrupted when the parent ends; was `Effect.fork`), `Effect.forkScoped` (lives until the enclosing `Scope` closes), `Effect.forkIn(self, scope)`, `Effect.forkDetach` (no parent; was `forkDaemon`, use only with an explicit owner that interrupts it). All take `{ startImmediately, uninterruptible }`.
- **Fibers**: `Fiber.join`, `Fiber.await` (gives the `Exit`), `Fiber.interrupt`, `Fiber.joinAll`, `Fiber.interruptAll`. `Effect.awaitAllChildren(self)` waits for forked children.
- **Fiber collections**, each scoped and interrupting its members when the scope closes: `FiberSet.make()` + `FiberSet.run(set, effect)`; `FiberMap.make<K>()` + `FiberMap.run(map, key, effect)` (replaces any fiber already at `key`; good for one fiber per thread or request); `FiberHandle.make()` + `FiberHandle.run` for a single slot. `join` fails when a member fails; `awaitEmpty` waits for all to finish.
- **Scopes**: `Effect.scoped(self)` provides and closes a scope; `Scope.make()`, `Scope.fork(scope)`, `Scope.close(scope, exit)`, `Scope.addFinalizer(scope, effect)`, `Scope.provide(scope)` (was `Scope.extend`). `Effect.acquireRelease`, `Effect.acquireUseRelease`, `Effect.addFinalizer`, `Effect.ensuring`, `Effect.onExit`, `Effect.onInterrupt`.
- **Parallel work**: `Effect.all([...], { concurrency })`, `Effect.forEach(items, f, { concurrency, discard: true })`, `Effect.race`, `Effect.raceFirst`, `Effect.raceAll`.
- **Callback APIs**: `Effect.callback<A, E>((resume, signal) => { ...; return cleanupEffect })` (was `Effect.async`). Call `resume(Effect.succeed(a))` once; the returned effect or the `signal` handles interruption.
- **Promises**: `Effect.promise(() => p)` (rejection is a defect), `Effect.tryPromise` (typed). `Effect.abortSignal` gives a scoped signal for other APIs.
- **Timeouts**: `Effect.timeout(self, "5 seconds")` fails with `Cause.TimeoutError` (catch with `catchTag("TimeoutError", ...)`); `Effect.timeoutOption`; `Effect.timeoutOrElse(self, { duration, orElse })` (was `timeoutFail`/`timeoutTo`). The loser is interrupted.
- **Time**: `Clock.currentTimeMillis`, `Clock.currentTimeNanos`, `Effect.sleep("100 millis")`, `Effect.timed`. Durations accept `Duration.Input` (`"5 seconds"`, a number of millis, or `Duration.seconds(5)`); `Duration.fromInput` replaces `Duration.decode`.
- **Coordination**: `Semaphore.make(n)` then `sem.withPermits(1)(effect)` or `Semaphore.withPermit(sem, effect)`; `Latch.make(open?)` with `latch.open`, `latch.await`, `latch.close`. These replace `Effect.makeSemaphore` and `Effect.makeLatch`. Mutable state: `Ref.make`, `Ref.get/set/update/modify`; `SynchronizedRef` for effectful updates.

## Deferred, Queue and PubSub

These are the pieces for holding pending JSON-RPC requests and fanning out notifications.

- **Deferred** (one-shot result): `Deferred.make<A, E>()`, `Deferred.succeed(d, a)`, `Deferred.fail(d, e)`, `Deferred.failCause`, `Deferred.die`, `Deferred.done(d, exit)`, `Deferred.complete(d, effect)`, `Deferred.interrupt(d)`, `Deferred.await(d)`, `Deferred.isDone`, `Deferred.poll`. Completion returns `false` if already done. A pending-request table is a `Map<id, Deferred.Deferred<Result, RpcError>>` (or a `Ref`/`SynchronizedRef` of one); when the child exits, fail or interrupt every remaining entry so no caller waits forever.
- **Queue**: `Queue.bounded<A, E>(n)`, `Queue.unbounded`, `Queue.sliding`, `Queue.dropping`, `Queue.make(options)`. Queues carry an error type: give `E` a `Cause.Done` member to be able to end one (`Queue.bounded<A, Cause.Done>(n)`). Producers: `Queue.offer`, `Queue.offerAll`, `Queue.offerUnsafe` (was `unsafeOffer`), `Queue.end` (no more offers; takers drain then see `Done`), `Queue.fail(q, e)`, `Queue.failCause`, `Queue.shutdown`, `Queue.interrupt`. Consumers: `Queue.take`, `Queue.takeAll`, `Queue.takeN`, `Queue.takeBetween`, `Queue.poll`, `Queue.collect`, `Queue.size`. `Queue.Enqueue`/`Queue.Dequeue` are the one-sided views.
- **PubSub**: `PubSub.unbounded<A>()`, `PubSub.bounded(n)`, `PubSub.sliding`, `PubSub.dropping`. `PubSub.publish(ps, a)`, `PubSub.publishAll`. `PubSub.subscribe(ps)` is scoped and returns a `PubSub.Subscription` (not a `Queue`); read it with `PubSub.take`, `PubSub.takeAll`, `PubSub.takeUpTo`. `PubSub.shutdown`, `PubSub.end`.
- **As streams**: `Stream.fromQueue(q)` (ends on `Done`), `Stream.fromPubSub(ps)`, `Stream.fromSubscription(sub)`, `Stream.runIntoQueue`, `Stream.toQueue`, `Stream.toPubSub`.

## Schedule

Constructors: `Schedule.exponential(base, factor?)`, `Schedule.spaced(d)`, `Schedule.fixed(d)`, `Schedule.recurs(n)`, `Schedule.during(d)`, `Schedule.fibonacci`, `Schedule.forever`, `Schedule.once`, `Schedule.cron`. Modifiers: `Schedule.jittered`, `Schedule.upTo({ times, duration })`, `Schedule.while((metadata) => boolean)` (replaces `whileInput`/`whileOutput`; metadata has `attempt`, `input`, `output`, `elapsed`, `duration`), `Schedule.addDelay`, `Schedule.modifyDelay`, `Schedule.tap`, `Schedule.map`. Combining: `Schedule.max([a, b])` recurs while all recur, with the longer delay (was `intersect`/`both`); `Schedule.min([a, b])` recurs while any recurs, with the shorter delay (was `union`/`either`); `Schedule.concat` runs one after the other.

Use with `Effect.retry(schedule)` or `Effect.retry({ times, while, until, schedule })`, `Effect.repeat(schedule)`, `Effect.retryOrElse`, `Effect.repeatOrElse`, `Stream.retry`, `Stream.schedule`.

## Streams, sinks and framing

- **Sources**: `Stream.make`, `Stream.fromIterable`, `Stream.fromEffect`, `Stream.callback((queue) => ...)` (was `Stream.async`; the queue type includes `Cause.Done`), `Stream.fromAsyncIterable`, `Stream.fromReadableStream`, `Stream.fromQueue`, `Stream.fromPubSub`, `Stream.fromSchedule`, `Stream.unfold`, `Stream.paginate`.
- **Text**: `Stream.decodeText()`, `Stream.encodeText`, `Stream.splitLines`.
- **Transform**: `Stream.map`, `Stream.mapEffect(f, { concurrency })`, `Stream.filter`, `Stream.tap`, `Stream.take`, `Stream.takeUntil`, `Stream.merge`, `Stream.interruptWhen`, `Stream.broadcast`, `Stream.share`, `Stream.pipeThroughChannel(channel)`.
- **Run**: `Stream.runForEach`, `Stream.runDrain`, `Stream.runCollect`, `Stream.runHead`, `Stream.run(sink)`. Running is an effect; fork it with `Effect.forkScoped` for a reader loop.
- **Sinks**: a `Sink.Sink<A, In, L, E, R>`; write a stream into one with `Stream.run(sink)` (`Sink.forEach`, `Sink.collect`, `Sink.drain`).
- **NDJSON** (`effect/encoding`): `Ndjson.decodeSchema(Schema)()` and `Ndjson.encodeSchema(Schema)()` are byte channels for `Stream.pipeThroughChannel`; `decodeSchemaString`/`encodeSchemaString` work on strings; `Ndjson.duplexSchema` wraps a bidirectional channel. Fits newline-delimited JSON-RPC over stdio.

## Child processes

Module `effect/process`. `BunServices.layer` and `NodeServices.layer` provide `ChildProcessSpawner` (plus `FileSystem`, `Path`, `Stdio`, `Terminal`). The Bun spawner is the shared Node one built on `node:child_process`.

- **Commands**: `ChildProcess.make("codex", ["app-server"], options)` or the template form ``ChildProcess.make`codex app-server ${arg}` ``. `ChildProcess.pipeTo(next)` builds pipelines; `ChildProcess.setCwd`, `ChildProcess.setEnv`, `ChildProcess.prefix` adjust them. Options: `cwd`, `env`, `extendEnv`, `shell`, `detached`, `stdin`/`stdout`/`stderr` (`"pipe" | "inherit" | "ignore"`, a stream/sink, or a config object), extra `fdN` descriptors, `killSignal` (default `SIGTERM`), `forceKillAfter`.
- **Spawner service**: `const spawner = yield* ChildProcessSpawner.ChildProcessSpawner`, then `spawner.string(cmd)`, `spawner.lines(cmd)`, `spawner.exitCode(cmd)`, `spawner.streamLines(cmd)`, `spawner.streamString(cmd)` for run-to-completion, and `spawner.spawn(cmd)` for a live handle. A `Command` is also an Effect, so `yield* ChildProcess.make(...)` spawns it directly.
- **Handle** (`ChildProcessSpawner.ChildProcessHandle`): `pid`, `stdin` (a `Sink<void, Uint8Array>`), `stdout`, `stderr`, `all` (byte streams), `exitCode` (waits; compare with `ChildProcessSpawner.ExitCode(0)`), `isRunning`, `kill({ killSignal, forceKillAfter })`, `unref`, `getInputFd`/`getOutputFd`. Errors are `PlatformError`.
- **Long-lived stdio peer** (the `codex app-server` shape): spawn inside a scope; fork a writer that feeds stdin from a queue (`Stream.fromQueue(q).pipe(Stream.encodeText, Stream.run(handle.stdin))`); fork a reader over `handle.stdout` (`Stream.decodeText()`, `Stream.splitLines`, or `Ndjson.decodeSchema`) that completes `Deferred`s by id and publishes notifications; drain `handle.stderr` into logs; watch `handle.exitCode` and fail pending requests when it resolves.
- **Gotchas** (from the declaration docs):
  - `spawn` needs a `Scope`. Closing it signals the process group and waits for the leader to exit with no time limit unless `forceKillAfter` is set; then `SIGKILL`. Set `forceKillAfter` for a child that may hang.
  - `detached` defaults to `true` on POSIX (its own process group).
  - Passing `env` without `extendEnv: true` replaces the environment, so the child gets no `PATH`.
  - `shell` together with arguments fails with `BadArgument`; build shell text with `CommandLine.quote`/`CommandLine.join`.
  - An unconsumed `stdout`/`stderr` pipe can block a chatty child once the pipe buffer fills. Consume both, or set the one you don't need to `"ignore"`. Don't read `all` alongside `stdout`/`stderr`.
  - Half-close of duplex fds is unsupported on Bun; keep input open until the exchange is done.
- Example in the package: `node_modules/effect/ai-docs/src/60_child-process/10_working-with-child-processes.ts`.

## Sockets (daemon over a unix socket)

Module `effect/socket`; implementations in `@effect/platform-bun` (`BunSocket`, `BunSocketServer`, re-exported from the shared Node ones) and `@effect/platform-node`.

- **Server**: `BunSocketServer.layer({ path })` provides `SocketServer.SocketServer` (`BunSocketServer.make` is the scoped effect form). Options are Node `net` `ServerOpts & ListenOptions`, so `path` gives a unix socket. The service has `address` and `run(handler)`, which returns `Effect<never, SocketServerError>`; each accepted connection's handler runs in its own fiber, and those fibers are interrupted when `run` ends. Connections queue until `run` is called. The server closes when its scope ends. It does not remove a stale socket file: delete the path (after checking no live daemon answers) before listening, and remove it on shutdown with a finalizer.
- **Connection** (`Socket.Socket`): `socket.reader` and `socket.writer` are scoped effects. `reader.pull` returns the next non-empty batch of chunks. `writer.write(chunk)` takes `Uint8Array | string | Socket.CloseEvent`; `writer.writeAll(chunks)` batches. Both apply backpressure. `Socket.toStream(socket)` gives a byte stream; `Socket.toChannel`, `Socket.toChannelString` give channels.
- **Client**: `BunSocket.makeNet({ path })` returns a `Socket.Socket` (`openTimeout`, `chunkSize` options); `BunSocket.layerNet(options)` provides it as a layer.
- **Errors**: `Socket.SocketError` with a `reason` of `SocketReadError | SocketWriteError | SocketOpenError | SocketUpgradeError | SocketCloseError`; server failures are `SocketServer.SocketServerError`.
- Higher level: `effect/rpc` has `RpcServer.layerProtocolSocketServer`, `RpcClient.layerProtocolSocket` and `RpcSerialization.layerNdjson`/`layerJsonRpc`/`layerNdJsonRpc` if the daemon protocol becomes an Effect RPC group. Not used yet; read their declarations before adopting.

## FileSystem and Path

`FileSystem.FileSystem` and `Path.Path` come from `"effect"` and are provided by `BunServices.layer` / `NodeServices.layer`. Examples: `src/config.ts`, `src/logging.ts`.

- `fs.readFileString(p)`, `fs.readFile`, `fs.writeFileString(p, data, { flag, mode })`, `fs.writeFile`, `fs.exists`, `fs.stat`, `fs.makeDirectory(p, { recursive: true, mode })`, `fs.readDirectory`, `fs.remove(p, { recursive, force })`, `fs.rename`, `fs.copy`, `fs.copyFile`, `fs.chmod`, `fs.open`, `fs.stream(p)`, `fs.sink(p)`, `fs.watch(p)` (a `Stream` of watch events), `fs.glob`, `fs.realPath`, `fs.makeTempDirectoryScoped()`, `fs.makeTempFileScoped()`.
- Atomic state writes: write `${file}.tmp` then `fs.rename` over the target.
- Failures are `PlatformError` (see Errors for the `reason` tags).
- `path.join`, `path.dirname`, `path.resolve`, `path.basename`, and so on mirror `node:path`.
- `FileSystem.layerNoop(partial)` gives a stub file system for tests.

## Configuration

- **Constructors** are capitalized: `Config.String`, `Config.NonEmptyString`, `Config.Int`, `Config.Number`, `Config.Boolean`, `Config.Port`, `Config.Duration`, `Config.Literals([...], name)`, `Config.Redacted`, `Config.URL`, `Config.schema(codec, name)`. Combinators: `Config.withDefault`, `Config.option`, `Config.all({...})`, `Config.nested`, `Config.map`, `Config.orElse`. A `Config` is yieldable in `Effect.gen`.
- **Providers**: `ConfigProvider.fromEnv()`, `ConfigProvider.fromEnvRecord(record)`, `ConfigProvider.fromUnknown(object)`, `ConfigProvider.fromDotEnv({ path })`, `ConfigProvider.fromDir`. Combine with `ConfigProvider.orElse`, `ConfigProvider.nested`, `ConfigProvider.constantCase`. Install with `ConfigProvider.layer(provider)` (replaces) or `ConfigProvider.layerAdd(provider)` (adds a fallback, or primary with `{ asPrimary: true }`).
- **Empty strings**: providers treat `""` as missing unless `{ preserveEmptyStrings: true }`. Whitespace-only values are not treated as missing; `src/config.ts` trims to absent itself.
- **Secrets**: `Redacted.make(value)`, `Redacted.value(r)`; `Config.Redacted` reads one; `ChildProcess` `env` accepts `Redacted` values and never prints them.
- Project pattern: `AppConfig` in `src/config.ts` builds a provider from an explicit env record per run (`ConfigProvider.fromEnvRecord`), never the live process env inside tests.

## Logging

- **Emitting**: `Effect.log`, `Effect.logDebug`, `Effect.logInfo`, `Effect.logWarning`, `Effect.logError`, `Effect.logFatal`, `Effect.logTrace`, `Effect.logWithLevel(level)(...)`. Context: `Effect.annotateLogs({ key: value })`, `Effect.annotateLogsScoped`, `Effect.withLogSpan("name")`.
- **Levels** (`LogLevel.LogLevel`): `"All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None"`. Filter with `Effect.provideService(References.MinimumLogLevel, level)` (`src/main.ts`).
- **Loggers**: `Logger.make((options) => ...)` where options has `message`, `logLevel`, `cause`, `fiber`, `date`; annotations come from `options.fiber.getRef(References.CurrentLogAnnotations)` (`src/logging.ts`). Install with `Logger.layer([logger])` (replaces the defaults) or `Logger.layer([logger], { mergeWithExisting: true })`. Built-ins: `Logger.consoleJson`, `Logger.consoleLogFmt`, `Logger.consolePretty`, `Logger.consoleStructured`, `Logger.defaultLogger`, formatters `Logger.formatJson`, `Logger.formatLogFmt`, `Logger.formatStructured`.
- **File and batching**: `Logger.formatJson.pipe(Logger.toFile(path, { flag, batchWindow }))` gives a scoped logger that needs `FileSystem`; `Logger.batched(logger, { window, flush })`. The project buffers its own records and flushes them once per invocation (`src/logging.ts`); a long-lived daemon will want `toFile` or `batched` instead.

## Schema

Project conventions and examples: `tests/schema-conventions.test.ts`, `src/errors.ts`, `src/schemas/`.

- **Decoding at boundaries**: `Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" })` (was `decodeUnknown`), `Schema.decodeUnknownSync`, `Schema.decodeUnknownExit`, `Schema.decodeUnknownResult`, `Schema.decodeUnknownPromise`; encoding mirrors with `Schema.encodeEffect`, `encodeSync`, and so on. Failures are `Schema.SchemaError`. `Schema.is(schema)` is a type guard.
- **Structures**: `Schema.Struct`, `Schema.Union([a, b])` and `Schema.Literals(["a", "b"])` take arrays; `Schema.Literal` takes one value. `Schema.Tuple([...])`, `Schema.Array`, `Schema.Record(key, value)`, `Schema.NullOr`, `Schema.UndefinedOr`, `Schema.TaggedStruct("Tag", fields)`, `Schema.TaggedUnion({ A: fields, B: fields })`, `Schema.Class<C>("C")(fields)`, `Schema.TaggedClass`, `Schema.TaggedError`.
- **Optional keys**: `Schema.optionalKey(s)` means the key may be absent (exact optional); `Schema.optional(s)` means absent or `undefined`. Defaults: `Schema.withDecodingDefaultKey(Effect.succeed(v))`, `Schema.withConstructorDefault`.
- **Checks**: `schema.check(Schema.isMinLength(1))`, `Schema.isPattern`, `Schema.isGreaterThan`, `Schema.isInt`, `Schema.isUUID`, and the other `is*` filters; custom ones with `Schema.makeFilter`. `Schema.brand("Name")` brands. There is no `Schema.filter`.
- **Transformations**: `from.pipe(Schema.decodeTo(to, transformation))` with `SchemaTransformation.transform({ decode, encode })`, `SchemaTransformation.transformEffect` for effectful or failing steps, or a ready one (`SchemaTransformation.trim()`, `toLowerCase()`, `numberFromString`, ...). Ready-made codecs: `Schema.NumberFromString`, `Schema.DateTimeUtcFromString`, `Schema.DurationFromString`, `Schema.Trim`. There is no `Schema.transform` or `Schema.compose`.
- **JSON text**: `Schema.fromJsonString(schema)` decodes a JSON string and then the schema (was `Schema.parseJson`). Use it for a single JSON-RPC message.
- **JSON Schema**: `Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })` gives a closed document (`additionalProperties: false`) for MCP tool inputs. There is no `JSONSchema.make`.
- **Standard Schema**: `Schema.toStandardSchemaV1(schema)`; `Schema.toStandardJSONSchemaV1` for the JSON-schema flavor.
- **Annotations**: `schema.annotate({ title, description })`, `Schema.annotateKey`.
- **Property testing**: `Arbitrary.schema(s)`, `Arbitrary.checkEffect`, `Arbitrary.formatCheckFailure` (from `"effect"`; no `fast-check` import needed).

## CLI

Module `effect/cli`. Project usage: `src/cli.ts`, `src/commands/doctor.ts`, `src/main.ts`.

- `Command.make(name, config, handler)` with `config` a record of `Flag`/`Argument` values; `Command.withHandler`, `Command.withSubcommands([...])`, `Command.withSharedFlags({...})`, `Command.withGlobalFlags`, `Command.withDescription`, `Command.withAlias`, `Command.withExamples`, `Command.provideEffectDiscard(f)` (run setup from parsed shared flags), `Command.provide`.
- Flags: `Flag.Boolean`, `Flag.String`, `Flag.Int`, `Flag.Finite`, `Flag.Literals`, `Flag.Path`, `Flag.File`, `Flag.Directory`, `Flag.Redacted`, with `Flag.withDefault`, `Flag.optional`, `Flag.withAlias`, `Flag.withDescription`, `Flag.withSchema`, `Flag.withFallbackConfig`. Arguments mirror these (`Argument.String`, ..., `Argument.variadic`).
- Running: `Command.runWith(command, { version, renderErrors })(args)` or `Command.run(command, { version })`. They need `Command.Environment` (`FileSystem | Path | Terminal | ChildProcessSpawner | Stdio`), which `BunServices.layer` provides.
- Configuration and output: `CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] })` limits built-in flags (the project drops `GlobalFlag.LogLevel`); `CliOutput.Formatter` is the service to override help/version rendering; `CliError.isCliError`, `CliError.ShowHelp`.

## Running programs

- The project runs one invocation per process with `Effect.runPromiseExit(program, { signal })` and maps the `Exit` to a status (`src/runtime.ts`, `src/bin.ts`). `RunOptions` also accepts `scheduler`, `uninterruptible`, `onFiberStart`.
- `BunRuntime.runMain(effect, { disableErrorReporting, teardown })` is the stock entry point: it installs signal handling and interrupts the main fiber on SIGINT/SIGTERM. A daemon entry that is `Layer.launch(DaemonLayer)` fits it.
- `Effect.runFork`, `Effect.runSync`, `Effect.runPromise` exist for other edges.
- Effect authoring: `Effect.gen`, `Effect.fn("name")(function* (...) {...}, ...pipeables)` with `Effect.fn.Return<A, E, R>` for annotated returns (`src/core/doctor.ts`), `Effect.fnUntraced` for hot paths.

## Testing

`@effect/vitest` re-exports `vitest` and adds the Effect testers. `tests/effect-testkit.test.ts` shows each pattern.

- `it.effect(name, () => effect)`: provides a `Scope` plus `TestClock` and `TestConsole`. Time does not move on its own: fork the sleeper (`Effect.forkChild`), `TestClock.adjust("1 hour")`, then `Fiber.join`. `TestClock.setTime(ms)`, `TestClock.withLive(effect)` for a section on the real clock.
- `it.live(name, ...)`: real clock and console, still scoped.
- `it.layer(layer, { timeout, buildPerTest, memoMap, excludeTestServices })(name?, (it) => { ... })` or the top-level `layer(...)`: share one built layer across a group; `buildPerTest: true` rebuilds per test.
- `it.prop(name, arbitraries, (values) => boolean)` and `it.effect.prop(...)`: arbitraries are `Schema`s or `Arbitrary`s, as a tuple or a record.
- Modifiers on each tester: `.skip`, `.only`, `.skipIf(c)`, `.runIf(c)`, `.each(cases)`, `.fails`. `it.flakyTest(effect, timeout)` retries.
- Import path: `import { TestClock } from "effect/testing"` (not `effect/TestClock`).
- Failures: `Effect.flip(self)` turns the typed failure into the success value; defects through `Effect.exit` then `Cause.hasDies(exit.cause)`. `assert` comes from `@effect/vitest`.
- `it.scoped` and `it.scopedLive` are gone: `it.effect`/`it.live` already provide a scope.

## Traps from Effect 3

Each old export below was checked absent from the 4.1.2 runtime exports (types and packages against the declarations and `node_modules`).

| Effect 3 | 4.1.2 |
| --- | --- |
| `Effect.Service`, `Effect.Tag`, `Context.Tag`, `Context.GenericTag` | `Context.Service<Self, Shape>()("id")`, `Context.Service<Shape>("id")` |
| `FiberRef` module | `Context.Reference` and `References.*` |
| `Layer.scoped`, `Layer.scopedDiscard` | `Layer.effect`, `Layer.effectDiscard` (they run in the layer scope) |
| `Layer.setConfigProvider` | `ConfigProvider.layer` / `ConfigProvider.layerAdd` |
| `Effect.fork` / `Effect.forkDaemon` | `Effect.forkChild` / `Effect.forkDetach` |
| `Effect.async`, `Stream.async`, `Stream.asyncScoped` | `Effect.callback`, `Stream.callback` |
| `Effect.catchAll`, `catchAllCause`, `catchAllDefect`, `catchSome` | `Effect.catch`, `catchCause`, `catchDefect`, `catchIf` / `catchFilter` |
| `Effect.either`, `Either` module | `Effect.result`, `Result` module |
| `Effect.zipRight` / `zipLeft` | `Effect.andThen` / `Effect.tap` |
| `Effect.tapErrorCause` | `Effect.tapCause` |
| `Effect.orElse`, `orElseFail` | `Effect.catch(() => ...)`, `Effect.mapError` |
| `Effect.timeoutFail` | `Effect.timeoutOrElse` (or `timeout` plus `catchTag("TimeoutError")`) |
| `Effect.makeSemaphore`, `Effect.makeLatch` | `Semaphore.make`, `Latch.make` |
| `Effect.runtime`, `Runtime.runPromise` | `ManagedRuntime.make(layer)`; the `Runtime` module only holds run-main helpers |
| `Effect.locally` | `Effect.provideService(Reference, value)` |
| `Scope.extend` | `Scope.provide` |
| `Queue.unsafeOffer` and other `unsafe*` prefixes | `Queue.offerUnsafe` (suffix `Unsafe` throughout) |
| `Cause.failureOption`, `Cause.failures`, `Cause.defects`, `Cause.isDie` | `Cause.findErrorOption`, `cause.reasons` with `Cause.isFailReason` / `Cause.isDieReason` |
| `Exit.isInterrupted` | `Exit.hasInterrupts`, `Cause.hasInterruptsOnly` |
| `Schedule.intersect` / `both`, `union` / `either`, `whileInput` / `whileOutput` | `Schedule.max([...])`, `Schedule.min([...])`, `Schedule.while(metadata => ...)` |
| `Duration.decode`, `Duration.DurationInput` | `Duration.fromInput`, `Duration.Input` |
| `Option.fromNullable` | `Option.fromNullishOr` |
| `Config.string`, `integer`, `number`, `boolean`, `redacted` | `Config.String`, `Int`, `Number`, `Boolean`, `Redacted` |
| `ConfigProvider.fromMap`, `fromJson` | `ConfigProvider.fromEnvRecord`, `fromUnknown` |
| `Logger.replace`, `Logger.add`, `Logger.json`, `Logger.minimumLogLevel` | `Logger.layer([...], { mergeWithExisting })`, `Logger.consoleJson`, `References.MinimumLogLevel` |
| `Schema.decodeUnknown`, `decodeUnknownEither` | `Schema.decodeUnknownEffect`, `decodeUnknownResult` |
| `Schema.Literal("a", "b")`, `Schema.Union(a, b)` | `Schema.Literals(["a", "b"])`, `Schema.Union([a, b])` |
| `Schema.filter`, `Schema.transform`, `transformOrFail`, `compose` | `.check(...)` / `Schema.makeFilter`, `Schema.decodeTo(to, SchemaTransformation.*)` |
| `Schema.parseJson` | `Schema.fromJsonString(schema)` |
| `Schema.optionalWith` | `Schema.optionalKey` / `Schema.optional` plus `withDecodingDefaultKey` |
| `JSONSchema.make`, `Schema.standardSchemaV1` (the `JsonSchema` module now holds low-level document helpers) | `Schema.toJsonSchemaDocument`, `Schema.toStandardSchemaV1` |
| `ParseResult` module | `SchemaIssue`, `Schema.SchemaError` |
| `@effect/schema`, `@effect/cli`, `@effect/platform` | `effect` (`effect/cli`; `FileSystem`, `Path` in the core) |
| `@effect/platform` `Command` / `CommandExecutor` | `effect/process` `ChildProcess` / `ChildProcessSpawner` |
| `Socket.run(handler)`, `Socket.writer` returning a function | `socket.reader` (`pull`) and `socket.writer` (`write`, `writeAll`), both scoped |
| `it.scoped`, `it.scopedLive` | `it.effect`, `it.live` |
| `import { TestClock } from "effect"` | `import { TestClock } from "effect/testing"` |

Smaller notes:

- `Schema.UnknownFromJsonString` exists at runtime but is missing from the 4.1.2 declarations; use `Schema.fromJsonString(Schema.Unknown)`.
- `import("effect/JSONSchema")` appears to resolve on macOS only because the file system is case-insensitive (the module is `JsonSchema`). Don't rely on it.

## Not used yet

`effect/ai` has `McpServer` (`McpServer.layerStdio({ name, version, protocols, registrations })`, `McpServer.layerHttp`, `registerToolkit`, `registerResource`, `registerPrompt`) and `Tool`/`Toolkit` for the planned MCP server. `effect/rpc` (`RpcGroup`, `RpcServer`, `RpcClient`, `RpcSerialization.jsonRpc`) could carry the daemon protocol. Both are marked unstable; verify against their declarations and add entries here when the code adopts them.
