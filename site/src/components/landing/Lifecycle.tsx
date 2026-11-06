import { usePlayback } from "@steamfield/ui/react/playback";
import { Tab, TabList, TabPanel, Tabs } from "@steamfield/ui/react/tabs";
import { useEffect, useId, useState } from "react";
import {
  type LifecycleId,
  type LifecycleModel,
  type LifecycleNode,
  tourAt,
  tourLength,
} from "../../data/lifecycle";
import { CodeFrame, Inline, StateBadge } from "./primitives";

// The DOM stays in reading order. Only the desktop diagram changes placement.
const positions: Record<
  LifecycleId,
  { x: number; y: number; classes: string }
> = {
  contract: {
    x: 100,
    y: 160,
    classes: "order-0 lg:col-start-1 lg:row-start-3",
  },
  start: { x: 300, y: 160, classes: "order-2 lg:col-start-2 lg:row-start-3" },
  running: { x: 500, y: 160, classes: "order-4 lg:col-start-3 lg:row-start-3" },
  question: { x: 500, y: 32, classes: "order-6 lg:col-start-3 lg:row-start-1" },
  done: { x: 700, y: 96, classes: "order-8 lg:col-start-4 lg:row-start-2" },
  failed: { x: 700, y: 160, classes: "order-10 lg:col-start-4 lg:row-start-3" },
  interrupted: {
    x: 700,
    y: 224,
    classes: "order-12 lg:col-start-4 lg:row-start-4",
  },
  lost: { x: 700, y: 288, classes: "order-14 lg:col-start-4 lg:row-start-5" },
  recover: {
    x: 900,
    y: 224,
    classes: "order-16 lg:col-start-5 lg:row-start-4",
  },
  review: { x: 900, y: 96, classes: "order-18 lg:col-start-5 lg:row-start-2" },
  archive: {
    x: 1100,
    y: 96,
    classes: "order-20 lg:col-start-6 lg:row-start-2",
  },
};

const panelOrder: Record<LifecycleId, string> = {
  contract: "order-1",
  start: "order-3",
  running: "order-5",
  question: "order-7",
  done: "order-9",
  failed: "order-11",
  interrupted: "order-13",
  lost: "order-15",
  recover: "order-17",
  review: "order-19",
  archive: "order-21",
};

// The tour's ring takes the stage's state color, distinct from the selected style.
const tourRing: Record<LifecycleNode["state"], string> = {
  starting: "ring-console-muted",
  running: "ring-state-running",
  waiting: "ring-signal",
  done: "ring-state-done",
  failed: "ring-state-failed",
  interrupted: "ring-state-interrupted",
  lost: "ring-console-muted",
};

function edgePath(from: LifecycleId, to: LifecycleId) {
  if (to === "question") return "M465 136 V56";
  if (from === "question") return "M535 56 V136";
  // The follow-up loops back under the diagram, in its own lane below Lost.
  if (from === "recover") return "M900 248 V336 H500 V184";
  const a = positions[from];
  const b = positions[to];
  return `M${a.x + 84} ${a.y} H${(a.x + b.x) / 2} V${b.y} H${b.x - 84}`;
}

function Detail({ node }: { node: LifecycleNode }) {
  return (
    <div className="border-line bg-card rounded-frame min-w-0 border p-4 sm:p-6">
      <h3 className="text-ink mb-4 text-lg font-semibold">{node.label}</h3>
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <h4 className="text-ink mb-2 font-semibold">foreman reports</h4>
          <p className="text-ink-2 text-sm leading-relaxed">
            <Inline text={node.reports} />
          </p>
          {node.excerpt && (
            <CodeFrame
              className={
                node.id === "question"
                  ? "mt-4 [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
                  : "mt-4"
              }
              title={node.excerpt.source}
              code={node.excerpt.text}
              surface="console"
            />
          )}
        </div>
        <div className="min-w-0">
          <h4 className="text-ink mb-2 font-semibold">Claude does</h4>
          <p className="text-ink-2 text-sm leading-relaxed">
            <Inline text={node.claude} />
          </p>
          <CodeFrame
            className="mt-4"
            title="Command / arguments"
            code={node.command}
          />
        </div>
      </div>
      <p className="text-ink-3 mt-4 text-xs">
        Explanations and command templates written for this page. Recorded
        excerpts are labeled.
      </p>
    </div>
  );
}

function Connections({
  model,
  crossing,
}: {
  model: LifecycleModel;
  crossing?: { from: LifecycleId; to: LifecycleId };
}) {
  const marker = useId();
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1200 352"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 top-0 hidden h-[22rem] w-full overflow-visible lg:block"
    >
      <defs>
        <marker
          id={marker}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 8 4 0 8" className="fill-ink-3" />
        </marker>
      </defs>
      {model.edges.map((edge) => (
        <path
          key={`${edge.from}-${edge.to}`}
          d={edgePath(edge.from, edge.to)}
          fill="none"
          className="stroke-ink-3"
          markerEnd={`url(#${marker})`}
        />
      ))}
      {crossing && (
        <path
          data-tour-edge={`${crossing.from}-${crossing.to}`}
          d={edgePath(crossing.from, crossing.to)}
          fill="none"
          strokeWidth={2}
          strokeDasharray="4 6"
          className="stroke-ink tour-flow"
        />
      )}
      <text
        x="450"
        y="92"
        textAnchor="end"
        className="fill-ink-3 font-mono text-xs"
      >
        ask
      </text>
      <text
        x="524"
        y="86"
        textAnchor="end"
        className="fill-ink-3 font-mono text-xs"
      >
        answer /
      </text>
      <text
        x="524"
        y="102"
        textAnchor="end"
        className="fill-ink-3 font-mono text-xs"
      >
        timeout
      </text>
      <text
        x="700"
        y="330"
        textAnchor="middle"
        className="fill-ink-3 font-mono text-xs"
      >
        followup
      </text>
    </svg>
  );
}

export function Lifecycle({ model }: { model: LifecycleModel }) {
  const [ready, setReady] = useState(false);
  const [wide, setWide] = useState(false);
  const [selected, setSelected] = useState("question");
  const [announcement, setAnnouncement] = useState("");
  // A looping walk through the graph until the reader touches the diagram.
  // It never changes the selection, moves focus or announces anything.
  const [touring, setTouring] = useState(true);
  const playback = usePlayback<HTMLDivElement>({
    duration: tourLength(model),
  });
  const { complete, replay } = playback;
  useEffect(() => {
    if (touring && complete) replay();
  }, [touring, complete, replay]);
  const tour =
    touring && playback.playing ? tourAt(model, playback.elapsed) : undefined;
  const stopTour = () => {
    if (!touring) return;
    setTouring(false);
    playback.pause();
  };

  useEffect(() => {
    const query = window.matchMedia("(min-width: 64rem)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    setReady(true);
    return () => query.removeEventListener("change", update);
  }, []);

  if (!ready) {
    return (
      <ol aria-label="Run lifecycle" className="flex min-w-0 flex-col gap-6">
        {model.nodes.map((node) => (
          <li key={node.id} className="min-w-0">
            <div className="mb-2">
              <StateBadge state={node.state} label={node.label} />
            </div>
            <Detail node={node} />
          </li>
        ))}
      </ol>
    );
  }

  return (
    <div className="min-w-0">
      <p className="text-ink-3 mb-4 text-sm">
        Select a stage to see what happens. The four wait endings are
        alternatives.
      </p>
      <div
        ref={playback.ref}
        className="relative"
        data-touring={tour ? true : undefined}
        onPointerDown={stopTour}
        onFocus={stopTour}
        onKeyDown={stopTour}
      >
        <Connections model={model} crossing={tour?.edge} />
        <Tabs
          id="lifecycle-stage"
          value={selected}
          defaultValue="question"
          asAnchors={false}
          orientation={wide ? "horizontal" : "vertical"}
          onValueChange={(value) => {
            setSelected(value);
            const node = model.nodes.find((entry) => entry.id === value);
            setAnnouncement(`${node?.label ?? value} details shown.`);
          }}
          className="relative grid min-w-0 grid-cols-1 gap-y-2 lg:grid-cols-6 lg:grid-rows-[repeat(5,4rem)_2rem_auto] lg:gap-y-0"
        >
          <TabList aria-label="Run lifecycle" className="contents">
            {model.nodes.map((node) => (
              <Tab
                key={node.id}
                value={node.id}
                className={`${positions[node.id].classes} rounded-control relative z-10 min-h-12 min-w-0 border px-2 py-2 text-left transition-shadow duration-300 lg:mx-4 lg:my-2 lg:min-h-0 lg:text-center ${selected === node.id ? "border-ink bg-band text-ink" : "border-line-strong bg-page text-ink-2 hover:border-ink"} ${tour?.node === node.id ? `ring-offset-page ring-2 ring-offset-2 ${tourRing[node.state]}` : ""}`}
              >
                <span
                  data-tour-active={tour?.node === node.id || undefined}
                  className="inline-flex items-center gap-2 font-mono text-[0.8125rem] leading-tight"
                >
                  <span
                    aria-hidden="true"
                    className={`state-square state-${node.state}`}
                  />
                  {node.label}
                </span>
              </Tab>
            ))}
          </TabList>
          {model.nodes.map((node) => (
            <TabPanel
              key={node.id}
              value={node.id}
              className={`${panelOrder[node.id]} min-w-0 lg:col-span-6 lg:col-start-1 lg:row-start-7 lg:mt-6`}
            >
              <Detail node={node} />
            </TabPanel>
          ))}
        </Tabs>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
