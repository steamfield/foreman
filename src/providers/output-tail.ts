/** How much command output a provider keeps on a completed command. */
const OUTPUT_TAIL_BYTES = 2048;

/** Returns the last 2 KB of command output, cut so the tail stays valid UTF-8. */
export function outputTail(output: string | null): string {
  const bytes = new TextEncoder().encode(output ?? "");
  let start = Math.max(0, bytes.length - OUTPUT_TAIL_BYTES);
  // Skip continuation bytes so the cut never lands inside a multi-byte character.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}
