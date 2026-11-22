// Model routing rules and their errors (docs/rfcs/0002-providers.md "Model routing and its
// errors") against fixture catalogs, near-miss ranking, the refresh-once rule, and `foreman
// models` in both output formats.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { AgyUnavailable, ModelUnresolved } from "../src/errors";
import type { AgyCatalog } from "../src/providers/agy/catalog";
import type { CodexCatalog } from "../src/providers/codex/catalog";
import { type ModelCatalogs, type ModelRequest, resolveModel } from "../src/providers/routing";
import { type NearMissOption, nearMisses } from "../src/providers/routing-errors";
import { runCli, tempDir } from "./helpers/cli";

const FETCHED_AT = "2026-11-22T00:00:00.000Z";
const HOUR = 60 * 60 * 1000;

const agyModel = (id: string, family: string, effort: string | null, name = id) => ({
  id,
  family,
  effort,
  name,
});

const agyCatalog: AgyCatalog = {
  fetchedAt: FETCHED_AT,
  agyVersion: "1.5.14",
  models: [
    agyModel("gemini-4-neon-low", "gemini-4-neon", "low"),
    agyModel("gemini-4-neon-high", "gemini-4-neon", "high"),
    agyModel("gemini-4-neon-medium", "gemini-4-neon", "medium"),
    agyModel("gemini-4-neon-xhigh", "gemini-4-neon", "xhigh"),
    agyModel("gemini-3.8-flash-low", "gemini-3.8-flash", "low"),
    agyModel("gemini-3.8-flash-medium", "gemini-3.8-flash", "medium"),
    agyModel("claude-opus-5-5", "claude-opus-5-5", null),
    agyModel("gpt-oss-120b-medium", "gpt-oss-120b-medium", "medium"),
  ],
};

const CODEX_EFFORTS = ["low", "medium", "high"];
const codexListed = (...models: string[]) =>
  models.map((model) => ({ model, efforts: CODEX_EFFORTS, defaultEffort: "medium" }));
const codexCatalog: CodexCatalog = {
  listed: codexListed("gpt-6.1-sol", "gpt-6.1-sol-mini"),
  hidden: ["gpt-x"],
};
const noCodexCatalog: CodexCatalog = { listed: [], hidden: [] };

const neverReadAgy = () => Effect.die(new Error("agy's catalog must not be read for this model"));
const agyBroken = () =>
  Effect.fail(new AgyUnavailable({ detail: "`agy models` exited with code 1" }));
const agyMissing = () =>
  Effect.succeed({ _tag: "NotInstalled", reason: "agy not found on PATH" } as const);
const agyRead = (catalog: AgyCatalog) => Effect.succeed({ _tag: "Read", catalog } as const);

const catalogs = (
  options: { codex?: CodexCatalog; agy?: ModelCatalogs["agy"]; agyCached?: AgyCatalog | null } = {},
): ModelCatalogs => ({
  codex: Effect.succeed(options.codex ?? codexCatalog),
  agy: options.agy ?? (() => agyRead(agyCatalog)),
  agyCached: Effect.succeed(options.agyCached ?? null),
});

const neonCandidate = {
  provider: "agy",
  model: "gemini-4-neon",
  efforts: ["low", "medium", "high", "xhigh"],
} as const;

describe("model routing", () => {
  it.effect.each<[string, ModelRequest, ModelCatalogs, unknown]>([
    [
      "no model keeps the Codex default and passes effort and tier",
      { effort: "low", tier: "flex" },
      catalogs({ agy: neverReadAgy }),
      { provider: "codex", effort: "low", tier: "flex" },
    ],
    [
      "no model uses a configured Codex default",
      { defaultModel: "gpt-6.1-sol-mini" },
      catalogs({ agy: neverReadAgy }),
      { provider: "codex", model: "gpt-6.1-sol-mini" },
    ],
    [
      "no model routes a configured agy default to agy",
      { defaultModel: "gemini-4-neon" },
      catalogs(),
      { provider: "agy", model: "gemini-4-neon", effort: "high" },
    ],
    [
      "--model wins over the configured default",
      { model: "gpt-6.1-sol", defaultModel: "gemini-4-neon" },
      catalogs({ agy: neverReadAgy }),
      { provider: "codex", model: "gpt-6.1-sol" },
    ],
    [
      "a model Codex lists runs on Codex without running agy",
      { model: "gpt-6.1-sol", effort: "medium" },
      catalogs({ agy: neverReadAgy, agyCached: agyCatalog }),
      { provider: "codex", model: "gpt-6.1-sol", effort: "medium" },
    ],
    [
      "a model both list runs on Codex when agy's cache is missing or stale",
      { model: "gpt-oss-120b-medium" },
      catalogs({
        codex: { listed: codexListed("gpt-oss-120b-medium"), hidden: [] },
        agy: neverReadAgy,
      }),
      { provider: "codex", model: "gpt-oss-120b-medium" },
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
      catalogs({ codex: { listed: codexListed("claude-opus-5-5"), hidden: [] } }),
      { provider: "agy", model: "claude-opus-5-5", effort: "none" },
    ],
    [
      "a fixed-effort agy model records effort none",
      { model: "claude-opus-5-5" },
      catalogs(),
      { provider: "agy", model: "claude-opus-5-5", effort: "none" },
    ],
    [
      "a fixed-effort agy model accepts --effort none",
      { model: "claude-opus-5-5", effort: "none" },
      catalogs(),
      { provider: "agy", model: "claude-opus-5-5", effort: "none" },
    ],
    [
      "a lone suffixed agy id keeps its fixed effort",
      { model: "gpt-oss-120b-medium" },
      catalogs(),
      { provider: "agy", model: "gpt-oss-120b-medium", effort: "medium" },
    ],
    [
      "codex:model runs on Codex without reading agy's catalog",
      { model: "codex:gpt-6.1-sol-mini" },
      catalogs({ agy: neverReadAgy, agyCached: agyCatalog }),
      { provider: "codex", model: "gpt-6.1-sol-mini" },
    ],
    [
      "an unreadable Codex catalog passes an unknown model to Codex",
      { model: "custom", effort: "high", tier: "priority" },
      catalogs({ codex: noCodexCatalog }),
      { provider: "codex", model: "custom", effort: "high", tier: "priority" },
    ],
    [
      "an unreadable Codex catalog and missing agy pass the model to Codex",
      { model: "custom" },
      catalogs({ codex: noCodexCatalog, agy: agyMissing }),
      { provider: "codex", model: "custom" },
    ],
    [
      "an unreadable Codex catalog still routes an agy model to agy",
      { model: "gemini-4-neon-low" },
      catalogs({ codex: noCodexCatalog }),
      { provider: "agy", model: "gemini-4-neon", effort: "low" },
    ],
  ])("%s", ([, request, given, expected]) =>
    Effect.gen(function* () {
      expect(yield* resolveModel(request, given)).toEqual(expected);
    }),
  );

  // One row per RFC table row, plus the provider-scoped and fixed-effort variants.
  it.effect.each<[string, ModelRequest, ModelCatalogs, ModelUnresolved]>([
    [
      "a near miss, with its provider and candidates",
      { model: "gemini-4-neo" },
      catalogs(),
      new ModelUnresolved({
        detail:
          'Unknown model "gemini-4-neo": no provider lists it. Did you mean gemini-4-neon (agy)? Run foreman models to see every model.',
        candidates: [neonCandidate],
      }),
    ],
    [
      "no near miss",
      { model: "gemini-9-ultra" },
      catalogs(),
      new ModelUnresolved({
        detail:
          'Unknown model "gemini-9-ultra": neither codex nor agy lists it. Run foreman models to see the available models.',
      }),
    ],
    [
      "a model both providers list",
      { model: "gpt-oss-120b-medium" },
      catalogs({
        codex: { listed: codexListed("gpt-oss-120b-medium"), hidden: [] },
        agy: neverReadAgy,
        agyCached: agyCatalog,
      }),
      new ModelUnresolved({
        detail:
          'Model "gpt-oss-120b-medium" is offered by codex and agy. Pass --model codex:gpt-oss-120b-medium or --model agy:gpt-oss-120b-medium.',
        candidates: [
          { provider: "codex", model: "gpt-oss-120b-medium", efforts: CODEX_EFFORTS },
          { provider: "agy", model: "gpt-oss-120b-medium", efforts: [] },
        ],
      }),
    ],
    [
      "an effort suffix that disagrees with --effort",
      { model: "gemini-4-neon-high", effort: "low" },
      catalogs(),
      new ModelUnresolved({
        detail:
          "--model gemini-4-neon-high sets effort high, but --effort is low. Use --model gemini-4-neon --effort low.",
      }),
    ],
    [
      "an effort the family doesn't offer",
      { model: "gemini-4-neon", effort: "minimal" },
      catalogs(),
      new ModelUnresolved({
        detail:
          "--effort minimal is not valid for gemini-4-neon (agy). Use one of: low, medium, high, xhigh.",
        candidates: [neonCandidate],
      }),
    ],
    [
      "an effort on a fixed-effort agy model",
      { model: "claude-opus-5-5", effort: "low" },
      catalogs(),
      new ModelUnresolved({
        detail:
          "--effort low is not valid for claude-opus-5-5 (agy), which has a fixed effort. Remove --effort.",
      }),
    ],
    [
      "a lone suffixed agy id given another effort",
      { model: "gpt-oss-120b-medium", effort: "high" },
      catalogs(),
      new ModelUnresolved({
        detail:
          "--effort high is not valid for gpt-oss-120b-medium (agy), which has a fixed effort. Remove --effort.",
      }),
    ],
    [
      "--tier on an agy model",
      { model: "gemini-4-neon", tier: "priority" },
      catalogs(),
      new ModelUnresolved({
        detail: "--tier only applies to Codex models; gemini-4-neon runs on agy. Remove --tier.",
      }),
    ],
    [
      "an unknown provider prefix",
      { model: "gemni:gemini-4-neon" },
      catalogs(),
      new ModelUnresolved({
        detail: 'Unknown provider "gemni" in --model gemni:gemini-4-neon. Use codex or agy.',
      }),
    ],
    [
      "a model Codex doesn't list when agy isn't installed, without asking for agy",
      { model: "gemini-4-neon" },
      catalogs({ agy: agyMissing }),
      new ModelUnresolved({
        detail:
          "Unknown model \"gemini-4-neon\": codex doesn't list it and agy isn't installed. Run foreman models to see the available models.",
      }),
    ],
    [
      "a Codex near miss when agy isn't installed",
      { model: "gpt-6.2-sol" },
      catalogs({ agy: agyMissing }),
      new ModelUnresolved({
        detail:
          "Unknown model \"gpt-6.2-sol\": codex doesn't list it and agy isn't installed. Did you mean gpt-6.1-sol (codex)? Run foreman models to see every model.",
        candidates: [{ provider: "codex", model: "gpt-6.1-sol", efforts: CODEX_EFFORTS }],
      }),
    ],
    [
      "an installed agy failing for a model Codex doesn't list",
      { model: "gemini-4-neon" },
      catalogs({ agy: agyBroken }),
      new ModelUnresolved({
        detail:
          'Can\'t check model "gemini-4-neon": agy is unavailable (`agy models` exited with code 1). Run foreman doctor.',
      }),
    ],
    [
      "a Codex near miss over an installed agy failing",
      { model: "gpt-6.2-sol" },
      catalogs({ agy: agyBroken }),
      new ModelUnresolved({
        detail:
          'Unknown model "gpt-6.2-sol": codex doesn\'t list it. Did you mean gpt-6.1-sol (codex)? Run foreman models to see every model.',
        candidates: [{ provider: "codex", model: "gpt-6.1-sol", efforts: CODEX_EFFORTS }],
      }),
    ],
    [
      "agy:model when agy isn't installed",
      { model: "agy:gemini-4-neon" },
      catalogs({ agy: agyMissing }),
      new ModelUnresolved({
        detail:
          'Can\'t check model "gemini-4-neon": agy is unavailable (agy not found on PATH). Install agy or set AGY_BIN.',
      }),
    ],
    [
      "an agy id misspelled past its effort suffix",
      { model: "gemini-4-neon-hihg" },
      catalogs(),
      new ModelUnresolved({
        detail:
          'Unknown model "gemini-4-neon-hihg": no provider lists it. Did you mean gemini-4-neon (agy)? Run foreman models to see every model.',
        candidates: [neonCandidate],
      }),
    ],
    [
      "a prefix of a suffixed agy id",
      { model: "gemini-4-neon-hig" },
      catalogs(),
      new ModelUnresolved({
        detail:
          'Unknown model "gemini-4-neon-hig": no provider lists it. Did you mean gemini-4-neon (agy)? Run foreman models to see every model.',
        candidates: [neonCandidate],
      }),
    ],
    [
      "a hidden Codex model, before agy is consulted",
      { model: "gpt-x" },
      catalogs({ agy: neverReadAgy }),
      new ModelUnresolved({
        detail:
          'Model "gpt-x" is in Codex\'s catalog but hidden. Pick a visible model from foreman models.',
      }),
    ],
    [
      "a hidden Codex model named with codex:",
      { model: "codex:gpt-x" },
      catalogs({ agy: neverReadAgy }),
      new ModelUnresolved({
        detail:
          'Model "gpt-x" is in Codex\'s catalog but hidden. Pick a visible model from foreman models.',
      }),
    ],
    [
      "an agy: model agy doesn't list",
      { model: "agy:gpt-6.1-sol" },
      catalogs(),
      new ModelUnresolved({
        detail:
          'Unknown model "gpt-6.1-sol": agy doesn\'t list it. Run foreman models to see the available models.',
      }),
    ],
    [
      "a codex: model Codex doesn't list, with a Codex near miss",
      { model: "codex:gpt-6.1-so" },
      catalogs({ agy: neverReadAgy }),
      new ModelUnresolved({
        detail:
          'Unknown model "gpt-6.1-so": codex doesn\'t list it. Did you mean gpt-6.1-sol (codex)? Run foreman models to see every model.',
        candidates: [
          { provider: "codex", model: "gpt-6.1-sol", efforts: CODEX_EFFORTS },
          { provider: "codex", model: "gpt-6.1-sol-mini", efforts: CODEX_EFFORTS },
        ],
      }),
    ],
  ])("refuses %s", ([, request, given, expected]) =>
    Effect.gen(function* () {
      expect(yield* resolveModel(request, given).pipe(Effect.flip)).toEqual(expected);
    }),
  );
});

describe("near misses", () => {
  const option = (
    model: string,
    provider: "codex" | "agy" = "agy",
    ids: readonly string[] = [],
  ): NearMissOption => ({ candidate: { provider, model, efforts: [] }, ids });
  const candidate = (model: string, provider: "codex" | "agy" = "agy") =>
    option(model, provider).candidate;

  it("scores every id of a model and reports the model once", () => {
    const neon = option("gemini-4-neon", "agy", ["gemini-4-neon-low", "gemini-4-neon-high"]);
    expect(nearMisses("gemini-4-neon-hihg", [neon])).toEqual([neon.candidate]);
    expect(nearMisses("gemini-4-neon-hig", [neon])).toEqual([neon.candidate]);
  });

  it("ranks by edit distance, keeps prefix matches and drops the rest", () => {
    const catalog = [
      option("gemini-4-neon-preview"),
      option("gemini-4-n"),
      option("gemini-4-neon"),
      option("gemini-9-ultra"),
      option("gpt-6.1-sol", "codex"),
    ];
    expect(nearMisses("gemini-4-neo", catalog).map(({ model }) => model)).toEqual([
      "gemini-4-neon",
      "gemini-4-n",
      "gemini-4-neon-preview",
    ]);
  });

  it("keeps catalog order for ties, so Codex comes first", () => {
    const catalog = [option("gpt-6.1-sol", "codex"), option("gpt-6.1-sal")];
    expect(nearMisses("gpt-6.1-sel", catalog)).toEqual([
      candidate("gpt-6.1-sol", "codex"),
      candidate("gpt-6.1-sal"),
    ]);
  });

  it("suggests at most five models for a short prefix", () => {
    const catalog = ["a1", "a2", "a3", "a4", "a5", "a6"].map((model) => option(`gemini-${model}`));
    expect(nearMisses("gemini-", catalog)).toHaveLength(5);
  });

  it("never suggests the input itself", () => {
    expect(nearMisses("gemini-4-neon", [option("gemini-4-neon")])).toEqual([]);
  });
});

describe("refreshing agy's catalog for an unknown model", () => {
  const recordingAgy = (fresh: AgyCatalog) => {
    const refreshes: boolean[] = [];
    const agy = (refresh: boolean) =>
      Effect.sync(() => {
        refreshes.push(refresh);
        return { _tag: "Read", catalog: refresh ? fresh : agyCatalog } as const;
      });
    return { agy, refreshes };
  };
  const added: AgyCatalog = {
    ...agyCatalog,
    fetchedAt: "2026-11-22T02:00:00.000Z",
    models: [...agyCatalog.models, agyModel("gemini-5-low", "gemini-5-low", "low")],
  };

  it.effect("refreshes once when the cache is over an hour old and then resolves", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(FETCHED_AT) + HOUR + 1);
      const { agy, refreshes } = recordingAgy(added);
      const routed = yield* resolveModel({ model: "gemini-5-low" }, catalogs({ agy }));
      expect(routed).toEqual({ provider: "agy", model: "gemini-5-low", effort: "low" });
      expect(refreshes).toEqual([false, true]);
    }),
  );

  it.effect("refreshes only once before failing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(FETCHED_AT) + 2 * HOUR);
      const { agy, refreshes } = recordingAgy(agyCatalog);
      const error = yield* resolveModel({ model: "gemini-9-ultra" }, catalogs({ agy })).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("ModelUnresolved");
      expect(refreshes).toEqual([false, true]);
    }),
  );

  it.effect("fails without refreshing when the cache is under an hour old", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(FETCHED_AT) + HOUR - 1);
      const { agy, refreshes } = recordingAgy(added);
      const error = yield* resolveModel({ model: "gemini-5-low" }, catalogs({ agy })).pipe(
        Effect.flip,
      );
      expect(error.detail).toContain('Unknown model "gemini-5-low"');
      expect(refreshes).toEqual([false]);
    }),
  );
});

describe("foreman models", () => {
  /** A HOME with Codex's model cache and agy uninstalled, or installed and listing two models. */
  async function setup(options: { agy: boolean; codex?: boolean }) {
    const home = await tempDir();
    const codexHome = join(home, "codex");
    const bin = join(home, "bin");
    await mkdir(codexHome, { recursive: true });
    await mkdir(bin, { recursive: true });
    if (options.codex !== false)
      await writeFile(
        join(codexHome, "models_cache.json"),
        JSON.stringify({
          models: [
            {
              slug: "gpt-6.1-sol",
              visibility: "list",
              default_reasoning_level: "medium",
              supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
            },
            { slug: "gpt-6.1-sol-mini", visibility: "list" },
            { slug: "gpt-x", visibility: "hide" },
          ],
        }),
      );
    if (options.agy) {
      const listing =
        "gemini-4-neon-low\\tLow\\ngemini-4-neon-high\\tHigh\\nclaude-opus-5-5\\tOpus";
      const script = [
        "#!/bin/sh",
        'case "$1" in',
        "  --version) echo 1.5.14 ;;",
        `  models) printf '${listing}\\n' ;;`,
        "  *) exit 2 ;;",
        "esac",
        "",
      ].join("\n");
      await writeFile(join(bin, "agy"), script);
      await chmod(join(bin, "agy"), 0o755);
    }
    const env = {
      FOREMAN_HOME: join(home, "foreman"),
      CODEX_HOME: codexHome,
      PATH: `${bin}:/usr/bin:/bin`,
    };
    return (args: readonly string[]) => runCli(["models", ...args], { home, env });
  }

  it("prints a compact table with the default model marked", async () => {
    const models = await setup({ agy: true });
    const result = await models([]);
    expect(result).toEqual({
      status: 0,
      stderr: "",
      stdout: [
        "PROVIDER  MODEL                  EFFORTS     DEFAULT EFFORT",
        "codex     gpt-6.1-sol (default)  low,medium  high",
        "codex     gpt-6.1-sol-mini       fixed       -",
        "agy       gemini-4-neon          low,high    high",
        "agy       claude-opus-5-5        fixed       -",
        "",
      ].join("\n"),
    });
  });

  it("names an unavailable provider and its reason below the table", async () => {
    const models = await setup({ agy: false });
    const result = await models([]);
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
      "agy: unavailable (agy not found on PATH)",
    );
  });

  it("lists an unreadable Codex catalog as unavailable in --json", async () => {
    const models = await setup({ agy: true, codex: false });
    const result = await models(["--json"]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const listed = JSON.parse(result.stdout) as { providers: unknown[] };
    expect(listed.providers).toEqual([
      {
        provider: "codex",
        unavailable: expect.stringMatching(/models_cache\.json is missing or lists no models/),
        models: [],
      },
      {
        provider: "agy",
        unavailable: null,
        models: [
          {
            model: "gemini-4-neon",
            efforts: ["low", "high"],
            defaultEffort: "high",
            default: false,
          },
          { model: "claude-opus-5-5", efforts: [], defaultEffort: null, default: false },
        ],
      },
    ]);
  });
});
