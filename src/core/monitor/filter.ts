import type { HistoryEntry, RunView } from "../../schemas/monitor";
import type { FilterBarView, State } from "./model-types";
import { pinnedKinds } from "./pinned";

const tokens = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);
type Subject = Pick<RunView, "name" | "title" | "repo" | "state" | "model" | "effort"> & {
  readonly activity?: RunView["activity"];
  readonly needsMe?: boolean;
};

/** Matches every filter token against a run's searchable facts. */
export function matchesFilter(subject: Subject, text: string, history = false): boolean {
  return tokens(text).every((token) => {
    if (token.startsWith("state:")) return token.slice(6).split(",").includes(subject.state);
    if (token.startsWith("repo:")) return subject.repo.toLowerCase().includes(token.slice(5));
    if (token.startsWith("model:"))
      return `${subject.model} ${subject.effort}`.toLowerCase().includes(token.slice(6));
    if (token === "needs:me") return subject.needsMe === true;
    const fields = [subject.name, subject.title ?? "", subject.activity?.text ?? ""];
    if (history) fields.push(subject.repo);
    return fields.some((field) => field.toLowerCase().includes(token));
  });
}

/** Whether the filter contains the needs-me token. */
export const needsMeFilter = (text: string): boolean => tokens(text).includes("needs:me");

/** Adds or removes needs:me without discarding other filter tokens. */
export function toggleNeedsMe(text: string): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return needsMeFilter(text)
    ? parts.filter((part) => part.toLowerCase() !== "needs:me").join(" ")
    : [...parts, "needs:me"].join(" ");
}

/** Matches list rows using the same attention reasons as the pinned block. */
export function matchesRun(run: RunView, state: State): boolean {
  const supervised = !(state.feed?._tag === "Saved" && state.feed.reason === "no-daemon");
  const needsMe = run.questions.length > 0 || pinnedKinds(run, state.now, supervised).length > 0;
  if (state.attentionOnly && !state.filter.text.trim() && !needsMe) return false;
  return matchesFilter({ ...run, needsMe }, state.filter.text);
}

/** Builds filter counts for the active screen, including matching collapsed runs. */
export function filterBar(state: State, runs: readonly RunView[]): FilterBarView | null {
  if (!state.filter.editing && !state.filter.text.trim()) return null;
  const entries = state.history ? (state.history.entries ?? []) : runs;
  const hidden: readonly (RunView | HistoryEntry)[] = state.history
    ? entries.filter((entry) => !matchesFilter(entry, state.filter.text, true))
    : runs.filter((run) => !matchesRun(run, state));
  return {
    ...state.filter,
    shown: entries.length - hidden.length,
    total: entries.length,
    hiddenWaiting: hidden.filter((entry) => entry.state === "waiting").length,
  };
}
