import { models, type ModelRole } from "../../data/landing";
import { CodeFrame, Inline } from "./primitives";

type Provider = (typeof models.providers)[number];

/** A recorded CLI transcript from fixtures/cli/. */
export interface CatalogRecording {
  command: string;
  output: string;
}

/** Claude Code's card: its job, the command loop it drives delegates with, and its evidence. */
function OrchestratorCard({ role }: { role: ModelRole }) {
  return (
    <div
      className="rounded-frame border-ink bg-card flex min-w-0 flex-col gap-3 border p-5 sm:p-6 lg:sticky lg:top-20"
      data-motion="lift-card"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-ink font-display text-2xl font-semibold">
          {role.name}
        </h3>
        <span className="rounded-chip bg-band text-ink-2 px-1.5 py-0.5 font-mono text-xs">
          {role.model}
        </span>
      </div>
      <p className="text-ink-2 leading-relaxed">
        <Inline text={role.job} />
      </p>
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
      {role.evidence && (
        <p className="text-ink-3 text-sm">
          <span className="text-ink-2 font-medium">On this page: </span>
          {role.evidence}
        </p>
      )}
    </div>
  );
}

/** One model: name and id on one line, then its job and any evidence. */
function ModelRow({ role, compact }: { role: ModelRole; compact: boolean }) {
  return (
    <li
      className={`flex min-w-0 flex-col gap-1 ${compact ? "border-line border-t py-3" : "py-4"}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-ink font-mono text-base font-semibold">
          {role.name}
        </h4>
        <span className="rounded-chip bg-band text-ink-2 px-1.5 py-0.5 font-mono text-xs">
          {role.model}
        </span>
      </div>
      <p className="text-ink-2 leading-relaxed">
        <Inline text={role.job} />
      </p>
      {role.evidence && (
        <p className="text-ink-3 text-sm">
          <span className="text-ink-2 font-medium">On this page: </span>
          {role.evidence}
        </p>
      )}
    </li>
  );
}

/**
 * A provider's heading and summary over its models. Models with no recorded evidence
 * carry one short line each, so they sit two to a row instead of one per divided row.
 */
function ProviderSection({ provider }: { provider: Provider }) {
  const roles = models.roles.filter((role) => role.provider === provider.id);
  const compact = roles.every((role) => !role.evidence);
  return (
    <section className="min-w-0 px-5 pt-5 sm:px-6">
      <h3 className="text-ink font-display text-xl font-semibold">
        {provider.name}
      </h3>
      <p className="text-ink-3 mt-1 text-sm leading-relaxed">
        <Inline text={provider.summary} />
      </p>
      <ul
        className={
          compact
            ? "mt-4 grid gap-x-6 pb-2 sm:grid-cols-2"
            : "divide-line mt-1 divide-y"
        }
        data-stagger
      >
        {roles.map((role) => (
          <ModelRow key={role.model} role={role} compact={compact} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Who does what: Claude Code orchestrates, and each provider's models take the
 * work. `catalog` is the recorded `foreman models` output that shows both catalogs.
 */
export function Models({ catalog }: { catalog: CatalogRecording }) {
  const orchestrator = models.roles.find((role) => role.provider === "claude");
  return (
    <div className="flex flex-col gap-12">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
        {orchestrator && <OrchestratorCard role={orchestrator} />}
        <div className="rounded-frame border-line bg-page divide-line min-w-0 divide-y border">
          {models.providers.map((provider) => (
            <ProviderSection key={provider.id} provider={provider} />
          ))}
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
        <p className="text-ink-2 min-w-0 leading-relaxed">
          <Inline text={models.routing} />
        </p>
        <CodeFrame
          surface="console"
          title={catalog.command}
          code={catalog.output}
        />
      </div>
      <p className="text-ink-2 max-w-[44rem] leading-relaxed">
        <Inline text={models.guidance} />
      </p>
    </div>
  );
}
