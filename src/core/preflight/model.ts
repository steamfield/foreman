import { Effect, FileSystem, Path, Result, Schema } from "effect";

const Cache = Schema.Struct({ models: Schema.Array(Schema.Unknown) });
const Model = Schema.Struct({ visibility: Schema.Literal("list"), slug: Schema.String });
const fallback = "gpt-6.1-sol";

function newest(models: readonly unknown[]): string {
  const candidates: { slug: string; version: bigint[] }[] = [];
  for (const entry of models) {
    const model = Schema.decodeUnknownResult(Model)(entry);
    if (Result.isFailure(model)) continue;
    const match = /^gpt-([0-9]+(?:\.[0-9]+)*)-sol$/.exec(model.success.slug);
    if (match?.[1] === undefined || match[0] !== model.success.slug) continue;
    candidates.push({ slug: model.success.slug, version: match[1].split(".").map(BigInt) });
  }
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const left = a.version[i];
      const right = b.version[i];
      if (left === undefined) return -1;
      if (right === undefined) return 1;
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  });
  return candidates.at(-1)?.slug ?? fallback;
}

export const defaultModel = Effect.fn("preflight.defaultModel")(
  function* (codexHome: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs.readFileString(path.join(codexHome, "models_cache.json"));
    const cache = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Cache))(text);
    return newest(cache.models);
  },
  // Cache availability never prevents starting a run.
  Effect.orElseSucceed(() => fallback),
);
