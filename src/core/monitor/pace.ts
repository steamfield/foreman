import { activeStates } from "../../schemas/daemon";
import { PACE_MINUTES, type RunView } from "../../schemas/monitor";

const CELLS = "▁▂▃▄▅▆▇█";

/** Scales a live pace window to its own maximum, distinguishing inactivity from unknown data. */
export function pace(run: RunView, live: boolean): string | null {
  if (!live || run.pace.length === 0) return activeStates.has(run.state) ? null : "·";
  const window = run.pace.slice(-PACE_MINUTES);
  const values = [...Array<number>(PACE_MINUTES - window.length).fill(0), ...window];
  const maximum = Math.max(...values);
  return values
    .map((value) => CELLS[maximum === 0 ? 0 : Math.floor((value / maximum) * 7)])
    .join("");
}
