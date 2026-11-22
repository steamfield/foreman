import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, type Scope } from "effect";
import { PermissionDenied, RepoHooksUntrusted } from "../../src/errors";
import { agyHookTrust, findAgyHooks } from "../../src/providers/agy/hooks";

const VALID_HOOKS = JSON.stringify({
  guard: {
    PreToolUse: [
      { matcher: "run_command", hooks: [{ type: "command", command: "./guard.sh", timeout: 10 }] },
    ],
  },
  off: { enabled: false, PreInvocation: [{ command: "./remind.sh" }] },
});

/** A main checkout and a worktree in a temp directory; `files` are relative to each root. */
const repoWith = Effect.fnUntraced(function* (files: {
  main?: Record<string, string>;
  work?: Record<string, string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const write = Effect.fnUntraced(function* (base: string, entries: Record<string, string>) {
    for (const [name, text] of Object.entries(entries)) {
      const file = `${base}/${name}`;
      yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      yield* fs.writeFileString(file, text);
    }
  });
  yield* write(`${root}/main`, files.main ?? {});
  yield* write(`${root}/work`, files.work ?? {});
  yield* fs.makeDirectory(`${root}/main`, { recursive: true });
  yield* fs.makeDirectory(`${root}/work`, { recursive: true });
  return { fs, main: `${root}/main`, work: `${root}/work` };
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect.each([".agents", ".agent", "_agents", "_agent"])("finds hooks.json under %s", (dir) =>
  run(
    Effect.gen(function* () {
      const { work } = yield* repoWith({ work: { [`${dir}/hooks.json`]: VALID_HOOKS } });
      expect(yield* findAgyHooks(work)).toBe(`${work}/${dir}/hooks.json`);
    }),
  ),
);

it.effect("prefers .agents over the other directories", () =>
  run(
    Effect.gen(function* () {
      const { work } = yield* repoWith({
        work: { "_agent/hooks.json": "{}", ".agents/hooks.json": "{}" },
      });
      expect(yield* findAgyHooks(work)).toBe(`${work}/.agents/hooks.json`);
    }),
  ),
);

it.effect("counts a dangling symlink as present and returns null when there is none", () =>
  run(
    Effect.gen(function* () {
      const { fs, work } = yield* repoWith({});
      expect(yield* findAgyHooks(work)).toBeNull();
      yield* fs.makeDirectory(`${work}/.agents`);
      yield* fs.symlink("/nonexistent/hooks.json", `${work}/.agents/hooks.json`);
      expect(yield* findAgyHooks(work)).toBe(`${work}/.agents/hooks.json`);
    }),
  ),
);

it.effect.skipIf(process.getuid?.() === 0)(
  "reports an unreadable hook directory as PermissionDenied naming the path",
  () =>
    run(
      Effect.gen(function* () {
        const { fs, work } = yield* repoWith({ work: { ".agents/hooks.json": "{}" } });
        yield* fs.chmod(`${work}/.agents`, 0o000);
        const error = yield* findAgyHooks(work).pipe(
          Effect.flip,
          Effect.ensuring(fs.chmod(`${work}/.agents`, 0o755).pipe(Effect.ignore)),
        );
        expect(error).toBeInstanceOf(PermissionDenied);
        expect(error.detail).toContain(`${work}/.agents/hooks.json`);
      }),
    ),
);

it.effect("requires hooks when a valid file exists, in either entry shape", () =>
  run(
    Effect.gen(function* () {
      const { main, work } = yield* repoWith({ work: { ".agents/hooks.json": VALID_HOOKS } });
      expect(yield* agyHookTrust(main, work)).toEqual({ required: true });
    }),
  ),
);

it.effect("accepts agy hooks that sit beside Codex hooks", () =>
  run(
    Effect.gen(function* () {
      const { main, work } = yield* repoWith({
        main: { ".codex/hooks.json": "{}" },
        work: { ".agents/hooks.json": VALID_HOOKS },
      });
      expect(yield* agyHookTrust(main, work)).toEqual({ required: true });
    }),
  ),
);

it.effect.each([
  { name: "bad JSON", text: "{not json" },
  { name: "a non-object top level", text: "[]" },
  { name: "a non-boolean enabled", text: JSON.stringify({ guard: { enabled: "yes" } }) },
  {
    name: "a handler with no command",
    text: JSON.stringify({ guard: { PreToolUse: [{ hooks: [{}] }] } }),
  },
  { name: "a non-array event", text: JSON.stringify({ guard: { PreToolUse: "x" } }) },
])("refuses a hooks file with $name", ({ text }) =>
  run(
    Effect.gen(function* () {
      const { main, work } = yield* repoWith({ work: { ".agents/hooks.json": text } });
      const error = yield* agyHookTrust(main, work).pipe(Effect.flip);
      expect(error).toBeInstanceOf(RepoHooksUntrusted);
      expect(error.detail).toContain(`agy can't load ${work}/.agents/hooks.json:`);
      expect(error.detail).toContain("Fix the file, then run foreman doctor.");
    }),
  ),
);

it.effect("refuses a dangling hooks symlink because agy would fail to load it", () =>
  run(
    Effect.gen(function* () {
      const { fs, main, work } = yield* repoWith({});
      yield* fs.makeDirectory(`${work}/.agents`);
      yield* fs.symlink("/nonexistent/hooks.json", `${work}/.agents/hooks.json`);
      const error = yield* agyHookTrust(main, work).pipe(Effect.flip);
      expect(error).toBeInstanceOf(RepoHooksUntrusted);
      expect(error.detail).toContain("it can't be read");
    }),
  ),
);

it.effect("refuses a repo guarded only by Codex hooks, naming both paths", () =>
  run(
    Effect.gen(function* () {
      const { main, work } = yield* repoWith({ main: { ".codex/hooks.json": "{}" } });
      const error = yield* agyHookTrust(main, work).pipe(Effect.flip);
      expect(error).toEqual(
        new RepoHooksUntrusted({
          detail: `${main} has Codex hooks (.codex/hooks.json) but no agy hooks (.agents/hooks.json) in ${work}; agy runs would skip the repo's guards. Add and commit .agents/hooks.json, then run foreman doctor.`,
        }),
      );
    }),
  ),
);

it.effect("does not require hooks in a repo with none", () =>
  run(
    Effect.gen(function* () {
      const { main, work } = yield* repoWith({});
      expect(yield* agyHookTrust(main, work)).toEqual({ required: false });
    }),
  ),
);
