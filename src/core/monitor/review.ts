import type { Detail } from "../../schemas/monitor";
import { changedRows, changesMessage } from "./changed-files";
import { clockTime, duration } from "./format";
import type { ReviewView, State } from "./model-types";

/** Builds the finished run's hand-off, deferred decisions and scope summary. */
export function reviewView(state: State, data: Detail | null): ReviewView | null {
  const detail = state.detail;
  if (!detail?.review || !data) return null;
  const files = changedRows(detail.changes);
  const outside = files.filter((file) => file.outside).length;
  const reviewed = data.run.reviewedAt !== null;
  const budget = data.run.turnBudgetMs === null ? "no limit" : duration(data.run.turnBudgetMs);
  return {
    summary: `${data.run.turn} turn${data.run.turn === 1 ? "" : "s"} · ${duration(data.digest.elapsedMs)} of ${budget} · ${data.digest.commands.total} commands · ${files.length} files · ${outside} outside scope · ${reviewed ? "reviewed" : "not reviewed"}`,
    reviewed,
    handoff: data.handoff
      ? {
          title: `Hand-off · turn ${data.handoff.turn} · ${handoffTime(detail, data)}`,
          lines: data.handoff.text.split(/\r?\n/).map((line) => line.replace(/\p{Cc}/gu, " ")),
        }
      : null,
    decided: decisions(detail, data),
    files,
    filesNote: outside === 0 ? "all in scope" : `${outside} outside scope`,
    filesMessage: changesMessage(detail.changes),
    focus: detail.reviewFocus,
    lateAnswerHint: "a answer late (starts a follow-up turn)",
  };
}

function handoffTime(detail: NonNullable<State["detail"]>, data: Detail): string {
  const turn = data.handoff?.turn;
  const completed = detail.events.findLast(
    (entry) => entry.event._tag === "TurnCompleted" && entry.event.turn === turn,
  );
  if (completed) return clockTime(completed.at);
  const message = detail.events.findLast(
    (entry) => entry.event._tag === "AgentMessage" && entry.event.text === data.handoff?.text,
  );
  if (message) return clockTime(message.at);
  return turn === data.run.turn ? clockTime(data.run.stateSince) : "time unavailable";
}

function decisions(detail: NonNullable<State["detail"]>, data: Detail): ReviewView["decided"] {
  return data.questions.flatMap((question) => {
    const deferred = detail.events.find(
      (entry) =>
        entry.event._tag === "QuestionResolved" &&
        entry.event.id === question.id &&
        entry.event.resolution === "deferred",
    );
    if (!deferred && question.status !== "deferred") return [];
    const after = deferred
      ? detail.events.find(
          (entry) => entry.seq > deferred.seq && entry.event._tag === "AgentMessage",
        )?.event
      : null;
    const firstLine =
      after?._tag === "AgentMessage"
        ? after.text.split(/\r?\n/, 1)[0]?.replace(/\p{Cc}/gu, " ")
        : null;
    return [
      {
        question: question.text.replace(/\p{Cc}/gu, " "),
        asked: clockTime(question.askedAt),
        outcome: firstLine ? `→ Codex went with: ${firstLine}` : "→ deferred, no answer recorded",
      },
    ];
  });
}
