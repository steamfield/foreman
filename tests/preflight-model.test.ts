import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { defaultModel } from "../src/core/preflight/model";

it.effect(
  "selects listed sol models by numeric version, skipping malformed entries individually",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        path.join(home, "models_cache.json"),
        JSON.stringify({
          models: [
            null,
            3,
            "odd",
            {},
            { slug: 99, visibility: "list" },
            { slug: "gpt-6.9-sol", visibility: "list" },
            { slug: "gpt-6.10-sol", visibility: "list" },
            { slug: "gpt-7-sol", visibility: "hidden" },
            { slug: "gpt-8-sol-mini", visibility: "list" },
            { slug: "gpt-9-sol\n", visibility: "list" },
          ],
        }),
      );
      expect(yield* defaultModel(home)).toBe("gpt-6.10-sol");
      yield* fs.writeFileString(
        path.join(home, "models_cache.json"),
        JSON.stringify({
          models: [
            { slug: "gpt-6.10-sol", visibility: "list" },
            { slug: "gpt-6.10.0-sol", visibility: "list" },
          ],
        }),
      );
      expect(yield* defaultModel(home)).toBe("gpt-6.10.0-sol");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back for a missing, unreadable, malformed or unusable cache", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const file = path.join(home, "models_cache.json");
    expect(yield* defaultModel(home)).toBe("gpt-6.1-sol");
    for (const contents of ["{", "null", "{}", '{"models":{}}', '{"models":[null]}']) {
      yield* fs.writeFileString(file, contents);
      expect(yield* defaultModel(home)).toBe("gpt-6.1-sol");
    }
    yield* fs.remove(file);
    yield* fs.makeDirectory(file);
    expect(yield* defaultModel(home)).toBe("gpt-6.1-sol");
  }).pipe(Effect.provide(NodeServices.layer)),
);
