import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().default("multimodal-rag"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_CHAT_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_VISION_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(512 * 1024 * 1024),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  TESSERACT_PATH: z.string().default("tesseract"),
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
