// Stub: unit "session" replaces this file.
import type { Session } from "../../data/session";

export function SessionDiagram({ session }: { session: Session }) {
  return <div data-stub="session">{session.delegates.join(", ")}</div>;
}
