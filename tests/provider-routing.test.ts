// Model routing through the CLI (docs/rfcs/0002-providers.md "Model routing and its errors"):
// the routed start sent to the daemon, refusals before it is contacted, and the outdated-daemon
// refusal. The rules themselves are in tests/model-routing.test.ts.
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect";
import { onTestFinished } from "vitest";
import { call } from "../src/daemon/client";
import { daemon } from "../src/daemon/server";
import { errorEnvelope, ModelUnresolved, RunConflict } from "../src/errors";
import { type DaemonRequestBody, RunName } from "../src/schemas/daemon";
import { Host } from "../src/services/host";
import { listeningSockets, ndjson, runCli } from "./helpers/cli";

const name = Schema.decodeUnknownSync(RunName)("unit-a");

/** A daemon recording every request, launched by `build`; any other build is outdated and busy. */
async function daemonFixture(build = "test") {
  const dataDir = await mkdtemp("/tmp/fm-route-");
  await symlink(process.execPath, join(dataDir, "foreman"));
  const requests: DaemonRequestBody[] = [];
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      NodeServices.layer,
      Host.layer({
        name: "foreman",
        version: "test",
        build,
        platform: "node",
        compiled: false,
        executable: [process.execPath],
        pid: process.pid,
      }),
    ),
  );
  const ready = await runtime.runPromise(Deferred.make<void>());
  const fiber = runtime.runFork(
    daemon({
      dataDir,
      version: "daemon-test",
      busy: Effect.succeed(false),
      handler: (body) => {
        requests.push(body);
        if (build !== "test" && body._tag === "Shutdown")
          return Effect.fail(new RunConflict({ detail: "Active old runs" }));
        return Effect.succeed({ _tag: "Ok" as const });
      },
    }).pipe(Effect.provide(listeningSockets(Deferred.succeed(ready, undefined)))),
  );
  onTestFinished(async () => {
    await runtime.runPromise(Fiber.interrupt(fiber));
    await runtime.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  await runtime.runPromise(
    Effect.raceFirst(Fiber.join(fiber), Deferred.await(ready)).pipe(Effect.timeout("3 seconds")),
  );
  const contract = join(dataDir, "contract.md");
  await writeFile(contract, "Work");
  const run = (args: readonly string[]) =>
    runCli(["start", name, "--worktree", dataDir, "--contract", contract, ...args, "--json"], {
      home: dataDir,
      env: { FOREMAN_HOME: dataDir, PATH: dataDir },
    });
  /** Writes Codex's model cache under the CLI's HOME. */
  const codexCache = async (slugs: readonly string[]) => {
    await mkdir(join(dataDir, ".codex"), { recursive: true });
    const models = slugs.map((slug) => ({ slug, visibility: "list" }));
    await writeFile(join(dataDir, ".codex", "models_cache.json"), JSON.stringify({ models }));
  };
  /** Puts an `agy` on PATH that lists two Neon efforts and leaves a marker when it runs. */
  const fakeAgy = async () => {
    const marker = join(dataDir, "agy-ran");
    const script = [
      "#!/bin/sh",
      `: > ${JSON.stringify(marker)}`,
      'case "$1" in',
      "  --version) echo 1.5.14 ;;",
      "  models) printf 'Fetching models...\\ngemini-4-neon-low\\tGemini 4 Neon (Low)\\ngemini-4-neon-high\\tGemini 4 Neon (High)\\n' ;;",
      "  *) exit 2 ;;",
      "esac",
    ].join("\n");
    await writeFile(join(dataDir, "agy"), `${script}\n`);
    await chmod(join(dataDir, "agy"), 0o755);
  };
  const agyRan = () =>
    access(join(dataDir, "agy-ran")).then(
      () => true,
      () => false,
    );
  return { dataDir, requests, run, codexCache, fakeAgy, agyRan };
}

const starts = (requests: readonly DaemonRequestBody[]) =>
  requests.filter((request) => request._tag === "Start");

describe("start routing through the CLI", () => {
  it("sends a Codex model without a provider and never runs agy", async () => {
    const f = await daemonFixture();
    await f.codexCache(["gpt-6.1-sol"]);
    await f.fakeAgy();
    const result = await f.run(["--model", "gpt-6.1-sol", "--effort", "low", "--tier", "flex"]);
    expect(result).toEqual({ status: 0, stdout: '{"_tag":"Ok"}\n', stderr: "" });
    expect(starts(f.requests)).toEqual([
      expect.objectContaining({ model: "gpt-6.1-sol", effort: "low", tier: "flex" }),
    ]);
    expect(starts(f.requests)[0]).not.toHaveProperty("provider");
    expect(await f.agyRan()).toBe(false);
  });

  it("sends an agy model as provider agy with its family and effort", async () => {
    const f = await daemonFixture();
    await f.codexCache(["gpt-6.1-sol"]);
    await f.fakeAgy();
    const result = await f.run(["--model", "gemini-4-neon-low"]);
    expect(result).toEqual({ status: 0, stdout: '{"_tag":"Ok"}\n', stderr: "" });
    const [start, ...more] = starts(f.requests);
    expect(more).toEqual([]);
    expect(start).toMatchObject({ provider: "agy", model: "gemini-4-neon", effort: "low" });
    expect(start).not.toHaveProperty("tier");
  });

  it("refuses an unknown model with exit 2 before contacting the daemon", async () => {
    const f = await daemonFixture();
    await f.codexCache(["gpt-6.1-sol"]);
    await f.fakeAgy();
    const result = await f.run(["--model", "gemini-9-ultra"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    // The envelope follows the command's error log record.
    expect(ndjson(result.stderr).at(-1)).toEqual(
      errorEnvelope(
        new ModelUnresolved({
          detail:
            'Unknown model "gemini-9-ultra": neither codex nor agy lists it. Run foreman models to see the available models.',
        }),
      ),
    );
    expect(f.requests).toEqual([]);
  });

  it("tells a Codex-only user about an unknown model without asking them to install agy", async () => {
    const f = await daemonFixture();
    await f.codexCache(["gpt-6.1-sol"]);
    const result = await f.run(["--model", "gpt-6.2-sol"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(ndjson(result.stderr).at(-1)).toEqual(
      errorEnvelope(
        new ModelUnresolved({
          detail:
            'Unknown model "gpt-6.2-sol": no provider lists it. Did you mean gpt-6.1-sol (codex)? Run foreman models to see every model.',
          candidates: [{ provider: "codex", model: "gpt-6.1-sol", efforts: [] }],
        }),
      ),
    );
    expect(f.requests).toEqual([]);
  });
});

describe("an outdated busy daemon", () => {
  it.live("is never sent an agy start", () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(() => daemonFixture("old"));
      const error = yield* call(
        {
          _tag: "Start",
          name,
          worktree: f.dataDir,
          contract: "Work",
          write: true,
          provider: "agy",
          model: "gemini-4-neon",
          effort: "low",
          skipDepsCheck: false,
        },
        { dataDir: f.dataDir, onOutdated: Effect.void },
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DaemonUnavailable",
        detail:
          "Outdated busy daemon can't start agy runs; the request was not sent. Finish or interrupt its active runs, then retry.",
      });
      expect(starts(f.requests)).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          listeningSockets(Effect.void),
          Host.layer({
            name: "foreman",
            version: "test",
            build: "test",
            platform: "node",
            compiled: false,
            executable: [process.execPath],
            pid: process.pid,
          }),
        ),
      ),
    ),
  );
});
