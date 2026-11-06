import type { ConsoleStep } from "../../../data/supervision";
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
    <div
      data-step={step.id}
      className={`min-w-0 ${step.kind === "question" ? "border-signal border-l-2 pl-3" : ""}`}
    >
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
          <div className="min-w-0 flex-1">
            {step.label && (
              <p
                className={
                  step.kind === "question"
                    ? "text-signal"
                    : "text-console-muted"
                }
              >
                {step.kind === "question"
                  ? `question ${step.label}`
                  : step.label}
              </p>
            )}
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
