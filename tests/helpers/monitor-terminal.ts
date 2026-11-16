import { PassThrough, Readable, Writable } from "node:stream";
import { Stream } from "effect";
import { Terminal } from "../../src/services/terminal";

export class MonitorInput extends Readable {
  isTTY = true;
  isRaw = false;
  _read() {}
  setRawMode(raw: boolean) {
    this.isRaw = raw;
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
export function monitorTerminal(columns = 100, rows = 40) {
  const stdin = new MonitorInput();
  let output = "";
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    }),
    { isTTY: true, columns, rows },
  );
  const stderr = new PassThrough();
  return {
    stdin,
    stdout,
    output: () => output,
    layer: Terminal.layer({
      stdin,
      stdout,
      stderr,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      columns,
      rows,
      resize: Stream.empty,
    }),
  };
}
