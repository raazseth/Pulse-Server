import { Pool } from "pg";
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
import { SessionRepository } from "./session.repository";

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    logger.warn(`parseJson failed: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

function mapSignal(event: SessionEvent): SignalCue | null {
  if (event.type !== "signal:detected") return null;
  const { kind, label } = event.payload;
  if (
    (kind !== "silence" && kind !== "sentiment-shift" && kind !== "keyword") ||
    typeof label !== "string"
  ) {
    return null;
  }
  return {
    id: event.id,
    sessionId: event.sessionId,
    transcriptId: typeof event.payload.transcriptId === "string" ? event.payload.transcriptId : undefined,
    kind,
    label,
    timestamp: event.timestamp,
  };
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS hud_sessions (
        id TEXT PRIMARY KEY,
        context_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hud_transcript_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES hud_sessions(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        speaker_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hud_prompt_suggestions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES hud_sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        transcript_ids_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hud_tags (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES hud_sessions(id) ON DELETE CASCADE,
        transcript_id TEXT,
        label TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hud_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES hud_sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hud_transcript_session_time
        ON hud_transcript_entries (session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_hud_prompt_session_time
        ON hud_prompt_suggestions (session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_hud_tags_session_time
        ON hud_tags (session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_hud_events_session_time
        ON hud_events (session_id, timestamp);
    `);

    await this.pool.query(`
      ALTER TABLE hud_sessions ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
      ALTER TABLE hud_sessions ADD COLUMN IF NOT EXISTS facilitator TEXT NOT NULL DEFAULT '';
      ALTER TABLE hud_sessions ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT '';
      ALTER TABLE hud_sessions ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT '';
      ALTER TABLE hud_sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE hud_sessions ADD COLUMN IF NOT EXISTS created_by TEXT;

      CREATE INDEX IF NOT EXISTS idx_hud_sessions_created_by ON hud_sessions (created_by, created_at DESC);

      CREATE TABLE IF NOT EXISTS hud_notes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES hud_sessions(id) ON DELETE CASCADE,
        label TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hud_note_tags (
        note_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        PRIMARY KEY (note_id, tag_id)
      );

      CREATE INDEX IF NOT EXISTS idx_hud_notes_session ON hud_notes (session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_hud_note_tags_note ON hud_note_tags (note_id);
    `);
  }

  async ensureSession(sessionId: string, context: SessionContext = {}, createdBy?: string): Promise<HudSession> {
    const existing = await this.getSession(sessionId);
    const now = new Date().toISOString();

    if (existing) {
      const nextContext = { ...existing.context, ...context };
      const title = context.title !== undefined ? context.title : existing.title;
      const facilitator = context.facilitator !== undefined ? context.facilitator : existing.facilitator;
      const audience = context.audience !== undefined ? context.audience : existing.audience;
      const role = context.role !== undefined ? context.role : existing.role;
      await this.pool.query(
        "UPDATE hud_sessions SET context_json = $1, title = $2, facilitator = $3, audience = $4, role = $5, updated_at = $6 WHERE id = $7",
        [JSON.stringify(nextContext), title, facilitator, audience, role, now, sessionId],
      );
      return {
        ...existing,
        context: nextContext,
        title,
        facilitator,
        audience,
        role,
        updatedAt: now,
      };
    }

    await this.pool.query(
      "INSERT INTO hud_sessions (id, context_json, title, facilitator, audience, role, status, created_at, updated_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [sessionId, JSON.stringify(context), 'Untitled Session', '', '', '', 'active', now, now, createdBy ?? null],
    );
    return {
      id: sessionId,
      context,
      title: 'Untitled Session',
      facilitator: '',
      audience: '',
      role: '',
      status: 'active',
      ...(createdBy ? { createdBy } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  async setSessionOwnerIfUnset(sessionId: string, userId: string): Promise<string | null> {
    const now = new Date().toISOString();
    const { rows } = await this.pool.query<{ created_by: string }>(
      `UPDATE hud_sessions
       SET created_by = $2, updated_at = $3
       WHERE id = $1 AND (created_by IS NULL OR created_by = '')
       RETURNING created_by`,
      [sessionId, userId, now],
    );
    return rows[0]?.created_by ?? null;
  }

  async getSession(sessionId: string): Promise<HudSession | null> {
    const { rows } = await this.pool.query<{
      id: string; context_json: string; title: string; facilitator: string;
      audience: string; role: string; status: string; created_at: string; updated_at: string;
      created_by: string | null;
    }>(
      "SELECT id, context_json, title, facilitator, audience, role, status, created_at, updated_at, created_by FROM hud_sessions WHERE id = $1",
      [sessionId],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      context: parseJson<SessionContext>(r.context_json, {}),
      title: r.title,
      facilitator: r.facilitator,
      audience: r.audience,
      role: r.role,
      status: r.status as SessionStatus,
      ...(r.created_by ? { createdBy: r.created_by } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async saveTranscriptEntry(entry: TranscriptEntry): Promise<void> {
    await this.pool.query(
      "INSERT INTO hud_transcript_entries (id, session_id, text, timestamp, speaker_id) VALUES ($1, $2, $3, $4, $5)",
      [entry.id, entry.sessionId, entry.text, entry.timestamp, entry.speakerId],
    );
  }

  async hasTranscriptEntry(sessionId: string, transcriptId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ id: string }>(
      "SELECT id FROM hud_transcript_entries WHERE session_id = $1 AND id = $2",
      [sessionId, transcriptId],
    );
    return rows.length > 0;
  }

  async listRecentTranscriptEntries(sessionId: string, limit: number): Promise<TranscriptEntry[]> {
    const { rows } = await this.pool.query<{
      id: string; session_id: string; text: string; timestamp: string; speaker_id: string;
    }>(
      `SELECT id, session_id, text, timestamp, speaker_id
       FROM hud_transcript_entries WHERE session_id = $1
       ORDER BY timestamp DESC LIMIT $2`,
      [sessionId, limit],
    );
    return rows.reverse().map((r) => ({
      id: r.id, sessionId: r.session_id, text: r.text,
      timestamp: r.timestamp, speakerId: r.speaker_id,
    }));
  }

  async listTranscriptEntries(sessionId: string): Promise<TranscriptEntry[]> {
    const { rows } = await this.pool.query<{
      id: string; session_id: string; text: string; timestamp: string; speaker_id: string;
    }>(
      "SELECT id, session_id, text, timestamp, speaker_id FROM hud_transcript_entries WHERE session_id = $1 ORDER BY timestamp ASC",
      [sessionId],
    );
    return rows.map((r) => ({
      id: r.id, sessionId: r.session_id, text: r.text,
      timestamp: r.timestamp, speakerId: r.speaker_id,
    }));
  }

  async savePromptSuggestions(sessionId: string, prompts: PromptSuggestion[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM hud_prompt_suggestions WHERE session_id = $1", [sessionId]);
      for (const p of prompts) {
        await client.query(
          "INSERT INTO hud_prompt_suggestions (id, session_id, title, text, timestamp, transcript_ids_json) VALUES ($1, $2, $3, $4, $5, $6)",
          [p.id, sessionId, p.title, p.text, p.timestamp, JSON.stringify(p.transcriptIds)],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listPromptSuggestions(sessionId: string): Promise<PromptSuggestion[]> {
    const { rows } = await this.pool.query<{
      id: string; session_id: string; title: string; text: string;
      timestamp: string; transcript_ids_json: string;
    }>(
      "SELECT id, session_id, title, text, timestamp, transcript_ids_json FROM hud_prompt_suggestions WHERE session_id = $1 ORDER BY timestamp ASC",
      [sessionId],
    );
    return rows.map((r) => ({
      id: r.id, sessionId: r.session_id, title: r.title, text: r.text,
      timestamp: r.timestamp, transcriptIds: parseJson<string[]>(r.transcript_ids_json, []),
    }));
  }

  async saveTag(tag: SessionTag): Promise<void> {
    await this.pool.query(
      "INSERT INTO hud_tags (id, session_id, transcript_id, label, created_at, created_by, metadata_json) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        tag.id, tag.sessionId, tag.transcriptId ?? null, tag.label,
        tag.createdAt, tag.createdBy ?? null, JSON.stringify(tag.metadata ?? {}),
      ],
    );
  }

  async listTags(sessionId: string): Promise<SessionTag[]> {
    const { rows } = await this.pool.query<{
      id: string; session_id: string; transcript_id: string | null;
      label: string; created_at: string; created_by: string | null; metadata_json: string;
    }>(
      "SELECT id, session_id, transcript_id, label, created_at, created_by, metadata_json FROM hud_tags WHERE session_id = $1 ORDER BY created_at ASC",
      [sessionId],
    );
    return rows.map((r) => ({
      id: r.id, sessionId: r.session_id, transcriptId: r.transcript_id ?? undefined,
      label: r.label, createdAt: r.created_at, createdBy: r.created_by ?? undefined,
      metadata: parseJson<Record<string, string>>(r.metadata_json, {}),
    }));
  }

  async saveEvent(event: SessionEvent): Promise<void> {
    await this.pool.query(
      "INSERT INTO hud_events (id, session_id, type, timestamp, payload_json) VALUES ($1, $2, $3, $4, $5)",
      [event.id, event.sessionId, event.type, event.timestamp, JSON.stringify(event.payload)],
    );
  }

  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    const { rows } = await this.pool.query<{
      id: string; session_id: string; type: SessionEvent["type"];
      timestamp: string; payload_json: string;
    }>(
      "SELECT id, session_id, type, timestamp, payload_json FROM hud_events WHERE session_id = $1 ORDER BY timestamp ASC",
      [sessionId],
    );
    return rows.map((r) => ({
      id: r.id, sessionId: r.session_id, type: r.type,
      timestamp: r.timestamp, payload: parseJson<Record<string, unknown>>(r.payload_json, {}),
    }));
  }

  async listSignals(sessionId: string): Promise<SignalCue[]> {
    const events = await this.listEvents(sessionId);
    return events.map(mapSignal).filter((s): s is SignalCue => s !== null);
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    const [transcriptEntries, tags, notes, prompts, events] = await Promise.all([
      this.listTranscriptEntries(sessionId),
      this.listTags(sessionId),
      this.listNotes(sessionId),
      this.listPromptSuggestions(sessionId),
      this.listEvents(sessionId),
    ]);
    const signals = events.map(mapSignal).filter((s): s is SignalCue => s !== null);

    return { session, transcriptEntries, tags, notes, prompts, events, signals };
  }

  async createSession(input: { id: string; title: string; facilitator: string; audience: string; role: string; createdBy: string }): Promise<HudSession> {
    const now = new Date().toISOString();
    await this.pool.query(
      "INSERT INTO hud_sessions (id, context_json, title, facilitator, audience, role, status, created_at, updated_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [input.id, JSON.stringify({}), input.title, input.facilitator, input.audience, input.role, 'active', now, now, input.createdBy],
    );
    return {
      id: input.id,
      context: {},
      title: input.title,
      facilitator: input.facilitator,
      audience: input.audience,
      role: input.role,
      status: 'active',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
  }

  async listSessions(createdBy: string): Promise<HudSession[]> {
    const { rows } = await this.pool.query<{
      id: string; context_json: string; title: string; facilitator: string;
      audience: string; role: string; status: string; created_at: string; updated_at: string;
      note_count: number;
      created_by: string | null;
    }>(
      `SELECT s.id, s.context_json, s.title, s.facilitator, s.audience, s.role, s.status, s.created_at, s.updated_at, s.created_by,
              (SELECT COUNT(*)::int FROM hud_notes n WHERE n.session_id = s.id) AS note_count
       FROM hud_sessions s
       WHERE s.created_by = $1
       ORDER BY s.updated_at DESC, s.created_at DESC`,
      [createdBy],
    );
    return rows.map((r) => ({
      id: r.id,
      context: parseJson<SessionContext>(r.context_json, {}),
      title: r.title,
      facilitator: r.facilitator,
      audience: r.audience,
      role: r.role,
      status: r.status as SessionStatus,
      ...(r.created_by ? { createdBy: r.created_by } : {}),
      noteCount: r.note_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM hud_sessions WHERE id = $1", [sessionId]);
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      "UPDATE hud_sessions SET status = $1, updated_at = $2 WHERE id = $3",
      [status, now, sessionId],
    );
  }

  async createNote(note: { id: string; sessionId: string; label: string; body: string }): Promise<SessionNote> {
    const now = new Date().toISOString();
    await this.pool.query(
      "INSERT INTO hud_notes (id, session_id, label, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [note.id, note.sessionId, note.label, note.body, now, now],
    );
    return {
      id: note.id,
      sessionId: note.sessionId,
      label: note.label,
      body: note.body,
      linkedTagIds: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async listNotes(sessionId: string): Promise<SessionNote[]> {
    const { rows } = await this.pool.query<{
      id: string; session_id: string; label: string; body: string;
      created_at: string; updated_at: string; linked_tag_ids: string[];
    }>(
      `SELECT n.id, n.session_id, n.label, n.body, n.created_at, n.updated_at,
              COALESCE(array_agg(nt.tag_id) FILTER (WHERE nt.tag_id IS NOT NULL), '{}') AS linked_tag_ids
       FROM hud_notes n
       LEFT JOIN hud_note_tags nt ON n.id = nt.note_id
       WHERE n.session_id = $1
       GROUP BY n.id
       ORDER BY n.created_at ASC`,
      [sessionId],
    );
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      label: r.label,
      body: r.body,
      linkedTagIds: r.linked_tag_ids,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async updateNote(sessionId: string, noteId: string, body: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      "UPDATE hud_notes SET body = $1, updated_at = $2 WHERE id = $3 AND session_id = $4",
      [body, now, noteId, sessionId],
    );
  }

  async deleteNote(sessionId: string, noteId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM hud_notes WHERE id = $1 AND session_id = $2",
      [noteId, sessionId],
    );
  }

  async addTagToNote(noteId: string, tagId: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO hud_note_tags (note_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [noteId, tagId],
    );
  }

  async removeTagFromNote(noteId: string, tagId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM hud_note_tags WHERE note_id = $1 AND tag_id = $2",
      [noteId, tagId],
    );
  }
}
