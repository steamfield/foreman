import stringWidth from "string-width";
import type { ViewModel } from "../core/monitor/model";
import type { Theme } from "./theme";

type Hint = readonly [string, string];
const common: readonly Hint[] = [
  ["?", "help"],
  ["q", "quit"],
];
function listHints(model: ViewModel): readonly Hint[] {
  if (model.footer.compact) return common;
  return [
    ["↑↓/jk", "select"],
    ["Enter", "open"],
    ["a", "answer"],
    ["d", "defer"],
    ["!", model.footer.attentionOnly ? "all runs" : "needs me"],
    ...(model.columns >= (model.footer.caution ? 160 : 140)
      ? ([
          ["/", "filter"],
          [":", "palette"],
        ] satisfies Hint[])
      : []),
    ...(model.columns >= 100
      ? ([
          ["s", "steer"],
          ["i", "interrupt"],
        ] satisfies Hint[])
      : []),
    ...(model.columns >= 140
      ? ([
          ["F", "follow up"],
          ["x", "archive"],
        ] satisfies Hint[])
      : []),
    ...common,
  ];
}
function detailHints(model: ViewModel): readonly Hint[] {
  if (model.footer.compact) return common;
  return [
    ["Tab", "pane"],
    ["jk", "scroll"],
    ["f", "follow"],
    ["Esc", "list"],
    ...(model.columns >= 80
      ? ([
          ["a", "answer"],
          ["d", "defer"],
        ] satisfies Hint[])
      : []),
    ...(model.columns >= 100
      ? ([
          ["s", "steer"],
          ["i", "interrupt"],
        ] satisfies Hint[])
      : []),
    ...(model.columns >= 140
      ? ([
          ["F", "follow up"],
          ["x", "archive"],
        ] satisfies Hint[])
      : []),
    ...common,
  ];
}
function hints(model: ViewModel): readonly Hint[] {
  if (model.palette)
    return [
      [":", "palette open"],
      ["↑↓", "choose"],
      ["⏎", "run"],
      ["esc", "close"],
    ];
  if (model.history) return [["jk", "move"], ["/", "filter"], ["h/esc", "back"], ...common];
  if (model.act.hints) return model.act.hints.map(({ key, label }) => [key, label]);
  const result = model.detail ? detailHints(model) : listHints(model);
  return model.layout === "narrow" ? result.filter(([key]) => key !== "Enter") : result;
}

/** Formats responsive hints and preserves room for connection status when it fits. */
export function monitorFooter(model: ViewModel, colors: Theme): string {
  const left = hints(model)
    .map(([key, label]) => colors.paint(key, "fg", true) + colors.paint(` ${label}`, "muted"))
    .join("  ");
  const right =
    model.footer.compact || stringWidth(left + model.footer.status) + 1 > model.columns
      ? ""
      : colors.paint(model.footer.status, model.footer.caution ? "interrupted" : "muted");
  return left + " ".repeat(Math.max(1, model.columns - stringWidth(left + right))) + right;
}
