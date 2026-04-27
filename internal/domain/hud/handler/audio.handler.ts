import { NextFunction, Request, Response } from "express";
import OpenAI, { toFile } from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { AppError } from "@/internal/pkg/AppError";
import { ok } from "@/internal/pkg/ApiResponse";
import SC from "@/internal/pkg/response";
import { logger } from "@/internal/pkg/logger";

interface AudioBackend {
  transcribe(audio: Buffer, mimeType: string, lang: string): Promise<string>;
}

/** Strip codecs/parameters — Whisper rejects types like `audio/webm;codecs=opus` on the file part. */
function normalizeAudioMimeType(contentType: string | undefined): string {
  const raw = (contentType ?? "audio/webm").split(";")[0].trim().toLowerCase();
  const allowed = new Set([
    "audio/webm",
    "audio/ogg",
    "audio/mp3",
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/x-wav",
    "audio/flac",
    "audio/m4a",
    "audio/mpga",
  ]);
  return allowed.has(raw) ? raw : "audio/webm";
}

function mimeToFilename(mime: string): string {
  if (mime.includes("ogg")) return "audio.ogg";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "audio.wav";
  if (mime === "audio/mp4" || mime === "audio/m4a") return "audio.m4a";
  if (mime === "audio/flac") return "audio.flac";
  return "audio.webm";
}

class WhisperBackend implements AudioBackend {
  private readonly client: OpenAI;
  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, timeout: 30_000 });
  }
  async transcribe(audio: Buffer, mimeType: string, lang: string): Promise<string> {
    const normalized = normalizeAudioMimeType(mimeType);
    const filename = mimeToFilename(normalized);
    const result = await this.client.audio.transcriptions.create({
      file: await toFile(audio, filename, { type: normalized }),
      model: "whisper-1",
      language: lang,
    });
    return result.text ?? "";
  }
}

class GeminiAudioBackend implements AudioBackend {
  private readonly client: GoogleGenerativeAI;
  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }
  async transcribe(audio: Buffer, mimeType: string, _lang: string): Promise<string> {
    const normalized = normalizeAudioMimeType(mimeType);
    const modelName = process.env.GEMINI_AUDIO_MODEL?.trim() || "gemini-1.5-flash";
    const model = this.client.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(
      {
        contents: [{
          role: "user",
          parts: [
            { inlineData: { data: audio.toString("base64"), mimeType } },
            { text: "Transcribe this audio accurately. Return only the spoken words, no commentary." },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      },
      { timeout: 30_000 },
    );
    return result.response.text().trim();
  }
}

export class AudioHandler {
  private readonly primary: AudioBackend | null;
  private readonly fallback: AudioBackend | null;

  constructor(
    openaiApiKey: string | undefined,
    geminiApiKey: string | undefined,
    aiProvider?: string,
  ) {
    const prefer = aiProvider?.toLowerCase();

    if (prefer === "gemini") {
      // Explicit Gemini preference — use Gemini first, Whisper as fallback if key exists.
      this.primary = geminiApiKey ? new GeminiAudioBackend(geminiApiKey) : null;
      this.fallback = openaiApiKey ? new WhisperBackend(openaiApiKey) : null;
    } else if (prefer === "openai") {
      this.primary = openaiApiKey ? new WhisperBackend(openaiApiKey) : null;
      this.fallback = geminiApiKey ? new GeminiAudioBackend(geminiApiKey) : null;
    } else {
      // Auto: prefer whichever key is present; if both, Whisper first.
      this.primary = openaiApiKey
        ? new WhisperBackend(openaiApiKey)
        : geminiApiKey
          ? new GeminiAudioBackend(geminiApiKey)
          : null;
      this.fallback =
        openaiApiKey && geminiApiKey ? new GeminiAudioBackend(geminiApiKey) : null;
    }
  }

  transcribe = async (req: Request, res: Response, next: NextFunction) => {
    if (!this.primary) {
      return next(
        new AppError(
          "Audio transcription unavailable — set OPENAI_API_KEY or GEMINI_API_KEY to enable",
          0,
          SC.SERVICE_UNAVAILABLE,
        ),
      );
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return next(new AppError("Audio body is required", 0, SC.BAD_REQUEST));
    }

    const rawLang =
      (req.query.lang as string | undefined)?.split("-")[0]?.toLowerCase() ?? "en";
    const lang = /^[a-z]{2,3}$/.test(rawLang) ? rawLang : "en";
    const mimeType = normalizeAudioMimeType(
      typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined,
    );

    try {
      const text = await this.primary.transcribe(body, mimeType, lang);
      return res.status(SC.OK).json(ok({ text }, "Transcribed"));
    } catch (primaryErr) {
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      logger.error(`Audio primary transcription error: ${primaryMsg}`);

      if (this.fallback) {
        logger.warn("Audio primary failed — trying fallback backend");
        try {
          const text = await this.fallback.transcribe(body, mimeType, lang);
          return res.status(SC.OK).json(ok({ text }, "Transcribed"));
        } catch (fallbackErr) {
          const fb = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          logger.error(`Audio fallback transcription error: ${fb}`);
        }
      }

      const hint =
        /401|invalid.*api|incorrect api key/i.test(primaryMsg)
          ? " Check OPENAI_API_KEY / GEMINI_API_KEY."
          : "";
      return next(
        new AppError(`Audio transcription failed.${hint}`, 0, SC.INTERNAL_SERVER_ERROR),
      );
    }
  };
}
