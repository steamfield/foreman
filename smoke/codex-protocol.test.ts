import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { checkProtocol, codexVersion } from "../src/codex/check";
import { supportedCodex } from "../src/codex/protocol";

test.skipIf(process.env.FORMAN_SMOKE !== "1")(
  "matches the installed Codex protocol and version",
  async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const bin = process.env.CODEX_BIN ?? "codex";
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* codexVersion(bin, env)).toBe(supportedCodex.version);
        const result = yield* checkProtocol(bin, env);
        expect(result).toMatchObject({ matches: true, hash: supportedCodex.schemaHash });
        expect(result.files).toHaveLength(supportedCodex.schemaFiles);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  },
);
