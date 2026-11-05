import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { checkHookTrust } from "../src/core/preflight/hooks";

const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const main = path.join(root, 'repo.with"quote');
  const home = path.join(root, "codex");
  yield* fs.makeDirectory(path.join(main, ".codex"), { recursive: true });
  yield* fs.makeDirectory(home);
  const hooksFile = path.join(main, ".codex", "hooks.json");
  const configFile = path.join(home, "config.toml");
  const project = `[projects.${JSON.stringify(main)}]\ntrust_level = "trusted"\n`;
  const keys = ["pre_tool_use:0:0", "pre_tool_use:0:1", "pre_tool_use:1:0", "session_start:0:0"];
  const trust = (file = hooksFile, entries = keys) =>
    entries
      .map(
        (key) =>
          `[hooks.state.${JSON.stringify(`${file}:${key}`)}]\ntrusted_hash = "sha256:fixture"\n`,
      )
      .join("\n");
  const hook = { type: "command", command: "echo fixture" };
  const hooks = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [hook, hook] }, { hooks: [hook] }],
      SessionStart: [{ hooks: [hook] }],
    },
  };
  yield* fs.writeFileString(hooksFile, JSON.stringify(hooks));
  return { fs, path, root, main, home, hooksFile, configFile, project, trust, keys };
});

it.effect("passes without a hooks file even if no Codex config exists", () =>
  Effect.gen(function* () {
    const { fs, main, home, hooksFile } = yield* setup();
    yield* fs.remove(hooksFile);
    expect(yield* checkHookTrust(main, home)).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("matches every event, matcher and hook index in a trusted project", () =>
  Effect.gen(function* () {
    const { fs, main, home, configFile, project, trust } = yield* setup();
    yield* fs.writeFileString(
      configFile,
      `model = "other" # comment\nnotify = ["echo", "fixture",]\n[plugins."fixture@local"]\nenabled = true\n[features]\nenabled = true\n${project}\n${trust()}`,
    );
    expect(yield* checkHookTrust(main, home)).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("accepts empty parent tables written by Codex before individual trust entries", () =>
  Effect.gen(function* () {
    const { fs, main, home, configFile, project, trust } = yield* setup();
    yield* fs.writeFileString(
      configFile,
      `[projects]\n${project}\n[hooks]\n[hooks.state]\n${trust()}`,
    );
    expect(yield* checkHookTrust(main, home)).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses missing or explicitly untrusted projects", () =>
  Effect.gen(function* () {
    const { fs, main, home, configFile, project, trust } = yield* setup();
    for (const entry of ["", project.replace('"trusted"', '"untrusted"')]) {
      yield* fs.writeFileString(configFile, entry + trust());
      const error = yield* Effect.flip(checkHookTrust(main, home));
      expect(error).toMatchObject({ _tag: "RepoHooksUntrusted" });
      expect(error.detail).toBe(`Project not trusted: ${main}`);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("names missing hook hashes, including the second hook in a group", () =>
  Effect.gen(function* () {
    const { fs, main, home, hooksFile, configFile, project, trust, keys } = yield* setup();
    yield* fs.writeFileString(
      configFile,
      project +
        trust(
          hooksFile,
          keys.filter((key) => key !== "pre_tool_use:0:1"),
        ),
    );
    expect((yield* Effect.flip(checkHookTrust(main, home))).detail).toBe(
      `Hook keys lack a trusted_hash: ${hooksFile}:pre_tool_use:0:1`,
    );
    yield* fs.writeFileString(configFile, (project + trust()).replaceAll('"sha256:fixture"', '""'));
    expect((yield* Effect.flip(checkHookTrust(main, home))).detail).toContain(
      "lack a trusted_hash",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("resolves both the project and hooks file symlinks before looking up trust", () =>
  Effect.gen(function* () {
    const { fs, path, root, main, home, hooksFile, configFile, project, trust } = yield* setup();
    const target = path.join(root, "shared-hooks.json");
    yield* fs.rename(hooksFile, target);
    yield* fs.symlink(target, hooksFile);
    const alias = path.join(root, "alias");
    yield* fs.symlink(main, alias);
    yield* fs.writeFileString(configFile, project + trust(target));
    expect(yield* checkHookTrust(alias, home)).toBeUndefined();
    yield* fs.writeFileString(configFile, project + trust());
    expect((yield* Effect.flip(checkHookTrust(main, home))).detail).toContain(
      `${target}:pre_tool_use:0:0`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails closed on missing, unreadable, malformed or ambiguous config", () =>
  Effect.gen(function* () {
    const { fs, main, home, configFile, project, trust } = yield* setup();
    expect((yield* Effect.flip(checkHookTrust(main, home))).detail).toContain(
      "Could not read config.toml",
    );
    const valid = project + trust();
    for (const text of [
      "not toml",
      `${valid}\n[broken`,
      project.replace('"trusted"', '"trusted'),
      `${valid}\n${project}`,
      `${valid}\ntrusted_hash = "duplicate"`,
      `${valid}\nvalue = """\n${project}\n"""`,
      valid.replace('trust_level = "trusted"', "trust_level = true"),
    ]) {
      yield* fs.writeFileString(configFile, text);
      expect((yield* Effect.flip(checkHookTrust(main, home))).detail).toContain(
        "Could not read trust entries",
      );
    }
    yield* fs.remove(configFile);
    yield* fs.makeDirectory(configFile);
    expect((yield* Effect.flip(checkHookTrust(main, home))).detail).toContain(
      "Could not read config.toml",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails closed on malformed hooks or a dangling hooks symlink", () =>
  Effect.gen(function* () {
    const { fs, path, root, main, home, hooksFile } = yield* setup();
    for (const text of ["{", "{}", '{"hooks":{"PreToolUse":[{}]}}']) {
      yield* fs.writeFileString(hooksFile, text);
      expect((yield* Effect.flip(checkHookTrust(main, home))).detail).toContain(
        "Could not read or decode hooks file",
      );
    }
    yield* fs.remove(hooksFile);
    yield* fs.symlink(path.join(root, "absent"), hooksFile);
    expect((yield* Effect.flip(checkHookTrust(main, home))).detail).toContain(
      "Could not resolve hooks file",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects malformed event names rather than dropping their untrusted hooks", () =>
  Effect.gen(function* () {
    const { fs, main, home, hooksFile, configFile, project } = yield* setup();
    yield* fs.writeFileString(configFile, project);
    yield* fs.writeFileString(
      hooksFile,
      JSON.stringify({
        hooks: { pre_tool_use: [{ hooks: [{ type: "command", command: "echo guarded" }] }] },
      }),
    );
    expect((yield* Effect.flip(checkHookTrust(main, home))).detail).toContain(
      "Could not read or decode hooks file",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([String.raw`model = "\q"`, "value = [garbage]"])(
  "rejects malformed unrelated settings even when all trust entries are present: %s",
  (setting) =>
    Effect.gen(function* () {
      const { fs, main, home, configFile, project, trust } = yield* setup();
      yield* fs.writeFileString(configFile, `${setting}\n${project}\n${trust()}`);
      expect((yield* Effect.flip(checkHookTrust(main, home))).detail).toContain(
        "Could not read trust entries",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
