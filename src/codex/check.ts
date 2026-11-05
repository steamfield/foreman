import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CodexUnavailable } from "../errors";
import { supportedCodex } from "./protocol";

/** Hash every generated file, including its relative path and both NUL separators. */
export const hashSchemas = Effect.fn("codex.hashSchemas")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: string[] = [];
  for (const entry of yield* fs.readDirectory(directory, { recursive: true })) {
    if ((yield* fs.stat(path.join(directory, entry))).type === "File")
      files.push(entry.split(path.sep).join("/"));
  }
  files.sort();
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const file of files)
    parts.push(
      encoder.encode(`${file}\0`),
      yield* fs.readFile(path.join(directory, file)),
      new Uint8Array([0]),
    );
  const input = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    input.set(part, offset);
    offset += part.length;
  }
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", input),
    catch: () => new CodexUnavailable({ detail: "could not hash Codex protocol" }),
  });
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { matches: hash === supportedCodex.schemaHash, hash, files };
});

export const checkProtocol = Effect.fn("codex.checkProtocol")(
  function* (codexBin: string, env: Readonly<Record<string, string>>) {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped();
    const code = yield* spawner.exitCode(
      ChildProcess.make(
        codexBin,
        ["app-server", "generate-json-schema", "--experimental", "--out", directory],
        { env, extendEnv: false, stdout: "ignore", stderr: "ignore", forceKillAfter: "2 seconds" },
      ),
    );
    if (code !== 0)
      return yield* new CodexUnavailable({
        detail: `Codex schema generation exited with code ${code}`,
      });
    return yield* hashSchemas(directory);
  },
  Effect.mapError((error) =>
    error instanceof CodexUnavailable
      ? error
      : new CodexUnavailable({ detail: "could not generate Codex protocol" }),
  ),
);

export const codexVersion = Effect.fn("codex.version")(
  function* (codexBin: string, env: Readonly<Record<string, string>>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(codexBin, ["--version"], {
        env,
        extendEnv: false,
        stderr: "ignore",
        forceKillAfter: "2 seconds",
      }),
    );
    const output = (yield* handle.stdout.pipe(Stream.decodeText(), Stream.runCollect)).join("");
    const code = yield* handle.exitCode;
    if (code !== 0)
      return yield* new CodexUnavailable({ detail: `Codex version exited with code ${code}` });
    const version = output.trim().replace(/^codex(?:-cli)?\s+/, "");
    return yield* Schema.decodeUnknownEffect(
      Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/)),
    )(version).pipe(
      Effect.mapError(() => new CodexUnavailable({ detail: "could not parse Codex version" })),
    );
  },
  Effect.mapError((error) =>
    error instanceof CodexUnavailable
      ? error
      : new CodexUnavailable({ detail: "could not run Codex version" }),
  ),
);
