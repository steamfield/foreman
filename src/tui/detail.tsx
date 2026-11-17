import { Box, Text } from "ink";
import stringWidth from "string-width";
import {
  type DetailView,
  detailLayout,
  type Message,
  type PaneView,
  type ViewModel,
} from "../core/monitor/model";
import { Glyph, Line, pad, truncate } from "./components";
import { DetailPane } from "./detail-pane";
import { type Theme, theme } from "./theme";
import { Timeline } from "./timeline";

function fitPane(pane: PaneView, height: number): PaneView {
  const maximum = Math.max(0, pane.lines.length - height + 2);
  const atEnd = pane.offset === Math.max(0, pane.lines.length - pane.height + 2);
  const selected = pane.id === "files" ? pane.lines.findIndex((line) => line.selected) : -1;
  if (selected >= 0)
    return { ...pane, height, offset: Math.min(maximum, Math.max(0, selected - height + 3)) };
  return { ...pane, height, offset: atEnd ? maximum : Math.min(pane.offset, maximum) };
}

function inspectionLayout(detail: DetailView, model: ViewModel, height: number) {
  const original = detailLayout(detail, model.columns, model.rows);
  const timelineHeight = model.timeline ? 5 + Number(model.timeline.subagentCells !== null) : 0;
  const header = model.columns >= 120 || detail.focus !== "feed";
  const timeline =
    Boolean(model.timeline) &&
    height - detail.message.length - timelineHeight - (header ? original.headerHeight : 0) >= 3;
  const pinnedHeader = timeline && header;
  const available = Math.max(
    1,
    height -
      detail.message.length -
      (timeline ? timelineHeight : 0) -
      (pinnedHeader ? original.headerHeight : 0),
  );
  let position = pinnedHeader ? 0 : original.headerHeight;
  let start = 0;
  let end = 0;
  for (const pane of detail.panes) {
    if (model.columns >= 120 && pane.id === "feed") continue;
    const paneHeight = Math.min(pane.height, available);
    if (pane.id === detail.focus) {
      start = position;
      end = position + paneHeight;
    }
    position += paneHeight;
  }
  return {
    height: available,
    offset: end > available ? Math.min(start, end - available) : 0,
    timeline,
    pinnedHeader,
  };
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

/** Draws model detail panes beneath the run header and timeline. */
export function DetailScreen({
  detail,
  model,
  colors,
  onFind = () => {},
  onKey = () => {},
  height = Math.max(1, model.rows - 2),
}: {
  detail: DetailView;
  model: ViewModel;
  colors: Theme;
  onFind?: (message: Extract<Message, { type: "feed-search-text" }>) => void;
  onKey?: (key: string) => void;
  height?: number;
}) {
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
  const {
    offset,
    height: paneHeight,
    timeline,
    pinnedHeader,
  } = inspectionLayout(detail, model, height);
  const feed = detail.panes.find((pane) => pane.id === "feed");
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      {detail.message.map((message, index) => (
        <Line key={message} width={width} colors={colors}>
          {colors.paint(message, index === 1 ? "muted" : "fg")}
        </Line>
      ))}
      {pinnedHeader && (
        <Header
          detail={detail}
          width={width}
          narrow={model.layout === "narrow"}
          colors={bodyColors}
        />
      )}
      {timeline && model.timeline && (
        <Timeline timeline={model.timeline} width={width} colors={bodyColors} />
      )}
      <Box width={width} height={paneHeight} flexDirection="row" overflow="hidden">
        <Box width={leftWidth} height={paneHeight} flexDirection="column" overflow="hidden">
          <Box flexDirection="column" flexShrink={0} marginTop={-offset}>
            {!pinnedHeader && (
              <Header
                detail={detail}
                width={leftWidth}
                narrow={model.layout === "narrow"}
                colors={bodyColors}
              />
            )}
            {panes.map((pane) => (
              <DetailPane
                key={pane.id}
                pane={fitPane(
                  { ...pane, focused: pane.id === detail.focus },
                  Math.min(pane.height, paneHeight),
                )}
                width={leftWidth}
                colors={colors}
                contentColors={bodyColors}
                tabs={pane.id === "feed" ? model.feedTabs : null}
                onFind={onFind}
                onKey={onKey}
              />
            ))}
          </Box>
        </Box>
        {wide && feed ? (
          <DetailPane
            pane={fitPane({ ...feed, focused: detail.focus === "feed" }, paneHeight)}
            width={width - leftWidth}
            colors={colors}
            contentColors={bodyColors}
            tabs={model.feedTabs}
            onFind={onFind}
            onKey={onKey}
          />
        ) : null}
      </Box>
    </Box>
  );
}
