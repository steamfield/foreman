/**
 * Pure state and view for acting from the monitor: the watching/acting mode, the confirm
 * step that switches to acting, text and action confirms, and the outcome line after an action.
 * Side effects never happen here. A request to act becomes `ActState.inFlight`, which
 * `src/tui/run.tsx` executes through `src/core/monitor/acting.ts` and reports back as an
 * `ActMessage`.
 */
import type { QuestionId, RunName } from "../../schemas/daemon";
import { reduceActMessage } from "./act-reducer";
import { targetKey as draftKey, isPending as pending } from "./act-target";
import type { DetailLine, State } from "./model-types";

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
  | { readonly kind: "defer"; readonly name: RunName; readonly question: QuestionId }
  | { readonly kind: "steer"; readonly name: RunName; readonly text: string }
  | { readonly kind: "followup"; readonly name: RunName; readonly text: string }
  | { readonly kind: "interrupt"; readonly name: RunName }
  | { readonly kind: "archive"; readonly name: RunName; readonly keepWorktree: boolean }
  | { readonly kind: "review"; readonly name: RunName };

/** The action keys that need acting; confirm-acting resumes the one that asked. */
export type ActAction =
  | "answer"
  | "defer"
  | "steer"
  | "followup"
  | "interrupt"
  | "archive"
  | "review";

/** The run a steer or follow-up box is open on, copied from the feed when it opened. */
export type ComposeTarget = {
  readonly action: "steer" | "followup";
  readonly name: RunName;
  readonly turn: number;
  readonly state: string;
  readonly stateSince: number;
};

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
  | { readonly kind: "confirm-acting"; readonly resume: ActAction }
  | { readonly kind: "answer"; readonly target: AnswerTarget }
  | { readonly kind: "compose"; readonly target: ComposeTarget }
  | { readonly kind: "confirm-interrupt"; readonly name: RunName }
  | { readonly kind: "confirm-archive"; readonly name: RunName }
  | null;

/** The line shown after an action finishes, until the next key. */
export type ActNotice = { readonly ok: boolean; readonly text: string; readonly at: number };

/** Acting mode, pending intent, retained drafts and the latest outcome notice. */
export type ActState = {
  readonly mode: ActMode;
  readonly overlay: ActOverlay;
  /** Unsent text, kept per `<run>/<question or action>` across cancel and reopen. */
  readonly drafts: Readonly<Record<string, string>>;
  readonly inFlight: { readonly id: number; readonly intent: ActIntent } | null;
  readonly nextId: number;
  readonly notice: ActNotice | null;
  /**
   * A request to edit the open box's draft in $EDITOR. The executor suspends the screen,
   * runs the editor and replies with `editor-result` carrying the same id.
   */
  readonly editor: { readonly id: number; readonly text: string } | null;
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
  | { readonly type: "acting-lost"; readonly text: string }
  /** The $EDITOR hand-off finished: new text, or null when it failed or was abandoned. */
  | {
      readonly type: "editor-result";
      readonly id: number;
      readonly text: string | null;
      readonly error: string | null;
    };

/** What the screen draws for acting. */
export type ActView = {
  readonly chip: { readonly mode: ActMode; readonly text: string };
  readonly confirm: {
    readonly title: string;
    readonly lines: readonly string[];
    /** The confirm's own keys, primary first, for example y interrupt, s steer instead, n cancel. */
    readonly keys: readonly { readonly key: string; readonly label: string }[];
  } | null;
  /** The steer or follow-up box. */
  readonly compose: {
    readonly title: string;
    readonly meta: string;
    readonly draft: string;
    readonly sending: boolean;
  } | null;
  readonly answer: {
    /** Up to three feed lines leading up to this question, when its detail is loaded. */
    readonly context: readonly DetailLine[];
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
  editor: null,
};

/** The acting view before any action: the watching chip and nothing else. */
export const watchingView: ActView = {
  chip: { mode: "watching", text: "◇ watching" },
  confirm: null,
  compose: null,
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
  return reduceActMessage(state, msg);
}

/** The draft key for a question or composed message. */
export const targetKey = draftKey;

/** Whether the latest feed still accepts an answer to this pending or deferred question. */
export const isPending = pending;
