import type { Run } from "./runs";

function contractSection(contract: string, heading: string): string {
  const section = contract
    .match(
      new RegExp(`^## ${heading}\\n+([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"),
    )?.[1]
    ?.trim();
  if (!section)
    throw new Error(`Recorded contract is missing its ${heading} section`);
  return section;
}

export function contractExcerpt(contract: string) {
  const title = contract.split("\n")[0];
  if (!title?.startsWith("# "))
    throw new Error("Recorded contract is missing its title");
  const goal = contractSection(contract, "Goal").split("\n\n")[0];
  const scope = contractSection(contract, "Scope");
  const scopeLines = scope.split("\n");
  if (!scopeLines.some((line) => line.startsWith("- May change:"))) {
    throw new Error("Recorded contract Scope is missing its May change line");
  }
  return { title, goal, scope, scopeLines };
}

/** Keep every byte of the digest; only identify the lines needing review. */
export function digestBlocks(digest: string) {
  const lines = digest.split(/(?<=\n)/);
  const start = lines.findIndex(
    (line) => line.trimEnd() === "outside May change:",
  );
  if (start < 0)
    return {
      before: digest,
      outside: "",
      after: "",
      startLine: 0,
      lineCount: 0,
    };
  let end = start + 1;
  while (end < lines.length && lines[end]?.startsWith("  ")) end++;
  return {
    before: lines.slice(0, start).join(""),
    outside: lines.slice(start, end).join(""),
    after: lines.slice(end).join(""),
    startLine: start,
    lineCount: end - start,
  };
}

export function questionPairs(run: Run) {
  return run.questions
    .filter((q) => q._tag === "Asked")
    .map((asked, index, askedQuestions) => {
      const resolved = run.questions.find(
        (q) => q._tag === "Resolved" && q.id === asked.id,
      );
      if (!resolved || resolved._tag !== "Resolved") {
        throw new Error(
          `${run.name}: question ${asked.id} has no recorded resolution`,
        );
      }
      if (
        resolved.resolution !== "answered" &&
        resolved.resolution !== "auto-answered"
      ) {
        throw new Error(
          `${run.name}: unsupported resolution ${resolved.resolution}`,
        );
      }
      const previousAsked = askedQuestions[index - 1]?.t ?? -1;
      const hook = run.events.findLast(
        (event) =>
          event.kind === "hook-blocked" &&
          event.t > previousAsked &&
          event.t <= asked.t,
      );
      return {
        asked,
        resolved,
        // Report the nearest second: q1's recorded 18.959s is the page's 19s.
        elapsedMs: Math.round((resolved.t - asked.t) / 1000) * 1000,
        hook: hook?.kind === "hook-blocked" ? hook : undefined,
      };
    });
}

export function runTimelines(runs: readonly Run[]) {
  const first = runs[0];
  if (!first) throw new Error("The parallel timeline needs recorded runs");
  if (runs.some((run) => run.baseCommit !== first.baseCommit)) {
    throw new Error("Parallel runs must share one base commit");
  }
  const zero = Math.min(...runs.map((run) => Date.parse(run.createdAt)));
  const rows = runs.map((run) => {
    const startMs = Date.parse(run.createdAt) - zero;
    const commands = run.events.filter((event) => event.kind === "command");
    return {
      name: run.name,
      startMs,
      endMs: startMs + run.durationMs,
      durationMs: run.durationMs,
      commands: commands.length,
      failed: commands.filter(
        (event) => event.exitCode !== null && event.exitCode !== 0,
      ).length,
      files: new Set(
        run.events.flatMap((event) =>
          event.kind === "files" ? event.paths : [],
        ),
      ).size,
      outputTokens: run.tokens.output,
      questions: run.questions
        .filter((q) => q._tag === "Asked")
        .map((q) => ({ id: q.id, atMs: startMs + q.t })),
    };
  });
  const tickMs = 10 * 60 * 1000;
  const extentMs =
    Math.ceil(Math.max(...rows.map((row) => row.endMs)) / tickMs) * tickMs;
  const ticks = Array.from(
    { length: extentMs / tickMs + 1 },
    (_, i) => i * tickMs,
  );
  return { baseCommit: first.baseCommit, rows, extentMs, ticks };
}
