import type { ConsoleStep } from "../../../data/supervision";
import { StateBadge } from "../primitives";
import { ConsoleText } from "./ConsoleText";

export function TranscriptStep({
  step,
  time,
  interactive,
}: {
  step: ConsoleStep;
  time: number;
  interactive: boolean;
}) {
  const written =
    step.kind === "user" || step.kind === "prose" || step.kind === "note";
  return (
    <div data-step={step.id} className="min-w-0">
      {written && (
        <div className="text-console-muted mb-1 text-xs">
          Written for this page
        </div>
      )}
      {step.kind === "user" ? (
        <p>
          <span aria-hidden="true">❯ </span>
          {step.text}
        </p>
      ) : step.kind === "tool" ? (
        <>
          <ConsoleText
            text={`Bash(${step.text})`}
            interactive={interactive}
            label={step.id === "start" ? "start command" : "recorded answer"}
          />
          {step.backgroundUntil !== undefined &&
            time < step.backgroundUntil && (
              <span className="text-console-muted">background</span>
            )}
        </>
      ) : step.kind === "output" || step.kind === "question" ? (
        <div className="flex min-w-0 gap-2">
          <span aria-hidden="true" className="text-console-muted">
            ⎿
          </span>
          <div
            className={`min-w-0 flex-1 ${step.kind === "question" ? "console-note" : ""}`}
          >
            {step.label &&
              (step.kind === "question" ? (
                <StateBadge
                  state="waiting"
                  surface="console"
                  label={`question ${step.label}`}
                />
              ) : (
                <p className="text-console-muted">{step.label}</p>
              ))}
            <div className="whitespace-pre-wrap break-words">{step.text}</div>
          </div>
        </div>
      ) : (
        <p className={step.kind === "note" ? "text-console-muted" : ""}>
          {step.text}
        </p>
      )}
    </div>
  );
}
