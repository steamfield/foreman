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
  yield* waitForVersion(registry, body.after, body.timeoutMs);
  const path = yield* Path.Path;
  return yield* run.lock.withPermits(1)(
    Effect.gen(function* () {
      yield* registry.requireCurrent(run);
      const version = registry.version;
      const digest = yield* registry.digest(run, false);
      const view = projectRun(run, path.basename(run.record.group), yield* Clock.currentTimeMillis);
      return yield* readDetail(view, run.record, run.dir, version, digest);
    }),
  );
});
