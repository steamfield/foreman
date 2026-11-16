import { Clock, Effect, FileSystem, Path } from "effect";
import * as Store from "../core/runs/store";
import type { DaemonRequestBody, QuestionId, QuestionLine } from "../schemas/daemon";
import type { Detail } from "../schemas/monitor";
import { projectRun, waitForVersion } from "./overview";
import type { Registry } from "./registry";

export const CONTRACT_BYTE_LIMIT = 256 * 1024;

function foldQuestions(lines: readonly QuestionLine[]): Detail["questions"] {
  const questions = new Map<QuestionId, Detail["questions"][number]>();
  for (const line of lines) {
    if (line._tag === "Asked") {
      questions.set(line.id, {
        id: line.id,
        kind: line.kind,
        text: line.question,
        askedAt: line.at,
        status: "pending",
        resolvedAt: null,
      });
      continue;
    }
    const question = questions.get(line.id);
    if (!question) continue;
    if (line._tag === "Deferred") {
      questions.set(line.id, { ...question, status: "deferred", resolvedAt: null });
      continue;
    }
    const cancelled = line.resolution === "cancelled" || line.resolution === "superseded";
    questions.set(line.id, {
      ...question,
      status: cancelled ? "cancelled" : "resolved",
      resolvedAt: line.at,
    });
  }
  return [...questions.values()];
}

export const detail = Effect.fn("supervisor.detail")(function* (
  registry: Registry,
  body: Extract<DaemonRequestBody, { _tag: "Detail" }>,
) {
  const run = yield* registry.lookup(body.name);
  yield* waitForVersion(registry, body.after, body.timeoutMs);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* run.lock.withPermits(1)(
    Effect.gen(function* () {
      yield* registry.requireCurrent(run);
      const version = registry.version;
      const digest = yield* registry.digest(run, false);
      const record = run.record;
      const bytes = yield* fs
        .readFile(path.join(run.dir, "contract.md"))
        .pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(new Uint8Array())),
        );
      const contractTruncated = bytes.length > CONTRACT_BYTE_LIMIT;
      // Streaming decode omits a partial UTF-8 character at the truncation boundary.
      const contract = new TextDecoder().decode(bytes.subarray(0, CONTRACT_BYTE_LIMIT), {
        stream: contractTruncated,
      });
      return {
        _tag: "Detail",
        version,
        run: projectRun(run, path.basename(record.group), yield* Clock.currentTimeMillis),
        digest,
        record: {
          runDir: run.dir,
          worktree: record.worktree,
          branch: record.managedWorktree?.branch ?? null,
          baseCommit: record.baseCommit,
          fromRef: record.managedWorktree?.fromRef ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
        contract,
        contractTruncated,
        contractByteLimit: CONTRACT_BYTE_LIMIT,
        questions: foldQuestions(yield* Store.readQuestions(run.dir)),
        handoff: (yield* Store.readHandoff(run.dir, record.turns)).handoff,
      } satisfies Detail;
    }),
  );
});
