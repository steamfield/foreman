import { Effect, FileSystem, Path, Schema } from "effect";
import { RepoHooksUntrusted } from "../../errors";
import { readTrustConfig } from "./trust-config";

const HooksFile = Schema.Struct({
  hooks: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        hooks: Schema.Array(Schema.Struct({ type: Schema.String, command: Schema.String })),
      }),
    ),
  ).check(
    Schema.makeFilter((events) =>
      Object.keys(events).every((event) => /^[A-Z][a-zA-Z]+$/.test(event)),
    ),
  ),
});

const untrusted = (detail: string) => new RepoHooksUntrusted({ detail });

export const checkHookTrust = Effect.fn("preflight.checkHookTrust")(function* (
  mainCheckout: string,
  codexHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hooksPath = path.join(mainCheckout, ".codex", "hooks.json");
  // lstat distinguishes absence from a dangling symlink, which must fail closed.
  const info = yield* fs.lstat(hooksPath).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
    Effect.mapError(() => untrusted(`Could not read hooks file: ${hooksPath}`)),
  );
  if (info === undefined) return;
  const main = yield* fs
    .realPath(mainCheckout)
    .pipe(Effect.mapError(() => untrusted(`Could not resolve main checkout: ${mainCheckout}`)));
  const realHooks = yield* fs
    .realPath(hooksPath)
    .pipe(Effect.mapError(() => untrusted(`Could not resolve hooks file: ${hooksPath}`)));
  const hooks = yield* fs.readFileString(realHooks).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(HooksFile))),
    Effect.mapError(() => untrusted(`Could not read or decode hooks file: ${realHooks}`)),
  );
  const configPath = path.join(codexHome, "config.toml");
  const config = yield* fs.readFileString(configPath).pipe(
    Effect.mapError(() => untrusted(`Could not read config.toml: ${configPath}`)),
    Effect.flatMap((text) =>
      Effect.try({
        try: () => readTrustConfig(text),
        catch: () => untrusted(`Could not read trust entries in config.toml: ${configPath}`),
      }),
    ),
  );
  if (config.get(`projects:${main}`)?.get("trust_level") !== "trusted")
    return yield* untrusted(`Project not trusted: ${main}`);
  const missing: string[] = [];
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    const snake = event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    for (const [i, group] of groups.entries()) {
      for (const j of group.hooks.keys()) {
        const key = `${realHooks}:${snake}:${i}:${j}`;
        if (!config.get(`hooks.state:${key}`)?.get("trusted_hash")) missing.push(key);
      }
    }
  }
  if (missing.length > 0)
    return yield* untrusted(`Hook keys lack a trusted_hash: ${missing.join(", ")}`);
});
