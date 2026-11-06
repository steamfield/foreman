import start from "../../fixtures/cli/start-wait.json";
import { loadRun } from "./runs";

export type LifecycleId =
  | "contract"
  | "start"
  | "running"
  | "question"
  | "done"
  | "failed"
  | "interrupted"
  | "lost"
  | "review"
  | "archive";

export interface LifecycleNode {
  id: LifecycleId;
  label: string;
  state:
    | "starting"
    | "running"
    | "waiting"
    | "done"
    | "failed"
    | "interrupted"
    | "lost";
  reports: string;
  claude: string;
  command: string;
  excerpt?: { source: string; text: string };
}

export interface LifecycleModel {
  nodes: LifecycleNode[];
  edges: { from: LifecycleId; to: LifecycleId; label?: string }[];
}

interface CliRecording {
  command: string;
  output: string;
}

// A glob keeps the build valid before the optional archive capture is added.
const archiveRecordings = import.meta.glob<CliRecording>(
  "../../fixtures/cli/archive.json",
  { eager: true, import: "default" },
);

/** Pure shaping of build-time recordings; callers can also supply an archive capture. */
export function lifecycleModel(
  recordings: { archive?: CliRecording } = {
    archive: archiveRecordings["../../fixtures/cli/archive.json"],
  },
): LifecycleModel {
  const lines = start.output.split("\n");
  const doneIndex = lines.findIndex((line) => /^done\s/.test(line));
  if (doneIndex < 0)
    throw new Error("start-wait recording has no done outcome");
  const question = loadRun("fix-supervisor").questions.find(
    (entry) => entry._tag === "Asked" && entry.id === "q1",
  );
  if (!question || question._tag !== "Asked") {
    throw new Error("fix-supervisor recording has no q1 question");
  }

  return {
    nodes: [
      {
        id: "contract",
        label: "Contract",
        state: "starting",
        reports:
          "Nothing yet. forman sends the contract to Codex as the first turn's prompt, after a short preamble about working in a worktree and leaving changes uncommitted.",
        claude:
          "Write the goal, a `- May change:` line, the repo’s checks and the hand-off Codex should leave. Keep changes uncommitted for review.",
        command: "--contract <file>",
      },
      {
        id: "start",
        label: "Start",
        state: "starting",
        reports:
          "forman creates `.claude/worktrees/<name>` on branch `forman/<name>`, runs the setup command, then starts the turn. This recording is the delegate that set up this site.",
        claude:
          "Start with the repo’s install command and `--write`. Run `start --wait` in the background so Claude can keep working.",
        command:
          'forman start <name> --new-worktree --setup "<install>" --contract <file> --write --wait',
        excerpt: {
          source: "Recorded: forman start --wait",
          text: lines.slice(0, doneIndex).join("\n"),
        },
      },
      {
        id: "running",
        label: "Running",
        state: "running",
        reports:
          "The turn is active. Claude's background wait stays quiet until the run needs it, for up to 60 minutes by default.",
        claude:
          "Codex works while Claude’s background wait is idle. Use `steer` to change the active turn, or `interrupt` to stop it.",
        command:
          'forman wait <name>\nforman steer <name> "<message>"\nforman interrupt <name>',
      },
      {
        id: "question",
        label: "Question",
        state: "waiting",
        reports:
          "Codex called `ask_orchestrator`. forman holds the call open, and the wait returns `question` with an id. This is q1 from fix-supervisor, as Codex wrote it.",
        claude:
          "Answer the question with `--wait` to resume the held call and keep watching, or `defer` it to release the call without deciding. Codex then continues with independent work, avoids irreversible steps on the decision and lists it under Open. The question timeout (15 minutes by default) does the same, and Claude can still answer later.",
        command: 'forman answer <name> <id> "<text>" --wait',
        excerpt: {
          source: "Recorded: fix-supervisor q1",
          text: question.question,
        },
      },
      {
        id: "done",
        label: "Done",
        state: "done",
        reports:
          "`done` means the turn ended; assess its hand-off and checks before accepting the work.",
        claude:
          "Read the hand-off and diff. Check the result before accepting it; use `followup` if another turn is needed.",
        command: "forman result <name>",
        excerpt: {
          source: "Recorded: the wait result",
          text: lines
            .slice(doneIndex, lines.indexOf("files written:", doneIndex))
            .join("\n"),
        },
      },
      {
        id: "failed",
        label: "Failed",
        state: "failed",
        reports:
          "The turn ended with an error. The result includes Codex's hand-off if it left one, and its edits stay in the worktree.",
        claude:
          "Read the failure and inspect the edits left in place. Use `followup` to start another turn on the inactive run.",
        command: 'forman followup <name> "<message>" --wait',
      },
      {
        id: "interrupted",
        label: "Interrupted",
        state: "interrupted",
        reports:
          "The turn stopped before it finished, after `forman interrupt` for example. Its edits stay in the worktree.",
        claude:
          "Inspect the edits left in place after the turn stopped. The run accepts `followup` when Claude is ready to continue.",
        command: 'forman followup <name> "<message>" --wait',
      },
      {
        id: "lost",
        label: "Lost",
        state: "lost",
        reports:
          "`lost` means the daemon can no longer supervise the run, after a crash for example. The edits are still in the worktree.",
        claude:
          "Inspect the run and its worktree before deciding how to recover. Do not treat lost supervision as completed work.",
        command: "forman status <name>\nforman doctor",
      },
      {
        id: "review",
        label: "Review and commit",
        state: "done",
        reports:
          "Nothing new. The run stays idle, with its edits uncommitted in the worktree until Claude commits them.",
        claude:
          "Read the hand-off with `forman result` and inspect the diff in the worktree. Refactor, run the repo’s checks, then commit and merge useful work. forman never commits.",
        command: "forman result <name>\ngit -C .claude/worktrees/<name> diff",
      },
      {
        id: "archive",
        label: "Archive",
        state: "done",
        reports:
          "forman removes the worktree and branch only when that loses nothing: no uncommitted or untracked files, and a branch that is unchanged or merged. Otherwise it refuses and lists what's left.",
        claude:
          "Archive after review and merging useful work. If cleanup would lose work, forman refuses. Use `--keep-worktree` to archive the run while keeping its worktree and branch.",
        command: "forman archive <name>\nforman archive <name> --keep-worktree",
        ...(recordings.archive
          ? {
              excerpt: {
                source: `Recorded: ${recordings.archive.command}`,
                text: recordings.archive.output,
              },
            }
          : {}),
      },
    ],
    edges: [
      { from: "contract", to: "start" },
      { from: "start", to: "running" },
      { from: "running", to: "question", label: "ask" },
      { from: "question", to: "running", label: "answer / timeout" },
      { from: "running", to: "done" },
      { from: "running", to: "failed" },
      { from: "running", to: "interrupted" },
      { from: "running", to: "lost" },
      { from: "done", to: "review" },
      { from: "failed", to: "review" },
      { from: "interrupted", to: "review" },
      { from: "lost", to: "review" },
      { from: "review", to: "archive" },
    ],
  };
}

/** One hop of the lifecycle tour: cross `edge` (if any), then rest on `node`. */
export interface TourStop {
  node: LifecycleId;
  edge?: { from: LifecycleId; to: LifecycleId };
}

const TOUR_CROSS_MS = 500;
const TOUR_REST_MS = 700;
const TOUR_ENDINGS = ["done", "failed", "interrupted", "lost"] as const;

/** Paths through the graph, one per wait ending; the first also asks a question. */
export function tourRoutes(model: LifecycleModel): LifecycleId[][] {
  const routes = TOUR_ENDINGS.map((ending, i): LifecycleId[] => [
    "contract",
    "start",
    "running",
    ...(i === 0 ? (["question", "running"] as const) : []),
    ending,
    "review",
    "archive",
  ]);
  for (const route of routes)
    route.slice(1).forEach((to, i) => {
      const from = route[i];
      if (!model.edges.some((e) => e.from === from && e.to === to))
        throw new Error(`Lifecycle tour crosses a missing edge ${from}→${to}`);
    });
  return routes;
}

export const tourStopMs = TOUR_CROSS_MS + TOUR_REST_MS;

export function tourLength(model: LifecycleModel) {
  return tourRoutes(model).flat().length * tourStopMs;
}

/** Where the tour is at `t` ms: the node it rests on and the edge it is crossing. */
export function tourAt(model: LifecycleModel, t: number) {
  const stops = tourRoutes(model).flatMap((route) =>
    route.map((node, i): TourStop => ({
      node,
      edge: i > 0 ? { from: route[i - 1] as LifecycleId, to: node } : undefined,
    })),
  );
  const index = Math.min(
    stops.length - 1,
    Math.max(0, Math.floor(t / tourStopMs)),
  );
  const stop = stops[index] as TourStop;
  const crossing = t - index * tourStopMs < TOUR_CROSS_MS && stop.edge;
  return crossing
    ? { node: stop.edge?.from ?? stop.node, edge: stop.edge }
    : { node: stop.node, edge: undefined };
}
