import { Box } from "ink";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ActMessage } from "../core/monitor/act";
import type { Message, ViewModel } from "../core/monitor/model";
import { ActNotice, ActOverlay } from "./act";
import { Line, monitorFooter, Tick } from "./components";
import { DetailScreen } from "./detail";
import { DiffPane } from "./diff";
import { FilterBar, HiddenWaiting } from "./filter-bar";
import type { FindMessage } from "./find-input";
import { monitorHeader } from "./header";
import { Help } from "./help";
import { History } from "./history";
import { MonitorInput } from "./input";
import { listGroups } from "./list-row";
import { messageBlocks } from "./messages";
import { QuestionNote } from "./notes";
import { Palette } from "./palette";
import { PinnedRows } from "./pinned";
import { Preview } from "./preview";
import { ReviewScreen } from "./review";
import { type Theme, theme } from "./theme";

/** Renders a monitor frame exclusively from its view model. */
export const Screen = memo(function Screen({
  model,
  colors,
  onAct = () => {},
  onKey = () => {},
  onFind = () => {},
  onInspect = () => {},
}: {
  model: ViewModel;
  colors: Theme;
  onAct?: (message: ActMessage) => void;
  onKey?: (key: string) => void;
  onFind?: (message: FindMessage) => void;
  onInspect?: (message: Extract<Message, { type: "feed-search-text" }>) => void;
}) {
  const width = model.columns;
  const bodyColors = useMemo(
    () => (model.screen === "reconnecting" ? theme(colors.level, false, true) : colors),
    [colors, model.screen],
  );
  const header = model.history
    ? colors.paint(`History · ${model.history.rows.length} runs`, "fg", true)
    : monitorHeader(model, colors);
  const blocks: { key: string; height: number; content: React.ReactNode }[] = messageBlocks(
    model,
    colors,
  );
  for (const note of model.notes) {
    blocks.push({
      key: note.id,
      height: width < 100 ? 3 : 4,
      content: (
        <QuestionNote
          note={note}
          width={width}
          colors={bodyColors}
          saved={model.screen === "saved"}
        />
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
      height: (width < 100 ? 1 : model.pinned.length) + Number(model.morePinned > 0),
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
  const hiddenWaiting =
    !model.detail && !model.history && !model.overlay ? (model.filterBar?.hiddenWaiting ?? 0) : 0;
  const filterVisible = model.filterBar !== null && !model.overlay;
  const available = Math.max(
    1,
    model.rows - 2 - Number(model.act.notice !== null) - Number(filterVisible),
  );
  const preview = !model.detail && !model.overlay && !model.history ? model.preview : null;
  const listHeight = Math.max(0, available - (preview ? 5 : 0) - Number(hiddenWaiting > 0));
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
  else if (model.history)
    body = <History history={model.history} width={width} height={available} colors={colors} />;
  else if (model.review) body = <ReviewScreen model={model} colors={colors} height={available} />;
  else if (model.diff)
    body = <DiffPane diff={model.diff} width={width} height={available} colors={colors} />;
  else if (model.detail)
    body = (
      <DetailScreen
        detail={model.detail}
        model={model}
        colors={colors}
        onFind={onInspect}
        onKey={onKey}
        height={available}
      />
    );
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
      {filterVisible && model.filterBar && (
        <FilterBar
          filter={model.filterBar}
          width={width}
          colors={colors}
          onFind={onFind}
          onKey={onKey}
        />
      )}
      <Box height={available} flexDirection="column">
        {body}
        <HiddenWaiting count={hiddenWaiting} width={width} colors={bodyColors} />
        {preview && <Preview preview={preview} width={width} colors={bodyColors} />}
        {model.palette && !model.overlay && (
          <Palette
            palette={model.palette}
            columns={width}
            height={available}
            colors={colors}
            onFind={onFind}
            onKey={onKey}
          />
        )}
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
  onFind = () => {},
  onInspect = () => {},
}: {
  model: ViewModel;
  colors: Theme;
  onKey: (key: string) => void;
  onTick: (now: number) => void;
  onAct?: (message: ActMessage) => void;
  onFind?: (message: FindMessage) => void;
  onInspect?: (message: Extract<Message, { type: "feed-search-text" }>) => void;
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
        onFind={(message) => {
          if (!blocked.current) onFind(message);
        }}
        onInspect={(message) => {
          if (!blocked.current) onInspect(message);
        }}
      />
    </Tick>
  );
}
