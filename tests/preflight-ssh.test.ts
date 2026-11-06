import { createServer } from "node:net";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { probeSsh } from "../src/core/preflight/ssh";

const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "pf-" });
  const script = (name: string, body: string) =>
    fs.writeFileString(path.join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  const env = { PATH: root, SSH_AUTH_SOCK: "/inherited-agent" };
  yield* script("id", '[ "$1" = "-u" ] || exit 3\nprintf "501\\n"');
  return { fs, path, root, script, env };
});

it.effect("treats ssh-add exits 0 and 1 as alive using the inherited environment", () =>
  Effect.gen(function* () {
    const { script, env } = yield* setup();
    for (const code of [0, 1]) {
      yield* script(
        "ssh-add",
        `[ "$1" = "-l" ] && [ "$SSH_AUTH_SOCK" = "/inherited-agent" ] || exit 2\nexit ${code}`,
      );
      expect(yield* probeSsh(env)).toEqual({ alive: true, launchdSocket: undefined });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("finds an actual launchd socket when the inherited agent is dead", () =>
  Effect.gen(function* () {
    const { path, root, script, env } = yield* setup();
    const socket = path.join(root, "agent socket");
    const server = createServer();
    yield* Effect.acquireRelease(
      Effect.tryPromise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socket, resolve);
          }),
      ),
      () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    yield* script("ssh-add", "exit 2");
    yield* script(
      "launchctl",
      '[ "$1" = "print" ] && [ "$2" = "gui/501/com.openssh.ssh-agent" ] || exit 1\nprintf "    SSH_AUTH_SOCK => %s\\n" "$SOCKET"',
    );
    expect(yield* probeSsh({ ...env, SOCKET: socket })).toEqual({
      alive: false,
      launchdSocket: socket,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns no launchd socket without launchctl or when its output is not a socket", () =>
  Effect.gen(function* () {
    const { fs, path, root, script, env } = yield* setup();
    yield* script("ssh-add", "exit 2");
    expect(yield* probeSsh(env)).toEqual({ alive: false, launchdSocket: undefined });
    const file = path.join(root, "regular-file");
    yield* fs.writeFileString(file, "not a socket");
    yield* script("launchctl", 'printf "SSH_AUTH_SOCK => %s\\n" "$SOCKET"');
    expect(yield* probeSsh({ ...env, SOCKET: file })).toEqual({
      alive: false,
      launchdSocket: undefined,
    });
    expect(yield* probeSsh({ ...env, SOCKET: path.join(root, "absent") })).toEqual({
      alive: false,
      launchdSocket: undefined,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("never fails when commands are missing, fail or print unusable results", () =>
  Effect.gen(function* () {
    const { script, env } = yield* setup();
    expect(yield* probeSsh(env)).toEqual({ alive: false, launchdSocket: undefined });
    yield* script("ssh-add", "exit 127");
    yield* script("launchctl", "exit 1");
    expect(yield* probeSsh(env)).toEqual({ alive: false, launchdSocket: undefined });
    yield* script("id", 'printf "not-a-uid\\n"');
    expect(yield* probeSsh(env)).toEqual({ alive: false, launchdSocket: undefined });
  }).pipe(Effect.provide(NodeServices.layer)),
);
