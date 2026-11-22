import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import * as Store from "../src/core/runs/store";
import { providerOf, RunEvent, RunRecord } from "../src/schemas/daemon";
import { makeRegistry } from "../src/supervisor/registry";

const baseRecord = Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord))(
  readFileSync(new URL("./fixtures/runs/run.json", import.meta.url), "utf8"),
);

const setup = Effect.fnUntraced(function* (record: RunRecord) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const worktree = path.join(root, "worktree");
  yield* fs.makeDirectory(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  const run = { ...record, worktree };
  const dir = yield* Store.createRun(root, run, "contract");
  return { fs, path, root, dir, run };
});

const storedVersion = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const stored = JSON.parse(yield* fs.readFileString(`${dir}/run.json`));
  return stored.formatVersion;
});

const expectFormatVersionRefusal = (error: { readonly _tag: string; readonly message: string }) => {
  expect(error._tag).toBe("SchemaError");
  expect(error.message).toContain("formatVersion");
};

it.effect("writes an agy run as format 3 on create and recovers it through transition replay", () =>
  Effect.gen(function* () {
    const { root, dir, run } = yield* setup({ ...baseRecord, provider: "agy" });
    expect(yield* storedVersion(dir)).toBe(3);
    expect(yield* Store.readRun(dir)).toEqual(run);

    // A daemon that died between saving the pending transition and journaling it.
    yield* Store.writeRun(dir, {
      ...run,
      state: "idle",
      pendingStateEvent: { id: "t1", from: "running", to: "idle" },
    });
    const registry = yield* makeRegistry(root);
    const recovered = yield* registry.lookup(run.name);

    expect(providerOf(recovered.record)).toBe("agy");
    expect(yield* Store.hasTransition(dir, "t1")).toBe(true);
    expect(yield* storedVersion(dir)).toBe(3);
    const stored = yield* Store.readRun(dir);
    expect(providerOf(stored)).toBe("agy");
    expect(stored.pendingStateEvent ?? null).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { label: "a codex record", provider: "codex" as const },
  { label: "a record without provider", provider: undefined },
])("writes $label as format 1 and reads it back as codex", ({ provider }) =>
  Effect.gen(function* () {
    const { provider: _dropped, ...withoutProvider } = baseRecord;
    const record: RunRecord =
      provider === undefined ? withoutProvider : { ...withoutProvider, provider };
    const { dir } = yield* setup(record);
    expect(yield* storedVersion(dir)).toBe(1);
    yield* Store.writeRun(dir, { ...(yield* Store.readRun(dir)), state: "idle" });
    expect(yield* storedVersion(dir)).toBe(1);
    expect(providerOf(yield* Store.readRun(dir))).toBe("codex");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses a version 4 run.json as unsupported", () =>
  Effect.gen(function* () {
    const { fs, dir, run } = yield* setup(baseRecord);
    const encoded = yield* Schema.encodeEffect(RunRecord)(run);
    yield* fs.writeFileString(`${dir}/run.json`, JSON.stringify({ ...encoded, formatVersion: 4 }));
    expectFormatVersionRefusal(yield* Effect.flip(Store.readRun(dir)));
    expectFormatVersionRefusal(yield* Effect.flip(Store.writeRun(dir, run)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("appends agy raw messages to agy.jsonl and checks its version header", () =>
  Effect.gen(function* () {
    const { fs, dir } = yield* setup({ ...baseRecord, provider: "agy" });
    expect(Store.rawLogName("agy")).toBe("agy.jsonl");
    expect(Store.rawLogName("codex")).toBe("codex.jsonl");
    yield* Store.appendProviderMessage(dir, "agy", { method: "session/update" });
    expect(yield* fs.exists(`${dir}/codex.jsonl`)).toBe(false);
    const line = JSON.parse((yield* fs.readFileString(`${dir}/agy.jsonl`)).trim());
    expect(line).toMatchObject({ method: "session/update", formatVersion: 1 });

    yield* fs.writeFileString(`${dir}/agy.jsonl`, `${JSON.stringify({ formatVersion: 4 })}\n`);
    expectFormatVersionRefusal(
      yield* Effect.flip(Store.appendProviderMessage(dir, "agy", { method: "again" })),
    );
    expectFormatVersionRefusal(yield* Effect.flip(Store.writeRun(dir, baseRecord)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("round-trips a Permission event", () =>
  Effect.gen(function* () {
    const { dir } = yield* setup(baseRecord);
    const body = {
      _tag: "Permission" as const,
      kind: "execute",
      title: "Run ls",
      decision: "approved" as const,
    };
    const written = yield* Store.appendEvent(dir, body);
    const { events } = yield* Store.readEvents(dir);
    expect(events).toEqual([written]);
    expect(Schema.is(RunEvent)(events[0])).toBe(true);
    expect(events[0]?.event).toEqual(body);
  }).pipe(Effect.provide(NodeServices.layer)),
);
