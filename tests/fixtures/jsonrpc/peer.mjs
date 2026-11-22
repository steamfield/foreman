// A scripted JSON-RPC peer for tests/providers/jsonrpc.test.ts. It reads one JSON message per
// line on stdin and reacts by method:
//   echo      replies with its params as the result
//   reject    replies with JSON-RPC error -7 "refused"
//   hold      sends no reply; notifies "holding" with { id } so the test knows it arrived
//   release   replies late to the held request { id }, then notifies "released"
//   ask       notifies "asking", sends server requests with ids "ask-1" and 9, then replies
//   garbage   writes a line that is not JSON
//   exit      exits with params.code
//   cwd       replies with the process working directory
// A response the test sends back (no method) is reported as an "answered" notification.
import { createInterface } from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });

const handlers = {
  echo: ({ id, params }) => reply(id, params),
  reject: ({ id }) => write({ jsonrpc: "2.0", id, error: { code: -7, message: "refused" } }),
  hold: ({ id }) => write({ jsonrpc: "2.0", method: "holding", params: { id } }),
  release: ({ id, params }) => {
    reply(params.id, "too late");
    reply(id, null);
    write({ jsonrpc: "2.0", method: "released" });
  },
  ask: ({ id }) => {
    write({ jsonrpc: "2.0", method: "asking", params: { step: 1 } });
    write({ jsonrpc: "2.0", id: "ask-1", method: "question", params: { text: "first" } });
    write({ jsonrpc: "2.0", id: 9, method: "question" });
    reply(id, "asked");
  },
  garbage: () => process.stdout.write("this is not json\n"),
  exit: ({ params }) => process.exit(params.code),
  cwd: ({ id }) => reply(id, process.cwd()),
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    write({ jsonrpc: "2.0", method: "answered", params: { id: message.id, result: message.result, error: message.error } });
    return;
  }
  handlers[message.method]?.(message);
});
