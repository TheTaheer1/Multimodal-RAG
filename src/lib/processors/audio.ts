import { getOptionalEnv } from "../env";
import type { ProcessingResult } from "../types";
import { formatError } from "../errors";
import { parseCommandJson } from "./util";

type TranscriptSegment = {
  text: string;
  start_time?: number;
  end_time?: number;
  start?: number;
  end?: number;
  confidence?: number;
};

export async function processAudio(fileId: string, filePath: string): Promise<ProcessingResult> {
  const env = getOptionalEnv();
  if (!env.SPEECH_TO_TEXT_COMMAND) {
    return {
      observations: [],
      warnings: ["SPEECH_TO_TEXT_COMMAND is not configured; local speech-to-text skipped."]
    };
  }
  try {
    const segments = await parseCommandJson<TranscriptSegment[]>(env.SPEECH_TO_TEXT_COMMAND, filePath);
    const observations: ProcessingResult["observations"] = segments.map((segment) => ({
      fileId,
      modality: "audio" as const,
      kind: "transcript" as const,
      content: String(segment.text ?? "").trim(),
      timestampStart: Number(segment.start_time ?? segment.start ?? 0),
      timestampEnd: Number(segment.end_time ?? segment.end ?? 0),
      confidence: segment.confidence ?? 0.8,
      metadata: { engine: "local-speech-to-text-command" }
    })).filter((item) => item.content.length > 0);
    return { observations, warnings: [] };
  } catch (error) {
    return {
      observations: [],
      warnings: [`Speech-to-text skipped: ${friendlyAudioError(error)}`]
    };
  }
}

function friendlyAudioError(error: unknown) {
  const message = formatError(error);
  return `${message}. Configure SPEECH_TO_TEXT_COMMAND with a local transcription command that outputs transcript segments as JSON.`;
}
