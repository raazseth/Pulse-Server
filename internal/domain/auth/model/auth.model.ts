export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface TokenPair {
  accessToken: string;   // JWT, 15 min
  refreshToken: string;  // JWT, 7 days, stored in DB for revocation
}

export interface AccessTokenPayload {
  userId: string;
  email: string;
}

export interface RefreshTokenPayload {
  userId: string;
  tokenId: string;
}
