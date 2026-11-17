/**
 * Pure state and view for acting from the monitor: the watching/acting mode, the confirm
 * step that switches to acting, the answer box, and the outcome line after an action.
 * Side effects never happen here. A request to act becomes `ActState.inFlight`, which
 * `src/tui/run.tsx` executes through `src/core/monitor/acting.ts` and reports back as an
 * `ActMessage`.
 */
import type { QuestionId, RunName } from "../../schemas/daemon";
import type { State } from "./model";

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
  _state: State,
  _msg: ActMessage | { readonly type: "key"; readonly key: string },
): State | null {
  throw new Error("not implemented");
}

/** Builds the acting part of the view model. */
export function actView(_state: State): ActView {
  throw new Error("not implemented");
}
