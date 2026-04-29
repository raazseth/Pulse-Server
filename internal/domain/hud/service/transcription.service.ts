import fs from "fs/promises";
import { config } from "@/internal/config/config";
import { logger } from "@/internal/pkg/logger";
import { wavToFloat32 } from "@/internal/pkg/audio.utils";
import { toWhisperWav, unlink } from "./audio.service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WhisperPipeline = (input: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string }>;

class TranscriptionService {
  private _pipeline: WhisperPipeline | null = null;
  private _loading: Promise<WhisperPipeline> | null = null;

  private async loadModel(): Promise<WhisperPipeline> {
    if (this._pipeline) return this._pipeline;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      if (process.env.ORT_LOG_SEVERITY_LEVEL === undefined) {
        process.env.ORT_LOG_SEVERITY_LEVEL = "3";
      }
      const { pipeline, env } = await import("@xenova/transformers");
      env.localModelPath = config.whisper.modelsDir;
      env.allowRemoteModels = true;
      env.backends.onnx.wasm.numThreads = 1;

      const modelId = `Xenova/whisper-${config.whisper.model}`;
      logger.info(`Loading Whisper model: ${modelId}`);

      const pipe = await pipeline("automatic-speech-recognition", modelId, {
        cache_dir: config.whisper.modelsDir,
        quantized: true,
      });

      this._pipeline = pipe as unknown as WhisperPipeline;
      logger.info("Whisper model ready");
      return this._pipeline;
    })();

    try {
      return await this._loading;
    } catch (err) {
      this._loading = null;
      throw err;
    }
  }

  // Serial queue: ONNX inference is single-threaded — concurrent calls would OOM or deadlock.
  private _queue: Promise<unknown> = Promise.resolve();

  async transcribe(audioBuf: Buffer, lang: string, mimeType = "audio/webm"): Promise<string> {
    const doWork = async (): Promise<string> => {
      const wavPath = await toWhisperWav(audioBuf, mimeType);
      try {
        const wavBuf = await fs.readFile(wavPath);
        const samples = wavToFloat32(wavBuf);
        const pipe = await this.loadModel();
        const result = await pipe(
          samples,
          { language: lang, task: "transcribe" },
        );
        return result.text.trim();
      } finally {
        await unlink(wavPath);
      }
    };

    const queued = this._queue.then(doWork, doWork);
    this._queue = queued.catch(() => undefined);
    return queued;
  }

  async warmup(): Promise<void> {
    try {
      await this.loadModel();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Whisper warmup failed (will retry on first request): ${msg}`);
    }
  }
}

export const transcriptionService = new TranscriptionService();
