import { NextFunction, Request, Response } from "express";
import { ZodSchema } from "zod";
import { AppError } from "@/internal/pkg/AppError";
import SC from "@/internal/pkg/response";

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return next(new AppError(message, 0, SC.WRONG_ENTITY));
    }
    req.body = result.data;
    next();
  };
}
