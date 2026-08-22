import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnv } from "@/lib/env";
import { createFileRecord, enqueueJob, findDuplicateFile } from "@/lib/db";
import { getSupabaseAdmin } from "@/lib/supabase";
import { uploadRequestSchema, validateUpload } from "@/lib/upload";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return errorResponse("MISSING_FILE", "Upload a file using the `file` form field.", 400);
    }
    const parsed = uploadRequestSchema.parse({ userId: form.get("userId") ?? "anonymous" });
    const buffer = Buffer.from(await file.arrayBuffer());
    const validation = await validateUpload(file.name, buffer, file.type);
    if (!validation.ok) return errorResponse(validation.code, validation.message, 400);

    const duplicate = await findDuplicateFile(parsed.userId, validation.checksum);
    if (duplicate) {
      return NextResponse.json({
        success: true,
        duplicate: true,
        file: duplicate,
        message: "This exact file already exists for the user. Use the existing processed file or reprocess explicitly."
      });
    }

    const fileId = randomUUID();
    const ext = path.extname(file.name).toLowerCase();
    const storagePath = `uploads/${parsed.userId}/${fileId}/original${ext}`;
    const env = getEnv();
    const supabase = getSupabaseAdmin();
    const { error: uploadError } = await supabase.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .upload(storagePath, buffer, { contentType: validation.mimeType, upsert: false });
    if (uploadError) throw uploadError;

    const record = await createFileRecord({
      userId: parsed.userId,
      originalFilename: file.name,
      storagePath,
      mimeType: validation.mimeType,
      fileSize: buffer.length,
      checksum: validation.checksum,
      modality: validation.modality
    });
    await enqueueJob(record.id);
    return NextResponse.json({ success: true, duplicate: false, file: record });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed.";
    const code = message.includes("NEXT_PUBLIC_SUPABASE_URL") || message.includes("SUPABASE_SERVICE_ROLE_KEY")
      ? "SETUP_REQUIRED"
      : "UPLOAD_FAILED";
    return errorResponse(code, code === "SETUP_REQUIRED" ? "Supabase environment variables are missing. Configure .env.local before uploading files." : message, 500);
  }
}

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}
