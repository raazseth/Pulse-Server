import { Pool } from "pg";

export type LogLevel = "INFO" | "WARNING" | "ERROR";

const DEFAULT_RETENTION_HOURS = 6;

export class LogRepository {
  private readonly retentionHours: number;

  constructor(
    private readonly pool: Pool,
    retentionHours = DEFAULT_RETENTION_HOURS,
  ) {
    this.retentionHours = retentionHours;
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_logs (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        level       VARCHAR(10) NOT NULL,
        message     TEXT        NOT NULL,
        stack       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at  TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS app_logs_expires_at  ON app_logs (expires_at);
      CREATE INDEX IF NOT EXISTS app_logs_created_at  ON app_logs (created_at DESC);
      CREATE INDEX IF NOT EXISTS app_logs_level       ON app_logs (level);
    `);
  }

  insert(level: LogLevel, message: string, stack?: string): void {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.retentionHours);
    this.pool
      .query(
        `INSERT INTO app_logs (level, message, stack, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [level, message, stack ?? null, expiresAt.toISOString()],
      )
      .catch(() => {
        // Never throw from a log write — swallow DB errors silently.
      });
  }

  async deleteExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM app_logs WHERE expires_at <= NOW()`,
    );
    return result.rowCount ?? 0;
  }
}
