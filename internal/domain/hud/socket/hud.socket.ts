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
const MAX_WS_MESSAGE_CHARS = 2_200_000;
const socketUserId = new WeakMap<WebSocket, string>();

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
  transcriptId: z.string().min(1).max(200).optional(),
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
    let authedUserId: string;
    try {
      authedUserId = authService.verifyAccessToken(token).userId;
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
      socketUserId.set(ws, authedUserId);
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
      const raw = rawMessage.toString();
      if (raw.length > MAX_WS_MESSAGE_CHARS) {
        sendError(socket, "Message too large");
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendError(socket, "Invalid JSON");
        return;
      }

      const result = WsMessageSchema.safeParse(parsed);
      if (!result.success) {
        sendError(socket, result.error.issues[0]?.message ?? "Invalid message");
        return;
      }

      const userId = socketUserId.get(socket);
      if (!userId) {
        sendError(socket, "Unauthorized");
        return;
      }

      try {
        await handleMessage(result.data, socket, manager, hudService, userId);
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
  const words = t.split(/\s+/);
  if (words.length >= 3 && new Set(words).size === 1) return true;
  return false;
}

async function handleMessage(
  message: HudClientMessage,
  socket: WebSocket,
  manager: HudConnectionManager,
  hudService: HudSessionService,
  userId: string,
) {
  if (message.type === "session:subscribe") {
    await hudService.assertUserCanAccessSession(userId, message.payload.sessionId);
    manager.subscribe(socket, message.payload.sessionId);
    const snapshot = await hudService.getSessionSnapshot(message.payload.sessionId);
    try {
      socket.send(JSON.stringify({ type: "session:state", payload: snapshot }));
    } catch {
    }
    return;
  }

  if (message.type === "transcript:chunk") {
    const { sessionId } = message.payload;
    await hudService.assertUserCanAccessSession(userId, sessionId);
    const ingest = await hudService.ingestTranscriptChunk(message.payload);
    manager.broadcast(sessionId, { type: "transcript:chunk", payload: ingest.entry });
    if (ingest.signals.length) {
      manager.broadcast(sessionId, { type: "signal:detected", payload: ingest.signals });
    }
    if (ingest.isInterviewee) {
      void hudService
        .runIntervieweeSuggestionGeneration(sessionId, ingest.entry.speakerId, ingest.mergedContext)
        .then((prompts) => {
          manager.broadcast(sessionId, { type: "AI_SUGGESTION", payload: prompts });
          manager.broadcast(sessionId, { type: "prompt:update", payload: prompts });
        })
        .catch((err) => {
          logger.error(
            `transcript:chunk interviewee AI: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } else {
      manager.broadcast(sessionId, { type: "prompt:update", payload: ingest.existingPrompts });
    }
    return;
  }

  if (message.type === "audio:chunk") {
    const { sessionId, audio, mimeType, speakerId, lang, context } = message.payload;
    await hudService.assertUserCanAccessSession(userId, sessionId);
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

    const ingest = await hudService.ingestTranscriptChunk({
      sessionId,
      text,
      speakerId: speakerId?.trim() || "system",
      context,
    });

    manager.broadcast(sessionId, {
      type: "TRANSCRIPT_FINAL",
      payload: { ...ingest.entry, partialId },
    });
    manager.broadcast(sessionId, { type: "transcript:chunk", payload: ingest.entry });
    if (ingest.signals.length) {
      manager.broadcast(sessionId, { type: "signal:detected", payload: ingest.signals });
    }

    if (ingest.isInterviewee) {
      logger.info(
        `HUD AI ▸ queue suggestions (audio) [session=${sessionId}] speakerId=${ingest.entry.speakerId} transcriptId=${ingest.entry.id}`,
      );
      void hudService
        .runIntervieweeSuggestionGeneration(sessionId, ingest.entry.speakerId, ingest.mergedContext)
        .then((prompts) => {
          logger.info(
            `HUD AI ▸ broadcast suggestions (audio) [session=${sessionId}] count=${prompts.length} transcriptId=${ingest.entry.id}`,
          );
          manager.broadcast(sessionId, { type: "AI_SUGGESTION", payload: prompts });
          manager.broadcast(sessionId, { type: "prompt:update", payload: prompts });
        })
        .catch((err) => {
          logger.error(
            `audio:chunk interviewee AI: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } else {
      manager.broadcast(sessionId, { type: "prompt:update", payload: ingest.existingPrompts });
    }
    return;
  }

  if (message.type === "tag:create") {
    await hudService.assertUserCanAccessSession(userId, message.payload.sessionId);
    const { tag, created: isNew } = await hudService.createTag(message.payload);
    if (isNew) {
      manager.broadcast(message.payload.sessionId, { type: "tag:created", payload: tag });
    }
    return;
  }

  if (message.type === "session:context") {
    await hudService.assertUserCanAccessSession(userId, message.payload.sessionId);
    const snapshot = await hudService.updateSessionContext(message.payload);
    manager.broadcast(message.payload.sessionId, { type: "session:state", payload: snapshot });
  }
}
