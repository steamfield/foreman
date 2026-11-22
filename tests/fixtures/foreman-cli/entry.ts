// The foreman CLI as a separate process for tests, run with Bun: `bun entry.ts <args>`. It is
// src/bin.ts with Node services and build "test", so it talks to a test daemon (build "test")
// as the same build. tests/helpers/agy.ts gives the daemon this command line as Host.executable,
// so the question bridge agy launches (`foreman mcp-question`) is this process.
import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";
import { DaemonSockets } from "../../../src/daemon/sockets";
import { jsonRequested, main } from "../../../src/main";
import { AppLayer, runInvocation } from "../../../src/runtime";
import { Host } from "../../../src/services/host";
import type { Writer } from "../../../src/services/output";
import { Terminal } from "../../../src/services/terminal";

const writer =
  (stream: NodeJS.WriteStream): Writer =>
  (text) =>
    new Promise((resolve, reject) => {
      stream.write(text, (error) => (error ? reject(error) : resolve()));
    });
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const args = process.argv.slice(2);
const platform = Layer.mergeAll(
  NodeServices.layer,
  Terminal.layer({
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    columns: 80,
    rows: 24,
    resize: Stream.empty,
  }),
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
  Host.layer({
    name: "foreman",
    version: "dev",
    build: "test",
    platform: process.platform,
    compiled: false,
    executable: [process.execPath, import.meta.filename],
    pid: process.pid,
  }),
);
const app = AppLayer(
  process.env,
  jsonRequested(args),
  writer(process.stdout),
  writer(process.stderr),
);
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
process.exitCode = await runInvocation(
  main(args).pipe(Effect.provide(app), Effect.provide(platform), Effect.scoped),
  controller.signal,
);
