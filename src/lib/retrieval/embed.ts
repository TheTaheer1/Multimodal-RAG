import { getEnv } from "../env";
import { getOpenAI } from "../openai";
import { getSupabaseAdmin } from "../supabase";

export async function embedObservations(observations: Array<{ id: string; content: string }>) {
  const client = getOpenAI();
  if (!client || observations.length === 0) return;
  const env = getEnv();
  const supabase = getSupabaseAdmin();
  for (const obs of observations) {
    const response = await client.embeddings.create({
      model: env.OPENAI_EMBEDDING_MODEL,
      input: obs.content.slice(0, 8000)
    });
    const embedding = response.data[0]?.embedding;
    if (!embedding) continue;
    const { error } = await supabase.from("observation_embeddings").upsert({
      observation_id: obs.id,
      embedding
    });
    if (error) throw error;
  }
}

export async function embedQuery(query: string) {
  const client = getOpenAI();
  if (!client) return null;
  const env = getEnv();
  const response = await client.embeddings.create({
    model: env.OPENAI_EMBEDDING_MODEL,
    input: query
  });
  return response.data[0]?.embedding ?? null;
}
