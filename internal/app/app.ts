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
  const explicit = config.hud.aiProvider?.toLowerCase();

  if (explicit === "gemini") {
    if (!config.hud.geminiApiKey) throw new Error("AI_PROVIDER=gemini requires GEMINI_API_KEY");
    return new GeminiProvider(config.hud.geminiApiKey);
  }

  if (explicit === "openai") {
    if (!config.hud.openaiApiKey) throw new Error("AI_PROVIDER=openai requires OPENAI_API_KEY");
    return new OpenAIProvider(config.hud.openaiApiKey);
  }

  if (config.hud.openaiApiKey) return new OpenAIProvider(config.hud.openaiApiKey);
  if (config.hud.geminiApiKey) return new GeminiProvider(config.hud.geminiApiKey);
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
  const aiLabel = aiProvider instanceof GeminiProvider ? "Gemini (gemini-2.0-flash)"
    : aiProvider instanceof OpenAIProvider ? "OpenAI (gpt-4o-mini)"
    : "rule-based";

  const hudService = new HudSessionService(
    sessionRepository,
    new DefaultTranscriptProvider(),
    aiProvider,
  );

  const router = createRouter(hudService, authService, { skipRateLimiting: options?.skipRateLimiting });

  logger.info(`Pulse HUD ready — storage: postgres | auth: postgres | ai: ${aiLabel}`);

  return { router, hudService, authService, pg };
}
