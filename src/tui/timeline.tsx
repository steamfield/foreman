import type { TimelineView } from "../core/monitor/model";
import { InspectFrame, InspectRow } from "./inspect-frame";
import type { Theme } from "./theme";

/** Draws the run's timeline cells, optional subagents, ticks and legend. */
export function Timeline({
  timeline,
  width,
  colors,
}: {
  timeline: TimelineView;
  width: number;
  colors: Theme;
}) {
  const tracks = [timeline.cells, ...(timeline.subagentCells ? [timeline.subagentCells] : [])];
  const lines = [
    ...tracks.map((cells) => cells.map((cell) => colors.paint(cell.glyph, cell.tone)).join("")),
    colors.paint(timeline.ticks, "muted"),
    colors.paint(timeline.legend, "muted"),
  ];
  return (
    <InspectFrame title={timeline.label} width={width} height={lines.length + 2} colors={colors}>
      {lines
        .map((text, position) => ({ text, id: `track:${position}` }))
        .map(({ text, id }) => (
          <InspectRow key={id} text={text} width={width} colors={colors} />
        ))}
    </InspectFrame>
  );
}
