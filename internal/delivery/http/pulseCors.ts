import cors from "cors";
import { config } from "@/internal/config/config";

const exactOrigins = new Set(config.cors.allowedOrigins);
const vercelSuffix = config.cors.vercelTeamSuffix;

const LOCAL_LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

export function isPulseCorsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  if (LOCAL_LOOPBACK_ORIGIN.test(origin)) {
    return true;
  }
  if (exactOrigins.has(origin)) {
    return true;
  }
  if (!vercelSuffix) {
    return false;
  }
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== "https:") {
      return false;
    }
    return hostname.endsWith(`-${vercelSuffix}.vercel.app`);
  } catch {
    return false;
  }
}

export const pulseCors = cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (isPulseCorsOriginAllowed(origin)) {
      callback(null, true);
      return;
    }
    callback(null, []);
  },
  credentials: true,
  optionsSuccessStatus: 204,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie", "X-Requested-With"],
  maxAge: 86_400,
});
