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
import { AIProvider, isIntervieweeSpeakerId, shouldTriggerSuggestionAi } from "./ai.provider";
import { TranscriptProvider } from "./transcript.provider";

interface ProcessTranscriptChunkInput {
  sessionId: string;
  text: string;
  userId?: string;
  speakerId?: string;
  timestamp?: string;
  context?: SessionContext;
}

/** Persisted transcript + metadata; AI runs separately for WebSocket realtime when triggersSuggestionAi. */
export interface IngestTranscriptChunkResult {
  entry: TranscriptEntry;
  signals: SignalCue[];
  /** True when this chunk should queue async prompt generation (interviewee-style lines + HUD "interviewer"). */
  triggersSuggestionAi: boolean;
  mergedContext: SessionContext | undefined;
  /** Persisted prompts when chunk does not trigger AI; empty when triggersSuggestionAi. */
  existingPrompts: PromptSuggestion[];
}

interface CreateTagInput {
  sessionId: string;
  label: string;
  userId?: string;
  transcriptId?: string;
  createdBy?: string;
  metadata?: Record<string, string>;
}

interface UpdateSessionContextInput {
  sessionId: string;
  userId?: string;
  context: SessionContext;
}

function stripEphemeralChunkContext(context?: SessionContext): SessionContext | undefined {
  if (!context || !("transcriptSource" in context)) return context;
  const { transcriptSource: _removed, ...rest } = context;
  return Object.keys(rest).length ? rest : undefined;
}

export class HudSessionService {
  private readonly intervieweeSuggestionChain = new Map<string, Promise<PromptSuggestion[]>>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly transcriptProvider: TranscriptProvider,
    private readonly aiProvider: AIProvider,
  ) {}

  private async claimSessionIfUnowned(sessionId: string, userId: string): Promise<void> {
    const claimed = await this.sessions.setSessionOwnerIfUnset(sessionId, userId);
    if (claimed === userId) return;
    const again = await this.sessions.getSession(sessionId);
    if (!again) {
      throw new AppError("Session not found", 0, SC.NOT_FOUND);
    }
    if (again.createdBy === userId) return;
    throw new AppError("Forbidden: session is owned by another user", 0, SC.FORBIDDEN);
  }

  async assertUserCanAccessSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new AppError("Session not found", 0, SC.NOT_FOUND);
    }
    if (!session.createdBy) {
      await this.claimSessionIfUnowned(sessionId, userId);
      return;
    }
    if (session.createdBy !== userId) {
      throw new AppError("Forbidden: session is owned by another user", 0, SC.FORBIDDEN);
    }
  }

  private async ensureUserSession(userId: string | undefined, sessionId: string, context?: SessionContext): Promise<void> {
    const existing = await this.sessions.getSession(sessionId);
    if (!existing) {
      if (!userId) {
        throw new AppError("Session not found", 0, SC.NOT_FOUND);
      }
      await this.sessions.ensureSession(sessionId, stripEphemeralChunkContext(context), userId);
      return;
    }
    if (!userId) {
      throw new AppError("Authentication required", 0, SC.UNAUTHORIZED);
    }
    if (!existing.createdBy) {
      await this.claimSessionIfUnowned(sessionId, userId);
      return;
    }
    if (existing.createdBy !== userId) {
      throw new AppError("Forbidden: session is owned by another user", 0, SC.FORBIDDEN);
    }
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const snapshot = await this.sessions.getSessionSnapshot(sessionId);
    if (!snapshot) {
      throw new AppError("Session not found", 0, SC.NOT_FOUND);
    }
    return snapshot;
  }

  async ingestTranscriptChunk(input: ProcessTranscriptChunkInput): Promise<IngestTranscriptChunkResult> {
    const transcriptSource = input.context?.transcriptSource;
    if (transcriptSource === "browser-speech" || transcriptSource === "server-transcribe") {
      const preview =
        input.text.length > 200 ? `${input.text.slice(0, 200)}…` : input.text;
      logger.info(
        `${transcriptSource} sessionId=${input.sessionId} speakerId=${input.speakerId ?? ""} textLength=${input.text.length} text=${JSON.stringify(preview)}`,
      );
    }

    await this.ensureUserSession(input.userId, input.sessionId, input.context);
    await this.sessions.ensureSession(input.sessionId, stripEphemeralChunkContext(input.context), input.userId);

    const entry = this.transcriptProvider.normalizeChunk(input);
    await this.sessions.saveTranscriptEntry(entry);

    await this.sessions.saveEvent(this.createEvent(input.sessionId, "transcript:chunk", {
      transcriptId: entry.id,
      speakerId: entry.speakerId,
    }));

    const signals = this.detectSignals(entry);

    const signalSaves = signals.map((signal) =>
      this.sessions.saveEvent(
        this.createEvent(input.sessionId, "signal:detected", {
          transcriptId: signal.transcriptId,
          kind: signal.kind,
          label: signal.label,
        }),
      ),
    );

    const [session] = await Promise.all([
      this.sessions.getSession(input.sessionId),
      ...signalSaves,
    ]);

    const mergedContext: SessionContext | undefined = session
      ? {
          ...(session.context ?? {}),
          ...(session.title?.trim() ? { title: session.title.trim() } : {}),
          ...(session.facilitator?.trim() ? { facilitator: session.facilitator.trim() } : {}),
          ...(session.audience?.trim() ? { audience: session.audience.trim() } : {}),
          ...(session.role?.trim() ? { role: session.role.trim() } : {}),
        }
      : undefined;

    const triggersSuggestionAi = shouldTriggerSuggestionAi(entry.speakerId);
    const existingPrompts = triggersSuggestionAi
      ? []
      : (await this.sessions.getSessionSnapshot(input.sessionId))?.prompts ?? [];

    return { entry, signals, triggersSuggestionAi, mergedContext, existingPrompts };
  }

  runIntervieweeSuggestionGeneration(
    sessionId: string,
    triggerSpeakerId: string,
    mergedContext: SessionContext | undefined,
  ): Promise<PromptSuggestion[]> {
    const prev = this.intervieweeSuggestionChain.get(sessionId) ?? Promise.resolve([] as PromptSuggestion[]);
    const next = prev.catch(() => [] as PromptSuggestion[]).then(() =>
      this.materializeIntervieweeSuggestions(sessionId, triggerSpeakerId, mergedContext),
    );
    this.intervieweeSuggestionChain.set(sessionId, next);
    void next.finally(() => {
      if (this.intervieweeSuggestionChain.get(sessionId) === next) {
        this.intervieweeSuggestionChain.delete(sessionId);
      }
    });
    return next;
  }

  private async materializeIntervieweeSuggestions(
    sessionId: string,
    triggerSpeakerId: string,
    mergedContext: SessionContext | undefined,
  ): Promise<PromptSuggestion[]> {
    const recentTranscript = await this.sessions.listRecentTranscriptEntries(sessionId, 12);
    const anchorTranscriptId =
      [...recentTranscript].reverse().find((e) => isIntervieweeSpeakerId(e.speakerId))?.id
      ?? recentTranscript[recentTranscript.length - 1]?.id;
    const prompts = await this.aiProvider.generateSuggestions({
      sessionId,
      recentTranscript,
      context: mergedContext,
      triggerSpeakerId,
      anchorTranscriptId,
    });

    await this.sessions.savePromptSuggestions(sessionId, prompts);
    await this.sessions.saveEvent(this.createEvent(sessionId, "prompt:update", {
      promptIds: prompts.map((prompt) => prompt.id),
      count: prompts.length,
    }));
    return prompts;
  }

  async processTranscriptChunk(input: ProcessTranscriptChunkInput): Promise<{
    entry: TranscriptEntry;
    prompts: PromptSuggestion[];
    signals: SignalCue[];
  }> {
    const ingest = await this.ingestTranscriptChunk(input);
    const prompts = ingest.triggersSuggestionAi
      ? await this.runIntervieweeSuggestionGeneration(
          input.sessionId,
          ingest.entry.speakerId,
          ingest.mergedContext,
        )
      : ingest.existingPrompts;

    return { entry: ingest.entry, prompts, signals: ingest.signals };
  }

  async createTag(input: CreateTagInput): Promise<{ tag: SessionTag; created: boolean }> {
    await this.ensureUserSession(input.userId, input.sessionId);
    await this.sessions.ensureSession(input.sessionId, {}, input.userId);

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

    const catalogKey = input.metadata?.tagKey?.trim();
    if (input.transcriptId) {
      const existingTags = await this.sessions.listTags(input.sessionId);
      const dup = existingTags.find((t) => {
        if (t.transcriptId !== input.transcriptId) return false;
        if (catalogKey) return t.metadata?.tagKey === catalogKey;
        return t.label.trim() === label;
      });
      if (dup) {
        return { tag: dup, created: false };
      }
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

    return { tag, created: true };
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
      ...snapshot.prompts.map((p) =>
        this.toCsvRow([
          "prompt",
          p.id,
          p.sessionId,
          p.timestamp,
          "",
          p.text,
          p.title,
          (p.transcriptIds ?? []).join("|"),
          p.suggestionOrigin ?? "",
          "",
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
    const existing = await this.sessions.getSession(input.sessionId);
    if (!existing) {
      if (!input.userId) {
        throw new AppError("Session not found", 0, SC.NOT_FOUND);
      }
      await this.sessions.ensureSession(input.sessionId, input.context, input.userId);
    } else if (!input.userId) {
      throw new AppError("Authentication required", 0, SC.UNAUTHORIZED);
    } else if (!existing.createdBy) {
      await this.claimSessionIfUnowned(input.sessionId, input.userId);
    } else if (existing.createdBy !== input.userId) {
      throw new AppError("Forbidden: session is owned by another user", 0, SC.FORBIDDEN);
    }
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
        label: "Lexical cue: possible pause or silence",
        timestamp: entry.timestamp,
      });
    }

    if (/(frustrated|confused|excited|love|hate|annoyed|happy)/.test(text)) {
      signals.push({
        id: randomUUID(),
        sessionId: entry.sessionId,
        transcriptId: entry.id,
        kind: "sentiment-shift",
        label: "Lexical cue: possible emotion or sentiment shift",
        timestamp: entry.timestamp,
      });
    }

    if (/(unexpected|surprising|blocked|issue|problem|pain point)/.test(text)) {
      signals.push({
        id: randomUUID(),
        sessionId: entry.sessionId,
        transcriptId: entry.id,
        kind: "keyword",
        label: "Lexical cue: unexpected keyword or friction",
        timestamp: entry.timestamp,
      });
    }

    return signals;
  }
}
