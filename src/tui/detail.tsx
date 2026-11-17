import { Box, Text } from "ink";
import { Fragment } from "react";
import stringWidth from "string-width";
import { type DetailView, detailLayout, type PaneView } from "../core/monitor/model";
import { Glyph, Line, pad, truncate } from "./components";
import { DetailPane } from "./detail-pane";
import { InspectFiles } from "./inspect-files";
import type { InspectMessage, InspectViewModel } from "./inspect-view";
import { type Theme, theme } from "./theme";
import { Timeline } from "./timeline";

function fitPane(pane: PaneView, height: number): PaneView {
  const maximum = Math.max(0, pane.lines.length - height + 2);
  const atEnd = pane.offset === Math.max(0, pane.lines.length - pane.height + 2);
  return { ...pane, height, offset: atEnd ? maximum : Math.min(pane.offset, maximum) };
}

function inspectionLayout(detail: DetailView, model: InspectViewModel, height: number) {
  const original = detailLayout(detail, model.columns, model.rows);
  if (!model.timeline && !model.files) return { ...original, filesHeight: 0 };
  const timelineHeight = model.timeline ? 5 + Number(model.timeline.subagentCells !== null) : 0;
  const available = Math.max(
    1,
    height - detail.message.length - timelineHeight - (model.timeline ? original.headerHeight : 0),
  );
  const filesHeight = model.files
    ? Math.min(model.files.length + 2, Math.max(3, Math.floor(available / 3)))
    : 0;
  let position = model.timeline ? 0 : original.headerHeight;
  let start = 0;
  let end = 0;
  const blocks = detail.panes
    .filter((pane) => model.columns < 120 || pane.id !== "feed")
    .flatMap((pane) => [
      { ...pane, height: Math.min(pane.height, available) },
      ...(pane.id === "task" && filesHeight
        ? [{ height: filesHeight, focused: Boolean(model.filesFocused) }]
        : []),
    ]);
  if (!detail.panes.some((pane) => pane.id === "task") && filesHeight)
    blocks.unshift({ height: filesHeight, focused: Boolean(model.filesFocused) });
  for (const block of blocks) {
    if (block.focused) {
      start = position;
      end = position + block.height;
    }
    position += block.height;
  }
  return {
    height: available,
    offset: end > available ? Math.min(start, end - available) : 0,
    filesHeight,
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

export function DetailScreen({
  detail,
  model,
  colors,
  onFind = () => {},
  onKey = () => {},
  height = Math.max(1, model.rows - 2),
}: {
  detail: DetailView;
  model: InspectViewModel;
  colors: Theme;
  onFind?: (message: InspectMessage) => void;
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
  const { offset, height: paneHeight, filesHeight } = inspectionLayout(detail, model, height);
  const feed = detail.panes.find((pane) => pane.id === "feed");
  const filePane = model.files ? (
    <InspectFiles
      files={model.files}
      width={leftWidth}
      height={filesHeight}
      offset={Math.max(0, model.files.findIndex((file) => file.selected) - filesHeight + 3)}
      colors={colors}
      focused={model.filesFocused}
    />
  ) : null;
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      {detail.message.map((message, index) => (
        <Line key={message} width={width} colors={colors}>
          {colors.paint(message, index === 1 ? "muted" : "fg")}
        </Line>
      ))}
      {model.timeline && (
        <>
          <Header
            detail={detail}
            width={width}
            narrow={model.layout === "narrow"}
            colors={bodyColors}
          />
          <Timeline timeline={model.timeline} width={width} colors={bodyColors} />
        </>
      )}
      <Box width={width} height={paneHeight} flexDirection="row" overflow="hidden">
        <Box width={leftWidth} height={paneHeight} flexDirection="column" overflow="hidden">
          <Box flexDirection="column" flexShrink={0} marginTop={-offset}>
            {!model.timeline && (
              <Header
                detail={detail}
                width={leftWidth}
                narrow={model.layout === "narrow"}
                colors={bodyColors}
              />
            )}
            {!panes.some((pane) => pane.id === "task") && filePane}
            {panes.map((pane) => (
              <Fragment key={pane.id}>
                <DetailPane
                  pane={fitPane(pane, Math.min(pane.height, paneHeight))}
                  width={leftWidth}
                  colors={colors}
                  contentColors={bodyColors}
                  tabs={pane.id === "feed" ? model.feedTabs : null}
                  onFind={onFind}
                  onKey={onKey}
                />
                {pane.id === "task" && filePane}
              </Fragment>
            ))}
          </Box>
        </Box>
        {wide && feed ? (
          <DetailPane
            pane={fitPane(feed, paneHeight)}
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
