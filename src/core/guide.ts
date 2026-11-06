import { Effect } from "effect";
import { Usage } from "../errors";
import { guideTopics } from "../guide/topics";
import type { GuideResult } from "../schemas/guide";

export const mentionedCommands = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(/\bforeman (?!command\b)([a-z][a-z-]*)(?: (install|stop)\b)?/g)].map(
      ([, command, child]) => `foreman ${command}${child ? ` ${child}` : ""}`,
    ),
  ),
];

export const guide = Effect.fn("guide")(function* (parts: readonly string[]) {
  const topic = parts.length === 0 ? "core" : parts.join(" ");
  const entry = Object.entries(guideTopics).find(([name]) => name === topic);
  if (!entry)
    return yield* new Usage({
      detail: `Unknown guide topic. Topics: ${Object.keys(guideTopics).join(", ")}. Run foreman guide.`,
    });
  const text = entry[1].trimEnd();
  return {
    topic,
    text,
    topics: Object.keys(guideTopics),
    commands: mentionedCommands(text),
  } satisfies typeof GuideResult.Type;
});
