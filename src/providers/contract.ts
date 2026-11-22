/**
 * The contract between the supervisor and a coding-agent provider (Codex, agy).
 *
 * A provider turns its wire protocol into ProviderEvents and QuestionCalls, and accepts the
 * commands the supervisor issues for a run. The supervisor owns every run state machine
 * (states, budgets, questions, hand-offs, hook enforcement); a provider owns decoding, its own
 * ids and its child process. docs/rfcs/0002-providers.md is the design.
 *
 * Types, internal tagged errors and one predicate only: nothing here performs I/O.
 */
import { type Cause, Data, type Effect, type Scope, type Stream } from "effect";
import {
  AgyUnavailable,
  CodexUnavailable,
  type ModelUnresolved,
  type PermissionDenied,
  type RepoHooksUntrusted,
} from "../errors";
import type { RunFailure as RunFailureSchema, TokenTotals, TurnKind } from "../schemas/daemon";

type RunFailure = typeof RunFailureSchema.Type;

import type { Access, ProviderId } from "../schemas/provider";
import type { RpcError, RpcRequestTimeout } from "./jsonrpc";

export type { Access, ProviderId, RpcError, RpcRequestTimeout };

/** The provider's conversation id: a Codex thread id or an agy session id. */
export type SessionId = string;
/** The provider's turn id. agy mints `t<turn number>`; Codex supplies its own. */
export type TurnId = string;

/** The public error a provider's failures surface as (exit code 5). */
export type ProviderUnavailable = CodexUnavailable | AgyUnavailable;

/** Reports whether an error is any provider's public unavailable error. */
export const isProviderUnavailable = (error: unknown): error is ProviderUnavailable =>
  error instanceof CodexUnavailable || error instanceof AgyUnavailable;

/** Static facts about a provider that change what the supervisor and CLI offer. */
export interface Capabilities {
  /** `--tier` applies (Codex service tier). */
  readonly serviceTier: boolean;
  /**
   * The wire reports project hook runs (HookStarted). When false, the "command before any
   * project hook" rule cannot run and is skipped.
   */
  readonly hookEvents: boolean;
  /**
   * Cancelling a held question must come before the interrupt, because the held call blocks
   * the turn from ending (agy's bridge). When false the provider drops held calls itself, so
   * a failed interrupt must leave them answerable (Codex).
   */
  readonly cancelsQuestionsBeforeInterrupt: boolean;
}

/** Settings a session runs with. Passed again on resume so nothing falls back to user config. */
export interface SessionSettings {
  readonly cwd: string;
  readonly model: string;
  readonly effort: string;
  /** Codex service tier; null for providers without one. */
  readonly tier: string | null;
  readonly access: Access;
  /**
   * The run's recorded token total. agy reports usage per prompt, so a resumed session starts
   * its sum here; Codex reports running totals and ignores it.
   */
  readonly priorTokens?: TokenTotals | null;
}

/** What a turn is for; the provider derives its per-turn policy from it (hand-off is read-only). */
export interface TurnRequest {
  /** The run's persisted turn number for this turn (RunRecord.turns after increment). */
  readonly turn: number;
  readonly kind: TurnKind;
  readonly input: string;
  readonly settings: SessionSettings;
}

/** A started or completed tool, command or edit, reduced to what the supervisor records. */
export type ItemSummary =
  | {
      readonly kind: "command";
      readonly id: string;
      readonly command: string;
      readonly status: string;
      readonly exitCode: number | null;
      /** The last 2 KB of output, cut on a UTF-8 boundary. */
      readonly outputTail: string;
    }
  | { readonly kind: "fileChange"; readonly id: string; readonly paths: readonly string[] }
  | { readonly kind: "tool"; readonly id: string; readonly name: string }
  | { readonly kind: "other"; readonly id: string; readonly type: string };

/** A subagent's activity as Codex reports it; folded into Run.subagents on completion. */
export interface SubAgentActivity {
  readonly kind: string;
  readonly threadId: string;
  readonly path: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly startedAtMs: number | null;
}

/**
 * What a provider reports. `turn` is the provider turn the event belongs to. null means the
 * wire did not name a turn, and the event applies to the run's active one: it is never stale.
 * An adapter that knows a message belongs to no turn (agy updates that arrive with no prompt
 * outstanding) emits an Inbound with no events instead, so only the raw log records it. The
 * supervisor drops events for a turn other than the run's active one, and adopts the turn of
 * the first event that names one while a run is `unknown`.
 */
export type ProviderEvent =
  | { readonly _tag: "TurnStarted"; readonly turn: TurnId }
  | {
      readonly _tag: "TurnCompleted";
      readonly turn: TurnId;
      readonly status: "completed" | "interrupted" | "failed";
      readonly failure: RunFailure | null;
      /** The hand-off text the adapter chose for this turn, or null when there was none. */
      readonly handoff: string | null;
    }
  | {
      readonly _tag: "ItemStarted";
      /** null when only the item type decoded; the hook rule still applies to it. */
      readonly turn: TurnId | null;
      readonly id: string;
      /** From a minimal decode, so hook enforcement holds even if the full shape changed. */
      readonly kind: "command" | "fileChange" | "agentMessage" | "tool" | "other";
      /** The wire type for display (`commandExecution`, `execute`, ...). */
      readonly type: string;
      readonly command: string | null;
    }
  | { readonly _tag: "ItemCompleted"; readonly turn: TurnId; readonly item: ItemSummary }
  | {
      readonly _tag: "AgentMessage";
      readonly turn: TurnId;
      readonly text: string;
      readonly phase: "commentary" | "final_answer" | null;
    }
  | { readonly _tag: "SubAgent"; readonly turn: TurnId; readonly activity: SubAgentActivity }
  | { readonly _tag: "HookStarted"; readonly turn: TurnId | null; readonly project: boolean }
  | {
      readonly _tag: "HookBlocked";
      readonly turn: TurnId | null;
      readonly event: string;
      readonly feedback: string;
    }
  | { readonly _tag: "TokenUsage"; readonly turn: TurnId; readonly totals: TokenTotals }
  | { readonly _tag: "Retrying"; readonly turn: TurnId; readonly message: string }
  | {
      readonly _tag: "McpStartupFailed";
      readonly turn: null;
      readonly server: string;
      readonly error: string | null;
    }
  | {
      readonly _tag: "Permission";
      readonly turn: TurnId;
      readonly kind: string;
      readonly title: string;
      readonly decision: "approved" | "rejected";
    }
  /** A delta or other message that only refreshes the activity clock. */
  | { readonly _tag: "Activity"; readonly turn: TurnId | null }
  /** A recognized message that decoded only partly (`minimal`) or not at all (`invalid`). */
  | {
      readonly _tag: "DecodeIssue";
      readonly turn: TurnId | null;
      readonly method: string;
      readonly issue: "minimal" | "invalid";
    }
  /** A routed message the adapter doesn't map; recorded as an `Other` event. */
  | { readonly _tag: "Unrecognized"; readonly turn: TurnId | null; readonly method: string }
  /** The question's transport closed before an answer (agy bridge only). */
  | { readonly _tag: "QuestionAbandoned"; readonly turn: TurnId | null; readonly callId: string };

/** One wire message routed to a session, with the events decoded from it, in order. */
export interface Inbound {
  /** null when the message names no session; the supervisor logs and drops it. */
  readonly session: SessionId | null;
  /** The wire method, for logs. */
  readonly method: string;
  /**
   * The message as received, appended to the run's raw provider log. null means there is
   * nothing to log: the events were synthesized, not received (agy reports TurnStarted this
   * way, since ACP has no turn-start message).
   */
  readonly raw: unknown | null;
  /** Empty when the message changes nothing beyond the raw log. */
  readonly events: readonly ProviderEvent[];
}

/** The provider refused the steer; the supervisor falls back to a follow-up after the turn. */
export class SteerRefused extends Data.TaggedError("SteerRefused")<{
  readonly reason: string;
}> {}

/** The run refused a question asked through `ask`; the reason goes back to the agent. */
export class QuestionRefused extends Data.TaggedError("QuestionRefused")<{
  readonly reason: string;
}> {}

/** The supervisor cancelled a question asked through `ask` (interrupt, turn end, budget). */
export class QuestionCancelled extends Data.TaggedError("QuestionCancelled") {}

/**
 * The agent stopped waiting for a held question call before the supervisor answered it (agy's
 * bridge closed), so nothing was delivered. Codex never reports this.
 */
export class QuestionCallEnded extends Data.TaggedError("QuestionCallEnded")<{
  readonly callId: string;
}> {}

/** A question that arrived outside the provider's own wire (agy's MCP bridge). */
export interface ExternalQuestion {
  readonly question: string;
  readonly kind: "question" | "blocked";
  /** Unique per connection; matches QuestionAbandoned.callId. */
  readonly callId: string;
  /** The request as received, appended to the run's raw provider log. */
  readonly raw: unknown;
}

/** A held ask_orchestrator call. Answering it releases the agent's tool call. */
export interface QuestionCall {
  readonly session: SessionId;
  readonly turn: TurnId;
  /** Unique per connection; matches QuestionAbandoned.callId. */
  readonly callId: string;
  readonly question: string;
  readonly kind: "question" | "blocked";
  /** The request as received, appended to the run's raw provider log. */
  readonly raw: unknown;
  /**
   * Delivers the answer as the tool result.
   * @throws {QuestionCallEnded} When the agent stopped waiting first; nothing was delivered.
   */
  readonly respond: (text: string) => Effect.Effect<void, ProviderUnavailable | QuestionCallEnded>;
  /**
   * Fails the tool call because the run can't accept it (no active turn, for example).
   * @throws {QuestionCallEnded} When the agent stopped waiting first; nothing was delivered.
   */
  readonly reject: (reason: string) => Effect.Effect<void, ProviderUnavailable | QuestionCallEnded>;
  /**
   * Releases the call after the supervisor cancelled the question (interrupt, turn end,
   * budget). Codex drops held calls itself when a turn ends, so its cancel sends nothing;
   * agy's answers the bridge so the MCP tool call returns.
   */
  readonly cancel: Effect.Effect<void>;
}

/** What opening a session reports besides its id. */
export interface Opened {
  readonly session: SessionId;
  /** Non-fatal problems to add to the run's warnings (a refused thread title, for example). */
  readonly warnings: readonly string[];
}

/** What a resume reports, recorded as the run's `Resumed` event. */
export interface Resumed {
  /** The access label the provider reports (Codex sandbox type, agy mode). */
  readonly sandbox: string;
  readonly model: string;
}

/** Repo hook state for a start: whether hooks exist and must be enforced. */
export interface HookTrust {
  readonly required: boolean;
}

/**
 * One live agent child process (today's Codex app server). Failures of its requests are the
 * provider's public unavailable error, `RpcRequestTimeout`, or `RpcError` for a refusal.
 */
export interface ProviderConnection {
  readonly provider: ProviderId;
  /** Changes on every new child; runs and held questions are tied to one generation. */
  readonly generation: symbol;
  /** Notifications, decoded and routed. Ends or fails when the child goes away. */
  readonly inbound: Stream.Stream<Inbound, ProviderUnavailable>;
  readonly questions: Stream.Stream<QuestionCall, ProviderUnavailable>;
  /** Resolves with the cause when the connection ends for any reason. */
  readonly termination: Effect.Effect<Cause.Cause<ProviderUnavailable>>;
  /**
   * Opens a session for a run, with the question tool available.
   * @throws {ProviderUnavailable} When the child is unavailable or the provider refuses.
   */
  readonly open: (
    run: string,
    settings: SessionSettings,
  ) => Effect.Effect<Opened, ProviderUnavailable | RpcError | RpcRequestTimeout>;
  /**
   * Gives an opened session a display title, after the supervisor has saved the session id so
   * no notification in between goes unrouted. Returns warnings for a refused title; never
   * fails the run. Providers that title sessions themselves return no warnings.
   */
  readonly nameSession: (session: SessionId, title: string) => Effect.Effect<readonly string[]>;
  readonly resume: (
    run: string,
    session: SessionId,
    settings: SessionSettings,
  ) => Effect.Effect<Resumed, ProviderUnavailable | RpcError | RpcRequestTimeout>;
  /** True when this connection already has the session open (no resume needed). */
  readonly isLoaded: (session: SessionId) => boolean;
  /** Starts a turn; its end always arrives later as a TurnCompleted event. */
  readonly startTurn: (
    session: SessionId,
    request: TurnRequest,
  ) => Effect.Effect<TurnId, ProviderUnavailable | RpcError | RpcRequestTimeout>;
  readonly steer: (
    session: SessionId,
    turn: TurnId,
    input: string,
  ) => Effect.Effect<void, ProviderUnavailable | RpcError | RpcRequestTimeout | SteerRefused>;
  readonly interrupt: (
    session: SessionId,
    turn: TurnId,
  ) => Effect.Effect<void, ProviderUnavailable | RpcError | RpcRequestTimeout>;
  /**
   * Asks the supervisor a question that arrived outside the wire, for the daemon's bridge
   * handler. Emits a QuestionCall on `questions` and resolves with its outcome: `respond`
   * succeeds with the answer, `reject` fails with QuestionRefused, `cancel` with
   * QuestionCancelled. Providers whose questions arrive on their own wire refuse at once.
   */
  readonly ask: (
    session: SessionId,
    question: ExternalQuestion,
  ) => Effect.Effect<string, ProviderUnavailable | QuestionRefused | QuestionCancelled>;
  /**
   * Confirms the worktree's repo hooks will run.
   * @throws {RepoHooksUntrusted} When hooks exist but the provider won't run them.
   */
  readonly hookTrust: (
    mainCheckout: string,
    worktree: string,
  ) => Effect.Effect<
    HookTrust,
    ProviderUnavailable | RepoHooksUntrusted | RpcError | RpcRequestTimeout
  >;
}

/**
 * What the supervisor knows about a provider without starting it: names, facts and the
 * provider-specific checks and wording. Providers resolve their own services when built, so
 * none of these require any.
 */
export interface ProviderDescriptor {
  readonly id: ProviderId;
  /** The provider's name in messages ("Codex"). */
  readonly displayName: string;
  /** The configured executable, quoted in unavailable errors. */
  readonly binary: string;
  readonly capabilities: Capabilities;
  /** The environment for the child and for setup commands, after filtering. */
  readonly environment: Effect.Effect<Record<string, string>>;
  /** A warning to add to new runs when the installed agent's protocol is unverified. */
  readonly compatibilityWarning: Effect.Effect<string | null>;
  /** The model a run uses when the start names none. Never fails. */
  readonly defaultModel: Effect.Effect<string>;
  /** Builds this provider's public unavailable error (CodexUnavailable or AgyUnavailable). */
  readonly unavailable: (detail: string) => ProviderUnavailable;
  /**
   * Reports whether the repo has hooks this provider loads, so they must be enforced.
   * @throws {PermissionDenied} When the hooks file's directory can't be inspected.
   * @throws {RepoHooksUntrusted} When inspecting the hooks file fails for another reason.
   */
  readonly hasRepoHooks: (
    mainCheckout: string,
    worktree: string,
  ) => Effect.Effect<boolean, PermissionDenied | RepoHooksUntrusted>;
  /** The run failure when a command started before any project hook ran. */
  readonly hookBypassMessage: (group: string, worktree: string) => string;
  /**
   * Checks an effort a follow-up asks for against the model's catalog, before it is saved.
   * Absent for providers that validate efforts themselves (Codex).
   * @throws {ModelUnresolved} When the model doesn't offer the effort; the message lists the valid ones.
   * @throws {AgyUnavailable} When the catalog can't be read.
   */
  readonly checkEffort?: (
    model: string,
    effort: string,
  ) => Effect.Effect<void, ModelUnresolved | ProviderUnavailable>;
}

/** A provider: its descriptor and how to start a connection. */
export interface Provider extends ProviderDescriptor {
  /** Starts a child and its connection, owned by the given scope. */
  readonly connect: (
    stderr: (line: string) => Effect.Effect<void>,
  ) => Effect.Effect<ProviderConnection, ProviderUnavailable, Scope.Scope>;
}
