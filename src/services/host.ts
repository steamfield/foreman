import { Context, Layer } from "effect";

export class Host extends Context.Service<
  Host,
  {
    name: string;
    version: string;
    build: string;
    platform: string;
    compiled: boolean;
    executable: ReadonlyArray<string>;
    pid: number;
  }
>()("app/Host") {
  static layer = (value: Host["Service"]) => Layer.succeed(Host, value);
}
