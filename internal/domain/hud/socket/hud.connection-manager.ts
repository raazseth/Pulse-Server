import WebSocket from "ws";

export class HudConnectionManager {
  private readonly sessionSockets = new Map<string, Set<WebSocket>>();
  private readonly socketSessions = new Map<WebSocket, Set<string>>();

  subscribe(socket: WebSocket, sessionId: string) {
    const sockets = this.sessionSockets.get(sessionId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.sessionSockets.set(sessionId, sockets);

    const sessions = this.socketSessions.get(socket) ?? new Set<string>();
    sessions.add(sessionId);
    this.socketSessions.set(socket, sessions);
  }

  unsubscribeAll(socket: WebSocket) {
    const sessions = this.socketSessions.get(socket);
    if (!sessions) {
      return;
    }

    for (const sessionId of sessions) {
      const sockets = this.sessionSockets.get(sessionId);
      if (!sockets) {
        continue;
      }

      sockets.delete(socket);
      if (sockets.size === 0) {
        this.sessionSockets.delete(sessionId);
      }
    }

    this.socketSessions.delete(socket);
  }

  broadcast(sessionId: string, message: unknown) {
    const sockets = this.sessionSockets.get(sessionId);
    if (!sockets?.size) {
      return;
    }

    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(payload);
        } catch {
          // socket closed between readyState check and send
        }
      }
    }
  }
}
