import { stat } from "node:fs/promises";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Queue, Stream } from "effect";
import { render, Text, useApp, useInput } from "ink";
import { createElement, useEffect } from "react";
import { expect } from "vitest";
import { initialState } from "../src/core/monitor/model";
import type { Message } from "../src/core/monitor/model-types";
import { WorktreeInvalid } from "../src/errors";
import { type InspectRequests, runInspect } from "../src/tui/inspect-executor";
import { makePagerRunner, runPagers } from "../src/tui/pager";
import { runMonitor } from "../src/tui/run";
import type { MonitorApp } from "../src/tui/screen";
import { eventsPlatform } from "./helpers/events";
import { defaults, detail, detailLive, live, now, run } from "./helpers/monitor";
import { monitorTerminal } from "./helpers/monitor-terminal";

const InspectionApp: typeof MonitorApp = (props) => {
  useInput((input, key) => props.onKey(key.return ? "enter" : input));
  const files = props.model.detail?.panes.find((pane) => pane.id === "files");
  return createElement(
    Text,
    {},
    props.model.detail
      ? `Opened detail\n${JSON.stringify(files)}\n${JSON.stringify(props.model.review?.files)}`
      : `Selected ${props.model.selected}`,
  );
};

it.live.each([
  { state: "running", named: false },
  { state: "idle", named: false },
  { state: "running", named: true },
] as const)(
  "loads files once after the first detail feed ($state, named=$named)",
  ({ state, named }) =>
    Effect.gen(function* () {
      const terminal = monitorTerminal(140, 40);
      const data = detail(run("inspect-first", { state }));
      const feeds = yield* Queue.unbounded<ReturnType<typeof detailLive>>();
      const calls: unknown[] = [];
      const worker = yield* Effect.forkChild(
        runMonitor(
          {
            stdin: terminal.stdin,
            stdout: terminal.stdout,
            stderr: terminal.stdout,
            stdinIsTTY: true,
            stdoutIsTTY: true,
            columns: 140,
            rows: 40,
            resize: Stream.empty,
          },
          {
            group: "/repo",
            defaults,
            version: "test",
            now,
            columns: 140,
            rows: 40,
            ...(named ? { name: data.run.name } : {}),
          },
          Stream.make(live([data.run])),
          () => Stream.fromQueue(feeds),
          true,
          undefined,
          InspectionApp,
          undefined,
          undefined,
          {
            changes: (...args) =>
              Effect.sync(() => {
                calls.push(args);
                return [
                  {
                    path: "loaded-once.ts",
                    status: "modified",
                    added: 1,
                    removed: 0,
                    outside: false,
                  },
                ];
              }),
            diff: () => Effect.die("unexpected diff"),
          },
        ).pipe(Effect.scoped),
      );
      if (!named) {
        yield* Effect.promise(() => terminal.waitFor("inspect-first"));
        terminal.stdin.push(state === "idle" ? "r" : "\r");
      }
      yield* Effect.promise(() => terminal.waitFor("Opened detail"));
      expect(calls).toEqual([]);
      yield* Queue.offer(feeds, detailLive(data));
      yield* Effect.promise(() => terminal.waitFor("loaded-once.ts"));
      yield* Queue.offer(feeds, detailLive(data));
      terminal.stdin.push("q");
      yield* Fiber.join(worker);
      expect(calls).toEqual([[data.record.worktree, data.record.baseCommit, data.contract]]);
    }).pipe(Effect.provide(eventsPlatform)),
);

function request(id = 1): InspectRequests {
  const data = detail();
  const base = initialState({
    group: "/repo",
    defaults,
    version: "test",
    now,
    columns: 140,
    rows: 40,
    name: data.run.name,
  });
  if (!base.detail) throw new Error("Expected named detail");
  return {
    detail: {
      ...base.detail,
      feed: detailLive(data),
      changes: { id, files: null, error: null, selected: 0 },
      diff: { id: id + 10, path: "src/client.ts", text: null, error: null, offset: 0 },
    },
    pager: { id: id + 20, name: data.run.name },
  };
}
it.effect(
  "reads each changes and diff id once with loaded worktree, base, contract and 512 KB limit",
  () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const messages: Message[] = [];
      const data = detail();
      yield* runInspect(
        {
          changes: (...args) =>
            Effect.sync(() => {
              calls.push(args);
              return [];
            }),
          diff: (...args) =>
            Effect.sync(() => {
              calls.push(args);
              return { text: "diff", truncated: false };
            }),
        },
        Stream.make(request(), request(), request(2)),
        (message) => messages.push(message),
      );
      expect(calls).toEqual([
        [data.record.worktree, data.record.baseCommit, data.contract],
        [data.record.worktree, data.record.baseCommit, "src/client.ts", 512 * 1024],
        [data.record.worktree, data.record.baseCommit, data.contract],
        [data.record.worktree, data.record.baseCommit, "src/client.ts", 512 * 1024],
      ]);
      expect(messages).toEqual([
        { type: "changes-result", id: 1, files: [], error: null },
        { type: "diff-result", id: 11, text: { text: "diff", truncated: false }, error: null },
        { type: "changes-result", id: 2, files: [], error: null },
        { type: "diff-result", id: 12, text: { text: "diff", truncated: false }, error: null },
      ]);
    }),
);
it.effect("replies with errors for changes and diff before detail data is loaded", () =>
  Effect.gen(function* () {
    const value = request();
    const messages: Message[] = [];
    yield* runInspect(
      { changes: () => Effect.die("must not read"), diff: () => Effect.die("must not read") },
      Stream.make({ ...value, detail: value.detail && { ...value.detail, feed: null } }),
      (message) => messages.push(message),
    );
    expect(messages).toEqual([
      { type: "changes-result", id: 1, files: null, error: expect.stringContaining("not loaded") },
      { type: "diff-result", id: 11, text: null, error: expect.stringContaining("not loaded") },
    ]);
  }),
);
it.effect("preserves reader failure detail in both replies", () =>
  Effect.gen(function* () {
    const messages: Message[] = [];
    const fail = () =>
      Effect.fail(new WorktreeInvalid({ detail: "git cannot read this worktree" }));
    yield* runInspect({ changes: fail, diff: fail }, Stream.make(request()), (message) =>
      messages.push(message),
    );
    expect(messages).toEqual([
      { type: "changes-result", id: 1, files: null, error: "git cannot read this worktree" },
      { type: "diff-result", id: 11, text: null, error: "git cannot read this worktree" },
    ]);
  }),
);
it.effect.each(["success", "failure", "nonzero"] as const)(
  "pager %s restores the terminal, removes its private file and replies once",
  (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const order: string[] = [];
      const messages: Message[] = [];
      let filename = "";
      const data = detail();
      yield* runPagers(
        (...args) =>
          Effect.sync(() => {
            expect(args).toEqual([
              data.record.worktree,
              data.record.baseCommit,
              null,
              16 * 1024 * 1024,
            ]);
            return { text: "whole diff\n", truncated: false };
          }),
        (file) =>
          Effect.gen(function* () {
            filename = file;
            order.push("run");
            expect(yield* fs.readFileString(file)).toBe("whole diff\n");
            expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600);
            if (kind === "failure") return yield* Effect.fail(new Error("pager unavailable"));
            return kind === "nonzero" ? 2 : 0;
          }),
        async () => {
          order.push("suspend");
          return {
            resume: async () => {
              order.push("resume");
            },
            [Symbol.asyncDispose]: async () => {},
          };
        },
        Stream.make(request(), request()),
        (message) => messages.push(message),
      );
      expect(order).toEqual(["suspend", "run", "resume"]);
      expect(yield* fs.exists(filename)).toBe(false);
      expect(messages).toEqual([
        {
          type: "pager-result",
          id: 21,
          error: {
            success: null,
            failure: "pager unavailable",
            nonzero: "Pager exited with status 2.",
          }[kind],
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each([true, false])(
  "runs configured PAGER or less -R with inherited stdio (configured=%s)",
  (configured) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fm-pager-test-" });
      const file = `${dir}/diff with spaces`;
      yield* fs.writeFileString(file, "diff");
      yield* fs.writeFileString(`${dir}/pager`, '#!/bin/sh\nprintf "%s\\n" "$@" > "$2"\n', {
        mode: 0o700,
      });
      yield* fs.writeFileString(`${dir}/less`, '#!/bin/sh\nprintf "%s\\n" "$@" > "$2"\n', {
        mode: 0o700,
      });
      const runner = yield* makePagerRunner({
        PATH: dir,
        ...(configured ? { PAGER: "pager 'two words'" } : {}),
      });
      expect(yield* runner(file)).toBe(0);
      expect(yield* fs.readFileString(file)).toBe(`${configured ? "two words" : "-R"}\n${file}\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["missing", "read", "limit"] as const)(
  "reports pager %s failure before taking terminal ownership",
  (kind) =>
    Effect.gen(function* () {
      const value = request();
      const messages: Message[] = [];
      yield* runPagers(
        () =>
          kind === "read"
            ? Effect.fail(new WorktreeInvalid({ detail: "git diff failed" }))
            : Effect.succeed({ text: "", truncated: true }),
        () => Effect.die("must not start pager"),
        async () => {
          throw new Error("must not suspend");
        },
        Stream.make(
          kind === "missing"
            ? { ...value, detail: value.detail && { ...value.detail, feed: null } }
            : value,
        ),
        (message) => messages.push(message),
      );
      expect(messages).toEqual([
        {
          type: "pager-result",
          id: 21,
          error: {
            missing: expect.stringContaining("not loaded"),
            read: "git diff failed",
            limit: "Diff exceeds the 16 MB pager limit.",
          }[kind],
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

function PagerApp({ ready }: { ready: Deferred.Deferred<ReturnType<typeof useApp>> }) {
  const app = useApp();
  useInput(() => {});
  useEffect(() => {
    Deferred.doneUnsafe(ready, Effect.succeed(app));
  }, [app, ready]);
  return createElement(Text, {}, "pager fixture");
}
it.effect.each([false, true])(
  "restores Ink raw mode, alternate screen and repaint after pager cancellation=%s",
  (cancel) =>
    Effect.gen(function* () {
      const terminal = monitorTerminal();
      const ready = yield* Deferred.make<ReturnType<typeof useApp>>();
      const mounted = yield* Effect.acquireRelease(
        Effect.sync(() =>
          render(createElement(PagerApp, { ready }), {
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
      const started = yield* Deferred.make<string>();
      const replies = yield* Queue.unbounded<Message>();
      const requests = yield* Queue.unbounded<InspectRequests>();
      const fs = yield* FileSystem.FileSystem;
      const worker = yield* Effect.forkChild(
        runPagers(
          () => Effect.succeed({ text: "whole diff", truncated: false }),
          (file) =>
            Effect.gen(function* () {
              expect(terminal.stdin.isRaw).toBe(false);
              expect(terminal.output()).toContain("\u001b[?1049l");
              yield* Deferred.succeed(started, file);
              return yield* cancel ? Effect.never : Effect.succeed(0);
            }),
          app.suspendTerminal,
          Stream.fromQueue(requests),
          (message) => {
            Queue.offerUnsafe(replies, message);
          },
        ),
      );
      yield* Queue.offer(requests, request());
      const filename = yield* Deferred.await(started);
      if (cancel) yield* Fiber.interrupt(worker);
      else
        expect(yield* Queue.take(replies)).toEqual({ type: "pager-result", id: 21, error: null });
      expect(yield* fs.exists(filename)).toBe(false);
      expect(terminal.stdin.isRaw).toBe(true);
      expect(terminal.output().split("\u001b[?1049h")).toHaveLength(3);
      expect(terminal.output().split("\u001b[?1049h").at(-1)).toContain("pager fixture");
      yield* Fiber.interrupt(worker);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
