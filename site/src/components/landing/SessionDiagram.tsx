import { usePlayback } from "@steamfield/ui/react/playback";
import { sceneAt, type Session } from "../../data/session";
import { track } from "../../lib/analytics";
import { Events } from "../../lib/events";
import { CodeFrame, Inline, StateBadge } from "./primitives";
import { SessionCanvas } from "./session/SessionCanvas";

/** Story milliseconds per wall-clock millisecond: 54s of story plays in about 22s. */
export const PLAYBACK_RATE = 2.5;

export function SessionDiagram({ session }: { session: Session }) {
  const playback = usePlayback({
    duration: session.duration / PLAYBACK_RATE,
    reducedPolicy: "hold",
  });
  const still = !playback.ready || playback.reduced;
  const scene = sceneAt(
    session,
    still ? session.stillAt : playback.elapsed * PLAYBACK_RATE,
  );
  const current = session.steps[scene.step];
  return (
    <div className="min-w-0" data-session-diagram>
      <p className="sr-only">
        Claude Code writes three contracts and starts Codex delegates on astra,
        sol and terra in separate worktrees. The foreman daemon routes their
        events. It holds site-commands' question while the other two work, wakes
        Claude and releases the call after Claude answers. Claude steers
        site-e2e, reviews site-console, starts a second turn on the same thread,
        then reviews, checks, commits and merges all three before archiving
        their clean worktrees.
      </p>
      <figure className="rounded-frame border-line bg-card overflow-hidden border">
        <div className="border-line flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
          <p
            className="text-ink-3 font-mono text-xs"
            aria-live="polite"
            aria-atomic="true"
          >
            Step {scene.step + 1} of {session.steps.length}
            <span className="sr-only">: {current?.title}</span>
          </p>
          {!still && (
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-secondary text-sm"
                onClick={playback.toggle}
                disabled={playback.complete}
              >
                {playback.paused || playback.complete ? "Play" : "Pause"}
              </button>
              <button
                type="button"
                className="btn btn-secondary text-sm"
                onClick={() => {
                  playback.replay();
                  track(Events.demoReplayed, { id: "session" });
                }}
              >
                Replay
              </button>
            </div>
          )}
        </div>
        <div ref={playback.ref} className="p-2 sm:p-4">
          <SessionCanvas
            session={session}
            scene={scene}
            playing={playback.playing}
          />
        </div>
        <figcaption className="border-line text-ink-3 border-t px-4 py-3 text-xs">
          Each lane's commands are sampled from its delegate's recording;
          question and answer from site-commands. Narration written for this
          page.
        </figcaption>
      </figure>
      <ol className="mt-8 grid min-w-0 gap-x-8 gap-y-6 md:grid-cols-2">
        {session.steps.map((step, i) => (
          <li key={step.at} className="min-w-0">
            {still ? (
              <h3 className="text-ink flex items-center gap-3 font-semibold">
                <span aria-hidden="true" className="step-number">
                  {i + 1}
                </span>
                <span className="sr-only">{i + 1}. </span>
                {step.title}
              </h3>
            ) : (
              <button
                type="button"
                aria-current={i === scene.step ? "step" : undefined}
                className={`rounded-control flex w-full items-center gap-3 border px-3 py-2 text-left font-semibold transition-colors ${i === scene.step ? "border-ink bg-card text-ink" : "text-ink-2 hover:border-line-strong hover:text-ink border-transparent"}`}
                onClick={() => {
                  playback.seek(step.at / PLAYBACK_RATE);
                  playback.pause();
                }}
              >
                <span
                  aria-hidden="true"
                  className={`step-number ${i === scene.step ? "step-number-current" : ""}`}
                >
                  {i + 1}
                </span>
                <span className="sr-only">{i + 1}. </span>
                {step.title}
              </button>
            )}
            <p className="text-ink-2 mt-2 text-sm leading-relaxed">
              <Inline text={step.text} />
            </p>
            {(still || scene.step === i) && (
              <div className="mt-3 flex min-w-0 flex-col gap-3">
                {i === 0 &&
                  session.delegates.map((d) => (
                    <CodeFrame
                      key={d.name}
                      title={`${d.contract} · written for this page`}
                      code={`Task: ${d.work}\nMay change: ${d.scope}`}
                    />
                  ))}
                {step.recorded &&
                  (i === 6 ? (
                    <details
                      onToggle={(event) => {
                        if (event.currentTarget.open) playback.pause();
                      }}
                    >
                      <summary className="text-ink-2 cursor-pointer text-sm">
                        Read the recorded digest
                      </summary>
                      <CodeFrame
                        title={step.recorded.title}
                        code={step.recorded.text}
                        surface="console"
                        className="mt-2"
                      />
                    </details>
                  ) : (
                    <blockquote className="rounded-control border-line bg-card text-ink overflow-hidden border text-sm leading-relaxed">
                      <p className="border-line text-ink-3 flex items-center gap-2 border-b px-3 py-2 font-mono text-xs">
                        {i === 3 && (
                          <StateBadge
                            state="waiting"
                            label={`question ${session.question.id}`}
                          />
                        )}
                        {step.recorded.title}
                      </p>
                      <p className="wrap-anywhere p-3">{step.recorded.text}</p>
                    </blockquote>
                  ))}
                {step.commands.length > 0 && (
                  <CodeFrame
                    title="Claude's commands · written for this page"
                    code={step.commands.join("\n\n")}
                    surface="console"
                  />
                )}
                {step.recordedOutput && (
                  <CodeFrame
                    title="Recorded answer output"
                    code={step.recordedOutput}
                    surface="console"
                  />
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
