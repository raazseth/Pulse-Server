import http from "http";
import { randomUUID } from "crypto";
import { URL } from "url";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { config } from "@/internal/config/config";
import { logger } from "@/internal/pkg/logger";
import { AuthService } from "@/internal/domain/auth/service/auth.service";
import { HudSessionService } from "@/internal/domain/hud/service/session.service";
import { transcriptionService } from "@/internal/domain/hud/service/transcription.service";
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

const AudioChunkSchema = z.object({
  sessionId: z.string().min(1).max(200),
  audio: z.string().min(1).max(2_000_000),
  mimeType: z.string().max(100).optional().default("audio/webm"),
  speakerId: z.string().max(100).optional(),
  lang: z.string().max(10).optional(),
  context: z.record(z.string(), z.string().max(500)).optional(),
});

const WsMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session:subscribe"), payload: SubscribeSchema }),
  z.object({ type: z.literal("transcript:chunk"), payload: ChunkSchema }),
  z.object({ type: z.literal("audio:chunk"), payload: AudioChunkSchema }),
  z.object({ type: z.literal("tag:create"), payload: TagSchema }),
  z.object({ type: z.literal("session:context"), payload: ContextSchema }),
]);

type HudClientMessage = z.infer<typeof WsMessageSchema>;

function sendError(socket: WebSocket, message: string) {
  try {
    socket.send(JSON.stringify({ type: "error", payload: { message } }));
  } catch {
  }
}

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

// Whisper commonly hallucinates these patterns on silent / near-silent audio
const HALLUCINATION_RE = /^\s*(\[.*?\]|\(.*?\)|thanks?\.?|you\.?|bye\.?|\.{1,3})\s*$/i;

function isWhisperHallucination(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length < 3) return true;
  if (HALLUCINATION_RE.test(t)) return true;
  // Repetition: "you you you" or "the the the" – common silence artefact
  const words = t.split(/\s+/);
  if (words.length >= 3 && new Set(words).size === 1) return true;
  return false;
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

  if (message.type === "audio:chunk") {
    const { sessionId, audio, mimeType, speakerId, lang, context } = message.payload;
    const audioBuffer = Buffer.from(audio, "base64");
    const rawLang = lang?.split("-")[0]?.toLowerCase() ?? "en";
    const normalizedLang = /^[a-z]{2,3}$/.test(rawLang) ? rawLang : "en";

    logger.success(`[audio:chunk] received sessionId=${sessionId} bytes=${audioBuffer.length} mimeType=${mimeType}`);

    // Immediately acknowledge — client shows "transcribing…" indicator
    const partialId = randomUUID();
    manager.broadcast(sessionId, {
      type: "TRANSCRIPT_PARTIAL",
      payload: { id: partialId, sessionId, speakerId: speakerId ?? "system" },
    });

    const t0 = Date.now();
    let text: string;
    try {
      text = await transcriptionService.transcribe(audioBuffer, normalizedLang, mimeType);
      logger.success(`[audio:chunk] transcribed sessionId=${sessionId} text="${text.slice(0, 80)}" ms=${Date.now() - t0}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`audio:chunk transcription error: ${msg}`);
      manager.broadcast(sessionId, { type: "TRANSCRIPT_PARTIAL_CANCEL", payload: { id: partialId } });
      sendError(socket, "Transcription failed");
      return;
    }

    if (!text || isWhisperHallucination(text)) {
      manager.broadcast(sessionId, { type: "TRANSCRIPT_PARTIAL_CANCEL", payload: { id: partialId } });
      return;
    }

    const result = await hudService.processTranscriptChunk({ sessionId, text, speakerId, context });

    // Named events per spec
    manager.broadcast(sessionId, {
      type: "TRANSCRIPT_FINAL",
      payload: { ...result.entry, partialId },
    });
    manager.broadcast(sessionId, {
      type: "AI_SUGGESTION",
      payload: result.prompts,
    });

    // Legacy aliases kept for any client code still using the old names
    manager.broadcast(sessionId, { type: "transcript:chunk", payload: result.entry });
    manager.broadcast(sessionId, { type: "prompt:update", payload: result.prompts });
    if (result.signals.length) {
      manager.broadcast(sessionId, { type: "signal:detected", payload: result.signals });
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
