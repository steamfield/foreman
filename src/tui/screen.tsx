import { Box, Text } from "ink";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import type { ActMessage } from "../core/monitor/act";
import type { ViewModel } from "../core/monitor/model";
import { ActNotice, ActOverlay } from "./act";
import { Glyph, Help, Line, monitorFooter, NoteHeading, pad, Tick, truncate } from "./components";
import { DetailScreen } from "./detail";
import { monitorHeader } from "./header";
import { MonitorInput } from "./input";
import { listGroups } from "./list-row";
import { PinnedRows } from "./pinned";
import { Preview } from "./preview";
import { type Theme, theme } from "./theme";

/** Renders a monitor frame exclusively from its view model. */
export const Screen = memo(function Screen({
  model,
  colors,
  onAct = () => {},
  onKey = () => {},
}: {
  model: ViewModel;
  colors: Theme;
  onAct?: (message: ActMessage) => void;
  onKey?: (key: string) => void;
}) {
  const width = model.columns;
  const bodyColors = useMemo(
    () => (model.screen === "reconnecting" ? theme(colors.level, false, true) : colors),
    [colors, model.screen],
  );
  const header = monitorHeader(model, colors);
  const blocks: { key: string; height: number; content: React.ReactNode }[] = [];
  if (model.message.length && (model.groups.length === 0 || model.screen !== "list")) {
    for (const [index, message] of model.message.entries())
      blocks.push({
        key: `message:${index}`,
        height: 1,
        content:
          model.screen === "probing" && index === 0 ? (
            <Text>
              {colors.fill(
                " ".repeat(Math.max(0, Math.floor((width - stringWidth(message) - 2) / 2))),
              )}
              <Glyph kind="probing" tone="muted" colors={colors} />
              {colors.fill(colors.paint(` ${message}`))}
            </Text>
          ) : (
            <Line width={width} colors={colors}>
              {colors.paint(
                pad("", Math.max(0, Math.floor((width - stringWidth(message)) / 2))) + message,
                index === 1 ? "muted" : "fg",
              )}
            </Line>
          ),
      });
  }
  for (const note of model.notes) {
    blocks.push({
      key: `${note.id}:heading`,
      height: 1,
      content: (
        <NoteHeading
          title={note.title}
          width={width}
          colors={bodyColors}
          saved={model.screen === "saved"}
        />
      ),
    });
    const noteLines = [
      bodyColors.paint("│ ", "line") +
        bodyColors.paint(pad(truncate(note.text, width - 4), width - 4), "muted") +
        bodyColors.paint(" │", "line"),
      bodyColors.paint("│ ", "line") +
        bodyColors.paint(pad(truncate(note.command, width - 4), width - 4)) +
        bodyColors.paint(" │", "line"),
      bodyColors.paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, "line"),
    ];
    for (const [index, text] of noteLines.entries())
      blocks.push({
        key: `${note.id}:${index}`,
        height: 1,
        content: (
          <Line width={width} colors={bodyColors}>
            {text}
          </Line>
        ),
      });
  }
  if (model.moreNotes)
    blocks.push({
      key: "more-notes",
      height: 1,
      content: (
        <Line width={width} colors={bodyColors}>
          {bodyColors.paint(`+${model.moreNotes} more`, "signal")}
        </Line>
      ),
    });
  if (model.pinned.length)
    blocks.push({
      key: "pinned",
      height: model.pinned.length,
      content: (
        <PinnedRows
          pinned={model.pinned}
          morePinned={model.morePinned}
          width={width}
          colors={bodyColors}
        />
      ),
    });
  blocks.push(...listGroups(model, bodyColors));
  const available = Math.max(1, model.rows - 2 - Number(model.act.notice !== null));
  const preview = !model.detail && !model.overlay ? model.preview : null;
  const listHeight = Math.max(0, available - (preview ? 5 : 0));
  const offset = model.offset;
  let skipped = 0;
  const visible = blocks.flatMap((block) => {
    const before = skipped;
    skipped += block.height;
    return skipped > offset && before < offset + listHeight
      ? [{ ...block, crop: Math.max(0, offset - before) }]
      : [];
  });
  const footer = monitorFooter(model, colors);
  let body = (
    <Box
      flexDirection="column"
      height={listHeight}
      overflow="hidden"
      justifyContent={model.groups.length ? "flex-start" : "center"}
    >
      {visible.map((block) => (
        <Box key={block.key} flexDirection="column" flexShrink={0} marginTop={-block.crop}>
          {block.content}
        </Box>
      ))}
    </Box>
  );
  if (model.overlay) body = <Help model={model} colors={colors} />;
  else if (model.detail)
    body = <DetailScreen detail={model.detail} model={model} colors={colors} />;
  return (
    <Box
      width={width}
      height={model.rows}
      flexDirection="column"
      backgroundColor={colors.background}
    >
      <Line width={width} colors={colors} bar>
        {header}
      </Line>
      <Box height={available} flexDirection="column">
        {body}
        {preview && <Preview preview={preview} width={width} colors={bodyColors} />}
        {(model.act.confirm || model.act.answer || model.act.compose) && (
          <ActOverlay
            act={model.act}
            columns={width}
            height={available}
            colors={colors}
            onAct={onAct}
            onKey={onKey}
          />
        )}
      </Box>
      <ActNotice act={model.act} width={width} colors={colors} />
      <Line width={width} colors={colors} bar>
        {footer}
      </Line>
    </Box>
  );
});
/** Routes monitor keys separately from the controlled answer input. */
export function MonitorApp({
  model,
  colors,
  onKey,
  onTick,
  onAct = () => {},
}: {
  model: ViewModel;
  colors: Theme;
  onKey: (key: string) => void;
  onTick: (now: number) => void;
  onAct?: (message: ActMessage) => void;
}) {
  const [now, setNow] = useState(model.now);
  const blocked = useRef(false);
  useEffect(() => {
    if (!model.animating) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      onTick(time);
    }, 100);
    return () => clearInterval(timer);
  }, [model.animating, onTick]);
  return (
    <Tick value={now}>
      <MonitorInput model={model} onKey={onKey} blocked={blocked} />
      <Screen
        model={model}
        colors={colors}
        onKey={onKey}
        onAct={(message) => {
          if (!blocked.current) onAct(message);
        }}
      />
    </Tick>
  );
}
