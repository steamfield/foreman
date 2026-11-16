import { Box, Text } from "ink";
import stringWidth from "string-width";
import {
  type DetailLine,
  type DetailView,
  detailLayout,
  type PaneView,
  type ViewModel,
} from "../core/monitor/model";
import { Glyph, Line, pad, truncate } from "./components";
import { type Theme, theme } from "./theme";

function rule(title: string, value: string, width: number, tone: "fg" | "line", colors: Theme) {
  const right = truncate(value, Math.max(0, Math.floor(width / 2)));
  // `╭─ title ───╮` alone, or `╭─ title ─── value ─╮` with a value.
  const fixed = right === "" ? 6 : 8;
  const left = truncate(title, Math.max(0, width - stringWidth(right) - fixed - 1));
  const remaining = Math.max(0, width - stringWidth(left) - stringWidth(right) - fixed);
  return (
    colors.paint("╭─ ", tone) +
    left +
    colors.paint(` ${"─".repeat(remaining)}`, tone) +
    (right === "" ? "" : ` ${colors.paint(right, "muted")} `) +
    colors.paint("─╮", tone)
  );
}
function content(line: DetailLine, width: number, colors: Theme) {
  if (line.frame === "top")
    return rule(
      colors.paint(`${line.at ?? ""} `, "muted") + colors.paint(line.text, line.tone, true),
      "",
      width,
      "line",
      colors,
    );
  if (line.frame === "bottom")
    return colors.paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, "line");
  if (line.frame === "body")
    return (
      colors.paint("│ ", "line") +
      colors.paint(pad(truncate(line.text, width - 4), width - 4), line.tone) +
      colors.paint(" │", "line")
    );
  return (
    (line.at ? colors.paint(`${line.at} `, "muted") : "") +
    (line.symbol ? colors.paint(`${line.symbol} `, line.tone) : "") +
    colors.paint(line.text, line.symbol ? "fg" : line.tone)
  );
}
function Pane({
  pane,
  width,
  colors,
  contentColors = colors,
}: {
  pane: PaneView;
  width: number;
  colors: Theme;
  contentColors?: Theme;
}) {
  const tone = pane.focused ? "fg" : "line";
  const rows = [];
  for (let position = pane.offset; position < pane.offset + pane.height - 2; position++) {
    const line = pane.lines[position];
    const inside = Math.max(0, width - 4);
    rows.push(
      <Text key={`${pane.id}:${position}`} wrap="truncate-end">
        {colors.fill(colors.paint("│ ", tone))}
        {line?.kind ? (
          <>
            <Glyph
              kind={line.kind}
              tone={line.kind === "working" ? "running" : "muted"}
              colors={contentColors}
            />
            {colors.fill(
              contentColors.paint(
                pad(truncate(` ${line.text}`, Math.max(0, inside - 1)), Math.max(0, inside - 1)),
                line.tone,
              ),
            )}
          </>
        ) : (
          colors.fill(
            pad(truncate(line ? content(line, inside, contentColors) : "", inside), inside),
          )
        )}
        {colors.fill(colors.paint(" │", tone))}
      </Text>,
    );
  }
  return (
    <Box flexDirection="column" width={width} height={pane.height} flexShrink={0}>
      <Line width={width} colors={colors}>
        {rule(colors.paint(pane.title, tone, true), pane.value, width, tone, colors)}
      </Line>
      {rows}
      <Line width={width} colors={colors}>
        {colors.paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, tone)}
      </Line>
    </Box>
  );
}
function Header({
  detail,
  width,
  narrow,
  colors,
}: {
  detail: DetailView;
  width: number;
  narrow: boolean;
  colors: Theme;
}) {
  const column = Math.max(0, Math.floor((width - 4) / (narrow ? 1 : 2)));
  const pair = ([label, value]: readonly [string, string]) =>
    colors.paint(`${label.padStart(10)} `, "muted") + colors.paint(truncate(value, column - 11));
  const lines: string[] = [];
  for (let i = 0; i < detail.header.length; i += narrow ? 1 : 2) {
    const first = detail.header[i];
    const second = narrow ? undefined : detail.header[i + 1];
    if (first) lines.push(pad(pair(first), column) + (second ? pair(second) : ""));
  }
  const stateLabel = detail.stale ? `${detail.state} · not supervised` : (detail.state ?? "");
  const title = truncate(`${stateLabel}  ${detail.name}`, width - 8);
  const badge = colors.paint(` ${stateLabel}  `, detail.tone);
  const name = colors.paint(
    truncate(detail.name, Math.max(0, width - 10 - stateLabel.length)),
    "fg",
    true,
  );
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text wrap="truncate-end">
        {colors.fill(colors.paint("╭─ ", "line"))}
        <Glyph
          kind={detail.stale ? "lost" : (detail.state ?? "probing")}
          tone={detail.tone}
          colors={colors}
        />
        {colors.fill(
          badge +
            name +
            colors.paint(` ${"─".repeat(Math.max(0, width - stringWidth(title) - 8))}─╮`, "line"),
        )}
      </Text>
      {[
        ...lines,
        ...detail.warnings.map((warning) => colors.paint(`warning: ${warning}`, "interrupted")),
      ].map((line) => (
        <Line key={line} width={width} colors={colors}>
          {colors.paint("│ ", "line") +
            pad(truncate(line, width - 4), width - 4) +
            colors.paint(" │", "line")}
        </Line>
      ))}
      <Line width={width} colors={colors}>
        {colors.paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, "line")}
      </Line>
    </Box>
  );
}

export function DetailScreen({
  detail,
  model,
  colors,
}: {
  detail: DetailView;
  model: ViewModel;
  colors: Theme;
}) {
  const height = Math.max(1, model.rows - 2);
  const width = model.columns;
  if (detail.message.length && detail.panes.length === 0)
    return (
      <Box
        height={height}
        width={width}
        justifyContent="center"
        alignItems="center"
        flexDirection="column"
      >
        {detail.message.map((message, index) => (
          <Text key={message}>
            {index === 0 && detail.status === "loading" ? (
              <Glyph kind="probing" tone="muted" colors={colors} />
            ) : null}
            {colors.paint(truncate(message, width), index === 1 ? "muted" : "fg")}
          </Text>
        ))}
      </Box>
    );
  const wide = model.layout === "wide";
  const bodyColors = detail.status === "reconnecting" ? theme(colors.level, false, true) : colors;
  const leftWidth = wide ? Math.floor(width * 0.48) : width;
  const panes = detail.panes.filter((pane) => !wide || pane.id !== "feed");
  const { offset, height: paneHeight } = detailLayout(detail, width, model.rows);
  const feed = detail.panes.find((pane) => pane.id === "feed");
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      {detail.message.map((message, index) => (
        <Line key={message} width={width} colors={colors}>
          {colors.paint(message, index === 1 ? "muted" : "fg")}
        </Line>
      ))}
      <Box width={width} height={paneHeight} flexDirection="row" overflow="hidden">
        <Box width={leftWidth} height={paneHeight} flexDirection="column" overflow="hidden">
          <Box flexDirection="column" flexShrink={0} marginTop={-offset}>
            <Header
              detail={detail}
              width={leftWidth}
              narrow={model.layout === "narrow"}
              colors={bodyColors}
            />
            {panes.map((pane) => (
              <Pane
                key={pane.id}
                pane={pane}
                width={leftWidth}
                colors={colors}
                contentColors={bodyColors}
              />
            ))}
          </Box>
        </Box>
        {wide && feed ? (
          <Pane pane={feed} width={width - leftWidth} colors={colors} contentColors={bodyColors} />
        ) : null}
      </Box>
    </Box>
  );
}
