import { randomUUID } from "crypto";
import SC from "@/internal/pkg/response";
import { AppError } from "@/internal/pkg/AppError";
import { logger } from "@/internal/pkg/logger";
import {
  HudSession,
  PromptSuggestion,
  SessionContext,
  SessionEvent,
  SessionNote,
  SessionSnapshot,
  SessionStatus,
  SessionTag,
  SignalCue,
  TranscriptEntry,
} from "@/internal/domain/hud/model/hud.model";
import { SessionRepository } from "@/internal/domain/hud/repository/session.repository";
import { AIProvider } from "./ai.provider";
import { TranscriptProvider } from "./transcript.provider";

interface ProcessTranscriptChunkInput {
  sessionId: string;
  text: string;
  speakerId?: string;
  timestamp?: string;
  context?: SessionContext;
}

interface CreateTagInput {
  sessionId: string;
  label: string;
  transcriptId?: string;
  createdBy?: string;
  metadata?: Record<string, string>;
}

interface UpdateSessionContextInput {
  sessionId: string;
  context: SessionContext;
}

function stripEphemeralChunkContext(context?: SessionContext): SessionContext | undefined {
  if (!context || !("transcriptSource" in context)) return context;
  const { transcriptSource: _removed, ...rest } = context;
  return Object.keys(rest).length ? rest : undefined;
}

export class HudSessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly transcriptProvider: TranscriptProvider,
    private readonly aiProvider: AIProvider,
  ) {}

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const snapshot = await this.sessions.getSessionSnapshot(sessionId);
    if (!snapshot) {
      await this.sessions.ensureSession(sessionId);
      const created = await this.sessions.getSessionSnapshot(sessionId);
      if (!created) throw new AppError("Failed to initialise session", 0, SC.INTERNAL_SERVER_ERROR);
      return created;
    }

    return snapshot;
  }

  async processTranscriptChunk(input: ProcessTranscriptChunkInput): Promise<{
    entry: TranscriptEntry;
    prompts: PromptSuggestion[];
    signals: SignalCue[];
  }> {
    const transcriptSource = input.context?.transcriptSource;
    if (transcriptSource === "browser-speech" || transcriptSource === "server-transcribe") {
      const preview =
        input.text.length > 200 ? `${input.text.slice(0, 200)}…` : input.text;
      logger.info(
        `${transcriptSource} sessionId=${input.sessionId} speakerId=${input.speakerId ?? ""} textLength=${input.text.length} text=${JSON.stringify(preview)}`,
      );
    }

    await this.sessions.ensureSession(input.sessionId, stripEphemeralChunkContext(input.context));

    const entry = this.transcriptProvider.normalizeChunk(input);
    await this.sessions.saveTranscriptEntry(entry);

    await this.sessions.saveEvent(this.createEvent(input.sessionId, "transcript:chunk", {
      transcriptId: entry.id,
      speakerId: entry.speakerId,
    }));

    const signals = this.detectSignals(entry);

    // S-10: Run signal saves, session fetch, and recent transcript fetch in parallel
    const signalSaves = signals.map((signal) =>
      this.sessions.saveEvent(
        this.createEvent(input.sessionId, "signal:detected", {
          transcriptId: signal.transcriptId,
          kind: signal.kind,
          label: signal.label,
        }),
      ),
    );

    const [session, recentTranscript] = await Promise.all([
      this.sessions.getSession(input.sessionId),
      this.sessions.listRecentTranscriptEntries(input.sessionId, 8),
      ...signalSaves,
    ]);

    const prompts = await this.aiProvider.generateSuggestions({
      sessionId: input.sessionId,
      recentTranscript,
      context: session?.context,
    });

    await this.sessions.savePromptSuggestions(input.sessionId, prompts);
    await this.sessions.saveEvent(this.createEvent(input.sessionId, "prompt:update", {
      promptIds: prompts.map((prompt) => prompt.id),
      count: prompts.length,
    }));

    return { entry, prompts, signals };
  }

  async createTag(input: CreateTagInput): Promise<SessionTag> {
    await this.sessions.ensureSession(input.sessionId);

    if (input.transcriptId) {
      const exists = await this.sessions.hasTranscriptEntry(
        input.sessionId,
        input.transcriptId,
      );
      if (!exists) {
        throw new AppError("Transcript entry not found for session", 0, SC.NOT_FOUND);
      }
    }

    const label = input.label.trim();
    if (!label) {
      throw new AppError("Tag label is required", 0, SC.BAD_REQUEST);
    }

    const tag: SessionTag = {
      id: randomUUID(),
      sessionId: input.sessionId,
      transcriptId: input.transcriptId,
      label,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
      metadata: input.metadata ?? {},
    };

    await this.sessions.saveTag(tag);
    await this.sessions.saveEvent(this.createEvent(input.sessionId, "tag:created", {
      tagId: tag.id,
      transcriptId: tag.transcriptId,
      label: tag.label,
    }));

    return tag;
  }

  async exportSession(
    sessionId: string,
    format: "json" | "csv",
  ): Promise<{ body: string; contentType: string; filename: string }> {
    const snapshot = await this.getSessionSnapshot(sessionId);

    if (format === "json") {
      return {
        body: JSON.stringify(snapshot, null, 2),
        contentType: "application/json",
        filename: `hud-session-${sessionId}.json`,
      };
    }

    const rows = [
      "category,id,sessionId,timestamp,speakerId,text,label,transcriptId,eventType,eventPayload",
      ...snapshot.transcriptEntries.map((entry) =>
        this.toCsvRow([
          "transcript", entry.id, entry.sessionId, entry.timestamp,
          entry.speakerId, entry.text, "", "", "", "",
        ]),
      ),
      ...snapshot.tags.map((tag) =>
        this.toCsvRow([
          "tag", tag.id, tag.sessionId, tag.createdAt, "", "", tag.label,
          tag.transcriptId ?? "", "", JSON.stringify(
            Object.fromEntries(
              Object.entries(tag.metadata ?? {}).map(([k, v]) => [k, String(v)]),
            ),
          ),
        ]),
      ),
      ...snapshot.events.map((event) =>
        this.toCsvRow([
          "event", event.id, event.sessionId, event.timestamp, "", "", "", "",
          event.type, JSON.stringify(event.payload),
        ]),
      ),
    ];

    return {
      body: rows.join("\n"),
      contentType: "text/csv",
      filename: `hud-session-${sessionId}.csv`,
    };
  }

  async updateSessionContext(
    input: UpdateSessionContextInput,
  ): Promise<SessionSnapshot> {
    await this.sessions.ensureSession(input.sessionId, input.context);
    await this.sessions.saveEvent(
      this.createEvent(input.sessionId, "session:context-updated", {
        context: input.context,
      }),
    );

    return this.getSessionSnapshot(input.sessionId);
  }

  async createSession(input: { id: string; title: string; facilitator: string; audience: string; role: string; createdBy: string }): Promise<HudSession> {
    return this.sessions.createSession(input);
  }

  async getSession(sessionId: string): Promise<HudSession | null> {
    return this.sessions.getSession(sessionId);
  }

  async listSessions(createdBy: string): Promise<HudSession[]> {
    return this.sessions.listSessions(createdBy);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.sessions.deleteSession(sessionId);
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    if (status === 'active') {
      const current = await this.sessions.getSession(sessionId);
      if (current?.status === 'ended') {
        throw new AppError('Cannot reactivate an ended session', 0, SC.BAD_REQUEST);
      }
    }
    await this.sessions.updateSessionStatus(sessionId, status);
  }

  async createNote(input: { id: string; sessionId: string; label: string; body: string }): Promise<SessionNote> {
    await this.sessions.ensureSession(input.sessionId);
    return this.sessions.createNote(input);
  }

  async listNotes(sessionId: string): Promise<SessionNote[]> {
    return this.sessions.listNotes(sessionId);
  }

  async updateNote(sessionId: string, noteId: string, body: string): Promise<void> {
    await this.sessions.updateNote(sessionId, noteId, body);
  }

  async deleteNote(sessionId: string, noteId: string): Promise<void> {
    await this.sessions.deleteNote(sessionId, noteId);
  }

  async addTagToNote(noteId: string, tagId: string): Promise<void> {
    await this.sessions.addTagToNote(noteId, tagId);
  }

  async removeTagFromNote(noteId: string, tagId: string): Promise<void> {
    await this.sessions.removeTagFromNote(noteId, tagId);
  }

  private createEvent(
    sessionId: string,
    type: SessionEvent["type"],
    payload: Record<string, unknown>,
  ): SessionEvent {
    return {
      id: randomUUID(),
      sessionId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  private toCsvRow(values: unknown[]) {
    return values
      .map((value) => {
        const s = value == null ? "" : String(value);
        return `"${s.replace(/"/g, '""').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
      })
      .join(",");
  }

  private detectSignals(entry: TranscriptEntry): SignalCue[] {
    const text = entry.text.toLowerCase();
    const signals: SignalCue[] = [];

    if (/\.\.\.|pause|silence/.test(text)) {
      signals.push({
        id: randomUUID(),
        sessionId: entry.sessionId,
        transcriptId: entry.id,
        kind: "silence",
        label: "Possible pause or silence cue",
        timestamp: entry.timestamp,
      });
    }

    if (/(frustrated|confused|excited|love|hate|annoyed|happy)/.test(text)) {
      signals.push({
        id: randomUUID(),
        sessionId: entry.sessionId,
        transcriptId: entry.id,
        kind: "sentiment-shift",
        label: "Possible emotion or sentiment shift",
        timestamp: entry.timestamp,
      });
    }

    if (/(unexpected|surprising|blocked|issue|problem|pain point)/.test(text)) {
      signals.push({
        id: randomUUID(),
        sessionId: entry.sessionId,
        transcriptId: entry.id,
        kind: "keyword",
        label: "Unexpected keyword or friction signal",
        timestamp: entry.timestamp,
      });
    }

    return signals;
  }
}
