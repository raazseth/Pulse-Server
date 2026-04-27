import dotenv from "dotenv";

const NODE_ENV = process.env.NODE_ENV || "development";
dotenv.config({ path: `.env.${NODE_ENV}` });
dotenv.config();

const isProduction = NODE_ENV === "production";

function requireInProduction(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value) {
    if (isProduction) throw new Error(`Missing required environment variable: ${name}`);
    console.warn(`[config] ${name} is not set — using insecure dev default. Set a real value before deploying.`);
    return fallback;
  }
  return value;
}

const SERVER_PORT = process.env.PORT || 3000;
const HUD_WS_PATH = process.env.HUD_WS_PATH || "/ws/transcript";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AI_PROVIDER = process.env.AI_PROVIDER;
const DATABASE_URL = process.env.DATABASE_URL;

const JWT_SECRET = requireInProduction("JWT_SECRET", "dev-jwt-secret-change-in-production");
const JWT_REFRESH_SECRET = requireInProduction("JWT_REFRESH_SECRET", "dev-refresh-secret-change-in-production");

export const config = {
  server: {
    port: SERVER_PORT,
  },
  hud: {
    wsPath: HUD_WS_PATH,
    openaiApiKey: OPENAI_API_KEY,
    geminiApiKey: GEMINI_API_KEY,
    aiProvider: AI_PROVIDER,
    databaseUrl: DATABASE_URL,
  },
  auth: {
    jwtSecret: JWT_SECRET,
    jwtRefreshSecret: JWT_REFRESH_SECRET,
  },
  cors: {
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
      : ["http://localhost:5173", "http://localhost:3000"],
  },
};
