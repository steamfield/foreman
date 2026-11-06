// Stub: unit "console" replaces this file. Interface: buildConsoleScript(run) -> ConsoleScript.
import type { Run } from "./runs";

export interface ConsoleScript {
  name: string;
}

export function buildConsoleScript(run: Run): ConsoleScript {
  return { name: run.name };
}
