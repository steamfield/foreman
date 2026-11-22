import { Box, Text } from "ink";
import { memo } from "react";
import stringWidth from "string-width";
import { MODEL_CELL_WIDTH } from "../core/monitor/format";
import type { RowView, ViewModel } from "../core/monitor/model-types";
import { PACE_MINUTES } from "../schemas/monitor";
import { Glyph, Line, pad, truncate } from "./components";
import { GroupHeading } from "./group-heading";
import type { Theme } from "./theme";

type ListModel = Pick<ViewModel, "columns" | "layout" | "budgetCells" | "listColumns" | "groups">;
function widths(model: ListModel) {
  const stale = model.groups.some((group) => group.rows.some((row) => row.stale));
  let name = 16;
  let status = 13;
  let task = 26;
  if (model.columns >= 120) {
    name = 21;
    status = 15;
    task = 30;
  } else if (model.columns >= 100) {
    name = 17;
    status = 14;
    task = 32;
  }
  let statusWidth = status;
  for (const group of model.groups)
    for (const row of group.rows) {
      const label = row.stale ? `${row.state} · not supervised` : row.state;
      statusWidth = Math.max(statusWidth, stringWidth(label + row.age) + 2);
    }
  const sizes = {
    name: Math.min(name, Math.max(1, model.columns - (stale ? 34 : 19))),
    model: model.listColumns.model ? MODEL_CELL_WIDTH : 0,
    status: statusWidth,
    task: model.listColumns.task ? Math.max(1, task - (statusWidth - status)) : 0,
    pace: model.listColumns.pace ? PACE_MINUTES + 1 : 0,
    progress: model.listColumns.progress ? 15 : 0,
    budget:
      model.layout === "narrow" ? 0 : model.budgetCells + (model.listColumns.budgetLabel ? 9 : 2),
  };
  const fixed =
    3 + sizes.name + sizes.model + sizes.status + sizes.pace + sizes.progress + sizes.budget;
  if (sizes.task) {
    const available = Math.min(sizes.task, model.columns - fixed - 12);
    if (available < 7 && sizes.budget && !model.listColumns.budgetLabel) sizes.budget--;
    sizes.task = Math.max(7, available);
  }
  return sizes;
}
const cell = (text: string, width: number) => pad(truncate(text, width), width);
const taskCell = (text: string, width: number) => (width > 0 ? `${cell(text, width - 1)} ` : "");

/** Renders the enabled column labels using the same widths as the run rows. */
export function ListHeader({ model, colors }: { model: ListModel; colors: Theme }) {
  if (
    !model.listColumns.task &&
    !model.listColumns.model &&
    !model.listColumns.progress &&
    !model.listColumns.pace
  )
    return null;
  const w = widths(model);
  const labels =
    "   " +
    cell("RUN", w.name) +
    cell("MODEL · EFFORT", w.model) +
    cell("STATUS", w.status) +
    taskCell("TASK", w.task) +
    cell("PACE", w.pace) +
    cell("PROGRESS", w.progress) +
    cell("BUDGET", w.budget) +
    "FLAGS";
  return (
    <Line width={model.columns} colors={colors}>
      {colors.paint(labels, "muted")}
    </Line>
  );
}
function rowContent(row: RowView, model: ListModel, colors: Theme) {
  const w = widths(model);
  const word =
    colors.level === 0 && (row.state === "waiting" || row.state === "failed")
      ? row.state.toUpperCase()
      : row.state;
  const state = row.stale ? `${word} · not supervised` : word;
  const status = `${state} ${row.age.padStart(Math.max(0, w.status - stringWidth(state) - 2))}`;
  const failures = row.progress?.failed ? colors.paint(` ×${row.progress.failed}`, "failed") : "";
  const budget =
    row.budget && w.budget
      ? colors.paint("━".repeat(row.budget.filled), row.budget.tone) +
        colors.paint("─".repeat(Math.max(0, model.budgetCells - row.budget.filled)), "line") +
        (model.listColumns.budgetLabel
          ? colors.paint(` ${row.budget.label.padStart(7)}`, "muted")
          : "")
      : "";
  return (
    " " +
    colors.paint(cell(row.name, w.name), "fg", true) +
    colors.paint(cell(row.modelLabel, w.model), "muted") +
    colors.paint(cell(status, w.status), row.tone) +
    colors.paint(taskCell(row.task ?? "", w.task)) +
    colors.paint(cell(row.pace ?? "·", w.pace), row.state === "idle" ? "muted" : row.tone) +
    cell(
      colors.paint(
        truncate(row.progress?.text ?? "", Math.max(0, w.progress - stringWidth(failures))),
      ) + failures,
      w.progress,
    ) +
    cell(budget, w.budget) +
    row.flags.map((flag) => colors.paint(flag.text, flag.tone)).join(colors.paint(" · ", "muted"))
  );
}

/** Renders a run and its activity and subagent lines. */
export const RunRow = memo(
  function RunRow({
    row,
    model,
    colors,
    selected,
  }: {
    row: RowView;
    model: ListModel;
    colors: Theme;
    selected: boolean;
  }) {
    const { columns: width } = model;
    let activity = colors.paint(`    ${row.activity}`, row.activityTone);
    if (row.activityAge !== null)
      activity = `    ${colors.paint("…", "running")}${colors.paint(row.activity.slice(1), "fg")}${colors.paint(` · ${row.activityAge}`, "muted")}`;
    if (width < 100) {
      let suffix = "";
      if (row.subagents.length)
        suffix += colors.paint(` · ${row.subagents.length} subagents`, "muted");
      activity = truncate(activity, Math.max(4, width - stringWidth(suffix))) + suffix;
    }
    const lead = (
      <Glyph
        kind={row.stale ? "lost" : row.state}
        tone={row.tone}
        colors={colors}
        selected={selected}
      />
    );
    const content = pad(
      truncate(rowContent(row, model, colors), Math.max(0, width - 2)),
      Math.max(0, width - 2),
    );
    return (
      <Box flexDirection="column" width={width}>
        <Text wrap="truncate-end">
          {selected ? colors.select(" ") : colors.fill(" ")}
          {lead}
          {selected ? colors.select(content) : colors.fill(content)}
        </Text>
        <Line width={width} colors={colors} selected={selected}>
          {activity}
        </Line>
        {width >= 100 &&
          row.subagents.map((agent, index) => {
            const tree = index === row.subagents.length - 1 ? "└─" : "├─";
            const text =
              colors.paint(` ${agent.path}`, "fg") + colors.paint(`  ${agent.text}`, "muted");
            const start = colors.paint(`    ${tree} `, "line");
            return (
              <Text key={agent.path} wrap="truncate-end">
                {selected ? colors.select(start) : colors.fill(start)}
                <Glyph
                  kind={agent.working ? "working" : "subagent-idle"}
                  tone={agent.working ? "running" : "muted"}
                  colors={colors}
                  selected={selected}
                />
                {selected
                  ? colors.select(pad(truncate(text, width - 8), width - 8))
                  : colors.fill(pad(truncate(text, width - 8), width - 8))}
              </Text>
            );
          })}
      </Box>
    );
  },
  (previous, next) =>
    previous.row === next.row &&
    previous.colors === next.colors &&
    previous.selected === next.selected &&
    previous.model.columns === next.model.columns &&
    previous.model.layout === next.model.layout &&
    previous.model.budgetCells === next.model.budgetCells &&
    previous.model.listColumns === next.model.listColumns &&
    widths(previous.model).status === widths(next.model).status,
);

/** Builds the ordered group rules, column headers and run blocks for list scrolling. */
export function listGroups(model: ViewModel, colors: Theme) {
  const width = model.columns;
  const blocks: { key: string; height: number; content: React.ReactNode }[] = [];
  for (const group of model.groups) {
    blocks.push({
      key: `group:${group.id}`,
      height: 1,
      content: (
        <GroupHeading title={group.title} summary={group.summary} width={width} colors={colors} />
      ),
    });
    if (
      model.listColumns.task ||
      model.listColumns.model ||
      model.listColumns.progress ||
      model.listColumns.pace
    )
      blocks.push({
        key: `columns:${group.id}`,
        height: 1,
        content: <ListHeader model={model} colors={colors} />,
      });
    for (const row of group.rows)
      blocks.push({
        key: row.name,
        height: 2 + (model.columns < 100 ? 0 : row.subagents.length),
        content: (
          <RunRow row={row} model={model} colors={colors} selected={model.selected === row.name} />
        ),
      });
    if (group.older)
      blocks.push({
        key: group.older.id,
        height: 1,
        content: (
          <Line width={width} colors={colors} selected={model.selected === group.older.id}>
            {colors.paint(group.older.text, "muted")}
          </Line>
        ),
      });
  }
  return blocks;
}
