export interface SessionContext {
  role?: string;
  company?: string;
  notes?: string;
  [key: string]: string | undefined;
}

export interface SignalCue {
  id: string;
  sessionId: string;
  transcriptId?: string;
  kind: "silence" | "sentiment-shift" | "keyword";
  label: string;
  timestamp: string;
}

export type SessionStatus = "active" | "paused" | "ended";

export interface HudSession {
  id: string;
  context: SessionContext;
  title: string;
  facilitator: string;
  audience: string;
  role: string;
  status: SessionStatus;
  createdBy?: string;
  noteCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionNote {
  id: string;
  sessionId: string;
  label: string;
  body: string;
  linkedTagIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptEntry {
  id: string;
  sessionId: string;
  text: string;
  timestamp: string;
  speakerId: string;
}

export interface PromptSuggestion {
  id: string;
  sessionId: string;
  title: string;
  text: string;
  timestamp: string;
  transcriptIds: string[];
  suggestionOrigin?: "model";
}

export interface SessionTag {
  id: string;
  sessionId: string;
  transcriptId?: string;
  label: string;
  createdAt: string;
  createdBy?: string;
  metadata?: Record<string, string>;
}

export type HudEventType =
  | "transcript:chunk"
  | "prompt:update"
  | "tag:created"
  | "session:context-updated"
  | "signal:detected";

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: HudEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SessionSnapshot {
  session: HudSession;
  transcriptEntries: TranscriptEntry[];
  tags: SessionTag[];
  notes: SessionNote[];
  prompts: PromptSuggestion[];
  events: SessionEvent[];
  signals: SignalCue[];
}
