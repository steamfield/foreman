import type { DiffView, Tone } from "../core/monitor/model";
import { InspectFrame, InspectRow } from "./inspect-frame";
import type { Theme } from "./theme";

const tones: Record<DiffView["lines"][number]["kind"], Tone> = {
  hunk: "running",
  add: "done",
  remove: "failed",
  context: "fg",
  meta: "muted",
};
function diffRow(line: DiffView["lines"][number], colors: Theme) {
  const numbered = line.oldLine !== null || line.newLine !== null;
  const numbers = numbered
    ? colors.paint(
        `${String(line.oldLine ?? "").padStart(4)} ${String(line.newLine ?? "").padStart(4)} `,
        "muted",
      )
    : "";
  return numbers + colors.paint(line.text, tones[line.kind]);
}

/** Draws an offset diff in a reusable frame, reserving room for truncation notices. */
export function DiffPane({
  diff,
  width,
  height,
  colors,
  focused = true,
}: {
  diff: DiffView;
  width: number;
  height: number;
  colors: Theme;
  focused?: boolean;
}) {
  const count = Math.max(0, height - 2 - Number(diff.truncated));
  const rows =
    diff.status === "ready"
      ? diff.lines.slice(diff.offset, diff.offset + count).map((line) => diffRow(line, colors))
      : [
          colors.paint(
            diff.message ?? (diff.status === "loading" ? "Loading diff…" : "Cannot read diff."),
            diff.status === "failed" ? "failed" : "muted",
          ),
        ];
  return (
    <InspectFrame
      title={`${diff.title} · ${diff.position}  n/p hunk`}
      width={width}
      height={height}
      colors={colors}
      focused={focused}
    >
      {Array.from({ length: count }, (_, index) => ({
        id: `diff:${diff.offset + index}`,
        text: rows[index] ?? "",
      })).map(({ id, text }) => (
        <InspectRow key={id} text={text} width={width} colors={colors} focused={focused} />
      ))}
      {diff.truncated && (
        <InspectRow
          text={colors.paint("… diff truncated · D opens more in $PAGER", "muted")}
          width={width}
          colors={colors}
          focused={focused}
        />
      )}
    </InspectFrame>
  );
}
