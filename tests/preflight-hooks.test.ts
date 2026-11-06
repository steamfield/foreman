import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { assert, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { openConnection } from "../src/codex/client";
import { checkHookTrust } from "../src/core/preflight/hooks";
import { commandResult } from "../src/core/process";
import { RepoHooksUntrusted } from "../src/errors";
import { Scenario } from "./fixtures/fake-app-server/scenario";
import {
  missingProjectHooks,
  modifiedHooks,
  repoHooks,
  untrustedHooks,
} from "./fixtures/fake-app-server/scenarios";

const fake = fileURLToPath(new URL("./fixtures/fake-app-server/main.mjs", import.meta.url));
const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const main = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const git = yield* commandResult(ChildProcess.make("git", ["init", "-q", main]));
  expect(git.code).toBe(0);
  yield* fs.makeDirectory(`${main}/.codex`);
  const file = `${main}/.codex/hooks.json`;
  yield* fs.writeFileString(
    file,
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] } }),
  );
  const connect = Effect.fnUntraced(function* (scenario: Scenario) {
    const log = `${main}/requests.jsonl`;
    yield* fs.writeFileString(log, "");
    yield* fs.writeFileString(
      `${main}/scenario.json`,
      Schema.encodeSync(Schema.fromJsonString(Scenario))(scenario),
    );
    const connection = yield* openConnection({
      codexBin: fake,
      version: "test",
      stderr: () => Effect.void,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        FAKE_APP_SERVER_SCENARIO: `${main}/scenario.json`,
        FAKE_APP_SERVER_LOG: log,
      },
    });
    return { connection, log };
  });
  return { fs, main, file, connect };
});

it.live("skips hooks/list when no repo hooks file exists", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    yield* f.fs.remove(f.file);
    const { connection, log } = yield* f.connect({ rules: [] });
    yield* checkHookTrust(connection, f.main, f.main);
    expect(yield* f.fs.readFileString(log)).not.toContain('"hooks/list"');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["trusted", "managed"])(
  "accepts %s project hooks and ignores user-hook trust",
  (status) =>
    Effect.gen(function* () {
      const f = yield* setup();
      const { connection } = yield* f.connect(repoHooks(f.main, f.file, status));
      expect(yield* checkHookTrust(connection, f.main, f.main)).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([untrustedHooks, modifiedHooks])(
  "refuses a failing project hook with its key, status and exact fix",
  (build) =>
    Effect.gen(function* () {
      const f = yield* setup();
      const script = build(f.main, f.file);
      const { connection } = yield* f.connect(script);
      const error = yield* Effect.flip(checkHookTrust(connection, f.main, f.main));
      assert.instanceOf(error, RepoHooksUntrusted);
      expect(error._tag).toBe("RepoHooksUntrusted");
      expect(error.detail).toContain(
        `${f.file}:pre_tool_use:0:0: ${build === untrustedHooks ? "untrusted" : "modified"}`,
      );
      expect(
        error.detail?.endsWith(
          `Open Codex in ${f.main}, run /hooks and approve these hooks (and trust the project if Codex asks). Then run forman doctor to check.`,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refuses missing project hooks, as returned for an untrusted project", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const { connection } = yield* f.connect(missingProjectHooks(f.main));
    const error = yield* Effect.flip(checkHookTrust(connection, f.main, f.main));
    assert.instanceOf(error, RepoHooksUntrusted);
    expect(error.detail).toContain(`Codex loaded no project hooks from ${f.file}.`);
    expect(error.detail).toContain(`Open Codex in ${f.main}, run /hooks`);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refuses hooks/list errors even with trusted project hooks", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const { connection } = yield* f.connect({
      rules: [
        {
          method: "hooks/list",
          respond: {
            result: {
              data: [
                {
                  cwd: f.main,
                  hooks: [
                    {
                      key: `${f.file}:pre_tool_use:0:0`,
                      source: "project",
                      currentHash: "sha256:fixture",
                      trustStatus: "trusted",
                    },
                  ],
                  warnings: [],
                  errors: [{ path: f.file, message: "bad file" }],
                },
              ],
            },
          },
        },
      ],
    });
    const error = yield* Effect.flip(checkHookTrust(connection, f.main, f.main));
    assert.instanceOf(error, RepoHooksUntrusted);
    expect(error.detail).toContain(`${f.file}: hooks/list error`);
    expect(error.detail).toContain(`Open Codex in ${f.main}, run /hooks`);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("fails closed on a dangling hooks symlink and on an unavailable hooks/list", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    yield* f.fs.remove(f.file);
    yield* f.fs.symlink(`${f.main}/missing`, f.file);
    const { connection } = yield* f.connect({ rules: [] });
    expect(yield* Effect.flip(checkHookTrust(connection, f.main, f.main))).toMatchObject({
      _tag: "CodexRpcError",
      code: -32601,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "checks every project hook and requests the worktree, accepting keys from the main checkout",
  () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const cwd = `${f.main}/work/unit`;
      const { connection } = yield* f.connect({
        rules: [
          {
            method: "hooks/list",
            when: { cwds: [cwd] },
            respond: {
              result: {
                data: [
                  {
                    cwd,
                    hooks: [
                      {
                        key: `${f.file}:pre_tool_use:0:0`,
                        source: "project",
                        currentHash: "sha256:fixture",
                        trustStatus: "untrusted",
                      },
                      {
                        key: `${f.file}:pre_tool_use:1:0`,
                        source: "project",
                        currentHash: "sha256:fixture",
                        trustStatus: "modified",
                      },
                    ],
                    warnings: [],
                    errors: [],
                  },
                ],
              },
            },
          },
        ],
      });
      const error = yield* Effect.flip(checkHookTrust(connection, f.main, cwd));
      assert.instanceOf(error, RepoHooksUntrusted);
      expect(error.detail).toContain(`${f.file}:pre_tool_use:0:0: untrusted`);
      expect(error.detail).toContain(`${f.file}:pre_tool_use:1:0: modified`);
    }).pipe(Effect.provide(NodeServices.layer)),
);
