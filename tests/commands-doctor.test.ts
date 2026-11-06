import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { TestClock } from "effect/testing";
import { AppConfig } from "../src/config";
import { doctor } from "../src/core/doctor";
import { commandResult } from "../src/core/preflight/command";
import { DaemonSockets } from "../src/daemon/sockets";
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
  AppConfig.layer({ HOME: home, FORMAN_DATA_DIR: home, CODEX_BIN: codexBin }).pipe(
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

describe("bounded doctor diagnostics", () => {
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
            FORMAN_DATA_DIR: home,
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
      expect(result.daemon).toEqual({ state: "not running" });
    }).pipe(Effect.provide(platform)),
  );
});

const fake = fileURLToPath(new URL("./fixtures/fake-app-server/main.mjs", import.meta.url));

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
          if (trust === "unknown")
            expect(result.stdout).toContain(
              "Repo hooks: unknown (Could not query Codex hook trust.)\n  forman start: unknown",
            );
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
            FORMAN_DATA_DIR: home,
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
      expect(decoded.repoHooks).toMatchObject({ state: "unknown", acceptsStart: null });
    } else {
      expect(result.stdout).toContain("forman start: unknown");
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
