import { Box } from "ink";
import type { ReactNode } from "react";
import stringWidth from "string-width";
import { Line, pad, truncate } from "./components";
import type { Theme } from "./theme";

/** Frames a fixed-height inspection pane with clipped terminal rows. */
export function InspectFrame({
  title,
  width,
  height,
  focused = false,
  colors,
  children,
}: {
  title: string;
  width: number;
  height: number;
  focused?: boolean;
  colors: Theme;
  children: ReactNode;
}) {
  const tone = focused ? "fg" : "line";
  const label = truncate(title, Math.max(0, width - 6));
  return (
    <Box width={width} height={height} flexShrink={0} flexDirection="column" overflow="hidden">
      <Line width={width} colors={colors}>
        {colors.paint("╭─ ", tone) +
          colors.paint(label, "fg", true) +
          colors.paint(`${"─".repeat(Math.max(0, width - stringWidth(label) - 5))}─╮`, tone)}
      </Line>
      <Box width={width} height={Math.max(0, height - 2)} flexDirection="column" overflow="hidden">
        {children}
      </Box>
      <Line width={width} colors={colors}>
        {colors.paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, tone)}
      </Line>
    </Box>
  );
}

/** Draws one framed row with optional selection fill inside the borders. */
export function InspectRow({
  text,
  width,
  colors,
  selected = false,
  focused = false,
}: {
  text: string;
  width: number;
  colors: Theme;
  selected?: boolean;
  focused?: boolean;
}) {
  const tone = focused ? "fg" : "line";
  const inside = pad(truncate(text, Math.max(0, width - 4)), Math.max(0, width - 4));
  return (
    <Box height={1} flexShrink={0}>
      <Line width={width} colors={colors}>
        {colors.paint("│ ", tone) +
          (selected ? colors.select(inside) : inside) +
          colors.paint(" │", tone)}
      </Line>
    </Box>
  );
}
