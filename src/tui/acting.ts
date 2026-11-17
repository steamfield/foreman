import { Effect, Fiber, FiberSet, Stream } from "effect";
import type { ActMessage, ActState } from "../core/monitor/act";
import type { ActingSession, openActing } from "../core/monitor/acting";
import { type AppError, DaemonUnavailable, detailFor, errorTable } from "../errors";

type ActingOpener = () => ReturnType<typeof openActing>;
type ActRequest = NonNullable<ActState["inFlight"]>;

/** Executes acting intents while owning and observing the session's scoped fiber. */
export const runActing = Effect.fn("tui.runActing")(function* <R>(
  open: ActingOpener,
  requests: Stream.Stream<ActRequest, never, R>,
  dispatch: (message: ActMessage) => void,
) {
  const fibers = yield* FiberSet.make<void, never>();
  let held: Fiber.Fiber<void, never> | undefined;
  let session: ActingSession | undefined;
  let lastId = 0;
  const report = <R2>(id: number, effect: Effect.Effect<string, AppError, R2>) =>
    effect.pipe(
      Effect.match({
        onFailure: (error) =>
          dispatch({
            type: "act-outcome",
            outcome: { id, ok: false, text: detailFor(error) ?? errorTable[error._tag].message },
          }),
        onSuccess: (text) => dispatch({ type: "act-outcome", outcome: { id, ok: true, text } }),
      }),
    );
  const enter = (id: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* open().pipe(Effect.result);
        if (opened._tag === "Failure") {
          yield* report(id, Effect.fail(opened.failure));
          return;
        }
        session = opened.success;
        yield* report(id, Effect.succeed("acting"));
        yield* session.closed;
        dispatch({ type: "acting-lost", text: "The daemon connection closed; back to watching." });
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          session = undefined;
        }),
      ),
    );
  const execute = (request: ActRequest) =>
    Effect.gen(function* () {
      if (request.id === lastId) return;
      lastId = request.id;
      const { id, intent } = request;
      if (intent.kind === "enter-acting") {
        if (held) yield* Fiber.interrupt(held);
        held = yield* FiberSet.run(fibers, enter(id));
      } else if (intent.kind === "leave-acting") {
        if (held) yield* Fiber.interrupt(held);
        held = undefined;
        yield* report(id, Effect.succeed("watching"));
      } else
        yield* report(
          id,
          session
            ? session.send(intent)
            : Effect.fail(
                new DaemonUnavailable({
                  detail: "The daemon connection closed; back to watching.",
                }),
              ),
        );
    });
  yield* Effect.raceFirst(Stream.runForEach(requests, execute), FiberSet.join(fibers));
}, Effect.scoped);
