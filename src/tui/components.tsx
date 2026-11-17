import cliTruncate from "cli-truncate";
import { Text } from "ink";
import { createContext, memo, use } from "react";
import stringWidth from "string-width";
import type { Tone } from "../core/monitor/model-types";
import type { Theme } from "./theme";

/** Shares the animation timestamp with glyph cells. */
export const Tick = createContext(0);
const spinner = "⣾⣽⣻⢿⡿⣟⣯⣷";
/** Truncates terminal text to a measured cell width with an ellipsis. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return cliTruncate(text, width, { position: "end", truncationCharacter: "…" });
}
/** Pads terminal text to a measured cell width. */
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
/** Renders a state glyph using the shared animation clock. */
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
/** Renders one filled terminal line within the requested cell width. */
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

/** Formats the footer hints and connection status within the terminal width. */
export { monitorFooter } from "./footer";

/** Renders a waiting note heading and its shared-clock glyph. */
export const NoteHeading = memo(function NoteHeading({
  title,
  width,
  colors,
  saved,
}: {
  title: string;
  width: number;
  colors: Theme;
  saved: boolean;
}) {
  const heavy = colors.level === 0;
  const label = truncate(heavy ? title.replace("waiting", "WAITING") : title, width - 6);
  return (
    <Text wrap="truncate-end">
      {colors.fill(colors.paint(heavy ? "┏━ " : "╭─ ", "line"))}
      {saved ? (
        colors.fill(colors.paint("■", "signal"))
      ) : (
        <Glyph kind="waiting" tone="signal" colors={colors} />
      )}
      {colors.fill(
        colors.paint(label.slice(1), "signal") +
          colors.paint(
            ` ${(heavy ? "━" : "─").repeat(Math.max(0, width - stringWidth(label) - 5))}${heavy ? "┓" : "╮"}`,
            "line",
          ),
      )}
    </Text>
  );
});
