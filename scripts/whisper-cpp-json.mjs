#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const inputPath = process.argv.at(-1);
if (!inputPath || inputPath === import.meta.filename) {
  fail("Usage: node scripts/whisper-cpp-json.mjs <audio-file>");
}

const whisperBin = process.env.WHISPER_CPP_BIN || "whisper-cli";
const modelPath = process.env.WHISPER_CPP_MODEL ? path.resolve(process.env.WHISPER_CPP_MODEL) : "";
const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";

if (!modelPath) {
  fail("WHISPER_CPP_MODEL is not configured. Set it to a local whisper.cpp model path, such as models/ggml-base.en.bin.");
}

try {
  await access(modelPath);
} catch {
  fail(`WHISPER_CPP_MODEL file does not exist: ${modelPath}. Download one with: curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`);
}

const workDir = await mkdtemp(path.join(tmpdir(), "mm-rag-whisper-"));
try {
  const wavPath = path.join(workDir, "audio.wav");
  const outputPrefix = path.join(workDir, "transcript");
  await run(ffmpegBin, ["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", wavPath], 120_000);
  await run(whisperBin, ["-m", modelPath, "-f", wavPath, "-oj", "-of", outputPrefix], 900_000);

  const raw = JSON.parse(await readFile(`${outputPrefix}.json`, "utf8"));
  const segments = normalizeWhisperJson(raw);
  process.stdout.write(`${JSON.stringify(segments)}\n`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}

function normalizeWhisperJson(raw) {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.segments)
      ? raw.segments
      : Array.isArray(raw.transcription)
        ? raw.transcription
        : [];

  return source
    .map((segment) => {
      const timestamps = segment.timestamps || {};
      return {
        text: String(segment.text || "").trim(),
        start_time: numberOrTime(segment.start ?? segment.start_time ?? segment.t0 ?? timestamps.from ?? 0),
        end_time: numberOrTime(segment.end ?? segment.end_time ?? segment.t1 ?? timestamps.to ?? 0),
        confidence: typeof segment.confidence === "number" ? segment.confidence : undefined
      };
    })
    .filter((segment) => segment.text.length > 0);
}

function numberOrTime(value) {
  if (typeof value === "number") return value > 1000 ? value / 1000 : value;
  if (typeof value !== "string") return 0;
  const parts = value.replace(",", ".").split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value) || 0;
}

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
