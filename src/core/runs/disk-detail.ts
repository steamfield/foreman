import { DateTime, Effect, FileSystem, Path } from "effect";
import type { Digest, QuestionLine, RunName, RunRecord } from "../../schemas/daemon";
import type { Detail, RunView } from "../../schemas/monitor";
import { buildDigest } from "./digest";
import { diskRunView } from "./disk-overview";
import * as Store from "./store";

export const CONTRACT_BYTE_LIMIT = 256 * 1024;

function questionStatus(
  line: Exclude<QuestionLine, { _tag: "Asked" }>,
): Detail["questions"][number]["status"] {
  if (line._tag === "Deferred") return "deferred";
  if (line.resolution === "cancelled" || line.resolution === "superseded") return "cancelled";
  return "resolved";
}

/** Drop an incomplete final UTF-8 character at the byte boundary. */
export function truncateContract(bytes: Uint8Array) {
  const contractTruncated = bytes.length > CONTRACT_BYTE_LIMIT;
  return {
    contract: new TextDecoder().decode(bytes.subarray(0, CONTRACT_BYTE_LIMIT), {
      stream: contractTruncated,
    }),
    contractTruncated,
    contractByteLimit: CONTRACT_BYTE_LIMIT,
  };
}

export function foldQuestions(lines: readonly QuestionLine[]): Detail["questions"] {
  const questions = new Map<string, Detail["questions"][number]>();
  for (const line of lines) {
    if (line._tag === "Asked")
      questions.set(line.id, {
        id: line.id,
        kind: line.kind,
        text: line.question,
        askedAt: line.at,
        status: "pending",
        resolvedAt: null,
      });
    else {
      const question = questions.get(line.id);
      if (!question) continue;
      questions.set(line.id, {
        ...question,
        status: questionStatus(line),
        resolvedAt: line._tag === "Deferred" ? null : line.at,
      });
    }
  }
  return [...questions.values()];
}

/** Shared journal projection; callers in the supervisor hold the run lock. */
export const readDetail = Effect.fn("runs.readDetail")(function* (
  run: RunView,
  record: RunRecord,
  dir: string,
  version: number,
  digest: Digest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bytes = yield* fs
    .readFile(path.join(dir, "contract.md"))
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(new Uint8Array())));
  return {
    _tag: "Detail",
    version,
    run,
    digest,
    record: {
      runDir: dir,
      worktree: record.worktree,
      branch: record.managedWorktree?.branch ?? null,
      baseCommit: record.baseCommit,
      fromRef: record.managedWorktree?.fromRef ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
    ...truncateContract(bytes),
    questions: foldQuestions(yield* Store.readQuestions(dir)),
    handoff: (yield* Store.readHandoff(dir, record.turns)).handoff,
  } satisfies Detail;
});

/** Named disk fallback: no recovery, child processes or refreshed worktree fields. */
export const diskDetail = Effect.fn("runs.diskDetail")(function* (home: string, name: RunName) {
  const dir = yield* Store.runDirectory(home, name);
  const record = yield* Store.readRun(dir).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
  );
  if (record === null) return null;
  const run = yield* diskRunView(dir, record);
  const events = yield* Store.readEvents(dir, 0, Number.MAX_SAFE_INTEGER);
  const digest = buildDigest(
    record,
    events.events,
    yield* Store.readQuestions(dir),
    dir,
    DateTime.toEpochMillis(record.updatedAt),
    null,
  );
  return yield* readDetail(run, record, dir, 0, digest);
});
