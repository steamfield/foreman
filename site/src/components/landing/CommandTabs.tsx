import { enhanceCopyButtons } from "@steamfield/ui/copy";
import { CopyCommand } from "@steamfield/ui/react/copy";
import { Tab, TabList, TabPanel, Tabs } from "@steamfield/ui/react/tabs";
import { useEffect, useRef, useState } from "react";
import { type CommandDemo, commandOutputParts } from "../../data/commands";
import { track } from "../../lib/analytics";
import { Events } from "../../lib/events";

const tones = {
  running: "text-state-running",
  waiting: "text-signal",
  done: "text-state-done",
  failed: "text-state-failed",
  interrupted: "text-state-interrupted",
  lost: "text-console-muted",
};

export function CommandTabs({
  commands,
}: {
  commands: readonly CommandDemo[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const [hydrated, setHydrated] = useState(false);
  const [vertical, setVertical] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    setHydrated(true);
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setVertical(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (hydrated && root.current) return enhanceCopyButtons(root.current);
  }, [commands, hydrated]);

  if (commands.length === 0) return null;

  return (
    <div ref={root} className="min-w-0" data-nosnippet>
      <p className="text-ink-3 mb-4 text-sm">
        Command captions are written for this page. Console output is recorded.
      </p>
      <Tabs
        id="command"
        orientation={vertical ? "vertical" : "horizontal"}
        onValueChange={(name) => {
          track(Events.commandTab, { name });
          const command = commands.find((command) => command.name === name);
          setAnnouncement(`${command?.label ?? name} output shown.`);
        }}
        className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]"
      >
        <TabList
          aria-label="foreman commands"
          className="flex min-w-0 flex-row gap-1 overflow-x-auto p-1 lg:flex-col"
        >
          {commands.map((command) => (
            <Tab
              key={command.name}
              value={command.name}
              className="rounded-control border-line text-ink-2 shrink-0 border px-3 py-3 text-left no-underline hover:no-underline aria-selected:border-ink aria-selected:bg-card aria-selected:text-ink lg:shrink"
            >
              <span className="block font-mono text-sm font-medium">
                {command.label}
              </span>
              <span className="text-ink-3 mt-1 block max-w-[28rem] text-xs lg:max-w-none">
                {command.caption}
              </span>
            </Tab>
          ))}
        </TabList>
        <div className="flex min-w-0 flex-col gap-6">
          {commands.map((command) => (
            <TabPanel
              key={command.name}
              value={command.name}
              className="min-w-0 [[data-part=tabs]:not([data-live])_&]:block"
            >
              <figure className="rounded-frame border-console-line bg-console shadow-console min-w-0 overflow-hidden border">
                <figcaption className="border-console-line bg-console-2 text-console-muted border-b px-4 py-2 font-mono text-xs">
                  Recorded: {command.label}
                </figcaption>
                <div className="border-console-line text-console-fg border-b p-4">
                  {hydrated ? (
                    <CopyCommand
                      id={`command-line-${command.name}`}
                      command={command.command}
                      className="flex min-w-0 items-start gap-3 font-mono text-[0.8125rem]"
                      promptClassName="text-console-muted"
                      commandClassName="min-w-0 flex-1 whitespace-pre-wrap break-all text-[0.8125rem]"
                      buttonClassName="rounded-control shrink-0"
                    />
                  ) : (
                    // The page enhancer runs before client:visible hydration.
                    // Keep its controls out of this island's server markup.
                    <div className="flex min-w-0 items-start gap-3 font-mono text-[0.8125rem]">
                      <span className="text-console-muted" aria-hidden="true">
                        $
                      </span>
                      <code
                        id={`command-line-${command.name}`}
                        className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[0.8125rem]"
                      >
                        {command.command}
                      </code>
                    </div>
                  )}
                </div>
                <pre
                  tabIndex={0}
                  aria-label={`Output of ${command.label}`}
                  className="text-console-fg max-h-96 overflow-auto p-4 font-mono text-[0.8125rem] leading-relaxed"
                >
                  <code className="text-[0.8125rem]">
                    {commandOutputParts(command.output).map((part, index) =>
                      part.tone ? (
                        <span key={index} className={tones[part.tone]}>
                          {part.text}
                        </span>
                      ) : (
                        part.text
                      ),
                    )}
                  </code>
                </pre>
              </figure>
            </TabPanel>
          ))}
        </div>
      </Tabs>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
