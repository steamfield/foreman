import { usePlayback } from "@steamfield/ui/react/playback";
import { useEffect, useRef } from "react";
import { hero } from "../../data/landing";
import {
  playbackToRun,
  snapshotAt,
  type ConsoleScript,
} from "../../data/supervision";
import { track } from "../../lib/analytics";
import { Events } from "../../lib/events";
import { formatElapsed, formatTokens } from "../../lib/format";
import { StateBadge } from "./primitives";
import { EventEntry } from "./console/EventFeed";
import { TranscriptStep } from "./console/Transcript";

export function SupervisionConsole({ script }: { script: ConsoleScript }) {
  const playback = usePlayback({ duration: script.playbackMs });
  const final = !playback.ready || playback.reduced || playback.complete;
  const time = final
    ? script.durationMs
    : playbackToRun(script.timeline, playback.elapsed);
  const snapshot = snapshotAt(script, time);
  const steps = script.steps.filter((step) => step.t <= time);
  const reached = script.events.filter((event) => event.t <= time);
  const tail = reached.slice(-12);
  const questions = final
    ? reached.filter(
        (event) => event.kind === "question" && !tail.includes(event),
      )
    : [];
  const transcript = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const lastStep = steps.at(-1)?.id;
  const lastEvent = tail.at(-1)?.seq;

  useEffect(() => {
    if (!playback.playing || final) return;
    const node = transcript.current;
    const last = node?.lastElementChild;
    if (node && last instanceof HTMLElement) node.scrollTop = last.offsetTop;
  }, [lastStep, playback.playing, final]);
  useEffect(() => {
    if (!playback.playing || final) return;
    const node = feed.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lastEvent, playback.playing, final]);
  // Keep the retained questions visible when playback finishes.
  useEffect(() => {
    if (final && feed.current) feed.current.scrollTop = 0;
  }, [final]);

  const status =
    snapshot.state === "waiting"
      ? "Codex has a question."
      : snapshot.state === "done"
        ? "Turn complete. Claude reviews the hand-off."
        : "Codex is working. Claude waits in the background.";

  return (
    <figure aria-label="Supervision console">
      <div
        ref={playback.ref}
        className="border-console-line bg-console text-console-fg shadow-console rounded-frame overflow-hidden border font-mono text-[0.8125rem] leading-relaxed"
      >
        <div className="border-console-line bg-console-2 inset-shadow-console-bar flex min-h-12 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <span className="text-console-muted">
            replaying {formatElapsed(script.durationMs)} in 1m
          </span>
          {playback.ready && !playback.reduced && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={playback.toggle}
                disabled={playback.complete}
                className="border-console-line rounded-control hover:bg-console border px-3 py-1 disabled:opacity-50"
              >
                {playback.paused || playback.complete ? "Play" : "Pause"}
              </button>
              <button
                type="button"
                onClick={() => {
                  playback.replay();
                  track(Events.demoReplayed, { id: "supervision" });
                }}
                className="border-console-line rounded-control hover:bg-console border px-3 py-1"
              >
                Replay
              </button>
            </div>
          )}
        </div>
        <p aria-live="polite" aria-atomic="true" className="sr-only">
          {status}
        </p>
        <div className="grid lg:h-[34rem] lg:grid-cols-12">
          <section
            aria-label="Claude Code transcript"
            className="border-console-line flex min-h-0 min-w-0 flex-col border-b lg:col-span-5 lg:border-r lg:border-b-0"
          >
            <header className="border-console-line flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
              <h2 className="font-medium">Claude Code</h2>
              <span className="text-console-muted text-xs">
                written + recorded
              </span>
            </header>
            <div
              ref={transcript}
              tabIndex={0}
              role="region"
              aria-label="Claude conversation"
              className="relative max-h-[34rem] min-h-0 space-y-4 overflow-y-auto p-4 lg:max-h-none lg:flex-1"
            >
              {steps.map((step) => (
                <TranscriptStep
                  key={step.id}
                  step={step}
                  time={time}
                  interactive={playback.ready}
                />
              ))}
            </div>
          </section>
          <section
            aria-label={`Codex: ${script.name}`}
            className="flex min-h-0 min-w-0 flex-col lg:col-span-7"
          >
            <header className="border-console-line space-y-2 border-b px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">Codex: {script.name}</h2>
                <div className="flex items-center gap-3">
                  <StateBadge state={snapshot.state} surface="console" />
                  <span className="text-console-muted tabular-nums">
                    {formatElapsed(time)}
                  </span>
                </div>
              </div>
              <div className="text-console-muted flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                <span>
                  {snapshot.commands} commands ({snapshot.failed} failed)
                </span>
                <span>{snapshot.files} files written</span>
                {snapshot.state === "done" && (
                  <span>
                    {formatTokens(script.tokens.input)} in /{" "}
                    {formatTokens(script.tokens.output)} out
                  </span>
                )}
              </div>
            </header>
            <div
              ref={feed}
              tabIndex={0}
              role="region"
              aria-label="Recorded Codex events"
              className="max-h-[34rem] min-h-0 overflow-y-auto p-4 lg:max-h-none lg:flex-1"
            >
              {questions.length > 0 && (
                <>
                  <p className="text-console-muted mb-3 text-xs">
                    Questions from this run
                  </p>
                  <ul className="space-y-3">
                    {questions.map((event) => (
                      <EventEntry
                        key={event.seq}
                        event={event}
                        interactive={playback.ready}
                      />
                    ))}
                  </ul>
                  <p className="border-console-line text-console-muted mt-4 mb-3 border-t pt-3 text-xs">
                    Latest recorded events
                  </p>
                </>
              )}
              <ul className="space-y-3">
                {tail.map((event) => (
                  <EventEntry
                    key={event.seq}
                    event={event}
                    interactive={playback.ready}
                  />
                ))}
              </ul>
            </div>
          </section>
        </div>
      </div>
      <figcaption className="text-ink-3 mt-4 max-w-[60rem] text-sm">
        {hero.consoleCaption}
      </figcaption>
    </figure>
  );
}
