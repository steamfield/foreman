import stringWidth from "string-width";
import type { ViewModel } from "../core/monitor/model";
import { ModeChip } from "./act";
import type { Theme } from "./theme";

/** Fits the header, dropping the acting note before daemon status and defaults. */
export function monitorHeader(model: ViewModel, colors: Theme) {
  const mark = colors.paint("››", "fg") + colors.paint("›", "signal");
  const left = `${mark} ${colors.paint("foreman", "fg", true)} ${colors.paint(model.header.version, "muted")}   ${ModeChip({ act: model.act, colors })}`;
  const counts = model.header.counts
    .map((count) => {
      const state =
        colors.level === 0 && ["waiting", "failed"].includes(count.state)
          ? count.state.toUpperCase()
          : count.state;
      return colors.paint("■", count.tone) + colors.paint(` ${count.count} ${state}`);
    })
    .join("  ");
  const rightParts = [
    ...(model.act.chip.mode === "acting"
      ? [colors.paint("daemon stays up while this monitor is open · w to watch only", "muted")]
      : []),
    colors.paint(model.header.daemon, model.header.caution ? "interrupted" : "muted"),
    colors.paint(model.header.defaults, "muted"),
    counts,
  ];
  if (model.firstRun)
    rightParts.splice(
      0,
      rightParts.length,
      colors.paint(model.header.daemon, model.header.caution ? "interrupted" : "muted"),
    );
  while (rightParts.length && stringWidth(`${left}  ${rightParts.join("  ")}`) > model.columns) {
    if (model.header.daemon.startsWith("no daemon")) rightParts.pop();
    else rightParts.shift();
  }
  const right = rightParts.join("  ");
  return left + " ".repeat(Math.max(1, model.columns - stringWidth(left + right))) + right;
}
