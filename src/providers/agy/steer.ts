/**
 * Steering an agy turn: a steer is one more `session/prompt` in the same session, which agy
 * merges into the running turn (the earlier prompt replies `end_turn` and the latest prompt's
 * reply ends the real turn). docs/rfcs/0002-providers.md "Steering" is the design.
 *
 * A steer must never start agy working after foreman queued the turn's completion, so steers
 * and prompt-reply handling take the same per-session lock.
 */
import { Effect, Semaphore } from "effect";
import * as Acp from "../../schemas/acp";
import { type SessionId, SteerRefused, type TurnId } from "../contract";
import type { Live } from "./live";
import { acceptsSteer, beginSteer } from "./turns";

/** The refusal reason when the turn to steer has already ended or never ran here. */
export const STEER_TURN_FINISHED = "the agy turn already finished";

/** One lock per session, shared by its steers and the reader's handling of its prompt replies. */
export type SessionLocks = Map<SessionId, Semaphore.Semaphore>;

/**
 * Runs `effect` holding the session's lock, so it doesn't interleave with a steer or a prompt
 * reply of the same session.
 * @throws Whatever `effect` fails with.
 */
export function withSessionLock<A, E, R>(
  locks: SessionLocks,
  session: SessionId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const existing = locks.get(session);
  const lock = existing ?? Semaphore.makeUnsafe(1);
  if (existing === undefined) locks.set(session, lock);
  return Semaphore.withPermit(lock, effect);
}

/**
 * Sends `input` as a prompt that agy merges into the session's running turn. The turn then
 * ends on the reply of its latest prompt.
 * @throws {SteerRefused} When no prompt of `turn` is outstanding: the turn already finished
 * (its completion may still be on its way to the supervisor) or the session isn't open here.
 * The supervisor then delivers the message as a follow-up.
 * @throws {AgyUnavailable} When the connection has ended or the prompt can't be written.
 */
export const steerSession = (
  live: Live,
  locks: SessionLocks,
  session: SessionId,
  turn: TurnId,
  input: string,
) =>
  withSessionLock(
    locks,
    session,
    Effect.gen(function* () {
      const state = live.sessions.get(session);
      if (state === undefined || !acceptsSteer(state.turn, turn))
        return yield* new SteerRefused({ reason: STEER_TURN_FINISHED });
      const prompt = [{ type: "text", text: input }];
      yield* live.channel.requestOrdered(
        Acp.Method.prompt,
        { sessionId: session, prompt },
        (id) => {
          live.prompts.set(id, session);
          // Re-read: session updates may have landed since the check; only replies are locked out.
          const current = live.sessions.get(session) ?? state;
          live.sessions.set(session, { ...current, turn: beginSteer(current.turn) });
        },
      );
    }),
  );
