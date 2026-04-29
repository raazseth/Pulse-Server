#!/usr/bin/env node
"use strict";

const path = require("path");

const modelsDir = process.env.WHISPER_MODELS_DIR || path.join(__dirname, "../models");
const model = process.env.WHISPER_MODEL || "base.en";

async function main() {
  if (process.env.ORT_LOG_SEVERITY_LEVEL === undefined) {
    process.env.ORT_LOG_SEVERITY_LEVEL = "3";
  }
  console.log(`[warmup] Downloading Whisper model: openai/whisper-${model}`);
  console.log(`[warmup] Cache dir: ${modelsDir}`);

  const { pipeline, env } = await import("@xenova/transformers");
  env.localModelPath = modelsDir;
  env.allowRemoteModels = true;
  env.backends.onnx.wasm.numThreads = 1;

  await pipeline("automatic-speech-recognition", `Xenova/whisper-${model}`, {
    cache_dir: modelsDir,
    quantized: true,
  });

  console.log("[warmup] Model ready.");
}

main().catch((err) => {
  console.error("[warmup] Failed:", err.message || String(err));
  process.exit(1);
});
