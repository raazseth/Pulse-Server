import { NextFunction, Request, Response, Router, RequestHandler } from "express";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { ok } from "@/internal/pkg/ApiResponse";
import { AuthHandler } from "@/internal/domain/auth/handler/auth.handler";
import { AuthRoutes } from "@/internal/domain/auth/router/auth.routes";
import { AuthService } from "@/internal/domain/auth/service/auth.service";
import { AudioHandler } from "@/internal/domain/hud/handler/audio.handler";
import { HudHandler } from "@/internal/domain/hud/handler/hud.handler";
import { HudRoutes } from "@/internal/domain/hud/router/hud.routes";
import { HudSessionService } from "@/internal/domain/hud/service/session.service";
import { createAuthenticate } from "@/internal/middleware/authenticate";
import { config } from "@/internal/config/config";

function createRateLimiter(windowMs: number, max: number, maxKeys = 5_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const evictExpired = () => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  };

  setInterval(evictExpired, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = (req.ip ?? req.socket.remoteAddress) || "unknown";
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      if (!entry && hits.size >= maxKeys) {
        evictExpired();
        if (hits.size >= maxKeys) {
          res.status(429).json({ success: false, message: "Too many requests, slow down." });
          return;
        }
      }
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count++;
    if (entry.count > max) {
      res.status(429).json({ success: false, message: "Too many requests, slow down." });
      return;
    }
    next();
  };
}

export function createRouter(
  hudService: HudSessionService,
  authService: AuthService,
  options?: { skipRateLimiting?: boolean },
) {
  const passThrough: RequestHandler = (_req, _res, next) => next();
  const skip = options?.skipRateLimiting ?? false;
  const transcriptLimiter = skip ? passThrough : createRateLimiter(60_000, 120);
  const authLimiter = skip ? passThrough : createRateLimiter(15 * 60_000, 20);
  const router = Router();

  router.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: "deny" },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  }));
  router.use(express.json({ limit: "1mb" }));
  router.use(express.urlencoded({ extended: true, limit: "1mb" }));
  router.use(cookieParser());

  router.get("/health", (_req, res) => {
    const memory = process.memoryUsage();
    res.status(200).json(
      ok(
        {
          status: "up",
          service: "pulse-hud-backend",
          version: "1.0.0",
          environment: process.env.NODE_ENV || "development",
          timestamp: new Date().toISOString(),
          uptimeSeconds: process.uptime(),
          pid: process.pid,
          memory: { rss: memory.rss, heapTotal: memory.heapTotal, heapUsed: memory.heapUsed },
        },
        "OK",
      ),
    );
  });

  const authenticate = createAuthenticate(authService);

  router.use("/auth", authLimiter, AuthRoutes(new AuthHandler(authService), authService));

  router.use("/hud/sessions/:sessionId/transcript", transcriptLimiter);
  router.use("/hud", HudRoutes(new HudHandler(hudService), authenticate as RequestHandler));

  const audioHandler = new AudioHandler(config.hud.openaiApiKey, config.hud.geminiApiKey, config.hud.aiProvider);
  router.post(
    "/hud/audio/transcribe",
    authenticate as RequestHandler,
    express.raw({ type: (req) => Boolean(req.headers["content-type"]?.startsWith("audio/")), limit: "25mb" }),
    audioHandler.transcribe,
  );

  return router;
}
