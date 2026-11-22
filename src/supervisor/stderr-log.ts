/**
 * Redacts a provider child's stderr line by line before it reaches the daemon's log file.
 *
 * Private key blocks span several lines, so the redactor remembers whether it is inside one.
 */
import type { Effect } from "effect";
import { redactDiagnosticText } from "../logging";

const PRIVATE_KEY_BEGIN = /-----BEGIN [^-]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [^-]*PRIVATE KEY-----/;
const REDACTED_KEY = "[redacted private key]";

/** One redacted line and whether the next line is still inside a private key block. */
export interface RedactedLine {
  readonly text: string;
  readonly inKeyBlock: boolean;
}

/** Redacts one stderr line, replacing every line of a private key block whole. */
export function redactStderrLine(line: string, inKeyBlock: boolean): RedactedLine {
  const inside = inKeyBlock || PRIVATE_KEY_BEGIN.test(line);
  return {
    text: inside ? REDACTED_KEY : redactDiagnosticText(line),
    inKeyBlock: inside && !PRIVATE_KEY_END.test(line),
  };
}

/**
 * Makes the stderr callback for one child: each line is redacted and written with `write`,
 * which handles its own failures.
 */
export function stderrSink(write: (text: string) => Effect.Effect<void>) {
  let inKeyBlock = false;
  return (line: string) => {
    const redacted = redactStderrLine(line, inKeyBlock);
    inKeyBlock = redacted.inKeyBlock;
    return write(`${redacted.text}\n`);
  };
}
