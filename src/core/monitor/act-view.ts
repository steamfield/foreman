/**
 * The acting part of the monitor view model: mode chip, confirms, text boxes, notice and
 * footer hints, derived from `State.act` and the latest overview.
 */
import { DateTime } from "effect";
import {
  type ActView,
  type AnswerTarget,
  type ComposeTarget,
  isPending,
  targetKey,
  watchingView,
} from "./act";
import { confirmView } from "./act-confirm";
import { findRun } from "./act-target";
import { clockTime, duration, type State } from "./model";

/** Builds the acting portion of the screen without adding animation. */
export function actView(state: State): ActView {
  const { mode, overlay, notice } = state.act;
  const confirm = confirmView(state);
  let hints: ActView["hints"] = null;
  if (confirm) hints = confirm.keys;
  else if (overlay?.kind === "answer")
    hints = [
      { key: "enter", label: "send" },
      { key: "ctrl-d", label: "defer" },
      { key: "ctrl-e", label: "$EDITOR" },
      { key: "esc", label: "cancel" },
    ];
  else if (overlay?.kind === "compose")
    hints = [
      { key: "enter", label: "send" },
      { key: "ctrl-e", label: "$EDITOR" },
      { key: "esc", label: "cancel" },
    ];
  return {
    ...watchingView,
    chip: { mode, text: mode === "acting" ? "◆ acting" : "◇ watching" },
    notice,
    confirm,
    compose: overlay?.kind === "compose" ? composeView(state, overlay.target) : null,
    answer: overlay?.kind === "answer" ? answerView(state, overlay.target) : null,
    hints,
  };
}

function composeView(state: State, target: ComposeTarget): ActView["compose"] {
  const run = findRun(state, target.name);
  return {
    title: `${target.action === "steer" ? "steer" : "follow up"} ${target.name}`,
    meta: `turn ${run?.turn ?? target.turn} · ${run?.state ?? target.state} ${duration(state.now - (run ? DateTime.toEpochMillis(run.stateSince) : target.stateSince))}`,
    draft: state.act.drafts[targetKey(target)] ?? "",
    sending:
      state.act.inFlight?.intent.kind === target.action &&
      state.act.inFlight.intent.name === target.name,
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
