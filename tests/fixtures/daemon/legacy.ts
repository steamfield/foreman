// The pre-build-identity protocol, exercised as a real process and Unix socket.
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { Schema } from "effect";
import { requestJson } from "../../../src/daemon/protocol";

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("data directory required");
const parent = process.ppid;
await mkdir(dataDir, { recursive: true });
await writeFile(`${dataDir}/daemon.lock`, "", { flag: "wx" });
const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const request = Schema.decodeUnknownSync(requestJson)(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const result =
        request.body._tag === "Ping"
          ? { _tag: "Pong", version: "legacy", pid: process.pid }
          : { _tag: "Ok" };
      socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.body._tag === "Shutdown") {
        socket.end();
        server.close(() => {
          unlink(`${dataDir}/daemon.lock`).catch((error: unknown) => {
            process.stderr.write(String(error));
            process.exitCode = 1;
          });
        });
      }
    }
  });
});
server.listen(`${dataDir}/foreman.sock`, () => {
  writeFile(`${dataDir}/ready`, "").catch((error: unknown) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
    server.close();
  });
});
// Exit once the process that started this fixture dies or its test removes the data directory,
// so a crashed test run cannot leave it listening.
setInterval(() => {
  if (process.ppid !== parent || !existsSync(dataDir)) {
    process.stderr.write(`Legacy fixture for ${dataDir} lost its parent or data directory\n`);
    process.exit(1);
  }
}, 200).unref();
