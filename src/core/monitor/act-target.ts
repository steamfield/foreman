import { DateTime } from "effect";
import type { RunName } from "../../schemas/daemon";
import type { RunView } from "../../schemas/monitor";
import type { ActAction, AnswerTarget, ComposeTarget } from "./act";
import { grouped, type State } from "./model";

/** The retained draft key for an answer or composed message. */
export const targetKey = (
  target: Pick<AnswerTarget, "name" | "question"> | Pick<ComposeTarget, "name" | "action">,
) => `${target.name}/${"question" in target ? target.question : target.action}`;

/** Finds a run by name, preferring the open detail's fresher row. */
export function findRun(state: State, name: string | null): RunView | null {
  const detail = state.detail?.feed;
  if (state.detail?.name === name && detail && detail._tag !== "Archived") {
    const data = detail._tag === "Reconnecting" ? detail.last : detail.detail;
    if (data) return data.run;
  }
  const feed = state.feed;
  const overview = feed?._tag === "Reconnecting" ? feed.last : feed?.overview;
  return overview?.runs.find((run) => run.name === name) ?? null;
}

/** Whether an action can target the run's current state. */
export function eligible(action: ActAction, run: RunView): boolean {
  switch (action) {
    case "steer":
      return ["running", "starting"].includes(run.state);
    case "followup":
      return ["idle", "failed", "interrupted"].includes(run.state);
    case "interrupt":
      return ["running", "starting", "waiting"].includes(run.state);
    case "archive":
      return ["idle", "failed", "interrupted", "lost", "unknown"].includes(run.state);
    case "answer":
    case "defer":
      return run.questions.length > 0;
  }
}

/** Gives a state-specific explanation when a run cannot accept an action. */
export function ineligible(action: ActAction, run: RunView): string {
  const reason = {
    answer: "nothing is waiting for an answer.",
    defer: "nothing is waiting for an answer.",
    steer: "steer works while its turn is starting or running.",
    followup: "follow up works once its turn ends.",
    interrupt: "interrupt works while its turn is starting, running or waiting.",
    archive: "archive works once its turn ends.",
  }[action];
  return `${run.name} is ${run.state}; ${reason}`;
}

/** Whether the latest feed still lists the target question as pending. */
export function isPending(state: State, target: AnswerTarget): boolean {
  return findRun(state, target.name)?.questions.some((q) => q.id === target.question) ?? false;
}

/** Finds the selected question, falling back to the first attention note in the list. */
export function answerTarget(state: State): AnswerTarget | null {
  const selected = findRun(state, state.detail?.name ?? state.selected);
  let run = selected;
  if (!state.detail && (selected?.state !== "waiting" || !selected.questions.length))
    run =
      grouped(state)
        .flatMap((group) => group.runs)
        .find((run) => run.questions.length) ?? null;
  const q = run?.questions[0];
  return run && q
    ? {
        name: run.name,
        question: q.id,
        kind: q.kind,
        text: q.text,
        askedAt: DateTime.toEpochMillis(q.askedAt),
        defersAt: q.defersAt === null ? null : DateTime.toEpochMillis(q.defersAt),
      }
    : null;
}

/** Whether the currently targeted feed is connected to the running daemon. */
export function liveTarget(state: State): boolean {
  return (state.detail?.feed ?? state.feed)?._tag === "Live";
}

/** The run selected by a list or detail action, with no attention fallback. */
export const selectedRun = (state: State, name?: RunName) =>
  findRun(state, name ?? state.detail?.name ?? state.selected);
