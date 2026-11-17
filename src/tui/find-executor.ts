import { Effect, FiberSet, Stream } from "effect";
import type { Message } from "../core/monitor/model";
import type { HistoryResult } from "../core/runs/history";
import { defectTrace } from "../logging";

/** Pending read and clipboard requests projected from monitor state. */
export type FindRequests = {
  readonly history: { readonly id: number } | null;
  readonly clipboard: { readonly id: number; readonly text: string } | null;
};
/** Reads the history entries without a typed failure. */
export type HistoryReader<R = never> = () => Effect.Effect<HistoryResult, never, R>;
/** Executes history and clipboard requests while preserving request identities. */
export const runFind = Effect.fn("tui.runFind")(function* <R, R2>(
  read: HistoryReader<R>,
  requests: Stream.Stream<FindRequests, never, R2>,
  dispatch: (message: Message) => void,
  stdout: NodeJS.WritableStream,
) {
  const fibers = yield* FiberSet.make<void, never>();
  let historyId: number | undefined;
  let clipboardId: number | undefined;
  const execute = (request: FindRequests) =>
    Effect.gen(function* () {
      if (request.clipboard && request.clipboard.id !== clipboardId) {
        clipboardId = request.clipboard.id;
        stdout.write(`\u001b]52;c;${Buffer.from(request.clipboard.text).toString("base64")}\u0007`);
      }
      if (!request.history || request.history.id === historyId) return;
      const { id } = request.history;
      historyId = id;
      const load = Effect.suspend(read).pipe(
        Effect.map(
          (result) => ({ type: "history-result", id, ...result, error: null }) satisfies Message,
        ),
        Effect.catchDefect((cause) =>
          Effect.logError("monitor.history.failed").pipe(
            Effect.annotateLogs({ historyId: id, trace: defectTrace(cause) }),
            Effect.as({
              type: "history-result",
              id,
              entries: null,
              skipped: 0,
              error: `History read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            } satisfies Message),
          ),
        ),
        Effect.tap((message) => Effect.sync(() => dispatch(message))),
        Effect.asVoid,
      );
      yield* FiberSet.run(fibers, load);
    });
  yield* Effect.raceFirst(
    Stream.runForEach(requests, execute).pipe(Effect.andThen(FiberSet.awaitEmpty(fibers))),
    FiberSet.join(fibers),
  );
}, Effect.scoped);
