import crypto from "crypto";
import { promisify } from "util";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "@/internal/config/config";
import {
  AccessTokenPayload,
  AuthUser,
  RefreshTokenPayload,
  TokenPair,
} from "@/internal/domain/auth/model/auth.model";
import { AuthRepository } from "@/internal/domain/auth/repository/auth.repository";

const scryptAsync = promisify(crypto.scrypt);
const ACCESS_TTL = "15m";
const REFRESH_TTL = "7d";
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const AccessTokenPayloadSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
});

const RefreshTokenPayloadSchema = z.object({
  userId: z.string().uuid(),
  tokenId: z.string().uuid(),
});

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashed] = stored.split(":");
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return crypto.timingSafeEqual(Buffer.from(hashed, "hex"), hash);
}

export class AuthService {
  constructor(private readonly authRepo: AuthRepository) {}

  async register(email: string, password: string, name: string): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const existing = await this.authRepo.findUserByEmail(email.toLowerCase().trim());
    if (existing) throw new Error("Email already registered");

    const passwordHash = await hashPassword(password);
    const user = await this.authRepo.createUser({
      id: crypto.randomUUID(),
      email: email.toLowerCase().trim(),
      name: name.trim(),
      passwordHash,
      createdAt: new Date().toISOString(),
    });

    return { user, tokens: await this.issueTokenPair(user) };
  }

  async login(email: string, password: string): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const record = await this.authRepo.findUserByEmail(email.toLowerCase().trim());
    if (!record) throw new Error("Invalid email or password");

    const valid = await verifyPassword(password, record.passwordHash);
    if (!valid) throw new Error("Invalid email or password");

    const user: AuthUser = { id: record.id, email: record.email, name: record.name, createdAt: record.createdAt };
    return { user, tokens: await this.issueTokenPair(user) };
  }

  async refreshAccessToken(oldRefreshToken: string): Promise<{ accessToken: string; refreshToken: string; user: AuthUser }> {
    let payload: RefreshTokenPayload;
    try {
      payload = RefreshTokenPayloadSchema.parse(
        jwt.verify(oldRefreshToken, config.auth.jwtRefreshSecret),
      );
    } catch {
      throw new Error("Invalid or expired refresh token");
    }

    const record = await this.authRepo.getRefreshToken(payload.tokenId);
    if (!record || new Date(record.expiresAt) < new Date()) {
      throw new Error("Refresh token revoked or expired");
    }

    const user = await this.authRepo.findUserById(payload.userId);
    if (!user) throw new Error("User not found");

    await this.authRepo.deleteRefreshToken(payload.tokenId);

    const accessToken = jwt.sign(
      { userId: user.id, email: user.email } satisfies AccessTokenPayload,
      config.auth.jwtSecret,
      { expiresIn: ACCESS_TTL },
    );

    const newTokenId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
    const refreshToken = jwt.sign(
      { userId: user.id, tokenId: newTokenId } satisfies RefreshTokenPayload,
      config.auth.jwtRefreshSecret,
      { expiresIn: REFRESH_TTL },
    );
    await this.authRepo.saveRefreshToken(newTokenId, user.id, expiresAt);

    return { accessToken, refreshToken, user };
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    try {
      const payload = RefreshTokenPayloadSchema.parse(
        jwt.verify(refreshToken, config.auth.jwtRefreshSecret),
      );
      await this.authRepo.deleteRefreshToken(payload.tokenId);
    } catch {
    }
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    const raw = jwt.verify(token, config.auth.jwtSecret);
    return AccessTokenPayloadSchema.parse(raw);
  }

  async getUserById(userId: string): Promise<AuthUser | null> {
    return this.authRepo.findUserById(userId);
  }

  private async issueTokenPair(user: AuthUser): Promise<TokenPair> {
    const tokenId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();

    const accessToken = jwt.sign(
      { userId: user.id, email: user.email } satisfies AccessTokenPayload,
      config.auth.jwtSecret,
      { expiresIn: ACCESS_TTL },
    );

    const refreshToken = jwt.sign(
      { userId: user.id, tokenId } satisfies RefreshTokenPayload,
      config.auth.jwtRefreshSecret,
      { expiresIn: REFRESH_TTL },
    );

    await this.authRepo.saveRefreshToken(tokenId, user.id, expiresAt);
    await this.authRepo.deleteExpiredRefreshTokens();

    return { accessToken, refreshToken };
  }
}
