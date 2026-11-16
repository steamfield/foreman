import { Clock, Effect, Path } from "effect";
import { readDetail } from "../core/runs/disk-detail";
import type { DaemonRequestBody } from "../schemas/daemon";
import { projectRun, waitForVersion } from "./overview";
import type { Registry } from "./registry";

export const detail = Effect.fn("supervisor.detail")(function* (
  registry: Registry,
  body: Extract<DaemonRequestBody, { _tag: "Detail" }>,
) {
  const run = yield* registry.lookup(body.name);
  yield* waitForVersion(registry, body.after, body.timeoutMs, run);
  const path = yield* Path.Path;
  const snapshot = Effect.gen(function* () {
    yield* registry.requireCurrent(run);
    const digest = yield* registry.digest(run, false);
    const view = projectRun(run, path.basename(run.record.group), yield* Clock.currentTimeMillis);
    return { view, record: run.record, version: run.version, digest };
  });
  const read = (value: Effect.Success<typeof snapshot>) =>
    readDetail(value.view, value.record, run.dir, value.version, value.digest);
  const captured = yield* run.lock.withPermits(1)(snapshot);
  // Read display files outside the lock. If notifications changed the snapshot,
  // fall back to one locked read so a busy run cannot starve this request.
  const result = yield* read(captured).pipe(Effect.result);
  return yield* run.lock.withPermits(1)(
    Effect.gen(function* () {
      yield* registry.requireCurrent(run);
      if (run.version === captured.version) return yield* Effect.fromResult(result);
      return yield* read(yield* snapshot);
    }),
  );
});
