import { z } from "zod";
import { createOllamaChat } from "../ollama";
import { formatError } from "../errors";
import { getSupabaseAdmin } from "../supabase";
import { embedQuery } from "./embed";

export const querySchema = z.object({
  question: z.string().min(3),
  userId: z.string().min(1).default("anonymous")
});

type EvidenceRow = {
  id: string;
  file_id: string;
  original_filename: string;
  modality: string;
  kind: string;
  content: string;
  page_number: number | null;
  timestamp_start: number | null;
  timestamp_end: number | null;
  frame_timestamp: number | null;
  bounding_box: unknown;
  artifact_path: string | null;
  confidence: number | null;
  score: number;
};

export async function answerQuestion(question: string, userId: string) {
  const supabase = getSupabaseAdmin();
  const evidence: EvidenceRow[] = [];

  try {
    const embedding = await embedQuery(question);
    const { data, error } = await supabase.rpc("match_observations", {
      query_embedding: embedding,
      match_count: 12,
      user_id_filter: userId
    });
    if (error) throw error;
    evidence.push(...(data ?? []));
  } catch (error) {
    console.warn(`Vector retrieval skipped: ${friendlyError(error)}`);
  }

  const { data: keywordData, error: keywordError } = await supabase.rpc("keyword_observations", {
    query_text: question,
    match_count: 12,
    user_id_filter: userId
  });
  if (keywordError) throw keywordError;
  evidence.push(...(keywordData ?? []));

  const expanded = await expandEvidence(dedupeEvidence(evidence).slice(0, 16));
  const promptEvidence = expanded
    .map((row, index) => citationLabel(row, index))
    .join("\n\n");
  try {
    const answer = await createOllamaChat([
      {
        role: "system",
        content:
          "You answer only from supplied evidence. Cite every factual sentence with [E#]. If speaker identity is diarized-only, unknown, or conflicting, say that explicitly. Do not infer names or hidden content. End with a Claim verification section listing SUPPORTED, PARTIAL, CONFLICTING, or UNSUPPORTED."
      },
      {
        role: "user",
        content: `Question: ${question}\n\nEvidence:\n${promptEvidence}`
      }
    ]);
    return {
      answer: answer || retrievalOnlyAnswer(question, expanded, "Ollama returned an empty answer."),
      citations: expanded,
      claims: extractClaimStatuses(answer)
    };
  } catch (error) {
    return {
      answer: retrievalOnlyAnswer(question, expanded, friendlyError(error)),
      citations: expanded,
      claims: []
    };
  }
}

async function expandEvidence(seed: EvidenceRow[]) {
  if (seed.length === 0) return seed;
  const supabase = getSupabaseAdmin();
  const ids = seed.map((row) => row.id);
  const { data, error } = await supabase.rpc("expand_related_observations", {
    seed_ids: ids,
    temporal_window_seconds: 8
  });
  if (error) throw error;
  return dedupeEvidence([...seed, ...((data ?? []) as EvidenceRow[])]).slice(0, 24);
}

function dedupeEvidence(rows: EvidenceRow[]) {
  const map = new Map<string, EvidenceRow>();
  for (const row of rows) {
    const existing = map.get(row.id);
    if (!existing || row.score > existing.score) map.set(row.id, row);
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

function citationLabel(row: EvidenceRow, index: number) {
  const loc = [
    row.page_number ? `page ${row.page_number}` : null,
    row.timestamp_start !== null ? `${row.timestamp_start.toFixed(3)}s-${row.timestamp_end?.toFixed(3) ?? "?"}s` : null,
    row.frame_timestamp !== null ? `frame ${row.frame_timestamp.toFixed(3)}s` : null
  ]
    .filter(Boolean)
    .join(", ");
  return `[E${index + 1}] file=${row.original_filename}; modality=${row.modality}; kind=${row.kind}; location=${loc || "file-level"}; confidence=${row.confidence ?? "unknown"}\n${row.content}`;
}

function extractClaimStatuses(text: string) {
  return text
    .split("\n")
    .filter((line) => /\b(SUPPORTED|PARTIAL|CONFLICTING|UNSUPPORTED)\b/.test(line))
    .slice(0, 20);
}

function retrievalOnlyAnswer(question: string, evidence: EvidenceRow[], reason: string) {
  if (evidence.length === 0) {
    return `${reason}\n\nNo matching evidence was found for: ${question}`;
  }
  const lines = evidence.slice(0, 8).map((row, index) => {
    const location = [
      row.page_number ? `page ${row.page_number}` : null,
      row.timestamp_start !== null ? `${row.timestamp_start.toFixed(3)}s` : null,
      row.frame_timestamp !== null ? `frame ${row.frame_timestamp.toFixed(3)}s` : null
    ]
      .filter(Boolean)
      .join(", ") || "file-level";
    return `[E${index + 1}] ${row.original_filename} (${row.kind}, ${location}): ${row.content.slice(0, 360)}`;
  });
  return `${reason}\n\nTop retrieved evidence for: ${question}\n\n${lines.join("\n\n")}`;
}

function friendlyError(error: unknown) {
  const message = formatError(error);
  if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
    return "Ollama is not running. Start it with: ollama serve";
  }
  return message;
}
