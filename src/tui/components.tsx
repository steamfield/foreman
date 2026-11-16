import cliTruncate from "cli-truncate";
import { Text } from "ink";
import { createContext, use } from "react";
import stringWidth from "string-width";
import type { Tone } from "../core/monitor/model";
import type { Theme } from "./theme";

export const Tick = createContext(0);
const spinner = "⣾⣽⣻⢿⡿⣟⣯⣷";
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return cliTruncate(text, width, { position: "end", truncationCharacter: "…" });
}
export const pad = (text: string, width: number) =>
  text + " ".repeat(Math.max(0, width - stringWidth(text)));
function glyph(kind: string, now: number) {
  if (kind === "running") return spinner[Math.floor(now / 100) % 8] ?? "⣾";
  if (kind === "starting" || kind === "probing") return "◐◓◑◒"[Math.floor(now / 150) % 4] ?? "◐";
  if (kind === "waiting") return Math.floor(now / 800) % 2 === 0 ? "■" : "□";
  if (kind === "working") return Math.floor(now / 400) % 2 === 0 ? "⠿" : "⠶";
  if (kind === "idle") return "✓";
  if (kind === "failed") return "×";
  if (kind === "unknown") return "◐";
  if (kind === "lost") return "◌";
  return kind === "subagent-idle" ? "·" : "■";
}
export function Glyph({
  kind,
  tone,
  colors,
  selected = false,
}: {
  kind: string;
  tone: Tone;
  colors: Theme;
  selected?: boolean;
}) {
  const text = colors.paint(glyph(kind, use(Tick)), tone);
  return <Text>{selected ? colors.select(text) : colors.fill(text)}</Text>;
}
export function Line({
  children,
  width,
  colors,
  selected = false,
  bar = false,
}: {
  children: string;
  width: number;
  colors: Theme;
  selected?: boolean;
  bar?: boolean;
}) {
  const text = pad(truncate(children, width), width);
  return <Text wrap="truncate-end">{selected ? colors.select(text) : colors.fill(text, bar)}</Text>;
}
