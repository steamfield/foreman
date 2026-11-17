import type { ActAction } from "./act";
import { eligible, selectedRun } from "./act-target";
import { nextGrouping } from "./list-groups";
import type { PaletteView, State } from "./model";

type Item = { readonly label: string; readonly key: string | null; readonly command?: string };
const actions: readonly { action: ActAction; label: string; key: string }[] = [
  { action: "interrupt", label: "interrupt", key: "i" },
  { action: "steer", label: "steer", key: "s" },
  { action: "followup", label: "follow up", key: "F" },
  { action: "answer", label: "answer", key: "a" },
  { action: "defer", label: "defer", key: "d" },
  { action: "archive", label: "archive", key: "x" },
];

function items(state: State): Item[] {
  const run = selectedRun(state);
  const result: Item[] = [];
  if (run) {
    for (const action of actions) {
      if (!eligible(action.action, run)) continue;
      const question = action.action === "answer" || action.action === "defer";
      result.push({
        label: question ? `${action.label} ${run.questions[0]?.id}` : action.label,
        key: action.key,
      });
    }
    for (const command of ["answer", "steer", "followup", "interrupt", "status"]) {
      let text = `foreman ${command} ${run.name}`;
      if (command === "answer") text += ` ${run.questions[0]?.id ?? "<q>"}`;
      if (["answer", "steer", "followup"].includes(command)) text += " --file <path>";
      result.push({ label: `copy command: ${text}`, key: null, command: text });
    }
  }
  result.push(
    { label: `group by ${nextGrouping(state.grouping)}`, key: "g" },
    { label: "history", key: "h" },
    { label: "filter", key: "/" },
    { label: "help", key: "?" },
  );
  const query = state.palette?.query.toLowerCase() ?? "";
  return result.filter((item) => item.label.toLowerCase().includes(query));
}

/** Builds the palette with a non-selectable acting explanation above eligible actions. */
export function paletteView(state: State): PaletteView | null {
  if (!state.palette) return null;
  const index = Math.min(state.palette.index, Math.max(0, items(state).length - 1));
  const rows: PaletteView["items"][number][] = items(state).map((item, i) => ({
    label: item.label,
    key: item.key,
    detail: "",
    selected: i === index,
    heading: false,
  }));
  if (
    state.act.mode === "watching" &&
    rows.some((item) => actions.some((action) => action.key === item.key))
  )
    rows.unshift({
      label: "actions switch the monitor to acting",
      key: null,
      detail: "",
      selected: false,
      heading: true,
    });
  return { query: state.palette.query, subject: selectedRun(state)?.name ?? null, items: rows };
}

/** Edits or executes the palette, returning a shortcut for the existing reducer to dispatch. */
export function paletteKey(state: State, key: string): State | string {
  const palette = state.palette;
  if (!palette) return state;
  if (key === "escape") return { ...state, palette: null };
  const matches = items(state);
  const index = Math.min(palette.index, Math.max(0, matches.length - 1));
  if (key === "up" || key === "down")
    return {
      ...state,
      palette: {
        ...palette,
        index: Math.max(0, Math.min(matches.length - 1, index + (key === "up" ? -1 : 1))),
      },
    };
  if (key === "enter") {
    const item = matches[index];
    if (!item) return state;
    if (item.command) return copy(state, item.command);
    return item.key ?? state;
  }
  if (key === "backspace")
    return { ...state, palette: { query: [...palette.query].slice(0, -1).join(""), index: 0 } };
  if ([...key].length === 1 && !/\p{Cc}/u.test(key))
    return { ...state, palette: { query: palette.query + key, index: 0 } };
  return state;
}

function copy(state: State, text: string): State {
  return {
    ...state,
    palette: null,
    clipboard: { id: (state.clipboard?.id ?? 0) + 1, text },
    act: { ...state.act, notice: { ok: true, text: `copied: ${text}`, at: state.now } },
  };
}
