import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { connectCodex } from "../../src/providers/codex/connection";
import { QuestionRefused } from "../../src/providers/contract";
import { Scenario } from "../fixtures/fake-app-server/scenario";

const fake = fileURLToPath(new URL("../fixtures/fake-app-server/main.mjs", import.meta.url));

it.effect("refuses a question asked outside the app server and sends Codex nothing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const script = join(dir, "scenario.json");
    const log = join(dir, "received.jsonl");
    yield* fs.writeFileString(
      script,
      Schema.encodeSync(Schema.fromJsonString(Scenario))({ rules: [] }),
    );
    const connection = yield* connectCodex({
      codexBin: fake,
      env: {
        PATH: dirname(process.execPath),
        FAKE_APP_SERVER_SCENARIO: script,
        FAKE_APP_SERVER_LOG: log,
      },
      version: "test-version",
      stderr: () => Effect.void,
    });

    const refused = yield* connection
      .ask("thread", { question: "Which API?", kind: "question", callId: "call-1", raw: {} })
      .pipe(Effect.flip);

    expect(refused).toEqual(
      new QuestionRefused({ reason: "Codex questions arrive from the app server" }),
    );
    // A request the fake answers (with an unknown-method error) flushes its log: nothing
    // reached the app server between the handshake and it.
    yield* connection.interrupt("thread", "turn").pipe(Effect.flip);
    const methods = (yield* fs.readFileString(log))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).method);
    expect(methods).toEqual(["initialize", "initialized", "turn/interrupt"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
