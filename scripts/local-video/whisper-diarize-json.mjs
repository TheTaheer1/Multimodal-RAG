#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const audioPath = process.argv.at(-1);
const whisperBin = process.env.WHISPER_CPP_BIN || "whisper-cli";
const modelPath = process.env.WHISPER_CPP_MODEL ? path.resolve(process.env.WHISPER_CPP_MODEL) : "";

if (!audioPath) fail("Usage: node scripts/local-video/whisper-diarize-json.mjs <audio-file>");
if (!modelPath) fail("WHISPER_CPP_MODEL is not configured.");
try {
  await access(modelPath);
} catch {
  fail(`WHISPER_CPP_MODEL file does not exist: ${modelPath}`);
}

const workDir = await mkdtemp(path.join(tmpdir(), "mm-rag-diarize-"));
try {
  const outputPrefix = path.join(workDir, "diarize");
  const diarized = await runWhisper(["-m", modelPath, "-f", audioPath, "-oj", "-of", outputPrefix, "-tdrz"]);
  if (!diarized) {
    await runWhisper(["-m", modelPath, "-f", audioPath, "-oj", "-of", outputPrefix]);
  }
  const raw = JSON.parse(await readFile(`${outputPrefix}.json`, "utf8"));
  const segments = normalize(raw);
  process.stdout.write(`${JSON.stringify(segments)}\n`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}

async function runWhisper(args) {
  try {
    await run(whisperBin, args, 900_000);
    return true;
  } catch (error) {
    if (args.includes("-tdrz")) return false;
    throw error;
  }
}

function normalize(raw) {
  const source = Array.isArray(raw.segments) ? raw.segments : Array.isArray(raw.transcription) ? raw.transcription : [];
  let speaker = 0;
  return source
    .map((segment) => {
      const timestamps = segment.timestamps || {};
      const row = {
        speaker_id: `SPEAKER_${String(speaker).padStart(2, "0")}`,
        start_time: numberOrTime(segment.start ?? segment.t0 ?? timestamps.from ?? 0),
        end_time: numberOrTime(segment.end ?? segment.t1 ?? timestamps.to ?? 0),
        confidence: 0.55
      };
      if (segment.speaker_turn_next === true || segment.speaker_turn_next === 1) {
        speaker = speaker === 0 ? 1 : 0;
      }
      return row;
    })
    .filter((segment) => segment.end_time >= segment.start_time);
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
