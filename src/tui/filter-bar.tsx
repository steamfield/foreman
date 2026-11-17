import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { FilterBarView } from "../core/monitor/model-types";
import { Line, pad, truncate } from "./components";
import { FindInput, type FindMessage } from "./find-input";
import type { Theme } from "./theme";

/** Draws the applied filter tokens or its controlled editing input. */
export function FilterBar({
  filter,
  width,
  colors,
  onFind,
  onKey,
}: {
  filter: FilterBarView;
  width: number;
  colors: Theme;
  onFind: (message: FindMessage) => void;
  onKey: (key: string) => void;
}) {
  const counts = truncate(
    `${filter.shown} of ${filter.total} runs · esc clear`,
    Math.max(0, width - 5),
  );
  const space = Math.max(1, width - stringWidth(counts) - 4);
  const tokens = filter.text
    .split(/(\s+)/)
    .map((token) =>
      /^(state|repo|model|needs):\S+/.test(token)
        ? colors.fill(colors.paint(` ${token} `), true)
        : colors.paint(token),
    )
    .join("");
  return (
    <Box width={width} height={1}>
      <Text>{colors.fill(colors.paint("/ ", "fg", true))}</Text>
      {filter.editing ? (
        <FindInput
          value={filter.text}
          width={space}
          onChange={(text) => onFind({ type: "filter-text", text })}
          onKey={onKey}
        />
      ) : (
        <Text>{colors.fill(pad(truncate(tokens, space), space))}</Text>
      )}
      <Text>{colors.fill(colors.paint(`  ${counts}`, "muted"))}</Text>
    </Box>
  );
}

/** Warns when filtering hides a run that needs a person. */
export function HiddenWaiting({
  count,
  width,
  colors,
}: {
  count: number;
  width: number;
  colors: Theme;
}) {
  if (!count) return null;
  return (
    <Line width={width} colors={colors}>
      {colors.paint(
        `■ ${count} waiting run${count === 1 ? "" : "s"} hidden by this filter · ! needs me`,
        "signal",
      )}
    </Line>
  );
}
