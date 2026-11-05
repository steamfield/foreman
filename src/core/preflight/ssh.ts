import { Effect, FileSystem } from "effect";
import { ChildProcess } from "effect/process";
import { commandResult } from "./command";

export type SshProbe = { alive: boolean; launchdSocket: string | undefined };

export const probeSsh = Effect.fn("preflight.probeSsh")(function* (
  inherited: Readonly<Record<string, string | undefined>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const run = (command: string, args: string[]) =>
    commandResult(ChildProcess.make(command, args, { env: { ...inherited }, stderr: "ignore" }));
  const alive = yield* run("ssh-add", ["-l"]).pipe(
    Effect.map(({ code }) => code === 0 || code === 1),
    Effect.orElseSucceed(() => false),
  );
  const launchdSocket = yield* Effect.gen(function* () {
    const uid = yield* run("id", ["-u"]);
    if (uid.code !== 0 || !/^\d+$/.test(uid.stdout.trim())) return undefined;
    const launchd = yield* run("launchctl", [
      "print",
      `gui/${uid.stdout.trim()}/com.openssh.ssh-agent`,
    ]);
    if (launchd.code !== 0) return undefined;
    const socket = /^\s*SSH_AUTH_SOCK\s*=>\s*(.+?)\s*$/m.exec(launchd.stdout)?.[1];
    if (socket === undefined) return undefined;
    return (yield* fs.stat(socket)).type === "Socket" ? socket : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
  return { alive, launchdSocket } satisfies SshProbe;
});
