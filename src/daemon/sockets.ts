import { Context, type Effect, Layer, type Scope } from "effect";
import type { Socket, SocketServer } from "effect/socket";

// Binding must happen after acquiring the lock, so the platform supplies constructors.
export class DaemonSockets extends Context.Service<
  DaemonSockets,
  {
    connect: (path: string) => Effect.Effect<Socket.Socket>;
    listen: (
      path: string,
    ) => Effect.Effect<
      SocketServer.SocketServer["Service"],
      SocketServer.SocketServerError,
      Scope.Scope
    >;
  }
>()("app/daemon/Sockets") {
  static layer = (value: DaemonSockets["Service"]) => Layer.succeed(DaemonSockets, value);
}
