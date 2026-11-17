import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import chalk from "chalk";
import { Deferred, Effect, FileSystem, Queue, Schema, Stream } from "effect";
import { Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "vitest";
import { cli } from "../src/cli";
import { makeMonitorCommand, monitorCommand } from "../src/commands/monitor";
import { AppConfig } from "../src/config";
import type { MonitorFeed } from "../src/core/monitor/feed";
import { requestJson } from "../src/daemon/protocol";
import { daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { Overview } from "../src/schemas/monitor";
import { makeSupervisor } from "../src/supervisor";
import { askOrchestrator, successfulTurn } from "./fixtures/fake-app-server/scenarios";
import { listeningSockets, runCli } from "./helpers/cli";
import { eventsFixture, eventsPlatform } from "./helpers/events";
import { live, overview, run, subagents } from "./helpers/monitor";
import { monitorTerminal } from "./helpers/monitor-terminal";

const parsed = (
  args: readonly string[],
  terminal = monitorTerminal(),
  source?: Parameters<typeof makeMonitorCommand>[0],
) =>
  Command.runWith(cli("test-cli", source ? makeMonitorCommand(source) : monitorCommand), {
    version: "dev",
    renderErrors: false,
  })(args).pipe(Effect.provide(terminal.layer));

const withRun = (
  test: (fixture: Effect.Success<ReturnType<typeof eventsFixture>>) => Promise<void>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* eventsFixture(successfulTurn());
      yield* fixture.untilState("idle");
      yield* Effect.promise(() => test(fixture));
    }).pipe(Effect.scoped, Effect.provide(eventsPlatform)),
  );
describe("monitor command", () => {
  it("opens a pending run through the real overview and detail feeds and exits cleanly", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* eventsFixture(askOrchestrator());
        const terminal = monitorTerminal(140);
        const controller = new AbortController();
        const cwd = process.cwd();
        process.chdir(`${fixture.root}/repo`);
        const pending = runCli(["monitor"], {
          home: fixture.root,
          env: fixture.env,
          signal: controller.signal,
          program: Command.runWith(cli("test-cli", monitorCommand), {
            version: "dev",
            renderErrors: false,
          })(["monitor"]).pipe(Effect.provide(terminal.layer)),
        });
        yield* Effect.promise(async () => {
          try {
            await terminal.waitFor("foreman answer unit q1 --file <path>");
            await terminal.waitFor(/unit\s+waiting/);
            terminal.stdin.push("\r");
            await terminal.waitFor("Task");
            await terminal.waitFor("Read the repo.");
            const beforeEsc = terminal.output().length;
            terminal.stdin.push("\u001b");
            await terminal.waitFor("a answer", beforeEsc);
            terminal.stdin.push("q");
            expect(await pending).toEqual({ status: 0, stdout: "", stderr: "" });
            expect(terminal.output().split("\u001b[?1049l")).toHaveLength(2);
            expect(terminal.stdin.isRaw).toBe(false);
          } finally {
            controller.abort();
            await pending;
            process.chdir(cwd);
          }
        });
      }).pipe(Effect.scoped, Effect.provide(eventsPlatform)),
    );
  });

  it.each(["monitor", "status"])(
    "keeps %s readable when cwd git discovery fails",
    async (command) => {
      const terminal = monitorTerminal();
      const args = command === "status" ? ["status", "--all"] : ["monitor"];
      const program = Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return yield* parsed(args, terminal).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
            ...spawner,
            spawn: () =>
              spawner.spawn(
                ChildProcess.make(process.execPath, [
                  "-e",
                  "process.stderr.write('fatal: unsafe repository'); process.exit(128)",
                ]),
              ),
          }),
        );
      });
      if (command === "monitor") {
        await withRun(async (fixture) => {
          const pending = runCli(args, {
            program,
            home: fixture.root,
            env: { ...fixture.env, LOG_LEVEL: "debug" },
          });
          try {
            await terminal.waitFor("unit");
            terminal.stdin.push("q");
            const result = await pending;
            expect(result.status).toBe(0);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain("monitor.cwd-group-unavailable");
          } finally {
            terminal.stdin.push("q");
            await pending;
          }
        });
      } else {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const fixture = yield* eventsFixture(successfulTurn());
              yield* fixture.untilState("idle");
              const result = yield* Effect.promise(() =>
                runCli(args, {
                  program,
                  env: { ...fixture.env, LOG_LEVEL: "debug" },
                  home: fixture.root,
                }),
              );
              expect(result.status).toBe(0);
              expect(result.stdout).toMatch(/^1 run: 1 idle\n/);
              expect(result.stdout).toContain("other repo: its own session supervises it");
              expect(result.stdout).not.toContain("next:");
              expect(result.stderr).toContain("status.cwd-group-unavailable");
            }),
          ).pipe(Effect.provide(eventsPlatform)),
        );
      }
    },
  );
  it("opens a named detail, cancels on Esc, reopens on Enter and restores the terminal", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* eventsFixture(successfulTurn());
        yield* fixture.untilState("idle");
        const polls = yield* Queue.unbounded<Deferred.Deferred<void>>();
        // Observe real long-poll connections; all reads and writes still reach the daemon.
        const sockets = DaemonSockets.layer({
          listen: (path) => NodeSocketServer.make({ path }),
          connect: (path) =>
            NodeSocket.makeNet({ path }).pipe(
              Effect.map((socket) => ({
                ...socket,
                writer: Effect.gen(function* () {
                  const writer = yield* socket.writer;
                  const closed = yield* Deferred.make<void>();
                  let polling = false;
                  yield* Effect.addFinalizer(() =>
                    polling ? Deferred.succeed(closed, undefined) : Effect.void,
                  );
                  return {
                    ...writer,
                    write: (chunk) =>
                      Effect.gen(function* () {
                        if (typeof chunk === "string") {
                          const request = yield* Schema.decodeUnknownEffect(requestJson)(
                            chunk.trim(),
                          ).pipe(Effect.orDie);
                          if (request.body._tag === "Detail" && request.body.after !== undefined) {
                            polling = true;
                            yield* Queue.offer(polls, closed);
                          }
                        }
                        yield* writer.write(chunk);
                      }),
                  } satisfies typeof writer;
                }),
              })),
            ),
        });
        const terminal = monitorTerminal();
        const args = ["monitor", fixture.name];
        const controller = new AbortController();
        const pending = runCli(args, {
          home: fixture.root,
          env: fixture.env,
          signal: controller.signal,
          program: parsed(args, terminal).pipe(Effect.provide(sockets)),
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            controller.abort();
            await pending;
          }),
        );
        yield* Effect.promise(() => terminal.waitFor("Read the repo."));
        for (let opened = 0; opened < 2; opened++) {
          const closed = yield* Queue.take(polls);
          yield* Effect.promise(async () => {
            const before = terminal.output().length;
            terminal.stdin.push("\u001b");
            await terminal.waitFor("a answer", before);
          });
          yield* Deferred.await(closed).pipe(Effect.timeout("3 seconds"));
          if (opened === 0)
            yield* Effect.promise(async () => {
              const before = terminal.output().length;
              terminal.stdin.push("\r");
              await terminal.waitFor("Task", before);
            });
        }
        terminal.stdin.push("q");
        expect(yield* Effect.promise(() => pending)).toEqual({ status: 0, stdout: "", stderr: "" });
        expect(terminal.output().split("\u001b[?1049l")).toHaveLength(2);
        expect(terminal.stdin.isRaw).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(eventsPlatform)),
    );
  });
  it.each(["text", "json", "delegate"])(
    "named monitor matches named status in %s mode",
    async (mode) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* eventsFixture(successfulTurn());
            yield* fixture.untilState("idle");
            const args = ["monitor", fixture.name, ...(mode === "json" ? ["--json"] : [])];
            const env = { ...fixture.env, ...(mode === "delegate" ? { CODEX_DELEGATE: "1" } : {}) };
            const terminal = monitorTerminal();
            const status = yield* Effect.promise(() =>
              runCli(["status", fixture.name, ...(mode === "json" ? ["--json"] : [])], {
                home: fixture.root,
                env,
              }),
            );
            const result = yield* Effect.promise(() =>
              runCli(args, {
                home: fixture.root,
                env,
                ...(mode === "delegate" ? { program: parsed(args, terminal) } : {}),
              }),
            );
            expect(result).toEqual({
              status: status.status,
              stdout: status.stdout,
              stderr:
                mode === "json"
                  ? ""
                  : "The live view needs an interactive terminal; showing a snapshot.\n",
            });
            expect(result.status).toBe(0);
            expect(terminal.output()).toBe("");
          }),
        ).pipe(Effect.provide(eventsPlatform)),
      );
    },
  );
  it("forwards Page Down and Page Up to reach a long subagent list", async () => {
    const terminal = monitorTerminal(100, 24);
    const pending = runCli(["monitor"], {
      program: parsed(["monitor"], terminal, () =>
        Stream.make(live([run("many", { subagents: subagents(24) })])),
      ),
    });
    await expect.poll(() => terminal.output()).toContain("child-00");
    expect(terminal.output()).not.toContain("child-23");
    terminal.stdin.push("\u001b[6~");
    await expect.poll(() => terminal.output()).toContain("child-23");
    const before = terminal.output().length;
    terminal.stdin.push("\u001b[5~");
    await expect.poll(() => terminal.output().slice(before)).toContain("many");
    terminal.stdin.push("q");
    expect(await pending).toEqual({ status: 0, stdout: "", stderr: "" });
  });
  it("keeps the reconnect countdown amber while retained rows are muted", async () => {
    const previous = chalk.level;
    chalk.level = 3;
    const terminal = monitorTerminal(140);
    const feed: MonitorFeed = {
      _tag: "Reconnecting",
      last: overview([run()]),
      retryAt: Date.now() + 4000,
      reason: "Connection lost",
    };
    const pending = runCli(["monitor"], {
      program: parsed(["monitor"], terminal, () => Stream.make(feed)),
    });
    try {
      await expect.poll(() => terminal.output()).toContain("reconnecting in");
      terminal.stdin.push("q");
      expect(await pending).toEqual({ status: 0, stdout: "", stderr: "" });
      expect(terminal.output()).toMatch(/38;2;226;192;79mreconnecting in/);
      expect(terminal.output()).not.toMatch(/38;2;111;168;255m⣾/);
    } finally {
      terminal.stdin.push("q");
      await pending;
      chalk.level = previous;
    }
  });
  it("honors NO_COLOR for an interactive frame", async () => {
    const previous = chalk.level;
    chalk.level = 3;
    try {
      await withRun(async (fixture) => {
        const terminal = monitorTerminal();
        const pending = runCli(["monitor"], {
          home: fixture.root,
          env: { ...fixture.env, NO_COLOR: "1" },
          program: parsed(["monitor"], terminal),
        });
        await terminal.waitFor("unit");
        terminal.stdin.push("q");
        expect(await pending).toEqual({ status: 0, stdout: "", stderr: "" });
        expect(terminal.output()).not.toMatch(
          new RegExp(`${String.fromCharCode(27)}\\[(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:;|m)`),
        );
        expect(terminal.output()).toContain("\u001b[7m");
      });
    } finally {
      chalk.level = previous;
    }
  });
  it.each(["text", "json", "delegate", "only stdin is a TTY"])(
    "prints the status --all snapshot in %s mode",
    async (mode) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const root = yield* fs.makeTempDirectoryScoped({
              directory: "/tmp",
              prefix: "fm-mon-",
            });
            const env = {
              HOME: root,
              FOREMAN_HOME: `${root}/d`,
              LOG_LEVEL: "none",
              ...(mode === "delegate" ? { CODEX_DELEGATE: "1" } : {}),
            };
            const supervisor = yield* makeSupervisor().pipe(Effect.provide(AppConfig.layer(env)));
            const ready = yield* Deferred.make<void>();
            yield* daemon({ dataDir: env.FOREMAN_HOME, version: "dev", ...supervisor }).pipe(
              Effect.provide(listeningSockets(Deferred.succeed(ready, undefined))),
              Effect.forkScoped,
            );
            yield* Deferred.await(ready);
            const args = ["monitor", ...(mode === "json" ? ["--json"] : [])];
            const terminal = monitorTerminal(100, 40, mode !== "only stdin is a TTY");
            const result = yield* Effect.promise(() =>
              runCli(args, {
                home: root,
                env,
                ...(mode === "delegate" || mode === "only stdin is a TTY"
                  ? { program: parsed(args, terminal) }
                  : {}),
              }),
            );
            expect(result.status).toBe(0);
            expect(result.stderr).toBe(
              mode === "json"
                ? ""
                : "The live view needs an interactive terminal; showing a snapshot.\n",
            );
            if (mode === "json")
              expect(Schema.decodeUnknownSync(Overview)(JSON.parse(result.stdout))).toMatchObject({
                _tag: "Overview",
                version: 0,
                runs: [],
              });
            else expect(result.stdout).toBe("0 runs\n");
            expect(terminal.output()).toBe("");
            expect(terminal.stdin.isRaw).toBe(false);
          }),
        ).pipe(Effect.provide(eventsPlatform)),
      );
    },
  );
  it.each(["q", "\u0003"])(
    "renders a fixture through the parser and restores the terminal on %j",
    async (key) => {
      await withRun(async (fixture) => {
        const terminal = monitorTerminal();
        const pending = runCli(["monitor"], {
          home: fixture.root,
          env: fixture.env,
          program: parsed(["monitor"], terminal),
        });
        await terminal.waitFor("unit");
        expect(terminal.output()).toContain("\u001b[?1049h");
        terminal.stdin.push(key);
        const result = await pending;
        expect(result.status).toBe(key === "q" ? 0 : 130);
        expect(result.stdout).toBe("");
        expect(terminal.output()).toContain("\u001b[?1049l");
        expect(terminal.stdin.isRaw).toBe(false);
        expect(key === "q" ? result.stderr : result.stderr.replace(/Interrupted[^\n]*\n/, "")).toBe(
          "",
        );
      });
    },
  );
  it("restores the alternate screen after a feed defect", async () => {
    const terminal = monitorTerminal();
    let diagnostic = "";
    const result = await runCli(["monitor"], {
      env: { LOG_LEVEL: "none" },
      stderr: async (text) => {
        diagnostic += text;
        terminal.stdout.write(text);
      },
      program: parsed(["monitor"], terminal, () => Stream.fromEffect(Effect.die("fixture defect"))),
    });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(diagnostic).toBe("Internal error.\n");
    expect(terminal.output()).toContain("\u001b[?1049h");
    expect(terminal.output()).toContain("\u001b[?1049l");
    expect(terminal.output().indexOf("\u001b[?1049l")).toBeLessThan(
      terminal.output().indexOf("Internal error."),
    );
    expect(terminal.stdin.isRaw).toBe(false);
  });
});
