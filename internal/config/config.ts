import dotenv from "dotenv";

const NODE_ENV = process.env.NODE_ENV || "development";
// Load order: .env.local (highest priority, never committed) → .env.<NODE_ENV> → .env
dotenv.config({ path: ".env.local" });
dotenv.config({ path: `.env.${NODE_ENV}` });
dotenv.config();

const isProduction = NODE_ENV === "production";
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const PULSE_WEB_VERCEL_ORIGINS = [
  "https://pulse-web-sigma.vercel.app",
  "https://pulse-web-git-main-rajs-projects-ab8ef4bc.vercel.app",
  "https://pulse-8tgnnw7wz-rajs-projects-ab8ef4bc.vercel.app",
];

const CORS_VERCEL_TEAM_SUFFIX = process.env.CORS_VERCEL_TEAM_SUFFIX?.trim() || undefined;

function requireInProduction(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value) {
    if (isProduction) {
      console.warn(`[config] ${name} is not set in production — using fallback value. Set a secure secret.`);
    } else {
      console.warn(`[config] ${name} is not set — using insecure dev default. Set a real value before deploying.`);
    }
    return fallback;
  }
  return value;
}

function resolvePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    if (value !== undefined && value !== "") {
      console.warn(`[config] Invalid PORT "${value}" — falling back to ${fallback}.`);
    }
    return fallback;
  }
  return parsed;
}

const SERVER_PORT = resolvePort(process.env.PORT, 8080);
const SERVER_HOST = process.env.HOST?.trim() || "0.0.0.0";
const HUD_WS_PATH = process.env.HUD_WS_PATH || "/ws/transcript";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS_RAW = process.env.OPENAI_TIMEOUT_MS;
const OPENAI_TIMEOUT_MS = (() => {
  const n = Number(OPENAI_TIMEOUT_MS_RAW);
  if (!Number.isFinite(n) || n < 3000 || n > 60_000) return 7000;
  return Math.floor(n);
})();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
const AI_PROVIDER = process.env.AI_PROVIDER;
const DATABASE_URL = process.env.DATABASE_URL;
const WHISPER_MODEL = process.env.WHISPER_MODEL?.trim() || "base.en";
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE?.trim() || "en";
const WHISPER_MODELS_DIR = process.env.WHISPER_MODELS_DIR?.trim() || "./models";

const JWT_SECRET = requireInProduction("JWT_SECRET", "dev-jwt-secret-change-in-production");
const JWT_REFRESH_SECRET = requireInProduction("JWT_REFRESH_SECRET", "dev-refresh-secret-change-in-production");

function resolveAllowedOrigins(): string[] {
  const fromEnv = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : [];
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...PULSE_WEB_VERCEL_ORIGINS, ...fromEnv])];
}

export const config = {
  server: {
    host: SERVER_HOST,
    port: SERVER_PORT,
  },
  hud: {
    wsPath: HUD_WS_PATH,
    openaiApiKey: OPENAI_API_KEY,
    openaiModel: OPENAI_MODEL,
    openaiTimeoutMs: OPENAI_TIMEOUT_MS,
    geminiApiKey: GEMINI_API_KEY,
    geminiModel: GEMINI_MODEL,
    aiProvider: AI_PROVIDER,
    databaseUrl: DATABASE_URL,
  },
  whisper: {
    model: WHISPER_MODEL,
    language: WHISPER_LANGUAGE,
    modelsDir: WHISPER_MODELS_DIR,
  },
  auth: {
    jwtSecret: JWT_SECRET,
    jwtRefreshSecret: JWT_REFRESH_SECRET,
  },
  cors: {
    allowedOrigins: resolveAllowedOrigins(),
    vercelTeamSuffix: CORS_VERCEL_TEAM_SUFFIX,
  },
};
