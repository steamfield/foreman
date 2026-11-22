import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, type Path, type Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { AgyUnavailable } from "../../src/errors";
import { parseAgyModels, readAgyCatalog } from "../../src/providers/agy/catalog";

const AGY_MODELS_OUTPUT = `Fetching available models...
gemini-4-neon-high\tGemini 4 Neon (High)
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)
gemini-4-neon-medium\tGemini 4 Neon (Medium)
gemini-4-neon-low\tGemini 4 Neon (Low)
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-pro-orchestrator-neon\tOrchestrator (Neon)
gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

describe("parseAgyModels", () => {
  const models = parseAgyModels(AGY_MODELS_OUTPUT);
  const byId = (id: string) => models.find((model) => model.id === id);

  it("skips the Fetching line and keeps every model", () => {
    expect(models).toHaveLength(16);
  });

  it("splits an effort suffix into family and effort", () => {
    expect(byId("gemini-4-neon-xhigh")).toEqual({
      id: "gemini-4-neon-xhigh",
      family: "gemini-4-neon",
      effort: "xhigh",
      name: "Gemini 4 Neon (XHigh)",
    });
    expect(byId("gemini-3.8-flash-low")?.family).toBe("gemini-3.8-flash");
  });

  it("keeps an id with no effort suffix as its own family", () => {
    expect(byId("gemini-pro-orchestrator-neon")).toEqual({
      id: "gemini-pro-orchestrator-neon",
      family: "gemini-pro-orchestrator-neon",
      effort: null,
      name: "Orchestrator (Neon)",
    });
  });

  it("keeps a lone fixed-effort id as its own family but records the effort", () => {
    expect(byId("gpt-oss-120b-medium")).toEqual({
      id: "gpt-oss-120b-medium",
      family: "gpt-oss-120b-medium",
      effort: "medium",
      name: "GPT-OSS 120B (Medium)",
    });
  });

  it("returns nothing for empty output", () => {
    expect(parseAgyModels("")).toEqual([]);
  });
});

const NOW = Date.parse("2026-11-22T12:00:00Z");
const HOUR = 60 * 60 * 1000;

/**
 * A fake `agy` shell script: `--version` prints the contents of `version`, `models` prints
 * `models` and appends a line to `calls`. All three live in the returned directory.
 */
const fakeAgy = Effect.fnUntraced(function* (version = "1.5.14", failModels = false) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  const script = `${dir}/agy`;
  yield* fs.writeFileString(`${dir}/version`, version);
  yield* fs.writeFileString(`${dir}/models`, AGY_MODELS_OUTPUT);
  yield* fs.writeFileString(`${dir}/calls`, "");
  yield* fs.writeFileString(
    script,
    `#!/bin/sh
case "$1" in
  --version) cat "${dir}/version" ;;
  models)
    echo x >> "${dir}/calls"
    ${failModels ? 'echo "not signed in" >&2; exit 3' : `cat "${dir}/models"`} ;;
esac
`,
    { mode: 0o755 },
  );
  const calls = () =>
    fs.readFileString(`${dir}/calls`).pipe(Effect.map((t) => t.split("\n").length - 1));
  const options = (overrides: { now?: number; refresh?: boolean } = {}) => ({
    agyBin: script,
    env: { PATH: "/usr/bin:/bin" },
    home: `${dir}/home`,
    now: overrides.now ?? NOW,
    refresh: overrides.refresh ?? false,
  });
  return { fs, dir, calls, options };
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("readAgyCatalog", () => {
  it.effect("runs agy models once, then serves the cache", () =>
    run(
      Effect.gen(function* () {
        const agy = yield* fakeAgy();
        const first = yield* readAgyCatalog(agy.options());
        const second = yield* readAgyCatalog(agy.options({ now: NOW + HOUR }));
        expect(first.agyVersion).toBe("1.5.14");
        expect(first.fetchedAt).toBe("2026-11-22T12:00:00.000Z");
        expect(first.models).toHaveLength(16);
        expect(second).toEqual(first);
        expect(yield* agy.calls()).toBe(1);
      }),
    ),
  );

  it.effect("refreshes a cache older than 24 hours", () =>
    run(
      Effect.gen(function* () {
        const agy = yield* fakeAgy();
        yield* readAgyCatalog(agy.options());
        const later = yield* readAgyCatalog(agy.options({ now: NOW + 25 * HOUR }));
        expect(later.fetchedAt).toBe(new Date(NOW + 25 * HOUR).toISOString());
        expect(yield* agy.calls()).toBe(2);
      }),
    ),
  );

  it.effect("refreshes when agy's version changed", () =>
    run(
      Effect.gen(function* () {
        const agy = yield* fakeAgy();
        yield* readAgyCatalog(agy.options());
        yield* agy.fs.writeFileString(`${agy.dir}/version`, "1.6.0\n");
        const updated = yield* readAgyCatalog(agy.options());
        expect(updated.agyVersion).toBe("1.6.0");
        expect(yield* agy.calls()).toBe(2);
      }),
    ),
  );

  it.effect("refreshes when asked to, even with a fresh cache", () =>
    run(
      Effect.gen(function* () {
        const agy = yield* fakeAgy();
        yield* readAgyCatalog(agy.options());
        yield* readAgyCatalog(agy.options({ refresh: true }));
        expect(yield* agy.calls()).toBe(2);
      }),
    ),
  );

  it.effect("treats a damaged cache as missing and rewrites it", () =>
    run(
      Effect.gen(function* () {
        const agy = yield* fakeAgy();
        const cache = `${agy.dir}/home/providers/agy/models.json`;
        yield* agy.fs.makeDirectory(`${agy.dir}/home/providers/agy`, { recursive: true });
        yield* agy.fs.writeFileString(cache, "{torn");
        yield* readAgyCatalog(agy.options());
        expect(JSON.parse(yield* agy.fs.readFileString(cache)).models).toHaveLength(16);
      }),
    ),
  );

  it.effect("writes the cache atomically and leaves no temporary file", () =>
    run(
      Effect.gen(function* () {
        const agy = yield* fakeAgy();
        yield* readAgyCatalog(agy.options());
        expect(yield* agy.fs.readDirectory(`${agy.dir}/home/providers/agy`)).toEqual([
          "models.json",
        ]);
      }),
    ),
  );

  it.effect("fails with the command and its stderr when agy models fails, caching nothing", () =>
    run(
      Effect.gen(function* () {
        const agy = yield* fakeAgy("1.5.14", true);
        const error = yield* readAgyCatalog(agy.options()).pipe(Effect.flip);
        expect(error).toBeInstanceOf(AgyUnavailable);
        expect(error.detail).toContain("models` exited with code 3: not signed in");
        expect(yield* agy.fs.exists(`${agy.dir}/home/providers/agy/models.json`)).toBe(false);
      }),
    ),
  );

  it.effect("fails with the install hint when the agy binary is missing", () =>
    run(
      Effect.gen(function* () {
        const agy = yield* fakeAgy();
        const error = yield* readAgyCatalog({ ...agy.options(), agyBin: `${agy.dir}/nope` }).pipe(
          Effect.flip,
        );
        expect(error).toBeInstanceOf(AgyUnavailable);
        expect(error.detail).toContain("Install agy or set AGY_BIN, then run foreman doctor.");
      }),
    ),
  );
});
