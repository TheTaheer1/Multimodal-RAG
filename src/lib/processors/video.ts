import fs from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../env";
import type { ProcessingResult } from "../types";
import { processAudio } from "./audio";
import { processImage } from "./image";
import { commandExists, runCommand } from "./util";
import { runActiveSpeaker, runDiarization, runFaceDetection } from "../video/speaker";

export async function processVideo(fileId: string, filePath: string, workDir: string): Promise<ProcessingResult> {
  const env = getEnv();
  const warnings: string[] = [];
  const observations: ProcessingResult["observations"] = [];

  if (!(await commandExists(env.FFMPEG_PATH))) {
    return { observations, warnings: ["FFmpeg is not installed or not on FFMPEG_PATH; video processing skipped."] };
  }

  const audioPath = path.join(workDir, "audio.wav");
  await runCommand(env.FFMPEG_PATH, ["-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", audioPath], 600_000);
  const audioResult = await processAudio(fileId, audioPath);
  warnings.push(...audioResult.warnings);
  observations.push(...audioResult.observations.map((obs) => ({ ...obs, modality: "video" as const })));

  const framesDir = path.join(workDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });
  await runCommand(env.FFMPEG_PATH, ["-y", "-i", filePath, "-vf", "fps=1/5", path.join(framesDir, "frame-%06d.jpg")], 600_000);
  const frameFiles = (await fs.readdir(framesDir)).filter((name) => name.endsWith(".jpg")).sort();
  const manifest = frameFiles.map((name, index) => ({
    frame_path: path.join(framesDir, name),
    timestamp: index * 5
  }));
  const manifestPath = path.join(workDir, "frames.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  for (const frame of manifest.slice(0, 80)) {
    observations.push({
      fileId,
      modality: "video",
      kind: "frame",
      content: `Extracted representative video frame at ${frame.timestamp.toFixed(3)} seconds.`,
      frameTimestamp: frame.timestamp,
      artifactPath: frame.frame_path,
      confidence: 1,
      metadata: { extraction: "ffmpeg", local_artifact: true }
    });
    const frameResult = await processImage(fileId, frame.frame_path, frame.frame_path);
    warnings.push(...frameResult.warnings);
    observations.push(
      ...frameResult.observations.map((obs) => ({
        ...obs,
        modality: "video" as const,
        frameTimestamp: frame.timestamp,
        timestampStart: obs.timestampStart ?? frame.timestamp,
        timestampEnd: obs.timestampEnd ?? frame.timestamp
      }))
    );
  }

  const diarization = await runDiarization(audioPath);
  if (diarization.warning) warnings.push(diarization.warning);
  for (const segment of diarization.segments) {
    observations.push({
      fileId,
      modality: "video",
      kind: "speaker_segment",
      content: `${segment.speaker_id} spoke from ${segment.start_time.toFixed(3)}s to ${segment.end_time.toFixed(3)}s.`,
      timestampStart: segment.start_time,
      timestampEnd: segment.end_time,
      confidence: segment.confidence ?? null,
      metadata: { speaker_id: segment.speaker_id, identity_state: "DIARIZED_ONLY" }
    });
  }

  const faces = await runFaceDetection(manifestPath);
  if (faces.warning) warnings.push(faces.warning);
  for (const face of faces.faces) {
    observations.push({
      fileId,
      modality: "video",
      kind: "vision_description",
      content: `Detected face track ${face.track_id} at ${face.timestamp.toFixed(3)} seconds.`,
      timestampStart: face.timestamp,
      timestampEnd: face.timestamp,
      frameTimestamp: face.timestamp,
      boundingBox: face.bounding_box,
      artifactPath: face.frame_path,
      confidence: face.confidence ?? null,
      metadata: { face_track_id: face.track_id, detection: "face-adapter" }
    });
  }
  const activeManifestPath = path.join(workDir, "active-speaker-input.json");
  await fs.writeFile(activeManifestPath, JSON.stringify({ diarization: diarization.segments, faces: faces.faces }, null, 2));
  const active = await runActiveSpeaker(activeManifestPath);
  if (active.warning) warnings.push(active.warning);
  for (const link of active.links) {
    observations.push({
      fileId,
      modality: "video",
      kind: "speaker_segment",
      content:
        link.confidence && link.confidence >= 0.7
          ? `${link.speaker_id} is visually linked to face track ${link.track_id}.`
          : `${link.speaker_id} has an uncertain visual speaker link to face track ${link.track_id}.`,
      timestampStart: link.start_time,
      timestampEnd: link.end_time,
      confidence: link.confidence ?? null,
      metadata: {
        speaker_id: link.speaker_id,
        track_id: link.track_id,
        method: link.method ?? "active-speaker-adapter",
        identity_state: link.confidence && link.confidence >= 0.7 ? "IDENTIFIED_FACE_TRACK" : "UNKNOWN"
      }
    });
  }

  return { observations, warnings };
}
