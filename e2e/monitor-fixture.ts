// PTY QA entry: the production parser and renderer, with the contract's fixture feed.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { BunServices, BunSocket, BunSocketServer } from "@effect/platform-bun";
import { DateTime, Effect, Layer, Stream } from "effect";
import { Command } from "effect/cli";
import { cli } from "../src/cli";
import { makeMonitorCommand } from "../src/commands/monitor";
import { DaemonSockets } from "../src/daemon/sockets";
import { jsonRequested, main } from "../src/main";
import { AppLayer, runInvocation } from "../src/runtime";
import { Host } from "../src/services/host";
import { Terminal } from "../src/services/terminal";
import { mixedRuns, now, overview } from "../tests/helpers/monitor";

const args = process.argv.slice(2);
const group = dirname(
  execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim(),
);
const receivedAt = Date.now();
const shift = (at: DateTime.Utc) =>
  DateTime.makeUnsafe(DateTime.toEpochMillis(at) + receivedAt - now);
const shiftOptional = (at: DateTime.Utc | null) => (at === null ? null : shift(at));
const snapshot = overview(
  mixedRuns().map((run) => ({
    ...run,
    ...(run.group === "/repo" ? { group, repo: group } : {}),
    stateSince: shift(run.stateSince),
    turnStartedAt: shiftOptional(run.turnStartedAt),
    lastActivityAt: shiftOptional(run.lastActivityAt),
    activity: run.activity === null ? null : { ...run.activity, since: shift(run.activity.since) },
    retrying: run.retrying === null ? null : { ...run.retrying, at: shift(run.retrying.at) },
    questions: run.questions.map((question) => ({
      ...question,
      askedAt: shift(question.askedAt),
      defersAt: shiftOptional(question.defersAt),
    })),
    subagents: run.subagents.map((agent) => ({
      ...agent,
      startedAt: shift(agent.startedAt),
      lastInteractionAt: shift(agent.lastInteractionAt),
    })),
  })),
);
const feed = {
  _tag: "Live" as const,
  overview: {
    ...snapshot,
    daemon: { ...snapshot.daemon, startedAt: shift(snapshot.daemon.startedAt) },
  },
  receivedAt,
};
const program = Command.runWith(
  cli(
    "foreman",
    makeMonitorCommand(() => Stream.make(feed)),
  ),
  { version: "0.1.3", renderErrors: false },
)(args);
const platform = Layer.mergeAll(
  BunServices.layer,
  DaemonSockets.layer({
    connect: (path) => BunSocket.makeNet({ path }),
    listen: (path) => BunSocketServer.make({ path }),
  }),
  Host.layer({
    name: "foreman",
    version: "0.1.3",
    build: "fixture",
    platform: process.platform,
    compiled: true,
    executable: [process.execPath],
    pid: process.pid,
  }),
  Terminal.layer({
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    resize: Stream.empty,
  }),
);
process.exitCode = await runInvocation(
  main(args, program).pipe(
    Effect.provide(
      AppLayer(
        { HOME: process.env.HOME },
        jsonRequested(args),
        async (text) => {
          process.stdout.write(text);
        },
        async (text) => {
          process.stderr.write(text);
        },
      ),
    ),
    Effect.provide(platform),
    Effect.scoped,
  ),
);
