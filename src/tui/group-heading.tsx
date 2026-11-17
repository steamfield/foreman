import stringWidth from "string-width";
import { Line } from "./components";
import type { Theme } from "./theme";

/** Draws a group rule with its state summary, which carries filter counts when rows are hidden. */
export function GroupHeading({
  title,
  summary,
  width,
  colors,
}: {
  title: string;
  summary: string;
  width: number;
  colors: Theme;
}) {
  const start = colors.paint("── ", "line") + colors.paint(`${title} `, "fg", true);
  const end = colors.paint(` ${summary} `, "muted") + colors.paint("──", "line");
  return (
    <Line width={width} colors={colors}>
      {start +
        colors.paint("─".repeat(Math.max(0, width - stringWidth(start + end))), "line") +
        end}
    </Line>
  );
}
