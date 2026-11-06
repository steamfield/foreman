import {
  contractExcerpt,
  digestBlocks,
  questionPairs,
  runTimelines,
} from "../../data/evidence";
import { parallel } from "../../data/landing";
import type { Run } from "../../data/runs";
import { formatElapsed, formatOffset, formatTokens } from "../../lib/format";
import { CodeFrame, DataTable, Inline } from "./primitives";

export function WorkOrder({ run, note }: { run: Run; note: string }) {
  const excerpt = contractExcerpt(run.contract);
  const digest = digestBlocks(run.digest);
  const contractId = `${run.name}-contract`;
  const scopePosition = {
    "--scope-start": `${digest.startLine}lh`,
    "--scope-height": `${digest.lineCount}lh`,
  };
  return (
    <div className="grid items-start gap-8 lg:grid-cols-12">
      <div className="min-w-0 lg:col-span-5">
        <article className="rounded-frame border-line bg-card relative border px-4 py-6 sm:px-6">
          <div
            aria-hidden="true"
            className="border-line-strong absolute inset-x-0 top-0 border-t border-dashed"
          >
            <span className="border-line-strong bg-band absolute -top-1.5 left-6 size-3 rounded-full border" />
            <span className="border-line-strong bg-band absolute -top-1.5 right-6 size-3 rounded-full border" />
          </div>
          <div className="text-ink space-y-6 font-mono text-sm leading-relaxed wrap-anywhere">
            <h3 className="font-semibold">{excerpt.title}</h3>
            <div>
              <p className="mb-2 font-semibold">## Goal</p>
              <p>{excerpt.goal}</p>
            </div>
            <p aria-label="Excerpt omitted">…</p>
            <div>
              <p className="mb-2 font-semibold">## Scope</p>
              {excerpt.scopeLines.map((line, index) => (
                <p key={index} className="mb-4 whitespace-pre-wrap last:mb-0">
                  {line.startsWith("- May change:") && (
                    <span className="border-signal-text text-signal-text rounded-chip mr-2 inline-block border px-1.5 py-0.5 text-xs">
                      May change
                    </span>
                  )}
                  {line}
                </p>
              ))}
            </div>
            <p aria-label="Excerpt omitted">…</p>
          </div>
        </article>
        <details
          id={contractId}
          className="border-line mt-4 min-w-0 border-t pt-4"
        >
          <summary className="text-ink cursor-pointer text-sm font-medium">
            Read the full contract
          </summary>
          <pre className="text-ink-2 mt-4 whitespace-pre-wrap font-mono text-sm leading-relaxed wrap-anywhere">
            {run.contract}
          </pre>
        </details>
      </div>
      <div
        className="min-w-0 lg:col-span-7"
        style={{ position: "relative", ...scopePosition }}
      >
        <CodeFrame
          title={`forman status ${run.name}`}
          code={run.digest}
          surface="console"
          className="[&_code]:relative [&_code]:block [&_code]:before:absolute [&_code]:before:top-(--scope-start) [&_code]:before:-left-2 [&_code]:before:h-(--scope-height) [&_code]:before:border-l-2 [&_code]:before:border-signal"
        />
        <p className="text-ink-3 mt-4 text-sm leading-relaxed">
          <Inline text={note} />
        </p>
      </div>
    </div>
  );
}

export function QuestionTimeline({ run }: { run: Run }) {
  return (
    <ol className="border-line-strong ml-1 border-l">
      {questionPairs(run).map(({ asked, resolved, elapsedMs, hook }) => (
        <li key={asked.id} className="relative pb-12 pl-6 last:pb-0 sm:pl-8">
          {hook && (
            <div className="mb-8 min-w-0">
              <p className="text-ink-3 mb-3 font-mono text-xs">
                {formatOffset(hook.t)} · repo hook refused a write
              </p>
              <CodeFrame
                title="hook-blocked"
                code={hook.feedback}
                surface="console"
                className="[&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere"
              />
            </div>
          )}
          <div className="relative">
            <span
              aria-hidden="true"
              className="bg-signal absolute top-2 -left-7 size-2 sm:-left-9"
            />
            <h3 className="text-signal-text mb-3 font-mono text-sm font-medium">
              {formatOffset(asked.t)} · Codex asks {asked.id}
            </h3>
            <blockquote className="text-ink max-w-[40rem] whitespace-pre-wrap leading-relaxed wrap-anywhere">
              {asked.question}
            </blockquote>
          </div>
          <div className="relative mt-6">
            <span
              aria-hidden="true"
              className={`absolute top-2 -left-7 size-2 sm:-left-9 ${resolved.resolution === "answered" ? "bg-ink" : "bg-ink-3"}`}
            />
            <p
              className={`mb-3 font-mono text-sm ${resolved.resolution === "answered" ? "text-ink" : "text-ink-3"}`}
            >
              {formatOffset(resolved.t)} · {resolved.resolution} by{" "}
              {resolved.resolution === "answered"
                ? "Claude"
                : "forman after the timeout"}{" "}
              · {formatElapsed(elapsedMs)} later
            </p>
            <blockquote className="text-ink-2 max-w-[40rem] whitespace-pre-wrap leading-relaxed wrap-anywhere">
              {resolved.text}
            </blockquote>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ParallelRuns({ runs }: { runs: readonly Run[] }) {
  const timeline = runTimelines(runs);
  const percent = (ms: number) => `${(ms / timeline.extentMs) * 100}%`;
  return (
    <div>
      <div aria-hidden="true" className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <p className="text-ink-3 text-xs">Minutes from first start</p>
          <div className="relative h-6 font-mono text-xs tabular-nums">
            {timeline.ticks.map((tick, index) => (
              <span
                key={tick}
                className="text-ink-3 border-line-strong absolute w-0 border-l"
                style={{ left: percent(tick) }}
              >
                <span
                  className={`block w-max ${index === timeline.ticks.length - 1 ? "-translate-x-full pr-1" : "pl-1"}`}
                >
                  {tick / 60000}
                </span>
              </span>
            ))}
          </div>
        </div>
        {timeline.rows.map((row) => (
          <div
            key={row.name}
            className="border-line grid min-w-0 gap-3 border-b pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]"
          >
            <p className="text-ink font-mono text-sm font-medium">{row.name}</p>
            <div className="min-w-0">
              <div className="bg-line relative h-3">
                <div
                  className="bg-ink absolute inset-y-0"
                  style={{
                    left: percent(row.startMs),
                    width: percent(row.durationMs),
                  }}
                />
                {row.questions.map((question) => (
                  <span
                    key={question.id}
                    className="bg-signal absolute -top-1 h-5 w-1"
                    style={{ left: percent(question.atMs) }}
                  />
                ))}
              </div>
              <div className="text-ink-2 mt-3 flex justify-between gap-2 font-mono text-xs tabular-nums sm:justify-start sm:gap-8">
                <div>
                  {formatElapsed(row.durationMs)}
                  <span className="text-ink-3 block">duration</span>
                </div>
                <div>
                  {row.commands} / {row.failed}
                  <span className="text-ink-3 block">cmd / failed</span>
                </div>
                <div>
                  {row.files}
                  <span className="text-ink-3 block">files</span>
                </div>
                <div>
                  {formatTokens(row.outputTokens)}
                  <span className="text-ink-3 block">tokens out</span>
                </div>
              </div>
            </div>
          </div>
        ))}
        <p className="text-ink-3 flex items-center gap-2 text-xs">
          <span className="bg-signal h-3 w-1" /> Codex asked a question
        </p>
      </div>
      <div className="sr-only">
        <DataTable
          caption="Parallel release runs, measured from the earliest start"
          head={[
            "Run",
            "Start",
            "End",
            "Duration",
            "Commands (failed)",
            "Files written",
            "Output tokens",
            "Questions asked",
          ]}
          rows={timeline.rows.map((row) => [
            row.name,
            formatOffset(row.startMs),
            formatOffset(row.endMs),
            formatElapsed(row.durationMs),
            `${row.commands} (${row.failed} failed)`,
            String(row.files),
            formatTokens(row.outputTokens),
            row.questions
              .map((q) => `${q.id} at ${formatOffset(q.atMs)}`)
              .join(", ") || "None",
          ])}
        />
      </div>
      <p className="text-ink-2 mt-6 max-w-[40rem] leading-relaxed">
        {parallel.caption}
      </p>
      <p className="text-ink-3 mt-3 text-sm wrap-anywhere">
        <Inline
          text={`Base commit \`${timeline.baseCommit}\` · \`forman wait --all\``}
        />
      </p>
    </div>
  );
}
