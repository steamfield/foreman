// `foreman doctor` reports agy beside Codex (RFC 0002 "The agent experience"): executable,
// sign-in, protocol, hook trust and catalog size, without ever starting an agy session. The
// agy here is a shell wrapper that answers `--version` and `models` itself and hands `acp` to
// the fake ACP agent, which answers initialize.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcess } from "effect/process";
import { AppConfig } from "../src/config";
import { doctor } from "../src/core/doctor";
import { commandResult } from "../src/core/process";
import { DaemonSockets } from "../src/daemon/sockets";
import { Host } from "../src/services/host";
import { runCli, tempDir } from "./helpers/cli";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent/main.mjs", import.meta.url));
const MODELS = ["gemini-4-neon-low", "gemini-4-neon-high", "claude-opus-5-5"];

const platform = Layer.mergeAll(
  NodeServices.layer,
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
  Host.layer({
    name: "foreman",
    version: "test",
    build: "test",
    platform: "node",
    compiled: false,
    executable: [process.execPath],
    pid: process.pid,
  }),
);

interface AgyFixture {
  readonly root: string;
  readonly env: Record<string, string>;
  /** The JSON-RPC lines the fake agent received. */
  readonly received: () => Promise<string>;
}

/** A home, a fake agy wrapper (signed in unless `signedIn` is false) and the env pointing at it. */
async function agyFixture(options: { signedIn?: boolean; protocol?: number } = {}) {
  const root = await tempDir();
  await mkdir(join(root, "codex"), { recursive: true });
  const scenario = join(root, "scenario.json");
  await writeFile(scenario, JSON.stringify({ rules: [] }));
  const listing = MODELS.map((id) => `${id}\\t${id}`).join("\\n");
  const modelsCase =
    options.signedIn === false
      ? "  models) echo 'not signed in' >&2; exit 1 ;;"
      : `  models) printf '${listing}\\n' ;;`;
  const agy = join(root, "agy");
  await writeFile(
    agy,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  --version) echo 1.5.14 ;;",
      modelsCase,
      `  acp) exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT)} "$@" ;;`,
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(agy, 0o755);
  const log = join(root, "acp.jsonl");
  const env: Record<string, string> = {
    HOME: root,
    FOREMAN_HOME: join(root, "foreman"),
    CODEX_HOME: join(root, "codex"),
    CODEX_BIN: join(root, "missing-codex"),
    AGY_BIN: agy,
    FAKE_ACP_SCENARIO: scenario,
    FAKE_ACP_LOG: log,
    PATH: "/usr/bin:/bin",
    ...(options.protocol === undefined ? {} : { FAKE_ACP_PROTOCOL: String(options.protocol) }),
  };
  const received = () => readFile(log, "utf8").catch(() => "");
  return { root, env, received } satisfies AgyFixture;
}

const doctorWith = (env: Record<string, string>, cwd: string) =>
  doctor(cwd).pipe(Effect.provide(AppConfig.layer(env).pipe(Layer.provideMerge(platform))));

/** A git repo whose only committed hooks are Codex's. */
const codexOnlyHooksRepo = Effect.fnUntraced(function* (root: string) {
  const repo = join(root, "repo");
  yield* Effect.promise(() => mkdir(join(repo, ".codex"), { recursive: true }));
  yield* Effect.promise(() => writeFile(join(repo, ".codex", "hooks.json"), '{"hooks":{}}\n'));
  const git = (...args: string[]) => commandResult(ChildProcess.make("git", args, { cwd: repo }));
  yield* git("init", "-q");
  yield* git("add", ".codex/hooks.json");
  yield* git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "hooks");
  return repo;
}, Effect.provide(NodeServices.layer));

describe("doctor: agy", () => {
  it.live("reports a signed-in agy with version, protocol and catalog size", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => agyFixture());
      const result = yield* doctorWith(fixture.env, fixture.root);
      expect(result.agy).toEqual({
        installed: true,
        bin: fixture.env.AGY_BIN,
        version: "1.5.14",
        signedIn: true,
        protocolMatches: true,
        agentVersion: "1.5.14",
        hookTrust: "not applicable",
        catalogSize: MODELS.length,
        findings: [],
      });
      const received = yield* Effect.promise(fixture.received);
      expect(received).toContain("initialize");
      expect(received).not.toContain("session/");
    }),
  );

  it.live("reports a missing agy as not installed with the next step", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => agyFixture());
      const bin = join(fixture.root, "no-such-agy");
      const result = yield* doctorWith({ ...fixture.env, AGY_BIN: bin }, fixture.root);
      expect(result.agy).toMatchObject({
        installed: false,
        bin,
        signedIn: null,
        protocolMatches: null,
        catalogSize: null,
      });
      expect(result.agy.findings).toEqual([expect.stringContaining("Install agy or set AGY_BIN")]);
    }),
  );

  it.live("reports a signed-out agy and still checks the protocol", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => agyFixture({ signedIn: false }));
      const result = yield* doctorWith(fixture.env, fixture.root);
      expect(result.agy).toMatchObject({
        installed: true,
        signedIn: false,
        protocolMatches: true,
        catalogSize: null,
      });
      expect(result.agy.findings).toEqual([expect.stringContaining("Could not list agy models")]);
    }),
  );

  it.live("reports an agy that speaks another ACP protocol", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => agyFixture({ protocol: 2 }));
      const result = yield* doctorWith(fixture.env, fixture.root);
      expect(result.agy.protocolMatches).toBeNull();
      expect(result.agy.findings).toEqual([expect.stringContaining("ACP protocol 2")]);
    }),
  );

  it.live("shows the Codex-only hooks refusal for the current repo", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => agyFixture());
      const repo = yield* codexOnlyHooksRepo(fixture.root);
      const result = yield* doctorWith(fixture.env, repo);
      expect(result.agy.hookTrust).toBe("refused");
      expect(result.agy.findings).toEqual([expect.stringContaining(".agents/hooks.json")]);
    }),
  );
});

describe("doctor: exit codes and text", () => {
  it("exits 0 and says `agy: not installed` when agy is absent", async () => {
    const fixture = await agyFixture();
    const env = { ...fixture.env, AGY_BIN: join(fixture.root, "no-such-agy") };
    const result = await runCli(["doctor"], { home: fixture.root, env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agy: not installed");
  });

  it("exits 0 and prints each agy check when agy is installed", async () => {
    const fixture = await agyFixture();
    const result = await runCli(["doctor"], { home: fixture.root, env: fixture.env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agy: 1.5.14");
    expect(result.stdout).toContain("Signed in: true");
    expect(result.stdout).toContain(`Models: ${MODELS.length}`);
  });
});
