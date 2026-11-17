import { Box } from "ink";
import stringWidth from "string-width";
import type { PinnedRowView } from "../core/monitor/model";
import { Line, truncate } from "./components";
import type { Theme } from "./theme";

/** Renders non-question attention rows and their overflow count. */
export function PinnedRows({
  pinned,
  morePinned,
  width,
  colors,
}: {
  pinned: readonly PinnedRowView[];
  morePinned: number;
  width: number;
  colors: Theme;
}) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {pinned.map((row) => {
        const keys = row.keys
          .map(
            ({ key, label }) => colors.paint(key, "fg", true) + colors.paint(` ${label}`, "muted"),
          )
          .join("  ");
        const text = colors.paint(
          ` ${row.kind === "failed" ? "×" : "▲"} ${row.name} ${row.text}`,
          row.tone,
        );
        const left = truncate(
          text,
          Math.max(0, width - stringWidth(keys) - Number(keys.length > 0)),
        );
        return (
          <Line key={`${row.kind}:${row.name}`} width={width} colors={colors}>
            {left + " ".repeat(Math.max(0, width - stringWidth(left + keys))) + keys}
          </Line>
        );
      })}
      {morePinned > 0 && (
        <Line width={width} colors={colors}>
          {colors.paint(`+${morePinned} more`, "muted")}
        </Line>
      )}
    </Box>
  );
}
