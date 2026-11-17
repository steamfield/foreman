import { Box, Text } from "ink";
import stringWidth from "string-width";
import { Glyph, pad, truncate } from "./components";
import { DiffPane } from "./diff";
import { InspectFiles } from "./inspect-files";
import { InspectFrame, InspectRow } from "./inspect-frame";
import type { InspectViewModel } from "./inspect-view";
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
        <InspectRow key={id} text={text} width={width} colors={colors} />
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
  model: InspectViewModel;
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
  const handoffHeight = Math.min(handoff.length + 2, Math.max(3, Math.floor(height / 4)));
  const decisions = review.decided.flatMap((item) => [
    `${item.asked} · ${item.question}`,
    `→ ${item.outcome}`,
    "a answer late (starts a follow-up turn)",
  ]);
  const decisionHeight = Math.min(
    Math.max(1, decisions.length) + 2,
    Math.max(3, Math.floor(height / 4)),
  );
  const remaining = Math.max(6, height - 1 - handoffHeight - decisionHeight);
  const stacked = width < 120;
  const fileHeight = stacked
    ? Math.min(remaining - 3, Math.max(3, review.files.length + 3))
    : remaining;
  const fileWidth = stacked ? width : Math.floor(width * 0.32);
  const focus = model.detail?.focus;
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
        title={`Hand-off${review.handoff?.title ? ` · ${review.handoff.title}` : ""}`}
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
        focused={focus === "questions"}
        lines={(decisions.length ? decisions : ["No unattended decisions."]).map((text, position) =>
          colors.paint(text, position % 3 === 0 ? "interrupted" : "fg"),
        )}
        offset={model.detail?.panes.find((pane) => pane.id === "questions")?.offset ?? 0}
      />
      <Box width={width} height={remaining} flexDirection={stacked ? "column" : "row"}>
        <InspectFiles
          files={review.files}
          note={review.filesNote}
          width={fileWidth}
          height={fileHeight}
          offset={Math.max(0, review.files.findIndex((file) => file.selected) - fileHeight + 4)}
          focused={focus !== "questions" && focus !== "handoff"}
          colors={colors}
        />
        <DiffPane
          diff={
            review.diff ?? {
              title: "Diff",
              position: "",
              status: "loading",
              message: "Select a file to read its diff.",
              lines: [],
              offset: 0,
              truncated: false,
            }
          }
          width={stacked ? width : width - fileWidth}
          height={stacked ? remaining - fileHeight : remaining}
          colors={colors}
        />
      </Box>
    </Box>
  );
}
