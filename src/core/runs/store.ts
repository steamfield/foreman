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
} from "effect";
import { RunConflict } from "../../errors";
import {
  activeStates,
  type DaemonResult,
  QuestionLine,
  RunEvent,
  type RunEventBody,
  type RunName,
  RunRecord,
} from "../../schemas/daemon";
import { readGitStatus } from "./worktree";

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
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunRecord))(
    yield* fs.readFileString(path.join(runDir, "run.json")),
  );
});

// The daemon serializes mutations for each run; these functions keep no sequence or record cache.
export const writeRun = Effect.fn("runs.writeRun")(function* (runDir: string, record: RunRecord) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(runDir, "run.json");
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(RunRecord))(record);
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
      Exit.isFailure(exit) ? fs.remove(staging, { recursive: true }) : Effect.void,
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
    const result = yield* Effect.result(readRun(dir));
    if (Result.isFailure(result)) skipped.push({ name, reason: String(result.failure) });
    else runs.push(result.success);
  }
  return { runs, skipped };
});

export const archiveRun = Effect.fn("runs.archiveRun")(function* (dataDir: string, name: RunName) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* runDirectory(dataDir, name);
  const record = yield* readRun(dir);
  if (activeStates.has(record.state))
    return yield* new RunConflict({
      detail: `${name} is ${record.state}; active runs cannot be archived`,
    });
  const archive = path.join(dataDir, "runs", ".archive");
  yield* fs.makeDirectory(archive, { recursive: true });
  const target = path.join(archive, `${name}-${yield* Clock.currentTimeMillis}`);
  yield* fs.rename(dir, target);
  return target;
});

const readLines = Effect.fnUntraced(function* <A>(file: string, schema: Schema.Codec<A, unknown>) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));
  return yield* Effect.forEach(
    text
      .split("\n")
      .slice(0, -1)
      .filter((line) => line !== ""),
    (line) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(line),
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
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value);
  yield* repairTail(file);
  yield* fs.writeFileString(file, `${text}\n`, { flag: "a" });
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
  const all = yield* readLines(path.join(runDir, "events.jsonl"), RunEvent);
  const events = all.filter((event) => event.seq > after).slice(0, Math.max(0, limit));
  return {
    _tag: "Events",
    events,
    gap: all[0] !== undefined && after < all[0].seq - 1,
    next: events.at(-1)?.seq ?? after,
  };
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
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunEvent))(text);
    }),
  ).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
});

export const appendEvent = Effect.fn("runs.appendEvent")(function* (
  runDir: string,
  event: RunEventBody,
) {
  const path = yield* Path.Path;
  const file = path.join(runDir, "events.jsonl");
  yield* repairTail(file);
  const previous = yield* readLastEvent(file);
  const entry: RunEvent = {
    seq: (previous?.seq ?? 0) + 1,
    at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
    event,
  };
  yield* appendLine(file, RunEvent, entry);
  return entry;
});

export const appendCodexMessage = Effect.fn("runs.appendCodexMessage")(function* (
  runDir: string,
  message: unknown,
) {
  const path = yield* Path.Path;
  yield* appendLine(path.join(runDir, "codex.jsonl"), Schema.Unknown, message);
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
  yield* fs.makeDirectory(turns, { recursive: true });
  const file = path.join(turns, `${turn}.md`);
  yield* fs.writeFileString(file, text);
  yield* fs.copyFile(file, path.join(runDir, "last-message.md"));
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
