import chalk, { Chalk, type ColorSupportLevel } from "chalk";
import type { Tone } from "../core/monitor/model-types";

export const tokens = {
  console: "#121412",
  "console-2": "#1B1E1A",
  "console-line": "#2D322B",
  "console-fg": "#E4E8E0",
  "console-muted": "#9AA294",
  signal: "#FF5B14",
  "state-running": "#6FA8FF",
  "state-done": "#5CC98A",
  "state-failed": "#FF7A70",
  "state-interrupted": "#E2C04F",
} as const;
const tones = {
  fg: "console-fg",
  muted: "console-muted",
  line: "console-line",
  signal: "signal",
  running: "state-running",
  done: "state-done",
  failed: "state-failed",
  interrupted: "state-interrupted",
} as const;
export function theme(level: ColorSupportLevel = chalk.level, noColor = false, subdued = false) {
  const capability = noColor ? 0 : level;
  const color = new Chalk({ level: capability });
  const weight = new Chalk({ level: 1 });
  return {
    level: capability,
    background: capability >= 2 ? tokens.console : undefined,
    barBackground: capability >= 2 ? tokens["console-2"] : undefined,
    paint(text: string, tone: Tone = "fg", bold = false): string {
      if (subdued && tone !== "line") tone = "muted";
      let style = color;
      if (capability >= 2) style = color.hex(tokens[tones[tone]]);
      else if (capability === 1) {
        if (tone === "signal") style = color.redBright.bold;
        else if (tone === "running") style = color.blue;
        else if (tone === "done") style = color.green;
        else if (tone === "failed") style = color.red;
        else if (tone === "interrupted") style = color.yellow;
      }
      const painted = style(text);
      return bold ? weight.bold(painted) : painted;
    },
    select(text: string) {
      if (capability === 0) return weight.inverse(text);
      if (capability >= 2) return color.bgHex(tokens["console-2"])(text);
      return weight.inverse(text);
    },
    fill(text: string, bar = false) {
      return capability >= 2 ? color.bgHex(bar ? tokens["console-2"] : tokens.console)(text) : text;
    },
  };
}
export type Theme = ReturnType<typeof theme>;
