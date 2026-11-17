import { detailFor, errorClasses, errorTable } from "../errors";

/** Formats an inspection failure using its detail or safe application message. */
export function inspectError(error: unknown): string {
  for (const ErrorClass of errorClasses) {
    if (error instanceof ErrorClass) return detailFor(error) ?? errorTable[error._tag].message;
  }
  return error instanceof Error ? error.message : "Inspection failed.";
}
