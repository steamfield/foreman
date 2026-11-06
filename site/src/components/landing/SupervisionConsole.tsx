// Stub: unit "console" replaces this file.
import type { ConsoleScript } from "../../data/supervision";

export function SupervisionConsole({ script }: { script: ConsoleScript }) {
  return <div data-stub="console">{script.name}</div>;
}
