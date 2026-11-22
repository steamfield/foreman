import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { AppConfig } from "../../src/config";
import { commandResult } from "../../src/core/process";
import { call } from "../../src/daemon/client";
import { daemon } from "../../src/daemon/server";
import * as D from "../../src/schemas/daemon";
import { Host } from "../../src/services/host";
import { makeSupervisor } from "../../src/supervisor";
import { AcpScenario } from "../fixtures/fake-acp-agent/scenario";
import { ndjson } from "./cli";

export { eventsPlatform as agyPlatform } from "./events";

const name = Schema.decodeUnknownSync(D.RunName)("unit");

export interface AgyFixtureOptions {
  /** The ACP protocol version the fake agent answers initialize with (default 1). */
  readonly protocol?: number;
  /** Commit `.codex/hooks.json` (and no agy hooks) to the repo before adding the worktree. */
  readonly codexHooks?: boolean;
}

/**
 * A real supervisor and daemon whose agy is the fake ACP agent playing `scenario`, with a
 * git repo and worktree for run `unit`. Nothing starts until the test sends `start`.
 */
export const agyFixture = Effect.fnUntraced(function* (
  scenario: AcpScenario,
  options: AgyFixtureOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-agy-" });
  const repo = `${root}/repo`;
  const worktree = `${repo}/work/unit`;
  const dataDir = `${root}/d`;
  yield* fs.makeDirectory(repo);
  const git = Effect.fnUntraced(function* (...args: string[]) {
    const result = yield* commandResult(ChildProcess.make("git", args, { cwd: repo }));
    if (result.code !== 0) return yield* Effect.die(`git failed: ${result.stderr}`);
  });
  const commit = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit"];
  yield* git("init", "-q");
  if (options.codexHooks) {
    yield* fs.makeDirectory(`${repo}/.codex`);
    yield* fs.writeFileString(`${repo}/.codex/hooks.json`, '{"hooks":{}}\n');
    yield* git("add", ".codex/hooks.json");
    yield* git(...commit, "-qm", "codex hooks");
  } else yield* git(...commit, "--allow-empty", "-qm", "initial");
  yield* git("worktree", "add", "-qb", "unit", worktree);
  const scenarioFile = `${root}/scenario.json`;
  yield* fs.writeFileString(
    scenarioFile,
    Schema.encodeSync(Schema.fromJsonString(AcpScenario))(scenario),
  );
  const env: Record<string, string> = {
    HOME: root,
    FOREMAN_HOME: dataDir,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    CODEX_BIN: fileURLToPath(new URL("../fixtures/fake-app-server/main.mjs", import.meta.url)),
    CODEX_HOME: `${root}/codex`,
    AGY_BIN: fileURLToPath(new URL("../fixtures/fake-acp-agent/main.mjs", import.meta.url)),
    FAKE_ACP_SCENARIO: scenarioFile,
    FAKE_ACP_LOG: `${root}/acp.jsonl`,
    FAKE_ACP_ARGS: `${root}/args.jsonl`,
    // Must not reach agy: it signs in with its own login.
    GEMINI_API_KEY: "placeholder",
    LOG_LEVEL: "none",
    ...(options.protocol === undefined ? {} : { FAKE_ACP_PROTOCOL: String(options.protocol) }),
  };
  const host = yield* Host;
  const daemonHost = Host.layer({ ...host, build: "test" });
  const supervisor = yield* makeSupervisor().pipe(
    Effect.provide(AppConfig.layer(env)),
    Effect.provide(daemonHost),
  );
  yield* Effect.raceFirst(
    supervisor.failed,
    daemon({ dataDir, version: "dev", ...supervisor }).pipe(Effect.provide(daemonHost)),
  ).pipe(Effect.forkScoped);
  const request = (body: D.DaemonRequestBody) =>
    call(body, { dataDir, connectOnly: true }).pipe(Effect.provide(daemonHost));
  while ((yield* request({ _tag: "Ping" }).pipe(Effect.result))._tag !== "Success")
    yield* Effect.yieldNow;
  const start = (write: boolean) =>
    request({
      _tag: "Start",
      name,
      worktree,
      contract: "Create result.txt.",
      write,
      provider: "agy",
      model: "gemini-4-neon",
      effort: "low",
      skipDepsCheck: false,
    });
  /** Waits until run `unit` reaches `state` (and `turn`, when given), returning its digest. */
  const until = Effect.fnUntraced(function* (state: D.RunState, turn?: number) {
    while (true) {
      const result = yield* request({ _tag: "Status", name, cwd: repo });
      const digest = result._tag === "Digests" ? result.digests[0] : undefined;
      if (digest?.state === state && (turn === undefined || digest.turn === turn)) return digest;
      yield* Effect.yieldNow;
    }
  });
  const events = request({ _tag: "Events", name, limit: 1000 }).pipe(
    Effect.map((page) => (page._tag === "Events" ? page.events.map(({ event }) => event) : [])),
  );
  const readLines = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map(ndjson),
    );
  return {
    name,
    root,
    repo,
    worktree,
    home: dataDir,
    request,
    start,
    until,
    events,
    /** Every message foreman sent the fake agent, in order. */
    received: readLines(`${root}/acp.jsonl`),
    /** One entry per agy launch: argv, cwd and environment. */
    launches: readLines(`${root}/args.jsonl`),
    runJson: fs
      .readFileString(`${dataDir}/runs/unit/run.json`)
      .pipe(Effect.map((text): unknown => JSON.parse(text))),
  };
});
