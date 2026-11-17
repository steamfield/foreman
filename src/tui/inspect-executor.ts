import { Effect, Stream } from "effect";
import type { Message, State } from "../core/monitor/model-types";
import type { ChangedFile, DiffText } from "../core/runs/changes";
import type { Detail } from "../schemas/monitor";
import { inspectError } from "./inspect-error";

/** Captures the loaded detail and request ids at the instant the model requests I/O. */
export type InspectRequests = Pick<State, "detail" | "pager">;
/** Reads changed files and bounded diffs at the monitor's I/O boundary.
 * @throws {Error} When the worktree cannot be read.
 */
export type InspectReaders<R = never> = {
  readonly changes: (
    worktree: string,
    base: string,
    contract: string,
  ) => Effect.Effect<readonly ChangedFile[], Error, R>;
  readonly diff: DiffReader<R>;
};
/** Reads a diff with an explicit byte limit.
 * @throws {Error} When the worktree cannot be read.
 */
export type DiffReader<R = never> = (
  worktree: string,
  base: string,
  path: string | null,
  maxBytes: number,
) => Effect.Effect<DiffText, Error, R>;

/** Extracts retained detail data from live, saved or reconnecting feeds. */
export function inspectDetail(request: InspectRequests): Detail | null {
  const feed = request.detail?.feed;
  if (!feed || feed._tag === "Archived") return null;
  return feed._tag === "Reconnecting" ? feed.last : feed.detail;
}

function load<A, R>(request: InspectRequests, read: (data: Detail) => Effect.Effect<A, Error, R>) {
  return Effect.suspend(() => {
    const data = inspectDetail(request);
    return data
      ? read(data)
      : Effect.fail(new Error("Run detail data is not loaded yet. Reopen detail and try again."));
  }).pipe(Effect.result);
}

/** Executes new changes and diff requests once and replies with their original ids. */
export const runInspect = Effect.fn("tui.runInspect")(function* <R, R2>(
  readers: InspectReaders<R>,
  requests: Stream.Stream<InspectRequests, never, R2>,
  dispatch: (message: Message) => void,
) {
  let changesId: number | undefined;
  let diffId: number | undefined;
  yield* Stream.runForEach(requests, (request) =>
    Effect.gen(function* () {
      const changes = request.detail?.changes;
      if (changes && changes.id !== changesId) {
        changesId = changes.id;
        const result = yield* load(request, (data) =>
          readers.changes(data.record.worktree, data.record.baseCommit, data.contract),
        );
        dispatch({
          type: "changes-result",
          id: changes.id,
          files: result._tag === "Success" ? result.success : null,
          error: result._tag === "Failure" ? inspectError(result.failure) : null,
        });
      }
      const diff = request.detail?.diff;
      if (diff && diff.id !== diffId) {
        diffId = diff.id;
        const result = yield* load(request, (data) =>
          readers.diff(data.record.worktree, data.record.baseCommit, diff.path, 512 * 1024),
        );
        dispatch({
          type: "diff-result",
          id: diff.id,
          text: result._tag === "Success" ? result.success : null,
          error: result._tag === "Failure" ? inspectError(result.failure) : null,
        });
      }
    }),
  );
});
