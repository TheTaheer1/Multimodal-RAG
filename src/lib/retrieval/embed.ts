import { createOllamaEmbedding } from "../ollama";
import { formatDatabaseError } from "../errors";
import { getSupabaseAdmin } from "../supabase";

export async function embedObservations(observations: Array<{ id: string; content: string }>) {
  if (observations.length === 0) return;
  const supabase = getSupabaseAdmin();
  for (const obs of observations) {
    const embedding = await createOllamaEmbedding(obs.content.slice(0, 8000));
    const { error } = await supabase.from("observation_embeddings").upsert({
      observation_id: obs.id,
      embedding
    });
    if (error) throw new Error(formatDatabaseError(error));
  }
}

export async function embedQuery(query: string) {
  return createOllamaEmbedding(query);
}
