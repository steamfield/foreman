import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, FileSystem, Schema, Scope } from "effect";
import { ChildProcess } from "effect/process";
import { AppConfig } from "../../src/config";
import { commandResult } from "../../src/core/process";
import { call } from "../../src/daemon/client";
import { daemon } from "../../src/daemon/server";
import * as D from "../../src/schemas/daemon";
import { Host } from "../../src/services/host";
import { makeSupervisor } from "../../src/supervisor";
import { AcpScenario } from "../fixtures/fake-acp-agent/scenario";
import type { Gate } from "../fixtures/fake-acp-agent/scenarios";
import { ndjson } from "./cli";

export { eventsPlatform as agyPlatform } from "./events";

const name = Schema.decodeUnknownSync(D.RunName)("unit");
const cliEntry = fileURLToPath(new URL("../fixtures/foreman-cli/entry.ts", import.meta.url));

/** Settings a test start passes besides the fixture's model and worktree. */
export interface AgyStartOptions {
  readonly questionTimeoutMs?: number;
  readonly budgetMs?: number;
}

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
  const writeScenario = (next: AcpScenario) =>
    fs.writeFileString(scenarioFile, Schema.encodeSync(Schema.fromJsonString(AcpScenario))(next));
  yield* writeScenario(scenario);
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
    FAKE_ACP_MCP_LOG: `${root}/mcp.jsonl`,
    // Must not reach agy: it signs in with its own login.
    GEMINI_API_KEY: "placeholder",
    LOG_LEVEL: "none",
    ...(options.protocol === undefined ? {} : { FAKE_ACP_PROTOCOL: String(options.protocol) }),
  };
  const host = yield* Host;
  // foreman's executable is the daemon's Host.executable; here it is the test CLI entry run by
  // Bun, so the `mcp-question` bridge agy launches from mcpServers is a real foreman process of
  // the daemon's build.
  const bun = yield* commandResult(ChildProcess.make("which", ["bun"]));
  if (bun.code !== 0) return yield* Effect.die("bun is not on PATH; the agy bridge runs with it");
  const daemonHost = Host.layer({
    ...host,
    build: "test",
    executable: [bun.stdout.trim(), cliEntry],
  });
  const request = (body: D.DaemonRequestBody) =>
    call(body, { dataDir, connectOnly: true }).pipe(Effect.provide(daemonHost));
  /** Starts a supervisor and daemon over `dataDir` in a scope of their own, ready for requests. */
  const launch = Effect.fnUntraced(function* () {
    const scope = yield* Scope.make();
    const supervisor = yield* makeSupervisor().pipe(
      Effect.provide(AppConfig.layer(env)),
      Effect.provide(daemonHost),
      Scope.provide(scope),
    );
    yield* Effect.raceFirst(
      supervisor.failed,
      daemon({ dataDir, version: "dev", ...supervisor }).pipe(Effect.provide(daemonHost)),
    ).pipe(Effect.forkIn(scope));
    while ((yield* request({ _tag: "Ping" }).pipe(Effect.result))._tag !== "Success")
      yield* Effect.yieldNow;
    return scope;
  });
  let daemonScope = yield* launch();
  yield* Effect.addFinalizer(() => Scope.close(daemonScope, Exit.void));
  /**
   * Stops the daemon, which ends its agy child, and starts a new one over the same foreman
   * home. With `next`, agy launched from now on plays that scenario instead.
   */
  const restart = Effect.fnUntraced(function* (next?: AcpScenario) {
    yield* Scope.close(daemonScope, Exit.void);
    if (next !== undefined) yield* writeScenario(next);
    daemonScope = yield* launch();
  });
  const start = (write: boolean, options: AgyStartOptions = {}) =>
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
      ...options,
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
  /** A gate for the fake under the fixture's directory; open it with `openGate`. */
  const gate = Effect.fnUntraced(function* (label: string) {
    const made: Gate = { ready: `${root}/${label}-ready`, release: `${root}/${label}-release` };
    const fifo = yield* commandResult(ChildProcess.make("mkfifo", [made.release]));
    if (fifo.code !== 0) return yield* Effect.die(`mkfifo failed: ${fifo.stderr}`);
    return made;
  });
  /** Opens a gate: the write completes once the fake blocked on it has read it. */
  const openGate = (opened: Gate) => fs.writeFileString(opened.release, "go");
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
    restart,
    /**
     * Replaces the scenario agy plays from its next launch: before `start`, for scenarios that
     * need the fixture's paths (gates, markers).
     */
    useScenario: writeScenario,
    gate,
    openGate,
    /** Every message foreman sent the fake agent, in order. */
    received: readLines(`${root}/acp.jsonl`),
    /** One entry per agy launch: argv, cwd and environment. */
    launches: readLines(`${root}/args.jsonl`),
    /** One entry per ended MCP call the fake made: `{label, response}` or `{label, exited}`. */
    mcpResults: readLines(`${root}/mcp.jsonl`),
    runJson: fs
      .readFileString(`${dataDir}/runs/unit/run.json`)
      .pipe(Effect.map((text): unknown => JSON.parse(text))),
  };
});
