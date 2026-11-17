import stringWidth from "string-width";
import type { ViewModel } from "../core/monitor/model-types";
import type { Theme } from "./theme";

type Hint = readonly [string, string];
const common: readonly Hint[] = [
  ["?", "help"],
  ["q", "quit"],
];
function listHints(model: ViewModel): readonly Hint[] {
  if (model.footer.compact || model.firstRun) return common;
  if (model.columns < 100)
    return [["⏎", "open"], ["a", "answer"], ["/", "filter"], [":", "palette"], ...common];
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
    ["jk", "move"],
    ["d", "diff file"],
    ...(model.columns >= 140
      ? ([
          ["D", "all in $PAGER"],
          ["1-5", "feed filter"],
        ] satisfies Hint[])
      : []),
    ...(model.columns >= 100
      ? ([
          ["/", "search feed"],
          ["s", "steer"],
          ["i", "interrupt"],
        ] satisfies Hint[])
      : []),
    ["Esc", "list"],
    ...(model.columns >= 140
      ? ([
          ["F", "follow up"],
          ["x", "archive"],
        ] satisfies Hint[])
      : common),
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
  if (model.diff && !model.review)
    return [
      ["jk", "scroll"],
      ["n/p", "hunk"],
      ["D", "open in $PAGER"],
      ["Esc", "back"],
    ];
  if (model.review)
    return [
      ["Tab", "pane"],
      ["jk", "scroll"],
      ["n/p", "hunk"],
      ["D", "open in $PAGER"],
      ["r", "mark reviewed"],
      ["F", "follow up"],
      ["x", "archive"],
      ["Esc", model.diff ? "back" : "list"],
    ];
  const result = model.detail ? detailHints(model) : listHints(model);
  return result;
}

/** Formats responsive hints and preserves room for connection status when it fits. */
export function monitorFooter(model: ViewModel, colors: Theme): string {
  const left = hints(model)
    .map(([key, label]) => colors.paint(key, "fg", true) + colors.paint(` ${label}`, "muted"))
    .join("  ");
  let status = model.footer.status;
  if (model.firstRun && model.header.caution)
    status = `saved state · read ${status.replace(/^updated /, "")}`;
  else if (model.columns < 100) status = status.replace(/^updated /, "").replace(/ ago$/, "");
  const right =
    model.footer.compact || stringWidth(left + status) + 1 > model.columns
      ? ""
      : colors.paint(status, model.footer.caution ? "interrupted" : "muted");
  return left + " ".repeat(Math.max(1, model.columns - stringWidth(left + right))) + right;
}
