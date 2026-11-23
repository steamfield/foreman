import type { ReactNode } from "react";
import { models, type ModelRole } from "../../data/landing";
import { CodeFrame, Inline } from "./primitives";

type Provider = (typeof models.providers)[number];

/** A recorded CLI transcript from fixtures/cli/. */
export interface CatalogRecording {
  command: string;
  output: string;
}

function RoleCard({
  role,
  lead = false,
  children,
}: {
  role: ModelRole;
  lead?: boolean;
  children?: ReactNode;
}) {
  // Claude's card sits beside the provider headings (h3); model cards sit under them.
  const Heading = lead ? "h3" : "h4";
  return (
    <div
      className={`rounded-frame flex min-w-0 flex-col gap-3 border p-5 ${lead ? "border-ink bg-card h-full sm:p-6" : "border-line bg-page"}`}
      data-motion="lift-card"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Heading
          className={`text-ink font-semibold ${lead ? "font-display text-2xl" : "font-mono text-lg"}`}
        >
          {role.name}
        </Heading>
        <span className="rounded-chip bg-band text-ink-2 px-1.5 py-0.5 font-mono text-xs">
          {role.model}
        </span>
      </div>
      <p className="text-ink-2 leading-relaxed">
        <Inline text={role.job} />
      </p>
      {children}
      {role.evidence && (
        <p className="text-ink-3 mt-auto text-sm">
          <span className="text-ink-2 font-medium">On this page: </span>
          {role.evidence}
        </p>
      )}
    </div>
  );
}

/** One provider's heading, what it is, and a card per model it serves. */
function ProviderGroup({ provider }: { provider: Provider }) {
  const roles = models.roles.filter((role) => role.provider === provider.id);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h3 className="text-ink font-display text-2xl font-semibold">
          {provider.name}
        </h3>
        <p className="text-ink-2 mt-2 max-w-[40rem] leading-relaxed">
          <Inline text={provider.summary} />
        </p>
      </div>
      <div
        className={`grid gap-4 ${provider.id === "agy" ? "sm:grid-cols-2" : ""}`}
        data-stagger
      >
        {roles.map((role) => (
          <RoleCard key={role.model} role={role} />
        ))}
      </div>
    </div>
  );
}

/** Claude Code's card, with the command loop it uses to drive any delegate. */
function OrchestratorCard({ role }: { role: ModelRole }) {
  return (
    <RoleCard role={role} lead>
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
  );
}

/**
 * Who does what: Claude Code orchestrates, and each provider's models take the
 * work. `catalog` is the recorded `foreman models` output that shows both catalogs.
 */
export function Models({ catalog }: { catalog: CatalogRecording }) {
  const orchestrator = models.roles.find((role) => role.provider === "claude");
  const [codex, agy] = models.providers;
  return (
    <div>
      <div className="grid gap-x-4 gap-y-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {orchestrator && <OrchestratorCard role={orchestrator} />}
        <ProviderGroup provider={codex} />
        <ProviderGroup provider={agy} />
        <div className="flex min-w-0 flex-col gap-4">
          <p className="text-ink-2 leading-relaxed">
            <Inline text={models.routing} />
          </p>
          <CodeFrame
            surface="console"
            title={catalog.command}
            code={catalog.output}
          />
        </div>
      </div>
      <p className="text-ink-2 mt-8 max-w-[44rem] leading-relaxed">
        <Inline text={models.guidance} />
      </p>
    </div>
  );
}
