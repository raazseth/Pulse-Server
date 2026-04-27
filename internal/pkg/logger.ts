import type { LogRepository, LogLevel } from "@/internal/pkg/log-repository";

const isProduction = process.env.NODE_ENV === "production";

let repo: LogRepository | null = null;

/** Call once the DB pool is ready. All subsequent log calls will also persist to app_logs. */
export function setLogRepository(r: LogRepository): void {
  repo = r;
}

function log(severity: LogLevel, msg: string, err?: unknown) {
  const message = err
    ? `${msg}: ${err instanceof Error ? err.message : String(err)}`
    : msg;
  const stack = err instanceof Error ? err.stack : undefined;

  if (isProduction) {
    process.stdout.write(
      JSON.stringify({
        severity,
        message,
        timestamp: new Date().toISOString(),
        ...(stack ? { stack } : {}),
      }) + "\n",
    );
  } else {
    const fn =
      severity === "ERROR"
        ? console.error
        : severity === "WARNING"
          ? console.warn
          : console.log;
    fn(`${new Date().toISOString()} ${severity.padEnd(7)} ${message}`);
  }

  if (severity === "ERROR") repo?.insert(severity, message, stack);
}

export const logger = {
  info:  (msg: string)                => log("INFO",    msg),
  warn:  (msg: string)                => log("WARNING", msg),
  error: (msg: string, err?: unknown) => log("ERROR",   msg, err),
};
