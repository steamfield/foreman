import stringWidth from "string-width";
import type { ReviewView } from "../core/monitor/model";
import { pad, truncate } from "./components";
import { InspectFrame, InspectRow } from "./inspect-frame";
import type { Theme } from "./theme";

/** Draws numstat and scope warnings for the selected worktree file. */
export function InspectFiles({
  files,
  width,
  height,
  colors,
  focused = false,
  note = "",
  offset = 0,
}: {
  files: ReviewView["files"];
  width: number;
  height: number;
  colors: Theme;
  focused?: boolean;
  note?: string;
  offset?: number;
}) {
  const rows = Math.max(0, height - 2 - Number(Boolean(note)));
  return (
    <InspectFrame
      title={`Files · ${files.length}`}
      width={width}
      height={height}
      colors={colors}
      focused={focused}
    >
      {Array.from({ length: rows }, (_, index) => {
        const file = files[index + offset];
        const suffix = file
          ? `${file.outside ? `${colors.paint("▲ outside May change", "interrupted")}  ` : ""}${colors.paint(file.added, "done")} ${colors.paint(file.removed, "failed")}`
          : "";
        const path = file
          ? pad(
              truncate(`${file.status} ${file.path}`, Math.max(0, width - 6 - stringWidth(suffix))),
              Math.max(0, width - 6 - stringWidth(suffix)),
            )
          : "";
        return (
          <InspectRow
            key={file?.path ?? `empty:${index + offset}`}
            text={file ? `${path}  ${suffix}` : ""}
            width={width}
            colors={colors}
            selected={focused && file?.selected}
          />
        );
      })}
      {note && <InspectRow text={colors.paint(note, "muted")} width={width} colors={colors} />}
    </InspectFrame>
  );
}
