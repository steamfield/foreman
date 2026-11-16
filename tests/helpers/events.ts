import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { AppConfig } from "../../src/config";
import { commandResult } from "../../src/core/process";
import { call } from "../../src/daemon/client";
import { daemon } from "../../src/daemon/server";
import { DaemonSockets } from "../../src/daemon/sockets";
import * as D from "../../src/schemas/daemon";
import { Host } from "../../src/services/host";
import { makeSupervisor } from "../../src/supervisor";
import { Scenario } from "../fixtures/fake-app-server/scenario";

const name = Schema.decodeUnknownSync(D.RunName)("unit");
export const eventsPlatform = Layer.mergeAll(
  NodeServices.layer,
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
  Host.layer({
    name: "test-cli",
    version: "dev",
    build: "test",
    platform: "test",
    compiled: false,
    executable: [process.execPath],
    pid: process.pid,
  }),
);

export const eventsFixture = Effect.fnUntraced(function* (
  script: Scenario,
  legacy = false,
  build = "test",
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-events-" });
  const repo = `${root}/repo`;
  const worktree = `${repo}/work/unit`;
  const dataDir = `${root}/d`;
  yield* fs.makeDirectory(repo);
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ],
    ["worktree", "add", "-qb", "unit", worktree],
  ]) {
    const result = yield* commandResult(ChildProcess.make("git", args, { cwd: repo }));
    if (result.code !== 0) return yield* Effect.die(`git failed: ${result.stderr}`);
  }
  const scenarioFile = `${root}/scenario.json`;
  yield* fs.writeFileString(
    scenarioFile,
    Schema.encodeSync(Schema.fromJsonString(Scenario))(script),
  );
  const env = {
    HOME: root,
    FOREMAN_HOME: dataDir,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    CODEX_BIN: fileURLToPath(new URL("../fixtures/fake-app-server/main.mjs", import.meta.url)),
    CODEX_HOME: `${root}/codex`,
    FAKE_APP_SERVER_SCENARIO: scenarioFile,
    FAKE_APP_SERVER_LOG: `${root}/received.jsonl`,
    LOG_LEVEL: "none",
  };
  const host = yield* Host;
  const daemonHost = Host.layer({ ...host, build });
  const supervisor = yield* makeSupervisor().pipe(
    Effect.provide(AppConfig.layer(env)),
    Effect.provide(daemonHost),
  );
  const handler = (body: D.DaemonRequestBody) => {
    if (!legacy || body._tag !== "Events") return supervisor.handler(body);
    return supervisor
      .handler({
        _tag: "Events",
        name: body.name,
        ...(body.after === undefined ? {} : { after: body.after }),
        ...(body.limit === undefined ? {} : { limit: body.limit }),
      })
      .pipe(
        Effect.map((page) =>
          page._tag === "Events"
            ? { _tag: "Events" as const, events: page.events, gap: page.gap, next: page.next }
            : page,
        ),
      );
  };
  yield* Effect.raceFirst(
    supervisor.failed,
    daemon({ dataDir, version: "dev", ...supervisor, handler }).pipe(Effect.provide(daemonHost)),
  ).pipe(Effect.forkScoped);
  const request = (body: D.DaemonRequestBody) =>
    call(body, { dataDir, connectOnly: true }).pipe(Effect.provide(daemonHost));
  while ((yield* request({ _tag: "Ping" }).pipe(Effect.result))._tag !== "Success")
    yield* Effect.yieldNow;
  yield* request({
    _tag: "Start",
    name,
    worktree,
    contract: "Read the repo.",
    write: false,
    skipDepsCheck: false,
  });
  const untilState = Effect.fnUntraced(function* (state: D.RunState) {
    while (true) {
      const result = yield* request({ _tag: "Status", name, cwd: repo });
      if (result._tag === "Digests" && result.digests[0]?.state === state) return;
      yield* Effect.yieldNow;
    }
  });
  return { env, root, request, untilState, name };
});
