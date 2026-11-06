export interface CommandDemo {
  name: string;
  label: string;
  caption: string;
  command: string;
  output: string;
}

interface CommandRecording {
  command: string;
  output: string;
  exitCode: number;
}

const recordings = import.meta.glob<CommandRecording>(
  "../../fixtures/cli/*.json",
  { eager: true, import: "default" },
);

// Captions paraphrase the README's command reference; they are page copy.
const reference = [
  [
    "start-wait",
    "start --wait",
    "Start the contract in its own worktree and wait for attention.",
  ],
  [
    "wait-all",
    "wait --all",
    "Watch every run in the repository for attention.",
  ],
  [
    "answer",
    "answer",
    "Answer a pending question so the held tool call resumes.",
  ],
  [
    "status-release",
    "status",
    "Inspect a run's digest or list the current group's runs.",
  ],
  [
    "result",
    "result",
    "Read the digest and available hand-off, with its turn number.",
  ],
  [
    "archive",
    "archive",
    "Archive an inactive run and safely clean its worktree.",
  ],
  [
    "doctor",
    "doctor",
    "Check configuration, Codex, repo hook trust and the daemon.",
  ],
] as const;

/** The map seam also supports partial sets of recordings during capture. */
export function loadCommands(
  fixtures: Readonly<Record<string, CommandRecording>> = recordings,
): CommandDemo[] {
  return reference.flatMap(([name, label, caption]) => {
    const recording = fixtures[`../../fixtures/cli/${name}.json`];
    return recording
      ? [
          {
            name,
            label,
            caption,
            command: recording.command,
            output: recording.output,
          },
        ]
      : [];
  });
}

export interface OutputPart {
  text: string;
  tone?: "running" | "waiting" | "done" | "failed" | "interrupted" | "lost";
}

/** Preserve every byte; only the digest state and explicit command exits get color. */
export function commandOutputParts(output: string): OutputPart[] {
  const parts: OutputPart[] = [];
  const pattern =
    /(^run:[ \t]+\S+[ \t]+)(running|waiting|idle|failed|interrupted|lost)\b|\bexit=(-?\d+)\b/gm;
  let cursor = 0;
  for (const match of output.matchAll(pattern)) {
    const prefix = match[1] ?? "";
    const start = match.index + prefix.length;
    parts.push({ text: output.slice(cursor, start) });
    const text = match[2] ?? match[0];
    const state = match[2];
    const tone =
      state === "running" ||
      state === "waiting" ||
      state === "failed" ||
      state === "interrupted" ||
      state === "lost"
        ? state
        : state === "idle"
          ? "done"
          : Number(match[3]) === 0
            ? "done"
            : "failed";
    parts.push({ text, tone });
    cursor = start + text.length;
  }
  parts.push({ text: output.slice(cursor) });
  return parts;
}
