import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().default("multimodal-rag"),
  AI_PROVIDER: z.enum(["ollama"]).default("ollama"),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().default("llama3.2"),
  OLLAMA_EMBEDDING_MODEL: z.string().default("nomic-embed-text"),
  OLLAMA_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(768),
  OLLAMA_VISION_MODEL: z.string().optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(512 * 1024 * 1024),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  TESSERACT_PATH: z.string().default("tesseract"),
  SPEECH_TO_TEXT_COMMAND: z.string().optional(),
  SPEAKER_DIARIZATION_COMMAND: z.string().optional(),
  FACE_DETECTION_COMMAND: z.string().optional(),
  ACTIVE_SPEAKER_COMMAND: z.string().optional()
});

export type AppEnv = z.infer<typeof envSchema>;

export function getEnv(): AppEnv {
  return envSchema.parse(process.env);
}

export function getOptionalEnv(): Partial<AppEnv> {
  return envSchema.partial().parse(process.env);
}
