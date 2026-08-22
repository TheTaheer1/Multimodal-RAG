import fs from "node:fs";
import { getOpenAI } from "../openai";
import type { ProcessingResult } from "../types";

export async function processAudio(fileId: string, filePath: string): Promise<ProcessingResult> {
  const client = getOpenAI();
  if (!client) {
    return {
      observations: [],
      warnings: ["OPENAI_API_KEY is not configured; speech-to-text skipped."]
    };
  }
  const transcription = await client.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"]
  });
  const segments = "segments" in transcription && Array.isArray(transcription.segments) ? transcription.segments : [];
  const observations: ProcessingResult["observations"] = segments.map((segment) => ({
    fileId,
    modality: "audio" as const,
    kind: "transcript" as const,
    content: String(segment.text ?? "").trim(),
    timestampStart: Number(segment.start ?? 0),
    timestampEnd: Number(segment.end ?? 0),
    confidence: 0.86,
    metadata: { engine: "openai-whisper" }
  })).filter((item) => item.content.length > 0);
  return { observations, warnings: [] };
}
