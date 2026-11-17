import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { DetailLine, PaneView, ViewModel } from "../core/monitor/model";
import { Glyph, Line, pad, truncate } from "./components";
import { FindInput } from "./find-input";
import type { InspectMessage } from "./inspect-view";
import type { Theme } from "./theme";

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
/** Draws a detail pane with optional feed tabs and controlled search. */
export function DetailPane({
  pane,
  width,
  colors,
  contentColors = colors,
  tabs = null,
  onFind = () => {},
  onKey = () => {},
}: {
  pane: PaneView;
  width: number;
  colors: Theme;
  contentColors?: Theme;
  tabs?: ViewModel["feedTabs"];
  onFind?: (message: InspectMessage) => void;
  onKey?: (key: string) => void;
}) {
  const tone = pane.focused ? "fg" : "line";
  const rows = [];
  for (
    let position = pane.offset;
    position < pane.offset + pane.height - 2 - Number(Boolean(tabs?.editing));
    position++
  ) {
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
        {rule(
          colors.paint(pane.title, tone, true) +
            (tabs
              ? "  " +
                (
                  [
                    ["all", "all"],
                    ["commands", "cmds"],
                    ["files", "files"],
                    ["messages", "msgs"],
                    ["questions", "q&a"],
                  ] as const
                )
                  .map(([filter, label]) =>
                    filter === tabs.filter
                      ? colors.select(colors.paint(` ${label} `, "fg", true))
                      : colors.paint(` ${label} `, "muted"),
                  )
                  .join(" ")
              : ""),
          pane.value,
          width,
          tone,
          colors,
        )}
      </Line>
      {tabs?.editing && (
        <Box height={1} width={width}>
          <Text>{colors.paint("│ / search feed ", "muted")}</Text>
          <FindInput
            value={tabs.search}
            width={Math.max(1, width - 18)}
            onChange={(text) => onFind({ type: "feed-search-text", text })}
            onKey={onKey}
          />
          <Text>{colors.paint(" │", tone)}</Text>
        </Box>
      )}
      {rows}
      <Line width={width} colors={colors}>
        {colors.paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, tone)}
      </Line>
    </Box>
  );
}
