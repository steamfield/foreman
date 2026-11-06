import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { installSkill } from "../core/skill";
import { SkillResult } from "../schemas/skill";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

const installCommand = Command.make(
  "install",
  {
    force: Flag.Boolean("force").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Replace a different installed SKILL.md (default: refuse)."),
    ),
    print: Flag.Boolean("print").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Print SKILL.md without looking up HOME or writing files (default: install).",
      ),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      yield* (yield* Invocation).named("skill install");
      const result = yield* installSkill(options);
      const text =
        result.action === "printed"
          ? (result.text ?? "").trimEnd()
          : `${result.action === "written" ? "Installed" : "Unchanged"}: ${result.path}`;
      yield* (yield* Output).result(Schema.encodeSync(SkillResult)(result), text);
    }),
).pipe(
  Command.withDescription(
    "Install the bundled agent entry point at $HOME/.claude/skills/foreman/SKILL.md. An identical file succeeds unchanged; a different file requires --force. Other agents can copy --print output. Independent of run state; never contacts Codex or a daemon. Exits 0 when written, unchanged or printed, 2 for usage or a conflicting target, 6 when HOME is unset or the target cannot be written (including linked install directories or files), 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Install the bundled foreman agent skill."),
  Command.withExamples([
    { command: "foreman skill install", description: "Install the skill for Claude Code" },
    {
      command: "foreman skill install --force",
      description: "Replace an inspected older or edited skill",
    },
    {
      command: "foreman skill install --print",
      description: "Print the entry point for another agent",
    },
  ]),
);

export const skillCommand = Command.make("skill").pipe(
  Command.withDescription(
    "Manage the bundled agent skill. Use skill install to install or print it; no run state is required or changed. Exits 0 for help, 2 for usage, 6 when output is refused, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Manage the bundled agent skill."),
  Command.withExamples([
    { command: "foreman skill install", description: "Install the entry point for your user" },
    { command: "foreman skill install --print", description: "Read the bundled entry point" },
  ]),
  Command.withSubcommands([installCommand]),
);
