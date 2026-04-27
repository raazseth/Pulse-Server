import { Pool } from "pg";
import { AuthUser } from "@/internal/domain/auth/model/auth.model";
import { AuthRepository } from "./auth.repository";

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id            TEXT PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_auth_tokens_user
        ON auth_refresh_tokens (user_id);
    `);
  }

  async findUserByEmail(email: string): Promise<(AuthUser & { passwordHash: string }) | null> {
    const { rows } = await this.pool.query<{
      id: string; email: string; name: string; password_hash: string; created_at: string;
    }>(
      "SELECT id, email, name, password_hash, created_at FROM auth_users WHERE email = $1",
      [email],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, email: r.email, name: r.name, passwordHash: r.password_hash, createdAt: r.created_at };
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const { rows } = await this.pool.query<{
      id: string; email: string; name: string; created_at: string;
    }>(
      "SELECT id, email, name, created_at FROM auth_users WHERE id = $1",
      [id],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, email: r.email, name: r.name, createdAt: r.created_at };
  }

  async createUser(user: AuthUser & { passwordHash: string }): Promise<AuthUser> {
    await this.pool.query(
      "INSERT INTO auth_users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)",
      [user.id, user.email, user.name, user.passwordHash, user.createdAt],
    );
    return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
  }

  async saveRefreshToken(tokenId: string, userId: string, expiresAt: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO auth_refresh_tokens (id, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)",
      [tokenId, userId, expiresAt, new Date().toISOString()],
    );
  }

  async getRefreshToken(tokenId: string): Promise<{ userId: string; expiresAt: string } | null> {
    const { rows } = await this.pool.query<{ user_id: string; expires_at: string }>(
      "SELECT user_id, expires_at FROM auth_refresh_tokens WHERE id = $1",
      [tokenId],
    );
    if (!rows[0]) return null;
    return { userId: rows[0].user_id, expiresAt: rows[0].expires_at };
  }

  async deleteRefreshToken(tokenId: string): Promise<void> {
    await this.pool.query("DELETE FROM auth_refresh_tokens WHERE id = $1", [tokenId]);
  }

  async deleteExpiredRefreshTokens(): Promise<void> {
    await this.pool.query(
      "DELETE FROM auth_refresh_tokens WHERE expires_at < $1",
      [new Date().toISOString()],
    );
  }
}
