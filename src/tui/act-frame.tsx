import { Box, type DOMElement, Text, Transform } from "ink";
import type { ReactNode, RefObject } from "react";
import stringWidth from "string-width";
import { Line, pad, truncate } from "./components";
import { type Theme, tokens } from "./theme";

/** Frames content while preserving its intrinsic height for viewport measurement. */
export function FrameRow({
  children,
  width,
  colors,
  height,
  maxHeight,
  contentRef,
}: {
  children: ReactNode;
  width: number;
  colors: Theme;
  height?: number;
  maxHeight?: number;
  contentRef?: RefObject<DOMElement | null>;
}) {
  return (
    <Box
      flexShrink={0}
      width={width}
      height={height}
      maxHeight={maxHeight}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderColor={colors.level >= 2 ? tokens["console-fg"] : undefined}
      flexDirection="column"
      overflowY="hidden"
    >
      <Box ref={contentRef} width={width - 4} flexShrink={0} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

/** Fills every interior cell after Ink wraps the text, covering the underlying list. */
export function FrameContent({
  children,
  width,
  colors,
}: {
  children: ReactNode;
  width: number;
  colors: Theme;
}) {
  return (
    <Transform transform={(line) => colors.fill(` ${pad(line, width - 4)} `)}>{children}</Transform>
  );
}

/** Draws one truncated text row inside the overlay frame. */
export function FramedText({
  text,
  width,
  colors,
  muted = false,
}: {
  text: string;
  width: number;
  colors: Theme;
  muted?: boolean;
}) {
  return (
    <FrameRow width={width} colors={colors}>
      <FrameContent width={width} colors={colors}>
        <Line width={width - 4} colors={colors}>
          {colors.paint(text, muted ? "muted" : "fg")}
        </Line>
      </FrameContent>
    </FrameRow>
  );
}

/** Wraps text within the overlay's side borders. */
export function FramedParagraph({
  text,
  width,
  colors,
  muted = false,
}: {
  text: string;
  width: number;
  colors: Theme;
  muted?: boolean;
}) {
  return (
    <FrameRow width={width} colors={colors}>
      <FrameContent width={width} colors={colors}>
        <Text>{colors.paint(text, muted ? "muted" : "fg")}</Text>
      </FrameContent>
    </FrameRow>
  );
}

/** Fits the overlay title and metadata between both frame corners. */
export function frameHeading(
  title: string,
  meta: string,
  width: number,
  colors: Theme,
  attention = true,
) {
  const label = truncate(title, width - 7);
  const tail = truncate(meta, Math.max(0, width - stringWidth(label) - 8));
  const gap = Math.max(0, width - stringWidth(label + tail) - 7);
  return (
    colors.paint("╭─ ", "fg") +
    colors.paint(label, attention && title.startsWith("■") ? "signal" : "fg", true) +
    colors.paint(` ${"─".repeat(gap)}${tail ? ` ${tail}` : " "}─╮`, "fg")
  );
}
