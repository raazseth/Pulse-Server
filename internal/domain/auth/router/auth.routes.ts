import { Router } from "express";
import { AuthHandler } from "@/internal/domain/auth/handler/auth.handler";
import { createAuthenticate } from "@/internal/middleware/authenticate";
import { validateBody } from "@/internal/middleware/validate";
import { AuthService } from "@/internal/domain/auth/service/auth.service";
import { LoginSchema, RegisterSchema } from "@/internal/validation/auth.schemas";

export function AuthRoutes(handler: AuthHandler, authService: AuthService): Router {
  const router = Router();
  const authenticate = createAuthenticate(authService);

  router.post("/register", validateBody(RegisterSchema), handler.register);
  router.post("/login", validateBody(LoginSchema), handler.login);
  router.post("/refresh", handler.refresh);
  router.delete("/logout", handler.logout);
  router.get("/me", authenticate, handler.me);

  return router;
}
