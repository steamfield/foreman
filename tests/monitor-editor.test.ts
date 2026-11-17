import { stat } from "node:fs/promises";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Queue, Stream } from "effect";
import { render, Text, useApp, useInput } from "ink";
import { createElement, useEffect } from "react";
import { expect } from "vitest";
import type { ActMessage, ActState } from "../src/core/monitor/act";
import { type EditorRunner, makeEditorRunner, runEditors } from "../src/tui/editor";
import { monitorTerminal } from "./helpers/monitor-terminal";

type Request = NonNullable<ActState["editor"]>;
function EditorApp({ ready }: { ready: Deferred.Deferred<ReturnType<typeof useApp>> }) {
  const app = useApp();
  useInput(() => {});
  useEffect(() => {
    Deferred.doneUnsafe(ready, Effect.succeed(app));
  }, [app, ready]);
  return createElement(Text, {}, "editor fixture");
}
const fixture = Effect.gen(function* () {
  const terminal = monitorTerminal();
  const ready = yield* Deferred.make<ReturnType<typeof useApp>>();
  const mounted = yield* Effect.acquireRelease(
    Effect.sync(() =>
      render(createElement(EditorApp, { ready }), {
        stdin: terminal.stdin,
        stdout: terminal.stdout,
        interactive: true,
        alternateScreen: true,
        patchConsole: false,
        exitOnCtrlC: false,
      }),
    ),
    (app) =>
      Effect.promise(async () => {
        app.unmount();
        await app.waitUntilExit();
        app.cleanup();
      }),
  );
  const app = yield* Deferred.await(ready);
  yield* Effect.promise(() => mounted.waitUntilRenderFlush());
  const requests = yield* Queue.unbounded<Request>();
  const messages = yield* Queue.unbounded<ActMessage>();
  const received: ActMessage[] = [];
  const dispatch = (message: ActMessage) => {
    received.push(message);
    Queue.offerUnsafe(messages, message);
  };
  return { terminal, app, requests, messages, received, dispatch };
});

it.effect(
  "edits each new id once, restores raw/alternate screen with repaint and deletes the private file",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const files: string[] = [];
      const runner: EditorRunner = (file) =>
        Effect.gen(function* () {
          files.push(file);
          expect(yield* fs.readFileString(file)).toBe("draft");
          expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600);
          expect(f.terminal.stdin.isRaw).toBe(false);
          expect(f.terminal.output()).toContain("\u001b[?1049l");
          yield* fs.writeFileString(file, "edited\n\n");
          return 0;
        });
      const worker = yield* Effect.forkChild(
        runEditors(runner, f.app.suspendTerminal, Stream.fromQueue(f.requests), f.dispatch),
      );
      yield* Queue.offer(f.requests, { id: 1, text: "draft" });
      expect(yield* Queue.take(f.messages)).toEqual({
        type: "editor-result",
        id: 1,
        text: "edited\n",
        error: null,
      });
      expect(f.terminal.stdin.isRaw).toBe(true);
      const resumed = f.terminal.output().split("\u001b[?1049h");
      expect(resumed).toHaveLength(3);
      expect(resumed.at(-1)).toContain("editor fixture");
      expect(yield* fs.exists(files[0] ?? "missing")).toBe(false);
      yield* Queue.offer(f.requests, { id: 1, text: "draft" });
      yield* Queue.offer(f.requests, { id: 2, text: "draft" });
      expect(yield* Queue.take(f.messages)).toMatchObject({ id: 2, text: "edited\n" });
      yield* Fiber.interrupt(worker);
      expect(files).toHaveLength(2);
      for (const file of files) expect(yield* fs.exists(file)).toBe(false);
      expect(f.received).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect.each(["nonzero", "empty", "spawn", "read"] as const)(
  "handles editor %s and always cleans up and restores the terminal",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      let filename = "";
      const runner: EditorRunner = (file) =>
        Effect.gen(function* () {
          filename = file;
          if (kind === "spawn") return yield* Effect.fail(new Error("Cannot spawn editor fixture"));
          if (kind === "read") yield* fs.remove(file);
          else yield* fs.writeFileString(file, kind === "empty" ? "" : "changed");
          return kind === "nonzero" ? 2 : 0;
        });
      const worker = yield* Effect.forkChild(
        runEditors(runner, f.app.suspendTerminal, Stream.fromQueue(f.requests), f.dispatch),
      );
      yield* Queue.offer(f.requests, { id: 1, text: "draft" });
      const message = yield* Queue.take(f.messages);
      expect(message).toEqual({
        type: "editor-result",
        id: 1,
        text: null,
        error: {
          spawn: "Cannot spawn editor fixture",
          read: expect.stringMatching(/ENOENT|NotFound|no such file/i),
          nonzero: null,
          empty: null,
        }[kind],
      });
      expect(yield* fs.exists(filename)).toBe(false);
      expect(f.terminal.stdin.isRaw).toBe(true);
      expect(f.terminal.output().split("\u001b[?1049h")).toHaveLength(3);
      yield* Fiber.interrupt(worker);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("cancelling an editor restores the terminal and removes its draft", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const fs = yield* FileSystem.FileSystem;
    const started = yield* Deferred.make<string>();
    const worker = yield* Effect.forkChild(
      runEditors(
        (file) => Deferred.succeed(started, file).pipe(Effect.andThen(Effect.never)),
        f.app.suspendTerminal,
        Stream.fromQueue(f.requests),
        f.dispatch,
      ),
    );
    yield* Queue.offer(f.requests, { id: 1, text: "draft" });
    const file = yield* Deferred.await(started);
    yield* Fiber.interrupt(worker);
    expect(yield* fs.exists(file)).toBe(false);
    expect(f.terminal.stdin.isRaw).toBe(true);
    expect(f.received).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect.each([
  { VISUAL: "visual", EDITOR: "editor", expected: "visual" },
  { VISUAL: "  ", EDITOR: "editor", expected: "editor" },
  { VISUAL: "", EDITOR: "", expected: "vi" },
])("chooses $expected with inherited stdio", (env) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fm-editor-test-" });
    for (const name of ["visual", "editor", "vi"]) {
      yield* fs.writeFileString(`${dir}/${name}`, `#!/bin/sh\nprintf '%s' '${name}' > "$1"\n`, {
        mode: 0o700,
      });
    }
    const file = `${dir}/draft`;
    yield* fs.writeFileString(file, "draft");
    const runner = yield* makeEditorRunner({ VISUAL: env.VISUAL, EDITOR: env.EDITOR, PATH: dir });
    expect(yield* runner(file)).toBe(0);
    expect(yield* fs.readFileString(file)).toBe(env.expected);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("reports a configured executable that cannot be spawned and restores the terminal", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const runner = yield* makeEditorRunner({ VISUAL: "/no-such-foreman-editor" });
    const worker = yield* Effect.forkChild(
      runEditors(runner, f.app.suspendTerminal, Stream.fromQueue(f.requests), f.dispatch),
    );
    yield* Queue.offer(f.requests, { id: 1, text: "draft" });
    expect(yield* Queue.take(f.messages)).toEqual({
      type: "editor-result",
      id: 1,
      text: null,
      error: expect.stringContaining("/no-such-foreman-editor"),
    });
    expect(f.terminal.stdin.isRaw).toBe(true);
    yield* Fiber.interrupt(worker);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
