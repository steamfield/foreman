/**
 * The display title of a run, read from its contract.
 */

const TITLE_LENGTH = 120;

/**
 * Returns the contract's first Markdown heading, else its first non-empty line, trimmed and
 * cut to 120 characters; null when the contract has no text.
 */
export function contractTitle(contract: string): string | null {
  const lines = contract.split(/\r?\n/).map((line) => line.trim());
  const line = lines.find((line) => /^#+\s/.test(line)) ?? lines.find((line) => line.length > 0);
  return (
    line
      ?.replace(/^#+\s*/, "")
      .replace(/\s+#+$/, "")
      .trim()
      .slice(0, TITLE_LENGTH) || null
  );
}
