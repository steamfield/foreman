import { execFileSync } from "node:child_process";
import { chmod, mkdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { AppConfig } from "../src/config";
import { doctor } from "../src/core/doctor";
import { commandResult } from "../src/core/process";
import { DaemonSockets } from "../src/daemon/sockets";
import { RunName, RunRecord } from "../src/schemas/daemon";
import { DoctorResult } from "../src/schemas/doctor";
import { Host } from "../src/services/host";
import { Scenario } from "./fixtures/fake-app-server/scenario";
import { repoHooks } from "./fixtures/fake-app-server/scenarios";
import { runCli, tempDir } from "./helpers/cli";

const platform = Layer.mergeAll(
  NodeServices.layer,
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
  Host.layer({
    name: "forman",
    version: "test",
    build: "test",
    platform: "node",
    compiled: false,
    executable: [process.execPath],
    pid: process.pid,
  }),
);

const settings = (home: string, codexBin: string) =>
  AppConfig.layer({ HOME: home, FORMAN_HOME: home, CODEX_BIN: codexBin }).pipe(
    Layer.provideMerge(platform),
  );

const temp = Effect.fnUntraced(function* () {
  return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "fm-doc-",
  });
});

const entered = Effect.fnUntraced(function* (marker: string) {
  const fs = yield* FileSystem.FileSystem;
  while (!(yield* fs.exists(marker))) yield* Effect.yieldNow;
});

it.live("doctor lists clean and dirty managed orphan worktrees but excludes registered runs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* temp());
    const repo = `${root}/repo`;
    yield* fs.makeDirectory(repo);
    const git = (args: string[]) =>
      commandResult(ChildProcess.make("git", args, { cwd: repo })).pipe(
        Effect.tap(({ code }) => Effect.sync(() => expect(code).toBe(0))),
      );
    yield* git(["init", "-q"]);
    yield* git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    for (const name of ["clean", "dirty", "registered"])
      yield* git(["worktree", "add", "-qb", `forman/${name}`, `${repo}/.claude/worktrees/${name}`]);
    yield* fs.writeFileString(`${repo}/.claude/worktrees/dirty/result.txt`, "work");
    yield* fs.makeDirectory(`${root}/runs/registered`, { recursive: true });
    const record: unknown = JSON.parse(
      yield* fs.readFileString(fileURLToPath(new URL("./fixtures/runs/run.json", import.meta.url))),
    );
    const stored = Schema.decodeUnknownSync(RunRecord)(record);
    yield* fs.writeFileString(
      `${root}/runs/registered/run.json`,
      Schema.encodeSync(Schema.fromJsonString(RunRecord))({
        ...stored,
        name: Schema.decodeUnknownSync(RunName)("registered"),
        worktree: `${repo}/.claude/worktrees/registered`,
        group: repo,
      }),
    );
    const result = yield* doctor(repo).pipe(Effect.provide(settings(root, `${root}/missing`)));
    expect(result).toMatchObject({
      orphans: [
        { path: `${repo}/.claude/worktrees/clean`, branch: "forman/clean", holdsWork: false },
        { path: `${repo}/.claude/worktrees/dirty`, branch: "forman/dirty", holdsWork: true },
      ],
    });
  }).pipe(Effect.provide(platform)),
);

describe("bounded doctor diagnostics", () => {
  it.live("queries the daemon through a single socket connection", () =>
    Effect.gen(function* () {
      const home = yield* temp();
      let connections = 0;
      const server = yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
      yield* Effect.forkScoped(
        server.run((socket) =>
          Effect.scoped(
            Effect.gen(function* () {
              connections++;
              const reader = yield* socket.reader;
              yield* reader.pull;
              yield* (yield* socket.writer).write(
                `${JSON.stringify({ id: 1, result: { _tag: "Pong", version: "test", pid: 123 } })}\n`,
              );
              yield* Effect.never;
            }),
          ).pipe(Effect.catchTag("SocketError", () => Effect.void)),
        ),
      );
      const result = yield* doctor(home).pipe(Effect.provide(settings(home, `${home}/missing`)));
      expect(result.daemon).toMatchObject({ state: "running", pid: 123 });
      expect(connections).toBe(1);
    }).pipe(Effect.provide(platform)),
  );
  it.live.each(["same", "different", "legacy", "absent"] as const)(
    "reports a %s daemon build through text and JSON without replacing it",
    (mode) =>
      Effect.gen(function* () {
        const home = yield* temp();
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        let pid: number | undefined;
        if (mode !== "absent") {
          const bun = (yield* spawner.string(ChildProcess.make("which", ["bun"]))).trim();
          const child = yield* spawner.spawn(
            ChildProcess.make(
              bun,
              [
                fileURLToPath(new URL("./fixtures/daemon/entry.ts", import.meta.url)),
                home,
                mode === "same" ? "test" : "old",
                mode === "legacy" ? "legacy" : "same",
              ],
              { stdout: "ignore", stderr: "inherit", forceKillAfter: "2 seconds" },
            ),
          );
          pid = Number(child.pid);
          yield* entered(`${home}/ready`).pipe(Effect.timeout("3 seconds"));
        }
        for (const json of [false, true]) {
          const result = yield* Effect.promise(() =>
            runCli(["doctor", ...(json ? ["--json"] : [])], {
              home,
              env: { FORMAN_HOME: home, LOG_LEVEL: "none" },
            }),
          );
          expect(result).toMatchObject({ status: 0, stderr: "" });
          const build = { legacy: null, same: "test", different: "old", absent: null }[mode];
          const buildMatches = mode === "legacy" ? null : mode === "same";
          if (json) {
            const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(DoctorResult))(
              result.stdout,
            );
            expect(decoded.daemon).toEqual(
              mode === "absent"
                ? { state: "not running" }
                : {
                    state: "running",
                    version: mode === "legacy" ? "legacy" : "fixture",
                    pid,
                    build,
                    buildMatches,
                  },
            );
          } else if (mode === "absent") expect(result.stdout).toContain("Daemon: not running");
          else {
            expect(result.stdout).toContain(`(pid ${pid})`);
            expect(result.stdout).toContain(`Daemon build: ${build ?? "unknown"}`);
            expect(result.stdout).toContain(
              `Daemon build matches this CLI: ${buildMatches ?? "unknown"}`,
            );
          }
        }
        if (mode === "absent") expect(yield* fs.exists(`${home}/forman.sock`)).toBe(false);
      }).pipe(Effect.provide(platform)),
  );
  it.live("never passes API credentials to doctor Codex probes", () =>
    Effect.gen(function* () {
      const home = yield* temp();
      const fs = yield* FileSystem.FileSystem;
      const bin = `${home}/codex`;
      yield* fs.writeFileString(
        bin,
        `#!${process.execPath}
const fs = require("node:fs");
if (["OPENAI_API_KEY", "OPENAI_API_BASE", "CODEX_API_KEY"].some(k => process.env[k])) process.exit(1);
if (process.argv[2] === "--version") console.log("codex-cli 0.166.0");
if (process.argv[2] === "app-server") fs.writeFileSync(process.argv.at(-1) + "/schema.json", "{}");
`,
        { mode: 0o755 },
      );
      const result = yield* doctor(home).pipe(
        Effect.provide(
          AppConfig.layer({
            HOME: home,
            FORMAN_HOME: home,
            CODEX_BIN: bin,
            OPENAI_API_KEY: "must-not-pass",
            OPENAI_API_BASE: "must-not-pass",
            CODEX_API_KEY: "must-not-pass",
          }),
        ),
      );
      expect(result).toMatchObject({
        codexVersion: "0.166.0",
        protocolMatches: false,
        loggedIn: true,
      });
    }).pipe(Effect.provide(platform)),
  );
  it.each(["same", "different", "absent"] as const)(
    "reports whether forman on PATH is this executable: %s",
    async (target) => {
      const home = await tempDir();
      if (target === "same") await symlink(process.execPath, `${home}/forman`);
      if (target === "different")
        await writeFile(`${home}/forman`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      for (const json of [false, true]) {
        const result = await runCli(["doctor", ...(json ? ["--json"] : [])], {
          home,
          env: { PATH: home, LOG_LEVEL: "none" },
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        if (json)
          expect(JSON.parse(result.stdout)).toMatchObject({ formanOnPath: target === "same" });
        else expect(result.stdout).toContain(`forman on PATH is this binary: ${target === "same"}`);
      }
    },
  );
  it.live("finds a bare Codex executable through the inherited PATH", () =>
    Effect.gen(function* () {
      const home = yield* temp();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${home}/fixture-codex`,
        `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") console.log("codex-cli 0.166.0");
if (process.argv[2] === "app-server") fs.writeFileSync(process.argv.at(-1) + "/schema.json", "{}");
if (process.env.CODEX_HOME !== ${JSON.stringify(`${home}/configured`)}) process.exit(1);
`,
        { mode: 0o755 },
      );
      const result = yield* doctor(home).pipe(
        Effect.provide(
          AppConfig.layer({
            HOME: home,
            FORMAN_HOME: home,
            CODEX_BIN: "fixture-codex",
            CODEX_HOME: `${home}/configured`,
            PATH: home,
          }),
        ),
      );
      expect(result).toMatchObject({
        codexVersion: "0.166.0",
        protocolMatches: false,
        loggedIn: true,
      });
    }).pipe(Effect.provide(platform)),
  );
  it.effect.each(["version", "protocol", "login"] as const)(
    "reports an unavailable %s check when Codex stalls",
    (stalled) =>
      Effect.gen(function* () {
        const home = yield* temp();
        const fs = yield* FileSystem.FileSystem;
        const bin = `${home}/codex`;
        const marker = `${home}/entered`;
        yield* fs.writeFileString(
          bin,
          `#!${process.execPath}
const fs = require("node:fs");
const probe = { "--version": "version", "app-server": "protocol", "login": "login" }[process.argv[2]];
if (probe === ${JSON.stringify(stalled)}) {
  fs.writeFileSync(${JSON.stringify(marker)}, "entered");
  setInterval(() => {}, 1000);
} else if (probe === "version") {
  console.log("codex-cli 0.166.0");
} else if (probe === "protocol") {
  fs.writeFileSync(process.argv.at(-1) + "/schema.json", "{}");
}
`,
          { mode: 0o755 },
        );
        const pending = yield* Effect.forkScoped(
          doctor(home).pipe(Effect.provide(settings(home, bin))),
        );
        yield* entered(marker);
        yield* TestClock.adjust("6 seconds");
        const result = yield* TestClock.withLive(
          Fiber.join(pending).pipe(Effect.timeout("2 seconds")),
        );
        expect(result).toMatchObject({
          codexVersion: stalled === "version" ? null : "0.166.0",
          protocolMatches: stalled === "protocol" ? null : false,
          loggedIn: stalled === "login" ? null : true,
          daemon: { state: "not running" },
        });
      }).pipe(Effect.provide(platform)),
  );

  it.effect("reports an unavailable daemon when its socket accepts Ping but never replies", () =>
    Effect.gen(function* () {
      const home = yield* temp();
      const received = yield* Deferred.make<void>();
      const server = yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
      yield* Effect.forkScoped(
        server.run((socket) =>
          Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* socket.reader;
              yield* reader.pull;
              yield* Deferred.succeed(received, undefined);
              yield* Effect.never;
            }),
          ),
        ),
      );
      const pending = yield* Effect.forkScoped(
        doctor(home).pipe(Effect.provide(settings(home, `${home}/missing-codex`))),
      );
      yield* Deferred.await(received);
      yield* TestClock.adjust("6 seconds");
      const result = yield* TestClock.withLive(
        Fiber.join(pending).pipe(Effect.timeout("2 seconds")),
      );
      expect(result.daemon).toEqual({
        state: "unavailable",
        detail: "Daemon Ping timed out after 5 seconds.",
      });
    }).pipe(Effect.provide(platform)),
  );
});

const fake = fileURLToPath(new URL("./fixtures/fake-app-server/main.mjs", import.meta.url));

it("reports a writable home owned by another user", async () => {
  const root = await tempDir();
  const home = `${root}/state`;
  await symlink("/tmp", home);
  expect((await stat(home)).uid).not.toBe(process.getuid?.());
  const result = await runCli(["doctor", "--json"], {
    home: root,
    env: { FORMAN_HOME: home, LOG_LEVEL: "none" },
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    homePermissions: {
      state: "unsafe",
      detail: expect.stringContaining("owned by another user"),
    },
  });
});

it.live("reports an unreadable daemon socket as unavailable", () =>
  Effect.gen(function* () {
    const home = yield* temp();
    const fs = yield* FileSystem.FileSystem;
    yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
    yield* fs.chmod(`${home}/forman.sock`, 0);
    yield* Effect.addFinalizer(() => fs.chmod(`${home}/forman.sock`, 0o600).pipe(Effect.orDie));
    const result = yield* doctor(home).pipe(Effect.provide(settings(home, `${home}/missing`)));
    expect(result.daemon).toEqual({
      state: "unavailable",
      detail: `Cannot connect to daemon socket ${home}/forman.sock. Check the socket and directory permissions, then retry.`,
    });
  }).pipe(Effect.provide(platform)),
);

it.each(["private", "public", "unwritable", "file", "missing", "blocked-parent"])(
  "inspects a %s home without changing it",
  async (mode) => {
    const root = await tempDir();
    const home = `${root}/state`;
    if (mode === "file") await writeFile(home, "occupied");
    else if (mode !== "missing" && mode !== "blocked-parent") {
      await mkdir(home, { mode: mode === "public" ? 0o755 : 0o700 });
      if (mode === "unwritable") await chmod(home, 0o500);
    }
    if (mode === "blocked-parent") await chmod(root, 0o500);
    try {
      for (const json of [false, true]) {
        const result = await runCli(["doctor", ...(json ? ["--json"] : [])], {
          home: root,
          env: { FORMAN_HOME: home, LOG_LEVEL: "none" },
        });
        expect(result).toMatchObject({ status: 0, stderr: "" });
        const state = {
          private: "ok",
          public: "unsafe",
          unwritable: "unusable",
          file: "unusable",
          missing: "missing",
          "blocked-parent": "unusable",
        }[mode];
        if (json) {
          const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(DoctorResult))(
            result.stdout,
          );
          expect(decoded).toMatchObject({ homePermissions: { state, path: home } });
          if (mode === "public") {
            expect(result.stdout).toContain("chmod 700");
            expect(result.stdout).not.toContain("success(");
          }
        } else expect(result.stdout).toContain(`Home permissions: ${state}`);
      }
      if (mode === "private" || mode === "public" || mode === "unwritable")
        expect((await stat(home)).mode & 0o777).toBe(
          { private: 0o700, public: 0o755, unwritable: 0o500 }[mode],
        );
      if (mode === "missing" || mode === "blocked-parent")
        await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(root, 0o700);
      if (mode === "unwritable") await chmod(home, 0o700);
    }
  },
);

it.live("reports a malformed daemon reply as unavailable in text and JSON", () =>
  Effect.gen(function* () {
    const home = yield* temp();
    const server = yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
    yield* Effect.forkScoped(
      server.run((socket) =>
        Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* socket.reader;
            yield* reader.pull;
            const writer = yield* socket.writer;
            yield* writer.write("not json\n");
            yield* Effect.never;
          }),
        ),
      ),
    );
    for (const json of [false, true]) {
      const result = yield* Effect.promise(() =>
        runCli(["doctor", ...(json ? ["--json"] : [])], {
          home,
          env: { FORMAN_HOME: home, LOG_LEVEL: "none" },
        }),
      );
      expect(result.status).toBe(0);
      if (json)
        expect(JSON.parse(result.stdout)).toMatchObject({
          daemon: { state: "unavailable", detail: expect.stringContaining("decode daemon reply") },
        });
      else expect(result.stdout).toContain("Daemon: unavailable (Could not decode daemon reply");
    }
  }).pipe(Effect.provide(platform)),
);

it.live("reports an invalid daemon handshake and that the command was not sent", () =>
  Effect.gen(function* () {
    const home = yield* temp();
    const server = yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
    yield* Effect.forkScoped(
      server.run((socket) =>
        Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* socket.reader;
            yield* reader.pull;
            yield* (yield* socket.writer).write("not json\n");
            yield* Effect.never;
          }),
        ),
      ),
    );
    const result = yield* Effect.promise(() =>
      runCli(["status", "unit", "--json"], { home, env: { FORMAN_HOME: home, LOG_LEVEL: "none" } }),
    );
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Ping");
    expect(result.stderr).toContain("not sent");
    expect(result.stderr).toContain("forman doctor");
  }).pipe(Effect.provide(platform)),
);

it.live("reports an unexpected valid daemon handshake without sending the command", () =>
  Effect.gen(function* () {
    const home = yield* temp();
    const server = yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
    yield* Effect.forkScoped(
      server.run((socket) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* socket.reader).pull;
            yield* (yield* socket.writer).write(
              `${JSON.stringify({ id: 1, result: { _tag: "Ok" } })}\n`,
            );
            yield* Effect.never;
          }),
        ),
      ),
    );
    const result = yield* Effect.promise(() =>
      runCli(["status", "unit", "--json"], { home, env: { FORMAN_HOME: home, LOG_LEVEL: "none" } }),
    );
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Ping");
    expect(result.stderr).toContain("Ok");
    expect(result.stderr).toContain("not sent");
    expect(result.stderr).toContain("forman doctor");
  }).pipe(Effect.provide(platform)),
);

it.live("reports an unrecognized daemon error without exposing its detail", () =>
  Effect.gen(function* () {
    const home = yield* temp();
    const server = yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
    yield* Effect.forkScoped(
      server.run((socket) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* socket.reader).pull;
            yield* (yield* socket.writer).write(
              `${JSON.stringify({ id: 1, error: { tag: "FutureError", detail: "private response" } })}\n`,
            );
            yield* Effect.never;
          }),
        ),
      ),
    );
    const result = yield* Effect.promise(() =>
      runCli(["status", "unit", "--json"], { home, env: { FORMAN_HOME: home, LOG_LEVEL: "none" } }),
    );
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Ping");
    expect(result.stderr).toContain("not sent");
    expect(result.stderr).toContain("forman doctor");
    expect(result.stderr).not.toContain("private response");
  }).pipe(Effect.provide(platform)),
);

it.live.each(["timeout", "unreadable"] as const)(
  "names the home and remedy after %s shutdown cleanup",
  (mode) =>
    Effect.gen(function* () {
      const home = yield* temp();
      const server = yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.forkScoped(
        server.run((socket) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* (yield* socket.reader).pull;
              if (mode === "unreadable")
                yield* fs.symlink(`${home}/daemon.lock`, `${home}/daemon.lock`);
              yield* (yield* socket.writer).write(
                `${JSON.stringify({ id: 1, result: { _tag: "Ok" } })}\n`,
              );
              yield* Effect.never;
            }),
          ),
        ),
      );
      const result = yield* Effect.promise(() =>
        runCli(["daemon", "stop", "--json"], {
          home,
          env: { FORMAN_HOME: home, LOG_LEVEL: "none" },
        }),
      );
      expect(result.status).toBe(4);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(home);
      expect(result.stderr).toContain("forman doctor");
      expect(result.stderr).toContain(mode === "timeout" ? "10 seconds" : "daemon.lock");
    }).pipe(Effect.provide(platform)),
);

it.live("reports an unexpected valid shutdown reply and its uncertain state", () =>
  Effect.gen(function* () {
    const home = yield* temp();
    const server = yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
    yield* Effect.forkScoped(
      server.run((socket) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* socket.reader).pull;
            yield* (yield* socket.writer).write(
              `${JSON.stringify({ id: 1, result: { _tag: "Pong", version: "test", pid: 1 } })}\n`,
            );
            yield* Effect.never;
          }),
        ),
      ),
    );
    const result = yield* Effect.promise(() =>
      runCli(["daemon", "stop", "--json"], { home, env: { FORMAN_HOME: home, LOG_LEVEL: "none" } }),
    );
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Shutdown");
    expect(result.stderr).toContain("Pong");
    expect(result.stderr).toContain("may have been accepted");
    expect(result.stderr).toContain("forman doctor");
  }).pipe(Effect.provide(platform)),
);

it.live("identifies a daemon socket permission failure in commands and doctor", () =>
  Effect.gen(function* () {
    const home = yield* temp();
    const socket = `${home}/forman.sock`;
    yield* NodeSocketServer.make({ path: socket });
    const fs = yield* FileSystem.FileSystem;
    yield* fs.chmod(socket, 0);
    yield* Effect.addFinalizer(() => fs.chmod(socket, 0o700).pipe(Effect.orDie));
    const failed = yield* Effect.promise(() =>
      runCli(["status", "unit", "--json"], { home, env: { FORMAN_HOME: home, LOG_LEVEL: "none" } }),
    );
    expect(failed.status).toBe(6);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain(socket);
    expect(failed.stderr).toContain("permissions");
    const checked = yield* Effect.promise(() =>
      runCli(["doctor", "--json"], { home, env: { FORMAN_HOME: home, LOG_LEVEL: "none" } }),
    );
    expect(checked.status).toBe(0);
    expect(checked.stderr).toBe("");
    expect(checked.stdout).toContain(socket);
    expect(checked.stdout).toContain("permissions");
  }).pipe(Effect.provide(platform)),
);

it.live("explains an uncertain request after the daemon connection closes", () =>
  Effect.gen(function* () {
    const home = yield* temp();
    const server = yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
    yield* Effect.forkScoped(
      server.run((socket) =>
        Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* socket.reader;
            const writer = yield* socket.writer;
            yield* reader.pull;
            yield* writer.write(
              `${JSON.stringify({ id: 1, result: { _tag: "Pong", version: "test", pid: 1, build: "test" } })}\n`,
            );
            yield* reader.pull;
            yield* writer.write(new Socket.CloseEvent());
          }),
        ),
      ),
    );
    const result = yield* Effect.promise(() =>
      runCli(["status", "unit", "--json"], { home, env: { FORMAN_HOME: home, LOG_LEVEL: "none" } }),
    );
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unit");
    expect(result.stderr).toContain("may have been accepted");
    expect(result.stderr).toContain("forman doctor");
  }).pipe(Effect.provide(platform)),
);

it.each(["trusted", "untrusted", "none", "unknown"] as const)(
  "reports %s repo hooks through doctor text and JSON",
  async (trust) => {
    const expected = {
      trusted: { state: "known", text: "forman start will accept runs here" },
      untrusted: { state: "known", text: "forman start will refuse runs here" },
      none: { state: "not applicable", text: "no repo hooks apply" },
      unknown: { state: "unknown", text: "forman start: unknown" },
    }[trust];
    const root = await tempDir();
    const repo = `${root}/repo`;
    await mkdir(`${repo}/.codex`, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    const cwd = `${repo}/work/unit`;
    execFileSync("git", ["-C", repo, "worktree", "add", "-qb", "unit", cwd]);
    const realCwd = await realpath(cwd);
    const main = await realpath(repo);
    if (trust !== "none") await writeFile(`${repo}/.codex/hooks.json`, '{"hooks":{}}');
    const scenario = repoHooks(
      realCwd,
      `${main}/.codex/hooks.json`,
      trust === "untrusted" ? "untrusted" : "trusted",
    );
    await writeFile(
      `${root}/scenario.json`,
      Schema.encodeSync(Schema.fromJsonString(Scenario))(scenario),
    );
    const previous = process.cwd();
    try {
      process.chdir(cwd);
      for (const json of [false, true]) {
        const result = await runCli(["doctor", ...(json ? ["--json"] : [])], {
          home: root,
          env: {
            CODEX_BIN: trust === "unknown" ? `${root}/missing-codex` : fake,
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
            FAKE_APP_SERVER_SCENARIO: `${root}/scenario.json`,
          },
        });
        expect(result.status).toBe(0);
        if (json) {
          const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(DoctorResult))(
            result.stdout,
          );
          expect(decoded.repoHooks).toMatchObject({
            state: expected.state,
            mainCheckout: main,
            acceptsStart: trust === "none" || trust === "unknown" ? null : trust === "trusted",
          });
          if (trust === "trusted" || trust === "untrusted")
            expect(decoded.repoHooks.hooks).toEqual([
              { key: `${main}/.codex/hooks.json:pre_tool_use:0:0`, status: trust },
            ]);
        } else {
          expect(result.stdout).toContain(expected.text);
          if (trust === "trusted" || trust === "untrusted")
            expect(result.stdout).toContain(
              `Repo hooks:\n  pre_tool_use:0:0  ${trust}\n  ${expected.text}`,
            );
          if (trust === "unknown") {
            expect(result.stdout).toContain("Repo hooks: unknown (");
            expect(result.stdout).toContain(`${root}/missing-codex`);
            expect(result.stdout).toContain("Install Codex or set CODEX_BIN");
          }
          if (trust === "untrusted") {
            expect(result.stdout).toContain(
              `${main}/.codex/hooks.json:pre_tool_use:0:0: untrusted`,
            );
            expect(result.stdout).toContain("run /hooks and approve these hooks");
          }
        }
      }
    } finally {
      process.chdir(previous);
    }
  },
);

it.effect("bounds a stalled hooks/list probe and reports unknown", () =>
  Effect.gen(function* () {
    const home = yield* temp();
    const fs = yield* FileSystem.FileSystem;
    yield* commandResult(ChildProcess.make("git", ["init", "-q", home]));
    yield* fs.makeDirectory(`${home}/.codex`);
    yield* fs.writeFileString(`${home}/.codex/hooks.json`, '{"hooks":{}}');
    yield* fs.writeFileString(
      `${home}/scenario.json`,
      Schema.encodeSync(Schema.fromJsonString(Scenario))({
        rules: [{ method: "hooks/list", respond: "none" }],
      }),
    );
    const log = `${home}/requests.jsonl`;
    yield* fs.writeFileString(log, "");
    const pending = yield* Effect.forkScoped(
      doctor(home).pipe(
        Effect.provide(
          AppConfig.layer({
            HOME: home,
            CODEX_BIN: fake,
            FORMAN_HOME: home,
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
            FAKE_APP_SERVER_SCENARIO: `${home}/scenario.json`,
            FAKE_APP_SERVER_LOG: log,
          }),
        ),
      ),
    );
    while (!(yield* fs.readFileString(log)).includes('"hooks/list"')) yield* Effect.yieldNow;
    yield* TestClock.adjust("6 seconds");
    const result = yield* TestClock.withLive(Fiber.join(pending).pipe(Effect.timeout("2 seconds")));
    expect(result.repoHooks).toMatchObject({ state: "unknown", acceptsStart: null });
  }).pipe(Effect.provide(platform)),
);

it.each([false, true])("reports failed git discovery as unknown, json=%s", async (json) => {
  const home = await tempDir();
  execFileSync("git", ["init", "-q", home]);
  await mkdir(`${home}/.codex`);
  await writeFile(`${home}/.codex/hooks.json`, '{"hooks":{}}');
  await writeFile(`${home}/.git/config`, "[invalid");
  const previous = process.cwd();
  try {
    process.chdir(home);
    const result = await runCli(["doctor", ...(json ? ["--json"] : [])], { home });
    expect(result.status).toBe(0);
    if (json) {
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(DoctorResult))(result.stdout);
      expect(decoded.repoHooks).toMatchObject({
        state: "unknown",
        acceptsStart: null,
        detail: expect.stringContaining("git worktree list"),
      });
      expect(decoded.repoHooks.detail).toContain("exited");
      expect(decoded.repoHooks.detail).toContain("check Git and repository permissions");
    } else {
      expect(result.stdout).toContain("forman start: unknown");
      expect(result.stdout).toContain("git worktree list");
      expect(result.stdout).toContain("exited");
      expect(result.stdout).toContain("check Git and repository permissions");
      expect(result.stdout).not.toContain("no repo hooks apply");
    }
  } finally {
    process.chdir(previous);
  }
});

it.each([false, true])("reports no repo hooks outside git, json=%s", async (json) => {
  const home = await tempDir();
  const previous = process.cwd();
  try {
    process.chdir(home);
    const result = await runCli(["doctor", ...(json ? ["--json"] : [])], { home });
    expect(result.status).toBe(0);
    if (json) {
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(DoctorResult))(result.stdout);
      expect(decoded.repoHooks).toMatchObject({ state: "not applicable", mainCheckout: null });
    } else expect(result.stdout).toContain("no repo hooks apply");
  } finally {
    process.chdir(previous);
  }
});
