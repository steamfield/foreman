// Shared static building blocks for landing sections. Server-rendered only;
// islands import these too. Styling uses the tokens in src/styles/global.css.
import type { ReactNode } from "react";

/** Renders `backtick` spans in copy as inline code. */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
          <code key={i}>{part.slice(1, -1)}</code>
        ) : (
          part
        ),
      )}
    </>
  );
}

export interface SectionProps {
  id: string;
  title: string;
  lede?: string;
  /** Alternate background band. */
  band?: boolean;
  /** Fire `section_viewed` when this section scrolls into view. */
  track?: boolean;
  children?: ReactNode;
}

export function Section({
  id,
  title,
  lede,
  band = false,
  track = false,
  children,
}: SectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-track-section={track ? id : undefined}
      data-reveal=""
      className={`border-line border-t ${band ? "bg-band" : "bg-page"}`}
    >
      <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-8 sm:py-28">
        <header className="mb-12 max-w-[40rem]" data-motion="lift-md">
          <h2
            id={`${id}-title`}
            className="font-display text-ink text-[2.25rem] leading-[1.1]"
          >
            {title}
          </h2>
          {lede && (
            <p className="text-ink-2 mt-4 text-[1.0625rem] leading-relaxed">
              <Inline text={lede} />
            </p>
          )}
        </header>
        {children}
      </div>
    </section>
  );
}

export interface DataTableProps {
  caption: string;
  head: readonly string[];
  rows: readonly (readonly string[])[];
  /** Column indexes rendered in the mono face. */
  mono?: readonly number[];
}

export function DataTable({ caption, head, rows, mono = [] }: DataTableProps) {
  return (
    <div className="border-line bg-card rounded-frame overflow-x-auto border">
      <table className="w-full border-collapse text-left text-[0.9375rem]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-line border-b">
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="text-ink-3 px-4 py-3 text-sm font-medium"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]} className="border-line border-b last:border-b-0">
              {row.map((cell, i) => {
                const Cell = i === 0 ? "th" : "td";
                return (
                  <Cell
                    key={i}
                    scope={i === 0 ? "row" : undefined}
                    className={`text-ink px-4 py-3 align-top ${i === 0 ? "font-medium" : "text-ink-2"} ${mono.includes(i) ? "font-mono text-sm" : ""}`}
                  >
                    <Inline text={cell} />
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface CodeFrameProps {
  /** File name or command shown in the frame's bar. */
  title: string;
  code: string;
  /** Paper (default) for files on the page; console for terminal output. */
  surface?: "paper" | "console";
  className?: string;
}

export function CodeFrame({
  title,
  code,
  surface = "paper",
  className = "",
}: CodeFrameProps) {
  const consoleSurface = surface === "console";
  return (
    <figure
      className={`rounded-frame overflow-hidden border ${consoleSurface ? "border-console-line bg-console shadow-console" : "border-line bg-card"} ${className}`}
    >
      <figcaption
        className={`border-b px-4 py-2 font-mono text-xs ${consoleSurface ? "border-console-line bg-console-2 text-console-muted" : "border-line text-ink-3"}`}
      >
        {title}
      </figcaption>
      <pre
        className={`overflow-x-auto p-4 font-mono text-[0.8125rem] leading-relaxed ${consoleSurface ? "text-console-fg" : "text-ink"}`}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** Display states: forman's run states, with idle split by how the turn ended. */
export type BadgeState =
  | "starting"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "interrupted"
  | "lost";

const badgeLabel: Record<BadgeState, string> = {
  starting: "starting",
  running: "running",
  waiting: "question pending",
  done: "done",
  failed: "failed",
  interrupted: "interrupted",
  lost: "lost",
};

export function StateBadge({
  state,
  surface = "paper",
  label,
}: {
  state: BadgeState;
  surface?: "paper" | "console";
  label?: string;
}) {
  return (
    <span
      data-state={state}
      className={`state-badge rounded-chip inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-xs ${surface === "console" ? "border-console-line text-console-fg" : "border-line text-ink"}`}
    >
      <span aria-hidden="true" className={`state-square state-${state}`} />
      {label ?? badgeLabel[state]}
    </span>
  );
}
