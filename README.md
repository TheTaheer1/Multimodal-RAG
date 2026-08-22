# Multimodal Evidence RAG

A working Next.js + Node/TypeScript system for turning PDFs, images, video, and audio into structured, connected, retrieval-ready evidence. It stores originals in Supabase Storage, metadata and graph relationships in PostgreSQL, and embeddings in pgvector.

## What is implemented

- Upload validation by MIME, extension, file signature, size, checksum, and duplicate detection.
- Supabase Storage paths for originals and generated artifacts.
- PostgreSQL schema for files, jobs, observations, entities, relationships, events, speakers, diarization segments, frames, faces, tracks, speaker-face links, and embeddings.
- PDF extraction with page provenance, plus scanned-PDF OCR fallback when Tesseract is installed.
- Image OCR, EXIF timestamp capture, and vision analysis through OpenAI vision models.
- Audio transcription through OpenAI Whisper-compatible transcription.
- Video audio extraction, frame extraction, OCR/vision per frame, transcript alignment, diarization adapter, face detection adapter, active-speaker adapter, and uncertainty-preserving speaker mapping.
- Hybrid retrieval using vector, keyword, entity, temporal, and relationship expansion.
- Answer generation with evidence citations and claim-level verification.

No mock processing results are inserted. If a processor is unavailable or an optional model adapter is not configured, the file is marked `PARTIALLY_PROCESSED` and the missing capability is recorded as processing evidence/uncertainty.

## Setup

1. Create a Supabase project and a private storage bucket named `multimodal-rag`.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Copy `.env.example` to `.env.local` and fill in the Supabase and OpenAI values.
4. Install host tools on the worker machine:

```bash
brew install ffmpeg tesseract
```

5. Install dependencies and run:

```bash
npm install
npm run dev
```

6. In another terminal, start the processing worker:

```bash
npm run worker
```

## Optional model adapters

Speaker diarization, face detection, and active-speaker detection are dedicated stages. Configure them with commands that accept the relevant file path as the first argument and print JSON to stdout.

`SPEAKER_DIARIZATION_COMMAND` output:

```json
[
  { "speaker_id": "SPEAKER_00", "start_time": 129.85, "end_time": 134.2, "confidence": 0.91 }
]
```

`FACE_DETECTION_COMMAND` output:

```json
[
  { "frame_path": "/tmp/frame-0001.jpg", "timestamp": 130.4, "bounding_box": { "x": 20, "y": 40, "width": 180, "height": 210 }, "track_id": "TRACK_001", "confidence": 0.88 }
]
```

`ACTIVE_SPEAKER_COMMAND` output:

```json
[
  { "speaker_id": "SPEAKER_00", "track_id": "TRACK_001", "start_time": 129.85, "end_time": 134.2, "confidence": 0.82, "method": "active-speaker-model" }
]
```

Only confident links are exposed as identified. Low confidence, missing, or conflicting links remain `DIARIZED_ONLY`, `UNKNOWN`, or `CONFLICTING`; the RAG layer is instructed not to invent names.
