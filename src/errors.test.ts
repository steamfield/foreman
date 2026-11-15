import { Cause, Schema } from "effect";
import { CliError } from "effect/cli";
import { expect, it } from "vitest";
import {
  ErrorEnvelope,
  errorClasses,
  errorEnvelope,
  errorTable,
  errorText,
  exitCodeFor,
  failure,
  WorktreeInvalid,
} from "./errors";

it("maps every declared tag to its stable code and safe envelope", () => {
  expect(errorClasses.map((Class) => new Class()._tag)).toEqual(Object.keys(errorTable));
  expect(errorClasses.map((Class) => exitCodeFor(new Class()))).toEqual([
    2, 3, 6, 0, 130, 1, 4, 5, 7, 8, 9, 10, 2, 11,
  ]);
  for (const Class of errorClasses) {
    const error = new Class();
    expect(Schema.decodeUnknownSync(ErrorEnvelope)(errorEnvelope(error))).toEqual({
      error: {
        tag: error._tag,
        message: errorTable[error._tag].message,
        retryable: errorTable[error._tag].retryable,
      },
    });
    expect(errorText(error)).toBe(errorTable[error._tag].message);
    expect(failure(Cause.fail(error))).toBeInstanceOf(Class);
  }
});
it("carries foreman's own detail in both renderings", () => {
  const error = new WorktreeInvalid({
    detail: "/repo is the main checkout, not a linked worktree",
  });
  expect(errorEnvelope(error).error).toMatchObject({
    tag: "WorktreeInvalid",
    detail: "/repo is the main checkout, not a linked worktree",
  });
  expect(errorText(error)).toBe(
    `${errorTable.WorktreeInvalid.message}\n/repo is the main checkout, not a linked worktree`,
  );
});
it("leads a usage error with what was wrong and a suggestion when one is close", () => {
  expect(
    errorText(
      failure(
        Cause.fail(
          new CliError.UnknownSubcommand({
            subcommand: "statu",
            parent: ["foreman"],
            suggestions: ["status"],
          }),
        ),
      ),
    ),
  ).toBe('Unknown command "statu". Did you mean "status"?\nRun --help for usage.');
  expect(
    errorText(
      failure(
        Cause.fail(
          new CliError.UnknownSubcommand({
            subcommand: "remove",
            parent: ["foreman", "skill"],
            suggestions: [],
          }),
        ),
      ),
    ),
  ).toBe('Unknown command "remove" for "foreman skill".\nRun --help for usage.');
});
it("keeps defects and interruptions distinct", () => {
  expect(failure(Cause.die(new Error("private")))._tag).toBe("Defect");
  expect(failure(Cause.interrupt())._tag).toBe("Interrupted");
});
