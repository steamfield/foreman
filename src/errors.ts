import { Cause, Schema } from "effect";
import { CliError } from "effect/cli";

export class Usage extends Schema.TaggedError<Usage>()("Usage", {}) {}
export class InvalidConfig extends Schema.TaggedError<InvalidConfig>()("InvalidConfig", {}) {}
export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()(
  "PermissionDenied",
  {},
) {}
export class BrokenPipe extends Schema.TaggedError<BrokenPipe>()("BrokenPipe", {}) {}
export class Interrupted extends Schema.TaggedError<Interrupted>()("Interrupted", {}) {}
export class Defect extends Schema.TaggedError<Defect>()("Defect", {}) {}

// `detail` is text forman writes (which check failed, which run), never text from Codex.
const detail = { detail: Schema.optional(Schema.String) };
export class DaemonUnavailable extends Schema.TaggedError<DaemonUnavailable>()(
  "DaemonUnavailable",
  detail,
) {}
export class CodexUnavailable extends Schema.TaggedError<CodexUnavailable>()(
  "CodexUnavailable",
  detail,
) {}
export class RunNotFound extends Schema.TaggedError<RunNotFound>()("RunNotFound", detail) {}
export class RunConflict extends Schema.TaggedError<RunConflict>()("RunConflict", detail) {}
export class WorktreeInvalid extends Schema.TaggedError<WorktreeInvalid>()(
  "WorktreeInvalid",
  detail,
) {}
export class RepoHooksUntrusted extends Schema.TaggedError<RepoHooksUntrusted>()(
  "RepoHooksUntrusted",
  detail,
) {}

export const errorClasses = [
  Usage,
  InvalidConfig,
  PermissionDenied,
  BrokenPipe,
  Interrupted,
  Defect,
  DaemonUnavailable,
  CodexUnavailable,
  RunNotFound,
  RunConflict,
  WorktreeInvalid,
  RepoHooksUntrusted,
] as const;
export type AppError = InstanceType<(typeof errorClasses)[number]>;
export const errorTable = {
  Usage: { code: 2, message: "Invalid command. Run --help for usage.", retryable: false },
  InvalidConfig: {
    code: 3,
    message: "Invalid configuration. Check config.json and environment settings.",
    retryable: false,
  },
  PermissionDenied: {
    code: 6,
    message: "Permission denied. Check file permissions.",
    retryable: false,
  },
  BrokenPipe: { code: 0, message: "Output pipe closed.", retryable: false },
  Interrupted: { code: 130, message: "Interrupted.", retryable: false },
  Defect: { code: 1, message: "Internal error.", retryable: false },
  DaemonUnavailable: {
    code: 4,
    message: "The forman daemon could not be reached or started.",
    retryable: true,
  },
  CodexUnavailable: {
    code: 5,
    message: "Codex is unavailable or not the version forman was built for.",
    retryable: true,
  },
  RunNotFound: { code: 7, message: "No such run or question.", retryable: false },
  RunConflict: {
    code: 8,
    message: "The run is not in a state that allows this.",
    retryable: false,
  },
  WorktreeInvalid: {
    code: 9,
    message: "The worktree can't be used for a run.",
    retryable: false,
  },
  RepoHooksUntrusted: {
    code: 10,
    message:
      "Codex has not confirmed the repo's hooks are trusted. Open Codex in the main checkout, trust the project if asked, approve its hooks in /hooks, then run forman doctor.",
    retryable: false,
  },
} as const satisfies Record<
  AppError["_tag"],
  { code: number; message: string; retryable: boolean }
>;
export const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    tag: Schema.Literals(errorClasses.map((Class) => new Class()._tag)),
    message: Schema.String,
    detail: Schema.optionalKey(Schema.String),
    retryable: Schema.Boolean,
  }),
});
export const exitCodeFor = (error: AppError) => errorTable[error._tag].code;
export const retryableFor = (error: AppError) => errorTable[error._tag].retryable;
export const detailFor = (error: AppError): string | undefined =>
  "detail" in error ? error.detail : undefined;
export const errorEnvelope = (error: AppError): typeof ErrorEnvelope.Type => {
  const detail = detailFor(error);
  return {
    error: {
      tag: error._tag,
      message: errorTable[error._tag].message,
      ...(detail === undefined ? {} : { detail }),
      retryable: retryableFor(error),
    },
  };
};
// The human rendering: the safe message, then the detail on its own line when there is one.
export const errorText = (error: AppError): string => {
  const detail = detailFor(error);
  return detail === undefined
    ? errorTable[error._tag].message
    : `${errorTable[error._tag].message}\n${detail}`;
};

export function failure(cause: Cause.Cause<unknown>): AppError {
  if (Cause.hasInterruptsOnly(cause)) return new Interrupted();
  if (cause.reasons.some(Cause.isDieReason)) return new Defect();
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    for (const ErrorClass of errorClasses)
      if (reason.error instanceof ErrorClass) return reason.error;
    if (CliError.isCliError(reason.error)) return new Usage();
  }
  return new Defect();
}
