import answerCapture from "../../fixtures/cli/answer.json";
import type { Run, RunEvent } from "./runs";

export type SessionState =
  "queued" | "starting" | "running" | "waiting" | "done" | "archived";
type Activity = Extract<RunEvent, { kind: "command" | "files" }>;
export interface Delegate {
  name: string;
  model: string;
  work: string;
  branch: string;
  contract: string;
  scope: string;
  start: number;
  done: number;
  source: string;
  activity: { at: number; event: Activity }[];
}
export interface SessionStep {
  at: number;
  title: string;
  text: string;
  commands: string[];
  recorded?: { title: string; text: string };
  recordedOutput?: string;
}
type Endpoint = "claude" | "daemon" | number;
export interface Packet {
  from: Endpoint;
  to: Endpoint;
  label: string;
  at: number;
  attention: boolean;
}
export interface Session {
  delegates: Delegate[];
  steps: SessionStep[];
  packets: Packet[];
  question: { id: string; text: string; answer: string };
  duration: number;
  stillAt: number;
}
export interface DelegateScene {
  state: SessionState;
  turn: number;
  commands: number;
  files: number;
  latest?: Activity;
}
export interface Scene {
  step: number;
  held: boolean;
  claude: string;
  delegates: DelegateScene[];
  packets: (Packet & { progress: number })[];
}

const QUESTION = 16_500;
const ANSWER = 22_000;
const FOLLOWUP = 38_000;
const FOLLOWUP_DONE = 41_500;
const ARCHIVE = 48_500;
const FLIGHT = 1500;

/** Compress a recording segment without changing its event order. */
function activityFor(events: Activity[], start: number, end: number) {
  return events.map((event, i) => ({
    at: start + ((i + 1) / (events.length + 1)) * (end - start),
    event,
  }));
}

export function buildSession(
  questionSource: Run,
  laneSources: Record<"site-console" | "site-commands" | "site-e2e", Run>,
): Session {
  const asked = questionSource.questions.find((q) => q._tag === "Asked");
  const resolved = questionSource.questions.find(
    (q) => q._tag === "Resolved" && q.id === asked?.id,
  );
  if (
    !asked ||
    asked._tag !== "Asked" ||
    !resolved ||
    resolved._tag !== "Resolved"
  ) {
    throw new Error(
      "The session needs a recorded question and its matching answer.",
    );
  }
  const consoleRun = laneSources["site-console"];
  const samples = (run: Run) =>
    run.events.filter(
      (e): e is Activity =>
        e.kind === "files" || (e.kind === "command" && e.command.length < 90),
    );
  const specs = [
    {
      name: "site-console",
      model: "gpt-6-astra",
      work: "Hero console",
      contract: "console.md",
      scope:
        "site/src/components/landing/SupervisionConsole.tsx, site/src/components/landing/SupervisionConsole.test.tsx, site/src/components/landing/console/, site/src/data/supervision.ts, site/src/data/supervision.test.ts",
      start: 4000,
      done: 32_500,
      source: consoleRun.name,
      events: samples(consoleRun),
    },
    {
      name: "site-commands",
      model: "gpt-6.1-sol",
      work: "Command tabs + llms.txt",
      contract: "commands.md",
      scope:
        "site/src/components/landing/CommandTabs.tsx, site/src/components/landing/CommandTabs.test.tsx, site/src/data/commands.ts, site/src/data/commands.test.ts, site/src/pages/llms.txt.ts",
      start: 6000,
      done: 43_500,
      source: laneSources["site-commands"].name,
      events: samples(laneSources["site-commands"]),
    },
    {
      name: "site-e2e",
      model: "gpt-6.1-terra",
      work: "Browser + accessibility checks",
      contract: "e2e.md",
      scope: "site/e2e/, site/playwright.config.ts",
      start: 8000,
      done: 45_500,
      source: laneSources["site-e2e"].name,
      events: samples(laneSources["site-e2e"]),
    },
  ];
  const delegates = specs.map(({ events, ...spec }, i) => {
    // Keep whole recorded events; omit mixed-scope writes rather than rewriting their paths.
    const owned = events.filter(
      (event) =>
        event.kind !== "files" ||
        event.paths.every((path) =>
          spec.scope
            .split(", ")
            .some((scope) =>
              scope.endsWith("/") ? path.startsWith(scope) : path === scope,
            ),
        ),
    );
    const activity =
      i === 1
        ? [
            ...activityFor(
              owned.filter((event) => event.t < asked.t),
              spec.start + 2000,
              QUESTION,
            ),
            ...owned
              .filter((event) => event.t >= asked.t && event.t < resolved.t)
              .map((event) => ({ at: QUESTION, event })),
            ...activityFor(
              owned.filter((event) => event.t >= resolved.t),
              ANSWER,
              spec.done,
            ),
          ]
        : activityFor(owned, spec.start + 2000, spec.done);
    return { ...spec, branch: `forman/${spec.name}`, activity };
  });
  const quote = (s: string) => `"${s.replace(/[\\"$`]/g, "\\$&")}"`;
  const next = answerCapture.output
    .split("\n")
    .find((line) => line.startsWith("next: "));
  if (!next)
    throw new Error("The recorded answer must include its next wait command.");
  const steps: SessionStep[] = [
    {
      at: 0,
      title: "Write three contracts",
      text: "Claude splits the page into three tasks, each with its own May change line. Astra handles design taste, sol implementation, and terra tests.",
      commands: [],
    },
    {
      at: 4000,
      title: "Start three worktrees",
      text: "The daemon creates each .claude/worktrees/<name> directory on forman/<name>, runs bun install, then starts a Codex turn. The starts are staggered.",
      commands: delegates.map(
        (d) =>
          `forman start ${d.name} --new-worktree --setup "bun install" --contract ${d.contract} --write --model ${d.model}`,
      ),
    },
    {
      at: 11_000,
      title: "Wait while all three work",
      text: "Claude runs one wait in the background and goes idle. Commands and file writes stream from the delegates to the dispatch board.",
      commands: ["forman wait --all"],
    },
    {
      at: QUESTION,
      title: "Hold a question for Claude",
      text: `site-commands calls ask_orchestrator. The daemon holds the tool call, marks the run waiting, and wakes Claude with question ${asked.id}.`,
      commands: [],
      recorded: {
        title: `Recorded question · ${questionSource.name} · ${asked.id}`,
        text: asked.question,
      },
    },
    {
      at: ANSWER,
      title: "Answer and resume waiting",
      text: "Claude answers; the held call releases and site-commands keeps working. Claude runs the next wait command printed with the answer, including its cursor.",
      commands: [
        `forman answer site-commands ${asked.id} ${quote(resolved.text)}`,
        next.slice(6),
      ],
      recorded: { title: "Recorded answer", text: resolved.text },
      recordedOutput: answerCapture.output,
    },
    {
      at: 27_500,
      title: "Steer the active test turn",
      text: "Claude adds the 375px check while site-e2e is running, with no question pending. Steer changes the current turn's instructions.",
      commands: ['forman steer site-e2e "Also check 375px widths."'],
    },
    {
      at: 32_500,
      title: "Review the first result",
      text: "The wait returns done for site-console with its digest. Claude reads the result and diff, runs the site's checks, and commits the reviewed work.",
      commands: ["forman result site-console"],
      recorded: {
        title: "Recorded digest · site-console",
        text: consoleRun.digest,
      },
    },
    {
      at: FOLLOWUP,
      title: "Follow up on the same thread",
      text: "Claude starts turn 2 in site-console's existing thread and worktree. The small correction finishes, and Claude reviews and commits it.",
      commands: [
        'forman followup site-console "Drop the false scope flags from the final step."',
      ],
    },
    {
      at: 43_500,
      title: "Land the remaining work",
      text: "site-commands finishes, then site-e2e. Claude reviews each diff, runs the checks, commits the work and merges all three branches.",
      commands: ["forman result site-commands", "forman result site-e2e"],
    },
    {
      at: ARCHIVE,
      title: "Archive the merged runs",
      text: "Claude archives all three runs after their branches are merged and worktrees are clean. The worktrees and branches are removed; their records stay on the board.",
      commands: delegates.map((d) => `forman archive ${d.name}`),
    },
  ];
  const packets: Packet[] = [];
  const send = (
    at: number,
    from: Endpoint,
    to: Endpoint,
    label: string,
    attention = false,
  ) => packets.push({ at, from, to, label, attention });
  delegates.forEach((d, i) => {
    send(d.start, "claude", "daemon", "start");
    send(d.start + 1500, "daemon", i, "turn");
    send(d.done, i, "daemon", "done");
    send(d.done + 1500, "daemon", "claude", "done");
    send(ARCHIVE + i * 600, "claude", "daemon", "archive");
  });
  send(QUESTION, 1, "daemon", "ask_orchestrator", true);
  send(QUESTION + 1500, "daemon", "claude", `question ${asked.id}`, true);
  send(ANSWER, "claude", "daemon", "answer");
  send(ANSWER + 1500, "daemon", 1, "answer");
  send(27_500, "claude", "daemon", "steer");
  send(29_000, "daemon", 2, "steer");
  send(FOLLOWUP, "claude", "daemon", "followup");
  send(FOLLOWUP + 1500, "daemon", 0, "turn");
  send(FOLLOWUP_DONE, 0, "daemon", "done");
  send(FOLLOWUP_DONE + 1500, "daemon", "claude", "done");
  return {
    delegates,
    steps,
    packets,
    question: { id: asked.id, text: asked.question, answer: resolved.text },
    duration: 54_000,
    stillAt: 19_500,
  };
}

export function stepAt(session: Session, t: number): number {
  return Math.max(
    0,
    session.steps.findLastIndex((step) => step.at <= t),
  );
}

export function sceneAt(session: Session, time: number): Scene {
  const t = Math.max(0, Math.min(session.duration, time));
  const held = t >= QUESTION && t < ANSWER;
  const delegates = session.delegates.map((d, i): DelegateScene => {
    const followup = i === 0 && t >= FOLLOWUP;
    const state: SessionState =
      t >= ARCHIVE
        ? "archived"
        : t < d.start
          ? "queued"
          : t < d.start + 2000
            ? "starting"
            : held && i === 1
              ? "waiting"
              : followup
                ? t < FOLLOWUP_DONE
                  ? "running"
                  : "done"
                : t >= d.done
                  ? "done"
                  : "running";
    const seen = d.activity.filter((a) => a.at <= t);
    return {
      state,
      turn: t < d.start ? 0 : followup ? 2 : 1,
      commands: seen.filter((a) => a.event.kind === "command").length,
      files: new Set(
        seen.flatMap((a) => (a.event.kind === "files" ? a.event.paths : [])),
      ).size,
      latest: seen.at(-1)?.event,
    };
  });
  const packets = session.packets
    .filter((p) => t >= p.at && t < p.at + FLIGHT)
    .map((p) => ({ ...p, progress: (t - p.at) / FLIGHT }));
  if (t >= 11_000 && !packets.length)
    delegates.forEach((d, i) => {
      if (d.state === "running")
        packets.push({
          from: i,
          to: "daemon",
          label: "events",
          attention: false,
          at: t,
          progress: ((t + i * 500) % 2400) / 2400,
        });
    });
  const step = stepAt(session, t);
  const claude =
    [
      "Writing contracts",
      "Starting delegates",
      "Idle · wait --all",
      `Question ${session.question.id}`,
      "Answer → wait --all",
      "Steering site-e2e",
      "Review · check · commit",
      "Follow up · review",
      "Review · commit · merge",
      "Archive merged branches",
    ][step] ?? "";
  return { step, held, claude, delegates, packets };
}
