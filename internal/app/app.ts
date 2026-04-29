import { config } from "@/internal/config/config";
import { createRouter } from "@/internal/delivery/http/router";
import { PostgresAuthRepository } from "@/internal/domain/auth/repository/auth.repository.pg";
import { AuthService } from "@/internal/domain/auth/service/auth.service";
import { PostgresSessionRepository } from "@/internal/domain/hud/repository/session.repository.pg";
import { GeminiProvider, OpenAIProvider, RuleBasedAIProvider } from "@/internal/domain/hud/service/ai.provider";
import type { AIProvider } from "@/internal/domain/hud/service/ai.provider";
import { HudSessionService } from "@/internal/domain/hud/service/session.service";
import { DefaultTranscriptProvider } from "@/internal/domain/hud/service/transcript.provider";
import { PostgresInfra } from "@/internal/infrastructure/postgres_client";
import { logger, setLogRepository } from "@/internal/pkg/logger";
import { LogRepository } from "@/internal/pkg/log-repository";

function resolveAIProvider(): AIProvider {
  const explicit = config.hud.aiProvider?.trim().toLowerCase();
  const openaiOpts = {
    model: config.hud.openaiModel,
    timeoutMs: config.hud.openaiTimeoutMs,
  };

  const openaiKey = config.hud.openaiApiKey?.trim();
  const geminiKey = config.hud.geminiApiKey?.trim();

  if (explicit === "openai" && !openaiKey) {
    throw new Error("AI_PROVIDER=openai requires OPENAI_API_KEY");
  }

  // OpenAI whenever the key is set — must run before any AI_PROVIDER=gemini check (.env.local often sets gemini).
  if (openaiKey) {
    if (explicit === "gemini") {
      logger.warn(
        "HUD AI ▸ OPENAI_API_KEY is set — using OpenAI (AI_PROVIDER=gemini ignored). Remove OPENAI_API_KEY to use Gemini.",
      );
    }
    return new OpenAIProvider(openaiKey, openaiOpts);
  }

  if (explicit === "gemini" && !geminiKey) {
    throw new Error("AI_PROVIDER=gemini requires GEMINI_API_KEY (or set OPENAI_API_KEY for OpenAI)");
  }

  if (geminiKey) {
    return new GeminiProvider(geminiKey, { modelId: config.hud.geminiModel });
  }

  return new RuleBasedAIProvider();
}

export async function createApp(options?: { databaseUrl?: string; skipRateLimiting?: boolean }) {
  const databaseUrl = options?.databaseUrl ?? config.hud.databaseUrl;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Set it in your environment or .env file.");
  }

  logger.info("DB     ▸ connecting...");
  const pg = new PostgresInfra(databaseUrl);
  await pg.ping();
  logger.info("DB     ▸ ready");

  const logRepo = new LogRepository(pg.pool);
  await logRepo.initialize();
  setLogRepository(logRepo);

  const LOG_CLEANUP_MS = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    const deleted = await logRepo.deleteExpired().catch(() => 0);
    if (deleted > 0) logger.info(`Logs   ▸ pruned ${deleted} expired rows`);
  }, LOG_CLEANUP_MS).unref();

  const sessionRepository = new PostgresSessionRepository(pg.pool);
  await sessionRepository.initialize();

  const authRepo = new PostgresAuthRepository(pg.pool);
  await authRepo.initialize();
  const authService = new AuthService(authRepo);

  const aiProvider = resolveAIProvider();
  const explicitProvider = config.hud.aiProvider?.trim() || "";
  const hasOpenaiKey = Boolean(config.hud.openaiApiKey?.trim());
  const hasGeminiKey = Boolean(config.hud.geminiApiKey?.trim());

  let aiLine: string;
  if (aiProvider instanceof OpenAIProvider) {
    const why =
      explicitProvider.toLowerCase() === "openai"
        ? "AI_PROVIDER=openai"
        : "OPENAI_API_KEY set (primary)";
    aiLine = `OpenAI · model ${config.hud.openaiModel} · ${why}`;
  } else if (aiProvider instanceof GeminiProvider) {
    const why = !hasOpenaiKey && hasGeminiKey ? "no OPENAI_API_KEY, using GEMINI_API_KEY" : "fallback";
    aiLine = `Gemini · model ${config.hud.geminiModel} · ${why}`;
  } else {
    aiLine = "rule-based patterns (no OPENAI_API_KEY or GEMINI_API_KEY)";
  }

  logger.info(
    `Pulse HUD ready — storage: postgres | auth: postgres | suggestions: ${aiLine}`,
  );

  const hudService = new HudSessionService(
    sessionRepository,
    new DefaultTranscriptProvider(),
    aiProvider,
  );

  const router = createRouter(hudService, authService, { skipRateLimiting: options?.skipRateLimiting });

  return { router, hudService, authService, pg };
}
