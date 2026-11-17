/** Defines the state meanings shared by onboarding and the keyboard reference. */
export const stateLegend = [
  {
    glyph: "⣾",
    state: "running",
    meaning: "a turn is executing; the second line says what it is doing",
  },
  { glyph: "■", state: "waiting", meaning: "Codex asked a question and needs a person" },
  { glyph: "✓", state: "done", meaning: "the turn finished; review it, then archive" },
  { glyph: "×", state: "failed", meaning: "the turn ended with an error" },
] as const;

/** Formats the shared legend as terminal text without styling. */
export function legendLines(): readonly string[] {
  return stateLegend.map(({ glyph, state, meaning }) => `${glyph}  ${state.padEnd(9)}  ${meaning}`);
}
