#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const manifestPath = process.argv.at(-1);
if (!manifestPath) {
  process.stderr.write("Usage: node scripts/local-video/active-speaker-single-face.mjs <active-speaker-input.json>\n");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const diarization = manifest.diarization || [];
const faces = manifest.faces || [];

const links = [];
for (const segment of diarization) {
  const visibleTracks = new Set();
  for (const face of faces) {
    const timestamp = Number(face.timestamp);
    if (timestamp >= Number(segment.start_time) && timestamp <= Number(segment.end_time)) {
      visibleTracks.add(String(face.track_id));
    }
  }
  if (visibleTracks.size === 1) {
    links.push({
      speaker_id: segment.speaker_id,
      track_id: [...visibleTracks][0],
      start_time: segment.start_time,
      end_time: segment.end_time,
      confidence: 0.55,
      method: "single-visible-face-heuristic"
    });
  }
}

process.stdout.write(`${JSON.stringify(links)}\n`);
