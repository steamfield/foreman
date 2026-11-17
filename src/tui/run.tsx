import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { render, type SuspendTerminal, useApp } from "ink";
import { type ReactNode, useEffect } from "react";
import type { ActState } from "../core/monitor/act";
import type { openActing } from "../core/monitor/acting";
import type { DetailFeed } from "../core/monitor/detail-feed";
import type { MonitorFeed } from "../core/monitor/feed";
import { initialState, reduce, view } from "../core/monitor/model";
import type { Message, State } from "../core/monitor/model-types";
import { DaemonUnavailable } from "../errors";
import type { RunName } from "../schemas/daemon";
import type { Terminal } from "../services/terminal";
import { runActing } from "./acting";
import { type EditorRunner, runEditors } from "./editor";
import { type FindRequests, type HistoryReader, runFind } from "./find-executor";
import {
  type InspectReaders,
  type InspectRequests,
  inspectDetail,
  runInspect,
} from "./inspect-executor";
import { type PagerRunner, runPagers } from "./pager";
import { MonitorApp } from "./screen";
import { theme } from "./theme";

type ActingOpener = () => ReturnType<typeof openActing>;
type ActRequest = NonNullable<ActState["inFlight"]>;

/** Executes acting intents while owning the scoped connection. */
export { runActing } from "./acting";

/** Streams the selected run's preview after selection settles. */
export const runPreview = <R,>(
  selected: Stream.Stream<RunName | null, never, R>,
  detail: (name: RunName) => Stream.Stream<DetailFeed, never, R>,
  dispatch: (message: Message) => void,
) =>
  selected.pipe(
    Stream.changes,
    Stream.switchMap((name) =>
      name === null
        ? Stream.empty
        : Stream.unwrap(
            Effect.sleep(250).pipe(
              Effect.as(
                Stream.suspend(() => detail(name)).pipe(
                  Stream.tap((value) =>
                    Effect.sync(() => dispatch({ type: "preview-feed", name, value })),
                  ),
                ),
              ),
            ),
          ),
    ),
    Stream.runDrain,
  );

function previewName(state: State): RunName | null {
  if (state.detail || !state.feed) return null;
  const overview = state.feed._tag === "Reconnecting" ? state.feed.last : state.feed.overview;
  return overview?.runs.find((run) => run.name === state.selected)?.name ?? null;
}

function TerminalOwner({
  ready,
  children,
}: {
  ready: Deferred.Deferred<SuspendTerminal>;
  children: ReactNode;
}) {
  const { suspendTerminal } = useApp();
  useEffect(() => {
    Deferred.doneUnsafe(ready, Effect.succeed(suspendTerminal));
  }, [ready, suspendTerminal]);
  return children;
}

/** Runs the interactive monitor and releases its terminal and acting session on exit. */
export const runMonitor = Effect.fn("tui.runMonitor")(function* <R, R2 = never, R3 = never>(
  terminal: Terminal["Service"],
  options: Parameters<typeof initialState>[0],
  feed: Stream.Stream<MonitorFeed, never, R>,
  detail: (name: RunName) => Stream.Stream<DetailFeed, never, R>,
  noColor: boolean,
  open: ActingOpener = () => Effect.fail(new DaemonUnavailable()),
  App: typeof MonitorApp = MonitorApp,
  edit: EditorRunner = () => Effect.fail(new Error("No editor runner was provided.")),
  read: HistoryReader<R2> = () => Effect.die("No history reader was provided."),
  inspect: InspectReaders<R3> = {
    changes: () => Effect.fail(new Error("No changes reader was provided.")),
    diff: () => Effect.fail(new Error("No diff reader was provided.")),
  },
  page: PagerRunner = () => Effect.fail(new Error("No pager runner was provided.")),
) {
  const { stdin, stdout, stderr } = terminal;
  if (stdin === null || stdout === null || stderr === null)
    return yield* Effect.die("Monitor needs terminal streams");
  const done = yield* Deferred.make<"quit" | "interrupt">();
  const colors = theme(undefined, noColor);
  let state: State = initialState(options);
  let model = view(state);
  let instance: ReturnType<typeof render> | undefined;
  const opened = yield* Queue.unbounded<RunName | null>();
  const selected = yield* Queue.unbounded<RunName | null>();
  const actions = yield* Queue.unbounded<ActRequest>();
  const editors = yield* Queue.unbounded<NonNullable<ActState["editor"]>>();
  const finds = yield* Queue.unbounded<FindRequests>();
  const inspections = yield* Queue.unbounded<InspectRequests>();
  const pagers = yield* Queue.unbounded<InspectRequests>();
  const editorTerminal = yield* Deferred.make<SuspendTerminal>();
  yield* Effect.addFinalizer(() => Queue.shutdown(opened));
  yield* Effect.addFinalizer(() => Queue.shutdown(selected));
  yield* Effect.addFinalizer(() => Queue.shutdown(actions));
  yield* Effect.addFinalizer(() => Queue.shutdown(editors));
  yield* Effect.addFinalizer(() => Queue.shutdown(finds));
  yield* Effect.addFinalizer(() => Queue.shutdown(inspections));
  yield* Effect.addFinalizer(() => Queue.shutdown(pagers));
  Queue.offerUnsafe(opened, state.detail?.name ?? null);
  Queue.offerUnsafe(selected, previewName(state));
  const update = (message: Message) => {
    const next = reduce(state, message);
    if (next === state) return;
    if (next.detail?.name !== state.detail?.name)
      Queue.offerUnsafe(opened, next.detail?.name ?? null);
    if (previewName(next) !== previewName(state)) Queue.offerUnsafe(selected, previewName(next));
    if (next.act.inFlight && next.act.inFlight.id !== state.act.inFlight?.id)
      Queue.offerUnsafe(actions, next.act.inFlight);
    if (next.act.editor && next.act.editor.id !== state.act.editor?.id)
      Queue.offerUnsafe(editors, next.act.editor);
    if (next.history?.id !== state.history?.id || next.clipboard?.id !== state.clipboard?.id)
      Queue.offerUnsafe(finds, { history: next.history, clipboard: next.clipboard });
    if (
      inspectDetail(next) !== null &&
      (next.detail?.changes?.id !== state.detail?.changes?.id ||
        next.detail?.diff?.id !== state.detail?.diff?.id ||
        (inspectDetail(state) === null &&
          next.detail?.changes?.files === null &&
          next.detail.changes.error === null))
    )
      Queue.offerUnsafe(inspections, next);
    if (next.pager && next.pager.id !== state.pager?.id) Queue.offerUnsafe(pagers, next);
    state = next;
    model = view(state, model);
    instance?.rerender(frame());
  };
  const onTick = (now: number) => update({ type: "tick", now });
  const onKey = (key: string) => {
    if (
      (key === "q" &&
        !model.act.answer &&
        !model.act.confirm &&
        !model.act.compose &&
        !model.filterBar?.editing &&
        !model.feedTabs?.editing &&
        !model.palette) ||
      key === "ctrl-c"
    )
      Deferred.doneUnsafe(done, Effect.succeed(key === "q" ? "quit" : "interrupt"));
    else update({ type: "key", key });
  };
  const frame = () => (
    <TerminalOwner ready={editorTerminal}>
      <App
        model={model}
        colors={colors}
        onKey={onKey}
        onTick={onTick}
        onAct={update}
        onFind={update}
        onInspect={update}
      />
    </TerminalOwner>
  );
  const mounted = yield* Effect.acquireRelease(
    Effect.sync(() => {
      instance = render(frame(), {
        stdin,
        stdout,
        stderr,
        alternateScreen: true,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
        maxFps: 10,
        incrementalRendering: true,
      });
      return instance;
    }),
    (app) =>
      Effect.promise(async () => {
        try {
          app.unmount();
          // The input effect owns render failures; teardown must still finish.
          await app.waitUntilExit().catch(() => undefined);
        } finally {
          app.cleanup();
        }
      }),
  );
  const updates = feed.pipe(
    Stream.runForEach((value) => Effect.sync(() => update({ type: "feed", value }))),
  );
  const resizes = terminal.resize.pipe(
    Stream.runForEach((size) => Effect.sync(() => update({ type: "resize", ...size }))),
  );
  const details = Stream.fromQueue(opened).pipe(
    Stream.switchMap((name) =>
      name === null
        ? Stream.empty
        : detail(name).pipe(
            Stream.tap((value) => Effect.sync(() => update({ type: "detail-feed", name, value }))),
          ),
    ),
    Stream.runDrain,
  );
  const input = Effect.tryPromise({
    try: () => mounted.waitUntilExit(),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("monitor.render.failed").pipe(Effect.andThen(Effect.die(error))),
    ),
  );
  const worker = yield* Effect.forkChild(
    Effect.all(
      [
        updates,
        details,
        runPreview(Stream.fromQueue(selected), detail, update),
        resizes,
        input,
        runActing(open, Stream.fromQueue(actions), update),
        runFind(read, Stream.fromQueue(finds), update, stdout),
        runInspect(inspect, Stream.fromQueue(inspections), update),
        Deferred.await(editorTerminal).pipe(
          Effect.flatMap((suspend) =>
            runPagers(inspect.diff, page, suspend, Stream.fromQueue(pagers), update),
          ),
        ),
        Deferred.await(editorTerminal).pipe(
          Effect.flatMap((suspend) => runEditors(edit, suspend, Stream.fromQueue(editors), update)),
        ),
      ],
      { concurrency: "unbounded" },
    ),
  );
  const result = yield* Effect.raceFirst(Deferred.await(done), Fiber.join(worker)).pipe(
    Effect.ensuring(Fiber.interrupt(worker)),
  );
  if (result === "interrupt") return yield* Effect.interrupt;
});
