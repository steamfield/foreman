/**
 * Starting `agy acp`: its directories under foreman's home, the ordered channel, the
 * initialize handshake with its protocol check, and agy's wording for every way that fails.
 */
import { type Duration, Effect, FileSystem, type Schema } from "effect";
import { AgyUnavailable } from "../../errors";
import * as Acp from "../../schemas/acp";
import { type ChannelEnd, openChannel, type RpcError } from "../jsonrpc";
import type { AgyChannel } from "./live";

/** The ACP version foreman speaks. */
export const ACP_PROTOCOL_VERSION = 1;

const INITIALIZE_TIMEOUT = "60 seconds";

/** The failure when agy refuses a session or turn because nobody is signed in. */
export const SIGNED_OUT = "agy isn't signed in. Run agy once and sign in, then run foreman doctor.";

/** Whether an agy error message is about signing in (agy 1.5.14 says `auth_required`). */
export const mentionsAuth = (message: string) => /auth/i.test(message);

/** The failure when agy's reply to `method` doesn't decode. */
export const mismatchDetail = (method: string) =>
  `agy's reply to ${method} did not match the supported protocol; run foreman doctor and check the agy version.`;

/** AgyUnavailable for a reply to `method` that doesn't decode. */
export const replyMismatch = (method: string) =>
  new AgyUnavailable({ detail: mismatchDetail(method) });

/** Settings for one `agy acp` child. */
export interface AgyLaunchOptions {
  readonly agyBin: string;
  /** foreman's home: the ACP log and agy's empty launch directory live under it. */
  readonly home: string;
  /** The complete child environment. */
  readonly env: Readonly<Record<string, string>>;
  /** foreman's version, sent in the initialize handshake. */
  readonly version: string;
  readonly stderr: (line: string) => Effect.Effect<void>;
}

function endDetail(agyBin: string, end: ChannelEnd): string {
  if (end._tag === "Closed") return "agy connection closed";
  if (end.reason === "launch") {
    return `could not launch agy (${end.detail}). Install agy or set AGY_BIN, then run foreman doctor.`;
  }
  if (end.reason === "exit") return `agy exited with code ${end.exitCode}`;
  return `agy ${JSON.stringify(agyBin)}: ${end.detail}`;
}

/** Completes the handshake and returns agy's version; refuses any other protocol version. */
const initialize = Effect.fnUntraced(function* (channel: AgyChannel, version: string) {
  const reply = yield* channel
    .request(
      Acp.Method.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "foreman", version },
      },
      Acp.InitializeResult,
      { timeout: INITIALIZE_TIMEOUT },
    )
    .pipe(
      Effect.catchTag("SchemaError", () => Effect.fail(replyMismatch(Acp.Method.initialize))),
      Effect.catchTag("RpcError", (error) =>
        Effect.fail(
          new AgyUnavailable({
            detail: `agy refused initialize (${error.message}); run foreman doctor and check the agy version.`,
          }),
        ),
      ),
      Effect.catchTag("RpcRequestTimeout", (error) =>
        Effect.fail(
          new AgyUnavailable({
            detail: `agy did not answer initialize within ${error.timeoutMs} ms; run foreman doctor before retrying.`,
          }),
        ),
      ),
    );
  if (reply.protocolVersion !== ACP_PROTOCOL_VERSION) {
    return yield* new AgyUnavailable({
      detail: `agy speaks ACP protocol ${reply.protocolVersion}; foreman supports ${ACP_PROTOCOL_VERSION}. Install agy 1.5.14 or a compatible version, then run foreman doctor.`,
    });
  }
  return reply.agentInfo?.version ?? null;
});

/**
 * Starts `agy acp` in an empty directory under foreman's home and completes the handshake.
 * The child closes with the caller's scope.
 * @returns The ordered channel and the agy version initialize reported (null when none).
 * @throws {AgyUnavailable} When agy can't be launched, refuses or times out on initialize,
 * speaks another ACP protocol, or its directories under foreman's home can't be created.
 */
export const launchAgy = Effect.fn("agy.launch")(function* (options: AgyLaunchOptions) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = `${options.home}/providers/agy/cwd`;
  const logs = `${options.home}/logs`;
  yield* Effect.forEach([cwd, logs], (directory) =>
    fs
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.mapError(
          (error) =>
            new AgyUnavailable({ detail: `could not create ${directory}: ${error.message}` }),
        ),
      ),
  );
  const channel: AgyChannel = yield* openChannel({
    command: options.agyBin,
    args: ["acp", "--disable-telemetry", "--log-file", `${logs}/agy-acp.log`],
    cwd,
    env: options.env,
    stderr: options.stderr,
    ordered: true,
    unavailable: (end) => new AgyUnavailable({ detail: endDetail(options.agyBin, end) }),
  });
  const agentVersion = yield* initialize(channel, options.version);
  return { channel, agentVersion };
});

/**
 * Sends a session request. A refusal stays an RpcError unless it is about signing in; a reply
 * that doesn't decode becomes AgyUnavailable.
 */
export const sessionRequest = <A, I>(
  channel: AgyChannel,
  method: string,
  params: unknown,
  result: Schema.Codec<A, I>,
  timeout?: Duration.Input,
) =>
  channel.request(method, params, result, timeout === undefined ? {} : { timeout }).pipe(
    Effect.catchTag("SchemaError", () => Effect.fail(replyMismatch(method))),
    Effect.catchTag("RpcError", (error: RpcError) =>
      Effect.fail(mentionsAuth(error.message) ? new AgyUnavailable({ detail: SIGNED_OUT }) : error),
    ),
  );
