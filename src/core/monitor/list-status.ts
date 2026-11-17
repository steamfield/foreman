import { activeStates } from "../../schemas/daemon";
import type { RunView } from "../../schemas/monitor";
import { firstRunLines } from "./first-run";
import { age, oneLine, stateTone, unsupervised } from "./format";
import type { State, ViewModel } from "./model-types";

/** Builds the list connection message and run-count header. */
export function listStatus(state: State, runs: readonly RunView[], groupCount: number) {
  const feed = state.feed;
  const overview = feed?._tag === "Reconnecting" ? feed.last : feed?.overview;
  const status = listMessage(state, runs.length === 0 || groupCount === 0, runs.length === 0);
  const counts = new Map<RunView["state"], number>();
  for (const run of runs) counts.set(run.state, (counts.get(run.state) ?? 0) + 1);
  const reconnecting = feed?._tag === "Reconnecting";
  let daemon = "connecting";
  if (feed?._tag === "Saved") daemon = "no daemon · showing saved runs";
  else if (overview?.daemon) daemon = `daemon up ${age(overview.daemon.startedAt, state.now)}`;
  if (status.screen === "outdated") daemon = "daemon outdated · saved state";
  const header = {
    version: state.version,
    daemon,
    defaults: `${state.defaults.model} · ${state.defaults.effort} · ${state.defaults.tier === "priority" ? "fast" : state.defaults.tier}`,
    counts: [...counts].map(([s, count]) => ({
      state: s,
      count,
      tone: unsupervised(feed) && activeStates.has(s) ? "muted" : stateTone(s),
    })),
    caution: feed?._tag === "Saved" || reconnecting,
  };
  return { ...status, header };
}

/** Builds the footer freshness for the active list or detail subscription. */
export function listFooter(state: State): ViewModel["footer"] {
  const feed = state.feed;
  const reconnecting = feed?._tag === "Reconnecting";
  let footerStatus = reconnecting
    ? `reconnecting in ${Math.max(0, Math.ceil((feed.retryAt - state.now) / 1000))}s`
    : `updated ${(Math.max(0, state.now - (feed?.receivedAt ?? state.now)) / 1000).toFixed(1)}s ago`;
  let footerCaution = reconnecting;
  const detailFeed = state.detail?.feed;
  if (detailFeed?._tag === "Reconnecting") {
    footerStatus = `reconnecting in ${Math.max(0, Math.ceil((detailFeed.retryAt - state.now) / 1000))}s`;
    footerCaution = true;
  } else if (detailFeed?._tag === "Saved") {
    footerStatus =
      detailFeed.reason === "outdated" ? "saved · daemon outdated" : "saved · daemon not running";
    footerCaution = true;
  } else if (detailFeed?._tag === "Live") {
    footerStatus = `updated ${(Math.max(0, state.now - detailFeed.receivedAt) / 1000).toFixed(1)}s ago`;
    footerCaution = false;
  }

  return {
    compact: state.rows < 24,
    status: footerStatus,
    caution: footerCaution,
    attentionOnly: state.attentionOnly,
  };
}

function listMessage(state: State, empty: boolean, noRuns: boolean) {
  const feed = state.feed;
  let screen: ViewModel["screen"] = "list";
  let message: readonly string[] = [];
  const firstRun = noRuns && (feed?._tag === "Live" || unsupervised(feed));
  if (feed === null) {
    screen = "probing";
    message = ["Connecting to daemon", "Reading current runs", "foreman status --all"];
  } else if (feed._tag === "Saved") {
    screen = feed.reason === "outdated" ? "outdated" : "saved";
    message = [
      feed.reason === "outdated"
        ? "Saved state · daemon is outdated"
        : "Saved state · daemon not running",
      feed.reason === "outdated"
        ? "The monitor will reconnect when a compatible daemon is available."
        : "The monitor checks again automatically; start work in another terminal.",
      "foreman status --all",
    ];
  } else if (feed._tag === "Reconnecting") {
    screen = "reconnecting";
    message = ["Reconnecting to daemon", oneLine(feed.reason), "foreman status --all"];
  } else if (empty) {
    screen = "empty";
    message = [
      state.attentionOnly ? "No runs need attention" : "No runs match this filter.",
      state.attentionOnly ? "Press ! to show every run." : "Press / then Esc to clear the filter.",
      "foreman status --all",
    ];
  }
  if (firstRun)
    message = firstRunLines(feed?._tag === "Saved" ? feed.nextProbeAt : null, state.now);
  return { screen, message, firstRun };
}
