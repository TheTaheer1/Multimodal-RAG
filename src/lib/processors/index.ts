import path from "node:path";
import fs from "node:fs/promises";
import { getEnv } from "../env";
import { getSupabaseAdmin } from "../supabase";
import { insertObservations, insertProcessingNote, updateFileStatus } from "../db";
import { makeWorkDir, writeBuffer } from "./util";
import { processPdf } from "./pdf";
import { processImage } from "./image";
import { processAudio } from "./audio";
import { processVideo } from "./video";
import { processDocument } from "./document";
import { embedObservations } from "../retrieval/embed";
import { materializeGraph } from "../graph";

export async function processFile(fileId: string) {
  const supabase = getSupabaseAdmin();
  const { data: file, error } = await supabase.from("files").select("*").eq("id", fileId).single();
  if (error) throw error;

  await updateFileStatus(fileId, "PROCESSING", 5);
  const env = getEnv();
  const { data, error: downloadError } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).download(file.storage_path);
  if (downloadError) throw downloadError;

  const buffer = Buffer.from(await data.arrayBuffer());
  const workDir = await makeWorkDir(fileId);
  const filePath = await writeBuffer(workDir, `original${path.extname(file.original_filename)}`, buffer);
  await updateFileStatus(fileId, "PROCESSING", 20);

  const result =
    file.modality === "pdf"
      ? await processPdf(fileId, filePath)
      : file.modality === "image"
        ? await processImage(fileId, filePath)
        : file.modality === "audio"
          ? await processAudio(fileId, filePath)
          : file.modality === "video"
            ? await processVideo(fileId, filePath, workDir)
            : await processDocument(fileId, filePath);

  const inserted = await insertObservations(result.observations);
  await updateFileStatus(fileId, "PROCESSING", 75);
  await embedObservations(inserted.map((row) => ({ id: row.id, content: row.content })));
  await materializeGraph(file.user_id, inserted);

  for (const warning of result.warnings) {
    await insertProcessingNote(fileId, file.modality, warning, { severity: "warning" });
  }

  await fs.rm(workDir, { recursive: true, force: true });
  const finalStatus = result.warnings.length > 0 ? "PARTIALLY_PROCESSED" : "COMPLETED";
  await updateFileStatus(fileId, finalStatus, 100, result.warnings.join("\n") || null);
}
