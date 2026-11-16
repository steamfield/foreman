import { Context, Layer, Stream } from "effect";

export type Size = { readonly columns: number; readonly rows: number };
export class Terminal extends Context.Service<
  Terminal,
  Size & {
    readonly stdinIsTTY: boolean;
    readonly stdoutIsTTY: boolean;
    readonly stdin: NodeJS.ReadableStream | null;
    readonly stdout: NodeJS.WritableStream | null;
    readonly stderr: NodeJS.WritableStream | null;
    readonly resize: Stream.Stream<Size>;
  }
>()("app/Terminal") {
  static layer = (value: Terminal["Service"]) => Layer.succeed(Terminal, value);
  // Invocation hosts without interactive streams retain the snapshot interface.
  static nonInteractive: Terminal["Service"] = {
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdin: null,
    stdout: null,
    stderr: null,
    columns: 80,
    rows: 24,
    resize: Stream.empty,
  };
}
