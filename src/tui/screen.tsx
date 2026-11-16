import cliTruncate from "cli-truncate";
import { Box, Text, useInput } from "ink";
import { createContext, memo, use, useEffect, useMemo, useState } from "react";
import stringWidth from "string-width";
import type { RowView, Tone, ViewModel } from "../core/monitor/model";
import { type Theme, theme } from "./theme";

const Tick = createContext(0);
const spinner = "⣾⣽⣻⢿⡿⣟⣯⣷";
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return cliTruncate(text, width, { position: "end", truncationCharacter: "…" });
}
const pad = (text: string, width: number) =>
  text + " ".repeat(Math.max(0, width - stringWidth(text)));
function glyph(kind: string, now: number) {
  if (kind === "running") return spinner[Math.floor(now / 100) % 8] ?? "⣾";
  if (kind === "starting" || kind === "probing") return "◐◓◑◒"[Math.floor(now / 150) % 4] ?? "◐";
  if (kind === "waiting") return Math.floor(now / 800) % 2 === 0 ? "■" : "□";
  if (kind === "working") return Math.floor(now / 400) % 2 === 0 ? "⠿" : "⠶";
  if (kind === "idle") return "✓";
  if (kind === "failed") return "×";
  if (kind === "unknown") return "◐";
  if (kind === "lost") return "◌";
  return kind === "subagent-idle" ? "·" : "■";
}
function Glyph({
  kind,
  tone,
  colors,
  selected = false,
}: {
  kind: string;
  tone: Tone;
  colors: Theme;
  selected?: boolean;
}) {
  const text = colors.paint(glyph(kind, use(Tick)), tone);
  return <Text>{selected ? colors.select(text) : colors.fill(text)}</Text>;
}
function Line({
  children,
  width,
  colors,
  selected = false,
  bar = false,
}: {
  children: string;
  width: number;
  colors: Theme;
  selected?: boolean;
  bar?: boolean;
}) {
  const text = pad(truncate(children, width), width);
  return <Text wrap="truncate-end">{selected ? colors.select(text) : colors.fill(text, bar)}</Text>;
}
const NoteHeading = memo(function NoteHeading({
  title,
  width,
  colors,
}: {
  title: string;
  width: number;
  colors: Theme;
}) {
  const label = truncate(title, width - 6);
  return (
    <Text wrap="truncate-end">
      {colors.fill(colors.paint("╭─ ", "line"))}
      <Glyph kind="waiting" tone="signal" colors={colors} />
      {colors.fill(
        colors.paint(label.slice(1), "signal") +
          colors.paint(` ${"─".repeat(Math.max(0, width - stringWidth(label) - 6))}─╮`, "line"),
      )}
    </Text>
  );
});
const RunRow = memo(
  function RunRow({
    row,
    model,
    colors,
    selected,
  }: {
    row: RowView;
    model: Pick<ViewModel, "columns" | "layout" | "budgetCells">;
    colors: Theme;
    selected: boolean;
  }) {
    const { columns: width, layout } = model;
    let tail = "";
    if (layout !== "narrow") {
      tail = colors.paint(
        `  ${pad(`t${row.turn}${layout === "wide" && row.turnKind ? ` ${row.turnKind}` : ""}`, layout === "wide" ? 12 : 4)}`,
        "muted",
      );
      if (row.budget)
        tail += `  ${colors.paint("━".repeat(row.budget.filled), row.budget.tone)}${colors.paint("─".repeat(Math.max(0, model.budgetCells - row.budget.filled)), "line")} ${colors.paint(row.budget.label.padStart(7), "muted")}`;
      tail += row.flags.map((flag) => colors.paint(` · ${flag.text}`, flag.tone)).join("");
    }
    const nameWidth = Math.max(
      1,
      Math.min(layout === "narrow" ? 24 : 20, width - row.state.length - 12),
    );
    const prefix = ` ${colors.paint(pad(truncate(row.name, nameWidth), nameWidth), "fg", true)}  ${colors.paint(row.state.padEnd(11), row.tone)} ${colors.paint(row.age, "muted")}`;
    let activity = colors.paint(`    ${row.activity}`, row.activityTone);
    if (row.activityAge !== null)
      activity = `    ${colors.paint("…", "running")}${colors.paint(row.activity.slice(1), "fg")}${colors.paint(` · ${row.activityAge}`, "muted")}`;
    if (layout === "narrow") {
      let suffix = "";
      if (row.flags[0]) suffix += colors.paint(` · ${row.flags[0].text}`, row.flags[0].tone);
      if (row.subagents.length)
        suffix += colors.paint(` · ${row.subagents.length} subagents`, "muted");
      activity = truncate(activity, Math.max(4, width - stringWidth(suffix))) + suffix;
    }
    const lead = <Glyph kind={row.state} tone={row.tone} colors={colors} selected={selected} />;
    const content = pad(truncate(prefix + tail, Math.max(0, width - 2)), Math.max(0, width - 2));
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
        {layout !== "narrow" &&
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
    previous.model.layout === next.model.layout,
);

function Help({ model, colors }: { model: ViewModel; colors: Theme }) {
  const width = Math.min(76, model.columns);
  const lines = [
    "Monitor help",
    " ",
    "↑/k previous       ↓/j next",
    "Home first         End last",
    "PgUp scroll up     PgDn scroll down",
    "a attention only   Enter expand older idle runs",
    "? close help       Esc close help",
    "q quit             Ctrl-C interrupt",
    "  ",
    "⣾ running  ◐ starting  ■/□ waiting  ✓ idle",
    "× failed  ■ interrupted  ◐ unknown  ◌ lost",
    "⠿ working subagent  · idle subagent",
    "   ",
    "foreman status --all for scripts and agents",
  ];
  return (
    <Box
      width={model.columns}
      height={Math.max(1, model.rows - 2)}
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
    >
      <Line width={width} colors={colors}>
        {colors.paint(`╭${"─".repeat(Math.max(0, width - 2))}╮`, "line")}
      </Line>
      {lines.slice(0, Math.max(0, model.rows - 6)).map((text, index) => (
        <Line key={text} width={width} colors={colors}>
          {colors.paint("│ ", "line") +
            colors.paint(pad(truncate(text, width - 4), width - 4), "fg", index === 0) +
            colors.paint(" │", "line")}
        </Line>
      ))}
      <Line width={width} colors={colors}>
        {colors.paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, "line")}
      </Line>
    </Box>
  );
}
export const Screen = memo(function Screen({ model, colors }: { model: ViewModel; colors: Theme }) {
  const width = model.columns;
  const bodyColors = useMemo(
    () => (model.screen === "reconnecting" ? theme(colors.level, false, true) : colors),
    [colors, model.screen],
  );
  const mark = colors.paint("››", "fg") + colors.paint("›", "signal");
  const left = `${mark} ${colors.paint("foreman", "fg", true)} ${colors.paint(model.header.version, "muted")}`;
  const counts = model.header.counts
    .map((count) => colors.paint("■", count.tone) + colors.paint(` ${count.count} ${count.state}`))
    .join("  ");
  const rightParts = [
    colors.paint(model.header.daemon, model.header.caution ? "interrupted" : "muted"),
    colors.paint(model.header.defaults, "muted"),
    counts,
  ];
  while (rightParts.length && stringWidth(`${left}  ${rightParts.join("  ")}`) > width)
    rightParts.shift();
  const right = rightParts.join("  ");
  const header = left + " ".repeat(Math.max(1, width - stringWidth(left + right))) + right;
  const blocks: { key: string; height: number; content: React.ReactNode }[] = [];
  if (model.message.length && (model.groups.length === 0 || model.screen !== "list")) {
    for (const [index, message] of model.message.entries())
      blocks.push({
        key: `message:${index}`,
        height: 1,
        content:
          model.screen === "probing" && index === 0 ? (
            <Text>
              {colors.fill(
                " ".repeat(Math.max(0, Math.floor((width - stringWidth(message) - 2) / 2))),
              )}
              <Glyph kind="probing" tone="muted" colors={colors} />
              {colors.fill(colors.paint(` ${message}`))}
            </Text>
          ) : (
            <Line width={width} colors={colors}>
              {colors.paint(
                pad("", Math.max(0, Math.floor((width - stringWidth(message)) / 2))) + message,
                index === 1 ? "muted" : "fg",
              )}
            </Line>
          ),
      });
  }
  for (const note of model.notes) {
    blocks.push({
      key: `${note.id}:heading`,
      height: 1,
      content: <NoteHeading title={note.title} width={width} colors={bodyColors} />,
    });
    const noteLines = [
      bodyColors.paint("│ ", "line") +
        bodyColors.paint(pad(truncate(note.text, width - 4), width - 4), "muted") +
        bodyColors.paint(" │", "line"),
      bodyColors.paint("│ ", "line") +
        bodyColors.paint(pad(truncate(note.command, width - 4), width - 4)) +
        bodyColors.paint(" │", "line"),
      bodyColors.paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, "line"),
    ];
    for (const [index, text] of noteLines.entries())
      blocks.push({
        key: `${note.id}:${index}`,
        height: 1,
        content: (
          <Line width={width} colors={bodyColors}>
            {text}
          </Line>
        ),
      });
  }
  if (model.moreNotes)
    blocks.push({
      key: "more-notes",
      height: 1,
      content: (
        <Line width={width} colors={bodyColors}>
          {bodyColors.paint(`+${model.moreNotes} more`, "signal")}
        </Line>
      ),
    });
  for (const group of model.groups) {
    const title = bodyColors.paint("── ", "line") + bodyColors.paint(`${group.title} `, "fg", true);
    const summary =
      bodyColors.paint(` ${group.summary} `, "muted") + bodyColors.paint("──", "line");
    blocks.push({
      key: `group:${group.id}`,
      height: 1,
      content: (
        <Line width={width} colors={bodyColors}>
          {title +
            bodyColors.paint(
              "─".repeat(Math.max(0, width - stringWidth(title + summary))),
              "line",
            ) +
            summary}
        </Line>
      ),
    });
    for (const row of group.rows)
      blocks.push({
        key: row.name,
        height: 2 + (model.layout === "narrow" ? 0 : row.subagents.length),
        content: (
          <RunRow
            row={row}
            model={model}
            colors={bodyColors}
            selected={model.selected === row.name}
          />
        ),
      });
    if (group.older)
      blocks.push({
        key: group.older.id,
        height: 1,
        content: (
          <Line width={width} colors={bodyColors} selected={model.selected === group.older.id}>
            {bodyColors.paint(group.older.text, "muted")}
          </Line>
        ),
      });
  }
  const available = Math.max(1, model.rows - 2);
  const offset = model.offset;
  let skipped = 0;
  const visible = blocks.flatMap((block) => {
    const before = skipped;
    skipped += block.height;
    return skipped > offset && before < offset + available
      ? [{ ...block, crop: Math.max(0, offset - before) }]
      : [];
  });
  const hints = model.footer.compact
    ? [
        ["?", "help"],
        ["q", "quit"],
      ]
    : [
        ["↑↓/jk", "select"],
        ["Enter", "expand"],
        ["a", model.footer.attentionOnly ? "all runs" : "attention"],
        ["?", "help"],
        ["q", "quit"],
      ];
  const footerHints =
    model.layout === "narrow" && !model.footer.compact
      ? hints.filter(([key]) => key !== "Enter")
      : hints;
  const footerLeft = footerHints
    .map(
      ([key, label]) =>
        colors.paint(key ?? "", "fg", true) + colors.paint(` ${label ?? ""}`, "muted"),
    )
    .join("  ");
  const footerRight = model.footer.compact
    ? ""
    : colors.paint(model.footer.status, model.footer.caution ? "interrupted" : "muted");
  const footer =
    footerLeft +
    " ".repeat(Math.max(1, width - stringWidth(footerLeft + footerRight))) +
    footerRight;
  return (
    <Box
      width={width}
      height={model.rows}
      flexDirection="column"
      backgroundColor={colors.background}
    >
      <Line width={width} colors={colors} bar>
        {header}
      </Line>
      {model.overlay ? (
        <Help model={model} colors={colors} />
      ) : (
        <Box
          flexDirection="column"
          height={available}
          overflow="hidden"
          justifyContent={model.groups.length ? "flex-start" : "center"}
        >
          {visible.map((block) => (
            <Box key={block.key} flexDirection="column" flexShrink={0} marginTop={-block.crop}>
              {block.content}
            </Box>
          ))}
        </Box>
      )}
      <Line width={width} colors={colors} bar>
        {footer}
      </Line>
    </Box>
  );
});
export function MonitorApp({
  model,
  colors,
  onKey,
  onTick,
}: {
  model: ViewModel;
  colors: Theme;
  onKey: (key: string) => void;
  onTick: (now: number) => void;
}) {
  const [now, setNow] = useState(model.now);
  useInput((input, key) => {
    if (key.ctrl && input === "c") onKey("ctrl-c");
    else if (key.upArrow) onKey("up");
    else if (key.downArrow) onKey("down");
    else if (key.pageUp) onKey("page-up");
    else if (key.pageDown) onKey("page-down");
    else if (key.return) onKey("enter");
    else if (key.escape) onKey("escape");
    else if (key.home) onKey("home");
    else if (key.end) onKey("end");
    else onKey(input);
  });
  useEffect(() => {
    if (!model.animating) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      onTick(time);
    }, 100);
    return () => clearInterval(timer);
  }, [model.animating, onTick]);
  return (
    <Tick value={now}>
      <Screen model={model} colors={colors} />
    </Tick>
  );
}
