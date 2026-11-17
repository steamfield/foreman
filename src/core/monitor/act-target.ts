import { DateTime } from "effect";
import type { RunName } from "../../schemas/daemon";
import type { RunView } from "../../schemas/monitor";
import type { ActAction, AnswerTarget, ComposeTarget } from "./act";
import { grouped } from "./list-groups";
import type { State } from "./model-types";

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
    case "review":
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
    review: "review works once its turn ends.",
  }[action];
  return `${run.name} is ${run.state}; ${reason}`;
}

/** Whether the latest feed still accepts an answer to this pending or deferred question. */
export function isPending(state: State, target: AnswerTarget): boolean {
  return (
    (findRun(state, target.name)?.questions.some((q) => q.id === target.question) ?? false) ||
    (state.detail?.name === target.name && deferredQuestion(state, target.question) !== null)
  );
}

/** Finds the selected question, falling back to the first attention note in the list. */
export function answerTarget(state: State): AnswerTarget | null {
  const selected = findRun(state, state.detail?.name ?? state.selected);
  let run = selected;
  if (!state.detail && !selected?.questions.length)
    run =
      grouped(state)
        .flatMap((group) => group.runs)
        .find((run) => run.questions.length) ?? null;
  const q = run?.questions[0] ?? deferredQuestion(state);
  return run && q
    ? {
        name: run.name,
        question: q.id,
        kind: q.kind,
        text: q.text,
        askedAt: DateTime.toEpochMillis(q.askedAt),
        defersAt:
          "defersAt" in q && q.defersAt !== null ? DateTime.toEpochMillis(q.defersAt) : null,
      }
    : null;
}

function deferredQuestion(state: State, id?: AnswerTarget["question"]) {
  const detail = state.detail;
  if (!detail?.review || !detail.feed || detail.feed._tag === "Archived") return null;
  const data = detail.feed._tag === "Reconnecting" ? detail.feed.last : detail.feed.detail;
  return (
    data?.questions.find((q) => q.status === "deferred" && (id === undefined || q.id === id)) ??
    null
  );
}

/** Whether the currently targeted feed is connected to the running daemon. */
export function liveTarget(state: State): boolean {
  return (state.detail?.feed ?? state.feed)?._tag === "Live";
}

/** The run selected by a list or detail action, with no attention fallback. */
export const selectedRun = (state: State, name?: RunName) =>
  findRun(state, name ?? state.detail?.name ?? state.selected);
