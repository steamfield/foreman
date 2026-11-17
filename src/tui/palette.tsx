import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { PaletteView } from "../core/monitor/model";
import { FrameContent, FrameRow } from "./act-frame";
import { Line, pad, truncate } from "./components";
import { FindInput, type FindMessage } from "./find-input";
import type { Theme } from "./theme";

function itemText(item: PaletteView["items"][number], width: number, colors: Theme) {
  if (item.heading) return colors.paint(pad(truncate(`   ${item.label}`, width), width), "muted");
  const key = item.key ? colors.paint(item.key, "fg", true) : "";
  const room = Math.max(0, width - stringWidth(key) - 5);
  const label = truncate(item.label, room);
  const detail = truncate(item.detail, Math.max(0, room - stringWidth(label) - 2));
  const text = `${item.selected ? " ▸ " : "   "}${colors.paint(label)}${detail ? colors.paint(`  ${detail}`, "muted") : ""}`;
  return `${pad(text, width - stringWidth(key) - 1)}${key} `;
}

/** Frames the command palette over the monitor without exposing underlying rows. */
export function Palette({
  palette,
  columns,
  height,
  colors,
  onFind,
  onKey,
}: {
  palette: PaletteView;
  columns: number;
  height: number;
  colors: Theme;
  onFind: (message: FindMessage) => void;
  onKey: (key: string) => void;
}) {
  const width = Math.min(72, columns - 4);
  const capacity = Math.max(0, height - 4);
  const selected = palette.items.findIndex((item) => item.selected);
  const start = Math.max(0, selected - capacity + 1);
  const items = palette.items.slice(start, start + capacity);
  const title =
    colors.paint("Commands", "fg", true) +
    colors.paint(palette.subject ? ` · ${palette.subject} selected` : "", "muted");
  const heading =
    colors.paint("╭─ ") +
    truncate(title, width - 6) +
    colors.paint(` ${"─".repeat(Math.max(0, width - stringWidth(title) - 6))}─╮`);
  return (
    <Box
      position="absolute"
      width={columns}
      height={height}
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
    >
      <Box width={width} flexDirection="column" flexShrink={0}>
        <Line width={width} colors={colors}>
          {heading}
        </Line>
        <FrameRow width={width} colors={colors}>
          <Box width={width - 2} paddingX={1} backgroundColor={colors.background}>
            <Text>{colors.paint(": ", "fg", true)}</Text>
            <FindInput
              value={palette.query}
              width={width - 6}
              onChange={(text) => onFind({ type: "palette-query", text })}
              onKey={onKey}
            />
          </Box>
        </FrameRow>
        <FrameRow width={width} colors={colors}>
          <FrameContent width={width} colors={colors}>
            <Text>{colors.paint("─".repeat(width - 4), "line")}</Text>
          </FrameContent>
        </FrameRow>
        {items.map((item) => (
          <FrameRow key={item.label} width={width} colors={colors}>
            <FrameContent width={width} colors={colors}>
              <Line width={width - 4} colors={colors} selected={item.selected}>
                {itemText(item, width - 4, colors)}
              </Line>
            </FrameContent>
          </FrameRow>
        ))}
        <Line width={width} colors={colors}>
          {colors.paint(`╰${"─".repeat(width - 2)}╯`)}
        </Line>
      </Box>
    </Box>
  );
}
