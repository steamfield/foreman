import type { ReactNode } from "react";
import { models } from "../../data/landing";
import { Inline } from "./primitives";

type Role = (typeof models.roles)[number];

function RoleCard({
  role,
  lead = false,
  children,
}: {
  role: Role;
  lead?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-frame flex min-w-0 flex-col gap-3 border p-5 ${lead ? "border-ink bg-card h-full sm:p-6" : "border-line bg-page"}`}
      data-motion="lift-card"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3
          className={`text-ink font-semibold ${lead ? "font-display text-2xl" : "font-mono text-lg"}`}
        >
          {role.name}
        </h3>
        <span className="rounded-chip bg-band text-ink-2 px-1.5 py-0.5 font-mono text-xs">
          {role.model}
        </span>
      </div>
      <p className="text-ink-2 leading-relaxed">{role.job}</p>
      {children}
      <p className="text-ink-3 mt-auto text-sm">
        <span className="text-ink-2 font-medium">On this page: </span>
        {role.evidence}
      </p>
    </div>
  );
}

/** Who does what: Claude Code orchestrates, three Codex models take the work. */
export function Models() {
  const [lead, ...delegates] = models.roles;
  return (
    <div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {lead && (
          <RoleCard role={lead} lead>
            <div className="mt-2 min-w-0">
              <p className="text-ink-3 mb-2 text-xs">
                How Claude drives a delegate · written for this page
              </p>
              <ul className="bg-console text-console-fg rounded-control flex flex-col gap-2 overflow-x-auto p-4 font-mono text-xs leading-relaxed">
                {models.loop.map((line) => (
                  <li key={line} className="whitespace-pre-wrap break-words">
                    <span className="text-console-muted">$ </span>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </RoleCard>
        )}
        <div className="grid gap-4" data-stagger>
          {delegates.map((role) => (
            <RoleCard key={role.name} role={role} />
          ))}
        </div>
      </div>
      <p className="text-ink-2 mt-8 max-w-[44rem] leading-relaxed">
        <Inline text={models.guidance} />
      </p>
    </div>
  );
}
