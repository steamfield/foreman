// Phase 5 of plans/agy-provider.md (RFC 0002 "Model routing and its errors" and "The agent
// experience"): what Claude sees through the CLI. Routing errors name the input, the reason and
// the fix, exit 2 before any daemon is contacted, and carry candidates in --json; `foreman
// models` lists both catalogs; `foreman doctor` reports each provider.
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorTable } from "../src/errors";
import { ndjson, runCli, tempDir } from "./helpers/cli";

const AGY_VERSION = "1.5.14";

/** `agy models` as agy 1.5.14 prints it (RFC probe list, trimmed to the families used here). */
const AGY_MODELS: readonly (readonly [string, string])[] = [
  ["gemini-4-neon-low", "Gemini 4 Neon (Low)"],
  ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
  ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
  ["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
];

/** The cache entries src/providers/agy/catalog.ts writes for AGY_MODELS. */
const AGY_CACHE_MODELS = AGY_MODELS.map(([id, name]) => {
  const effort = /-(low|medium|high|xhigh)$/.exec(id)?.[1] ?? null;
  const stem = effort === null ? id : id.slice(0, -effort.length - 1);
  const shared = AGY_MODELS.filter(([other]) => other.startsWith(`${stem}-`)).length > 1;
  return { id, family: shared ? stem : id, effort, name };
});

const codexModel = (slug: string, visibility: "list" | "hide" = "list") => ({
  slug,
  display_name: slug,
  visibility,
  default_reasoning_level: "medium",
  supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
});

/**
 * A HOME with Codex's model cache, foreman's home with a fresh agy catalog cache, and a fake
 * `agy` that prints its version and model list and logs each invocation. `agy: false` leaves
 * agy uninstalled instead.
 */
async function setup(options: { agy?: boolean } = {}) {
  const home = await tempDir();
  const foremanHome = join(home, "foreman");
  const codexHome = join(home, "codex");
  const bin = join(home, "bin");
  const calls = join(home, "agy-calls.log");
  await mkdir(codexHome, { recursive: true });
  await mkdir(join(foremanHome, "providers", "agy"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(codexHome, "models_cache.json"),
    JSON.stringify({
      models: [
        codexModel("gpt-6.1-sol"),
        codexModel("gpt-6.1-sol-mini"),
        codexModel("gpt-oss-120b-medium"),
        codexModel("gpt-x", "hide"),
      ],
    }),
  );
  await writeFile(
    join(foremanHome, "providers", "agy", "models.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      agyVersion: AGY_VERSION,
      models: AGY_CACHE_MODELS,
    }),
  );
  const agy = join(bin, "agy");
  if (options.agy !== false) {
    const listing = AGY_MODELS.map(([id, name]) => `${id}\\t${name}`).join("\\n");
    await writeFile(
      agy,
      [
        "#!/bin/sh",
        `echo "$1" >> ${JSON.stringify(calls)}`,
        'case "$1" in',
        `  --version) echo ${AGY_VERSION} ;;`,
        `  models) printf 'Fetching models...\\n${listing}\\n' ;;`,
        "  *) exit 2 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(agy, 0o755);
  }
  const contract = join(home, "contract.md");
  await writeFile(contract, "Work");
  const env = {
    FOREMAN_HOME: foremanHome,
    CODEX_HOME: codexHome,
    AGY_BIN: options.agy === false ? "agy" : agy,
    PATH: `${bin}:/usr/bin:/bin`,
  };
  const run = (args: readonly string[]) => runCli(args, { home, env });
  const start = (model: readonly string[], json = true) =>
    run([
      "start",
      "unit",
      "--worktree",
      home,
      "--contract",
      contract,
      ...model,
      ...(json ? ["--json"] : []),
    ]);
  const agyCalls = async () =>
    (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const exists = (file: string) =>
    access(join(foremanHome, file)).then(
      () => true,
      () => false,
    );
  /** True when the CLI reached for a daemon: a socket or lock appeared in foreman's home. */
  const daemonTouched = async () => (await exists("foreman.sock")) || (await exists("daemon.lock"));
  return { run, start, agyCalls, daemonTouched };
}

/** The --json error envelope, which follows the command's error log record on stderr. */
const envelope = (stderr: string) => ndjson(stderr).at(-1);

describe("start with a model no provider resolves", () => {
  it("suggests the near miss with its provider and candidates, exit 2, no daemon", async () => {
    const f = await setup();
    const result = await f.start(["--model", "gemini-4-neo"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    const error = envelope(result.stderr);
    expect(error).toMatchObject({
      error: {
        tag: "ModelUnresolved",
        message: errorTable.ModelUnresolved.message,
        detail:
          'Unknown model "gemini-4-neo": no provider lists it. Did you mean gemini-4-neon (agy)? Run foreman models to see every model.',
        retryable: false,
      },
    });
    expect(error).toHaveProperty("error.candidates.0", {
      provider: "agy",
      model: "gemini-4-neon",
      efforts: ["low", "medium", "high", "xhigh"],
    });
    expect(await f.daemonTouched()).toBe(false);
    // A fresh cache answers without refreshing agy's catalog.
    expect(await f.agyCalls()).not.toContain("models");
  });

  it("prints the near miss on stderr without --json", async () => {
    const f = await setup();
    const result = await f.start(["--model", "gemini-4-neo"], false);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      'Unknown model "gemini-4-neo": no provider lists it. Did you mean gemini-4-neon (agy)? Run foreman models to see every model.',
    );
  });

  it.each<[string, readonly string[], string, { agy?: boolean }?]>([
    [
      "no near miss",
      ["--model", "gemini-9-ultra"],
      'Unknown model "gemini-9-ultra": neither codex nor agy lists it. Run foreman models to see the available models.',
    ],
    [
      "a model both providers list",
      ["--model", "gpt-oss-120b-medium"],
      'Model "gpt-oss-120b-medium" is offered by codex and agy. Pass --model codex:gpt-oss-120b-medium or --model agy:gpt-oss-120b-medium.',
    ],
    [
      "an effort suffix that disagrees with --effort",
      ["--model", "gemini-4-neon-high", "--effort", "low"],
      "--model gemini-4-neon-high sets effort high, but --effort is low. Use --model gemini-4-neon --effort low.",
    ],
    [
      "an effort the provider doesn't offer",
      ["--model", "gemini-4-neon", "--effort", "minimal"],
      "--effort minimal is not valid for gemini-4-neon (agy). Use one of: low, medium, high, xhigh.",
    ],
    [
      "--tier on an agy model",
      ["--model", "gemini-4-neon", "--tier", "flex"],
      "--tier only applies to Codex models; gemini-4-neon runs on agy. Remove --tier.",
    ],
    [
      "an unknown provider prefix",
      ["--model", "gemni:gemini-4-neon"],
      'Unknown provider "gemni" in --model gemni:gemini-4-neon. Use codex or agy.',
    ],
    [
      "a model Codex doesn't list when agy isn't installed",
      ["--model", "gemini-4-neon"],
      "Unknown model \"gemini-4-neon\": codex doesn't list it and agy isn't installed. Run foreman models to see the available models.",
      { agy: false },
    ],
    [
      "a hidden Codex model",
      ["--model", "gpt-x"],
      'Model "gpt-x" is in Codex\'s catalog but hidden. Pick a visible model from foreman models.',
    ],
  ])("refuses %s with the RFC text", async (_case, model, detail, options) => {
    const f = await setup(options);
    const result = await f.start(model);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(envelope(result.stderr)).toMatchObject({
      error: { tag: "ModelUnresolved", detail, retryable: false },
    });
    expect(await f.daemonTouched()).toBe(false);
  });
});

const byModel = (left: { model: string }, right: { model: string }) =>
  left.model.localeCompare(right.model);

describe("foreman models", () => {
  it("lists both catalogs with efforts, default efforts and the default model", async () => {
    const f = await setup();
    const result = await f.run(["models", "--json"]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const listed = JSON.parse(result.stdout) as {
      providers: { provider: string; unavailable: string | null; models: { model: string }[] }[];
    };
    expect(listed.providers.map(({ provider }) => provider)).toEqual(["codex", "agy"]);
    const [codex, agy] = listed.providers;
    const codexEntry = (model: string, isDefault = false) => ({
      model,
      efforts: ["low", "medium", "high"],
      // A start with no --effort uses high, whatever the catalog's own default.
      defaultEffort: "high",
      default: isDefault,
    });
    expect({ ...codex, models: [...(codex?.models ?? [])].sort(byModel) }).toEqual({
      provider: "codex",
      unavailable: null,
      models: [
        codexEntry("gpt-6.1-sol", true),
        codexEntry("gpt-6.1-sol-mini"),
        codexEntry("gpt-oss-120b-medium"),
      ],
    });
    expect({ ...agy, models: [...(agy?.models ?? [])].sort(byModel) }).toEqual({
      provider: "agy",
      unavailable: null,
      models: [
        { model: "claude-opus-5-5", efforts: [], defaultEffort: null, default: false },
        {
          model: "gemini-3.8-flash",
          efforts: ["low", "medium"],
          defaultEffort: "medium",
          default: false,
        },
        {
          model: "gemini-4-neon",
          efforts: ["low", "medium", "high", "xhigh"],
          defaultEffort: "high",
          default: false,
        },
        { model: "gpt-oss-120b-medium", efforts: [], defaultEffort: null, default: false },
      ],
    });
  });

  it("lists an unavailable agy with its reason", async () => {
    const f = await setup({ agy: false });
    const result = await f.run(["models", "--json"]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const listed = JSON.parse(result.stdout) as { providers: unknown[] };
    expect(listed.providers).toContainEqual({
      provider: "agy",
      unavailable: expect.stringMatching(/agy/),
      models: [],
    });
    expect(listed.providers).toContainEqual(
      expect.objectContaining({ provider: "codex", unavailable: null }),
    );
  });
});

describe("foreman doctor", () => {
  it("reports codex and agy separately in --json", async () => {
    const f = await setup();
    const result = await f.run(["doctor", "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    // Every Codex field stays where it was; agy gets its own object.
    expect(report).toHaveProperty("codexVersion");
    expect(report).toHaveProperty("loggedIn");
    expect(report).toHaveProperty("agy");
    expect(typeof report.agy).toBe("object");
    expect(JSON.stringify(report.agy)).toContain(AGY_VERSION);
  });

  it('says "agy: not installed" and still exits 0 without agy', async () => {
    const f = await setup({ agy: false });
    const result = await f.run(["doctor"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agy: not installed");
    const machine = await f.run(["doctor", "--json"]);
    expect(machine.status).toBe(0);
    expect(JSON.parse(machine.stdout)).toHaveProperty("agy");
  });
});
