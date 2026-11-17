import cliTruncate from "cli-truncate";
import { Box, Text } from "ink";
import { createContext, memo, use } from "react";
import stringWidth from "string-width";
import type { Tone, ViewModel } from "../core/monitor/model";
import type { Theme } from "./theme";

/** Shares the animation timestamp with glyph cells. */
export const Tick = createContext(0);
const spinner = "⣾⣽⣻⢿⡿⣟⣯⣷";
/** Truncates terminal text to a measured cell width with an ellipsis. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return cliTruncate(text, width, { position: "end", truncationCharacter: "…" });
}
/** Pads terminal text to a measured cell width. */
export const pad = (text: string, width: number) =>
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
/** Renders a state glyph using the shared animation clock. */
export function Glyph({
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
/** Renders one filled terminal line within the requested cell width. */
export function Line({
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

/** Renders the monitor keyboard and glyph reference. */
export function Help({ model, colors }: { model: ViewModel; colors: Theme }) {
  const width = Math.min(76, model.columns);
  const lines = [
    "Monitor help",
    " ",
    "↑/k previous       ↓/j next",
    "Home first         End last",
    "PgUp scroll up     PgDn scroll down",
    model.detail ? "Tab next pane      j/k scroll pane" : "! needs me         Enter open / expand",
    "a answer           d defer",
    "s steer            F follow up",
    "i interrupt        x archive",
    "ctrl-e open $EDITOR in any text box",
    "w watch only       ! needs me",
    ...(model.detail
      ? ["PgUp/PgDn page      Home/End jump", "f follow feed      Esc return to list"]
      : []),
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

/** Formats the footer hints and connection status within the terminal width. */
export function monitorFooter(model: ViewModel, colors: Theme): string {
  const width = model.columns;
  const hints = model.footer.compact
    ? [
        ["?", "help"],
        ["q", "quit"],
      ]
    : [
        ["↑↓/jk", "select"],
        ["Enter", "open"],
        ["a", "answer"],
        ["d", "defer"],
        ["!", model.footer.attentionOnly ? "all runs" : "needs me"],
        ...(width >= 100
          ? [
              ["s", "steer"],
              ["i", "interrupt"],
            ]
          : []),
        ...(width >= 140
          ? [
              ["F", "follow up"],
              ["x", "archive"],
            ]
          : []),
        ["?", "help"],
        ["q", "quit"],
      ];
  const detailHints =
    model.detail && !model.footer.compact
      ? [
          ["Tab", "pane"],
          ["jk", "scroll"],
          ["f", "follow"],
          ["Esc", "list"],
          ...(width >= 80
            ? [
                ["a", "answer"],
                ["d", "defer"],
              ]
            : []),
          ...(width >= 100
            ? [
                ["s", "steer"],
                ["i", "interrupt"],
              ]
            : []),
          ...(width >= 140
            ? [
                ["F", "follow up"],
                ["x", "archive"],
              ]
            : []),
          ["?", "help"],
          ["q", "quit"],
        ]
      : hints;
  const footerHints =
    model.act.hints?.map(({ key, label }) => [key, label]) ??
    (model.layout === "narrow" && !model.footer.compact
      ? detailHints.filter(([key]) => key !== "Enter")
      : detailHints);
  const footerLeft = footerHints
    .map(
      ([key, label]) =>
        colors.paint(key ?? "", "fg", true) + colors.paint(` ${label ?? ""}`, "muted"),
    )
    .join("  ");
  const footerRight =
    model.footer.compact || stringWidth(footerLeft + model.footer.status) + 1 > width
      ? ""
      : colors.paint(model.footer.status, model.footer.caution ? "interrupted" : "muted");
  return (
    footerLeft +
    " ".repeat(Math.max(1, width - stringWidth(footerLeft + footerRight))) +
    footerRight
  );
}

/** Renders a waiting note heading and its shared-clock glyph. */
export const NoteHeading = memo(function NoteHeading({
  title,
  width,
  colors,
  saved,
}: {
  title: string;
  width: number;
  colors: Theme;
  saved: boolean;
}) {
  const label = truncate(title, width - 6);
  return (
    <Text wrap="truncate-end">
      {colors.fill(colors.paint("╭─ ", "line"))}
      {saved ? (
        colors.fill(colors.paint("■", "signal"))
      ) : (
        <Glyph kind="waiting" tone="signal" colors={colors} />
      )}
      {colors.fill(
        colors.paint(label.slice(1), "signal") +
          colors.paint(` ${"─".repeat(Math.max(0, width - stringWidth(label) - 6))}─╮`, "line"),
      )}
    </Text>
  );
});
