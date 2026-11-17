import { Box } from "ink";
import stringWidth from "string-width";
import type { PreviewView } from "../core/monitor/model";
import { Line, pad, truncate } from "./components";
import type { Theme } from "./theme";

/** Renders the selected run's task, activity and file summary in a five-line frame. */
export function Preview({
  preview,
  width,
  colors,
}: {
  preview: PreviewView;
  width: number;
  colors: Theme;
}) {
  const line = (label: string, text: string) =>
    colors.paint("│ ", "line") +
    pad(colors.paint(`${label.padEnd(7)}`, "muted") + truncate(text, width - 11), width - 4) +
    colors.paint(" │", "line");
  const title =
    colors.paint(truncate(preview.name, width - 26), "fg", true) +
    colors.paint(" · preview", "muted");
  const open = colors.paint("⏎", "fg", true) + colors.paint(" open", "muted");
  const heading =
    colors.paint("╭─ ", "line") +
    title +
    colors.paint(` ${"─".repeat(Math.max(0, width - stringWidth(title + open) - 8))} `, "line") +
    open +
    colors.paint(" ─╮", "line");
  const nowWidth = Math.max(0, Math.floor((width - 18) / 3));
  const activity =
    pad(truncate(preview.now ?? "·", nowWidth), nowWidth + 2) +
    colors.paint("Said   ", "muted") +
    colors.paint(preview.said ?? "·", "muted");
  const outside = preview.outsideCount === null ? "" : `${preview.outsideCount} outside scope`;
  const files = preview.files
    .map(
      ({ path, outside }) =>
        (outside ? colors.paint("▲ ", "interrupted") : "") + colors.paint(path),
    )
    .join("    ");
  const more = preview.moreFiles ? colors.paint(`    ${preview.moreFiles} more`, "muted") : "";
  const fileWidth = Math.max(
    0,
    width - 11 - stringWidth(outside + more) - Number(outside.length > 0) * 2,
  );
  const fileLine =
    pad(truncate(files, fileWidth), fileWidth) +
    more +
    colors.paint(outside ? `  ${outside}` : "", preview.outsideCount ? "interrupted" : "muted");
  return (
    <Box flexDirection="column" height={5} flexShrink={0}>
      <Line width={width} colors={colors}>
        {heading}
      </Line>
      <Line width={width} colors={colors}>
        {line("Task", preview.task ?? "·")}
      </Line>
      <Line width={width} colors={colors}>
        {line("Now", activity)}
      </Line>
      <Line width={width} colors={colors}>
        {line("Files", fileLine)}
      </Line>
      <Line width={width} colors={colors}>
        {colors.paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, "line")}
      </Line>
    </Box>
  );
}
