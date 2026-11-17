import { Box } from "ink";
import { legendLines } from "../core/monitor/legend";
import type { ViewModel } from "../core/monitor/model-types";
import { Line, pad, truncate } from "./components";
import type { Theme } from "./theme";

const keys = [
  "Monitor help",
  "↑↓/jk select   Home/End first/last   PgUp/PgDn page",
  "Enter open / expand   Tab next pane   j/k scroll pane",
  "a answer   d defer   s steer   F follow up",
  "i interrupt   x archive   y confirm   k keep worktree",
  "ctrl-e $EDITOR   ctrl-s send   ctrl-d defer   enter send",
  "w watch only   ! needs me",
  "/ filter   : palette / copy command   g group   h history",
  "d diff file   D $PAGER   r review / r reviewed   R refresh files",
  "n/p hunk   f follow feed   1-5 feed filters   / search feed",
  "? close help   Esc back / cancel   q quit   Ctrl-C quit",
];

/** Renders the complete keyboard reference and shared first-run state meanings. */
export function Help({ model, colors }: { model: ViewModel; colors: Theme }) {
  const width = Math.min(92, model.columns);
  const lines = [
    ...keys,
    ...legendLines(),
    "◐ starting / unknown   ■ interrupted   ◌ lost",
    "⠿ working subagent   · idle subagent",
    "━━━─── budget: time used of the turn's limit, not progress",
    "foreman status --all for scripts and agents",
  ];
  return (
    <Box
      width={model.columns}
      height={Math.max(1, model.rows - 2)}
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
      overflow="hidden"
    >
      <Line width={width} colors={colors}>
        {colors.paint(`╭${"─".repeat(Math.max(0, width - 2))}╮`, "line")}
      </Line>
      {lines.map((text) => (
        <Line key={text} width={width} colors={colors}>
          {colors.paint("│ ", "line") +
            colors.paint(pad(truncate(text, width - 4), width - 4)) +
            colors.paint(" │", "line")}
        </Line>
      ))}
      <Line width={width} colors={colors}>
        {colors.paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, "line")}
      </Line>
    </Box>
  );
}
