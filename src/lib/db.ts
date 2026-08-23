import { getSupabaseAdmin } from "./supabase";
import type { FileStatus, ObservationInput } from "./types";

export async function createFileRecord(input: {
  userId: string;
  originalFilename: string;
  storagePath: string;
  mimeType: string;
  fileSize: number;
  checksum: string;
  modality: string;
}) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("files")
    .insert({
      user_id: input.userId,
      original_filename: input.originalFilename,
      storage_path: input.storagePath,
      mime_type: input.mimeType,
      file_size: input.fileSize,
      checksum: input.checksum,
      modality: input.modality,
      status: "QUEUED",
      processing_progress: 0
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function findDuplicateFile(userId: string, checksum: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("files")
    .select("*")
    .eq("user_id", userId)
    .eq("checksum", checksum)
    .in("status", ["QUEUED", "PROCESSING", "COMPLETED", "PARTIALLY_PROCESSED"])
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function enqueueJob(fileId: string, kind = "PROCESS_FILE") {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("processing_jobs")
    .select("*")
    .eq("file_id", fileId)
    .eq("kind", kind)
    .in("status", ["QUEUED", "PROCESSING"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;

  const { data, error } = await supabase
    .from("processing_jobs")
    .insert({ file_id: fileId, kind, status: "QUEUED" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateFileStatus(fileId: string, status: FileStatus, progress: number, errorMessage?: string | null) {
  const { error } = await getSupabaseAdmin()
    .from("files")
    .update({
      status,
      processing_progress: progress,
      processing_error: errorMessage ?? null,
      updated_at: new Date().toISOString()
    })
    .eq("id", fileId);
  if (error) throw error;
}

export async function insertObservations(observations: ObservationInput[]) {
  if (observations.length === 0) return [];
  const rows = observations.map((obs) => ({
    file_id: obs.fileId,
    modality: obs.modality,
    kind: obs.kind,
    content: obs.content,
    page_number: obs.pageNumber ?? null,
    timestamp_start: obs.timestampStart ?? null,
    timestamp_end: obs.timestampEnd ?? null,
    frame_timestamp: obs.frameTimestamp ?? null,
    bounding_box: obs.boundingBox ?? null,
    artifact_path: obs.artifactPath ?? null,
    confidence: obs.confidence ?? null,
    metadata: obs.metadata ?? {}
  }));
  const { data, error } = await getSupabaseAdmin().from("observations").insert(rows).select("*");
  if (error) throw error;
  return data ?? [];
}

export async function insertProcessingNote(fileId: string, modality: string, content: string, metadata: Record<string, unknown> = {}) {
  return insertObservations([
    {
      fileId,
      modality: modality as ObservationInput["modality"],
      kind: "processing_note",
      content,
      confidence: 1,
      metadata
    }
  ]);
}
