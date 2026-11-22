// Model routing (docs/rfcs/0002-providers.md "Model routing and its errors"): the rules against
// fixture catalogs, the CLI sending the routed start, and the outdated-daemon refusal.
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect";
import { onTestFinished } from "vitest";
import { call } from "../src/daemon/client";
import { daemon } from "../src/daemon/server";
import { AgyUnavailable, RunConflict, Usage } from "../src/errors";
import type { AgyCatalog } from "../src/providers/agy/catalog";
import { type ModelCatalogs, type ModelRequest, resolveModel } from "../src/providers/routing";
import { type DaemonRequestBody, RunName } from "../src/schemas/daemon";
import { Host } from "../src/services/host";
import { listeningSockets, ndjson, runCli } from "./helpers/cli";

const agyCatalog: AgyCatalog = {
  fetchedAt: "2026-11-22T00:00:00.000Z",
  agyVersion: "1.5.14",
  models: [
    {
      id: "gemini-4-neon-low",
      family: "gemini-4-neon",
      effort: "low",
      name: "Gemini 4 Neon (Low)",
    },
    {
      id: "gemini-4-neon-high",
      family: "gemini-4-neon",
      effort: "high",
      name: "Gemini 4 Neon (High)",
    },
    {
      id: "gemini-4-neon-medium",
      family: "gemini-4-neon",
      effort: "medium",
      name: "Gemini 4 Neon (Medium)",
    },
    {
      id: "gemini-4-neon-xhigh",
      family: "gemini-4-neon",
      effort: "xhigh",
      name: "Gemini 4 Neon (XHigh)",
    },
    {
      id: "gemini-3.8-flash-low",
      family: "gemini-3.8-flash",
      effort: "low",
      name: "Gemini 3.8 Flash (Low)",
    },
    {
      id: "gemini-3.8-flash-medium",
      family: "gemini-3.8-flash",
      effort: "medium",
      name: "Gemini 3.8 Flash (Medium)",
    },
    { id: "claude-opus-5-5", family: "claude-opus-5-5", effort: null, name: "Claude Opus 5.5" },
  ],
};
const codexModels = ["gpt-6.1-sol", "gpt-6.1-sol-mini"];

const unreadAgy = Effect.die(new Error("agy's catalog must not be read for this model"));
const catalogs = (
  codex: readonly string[] = codexModels,
  agy: ModelCatalogs["agy"] = Effect.succeed(agyCatalog),
): ModelCatalogs => ({ codex: Effect.succeed(codex), agy });
const agyMissing = Effect.fail(new AgyUnavailable({ detail: "agy not found on PATH" }));

describe("model routing", () => {
  it.effect.each<[string, ModelRequest, ModelCatalogs, unknown]>([
    [
      "no model keeps the Codex default and passes effort and tier",
      { effort: "low", tier: "flex" },
      catalogs(codexModels, unreadAgy),
      { provider: "codex", effort: "low", tier: "flex" },
    ],
    [
      "a model Codex lists runs on Codex without reading agy's catalog",
      { model: "gpt-6.1-sol", effort: "medium" },
      catalogs(codexModels, unreadAgy),
      { provider: "codex", model: "gpt-6.1-sol", effort: "medium" },
    ],
    [
      "an agy family runs on agy at high effort",
      { model: "gemini-4-neon" },
      catalogs(),
      { provider: "agy", model: "gemini-4-neon", effort: "high" },
    ],
    [
      "an agy family takes a listed --effort",
      { model: "gemini-4-neon", effort: "low" },
      catalogs(),
      { provider: "agy", model: "gemini-4-neon", effort: "low" },
    ],
    [
      "an agy id with an effort suffix splits into family and effort",
      { model: "gemini-4-neon-xhigh" },
      catalogs(),
      { provider: "agy", model: "gemini-4-neon", effort: "xhigh" },
    ],
    [
      "a suffixed id and a matching --effort agree",
      { model: "gemini-4-neon-low", effort: "low" },
      catalogs(),
      { provider: "agy", model: "gemini-4-neon", effort: "low" },
    ],
    [
      "a family without high defaults to its highest effort",
      { model: "gemini-3.8-flash" },
      catalogs(),
      { provider: "agy", model: "gemini-3.8-flash", effort: "medium" },
    ],
    [
      "agy:model checks agy's catalog only",
      { model: "agy:claude-opus-5-5" },
      catalogs(["claude-opus-5-5"]),
      { provider: "agy", model: "claude-opus-5-5", effort: "high" },
    ],
    [
      "codex:model runs on Codex without reading agy's catalog",
      { model: "codex:gpt-6.1-sol-mini" },
      catalogs(codexModels, unreadAgy),
      { provider: "codex", model: "gpt-6.1-sol-mini" },
    ],
    [
      "an unreadable Codex catalog passes an unknown model to Codex",
      { model: "custom", effort: "high", tier: "priority" },
      catalogs([]),
      { provider: "codex", model: "custom", effort: "high", tier: "priority" },
    ],
    [
      "an unreadable Codex catalog and missing agy pass the model to Codex",
      { model: "custom" },
      catalogs([], agyMissing),
      { provider: "codex", model: "custom" },
    ],
    [
      "an unreadable Codex catalog still routes an agy model to agy",
      { model: "gemini-4-neon-low" },
      catalogs([]),
      { provider: "agy", model: "gemini-4-neon", effort: "low" },
    ],
  ])("%s", ([, request, given, expected]) =>
    Effect.gen(function* () {
      expect(yield* resolveModel(request, given)).toEqual(expected);
    }),
  );

  it.effect.each<[string, ModelRequest, ModelCatalogs, unknown]>([
    [
      "an unknown model",
      { model: "gemini-9-ultra" },
      catalogs(),
      new Usage({
        detail:
          'Unknown model "gemini-9-ultra": neither codex nor agy lists it. Run foreman models to see the available models.',
      }),
    ],
    [
      "an unknown provider prefix",
      { model: "gemni:gemini-4-neon" },
      catalogs(),
      new Usage({
        detail: 'Unknown provider "gemni" in --model gemni:gemini-4-neon. Use codex or agy.',
      }),
    ],
    [
      "an agy: model agy doesn't list",
      { model: "agy:gpt-6.1-sol" },
      catalogs(),
      new Usage({
        detail:
          'Unknown model "gpt-6.1-sol": agy doesn\'t list it. Run foreman models to see the available models.',
      }),
    ],
    [
      "a codex: model Codex doesn't list",
      { model: "codex:gemini-4-neon" },
      catalogs(codexModels, unreadAgy),
      new Usage({
        detail:
          'Unknown model "gemini-4-neon": codex doesn\'t list it. Run foreman models to see the available models.',
      }),
    ],
    [
      "an effort suffix that disagrees with --effort",
      { model: "gemini-4-neon-high", effort: "low" },
      catalogs(),
      new Usage({
        detail:
          "--model gemini-4-neon-high sets effort high, but --effort is low. Use --model gemini-4-neon --effort low.",
      }),
    ],
    [
      "an effort the family doesn't offer",
      { model: "gemini-4-neon", effort: "minimal" },
      catalogs(),
      new Usage({
        detail:
          "--effort minimal is not valid for gemini-4-neon (agy). Use one of: low, medium, high, xhigh.",
      }),
    ],
    [
      "an effort on a fixed-effort agy model",
      { model: "claude-opus-5-5", effort: "low" },
      catalogs(),
      new Usage({
        detail:
          "--effort low is not valid for claude-opus-5-5 (agy), which has a fixed effort. Remove --effort.",
      }),
    ],
    [
      "--tier on an agy model",
      { model: "gemini-4-neon", tier: "priority" },
      catalogs(),
      new Usage({
        detail: "--tier only applies to Codex models; gemini-4-neon runs on agy. Remove --tier.",
      }),
    ],
    [
      "agy unavailable for a model Codex doesn't list",
      { model: "gemini-4-neon" },
      catalogs(codexModels, agyMissing),
      new AgyUnavailable({
        detail:
          'Can\'t check model "gemini-4-neon": agy is unavailable (agy not found on PATH). Install agy or set AGY_BIN, then run foreman doctor.',
      }),
    ],
  ])("refuses %s", ([, request, given, expected]) =>
    Effect.gen(function* () {
      expect(yield* resolveModel(request, given).pipe(Effect.flip)).toEqual(expected);
    }),
  );
});

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
    expect(ndjson(result.stderr)).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          tag: "Usage",
          detail:
            'Unknown model "gemini-9-ultra": neither codex nor agy lists it. Run foreman models to see the available models.',
        }),
      }),
    ]);
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
