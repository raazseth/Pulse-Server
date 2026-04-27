import { AuthUser } from "@/internal/domain/auth/model/auth.model";

export interface AuthRepository {
  initialize(): Promise<void>;
  findUserByEmail(email: string): Promise<(AuthUser & { passwordHash: string }) | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  createUser(user: AuthUser & { passwordHash: string }): Promise<AuthUser>;
  saveRefreshToken(tokenId: string, userId: string, expiresAt: string): Promise<void>;
  getRefreshToken(tokenId: string): Promise<{ userId: string; expiresAt: string } | null>;
  deleteRefreshToken(tokenId: string): Promise<void>;
  deleteExpiredRefreshTokens(): Promise<void>;
}
