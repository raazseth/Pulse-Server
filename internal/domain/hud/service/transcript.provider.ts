import { randomUUID } from "crypto";
import SC from "@/internal/pkg/response";
import { AppError } from "@/internal/pkg/AppError";
import { SessionContext, TranscriptEntry } from "@/internal/domain/hud/model/hud.model";

export interface TranscriptProvider {
  normalizeChunk(input: {
    sessionId: string;
    text: string;
    speakerId?: string;
    timestamp?: string;
    context?: SessionContext;
  }): TranscriptEntry;
}

export class DefaultTranscriptProvider implements TranscriptProvider {
  normalizeChunk(input: {
    sessionId: string;
    text: string;
    speakerId?: string;
    timestamp?: string;
  }): TranscriptEntry {
    const text = input.text.trim();
    if (!text) {
      throw new AppError("Transcript text is required", 0, SC.BAD_REQUEST);
    }

    return {
      id: randomUUID(),
      sessionId: input.sessionId,
      text,
      timestamp: input.timestamp ?? new Date().toISOString(),
      speakerId: input.speakerId?.trim() || "interviewee",
    };
  }
}
