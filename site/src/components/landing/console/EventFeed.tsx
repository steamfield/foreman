import type { ConsoleEvent } from "../../../data/supervision";
import { formatOffset } from "../../../lib/format";
import { ConsoleText } from "./ConsoleText";

export function EventEntry({
  event,
  interactive,
}: {
  event: ConsoleEvent;
  interactive: boolean;
}) {
  let content;
  switch (event.kind) {
    case "command":
      content = (
        <div className="flex min-w-0 gap-2">
          <span
            role="img"
            className={
              event.exitCode === null
                ? "text-state-running"
                : event.exitCode === 0
                  ? "text-state-done"
                  : "text-state-failed"
            }
            aria-label={
              event.exitCode === null ? "running" : `exit ${event.exitCode}`
            }
          >
            {event.exitCode === null
              ? "…"
              : event.exitCode === 0
                ? "✓"
                : `×${event.exitCode}`}
          </span>
          <span className="min-w-0 truncate" title={event.command}>
            {event.command}
          </span>
        </div>
      );
      break;
    case "files":
      content = (
        <div>
          <span className="text-console-muted">write </span>
          {event.paths.map((path) => (
            <div key={path} className="break-words">
              {path}
            </div>
          ))}
        </div>
      );
      break;
    case "message":
      content = (
        <ConsoleText
          text={event.text}
          interactive={interactive}
          label={`Codex message at ${formatOffset(event.t)}`}
        />
      );
      break;
    case "question":
      content = (
        <div className="border-signal border-l-2 pl-3">
          <p className="text-signal">question {event.id}</p>
          <ConsoleText
            text={event.text}
            interactive={interactive}
            label={`question ${event.id}`}
          />
        </div>
      );
      break;
    case "hook-blocked":
      content = (
        <div className="border-state-failed border-l-2 pl-3">
          <p className="text-state-failed">hook blocked</p>
          <ConsoleText
            text={event.feedback}
            interactive={interactive}
            label="hook feedback"
          />
        </div>
      );
      break;
    case "state":
      content = (
        <p className="text-console-muted">
          {event.from} → {event.to}
        </p>
      );
      break;
    case "question-resolved":
      content = (
        <p className="text-console-muted">
          {event.id}: {event.resolution}
        </p>
      );
      break;
    case "turn-started":
      content = (
        <p className="text-console-muted">
          turn {event.turn}: {event.turnKind}
        </p>
      );
      break;
    case "turn-completed":
      content = (
        <p className="text-console-muted">
          turn {event.turn}: {event.status}
        </p>
      );
      break;
  }
  return (
    <li className="min-w-0" data-event={event.seq}>
      <div className="text-console-muted mb-1 text-xs tabular-nums">
        {formatOffset(event.t)}
      </div>
      {content}
    </li>
  );
}
