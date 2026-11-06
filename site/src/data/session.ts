// Stub: unit "session" replaces this file. Interface: buildSession(question) -> Session.
import type { Run } from "./runs";

export interface Session {
  delegates: string[];
}

export function buildSession(questionSource: Run): Session {
  return { delegates: [questionSource.name] };
}
