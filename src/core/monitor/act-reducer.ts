import { DateTime } from "effect";
import type { RunName } from "../../schemas/daemon";
import type { ActAction, ActIntent, ActMessage, ActOutcome, AnswerTarget } from "./act";
import {
  answerTarget,
  canDefer,
  eligible,
  ineligible,
  isPending,
  liveTarget,
  selectedRun,
  targetKey,
} from "./act-target";
import type { State } from "./model";

/** Reduces acting input to pure state changes and executor requests. */
export function reduceActMessage(
  state: State,
  msg: ActMessage | { readonly type: "key"; readonly key: string },
): State | null {
  if (msg.type === "act-outcome") return finish(state, msg.outcome);
  if (msg.type === "acting-lost") {
    const intent = state.act.inFlight?.intent;
    return notice(
      {
        ...state,
        act: { ...state.act, mode: "watching", overlay: null },
      },
      false,
      intent && "name" in intent
        ? `connection closed; outcome unknown · foreman status ${intent.name}`
        : msg.text,
    );
  }
  if (msg.type === "draft") return updateDraft(state, msg.text);
  if (msg.type === "editor-result") return editorResult(state, msg);
  if (state.act.notice) state = { ...state, act: { ...state.act, notice: null } };
  return actKey(state, msg.key);
}

function updateDraft(state: State, text: string): State {
  const overlay = state.act.overlay;
  if (overlay?.kind !== "answer" && overlay?.kind !== "compose") return state;
  return {
    ...state,
    act: { ...state.act, drafts: { ...state.act.drafts, [targetKey(overlay.target)]: text } },
  };
}

function editorResult(state: State, msg: Extract<ActMessage, { type: "editor-result" }>): State {
  const editor = state.act.editor;
  if (editor?.id !== msg.id) return state;
  const next = { ...state, act: { ...state.act, editor: null } };
  if (msg.text !== null)
    return {
      ...next,
      act: { ...next.act, drafts: { ...next.act.drafts, [editor.draftKey]: msg.text } },
    };
  return msg.error === null ? next : notice(next, false, msg.error);
}

function actKey(state: State, key: string): State | null {
  if (state.act.editor) return state;
  if (state.act.overlay) return overlayKey(state, key);
  if (state.help) return null;
  if (
    state.act.inFlight &&
    (["a", "d", "s", "F", "i", "x", "w"].includes(key) || (key === "r" && state.detail?.review))
  )
    return state;
  if (key === "r" && state.detail?.review) return open(state, "review");
  const action = {
    a: "answer",
    d: "defer",
    s: "steer",
    F: "followup",
    i: "interrupt",
    x: "archive",
  } as const;
  for (const [shortcut, value] of Object.entries(action))
    if (shortcut === key) return open(state, value);
  if (key === "w" && state.act.mode === "acting")
    return request({ ...state, act: { ...state.act, mode: "watching" } }, { kind: "leave-acting" });
  return null;
}

function overlayKey(state: State, key: string): State {
  const overlay = state.act.overlay;
  if (!overlay) return state;
  if (key === "escape" || (key === "n" && overlay.kind.startsWith("confirm-")))
    return { ...state, act: { ...state.act, overlay: null } };
  if (state.act.inFlight) return state;
  if (overlay.kind === "confirm-acting")
    return ["y", "enter"].includes(key)
      ? request(state, { kind: "enter-acting", resume: overlay.resume })
      : state;
  if (overlay.kind === "confirm-interrupt") {
    if (key === "y") return request(state, { kind: "interrupt", name: overlay.name });
    const run = selectedRun(state, overlay.name);
    return key === "s" && run && eligible("steer", run)
      ? open(state, "steer", overlay.name)
      : state;
  }
  if (overlay.kind === "confirm-archive")
    return ["y", "k"].includes(key)
      ? request(state, { kind: "archive", name: overlay.name, keepWorktree: key === "k" })
      : state;
  return textKey(state, key);
}

function textKey(state: State, key: string): State {
  const overlay = state.act.overlay;
  if (overlay?.kind !== "answer" && overlay?.kind !== "compose") return state;
  const text = state.act.drafts[targetKey(overlay.target)] ?? "";
  if (key === "ctrl-e")
    return {
      ...state,
      act: {
        ...state.act,
        editor: { id: state.act.nextId, text, draftKey: targetKey(overlay.target) },
        nextId: state.act.nextId + 1,
      },
    };
  if (overlay.kind === "answer" && key === "ctrl-d")
    return canDefer(state, overlay.target) ? send(state, overlay.target, "defer") : state;
  if (!["enter", "ctrl-s"].includes(key) || !text.trim()) return state;
  if (overlay.kind === "compose")
    return request(state, { kind: overlay.target.action, name: overlay.target.name, text });
  return isPending(state, overlay.target) ? send(state, overlay.target, "answer", text) : state;
}

function notice(state: State, ok: boolean, text: string): State {
  return { ...state, act: { ...state.act, notice: { ok, text, at: state.now } } };
}
function request(state: State, intent: ActIntent): State {
  return {
    ...state,
    act: { ...state.act, inFlight: { id: state.act.nextId, intent }, nextId: state.act.nextId + 1 },
  };
}
function send(state: State, target: AnswerTarget, kind: "answer" | "defer", text = ""): State {
  const question = { name: target.name, question: target.question };
  return request(state, kind === "answer" ? { kind, ...question, text } : { kind, ...question });
}

function open(state: State, resume: ActAction, name?: RunName): State {
  if (!liveTarget(state))
    return notice(
      state,
      false,
      "Acting needs a running foreman daemon of this build; foreman status <run> starts supervision.",
    );
  const answer = resume === "answer" || resume === "defer" ? answerTarget(state) : null;
  const run = selectedRun(state, name);
  if (resume === "answer" || resume === "defer") {
    if (!answer || (resume === "defer" && !canDefer(state, answer)))
      return notice(state, false, "Nothing is waiting for an answer.");
  } else {
    if (!run) return notice(state, false, "Select a run first.");
    if (!eligible(resume, run)) return notice(state, false, ineligible(resume, run));
  }
  if (state.act.mode === "watching")
    return { ...state, act: { ...state.act, overlay: { kind: "confirm-acting", resume } } };
  if (answer)
    return resume === "defer"
      ? send(state, answer, "defer")
      : { ...state, act: { ...state.act, overlay: { kind: "answer", target: answer } } };
  if (!run) return state;
  if (resume === "review") return request(state, { kind: "review", name: run.name });
  if (resume === "steer" || resume === "followup")
    return {
      ...state,
      act: {
        ...state.act,
        overlay: {
          kind: "compose",
          target: {
            action: resume,
            name: run.name,
            turn: run.turn,
            state: run.state,
            stateSince: DateTime.toEpochMillis(run.stateSince),
          },
        },
      },
    };
  const overlay =
    resume === "interrupt"
      ? { kind: "confirm-interrupt" as const, name: run.name }
      : { kind: "confirm-archive" as const, name: run.name };
  return { ...state, act: { ...state.act, overlay } };
}

function finish(state: State, outcome: ActOutcome): State {
  const flight = state.act.inFlight;
  if (!flight || flight.id !== outcome.id) return state;
  const { intent } = flight;
  const overlay = state.act.overlay;
  let next = notice({ ...state, act: { ...state.act, inFlight: null } }, outcome.ok, outcome.text);
  if (intent.kind === "enter-acting") {
    if (overlay?.kind !== "confirm-acting")
      return outcome.ok ? request(next, { kind: "leave-acting" }) : next;
    next = {
      ...next,
      act: { ...next.act, mode: outcome.ok ? "acting" : "watching", overlay: null },
    };
    return outcome.ok ? open(next, intent.resume) : next;
  }
  if (outcome.ok && intent.kind !== "leave-acting") {
    const drafts = { ...next.act.drafts };
    if (intent.kind === "answer" || intent.kind === "defer") delete drafts[targetKey(intent)];
    if (intent.kind === "steer" || intent.kind === "followup")
      delete drafts[targetKey({ name: intent.name, action: intent.kind })];
    return { ...next, act: { ...next.act, drafts, overlay: null } };
  }
  return next;
}
