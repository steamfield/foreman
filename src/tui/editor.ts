/**
 * Hands private drafts to an editor while Ink releases the terminal.
 * Ctrl-C in cooked-mode editors such as ed also interrupts the monitor through its SIGINT handler.
 */
import { Effect, FileSystem, Path, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import type { SuspendTerminal } from "ink";
import type { ActMessage, ActState } from "../core/monitor/act";

/** Runs an editor on a prepared private draft file and returns its exit code.
 * @throws {Error} When the editor cannot be started or observed.
 */
export type EditorRunner = (file: string) => Effect.Effect<number, Error>;
type EditorRequest = NonNullable<ActState["editor"]>;
type EditorResult = Extract<ActMessage, { type: "editor-result" }>;

/** Binds the configured editor to the process service with inherited terminal stdio. */
export const makeEditorRunner = Effect.fn("tui.makeEditorRunner")(function* (
  environment: Readonly<Record<string, string | undefined>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const editor = environment.VISUAL?.trim() || environment.EDITOR?.trim() || "vi";
  const runner: EditorRunner = (file) =>
    Effect.scoped(
      Effect.gen(function* () {
        // $EDITOR may carry arguments ("code --wait"); the template parser splits them with shell quoting.
        const parsed = CommandLine.template(Object.assign([editor], { raw: [editor] }));
        if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure);
        const [program, ...args] = parsed.success;
        if (typeof program !== "string")
          return yield* Effect.fail(new Error("Editor command must name an executable."));
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

function editDraft(runner: EditorRunner, suspend: SuspendTerminal, request: EditorRequest) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const errors: string[] = [];
    const recover = (error: Error) =>
      Effect.sync(() => {
        errors.push(error.message);
      });
    const text = yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ prefix: "foreman-editor-" }),
          (directory) =>
            fs.remove(directory, { recursive: true, force: true }).pipe(Effect.catch(recover)),
        );
        const file = path.join(directory, "draft.txt");
        yield* fs.writeFileString(file, request.text, { mode: 0o600, flag: "wx" });
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
        if (code !== 0) return null;
        const content = yield* fs.readFileString(file);
        return content.replace(/\n$/, "") || null;
      }).pipe(Effect.catch((error) => recover(error).pipe(Effect.as(null)))),
    );
    return {
      type: "editor-result",
      id: request.id,
      text: errors.length ? null : text,
      error: errors.length ? errors.join("; ") : null,
    } satisfies EditorResult;
  });
}

/** Executes each new editor request once and reports readback after terminal restoration. */
export const runEditors = Effect.fn("tui.runEditors")(function* <R>(
  runner: EditorRunner,
  suspend: SuspendTerminal,
  requests: Stream.Stream<EditorRequest, never, R>,
  dispatch: (message: ActMessage) => void,
) {
  let lastId = 0;
  yield* Stream.runForEach(requests, (request) =>
    Effect.gen(function* () {
      if (request.id === lastId) return;
      lastId = request.id;
      const result = yield* editDraft(runner, suspend, request);
      dispatch(result);
    }),
  );
});
