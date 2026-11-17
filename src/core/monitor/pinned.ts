import { DateTime } from "effect";
import { activeStates } from "../../schemas/daemon";
import type { RunView } from "../../schemas/monitor";
import type { PinnedRowView } from "./model";
import { duration } from "./row";

const oneLine = (text: string) => text.split(/\r?\n/, 1)[0]?.replace(/\p{Cc}/gu, " ") ?? "";
const epoch = DateTime.toEpochMillis;
const steerKeys = [
  { key: "s", label: "steer" },
  { key: "i", label: "interrupt" },
];

function budgetFraction(run: RunView, now: number): number {
  if (run.turnStartedAt === null || run.turnBudgetMs === null) return 0;
  if (run.turnBudgetMs === 0) return 1;
  return Math.max(0, now - epoch(run.turnStartedAt)) / run.turnBudgetMs;
}

/** Lists non-question attention reasons for filtering and pinned presentation. */
export function pinnedKinds(
  run: RunView,
  now: number,
  supervised: boolean,
): PinnedRowView["kind"][] {
  const kinds: PinnedRowView["kind"][] = [];
  if (run.state === "failed") kinds.push("failed");
  if (!supervised) return kinds;
  if (activeStates.has(run.state) && budgetFraction(run, now) >= 0.8) kinds.push("budget");
  if (run.state === "running" && run.quiet && run.activity?.kind !== "command") kinds.push("quiet");
  return kinds;
}

function pinnedRow(run: RunView, kind: PinnedRowView["kind"], now: number): PinnedRowView {
  if (kind === "failed")
    return {
      kind,
      name: run.name,
      tone: "failed",
      text: `failed ${duration(now - epoch(run.stateSince))} ago · ${oneLine(run.failure?.message ?? run.activity?.text ?? "")}`,
      keys: [
        { key: "⏎", label: "open" },
        { key: "F", label: "follow up" },
      ],
    };
  if (kind === "budget") {
    const elapsed = Math.floor(
      Math.max(0, now - epoch(run.turnStartedAt ?? run.stateSince)) / 60000,
    );
    const limit = `${Math.floor((run.turnBudgetMs ?? 0) / 60000)}m`;
    return {
      kind,
      name: run.name,
      tone: "interrupted",
      keys: steerKeys,
      text: `${Math.floor(budgetFraction(run, now) * 100)}% of budget · ${elapsed}/${limit} · moves to a read-only hand-off turn at ${limit}`,
    };
  }
  const elapsed = duration(now - epoch(run.lastActivityAt ?? run.stateSince));
  return {
    kind,
    name: run.name,
    tone: "interrupted",
    keys: steerKeys,
    text: `quiet ${elapsed} · ${run.activity ? oneLine(run.activity.text) : `last activity ${elapsed} ago`}`,
  };
}

function attentionTime(run: RunView, kind: PinnedRowView["kind"]): number {
  if (kind === "budget") return epoch(run.turnStartedAt ?? run.stateSince);
  if (kind === "quiet") return epoch(run.lastActivityAt ?? run.stateSince);
  return epoch(run.stateSince);
}

/** Orders attention by urgency then age and exposes the rows hidden by the three-row cap. */
export function pinnedRows(runs: readonly RunView[], now: number, supervised: boolean) {
  const rows = (["failed", "budget", "quiet"] as const).flatMap((kind) =>
    runs
      .filter((run) => pinnedKinds(run, now, supervised).includes(kind))
      .sort(
        (a, b) => attentionTime(a, kind) - attentionTime(b, kind) || a.name.localeCompare(b.name),
      )
      .map((run) => pinnedRow(run, kind, now)),
  );
  return { pinned: rows.slice(0, 3), morePinned: Math.max(0, rows.length - 3) };
}
