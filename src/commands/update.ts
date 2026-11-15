import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { update } from "../core/update";
import { UpdateResult } from "../schemas/update";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

function summary(result: typeof UpdateResult.Type): string {
  switch (result.action) {
    case "current":
      return `foreman ${result.current} is the latest version.`;
    case "available":
      return `foreman ${result.latest} is available (installed: ${result.current}).\nRun foreman update to install it.`;
    case "updated":
      return [
        `Updated foreman ${result.current} -> ${result.latest} (${result.command}).`,
        "An idle daemon switches to the new build on the next run command; a busy one finishes its runs first.",
        "If you installed the agent skill, refresh it with foreman skill install --force.",
      ].join("\n");
    case "manual": {
      const available = `foreman ${result.latest} is available (installed: ${result.current})`;
      if (result.method === "project")
        return `${available}. This foreman is a project dependency; update it with that project's package manager.`;
      if (result.method === "npx")
        return `${available}. Run npx @steamfield/foreman@latest to use it.`;
      return `${available}, but this foreman was not installed from npm, so it can't update itself.\nInstall the npm package with npm install --global @steamfield/foreman and remove this copy, or rebuild from source (README: Upgrade).`;
    }
  }
}

export const updateCommand = Command.make(
  "update",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Report whether a newer version exists without installing it."),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      yield* (yield* Invocation).named("update");
      const result = yield* update(options);
      yield* (yield* Output).result(Schema.encodeSync(UpdateResult)(result), summary(result));
    }),
).pipe(
  Command.withDescription(
    "Update foreman to the latest npm release with the package manager that installed it (npm, bun or pnpm global installs). Checks the registry through npm. Project dependencies, npx and source builds are reported with what to do instead. Never touches run state; an idle daemon switches to the new build on the next run command. Exits 0 when updated, current or reported, 2 for usage, 11 when the registry check or install fails, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Update foreman to the latest release."),
  Command.withExamples([
    { command: "foreman update", description: "Install the latest release" },
    { command: "foreman update --check", description: "Only report whether one is available" },
  ]),
);
