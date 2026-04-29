import path from "path";
import os from "os";
import fs from "fs/promises";
import crypto from "crypto";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegPath as string);

function mimeToExt(mime: string): string {
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return ".mp4";
  if (mime.includes("mp3") || mime.includes("mpeg")) return ".mp3";
  if (mime.includes("wav")) return ".wav";
  if (mime.includes("flac")) return ".flac";
  return ".webm";
}

function mimeToFfmpegFormat(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "mp4";
  if (mime.includes("mp3") || mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("flac")) return "flac";
  return "webm";
}

export async function toWhisperWav(input: Buffer, mimeType = "audio/webm"): Promise<string> {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString("hex");
  const ext = mimeToExt(mimeType);
  const inPath = path.join(tmpDir, `whisper-in-${id}${ext}`);
  const outPath = path.join(tmpDir, `whisper-${id}.wav`);

  await fs.writeFile(inPath, input);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .inputOptions([`-f ${mimeToFfmpegFormat(mimeType)}`])
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec("pcm_s16le")
        .format("wav")
        .output(outPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
  } finally {
    await fs.unlink(inPath).catch(() => undefined);
  }

  return outPath;
}

export async function unlink(p: string): Promise<void> {
  await fs.unlink(p).catch(() => undefined);
}
