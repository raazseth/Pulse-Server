import { NextFunction, Request, Response } from "express";
import { AppError } from "@/internal/pkg/AppError";
import SC from "@/internal/pkg/response";
import { AuthService } from "@/internal/domain/auth/service/auth.service";

export function createAuthenticate(authService: AuthService) {
  return function authenticate(req: Request, _res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return next(new AppError("Authentication required", 0, SC.UNAUTHORIZED));
    }

    try {
      const payload = authService.verifyAccessToken(header.slice(7));
      req.user = { userId: payload.userId, email: payload.email };
      next();
    } catch {
      next(new AppError("Invalid or expired access token", 0, SC.UNAUTHORIZED));
    }
  };
}
