import http from "http";
import { URL } from "url";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { config } from "@/internal/config/config";
import { logger } from "@/internal/pkg/logger";
import { AuthService } from "@/internal/domain/auth/service/auth.service";
import { HudSessionService } from "@/internal/domain/hud/service/session.service";
import { HudConnectionManager } from "./hud.connection-manager";

const MAX_CONNECTIONS_PER_IP = 10;

const SubscribeSchema = z.object({
  sessionId: z.string().min(1).max(200),
});

const ChunkSchema = z.object({
  sessionId: z.string().min(1).max(200),
  text: z.string().min(1).max(10_000),
  speakerId: z.string().max(100).optional(),
  timestamp: z.string().optional(),
  context: z.record(z.string(), z.string().max(500)).optional(),
});

const TagSchema = z.object({
  sessionId: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  transcriptId: z.string().uuid().optional(),
  createdBy: z.string().max(100).optional(),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
});

const ContextSchema = z.object({
  sessionId: z.string().min(1).max(200),
  context: z.record(z.string(), z.string().max(1000)),
});

const WsMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session:subscribe"), payload: SubscribeSchema }),
  z.object({ type: z.literal("transcript:chunk"), payload: ChunkSchema }),
  z.object({ type: z.literal("tag:create"), payload: TagSchema }),
  z.object({ type: z.literal("session:context"), payload: ContextSchema }),
]);

type HudClientMessage = z.infer<typeof WsMessageSchema>;

function sendError(socket: WebSocket, message: string) {
  try {
    socket.send(JSON.stringify({ type: "error", payload: { message } }));
  } catch {
    // socket may already be closed
  }
}

// S-01: authService parameter added — JWT verified before upgrade handshake
export function initHudSocket(
  server: http.Server,
  hudService: HudSessionService,
  authService: AuthService,
) {
  const manager = new HudConnectionManager();
  const wss = new WebSocketServer({ noServer: true });
  const connectionsByIp = new Map<string, number>();

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "", "http://localhost");
    if (requestUrl.pathname !== config.hud.wsPath) return;

    // S-01: Reject connections without a valid JWT before completing the handshake
    const token = requestUrl.searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    try {
      authService.verifyAccessToken(token);
    } catch {
      logger.warn("WS auth: rejected connection with invalid token");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const ip = (request.socket.remoteAddress ?? "unknown");
    const count = connectionsByIp.get(ip) ?? 0;
    if (count >= MAX_CONNECTIONS_PER_IP) {
      logger.warn(`WS rate limit: rejected connection from ${ip}`);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
      ws.once("close", () => {
        const next = (connectionsByIp.get(ip) ?? 1) - 1;
        if (next <= 0) connectionsByIp.delete(ip);
        else connectionsByIp.set(ip, next);
      });
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket: WebSocket) => {
    try {
      socket.send(JSON.stringify({ type: "connection:ready" }));
    } catch {
      // socket may have closed immediately
    }

    socket.on("message", async (rawMessage: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawMessage.toString());
      } catch {
        sendError(socket, "Invalid JSON");
        return;
      }

      const result = WsMessageSchema.safeParse(parsed);
      if (!result.success) {
        sendError(socket, result.error.issues[0]?.message ?? "Invalid message");
        return;
      }

      try {
        await handleMessage(result.data, socket, manager, hudService);
      } catch (error) {
        sendError(socket, error instanceof Error ? error.message : "Unexpected socket error");
      }
    });

    socket.on("close", () => {
      manager.unsubscribeAll(socket);
    });
  });
}

async function handleMessage(
  message: HudClientMessage,
  socket: WebSocket,
  manager: HudConnectionManager,
  hudService: HudSessionService,
) {
  if (message.type === "session:subscribe") {
    manager.subscribe(socket, message.payload.sessionId);
    const snapshot = await hudService.getSessionSnapshot(message.payload.sessionId);
    try {
      socket.send(JSON.stringify({ type: "session:state", payload: snapshot }));
    } catch {
      // socket may have closed between subscribe and send
    }
    return;
  }

  if (message.type === "transcript:chunk") {
    const result = await hudService.processTranscriptChunk(message.payload);
    manager.broadcast(message.payload.sessionId, { type: "transcript:chunk", payload: result.entry });
    manager.broadcast(message.payload.sessionId, { type: "prompt:update", payload: result.prompts });
    if (result.signals.length) {
      manager.broadcast(message.payload.sessionId, { type: "signal:detected", payload: result.signals });
    }
    return;
  }

  if (message.type === "tag:create") {
    const tag = await hudService.createTag(message.payload);
    manager.broadcast(message.payload.sessionId, { type: "tag:created", payload: tag });
    return;
  }

  if (message.type === "session:context") {
    const snapshot = await hudService.updateSessionContext(message.payload);
    manager.broadcast(message.payload.sessionId, { type: "session:state", payload: snapshot });
  }
}
