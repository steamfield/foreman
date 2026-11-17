import stringWidth from "string-width";
import { Line } from "./components";
import type { Theme } from "./theme";

/** Draws a group rule and the filter's visible and hidden counts. */
export function GroupHeading({
  title,
  summary,
  shown,
  hidden,
  width,
  colors,
}: {
  title: string;
  summary: string;
  shown: number;
  hidden: number;
  width: number;
  colors: Theme;
}) {
  const start = colors.paint("── ", "line") + colors.paint(`${title} `, "fg", true);
  const label = hidden > 0 ? `${shown} shown · ${hidden} hidden by filter` : summary;
  const end = colors.paint(` ${label} `, "muted") + colors.paint("──", "line");
  return (
    <Line width={width} colors={colors}>
      {start +
        colors.paint("─".repeat(Math.max(0, width - stringWidth(start + end))), "line") +
        end}
    </Line>
  );
}
