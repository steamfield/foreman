/**
 * The acting part of the monitor view model: mode chip, confirm box, answer box, notice and
 * footer hints, derived from `State.act` and the latest overview.
 */
import { DateTime } from "effect";
import { type ActView, type AnswerTarget, isPending, targetKey, watchingView } from "./act";
import { clockTime, duration, type State } from "./model";

/** Builds the acting portion of the screen without adding animation. */
export function actView(state: State): ActView {
  const { mode, overlay, notice } = state.act;
  const confirm = overlay?.kind === "confirm-acting";
  let hints: ActView["hints"] = null;
  if (confirm)
    hints = [
      { key: "y", label: "confirm" },
      { key: "n", label: "cancel" },
    ];
  else if (overlay?.kind === "answer")
    hints = [
      { key: "enter", label: "send" },
      { key: "ctrl-d", label: "defer" },
      { key: "esc", label: "cancel" },
    ];
  return {
    ...watchingView,
    chip: { mode, text: mode === "acting" ? "◆ acting" : "◇ watching" },
    notice,
    confirm: confirm
      ? {
          title: "Switch to acting?",
          lines: [
            "Acting keeps the daemon running while this monitor is open.",
            "Press w to return to watching.",
            "y confirm  n cancel",
          ],
          keys: [
            { key: "y", label: "confirm" },
            { key: "n", label: "cancel" },
          ],
        }
      : null,
    answer: overlay?.kind === "answer" ? answerView(state, overlay.target) : null,
    hints,
  };
}

function answerView(state: State, target: AnswerTarget): ActView["answer"] {
  const { inFlight, drafts } = state.act;
  return {
    title: `${target.name} ${target.question}`,
    meta: `${target.kind} · asked ${clockTime(DateTime.makeUnsafe(target.askedAt))} · waited ${duration(state.now - target.askedAt)}${target.defersAt === null ? "" : ` · defers in ${duration(target.defersAt - state.now)}`}`,
    question: target.text.replace(/[^\P{Cc}\n]/gu, " "),
    draft: drafts[targetKey(target)] ?? "",
    sending:
      inFlight?.intent.kind === "answer" &&
      inFlight.intent.name === target.name &&
      inFlight.intent.question === target.question,
    resolved: !isPending(state, target),
    alsoWaiting: `The delegating agent may answer too. First answer wins; the other side sees ${target.question} resolved.`,
  };
}
