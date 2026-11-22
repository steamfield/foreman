/**
 * Resuming an agy session after a daemon restart, and the model and mode setup that opening
 * and resuming a session share. docs/rfcs/0002-providers.md "Resume" is the design.
 */
import { Effect, Schema } from "effect";
import * as Acp from "../../schemas/acp";
import type { Resumed, SessionId, SessionSettings } from "../contract";
import { sessionRequest } from "./launch";
import type { Live } from "./live";
import { openedSession } from "./turns";

/** Not declared in Acp.Method; its params are `session/new`'s plus the session id. */
const SESSION_RESUME = "session/resume";
/** Loading a session replays its history, which can take as long as opening one. */
const SESSION_RESUME_TIMEOUT = "180 seconds";
/** The effort routing records for agy models that have no thinking levels. */
const NO_EFFORT = "none";
/** The agy mode foreman runs sessions in; its permission requests come to foreman. */
const DEFAULT_MODE = "default";

/**
 * agy takes model and thinking level as one id: `gemini-4-neon-low`. Models without thinking
 * levels (`claude-opus-5-5`) go as they are.
 * @throws Never.
 */
export function modelValue(settings: SessionSettings): string {
  const suffix = `-${settings.effort}`;
  if (settings.effort === NO_EFFORT || settings.model.endsWith(suffix)) return settings.model;
  return `${settings.model}${suffix}`;
}

/**
 * Sets the session's model and thinking level, then the default mode, so nothing falls back to
 * the user's agy settings.
 * @throws {AgyUnavailable} When the connection has ended, nobody is signed in, or a reply
 * doesn't match the supported protocol.
 * @throws {RpcError} When agy refuses the model or the mode.
 * @throws {RpcRequestTimeout} When agy doesn't answer within 30 seconds.
 */
export const configureSession = Effect.fnUntraced(function* (
  live: Live,
  session: SessionId,
  settings: SessionSettings,
) {
  const model = { sessionId: session, configId: "model", value: modelValue(settings) };
  yield* sessionRequest(live.channel, Acp.Method.setConfigOption, model, Schema.Unknown);
  const mode = { sessionId: session, modeId: DEFAULT_MODE };
  yield* sessionRequest(live.channel, Acp.Method.setMode, mode, Schema.Unknown);
});

/**
 * Loads a session this connection didn't open, with the run's question bridge, model and
 * mode. The session counts as loaded only once all of that succeeded, so a failed resume is
 * retried in full on the next follow-up.
 * @throws {AgyUnavailable} When the connection has ended, nobody is signed in, or a reply
 * doesn't match the supported protocol.
 * @throws {RpcError} When agy refuses the session (it no longer exists, for example).
 * @throws {RpcRequestTimeout} When agy doesn't answer in time.
 */
export const resumeSession = Effect.fnUntraced(function* (
  live: Live,
  run: string,
  session: SessionId,
  settings: SessionSettings,
) {
  const params = { sessionId: session, cwd: settings.cwd, mcpServers: [live.bridge(run)] };
  yield* sessionRequest(
    live.channel,
    SESSION_RESUME,
    params,
    Schema.Unknown,
    SESSION_RESUME_TIMEOUT,
  );
  yield* configureSession(live, session, settings);
  live.sessions.set(session, {
    turn: openedSession(settings.access),
    tools: new Map(),
    cwd: settings.cwd,
  });
  return { sandbox: DEFAULT_MODE, model: settings.model } satisfies Resumed;
});
