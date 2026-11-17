/**
 * Pure state and view for acting from the monitor: the watching/acting mode, the confirm
 * step that switches to acting, the answer box, and the outcome line after an action.
 * Side effects never happen here. A request to act becomes `ActState.inFlight`, which
 * `src/tui/run.tsx` executes through `src/core/monitor/acting.ts` and reports back as an
 * `ActMessage`.
 */
import { DateTime } from "effect";
import type { QuestionId, RunName } from "../../schemas/daemon";
import { grouped, type State } from "./model";

/** Watching is the passive 0.2.0 connection; acting holds an active one. */
export type ActMode = "watching" | "acting";

/** One request the monitor wants the daemon to carry out. */
export type ActIntent =
  | { readonly kind: "enter-acting" }
  | { readonly kind: "leave-acting" }
  | {
      readonly kind: "answer";
      readonly name: RunName;
      readonly question: QuestionId;
      readonly text: string;
    }
  | { readonly kind: "defer"; readonly name: RunName; readonly question: QuestionId };

/** The question an answer box is open on, copied from the feed when the box opened. */
export type AnswerTarget = {
  readonly name: RunName;
  readonly question: QuestionId;
  readonly kind: string;
  readonly text: string;
  readonly askedAt: number;
  readonly defersAt: number | null;
};

/** At most one overlay belongs to acting at a time. */
export type ActOverlay =
  | { readonly kind: "confirm-acting"; readonly resume: "answer" | "defer" }
  | { readonly kind: "answer"; readonly target: AnswerTarget }
  | null;

/** The line shown after an action finishes, until the next key. */
export type ActNotice = { readonly ok: boolean; readonly text: string; readonly at: number };

/** Acting mode, pending intent, retained drafts and the latest outcome notice. */
export type ActState = {
  readonly mode: ActMode;
  readonly overlay: ActOverlay;
  /** Unsent answer text, kept per `<run>/<question>` across cancel and reopen. */
  readonly drafts: Readonly<Record<string, string>>;
  readonly inFlight: { readonly id: number; readonly intent: ActIntent } | null;
  readonly nextId: number;
  readonly notice: ActNotice | null;
};

/** What the executor reports for one in-flight intent. */
export type ActOutcome =
  | { readonly ok: true; readonly id: number; readonly text: string }
  | { readonly ok: false; readonly id: number; readonly text: string };

/** Input and executor messages owned by the acting reducer. */
export type ActMessage =
  | { readonly type: "act-outcome"; readonly outcome: ActOutcome }
  | { readonly type: "draft"; readonly text: string }
  /** The acting connection closed without being asked to; the monitor drops to watching. */
  | { readonly type: "acting-lost"; readonly text: string };

/** What the screen draws for acting. */
export type ActView = {
  readonly chip: { readonly mode: ActMode; readonly text: string };
  readonly confirm: { readonly title: string; readonly lines: readonly string[] } | null;
  readonly answer: {
    readonly title: string;
    readonly meta: string;
    readonly question: string;
    readonly draft: string;
    readonly sending: boolean;
    /** The feed shows the question resolved while the box was open; sending is refused. */
    readonly resolved: boolean;
    readonly alsoWaiting: string;
  } | null;
  readonly notice: ActNotice | null;
  /** Footer key hints while an acting overlay is open; null leaves the screen's own. */
  readonly hints: readonly { readonly key: string; readonly label: string }[] | null;
};

/** Starts a passive monitor with no drafts or requests. */
export const initialAct: ActState = {
  mode: "watching",
  overlay: null,
  drafts: {},
  inFlight: null,
  nextId: 1,
  notice: null,
};

/** The acting view before any action: the watching chip and nothing else. */
export const watchingView: ActView = {
  chip: { mode: "watching", text: "◇ watching" },
  confirm: null,
  answer: null,
  notice: null,
  hints: null,
};

/**
 * Handles keys and act messages that belong to acting.
 * Returns null when the message is not acting's, so `reduce` handles it as before.
 */
export function reduceAct(
  state: State,
  msg: ActMessage | { readonly type: "key"; readonly key: string },
): State | null {
  if (msg.type === "act-outcome") return finish(state, msg.outcome);
  if (msg.type === "acting-lost")
    return notice(
      { ...state, act: { ...state.act, mode: "watching", overlay: null, inFlight: null } },
      false,
      msg.text,
    );
  if (msg.type === "draft") {
    const overlay = state.act.overlay;
    return overlay?.kind === "answer"
      ? {
          ...state,
          act: {
            ...state.act,
            drafts: { ...state.act.drafts, [targetKey(overlay.target)]: msg.text },
          },
        }
      : state;
  }
  if (state.act.notice) state = { ...state, act: { ...state.act, notice: null } };
  return actKey(state, msg.key);
}

function actKey(state: State, key: string): State | null {
  if (state.act.inFlight && ["a", "d", "w", "y", "enter", "ctrl-s", "ctrl-d"].includes(key))
    return state;
  const overlay = state.act.overlay;
  if (overlay) {
    if (key === "escape" || (overlay.kind === "confirm-acting" && key === "n"))
      return { ...state, act: { ...state.act, overlay: null } };
    if (overlay.kind === "confirm-acting")
      return ["y", "enter"].includes(key) ? request(state, { kind: "enter-acting" }) : state;
    if (key === "ctrl-d") return send(state, overlay.target, "defer");
    if (["enter", "ctrl-s"].includes(key)) {
      const text = state.act.drafts[targetKey(overlay.target)] ?? "";
      return text.trim() && isPending(state, overlay.target)
        ? send(state, overlay.target, "answer", text)
        : state;
    }
    return state;
  }
  if (state.help) return null;
  if (key === "a" || key === "d") return open(state, key === "a" ? "answer" : "defer");
  if (key === "w" && state.act.mode === "acting")
    return request({ ...state, act: { ...state.act, mode: "watching" } }, { kind: "leave-acting" });
  return null;
}

/** The drafts key for a question: `<run>/<question>`. */
export const targetKey = (target: Pick<AnswerTarget, "name" | "question">) =>
  `${target.name}/${target.question}`;

/** Whether the latest overview still lists the target question as pending. */
export function isPending(state: State, target: AnswerTarget): boolean {
  const feed = state.feed;
  const overview = feed?._tag === "Reconnecting" ? feed.last : feed?.overview;
  return (
    overview?.runs.some(
      (run) => run.name === target.name && run.questions.some((q) => q.id === target.question),
    ) ?? false
  );
}
function target(state: State): AnswerTarget | null {
  const runs = grouped(state).flatMap((group) => group.runs);
  const selected = runs.find((run) => run.name === (state.detail?.name ?? state.selected));
  let run = selected;
  if (!state.detail && (selected?.state !== "waiting" || !selected.questions.length))
    run = runs.find((run) => run.questions.length);
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
function open(state: State, resume: "answer" | "defer"): State {
  if (state.feed?._tag !== "Live")
    return notice(
      state,
      false,
      "Acting needs a running foreman daemon of this build; foreman status <run> starts supervision.",
    );
  const found = target(state);
  if (!found) return notice(state, false, "Nothing is waiting for an answer.");
  if (state.act.mode === "watching")
    return { ...state, act: { ...state.act, overlay: { kind: "confirm-acting", resume } } };
  return resume === "defer"
    ? send(state, found, "defer")
    : { ...state, act: { ...state.act, overlay: { kind: "answer", target: found } } };
}
function finish(state: State, outcome: ActOutcome): State {
  const flight = state.act.inFlight;
  if (!flight || flight.id !== outcome.id) return state;
  const { intent } = flight;
  const overlay = state.act.overlay;
  let next = notice({ ...state, act: { ...state.act, inFlight: null } }, outcome.ok, outcome.text);
  if (intent.kind === "enter-acting") {
    next = {
      ...next,
      act: { ...next.act, mode: outcome.ok ? "acting" : "watching", overlay: null },
    };
    return outcome.ok && overlay?.kind === "confirm-acting" ? open(next, overlay.resume) : next;
  }
  if (outcome.ok && (intent.kind === "answer" || intent.kind === "defer")) {
    const drafts = { ...next.act.drafts };
    delete drafts[targetKey(intent)];
    return { ...next, act: { ...next.act, drafts, overlay: null } };
  }
  return next;
}
