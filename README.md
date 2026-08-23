# Multimodal Evidence RAG

A working Next.js + Node/TypeScript system for turning PDFs, images, video, and audio into structured, connected, retrieval-ready evidence. It stores originals in Supabase Storage, metadata and graph relationships in PostgreSQL, and embeddings in pgvector.

## What is implemented

- Upload validation by MIME, extension, file signature, size, checksum, and duplicate detection.
- Supabase Storage paths for originals and generated artifacts.
- PostgreSQL schema for files, jobs, observations, entities, relationships, events, speakers, diarization segments, frames, faces, tracks, speaker-face links, and embeddings.
- PDF extraction with page provenance, plus scanned-PDF OCR fallback when Tesseract is installed.
- Image OCR and EXIF timestamp capture. Optional image understanding uses an Ollama vision model when `OLLAMA_VISION_MODEL` is configured.
- Optional audio transcription through a local `SPEECH_TO_TEXT_COMMAND` adapter.
- Video audio extraction, frame extraction, OCR/vision per frame, transcript alignment, diarization adapter, face detection adapter, active-speaker adapter, and uncertainty-preserving speaker mapping.
- Hybrid retrieval using vector, keyword, entity, temporal, and relationship expansion.
- Ollama `nomic-embed-text` embeddings for pgvector search.
- Ollama `llama3.2` answer generation with evidence citations and claim-level verification.

No mock processing results are inserted. If a processor is unavailable or an optional model adapter is not configured, the file is marked `PARTIALLY_PROCESSED` and the missing capability is recorded as processing evidence/uncertainty.

## Setup

1. Create a Supabase project and a private storage bucket named `multimodal-rag`.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Copy `.env.example` to `.env.local` and fill in the Supabase values. Do not commit real keys.
4. Install and prepare Ollama:

```bash
brew install ollama
ollama serve
ollama pull llama3.2
ollama pull nomic-embed-text
```

5. Install host tools on the worker machine:

```bash
brew install ffmpeg tesseract
```

6. Install dependencies and run:

```bash
npm install
npm run dev
```

7. Check Ollama from the backend:

```bash
curl http://localhost:3000/api/health/ollama
```

8. In another terminal, start the processing worker:

```bash
npm run worker
```

The worker loads the same `.env.local` file as Next.js, so keep it in the project root.

## Ollama Embeddings

This project now uses:

- LLM model: `llama3.2`
- Embedding model: `nomic-embed-text`
- Ollama URL: `http://127.0.0.1:11434`
- Optional vision model: set `OLLAMA_VISION_MODEL` to a vision-capable Ollama model.

`nomic-embed-text` returns 768-dimensional vectors. The current project schema file has been updated to `vector(768)` for fresh installs.

If your Supabase database was already created with `vector(1536)`, do not drop your project. Run `supabase/ollama_embedding_migration.sql`. It preserves files, observations, metadata, relationships, timestamps, citations, speakers, and provenance, but backs up and clears old incompatible vectors so documents can be re-indexed with Ollama.

After migration, requeue files that need embeddings:

```sql
update files
set status = 'QUEUED',
    processing_progress = 0,
    processing_error = null,
    updated_at = now();

insert into processing_jobs (file_id, kind, status)
select id, 'PROCESS_FILE', 'QUEUED'
from files;
```

## Local Audio Transcription

Ollama does not provide speech-to-text. Audio/video transcription is handled by a local command adapter.

One supported free setup is `whisper.cpp`:

```bash
brew install whisper-cpp ffmpeg
mkdir -p models
curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Then set:

```bash
SPEECH_TO_TEXT_COMMAND=node scripts/whisper-cpp-json.mjs
WHISPER_CPP_BIN=whisper-cli
WHISPER_CPP_MODEL=models/ggml-base.en.bin
```

The command receives the audio file path as its final argument and prints JSON to stdout:

```json
[
  { "text": "hello world", "start_time": 0, "end_time": 2.5, "confidence": 0.8 }
]
```

## Optional model adapters

Speaker diarization, face detection, and active-speaker detection are dedicated stages. Configure them with commands that accept the relevant file path as the first argument and print JSON to stdout.

Local default adapters are included:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install opencv-python
ollama pull gemma3
```

Then set:

```bash
OLLAMA_VISION_MODEL=gemma3:latest
SPEAKER_DIARIZATION_COMMAND=node scripts/local-video/whisper-diarize-json.mjs
FACE_DETECTION_COMMAND=.venv/bin/python scripts/local-video/face-detect-track.py
ACTIVE_SPEAKER_COMMAND=node scripts/local-video/active-speaker-single-face.mjs
```

The active-speaker adapter is conservative: it links a speaker segment to a face track only when exactly one face track is visible during that segment. It does not guess when multiple people are visible.

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
