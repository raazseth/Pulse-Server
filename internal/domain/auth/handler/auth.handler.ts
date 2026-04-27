import { NextFunction, Request, Response } from "express";
import { AppError } from "@/internal/pkg/AppError";
import { ok, created } from "@/internal/pkg/ApiResponse";
import SC from "@/internal/pkg/response";
import { AuthService } from "@/internal/domain/auth/service/auth.service";

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export class AuthHandler {
  constructor(private readonly authService: AuthService) {}

  // S-09: Removed duplicate validation — Zod middleware already enforces these
  register = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, name } = req.body as {
        email: string;
        password: string;
        name: string;
      };

      const result = await this.authService.register(email, password, name);

      // S-14: refreshToken lives in httpOnly cookie, not response body
      res.cookie("refreshToken", result.tokens.refreshToken, COOKIE_OPTS);
      res.status(SC.CREATED).json(
        created(
          { user: result.user, tokens: { accessToken: result.tokens.accessToken } },
          "Account created",
        ),
      );
    } catch (err) {
      if (err instanceof AppError) return next(err);
      const msg = (err as Error).message ?? "";
      const status = msg === "Email already registered" ? SC.CONFLICT : SC.BAD_REQUEST;
      next(new AppError(msg, 0, status));
    }
  };

  login = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body as { email: string; password: string };

      const result = await this.authService.login(email, password);

      // S-14: refreshToken lives in httpOnly cookie, not response body
      res.cookie("refreshToken", result.tokens.refreshToken, COOKIE_OPTS);
      res.status(SC.OK).json(
        ok(
          { user: result.user, tokens: { accessToken: result.tokens.accessToken } },
          "Logged in",
        ),
      );
    } catch (err) {
      next(new AppError("Invalid email or password", 0, SC.UNAUTHORIZED));
    }
  };

  // S-14: Read refresh token from httpOnly cookie, set rotated cookie in response
  refresh = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const refreshToken = (req.cookies as Record<string, string>)?.refreshToken;
      if (!refreshToken) {
        throw new AppError("No refresh token", 0, SC.UNAUTHORIZED);
      }

      const result = await this.authService.refreshAccessToken(refreshToken);

      res.cookie("refreshToken", result.refreshToken, COOKIE_OPTS);
      res.status(SC.OK).json(
        ok({ accessToken: result.accessToken, user: result.user }, "Token refreshed"),
      );
    } catch (err) {
      if (err instanceof AppError) return next(err);
      next(new AppError("Invalid or expired refresh token", 0, SC.UNAUTHORIZED));
    }
  };

  // S-14: Revoke cookie-based refresh token and clear the cookie
  logout = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const refreshToken = (req.cookies as Record<string, string>)?.refreshToken;
      if (refreshToken) {
        await this.authService.revokeRefreshToken(refreshToken);
      }
      res.clearCookie("refreshToken", { httpOnly: true, sameSite: "strict" });
      res.status(SC.OK).json(ok(null, "Logged out"));
    } catch (err) {
      next(new AppError("Logout failed", 0, SC.INTERNAL_SERVER_ERROR));
    }
  };

  // S-08: Fetch full user profile from DB instead of returning the JWT stub
  me = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await this.authService.getUserById(req.user!.userId);
      if (!user) return next(new AppError("User not found", 0, SC.NOT_FOUND));
      res.status(SC.OK).json(ok(user, "Authenticated user"));
    } catch (err) {
      next(err);
    }
  };
}
