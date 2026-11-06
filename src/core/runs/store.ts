import {
  Clock,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Path,
  PlatformError,
  Result,
  Schema,
  Stream,
} from "effect";
import { RunConflict } from "../../errors";
import { makeLogAppender, redactDiagnostic, redactDiagnosticText } from "../../logging";
import {
  activeStates,
  type DaemonResult,
  QuestionLine,
  RunEvent,
  type RunEventBody,
  type RunName,
  RunRecord,
  StorageHeader,
} from "../../schemas/daemon";
import { readGitStatus } from "./worktree";

const decodeStored = Effect.fnUntraced(function* <A>(
  text: string,
  schema: Schema.Codec<A, unknown>,
) {
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text);
  yield* Schema.decodeUnknownEffect(StorageHeader)(value);
  return yield* Schema.decodeUnknownEffect(schema)(value);
});

const encodeStored = Effect.fnUntraced(function* <A>(
  schema: Schema.Codec<A, unknown>,
  value: A,
  diagnostic = false,
) {
  const encoded = yield* Schema.encodeEffect(schema)(value);
  const fields = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(
    encoded,
  );
  return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    ...(diagnostic
      ? yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(
          redactDiagnostic(fields),
        )
      : fields),
    formatVersion: 1,
  });
});

// Decode only newline-terminated records, including when a writer has a torn UTF-8 tail.
const committedLines = (file: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return fs.stream(file).pipe(
        Stream.decodeText(),
        Stream.mapAccum(
          () => "",
          (tail, chunk) => {
            const lines = (tail + chunk).split("\n");
            return [lines.pop() ?? "", lines] as const;
          },
        ),
        Stream.filter((line) => line !== ""),
        Stream.mapError((error) =>
          error.reason._tag === "BadArgument"
            ? error
            : PlatformError.systemError({
                ...error.reason,
                method: "readFile",
                pathOrDescriptor: file,
              }),
        ),
        Stream.catchReason("PlatformError", "NotFound", () => Stream.empty),
      );
    }),
  );

// Check every storage boundary before mutating any file. Unknown historical bodies are
// readable only by their own decoder, but a declared unsupported version always fences writes.
const checkVersion = (text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.result,
    Effect.flatMap((result) =>
      Result.isFailure(result)
        ? Effect.void
        : Schema.decodeUnknownEffect(StorageHeader)(result.success).pipe(Effect.asVoid),
    ),
  );
// The daemon is the serialized writer. Cache checked file identities, invalidating on
// metadata changes; startup always validates the complete history again.
const formatChecks = new WeakMap<FileSystem.FileSystem, Map<string, string>>();
const checksFor = (fs: FileSystem.FileSystem) => {
  let checks = formatChecks.get(fs);
  if (!checks) {
    checks = new Map();
    formatChecks.set(fs, checks);
  }
  return checks;
};
const fileStamp = (info: FileSystem.File.Info) =>
  `${info.dev}:${info.ino._tag === "Some" ? info.ino.value : ""}:${info.size}:${info.mode}:${info.mtime._tag === "Some" ? info.mtime.value.getTime() : ""}`;
const rememberVersion = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  checksFor(fs).set(file, fileStamp(yield* fs.stat(file)));
});
const forgetVersions = Effect.fnUntraced(function* (dir: string) {
  const checks = checksFor(yield* FileSystem.FileSystem);
  for (const file of ["events.jsonl", "questions.jsonl", "codex.jsonl"])
    checks.delete(`${dir}/${file}`);
});
const assertLogVersions = Effect.fnUntraced(function* (runDir: string, fresh = false) {
  const fs = yield* FileSystem.FileSystem;
  const checks = checksFor(fs);
  for (const file of ["events.jsonl", "questions.jsonl", "codex.jsonl"]) {
    const fullPath = `${runDir}/${file}`;
    const info = yield* fs
      .stat(fullPath)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    if (info?.type !== "File") {
      checks.delete(fullPath);
      continue;
    }
    const stamp = fileStamp(info);
    if (!fresh && checks.get(fullPath) === stamp) continue;
    yield* committedLines(fullPath).pipe(Stream.runForEach(checkVersion));
    checks.set(fullPath, stamp);
  }
});
export const assertSupported = Effect.fnUntraced(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.readFileString(`${runDir}/run.json`).pipe(
    Effect.flatMap(checkVersion),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
  );
  yield* assertLogVersions(runDir);
});

export const runDirectory = Effect.fn("runs.runDirectory")(function* (
  dataDir: string,
  name: RunName,
) {
  const path = yield* Path.Path;
  return path.join(dataDir, "runs", name);
});

export const readRun = Effect.fn("runs.readRun")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* decodeStored(yield* fs.readFileString(path.join(runDir, "run.json")), RunRecord);
});

// The daemon serializes mutations for each run; these functions keep no sequence or record cache.
export const writeRun = Effect.fn("runs.writeRun")(function* (runDir: string, record: RunRecord) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(runDir, "run.json");
  yield* assertSupported(runDir);
  const text = yield* encodeStored(RunRecord, {
    ...record,
    failure:
      record.failure === null
        ? null
        : {
            message: redactDiagnosticText(record.failure.message),
            codexErrorInfo: redactDiagnostic(record.failure.codexErrorInfo),
          },
  });
  yield* fs.writeFileString(`${file}.tmp`, text);
  yield* fs.rename(`${file}.tmp`, file);
});

export const createRun = Effect.fn("runs.createRun")(function* (
  dataDir: string,
  record: RunRecord,
  contract: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseline = yield* readGitStatus(record.worktree);
  const dir = yield* runDirectory(dataDir, record.name);
  if (yield* fs.exists(dir))
    return yield* new RunConflict({
      detail: `${record.name} already has run data; preserve it before reusing the name.`,
    });
  yield* fs.makeDirectory(path.dirname(dir), { recursive: true });
  return yield* Effect.acquireUseRelease(
    fs.makeTempDirectory({ directory: path.dirname(dir), prefix: `.tmp-${record.name}-` }),
    (staging) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(staging, "contract.md"), contract);
        yield* fs.writeFileString(path.join(staging, "start-mark"), "");
        yield* fs.writeFileString(path.join(staging, "baseline.txt"), baseline.join("\n"));
        yield* fs.writeFileString(path.join(staging, "events.jsonl"), "");
        yield* writeRun(staging, record);
        yield* fs.rename(staging, dir);
        return dir;
      }),
    (staging, exit) =>
      forgetVersions(staging).pipe(
        Effect.andThen(
          Exit.isFailure(exit) ? fs.remove(staging, { recursive: true }) : Effect.void,
        ),
      ),
  );
});

export const readAllRuns = Effect.fn("runs.readAllRuns")(function* (dataDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(dataDir, "runs");
  const names = yield* fs
    .readDirectory(root)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
  const runs: RunRecord[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const name of names.sort()) {
    if (name === ".archive" || name.startsWith(".tmp-")) continue;
    const dir = path.join(root, name);
    if ((yield* fs.stat(dir)).type !== "Directory") continue;
    const result = yield* Effect.result(
      readRun(dir).pipe(Effect.tap(() => assertLogVersions(dir, true))),
    );
    if (Result.isFailure(result)) skipped.push({ name, reason: String(result.failure) });
    else runs.push(result.success);
  }
  return { runs, skipped };
});

export const archiveRun = Effect.fn("runs.archiveRun")(function* <E = never, R = never>(
  dataDir: string,
  name: RunName,
  beforeArchive: Effect.Effect<void, E, R> = Effect.void,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* runDirectory(dataDir, name);
  const record = yield* readRun(dir);
  yield* assertLogVersions(dir);
  if (activeStates.has(record.state))
    return yield* new RunConflict({
      detail: `${name} is ${record.state}; active runs cannot be archived`,
    });
  yield* beforeArchive;
  const archive = path.join(dataDir, "runs", ".archive");
  yield* fs.makeDirectory(archive, { recursive: true });
  const target = path.join(archive, `${name}-${yield* Clock.currentTimeMillis}`);
  yield* fs.rename(dir, target);
  yield* forgetVersions(dir);
  return target;
});

const readLines = Effect.fnUntraced(function* <A>(file: string, schema: Schema.Codec<A, unknown>) {
  return yield* committedLines(file).pipe(
    Stream.mapEffect((line) => decodeStored(line, schema)),
    Stream.runCollect,
  );
});

// Only newline-terminated records are committed. Scan bytes so a torn UTF-8 tail is safe too.
const repairTail = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(file, { flag: "r+" });
      const original = (yield* handle.stat).size;
      let position: bigint = original;
      while (position > 0n) {
        const size = Number(position < 4096n ? position : 4096n);
        position -= BigInt(size);
        const buffer = new Uint8Array(size);
        let read = 0;
        while (read < size) {
          const count = yield* handle.read(buffer.subarray(read), {
            position: position + BigInt(read),
          });
          if (count === 0)
            return yield* PlatformError.systemError({
              _tag: "UnexpectedEof",
              module: "runs",
              method: "repairTail",
              pathOrDescriptor: file,
            });
          read += count;
        }
        const newline = buffer.lastIndexOf(10);
        if (newline >= 0) {
          const committed = position + BigInt(newline + 1);
          if (committed !== original) yield* handle.truncate(Number(committed));
          return;
        }
      }
      if (original > 0n) yield* handle.truncate(0);
    }),
  ).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
});

const appendLine = Effect.fnUntraced(function* <A>(
  file: string,
  schema: Schema.Codec<A, unknown>,
  value: A,
  diagnostic = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* encodeStored(schema, value, diagnostic);
  yield* repairTail(file);
  yield* fs.writeFileString(file, `${text}\n`, { flag: "a" });
  yield* rememberVersion(file);
});

export const readEvents = Effect.fn("runs.readEvents")(function* (
  runDir: string,
  after = 0,
  limit = 100,
): Effect.fn.Return<
  Extract<DaemonResult, { _tag: "Events" }>,
  PlatformError.PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  let first: number | undefined;
  const events = yield* committedLines(path.join(runDir, "events.jsonl")).pipe(
    Stream.rechunk(1),
    Stream.mapEffect((line) => decodeStored(line, RunEvent)),
    Stream.tap((event) =>
      Effect.sync(() => {
        first ??= event.seq;
      }),
    ),
    Stream.filter((event) => event.seq > after),
    Stream.take(Math.max(0, limit)),
    Stream.runCollect,
  );
  return {
    _tag: "Events",
    events,
    gap: first !== undefined && after < first - 1,
    next: events.at(-1)?.seq ?? after,
  };
});

export const hasTransition = Effect.fnUntraced(function* (runDir: string, id: string) {
  const path = yield* Path.Path;
  const found = yield* committedLines(path.join(runDir, "events.jsonl")).pipe(
    Stream.rechunk(1),
    Stream.mapEffect((line) => decodeStored(line, RunEvent)),
    Stream.filter((entry) => entry.transitionId === id),
    Stream.runHead,
  );
  return found._tag === "Some";
});

const readLastEvent = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(file, { flag: "r" });
      let position: bigint = (yield* handle.stat).size;
      const reversed: number[] = [];
      let complete = false;
      while (position > 0n && !complete) {
        const size = Number(position < 4096n ? position : 4096n);
        position -= BigInt(size);
        const buffer = new Uint8Array(size);
        let read = 0;
        while (read < size) {
          const count = yield* handle.read(buffer.subarray(read), {
            position: position + BigInt(read),
          });
          if (count === 0)
            return yield* PlatformError.systemError({
              _tag: "UnexpectedEof",
              module: "runs",
              method: "readLastEvent",
              pathOrDescriptor: file,
            });
          read += count;
        }
        for (let index = buffer.length - 1; index >= 0; index--) {
          const byte = buffer[index];
          if (byte === undefined) continue;
          if (byte === 10) {
            if (reversed.length === 0) continue;
            complete = true;
            break;
          }
          reversed.push(byte);
        }
      }
      if (reversed.length === 0) return null;
      const text = new TextDecoder().decode(Uint8Array.from(reversed.reverse()));
      return yield* decodeStored(text, RunEvent);
    }),
  ).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
});

export const appendEvent = Effect.fn("runs.appendEvent")(function* (
  runDir: string,
  event: RunEventBody,
  transitionId?: string,
) {
  const path = yield* Path.Path;
  const file = path.join(runDir, "events.jsonl");
  yield* assertSupported(runDir);
  yield* repairTail(file);
  const previous = yield* readLastEvent(file);
  const entry: RunEvent = {
    seq: (previous?.seq ?? 0) + 1,
    at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
    event,
    ...(transitionId === undefined ? {} : { transitionId }),
  };
  // File-change paths are identities used by scope reporting, not diagnostic text.
  yield* appendLine(file, RunEvent, entry, event._tag !== "FileChange");
  return entry;
});

export const appendCodexMessage = Effect.fn("runs.appendCodexMessage")(function* (
  runDir: string,
  message: unknown,
) {
  const path = yield* Path.Path;
  yield* assertSupported(runDir);
  const text = yield* encodeStored(Schema.Unknown, message, true);
  yield* repairTail(path.join(runDir, "codex.jsonl"));
  const append = yield* makeLogAppender(path.join(runDir, "codex.jsonl"), 1);
  yield* append(`${text}\n`);
  yield* rememberVersion(path.join(runDir, "codex.jsonl"));
});

export const readQuestions = Effect.fn("runs.readQuestions")(function* (runDir: string) {
  const path = yield* Path.Path;
  return yield* readLines(path.join(runDir, "questions.jsonl"), QuestionLine);
});

export const appendQuestion = Effect.fn("runs.appendQuestion")(function* (
  runDir: string,
  line: QuestionLine,
) {
  const path = yield* Path.Path;
  yield* assertSupported(runDir);
  yield* appendLine(path.join(runDir, "questions.jsonl"), QuestionLine, line);
});

export function pendingQuestions(lines: readonly QuestionLine[]) {
  const pending = new Map<string, Extract<QuestionLine, { _tag: "Asked" }>>();
  for (const line of lines) {
    if (line._tag === "Asked") pending.set(line.id, line);
    else pending.delete(line.id);
  }
  return [...pending.values()];
}

export const writeHandoff = Effect.fn("runs.writeHandoff")(function* (
  runDir: string,
  turn: number,
  text: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const turns = path.join(runDir, "turns");
  yield* assertSupported(runDir);
  yield* fs.makeDirectory(turns, { recursive: true });
  const file = path.join(turns, `${turn}.md`);
  yield* fs.writeFileString(`${file}.tmp`, redactDiagnosticText(text));
  yield* fs.rename(`${file}.tmp`, file);
  const latest = path.join(runDir, "last-message.md");
  yield* fs.writeFileString(`${latest}.tmp`, redactDiagnosticText(text));
  yield* fs.rename(`${latest}.tmp`, latest);
});

export const readHandoff = Effect.fn("runs.readHandoff")(function* (
  runDir: string,
  latestTurn: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (let turn = latestTurn; turn > 0; turn--) {
    const text = yield* fs
      .readFileString(path.join(runDir, "turns", `${turn}.md`))
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    if (text !== null)
      return { handoff: { turn, text }, latestTurnWithoutHandoff: turn < latestTurn };
  }
  return { handoff: null, latestTurnWithoutHandoff: latestTurn > 0 };
});
