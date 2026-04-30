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

export interface SessionRepository {
  initialize(): Promise<void>;
  ensureSession(sessionId: string, context?: SessionContext, createdBy?: string): Promise<HudSession>;
  getSession(sessionId: string): Promise<HudSession | null>;
  setSessionOwnerIfUnset(sessionId: string, userId: string): Promise<string | null>;
  saveTranscriptEntry(entry: TranscriptEntry): Promise<void>;
  hasTranscriptEntry(sessionId: string, transcriptId: string): Promise<boolean>;
  listRecentTranscriptEntries(sessionId: string, limit: number): Promise<TranscriptEntry[]>;
  listTranscriptEntries(sessionId: string): Promise<TranscriptEntry[]>;
  savePromptSuggestions(sessionId: string, prompts: PromptSuggestion[]): Promise<void>;
  listPromptSuggestions(sessionId: string): Promise<PromptSuggestion[]>;
  saveTag(tag: SessionTag): Promise<void>;
  listTags(sessionId: string): Promise<SessionTag[]>;
  saveEvent(event: SessionEvent): Promise<void>;
  listEvents(sessionId: string): Promise<SessionEvent[]>;
  listSignals(sessionId: string): Promise<SignalCue[]>;
  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null>;
  createSession(input: { id: string; title: string; facilitator: string; audience: string; role: string; createdBy: string }): Promise<HudSession>;
  listSessions(createdBy: string): Promise<HudSession[]>;
  deleteSession(sessionId: string): Promise<void>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  createNote(note: { id: string; sessionId: string; label: string; body: string }): Promise<SessionNote>;
  listNotes(sessionId: string): Promise<SessionNote[]>;
  updateNote(sessionId: string, noteId: string, body: string): Promise<void>;
  deleteNote(sessionId: string, noteId: string): Promise<void>;
  addTagToNote(noteId: string, tagId: string): Promise<void>;
  removeTagFromNote(noteId: string, tagId: string): Promise<void>;
}
