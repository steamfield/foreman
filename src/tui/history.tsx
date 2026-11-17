import { Box } from "ink";
import stringWidth from "string-width";
import type { HistoryView } from "../core/monitor/model-types";
import { Line, pad, truncate } from "./components";
import type { Theme } from "./theme";

function widths(width: number) {
  return width >= 120 ? [22, 20, 14, 12, 10, 7, 9] : [16, 12, 12, 10, 9, 6, 8];
}
function cells(values: readonly string[], width: number) {
  const sizes = widths(width);
  return values
    .map((value, index) =>
      pad(
        truncate(
          value,
          Math.max(0, (sizes[index] ?? width - sizes.reduce((a, b) => a + b, 0)) - 1),
        ),
        sizes[index] ?? 0,
      ),
    )
    .join("");
}
function historyRow(row: HistoryView["rows"][number], width: number, colors: Theme) {
  const values = [
    row.name,
    row.repo,
    row.outcome,
    row.ended,
    row.duration,
    String(row.turns),
    row.tokens,
  ];
  const sizes = widths(width);
  const leading = values
    .map((value, index) => {
      const size = sizes[index] ?? 0;
      const text = truncate(value, size - 1);
      return colors.paint(
        index >= 4 ? `${text.padStart(size - 1)} ` : pad(text, size),
        row.tone,
        index === 0,
      );
    })
    .join("");
  const room = Math.max(0, width - sizes.reduce((a, b) => a + b, 0));
  const mark = row.archived ? " archived" : "";
  return (
    leading +
    colors.paint(truncate(row.task ?? "", Math.max(0, room - stringWidth(mark))), row.tone) +
    (row.archived ? ` ${colors.paint("archived", "muted")}` : "")
  );
}

/** Draws historical run rows or the centred loading, failure and empty states. */
export function History({
  history,
  width,
  height,
  colors,
}: {
  history: HistoryView;
  width: number;
  height: number;
  colors: Theme;
}) {
  let message: string | null = null;
  if (history.status === "loading") message = "Loading history…";
  else if (history.status === "failed") message = history.message ?? "History could not be loaded.";
  else if (history.rows.length === 0) message = history.message ?? "No history runs.";
  const notice = history.status === "ready" && history.rows.length > 0 ? history.message : null;
  return (
    <Box height={height} width={width} flexDirection="column">
      <Line width={width} colors={colors}>
        {colors.paint(
          cells(["RUN", "REPO", "OUTCOME", "ENDED", "DURATION", "TURNS", "TOKENS", "TASK"], width),
          "muted",
        )}
      </Line>
      {notice && (
        <Line width={width} colors={colors}>
          {colors.paint(notice, "muted")}
        </Line>
      )}
      {message ? (
        <Box height={Math.max(0, height - 1)} justifyContent="center" flexDirection="column">
          <Line width={width} colors={colors}>
            {colors.paint(
              " ".repeat(Math.max(0, Math.floor((width - stringWidth(message)) / 2))) + message,
              history.status === "failed" ? "failed" : "muted",
            )}
          </Line>
        </Box>
      ) : (
        history.rows
          .slice(history.offset, history.offset + Math.max(0, height - 1 - Number(notice !== null)))
          .map((row, index) => (
            <Line
              key={row.name}
              width={width}
              colors={colors}
              selected={history.offset + index === history.selected}
            >
              {historyRow(row, width, colors)}
            </Line>
          ))
      )}
    </Box>
  );
}
