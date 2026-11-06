import { Context, Effect, Layer, Predicate } from "effect";
import { type AppError, BrokenPipe, errorEnvelope, errorText, PermissionDenied } from "../errors";

export type Writer = (text: string) => Promise<void>;
const write = (writer: Writer, stream: "stdout" | "stderr", text: string) =>
  Effect.tryPromise({
    try: () => writer(`${text}\n`),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error): Effect.Effect<never, BrokenPipe | PermissionDenied> => {
      if (Predicate.hasProperty(error, "code")) {
        if (error.code === "EPIPE") return Effect.fail(new BrokenPipe());
        if (error.code === "EACCES" || error.code === "EPERM")
          return Effect.fail(
            new PermissionDenied({
              detail: `Cannot write to ${stream}. Check the output destination and its permissions, then retry.`,
            }),
          );
      }
      return Effect.die(error);
    }),
  );

export class Output extends Context.Service<
  Output,
  {
    json: boolean;
    setJson: (value: boolean) => Effect.Effect<void>;
    result: (value: unknown, text: string) => Effect.Effect<void>;
    flush: Effect.Effect<void, BrokenPipe | PermissionDenied>;
    note: (text: string) => Effect.Effect<void, BrokenPipe | PermissionDenied>;
    error: (error: AppError) => Effect.Effect<void, BrokenPipe | PermissionDenied>;
  }
>()("app/Output") {
  static layer = (json: boolean, stdout: Writer, stderr: Writer) =>
    Layer.sync(Output, () => {
      const pending: string[] = [];
      let machine = json;
      return {
        get json() {
          return machine;
        },
        setJson: (value) =>
          Effect.sync(() => {
            machine = value;
          }),
        result: (value, text) =>
          Effect.sync(() => {
            pending.push(machine ? JSON.stringify(value) : text);
          }),
        flush: Effect.gen(function* () {
          for (const text of pending.splice(0)) yield* write(stdout, "stdout", text);
        }),
        note: (text) => write(stderr, "stderr", text),
        error: (error) =>
          write(
            stderr,
            "stderr",
            machine ? JSON.stringify(errorEnvelope(error)) : errorText(error),
          ),
      };
    });
}
