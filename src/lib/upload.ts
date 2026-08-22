import crypto from "node:crypto";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { getEnv } from "./env";

const supported = [
  { ext: ".pdf", mime: "application/pdf", modality: "pdf" },
  { ext: ".png", mime: "image/png", modality: "image" },
  { ext: ".jpg", mime: "image/jpeg", modality: "image" },
  { ext: ".jpeg", mime: "image/jpeg", modality: "image" },
  { ext: ".webp", mime: "image/webp", modality: "image" },
  { ext: ".mp4", mime: "video/mp4", modality: "video" },
  { ext: ".mov", mime: "video/quicktime", modality: "video" },
  { ext: ".webm", mime: "video/webm", modality: "video" },
  { ext: ".mp3", mime: "audio/mpeg", modality: "audio" },
  { ext: ".wav", mime: "audio/wav", modality: "audio" },
  { ext: ".m4a", mime: "audio/mp4", modality: "audio" },
  { ext: ".txt", mime: "text/plain", modality: "document" },
  { ext: ".md", mime: "text/markdown", modality: "document" }
] as const;

export const uploadRequestSchema = z.object({
  userId: z.string().min(1).default("anonymous")
});

export function sha256(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function validateUpload(fileName: string, buffer: Buffer, clientMime?: string) {
  const env = getEnv();
  if (buffer.length === 0) {
    return { ok: false as const, code: "EMPTY_FILE", message: "The uploaded file is empty." };
  }
  if (buffer.length > env.MAX_UPLOAD_BYTES) {
    return { ok: false as const, code: "FILE_TOO_LARGE", message: "The uploaded file exceeds the configured limit." };
  }

  const ext = path.extname(fileName).toLowerCase();
  const byExt = supported.find((item) => item.ext === ext);
  if (!byExt) {
    return { ok: false as const, code: "UNSUPPORTED_FILE_TYPE", message: "This file format is not supported." };
  }

  const detected = await fileTypeFromBuffer(buffer);
  const detectedMime = detected?.mime ?? clientMime ?? byExt.mime;
  const isText = byExt.mime.startsWith("text/");
  if (!isText && detectedMime !== byExt.mime) {
    return { ok: false as const, code: "INVALID_FILE_SIGNATURE", message: "The file contents do not match the extension." };
  }

  return {
    ok: true as const,
    extension: ext,
    mimeType: byExt.mime,
    modality: byExt.modality,
    checksum: sha256(buffer)
  };
}
