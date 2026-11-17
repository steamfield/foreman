import { Text } from "ink";
import stringWidth from "string-width";
import { stateLegend } from "../core/monitor/legend";
import type { Tone, ViewModel } from "../core/monitor/model";
import { Glyph, Line } from "./components";
import type { Theme } from "./theme";

function introduction(text: string, colors: Theme): string {
  const state = stateLegend.find(({ glyph, state }) =>
    text.trimStart().startsWith(`${glyph}  ${state}`),
  );
  if (state) {
    const tone: Tone = state.state === "waiting" ? "signal" : state.state;
    return colors.paint(`  ${state.glyph}`, tone) + colors.paint(text.slice(3));
  }
  if (text.startsWith("  ━━━"))
    return `  ${colors.paint("━━━")}${colors.paint("───", "line")}${colors.paint(text.slice(8))}`;
  if (text.includes("foreman doctor") || text.includes("foreman skill install")) {
    const command = text.indexOf("foreman ");
    return colors.paint(text.slice(0, command)) + colors.paint(text.slice(command), "fg", true);
  }
  const muted =
    text.startsWith("  “") ||
    text === "What you will see here" ||
    text.startsWith("This screen updates");
  return colors.paint(text, muted ? "muted" : "fg", text === "No runs on this machine yet.");
}

/** Builds the centred status or onboarding block with one terminal row per message. */
export function messageBlocks(model: ViewModel, colors: Theme) {
  if (!model.message.length || (model.groups.length > 0 && model.screen === "list")) return [];
  const width = model.columns;
  return model.message.map((message, index) => {
    const indent = model.firstRun
      ? Math.max(0, Math.floor((width - 80) / 2))
      : Math.max(0, Math.floor((width - stringWidth(message)) / 2));
    const content =
      model.screen === "probing" && index === 0 ? (
        <Text key={message}>
          {colors.fill(" ".repeat(Math.max(0, indent - 1)))}
          <Glyph kind="probing" tone="muted" colors={colors} />
          {colors.fill(colors.paint(` ${message}`))}
        </Text>
      ) : (
        <Line key={message} width={width} colors={colors}>
          {" ".repeat(indent) +
            (model.firstRun
              ? introduction(message, colors)
              : colors.paint(message, index === 1 ? "muted" : "fg"))}
        </Line>
      );
    return { key: `message:${index}`, height: 1, content };
  });
}
