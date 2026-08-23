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
import { formatError } from "../errors";

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

  await supabase.from("observations").delete().eq("file_id", fileId);
  const inserted = await insertObservations(result.observations);
  await updateFileStatus(fileId, "PROCESSING", 75, "Generating Ollama embeddings...");
  const warnings = [...result.warnings];
  try {
    await embedObservations(inserted.map((row) => ({ id: row.id, content: row.content })));
  } catch (error) {
    warnings.push(`Embedding skipped: ${friendlyError(error)}`);
  }
  await updateFileStatus(fileId, "PROCESSING", 86, "Building evidence graph...");
  try {
    await materializeGraph(file.user_id, inserted);
  } catch (error) {
    warnings.push(`Graph enrichment partially skipped: ${friendlyError(error)}`);
  }
  await updateFileStatus(fileId, "PROCESSING", 94, "Saving processing notes...");

  const summarizedWarnings = summarizeWarnings(warnings);
  for (const warning of summarizedWarnings) {
    await insertProcessingNote(fileId, file.modality, warning.message, {
      severity: "warning",
      count: warning.count
    });
  }

  await fs.rm(workDir, { recursive: true, force: true });
  const finalStatus = summarizedWarnings.length > 0 ? "PARTIALLY_PROCESSED" : "COMPLETED";
  await updateFileStatus(fileId, finalStatus, 100, formatWarnings(summarizedWarnings));
}

function friendlyError(error: unknown) {
  const message = formatError(error);
  if (message.includes("Ollama is not running")) {
    return "Ollama is not running. Start it with: ollama serve";
  }
  if (message.includes("timed out")) {
    return `${message} Local Ollama can be slow on first run; try again after the model has warmed up.`;
  }
  if (message.includes("Ollama model") || message.includes("Ollama embedding model") || message.includes("Embedding dimension mismatch")) {
    return message;
  }
  return message;
}

function summarizeWarnings(warnings: string[]) {
  const map = new Map<string, { message: string; count: number }>();
  for (const warning of warnings.map((item) => item.trim()).filter(Boolean)) {
    const existing = map.get(warning);
    if (existing) existing.count += 1;
    else map.set(warning, { message: warning, count: 1 });
  }
  return [...map.values()];
}

function formatWarnings(warnings: Array<{ message: string; count: number }>) {
  if (warnings.length === 0) return null;
  return warnings.map((warning) => (warning.count > 1 ? `${warning.message} (${warning.count} times)` : warning.message)).join("\n");
}
