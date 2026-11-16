import chalk from "chalk";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { Command } from "effect/cli";
import { describe, expect, it } from "vitest";
import { cli } from "../src/cli";
import { makeMonitorCommand } from "../src/commands/monitor";
import { AppConfig } from "../src/config";
import type { MonitorFeed } from "../src/core/monitor/feed";
import { call } from "../src/daemon/client";
import { daemon } from "../src/daemon/server";
import { Overview } from "../src/schemas/monitor";
import { makeSupervisor } from "../src/supervisor";
import { successfulTurn } from "./fixtures/fake-app-server/scenarios";
import { runCli } from "./helpers/cli";
import { eventsFixture, eventsPlatform } from "./helpers/events";
import { detailLive, live, mixedRuns, overview, run, subagents } from "./helpers/monitor";
import { monitorTerminal } from "./helpers/monitor-terminal";

const parsed = (
  args: readonly string[],
  terminal = monitorTerminal(),
  source = () => Stream.make(live(mixedRuns())),
  detailSource = () => Stream.make(detailLive()),
) =>
  Command.runWith(cli("test-cli", makeMonitorCommand(source, detailSource)), {
    version: "dev",
    renderErrors: false,
  })(args).pipe(Effect.provide(terminal.layer));
describe("monitor command", () => {
  it("opens a named detail, cancels on Esc, reopens on Enter and restores the terminal", async () => {
    const terminal = monitorTerminal();
    const subscriptions: string[] = [];
    const detailSource = () =>
      Stream.fromEffect(
        Effect.acquireRelease(
          Effect.sync(() => {
            subscriptions.push("opened");
            return detailLive();
          }),
          () =>
            Effect.sync(() => {
              subscriptions.push("closed");
            }),
        ),
      ).pipe(Stream.concat(Stream.never), Stream.scoped);
    const args = ["monitor", "fix-hooks"];
    const pending = runCli(args, { program: parsed(args, terminal, undefined, detailSource) });
    try {
      await expect.poll(() => terminal.output(), { timeout: 5000 }).toContain("Task");
      expect(subscriptions).toEqual(["opened"]);
      terminal.stdin.push("\u001b");
      await expect.poll(() => subscriptions).toEqual(["opened", "closed"]);
      terminal.stdin.push("\r");
      await expect.poll(() => subscriptions).toEqual(["opened", "closed", "opened"]);
      terminal.stdin.push("\u001b");
      await expect.poll(() => subscriptions).toEqual(["opened", "closed", "opened", "closed"]);
      terminal.stdin.push("q");
      expect(await pending).toEqual({ status: 0, stdout: "", stderr: "" });
      expect(terminal.output()).toContain("\u001b[?1049l");
      expect(terminal.stdin.isRaw).toBe(false);
    } finally {
      terminal.stdin.push("q");
      await pending;
    }
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
    const terminal = monitorTerminal();
    const pending = runCli(["monitor"], {
      env: { NO_COLOR: "1" },
      program: parsed(["monitor"], terminal),
    });
    await expect.poll(() => terminal.output()).toContain("fix-hooks");
    terminal.stdin.push("q");
    expect(await pending).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(terminal.output()).not.toMatch(
      new RegExp(`${String.fromCharCode(27)}\\[(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:;|m)`),
    );
    expect(terminal.output()).toContain("\u001b[7m");
  });
  it.each(["text", "json", "delegate"])(
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
            yield* daemon({ dataDir: env.FOREMAN_HOME, version: "dev", ...supervisor }).pipe(
              Effect.forkScoped,
            );
            while (
              (yield* call({ _tag: "Ping" }, { dataDir: env.FOREMAN_HOME, connectOnly: true }).pipe(
                Effect.result,
              ))._tag !== "Success"
            )
              yield* Effect.yieldNow;
            const args = ["monitor", ...(mode === "json" ? ["--json"] : [])];
            const terminal = monitorTerminal();
            const result = yield* Effect.promise(() =>
              runCli(args, {
                home: root,
                env,
                ...(mode === "delegate" ? { program: parsed(args, terminal) } : {}),
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
          }),
        ).pipe(Effect.provide(eventsPlatform)),
      );
    },
  );
  it.each(["q", "\u0003"])(
    "renders a fixture through the parser and restores the terminal on %j",
    async (key) => {
      const terminal = monitorTerminal();
      const pending = runCli(["monitor"], { program: parsed(["monitor"], terminal) });
      await expect.poll(() => terminal.output()).toContain("fix-hooks");
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
