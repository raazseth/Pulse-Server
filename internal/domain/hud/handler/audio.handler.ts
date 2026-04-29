import { NextFunction, Request, Response } from "express";
import { AppError } from "@/internal/pkg/AppError";
import { ok } from "@/internal/pkg/ApiResponse";
import SC from "@/internal/pkg/response";
import { transcriptionService } from "@/internal/domain/hud/service/transcription.service";

export class AudioHandler {
  transcribe = async (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return next(new AppError("Audio body is required", 0, SC.BAD_REQUEST));
    }

    const rawLang =
      (req.query.lang as string | undefined)?.split("-")[0]?.toLowerCase() ?? "en";
    const lang = /^[a-z]{2,3}$/.test(rawLang) ? rawLang : "en";

    const mimeType = (req.headers["content-type"] ?? "audio/webm").split(";")[0].trim();

    try {
      const text = await transcriptionService.transcribe(body, lang, mimeType);
      return res.status(SC.OK).json(ok({ text }, "Transcribed"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return next(new AppError(`Audio transcription failed: ${msg}`, 0, SC.INTERNAL_SERVER_ERROR));
    }
  };
}
