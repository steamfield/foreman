import { Effect, FileSystem, PlatformError, Schema } from "effect";
import { RunEvent, StorageHeader } from "../../schemas/daemon";

const readBlock = Effect.fnUntraced(function* (
  file: FileSystem.File,
  path: string,
  position: bigint,
  size: number,
) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const read = yield* file.read(bytes.subarray(offset), { position: position + BigInt(offset) });
    if (read === 0)
      return yield* PlatformError.systemError({
        _tag: "UnexpectedEof",
        module: "history",
        method: "readEvents",
        pathOrDescriptor: path,
      });
    offset += read;
  }
  return bytes;
});

const latestLines = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.open(path, { flag: "r" });
  let position: bigint = (yield* file.stat).size;
  const chunks: Uint8Array[] = [];
  let records = 0;
  let terminated = false;
  let nonempty = false;
  while (position > 0n && records <= 10_000) {
    const size = Number(position < 65_536n ? position : 65_536n);
    position -= BigInt(size);
    const bytes = yield* readBlock(file, path, position, size);
    chunks.push(bytes);
    for (let i = bytes.length - 1; i >= 0; i--) {
      if (bytes[i] === 10) {
        if (terminated && nonempty) records++;
        terminated = true;
        nonempty = false;
      } else if (terminated) nonempty = true;
    }
  }
  const decoder = new TextDecoder();
  const text =
    chunks
      .reverse()
      .map((chunk) => decoder.decode(chunk, { stream: true }))
      .join("") + decoder.decode();
  const lines = text.split("\n");
  lines.pop();
  if (position > 0n) lines.shift();
  const complete = lines.filter((line) => line !== "");
  return {
    lines: complete.slice(-10_000),
    countsAtLeast: complete.length > 10_000 || position > 0n,
  };
});

/** Reads at most the latest 10,000 committed history events without scanning older journal data.
 * @throws {PlatformError.PlatformError} When the journal cannot be read.
 * @throws {Schema.SchemaError} When a retained event cannot be decoded.
 */
export const readHistoryEvents = Effect.fnUntraced(function* (dir: string) {
  const tail = yield* latestLines(`${dir}/events.jsonl`).pipe(
    Effect.scoped,
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed({ lines: [], countsAtLeast: false }),
    ),
  );
  const events = yield* Effect.forEach(tail.lines, (line) =>
    Effect.gen(function* () {
      const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(line);
      yield* Schema.decodeUnknownEffect(StorageHeader)(value);
      return yield* Schema.decodeUnknownEffect(RunEvent)(value);
    }),
  );
  return { events, countsAtLeast: tail.countsAtLeast };
});
