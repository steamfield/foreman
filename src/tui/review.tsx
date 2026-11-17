import { Box, Text } from "ink";
import stringWidth from "string-width";
import { reviewLayout } from "../core/monitor/diff";
import type { ViewModel } from "../core/monitor/model";
import { Glyph, pad, truncate } from "./components";
import { DiffPane } from "./diff";
import { InspectFiles } from "./inspect-files";
import { InspectFrame, InspectRow } from "./inspect-frame";
import type { Theme } from "./theme";

function ReviewTextPane({
  title,
  lines,
  offset,
  height,
  width,
  colors,
  focused,
}: {
  title: string;
  lines: readonly string[];
  offset: number;
  height: number;
  width: number;
  colors: Theme;
  focused: boolean;
}) {
  const rows = Array.from({ length: Math.max(0, height - 2) }, (_, position) => ({
    id: `${title}:${position + offset}`,
    text: lines[position + offset] ?? "",
  }));
  return (
    <InspectFrame title={title} width={width} height={height} colors={colors} focused={focused}>
      {rows.map(({ id, text }) => (
        <InspectRow key={id} text={text} width={width} colors={colors} focused={focused} />
      ))}
    </InspectFrame>
  );
}

/** Draws the finished run's hand-off, unattended decisions, files and inline diff. */
export function ReviewScreen({
  model,
  colors,
  height,
}: {
  model: ViewModel;
  colors: Theme;
  height: number;
}) {
  const review = model.review;
  if (!review) return null;
  const width = model.columns;
  const task =
    model.detail?.header.find(([label]) => label.toLowerCase() === "task")?.[1] ??
    model.detail?.panes.find((pane) => pane.id === "task")?.lines[0]?.text.replace(/^#+\s*/, "") ??
    "";
  const header =
    colors.paint(` ${model.detail?.state ?? "done"}  `, model.detail?.tone ?? "done") +
    colors.paint(model.detail?.name ?? "", "fg", true) +
    colors.paint(`  ${task}`);
  const summary = truncate(review.summary, Math.floor(width / 2));
  const headerWidth = Math.max(0, width - stringWidth(summary) - 2);
  const handoff = review.handoff?.lines ?? ["No hand-off recorded."];
  const decisions = review.decided.flatMap((item) => [
    `${item.asked} · ${item.question}`,
    item.outcome,
    review.lateAnswerHint,
  ]);
  const { handoffHeight, decisionHeight, remaining, stacked, fileHeight, fileWidth, diffHeight } =
    reviewLayout(review, width, height);
  const focus = review.focus;
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      <Box width={width} height={1} flexShrink={0}>
        <Glyph
          kind={model.detail?.state ?? "idle"}
          tone={model.detail?.tone ?? "done"}
          colors={colors}
        />
        <Text wrap="truncate-end">
          {pad(truncate(header, headerWidth), headerWidth) + colors.paint(` ${summary}`, "muted")}
        </Text>
      </Box>
      <ReviewTextPane
        title={review.handoff?.title ?? "Hand-off"}
        width={width}
        height={handoffHeight}
        colors={colors}
        focused={focus === "handoff"}
        lines={handoff}
        offset={model.detail?.panes.find((pane) => pane.id === "handoff")?.offset ?? 0}
      />
      <ReviewTextPane
        title={`Decided without you · ${review.decided.length}`}
        width={width}
        height={decisionHeight}
        colors={colors}
        focused={focus === "decided"}
        lines={(decisions.length ? decisions : ["No unattended decisions."]).map((text, position) =>
          colors.paint(text, position % 3 === 0 ? "interrupted" : "fg"),
        )}
        offset={model.detail?.panes.find((pane) => pane.id === "questions")?.offset ?? 0}
      />
      <Box width={width} height={remaining} flexDirection={stacked ? "column" : "row"}>
        <InspectFiles
          files={review.files}
          message={review.filesMessage}
          note={review.filesNote}
          width={fileWidth}
          height={fileHeight}
          offset={Math.max(0, review.files.findIndex((file) => file.selected) - fileHeight + 4)}
          focused={focus === "files"}
          colors={colors}
        />
        <ReviewDiff
          diff={model.diff}
          width={stacked ? width : width - fileWidth}
          height={diffHeight}
          colors={colors}
          focused={focus === "diff"}
        />
      </Box>
    </Box>
  );
}

function ReviewDiff({
  diff,
  width,
  height,
  colors,
  focused,
}: {
  diff: ViewModel["diff"];
  width: number;
  height: number;
  colors: Theme;
  focused: boolean;
}) {
  if (diff)
    return <DiffPane diff={diff} width={width} height={height} colors={colors} focused={focused} />;
  return (
    <InspectFrame title="Diff" width={width} height={height} colors={colors} focused={focused}>
      <InspectRow
        text={colors.paint("Select a file to read its diff.", "muted")}
        width={width}
        colors={colors}
        focused={focused}
      />
    </InspectFrame>
  );
}
