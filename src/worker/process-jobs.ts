import { processFile } from "../lib/processors";
import { getSupabaseAdmin } from "../lib/supabase";
import { updateFileStatus } from "../lib/db";

const pollMs = 2500;

async function claimJob() {
  const supabase = getSupabaseAdmin();
  const { data: jobs, error } = await supabase
    .from("processing_jobs")
    .select("*")
    .eq("status", "QUEUED")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const job = jobs?.[0];
  if (!job) return null;
  const { data, error: updateError } = await supabase
    .from("processing_jobs")
    .update({ status: "PROCESSING", started_at: new Date().toISOString(), attempts: job.attempts + 1 })
    .eq("id", job.id)
    .eq("status", "QUEUED")
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;
  return data;
}

async function loop() {
  console.log("Multimodal RAG worker started.");
  while (true) {
    const job = await claimJob();
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    try {
      await processFile(job.file_id);
      await getSupabaseAdmin()
        .from("processing_jobs")
        .update({ status: "COMPLETED", finished_at: new Date().toISOString() })
        .eq("id", job.id);
      console.log(`Processed ${job.file_id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker error.";
      await updateFileStatus(job.file_id, "FAILED", 100, message);
      await getSupabaseAdmin()
        .from("processing_jobs")
        .update({ status: "FAILED", error: message, finished_at: new Date().toISOString() })
        .eq("id", job.id);
      console.error(`Failed ${job.file_id}: ${message}`);
    }
  }
}

loop().catch((error) => {
  console.error(error);
  process.exit(1);
});
