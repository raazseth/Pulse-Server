import express, {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";
import http from "http";
import { createApp } from "@/internal/app/app";
import { config } from "@/internal/config/config";
import { initHudSocket } from "@/internal/domain/hud/socket/hud.socket";
import { AppError } from "@/internal/pkg/AppError";
import { logger } from "@/internal/pkg/logger";
import SC from "@/internal/pkg/response";

const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const isAppError = err instanceof AppError;
  const status =
    isAppError && Number.isInteger(err.status)
      ? err.status
      : SC.INTERNAL_SERVER_ERROR;

  if (!isAppError) {
    logger.error("Unhandled server error", err);
  }

  res.status(status).json({
    type:
      isAppError && typeof err.type === "number"
        ? err.type
        : SC.INTERNAL_SERVER_ERROR,
    success: false,
    message: isAppError ? err.message : "An unexpected error occurred.",
    data: null,
  });
};

async function main() {
  const app = express();
  app.use(express.json());

  // S-01: authService passed to initHudSocket for WS token verification
  const { router, hudService, authService, pg } = await createApp();
  app.use("/api/v1", router);
  app.use(errorHandler);

  const server = http.createServer(app);
  initHudSocket(server, hudService, authService);

  server.listen(config.server.port, () => {
    logger.info(`Server ▸ http://localhost:${config.server.port}`);
    logger.info(`Server ▸ NODE_ENV=${process.env.NODE_ENV ?? "development"}`);
  });

  const shutdown = async () => {
    logger.info("Server ▸ shutting down...");
    server.close(() => logger.info("Server ▸ HTTP server closed"));
    await pg.close();
    process.exit(0);
  };

  const onSignal = () => {
    shutdown().catch((err) => {
      logger.error("Shutdown error", err);
      process.exit(1);
    });
  };

  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}

main().catch((err) => {
  logger.error("Failed to start server", err);
  process.exit(1);
});
