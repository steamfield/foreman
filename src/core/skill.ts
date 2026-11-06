import { Effect, FileSystem, Path } from "effect";
import { AppConfig } from "../config";
import { PermissionDenied, Usage } from "../errors";
import { skillText } from "../guide/skill";
import type { SkillResult } from "../schemas/skill";

export const installSkill = Effect.fn("skill.install")(function* (options: {
  print: boolean;
  force: boolean;
}) {
  if (options.print)
    return {
      name: "foreman",
      path: null,
      action: "printed",
      text: skillText,
    } satisfies typeof SkillResult.Type;

  const home = (yield* AppConfig).userHome;
  if (home === null)
    return yield* new PermissionDenied({
      detail:
        "HOME is unset. Set HOME to your user directory or use foreman skill install --print.",
    });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(home, ".claude", "skills", "foreman", "SKILL.md");
  return yield* Effect.gen(function* () {
    // Resolve HOME itself, but refuse links inside the install target rather than writing elsewhere.
    yield* fs.makeDirectory(home, { recursive: true });
    let directory = yield* fs.realPath(home);
    for (const part of [".claude", "skills", "foreman"]) {
      directory = path.join(directory, part);
      const info = yield* fs
        .lstat(directory)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
      if (info !== null && info.type !== "Directory")
        return yield* new PermissionDenied({
          detail: `Install directory is not a directory or is a symbolic link: ${directory}. Choose a regular target or use --print.`,
        });
      if (info === null) yield* fs.makeDirectory(directory);
    }
    const file = path.join(directory, "SKILL.md");
    const info = yield* fs
      .lstat(file)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    if (info?.type === "SymbolicLink")
      return yield* new PermissionDenied({
        detail: `Install target is a symbolic link: ${target}. Choose a regular target or use --print; --force does not write through links.`,
      });
    if (info !== null && info.type !== "File")
      return yield* new Usage({
        detail: `Install target is not a regular file: ${target}. Move it aside or use --print; --force only replaces regular files.`,
      });
    if (info !== null) {
      const current = yield* fs.readFileString(file);
      if (current === skillText)
        return {
          name: "foreman",
          path: target,
          action: "unchanged",
        } satisfies typeof SkillResult.Type;
      if (!options.force)
        return yield* new Usage({
          detail: `A different skill already exists at ${target}. Inspect it, then use foreman skill install --force to replace it.`,
        });
    }
    yield* fs.writeFileString(file, skillText, { flag: info === null ? "wx" : "w" });
    return { name: "foreman", path: target, action: "written" } satisfies typeof SkillResult.Type;
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new PermissionDenied({
          detail: `Cannot install ${target} (${error.reason._tag}). Check the target and its directory permissions, or use --print.`,
        }),
      ),
    ),
  );
});
