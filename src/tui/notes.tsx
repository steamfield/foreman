import type { ViewModel } from "../core/monitor/model";
import { Line, NoteHeading, pad, truncate } from "./components";
import type { Theme } from "./theme";

/** Renders a pending question with a stronger monochrome frame and compact narrow action. */
export function QuestionNote({
  note,
  width,
  colors,
  saved,
}: {
  note: ViewModel["notes"][number];
  width: number;
  colors: Theme;
  saved: boolean;
}) {
  const heavy = colors.level === 0;
  const side = heavy ? "┃" : "│";
  const rule = heavy ? "━" : "─";
  let action = "";
  if (width < 100)
    action = note.command.startsWith("foreman answer") ? " a answer " : ` ${note.command} `;
  const lines = [
    colors.paint(`${side} `, "line") +
      colors.paint(pad(truncate(note.text, width - 4), width - 4), "muted") +
      colors.paint(` ${side}`, "line"),
    ...(width < 100
      ? []
      : [
          colors.paint(`${side} `, "line") +
            colors.paint(pad(truncate(note.command, width - 4), width - 4)) +
            colors.paint(` ${side}`, "line"),
        ]),
    colors.paint(heavy ? "┗" : "╰", "line") +
      colors.paint(action, "muted") +
      colors.paint(
        rule.repeat(Math.max(0, width - 2 - action.length)) + (heavy ? "┛" : "╯"),
        "line",
      ),
  ];
  return (
    <>
      <NoteHeading title={note.title} width={width} colors={colors} saved={saved} />
      {lines.map((text) => (
        <Line key={text} width={width} colors={colors}>
          {text}
        </Line>
      ))}
    </>
  );
}
