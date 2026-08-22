import { createOllamaChat } from "./ollama";
import { getSupabaseAdmin } from "./supabase";

type InsertedObservation = {
  id: string;
  file_id: string;
  modality: string;
  kind: string;
  content: string;
  page_number: number | null;
  timestamp_start: number | null;
  timestamp_end: number | null;
  frame_timestamp: number | null;
  artifact_path: string | null;
  confidence: number | null;
  metadata: Record<string, unknown>;
};

type ExtractedGraph = {
  entities?: Array<{ name: string; type: string; aliases?: string[]; confidence?: number }>;
  relationships?: Array<{ source: string; target: string; type: string; evidence?: string; confidence?: number }>;
};

export async function materializeGraph(userId: string, observations: InsertedObservation[]) {
  await materializeMediaTables(observations);
  await extractEntitiesAndRelationships(userId, observations);
  await createTemporalRelationships(observations);
}

async function materializeMediaTables(observations: InsertedObservation[]) {
  const supabase = getSupabaseAdmin();
  for (const obs of observations) {
    if (obs.kind === "frame" && obs.artifact_path && obs.frame_timestamp !== null) {
      await supabase.from("frames").insert({
        file_id: obs.file_id,
        observation_id: obs.id,
        timestamp: obs.frame_timestamp,
        artifact_path: obs.artifact_path,
        metadata: obs.metadata
      });
    }
    if (obs.kind === "speaker_segment") {
      const label = String(obs.metadata?.speaker_id ?? "UNKNOWN");
      const identityState = normalizeIdentityState(String(obs.metadata?.identity_state ?? "DIARIZED_ONLY"));
      const { data: speaker } = await supabase
        .from("speakers")
        .upsert(
          {
            file_id: obs.file_id,
            diarization_label: label,
            identity_state: identityState === "IDENTIFIED" ? "IDENTIFIED" : identityState,
            confidence: obs.confidence,
            metadata: obs.metadata
          },
          { onConflict: "file_id,diarization_label" }
        )
        .select("*")
        .single();
      await supabase.from("speaker_segments").insert({
        file_id: obs.file_id,
        speaker_id: speaker?.id ?? null,
        diarization_label: label,
        start_time: obs.timestamp_start ?? 0,
        end_time: obs.timestamp_end ?? obs.timestamp_start ?? 0,
        confidence: obs.confidence,
        observation_id: obs.id
      });
    }
    if (obs.kind === "vision_description" && obs.metadata?.face_track_id) {
      await supabase.from("face_tracks").upsert(
        {
          file_id: obs.file_id,
          track_id: String(obs.metadata.face_track_id),
          identity_state: "UNKNOWN",
          confidence: obs.confidence,
          metadata: obs.metadata
        },
        { onConflict: "file_id,track_id" }
      );
    }
  }
}

async function extractEntitiesAndRelationships(userId: string, observations: InsertedObservation[]) {
  const eligible = observations
    .filter((obs) => obs.kind !== "processing_note" && obs.content.length > 8)
    .slice(0, 40);
  if (eligible.length === 0) return;
  const content = await createOllamaChat(
    [
      {
        role: "system",
        content:
          "Extract only explicit entities and relationships from evidence. Return JSON: {entities:[{name,type,aliases,confidence}], relationships:[{source,target,type,evidence,confidence}]}. Do not invent entities."
      },
      {
        role: "user",
        content: eligible.map((obs) => `[${obs.id}] ${obs.content}`).join("\n\n")
      }
    ],
    { json: true }
  );
  const parsed = JSON.parse(content || "{}") as ExtractedGraph;
  const supabase = getSupabaseAdmin();
  const entityIds = new Map<string, string>();
  for (const entity of parsed.entities ?? []) {
    if (!entity.name || !entity.type) continue;
    const { data } = await supabase
      .from("entities")
      .insert({
        user_id: userId,
        canonical_name: entity.name,
        entity_type: entity.type,
        aliases: entity.aliases ?? [],
        confidence: entity.confidence ?? null
      })
      .select("*")
      .single();
    if (data) entityIds.set(entity.name.toLowerCase(), data.id);
  }
  for (const obs of eligible) {
    for (const entity of parsed.entities ?? []) {
      const id = entityIds.get(entity.name.toLowerCase());
      if (id && obs.content.toLowerCase().includes(entity.name.toLowerCase())) {
        await supabase.from("observation_entities").upsert({
          observation_id: obs.id,
          entity_id: id,
          role: "mentioned",
          confidence: entity.confidence ?? null
        });
      }
    }
  }
  for (const rel of parsed.relationships ?? []) {
    const sourceObs = eligible.find((obs) => obs.content.toLowerCase().includes(rel.source.toLowerCase()));
    const targetObs = eligible.find((obs) => obs.content.toLowerCase().includes(rel.target.toLowerCase()));
    if (sourceObs && targetObs && sourceObs.id !== targetObs.id) {
      await supabase.from("evidence_relationships").insert({
        source_observation_id: sourceObs.id,
        target_observation_id: targetObs.id,
        relationship_type: rel.type,
        confidence: rel.confidence ?? null,
        evidence: rel.evidence ?? null
      });
    }
  }
}

async function createTemporalRelationships(observations: InsertedObservation[]) {
  const supabase = getSupabaseAdmin();
  const timed = observations.filter((obs) => obs.timestamp_start !== null || obs.frame_timestamp !== null);
  for (const source of timed) {
    const sourceTime = source.timestamp_start ?? source.frame_timestamp ?? 0;
    for (const target of timed) {
      if (source.id === target.id || source.file_id !== target.file_id) continue;
      const targetTime = target.timestamp_start ?? target.frame_timestamp ?? 0;
      if (Math.abs(sourceTime - targetTime) <= 8) {
        await supabase.from("evidence_relationships").insert({
          source_observation_id: source.id,
          target_observation_id: target.id,
          relationship_type: "TEMPORALLY_RELATED",
          confidence: 0.65,
          evidence: "Observed within the configured temporal window."
        });
      }
    }
  }
}

function normalizeIdentityState(value: string) {
  if (value === "IDENTIFIED") return "IDENTIFIED";
  if (value === "CONFLICTING") return "CONFLICTING";
  if (value === "UNKNOWN") return "UNKNOWN";
  return "DIARIZED_ONLY";
}
