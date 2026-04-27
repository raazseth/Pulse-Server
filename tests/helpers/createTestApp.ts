import express, { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { createApp } from "@/internal/app/app";
import { AppError } from "@/internal/pkg/AppError";
import { config } from "@/internal/config/config";
import SC from "@/internal/pkg/response";

const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const isAppError = err instanceof AppError;
  const status =
    isAppError && Number.isInteger(err.status) ? err.status : SC.INTERNAL_SERVER_ERROR;
  res.status(status).json({
    type: isAppError ? err.type : SC.INTERNAL_SERVER_ERROR,
    success: false,
    message: err instanceof Error ? err.message : "Something went wrong!",
    data: null,
  });
};

export function getTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL (or DATABASE_URL) is required to run integration tests against Postgres",
    );
  }
  return url;
}

// S-17: Mint a short-lived JWT signed with the app secret — used to authenticate
// integration test requests to protected HUD routes without a real DB user.
export function makeAuthHeader(
  userId: string = randomUUID(),
  email: string = "test@pulse.dev",
): string {
  const token = jwt.sign({ userId, email }, config.auth.jwtSecret, { expiresIn: "5m" });
  return `Bearer ${token}`;
}

export async function createTestApp() {
  const databaseUrl = getTestDatabaseUrl();
  const { router, authService, pg } = await createApp({ databaseUrl, skipRateLimiting: true });

  const app = express();
  app.use(express.json());
  app.use("/api/v1", router);
  app.use(errorHandler);

  // Use request.agent so cookies are automatically persisted between requests
  // within the same test session (required for httpOnly refresh-token flow).
  const agent = request.agent(app);
  const makeAgent = () => request.agent(app);

  return { agent, makeAgent, authService, pg };
}
