import { Effect, FileSystem, Path, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import type { TerminalSuspension } from "ink";
import type { Message } from "../core/monitor/model";
import { inspectError } from "./inspect-error";
import { type DiffReader, type InspectRequests, inspectDetail } from "./inspect-executor";

/** Runs a pager with inherited terminal stdio on a private diff file.
 * @throws {Error} When the pager cannot be started or observed.
 */
export type PagerRunner = (file: string) => Effect.Effect<number, Error>;

/** Binds $PAGER or less -R to the process service without shell evaluation. */
export const makePagerRunner = Effect.fn("tui.makePagerRunner")(function* (
  environment: Readonly<Record<string, string | undefined>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pager = environment.PAGER?.trim() || "less -R";
  const runner: PagerRunner = (file) =>
    Effect.scoped(
      Effect.gen(function* () {
        const parsed = CommandLine.template(Object.assign([pager], { raw: [pager] }));
        if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure);
        const [program, ...args] = parsed.success;
        if (typeof program !== "string")
          return yield* Effect.fail(new Error("Pager command must name an executable."));
        return yield* spawner.exitCode(
          ChildProcess.make(program, [...args, file], {
            env: environment,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            detached: false,
            forceKillAfter: "2 seconds",
          }),
        );
      }),
    );
  return runner;
});

function pageDiff<R>(
  read: DiffReader<R>,
  runner: PagerRunner,
  suspend: () => Promise<TerminalSuspension>,
  request: InspectRequests,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const errors: string[] = [];
    const recover = (error: Error) =>
      Effect.sync(() => {
        errors.push(inspectError(error));
      });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const data = inspectDetail(request);
        if (!data || data.run.name !== request.pager?.name)
          return yield* Effect.fail(
            new Error("Run detail data is not loaded yet. Reopen detail and try again."),
          );
        const diff = yield* read(
          data.record.worktree,
          data.record.baseCommit,
          null,
          16 * 1024 * 1024,
        );
        if (diff.truncated)
          return yield* Effect.fail(new Error("Diff exceeds the 16 MB pager limit."));
        const directory = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ prefix: "foreman-pager-" }),
          (directory) =>
            fs.remove(directory, { recursive: true, force: true }).pipe(Effect.catch(recover)),
        );
        const file = path.join(directory, "changes.diff");
        yield* fs.writeFileString(file, diff.text, { mode: 0o600, flag: "wx" });
        const code = yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () => suspend(),
            catch: (cause) => new Error(`Cannot release terminal: ${String(cause)}`, { cause }),
          }),
          () => runner(file),
          (held) =>
            Effect.tryPromise({
              try: () => held.resume(),
              catch: (cause) => new Error(`Cannot restore terminal: ${String(cause)}`, { cause }),
            }).pipe(Effect.catch(recover)),
        );
        if (code !== 0) return yield* Effect.fail(new Error(`Pager exited with status ${code}.`));
      }).pipe(Effect.catch(recover)),
    );
    return errors.length ? errors.join("; ") : null;
  });
}

/** Executes each pager id once and replies after restoration and private file cleanup. */
export const runPagers = Effect.fn("tui.runPagers")(function* <R, R2>(
  read: DiffReader<R>,
  runner: PagerRunner,
  suspend: () => Promise<TerminalSuspension>,
  requests: Stream.Stream<InspectRequests, never, R2>,
  dispatch: (message: Message) => void,
) {
  let lastId: number | undefined;
  yield* Stream.runForEach(requests, (request) =>
    Effect.gen(function* () {
      if (!request.pager || request.pager.id === lastId) return;
      lastId = request.pager.id;
      const error = yield* pageDiff(read, runner, suspend, request);
      dispatch({ type: "pager-result", id: request.pager.id, error });
    }),
  );
});
