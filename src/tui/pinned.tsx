import { Box } from "ink";
import stringWidth from "string-width";
import type { PinnedRowView } from "../core/monitor/model-types";
import { Line, truncate } from "./components";
import type { Theme } from "./theme";

function reason(text: string, colors: Theme) {
  if (colors.level > 0) return text;
  return text.replace(/^failed/, "FAILED").replace(/% (of )?budget/, "% OF BUDGET");
}

function compactPin(row: PinnedRowView, width: number, colors: Theme) {
  const text = truncate(reason(row.compactText ?? row.text, colors), Math.max(0, width - 6));
  const name = truncate(row.name, Math.max(0, width - stringWidth(text) - 3));
  return (
    colors.paint(`${row.kind === "failed" ? "×" : "▲"} `, row.tone) +
    colors.paint(name, "fg", true) +
    colors.paint(` ${text}`, row.tone)
  );
}

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
  const compactWidth = Math.floor(
    (width - 2 * Math.max(0, pinned.length - 1)) / Math.max(1, pinned.length),
  );
  return (
    <Box flexDirection="column" flexShrink={0}>
      {width < 100 ? (
        <Line width={width} colors={colors}>
          {pinned.map((row) => compactPin(row, compactWidth, colors)).join("  ")}
        </Line>
      ) : (
        pinned.map((row) => {
          const keys = row.keys
            .map(
              ({ key, label }) =>
                colors.paint(key, "fg", true) + colors.paint(` ${label}`, "muted"),
            )
            .join("  ");
          const text = `${colors.paint(` ${row.kind === "failed" ? "×" : "▲"} `, row.tone)}${colors.paint(row.name, "fg", true)} ${colors.paint(reason(row.text, colors), row.tone)}`;
          const left = truncate(
            text,
            Math.max(0, width - stringWidth(keys) - Number(keys.length > 0)),
          );
          return (
            <Line key={`${row.kind}:${row.name}`} width={width} colors={colors}>
              {left + " ".repeat(Math.max(0, width - stringWidth(left + keys))) + keys}
            </Line>
          );
        })
      )}
      {morePinned > 0 && (
        <Line width={width} colors={colors}>
          {colors.paint(`+${morePinned} more`, "muted")}
        </Line>
      )}
    </Box>
  );
}
