import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import * as Store from "../src/core/runs/store";
import { providerOf, RunEvent, RunRecord } from "../src/schemas/daemon";

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
  return { fs, path, dir, run };
});

const storedVersion = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const stored = JSON.parse(yield* fs.readFileString(`${dir}/run.json`));
  return stored.formatVersion;
});

it.effect("round-trips an agy run as format 3 through create, write and transition replay", () =>
  Effect.gen(function* () {
    const agy: RunRecord = { ...baseRecord, provider: "agy" };
    const { dir, run } = yield* setup(agy);
    expect(yield* storedVersion(dir)).toBe(3);
    expect(yield* Store.readRun(dir)).toEqual(run);

    const pending = {
      ...run,
      state: "idle" as const,
      pendingStateEvent: { id: "t1", from: "running" as const, to: "idle" as const },
    };
    yield* Store.writeRun(dir, pending);
    expect(yield* storedVersion(dir)).toBe(3);
    const reread = yield* Store.readRun(dir);
    expect(providerOf(reread)).toBe("agy");
    expect(yield* Store.hasTransition(dir, "t1")).toBe(false);

    yield* Store.appendEvent(dir, { _tag: "StateChanged", from: "running", to: "idle" }, "t1");
    expect(yield* Store.hasTransition(dir, "t1")).toBe(true);
    yield* Store.writeRun(dir, { ...reread, pendingStateEvent: null });
    expect(providerOf(yield* Store.readRun(dir))).toBe("agy");
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
    yield* Effect.flip(Store.readRun(dir));
    yield* Effect.flip(Store.writeRun(dir, run));
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
    yield* Effect.flip(Store.appendProviderMessage(dir, "agy", { method: "again" }));
    yield* Effect.flip(Store.writeRun(dir, baseRecord));
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
