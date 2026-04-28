import express, {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";
import http from "http";
import { createApp } from "@/internal/app/app";
import { config } from "@/internal/config/config";
import { pulseCors } from "@/internal/delivery/http/pulseCors";
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
  let ready = false;
  let startupError = "Booting";
  let closeStorage: (() => Promise<void>) | null = null;

  const server = http.createServer(app);

  server.on("error", (err) => {
    logger.error("Server ▸ startup error", err);
  });

  app.get("/api/v1/health", (_req, res) => {
    if (ready) {
      res.status(200).json({
        success: true,
        data: {
          status: "up",
          service: "pulse-hud",
          env: process.env.NODE_ENV ?? "development",
        },
      });
      return;
    }
    res.status(503).json({
      success: false,
      data: {
        status: "starting",
        service: "pulse-hud",
        message: startupError,
      },
    });
  });

  app.use("/api/v1", pulseCors);

  app.use((req, res, next) => {
    if (ready || req.path === "/api/v1/health") {
      next();
      return;
    }
    res.status(503).json({
      type: SC.SERVICE_UNAVAILABLE,
      success: false,
      message: "Service is starting. Try again shortly.",
      data: null,
    });
  });

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const initRuntime = async () => {
    while (!ready) {
      try {
        const { router, hudService, authService, pg } = await createApp();
        closeStorage = () => pg.close();
        app.use("/api/v1", router);
        app.use(errorHandler);
        initHudSocket(server, hudService, authService);
        ready = true;
        startupError = "";
        logger.info("Runtime ▸ dependencies initialized");
      } catch (err) {
        startupError = err instanceof Error ? err.message : String(err);
        logger.error("Runtime ▸ initialization failed, retrying in 5s", err);
        await wait(5000);
      }
    }
  };

  server.listen(config.server.port, config.server.host, () => {
    logger.info("App    ▸ pulse-hud");
    logger.info(`Server ▸ host=${config.server.host} port=${config.server.port}`);
    logger.info(`Server ▸ NODE_ENV=${process.env.NODE_ENV ?? "development"}`);
  });
  initRuntime().catch((err) => {
    logger.error("Runtime ▸ background initializer crashed", err);
  });

  const shutdown = async () => {
    logger.info("Server ▸ shutting down...");
    server.close(() => logger.info("Server ▸ HTTP server closed"));
    if (closeStorage) {
      await closeStorage();
    }
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

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  process.exit(1);
});

main().catch((err) => {
  logger.error("Failed to start server", err);
  process.exit(1);
});
