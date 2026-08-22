import { getOptionalEnv } from "../env";
import { parseCommandJson } from "../processors/util";
import type { BoundingBox } from "../types";

export type DiarizationSegment = {
  speaker_id: string;
  start_time: number;
  end_time: number;
  confidence?: number;
};

export type FaceDetection = {
  frame_path: string;
  timestamp: number;
  bounding_box: BoundingBox;
  track_id: string;
  confidence?: number;
};

export type ActiveSpeakerLink = {
  speaker_id: string;
  track_id: string;
  start_time: number;
  end_time: number;
  confidence?: number;
  method?: string;
};

export async function runDiarization(audioPath: string) {
  const env = getOptionalEnv();
  if (!env.SPEAKER_DIARIZATION_COMMAND) {
    return { segments: [] as DiarizationSegment[], warning: "SPEAKER_DIARIZATION_COMMAND is not configured; speaker identity remains diarized-only or unknown." };
  }
  return { segments: await parseCommandJson<DiarizationSegment[]>(env.SPEAKER_DIARIZATION_COMMAND, audioPath), warning: null };
}

export async function runFaceDetection(framesManifestPath: string) {
  const env = getOptionalEnv();
  if (!env.FACE_DETECTION_COMMAND) {
    return { faces: [] as FaceDetection[], warning: "FACE_DETECTION_COMMAND is not configured; face tracking skipped." };
  }
  return { faces: await parseCommandJson<FaceDetection[]>(env.FACE_DETECTION_COMMAND, framesManifestPath), warning: null };
}

export async function runActiveSpeaker(manifestPath: string) {
  const env = getOptionalEnv();
  if (!env.ACTIVE_SPEAKER_COMMAND) {
    return { links: [] as ActiveSpeakerLink[], warning: "ACTIVE_SPEAKER_COMMAND is not configured; active-speaker links remain unknown." };
  }
  return { links: await parseCommandJson<ActiveSpeakerLink[]>(env.ACTIVE_SPEAKER_COMMAND, manifestPath), warning: null };
}
