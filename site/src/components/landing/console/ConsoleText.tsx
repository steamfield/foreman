import { useId, useState } from "react";

export function ConsoleText({
  text,
  interactive,
  label,
}: {
  text: string;
  interactive: boolean;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const collapsible = interactive && text.length > 280;
  return (
    <div className="min-w-0">
      <div
        id={id}
        className={`whitespace-pre-wrap break-words ${collapsible && !expanded ? "line-clamp-3" : ""}`}
      >
        {text}
      </div>
      {collapsible && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={`${expanded ? "Show less" : "Show all"} ${label}`}
          onClick={() => setExpanded(!expanded)}
          className="text-console-muted rounded-control mt-1 px-1 underline underline-offset-2 hover:text-console-fg"
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}
