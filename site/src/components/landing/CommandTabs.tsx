// Stub: unit "commands" replaces this file.
import type { CommandDemo } from "../../data/commands";

export function CommandTabs({
  commands,
}: {
  commands: readonly CommandDemo[];
}) {
  return <div data-stub="commands">{commands.length}</div>;
}
