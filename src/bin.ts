import { fileURLToPath } from "node:url";
import { BunServices, BunSocket, BunSocketServer } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import rawMetadata from "../package.json";
import { buildIdentity } from "./daemon/build";
import { DaemonSockets } from "./daemon/sockets";
import { jsonRequested, main } from "./main";
import { AppLayer, runInvocation } from "./runtime";
import { PackageInfo } from "./schemas/package";
import { Host } from "./services/host";
import type { Writer } from "./services/output";

const writer =
  (stream: NodeJS.WriteStream): Writer =>
  (text) =>
    new Promise((resolve, reject) => {
      stream.write(text, (error) => (error ? reject(error) : resolve()));
    });
// The write callback owns errors; prevent a second uncaught stream error.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const args = process.argv.slice(2);
const metadata = Schema.decodeUnknownSync(PackageInfo)(rawMetadata);
declare const COMPILED: boolean;
declare const BUILD: string;
const compiled = typeof COMPILED !== "undefined" && COMPILED;
const build = compiled
  ? BUILD
  : `dev-${await buildIdentity(fileURLToPath(new URL("..", import.meta.url)), Bun.version)}`;
const platform = Layer.mergeAll(
  BunServices.layer,
  DaemonSockets.layer({
    connect: (path) => BunSocket.makeNet({ path }),
    listen: (path) => BunSocketServer.make({ path }),
  }),
  Host.layer({
    name: "foreman",
    version: metadata.version ?? "dev",
    build,
    platform: process.platform,
    compiled,
    executable: compiled ? [process.execPath] : [process.execPath, import.meta.filename],
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
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  process.exitCode = await runInvocation(
    main(args).pipe(Effect.provide(app), Effect.provide(platform), Effect.scoped),
    controller.signal,
  );
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
