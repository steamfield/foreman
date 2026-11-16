import { PassThrough, Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
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
export function monitorTerminal(columns = 100, rows = 40, stdoutIsTTY = true) {
  const stdin = new MonitorInput();
  let output = "";
  const waiters = new Set<() => void>();
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        for (const notify of waiters) notify();
        callback();
      },
    }),
    { isTTY: stdoutIsTTY, columns, rows },
  );
  const stderr = new PassThrough();
  return {
    stdin,
    stdout,
    output: () => output,
    waitFor: (text: string | RegExp, after = 0) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(notify);
          reject(new Error(`Missing terminal text: ${text}\n${output.slice(after)}`));
        }, 5000);
        const notify = () => {
          const visible = stripVTControlCharacters(output.slice(after));
          if (!(typeof text === "string" ? visible.includes(text) : text.test(visible))) return;
          waiters.delete(notify);
          clearTimeout(timeout);
          resolve();
        };
        waiters.add(notify);
        notify();
      }),
    layer: Terminal.layer({
      stdin,
      stdout,
      stderr,
      stdinIsTTY: true,
      stdoutIsTTY,
      columns,
      rows,
      resize: Stream.empty,
    }),
  };
}
