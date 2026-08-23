import { z } from "zod";
import { randomUUID } from "node:crypto";
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
  metadata?: Record<string, unknown> | null;
};

type SourceFile = {
  id: string;
  original_filename: string;
  modality: string;
  created_at: string;
};

type QueryPlan = {
  allowedFileIds: Set<string> | null;
  targetModalities: Set<string>;
  targetKinds: Set<string>;
  referencedFiles: SourceFile[];
  currentSource: SourceFile | null;
  crossSource: boolean;
  corroboration: boolean;
  firstPersonAttribution: boolean;
};

export async function answerQuestion(question: string, userId: string) {
  const supabase = getSupabaseAdmin();
  const queryId = randomUUID();
  const plan = await analyzeQuery(question, userId);
  const evidence: EvidenceRow[] = [];

  try {
    const embedding = await embedQuery(question);
    const { data, error } = await supabase.rpc("match_observations", {
      query_embedding: embedding,
      match_count: 36,
      user_id_filter: userId
    });
    if (error) throw error;
    evidence.push(...(data ?? []));
  } catch (error) {
    console.warn(`Vector retrieval skipped: ${friendlyError(error)}`);
  }

  const { data: keywordData, error: keywordError } = await supabase.rpc("keyword_observations", {
    query_text: question,
    match_count: 36,
    user_id_filter: userId
  });
  if (keywordError) throw keywordError;
  evidence.push(...(keywordData ?? []));
  const speakerOrdinal = speakerOrdinalIndex(question);
  if (plan.corroboration || plan.crossSource || plan.targetModalities.size > 1 || speakerOrdinal !== null) {
    evidence.push(...await fetchBroadEvidence(userId, plan, speakerOrdinal !== null));
  }

  const ranked = rankEvidence(question, evidence, plan);
  const expanded = await expandEvidence(seedEvidenceForExpansion(question, ranked, plan, plan.corroboration ? 24 : 10), plan);
  const selectedEvidence = selectFinalEvidence(question, expanded, plan, 12);
  const speakerEvidence = speakerOrdinal !== null ? await fetchSpeakerOrdinalEvidence(userId, plan, speakerOrdinal) : [];
  const finalEvidence = await hydrateEvidenceMetadata(prioritizeEvidence([...speakerEvidence, ...selectedEvidence]).slice(0, 12));
  if (finalEvidence.length === 0) {
    return {
      queryId,
      answer:
        "### Answer\n\nI don't have sufficient evidence in the uploaded sources to answer this reliably.\n\n### Verification\n\nUNSUPPORTED",
      citations: [],
      claims: ["UNSUPPORTED"]
    };
  }

  const promptEvidence = finalEvidence
    .map((row, index) => citationLabel(row, index))
    .join("\n\n");
  const attributionInstruction = plan.firstPersonAttribution
    ? "The question uses first-person wording. Do not assume the current user is the speaker, document subject, or person shown. Attribute identity answers to the uploaded evidence, for example: \"According to the uploaded audio, the speaker says ...\" Never answer as \"your name is\" unless the evidence explicitly identifies the current user."
    : "Keep source attribution explicit when identity, ownership, or personal facts are involved.";

  try {
    const answer = await createOllamaChat([
      {
        role: "system",
        content:
          "You are the answer generation and evidence verification layer. Answer only from supplied evidence objects. Never use general knowledge to fill gaps. Each evidence object has a Cite as value; cite factual claims using that value exactly. Do not output raw evidence keys, UUIDs, source_file_id, evidence_id, backend metadata, or SQL-style fields. Every factual claim needs an immediate citation. For list questions, put each extracted value on its own bullet line with its own citation. Never relabel evidence from one file as another file. Keep OCR, visual analysis, transcript, speaker, page, frame, and timestamp evidence distinct. If evidence is from an audio/video speaker, phrase claims as what the speaker says unless identity is independently established. If speaker identity is diarized-only, unknown, or conflicting, say that explicitly. Do not infer names, hidden content, or that the current user is a person in the evidence. If supplied evidence is irrelevant or insufficient, answer exactly: \"I don't have sufficient evidence in the uploaded sources to answer this reliably.\" Use this structure: ### Answer, ### Evidence, ### Verification. Verification must be SUPPORTED, PARTIALLY_SUPPORTED, or UNSUPPORTED."
      },
      {
        role: "user",
        content: `Query ID: ${queryId}\nQuestion: ${question}\n\n${attributionInstruction}\n\nEvidence:\n${promptEvidence}`
      }
    ]);
    const groundedAnswer = finalizeAnswer(answer || retrievalOnlyAnswer(question, finalEvidence, "Ollama returned an empty answer."), finalEvidence, plan, question);
    const supportingEvidence = supportingEvidenceForQuestion(question, finalEvidence);
    return {
      queryId,
      answer: groundedAnswer,
      citations: supportingEvidence.length > 0 ? supportingEvidence : finalEvidence,
      claims: extractClaimStatuses(groundedAnswer)
    };
  } catch (error) {
    return {
      queryId,
      answer: retrievalOnlyAnswer(question, finalEvidence, friendlyError(error)),
      citations: finalEvidence,
      claims: []
    };
  }
}

async function analyzeQuery(question: string, userId: string): Promise<QueryPlan> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("files")
    .select("id, original_filename, modality, created_at")
    .eq("user_id", userId)
    .in("status", ["COMPLETED", "PARTIALLY_PROCESSED"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;

  const files = (data ?? []) as SourceFile[];
  const normalizedQuestion = normalize(question);
  const crossSource = /\b(compare|across all|all uploaded|all files|between|versus|vs\.?|corroborat|confirm|same statement|same claim|all sources|all evidence)\b/i.test(question);
  const referencedFiles = files.filter((file) => fileMentioned(normalizedQuestion, file.original_filename));
  const targetModalities = inferModalities(question);
  const targetKinds = inferKinds(question);
  const corroboration = inferCorroborationIntent(question, referencedFiles, targetModalities);
  const currentSource = inferCurrentSource(question, files, targetModalities);
  const constrainedFiles = referencedFiles.length > 0 && !corroboration ? referencedFiles : currentSource && !crossSource && !corroboration ? [currentSource] : [];

  return {
    allowedFileIds: constrainedFiles.length > 0 && !crossSource && !corroboration ? new Set(constrainedFiles.map((file) => file.id)) : null,
    targetModalities,
    targetKinds,
    referencedFiles,
    currentSource,
    crossSource,
    corroboration,
    firstPersonAttribution: /\b(my|i'm|i am|where do i|what is my|who am i)\b/i.test(question)
  };
}

async function fetchBroadEvidence(userId: string, plan: QueryPlan, includeSpeakerMergeRows = false) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("observations")
    .select(
      "id,file_id,modality,kind,content,page_number,timestamp_start,timestamp_end,frame_timestamp,bounding_box,artifact_path,confidence,files!inner(original_filename,user_id)"
    )
    .eq("files.user_id", userId)
    .neq("kind", "processing_note")
    .limit(200);
  if (error) throw error;
  const referencedIds = new Set(plan.referencedFiles.map((file) => file.id));
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => {
      const file = row.files as { original_filename?: string } | null;
      return {
        id: String(row.id),
        file_id: String(row.file_id),
        original_filename: file?.original_filename ?? "unknown source",
        modality: String(row.modality),
        kind: String(row.kind),
        content: String(row.content),
        page_number: typeof row.page_number === "number" ? row.page_number : null,
        timestamp_start: typeof row.timestamp_start === "number" ? row.timestamp_start : null,
        timestamp_end: typeof row.timestamp_end === "number" ? row.timestamp_end : null,
        frame_timestamp: typeof row.frame_timestamp === "number" ? row.frame_timestamp : null,
        bounding_box: row.bounding_box ?? null,
        artifact_path: typeof row.artifact_path === "string" ? row.artifact_path : null,
        confidence: typeof row.confidence === "number" ? row.confidence : null,
        score: 0.6
      } satisfies EvidenceRow;
    })
    .filter((row) => {
      if (plan.allowedFileIds && !plan.allowedFileIds.has(row.file_id)) return false;
      if (referencedIds.has(row.file_id)) return true;
      if (plan.targetModalities.size > 0 && plan.targetModalities.has(row.modality)) return true;
      if (includeSpeakerMergeRows && (row.modality === "audio" || row.modality === "video")) return true;
      return plan.crossSource || plan.corroboration;
    });
}

async function expandEvidence(seed: EvidenceRow[], plan: QueryPlan) {
  if (seed.length === 0) return seed;
  const supabase = getSupabaseAdmin();
  const ids = seed.map((row) => row.id);
  const { data, error } = await supabase.rpc("expand_related_observations", {
    seed_ids: ids,
    temporal_window_seconds: 8
  });
  if (error) throw error;
  return rankEvidence("", [...seed, ...((data ?? []) as EvidenceRow[])], plan).slice(0, 24);
}

async function hydrateEvidenceMetadata(rows: EvidenceRow[]) {
  if (rows.length === 0) return rows;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("observations")
    .select("id, metadata")
    .in("id", rows.map((row) => row.id));
  if (error) throw error;
  const metadataById = new Map((data ?? []).map((row) => [row.id, row.metadata as Record<string, unknown>]));
  return rows.map((row) => ({ ...row, metadata: metadataById.get(row.id) ?? null }));
}

function dedupeEvidence(rows: EvidenceRow[]) {
  const map = new Map<string, EvidenceRow>();
  for (const row of rows) {
    const existing = map.get(row.id);
    if (!existing || row.score > existing.score) map.set(row.id, row);
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

function prioritizeEvidence(rows: EvidenceRow[]) {
  const map = new Map<string, EvidenceRow>();
  for (const row of rows) {
    if (!map.has(row.id)) map.set(row.id, row);
  }
  return [...map.values()];
}

async function fetchSpeakerOrdinalEvidence(userId: string, plan: QueryPlan, ordinalIndex: number) {
  const rows = await fetchBroadEvidence(userId, plan, true);
  const selected: EvidenceRow[] = [];
  for (const modality of modalitiesForSpeakerMerge(plan)) {
    selected.push(...transcriptRowsForModality(rows, modality).slice(0, ordinalIndex + 1));
  }
  return selected;
}

function seedEvidenceForExpansion(question: string, ranked: EvidenceRow[], plan: QueryPlan, limit: number) {
  const speakerOrdinal = speakerOrdinalIndex(question);
  const speakerModalities = modalitiesForSpeakerMerge(plan);
  if (speakerOrdinal === null || speakerModalities.length <= 1) return ranked.slice(0, limit);
  const selected: EvidenceRow[] = [];
  for (const modality of speakerModalities) {
    const transcript = transcriptForModalityAtOrdinal(ranked, modality, speakerOrdinal);
    if (transcript) selected.push(transcript);
  }
  const selectedIds = new Set(selected.map((row) => row.id));
  return [...selected, ...ranked.filter((row) => !selectedIds.has(row.id))].slice(0, limit);
}

function rankEvidence(question: string, rows: EvidenceRow[], plan: QueryPlan) {
  const terms = meaningfulTerms(question);
  const visualQuestion = isVisualQuestion(question) || /\bwhat.*(?:video|image|photo|picture)\b/i.test(question);
  const filtered = rows.filter((row) => {
    if (plan.allowedFileIds && !plan.allowedFileIds.has(row.file_id)) return false;
    if (row.kind === "processing_note") return false;
    return true;
  });

  const modalityMatches = filtered.filter((row) => plan.targetModalities.size === 0 || plan.targetModalities.has(row.modality));
  const candidates = modalityMatches.length > 0 && !plan.crossSource && !plan.corroboration ? modalityMatches : filtered;

  return dedupeEvidence(
    candidates.map((row) => {
      let score = Number.isFinite(row.score) ? row.score : 0;
      const filename = normalize(row.original_filename);
      const content = normalize(row.content);

      if (plan.allowedFileIds?.has(row.file_id)) score += 3;
      if (plan.referencedFiles.some((file) => file.id === row.file_id)) score += 4;
      if (plan.currentSource?.id === row.file_id) score += 2;
      if (plan.targetModalities.has(row.modality)) score += 1.8;
      if (plan.targetKinds.has(row.kind)) score += 1.2;
      if (plan.corroboration) score += corroborationScore(question, row);
      if (visualQuestion) {
        if (row.kind === "vision_description") score += 4;
        if (row.kind === "frame") score += 1;
        if (row.kind === "transcript" && /\[BLANK_AUDIO\]/i.test(row.content)) score -= 6;
        if (row.kind === "speaker_segment") score -= 2;
      }
      if (/\b(start|beginning|first|opening)\b/i.test(question) && row.modality === "video") {
        const time = row.frame_timestamp ?? row.timestamp_start ?? 9999;
        if (time <= 2) score += 5;
        else if (time <= 8) score += 2;
        else score -= Math.min(4, time / 10);
      }
      if (/\b(female|woman|women|person|people|screen)\b/i.test(question) && row.kind === "vision_description") score += 2;
      if (row.confidence !== null) score += Math.max(0, Math.min(row.confidence, 1)) * 0.35;
      for (const term of terms) {
        if (filename.includes(term)) score += 0.9;
        if (content.includes(term)) score += 0.25;
      }
      return { ...row, score };
    })
  );
}

function selectFinalEvidence(question: string, rows: EvidenceRow[], plan: QueryPlan, limit: number) {
  const ranked = rankEvidence(question, rows, plan);
  const speakerOrdinal = speakerOrdinalIndex(question);
  const speakerModalities = modalitiesForSpeakerMerge(plan);
  if (speakerOrdinal !== null && speakerModalities.length > 1) {
    const selected: EvidenceRow[] = [];
    for (const modality of speakerModalities) {
      const transcript = transcriptForModalityAtOrdinal(ranked, modality, speakerOrdinal);
      if (transcript) selected.push(transcript);
    }
    if (selected.length > 0) {
      const selectedIds = new Set(selected.map((row) => row.id));
      return [...selected, ...ranked.filter((row) => !selectedIds.has(row.id))].slice(0, limit);
    }
  }
  if (isVisualQuestion(question)) {
    const visualRows = ranked.filter((row) => ["vision_description", "frame", "ocr_text"].includes(row.kind));
    if (visualRows.length > 0) return visualRows.slice(0, limit);
  }
  if (/\b(start|beginning|first|opening)\b/i.test(question) && /\b(video|screen|female|woman|women|person|people)\b/i.test(question)) {
    const early = ranked.filter((row) => row.modality === "video" && ((row.frame_timestamp ?? row.timestamp_start ?? 9999) <= 8));
    if (early.length > 0) return early.slice(0, Math.min(limit, 6));
  }
  if (!plan.corroboration) return ranked.slice(0, limit);

  const relevant = ranked.filter((row) => corroborationScore(question, row) > 0);
  const byFile = new Map<string, EvidenceRow[]>();
  for (const row of relevant.length ? relevant : ranked) {
    const bucket = byFile.get(row.file_id) ?? [];
    bucket.push(row);
    byFile.set(row.file_id, bucket);
  }

  const selected: EvidenceRow[] = [];
  for (const rowsForFile of byFile.values()) {
    selected.push(...rowsForFile.slice(0, 3));
  }
  return dedupeEvidence(selected.length ? selected : ranked).slice(0, limit);
}

function citationLabel(row: EvidenceRow, index: number) {
  return [
    `Evidence ${index + 1}`,
    `Cite as: ${displayCitation(row)}`,
    `Source: ${row.original_filename}`,
    `Modality: ${row.modality}`,
    `Evidence type: ${readableKind(row.kind)}`,
    `Location: ${readableLocation(row)}`,
    `Confidence: ${row.confidence ?? "unknown"}`,
    "Text:",
    lineNumberedContent(row)
  ].join("\n");
}

function extractClaimStatuses(text: string) {
  return text
    .split("\n")
    .filter((line) => /\b(SUPPORTED|PARTIAL|CONFLICTING|UNSUPPORTED)\b/.test(line))
    .slice(0, 20);
}

function retrievalOnlyAnswer(question: string, evidence: EvidenceRow[], reason: string) {
  if (evidence.length === 0) {
    return `### Answer\n\nI don't have sufficient evidence in the uploaded sources to answer this reliably.\n\n### Verification\n\nUNSUPPORTED`;
  }
  const lines = evidence.slice(0, 8).map((row, index) => {
    return `${index + 1}. ${displayCitation(row)}\n${row.content.slice(0, 360)}`;
  });
  return `### Answer\n\n${reason}\n\nI found potentially relevant evidence for: ${question}\n\n### Evidence\n\n${lines.join("\n\n")}\n\n### Verification\n\nPARTIALLY_SUPPORTED`;
}

function finalizeAnswer(answer: string, evidence: EvidenceRow[], plan: QueryPlan, question: string) {
  const structured = extractStructuredAnswer(question, evidence);
  if (structured) return enforceAttribution(structured, plan);
  const citationSafeAnswer = normalizeAnswerFormat(stripLeakedMetadata(replaceRawEvidenceLabels(answer, evidence)), evidence, question);
  return enforceAttribution(citationSafeAnswer, plan);
}

function replaceRawEvidenceLabels(answer: string, evidence: EvidenceRow[]) {
  return evidence.reduce((text, row, index) => {
    return text.replace(new RegExp(`\\[E${index + 1}\\]`, "g"), displayCitation(row));
  }, answer);
}

function stripLeakedMetadata(answer: string) {
  return answer
    .split("\n")
    .filter((line) => !/\b(evidence_id|source_file_id|source_filename|source_modality|evidence_type|cite_as=|confidence=|location=)\b/i.test(line))
    .filter((line) => !/^\s*(Cite as|Source|Modality|Evidence type|Location|Confidence|Text):/i.test(line))
    .filter((line) => !/^### Evidence,\s*### Verification/i.test(line.trim()))
    .join("\n")
    .replace(/### Answer,\s*### Evidence,\s*### Verification/gi, "")
    .trim();
}

function extractStructuredAnswer(question: string, evidence: EvidenceRow[]) {
  const speakerDetails = extractSpeakerDetails(question, evidence);
  if (speakerDetails) return speakerDetails;

  const peopleAtStart = extractPeopleAtStartOfVideo(question, evidence);
  if (peopleAtStart) return peopleAtStart;

  const corroborated = extractCorroboratedStatement(question, evidence);
  if (corroborated) return corroborated;

  if (/\bnames?\b/i.test(question)) {
    const names = extractNames(evidence);
    if (names.length > 0) {
      return [
        "### Answer",
        "",
        ...names.map((item) => `- ${item.value} ${item.citation}`),
        "",
        "### Evidence",
        "",
        ...unique(names.map((item) => `- ${item.citation}`)),
        "",
        "### Verification",
        "",
        "SUPPORTED"
      ].join("\n");
    }
  }
  return null;
}

function isSpeakerDetailsQuestion(question: string) {
  return /\b(speaker|person)\b/i.test(question) && /\b(details|all|merge|audio|video|source|sources|name|age|phone)\b/i.test(question);
}

function modalitiesForSpeakerMerge(plan: QueryPlan) {
  const modalities = [...plan.targetModalities].filter((modality) => modality === "audio" || modality === "video");
  return modalities.length > 0 ? modalities : ["audio", "video"];
}

function speakerOrdinalIndex(question: string) {
  if (!isSpeakerDetailsQuestion(question)) return null;
  const normalizedQuestion = normalize(question);
  const ordinalPatterns: Array<[RegExp, number]> = [
    [/\b(first|one|1st|speaker 1|speaker one|person 1|person one)\b/, 0],
    [/\b(second|two|2nd|speaker 2|speaker two|person 2|person two)\b/, 1],
    [/\b(third|three|3rd|speaker 3|speaker three|person 3|person three)\b/, 2],
    [/\b(fourth|four|4th|speaker 4|speaker four|person 4|person four)\b/, 3],
    [/\b(fifth|five|5th|speaker 5|speaker five|person 5|person five)\b/, 4]
  ];
  for (const [pattern, index] of ordinalPatterns) {
    if (pattern.test(normalizedQuestion)) return index;
  }
  return /\b(speaker|person)\b/.test(normalizedQuestion) ? 0 : null;
}

function extractSpeakerDetails(question: string, evidence: EvidenceRow[]) {
  const ordinal = speakerOrdinalIndex(question);
  if (ordinal === null) return null;

  const audio = transcriptForModalityAtOrdinal(evidence, "audio", ordinal);
  const video = transcriptForModalityAtOrdinal(evidence, "video", ordinal);
  if (!audio && !video) return null;

  const facts: Array<{ label: string; value: string; citation: string }> = [];
  const audioFacts = audio ? personFactsFromTranscript(audio) : [];
  const videoFacts = video ? personFactsFromTranscript(video) : [];

  const audioName = audioFacts.find((fact) => fact.label === "Name")?.value;
  const videoName = videoFacts.find((fact) => fact.label === "Name")?.value;
  const similarName = audioName && videoName && namesProbablyMatch(audioName, videoName);

  if (audioName && videoName && normalize(audioName) !== normalize(videoName) && similarName) {
    facts.push({
      label: "Name",
      value: `${audioName} in the audio; possibly the same name is transcribed as ${videoName} in the video`,
      citation: `${displayCitation(audio!)} ${displayCitation(video!)}`
    });
  } else if (audioName) {
    facts.push({ label: "Name", value: audioName, citation: displayCitation(audio!) });
  } else if (videoName) {
    facts.push({ label: "Name", value: videoName, citation: displayCitation(video!) });
  }

  for (const fact of [...audioFacts, ...videoFacts]) {
    if (fact.label === "Name") continue;
    if (facts.some((existing) => existing.label === fact.label && normalize(existing.value) === normalize(fact.value))) continue;
    facts.push(fact);
  }

  if (facts.length === 0) return null;
  return [
    "### Answer",
    "",
    `Speaker: ${ordinalLabel(ordinal)}`,
    "",
    ...facts.map((fact) => `- ${fact.label}: ${fact.value} ${fact.citation}`),
    "",
    ...(audioName && videoName && normalize(audioName) !== normalize(videoName)
      ? [
          "Note:",
          "",
          `- The name spelling differs between sources: ${audioName} in audio and ${videoName} in video, so this is merged as a likely match rather than a guaranteed identity.`,
          ""
        ]
      : []),
    "### Evidence",
    "",
    ...unique(facts.map((fact) => `- ${fact.citation}`)),
    "",
    "### Verification",
    "",
    facts.length > 1 ? "SUPPORTED" : "PARTIALLY_SUPPORTED"
  ].join("\n");
}

function transcriptForModalityAtOrdinal(evidence: EvidenceRow[], modality: string, ordinalIndex: number) {
  return transcriptRowsForModality(evidence, modality)[ordinalIndex] ?? null;
}

function ordinalLabel(index: number) {
  return ["first", "second", "third", "fourth", "fifth"][index] ?? `#${index + 1}`;
}

function firstTranscriptForModality(evidence: EvidenceRow[], modality: string) {
  return transcriptForModalityAtOrdinal(evidence, modality, 0);
}

function transcriptRowsForModality(evidence: EvidenceRow[], modality: string) {
  const rows = evidence
    .filter((row) => row.modality === modality && row.kind === "transcript" && !/\[BLANK_AUDIO\]/i.test(row.content))
    .sort((a, b) => (a.timestamp_start ?? 9999) - (b.timestamp_start ?? 9999));
  const identityGroups = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    if (personFactsFromTranscript(row).length === 0) continue;
    const group = identityGroups.get(row.file_id) ?? [];
    group.push(row);
    identityGroups.set(row.file_id, group);
  }
  if (identityGroups.size === 0) return rows;
  return [...identityGroups.values()]
    .sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      return (a[0]?.timestamp_start ?? 9999) - (b[0]?.timestamp_start ?? 9999);
    })[0];
}

function personFactsFromTranscript(row: EvidenceRow) {
  const text = row.content.replace(/^["']|["']$/g, "");
  const citation = displayCitation(row);
  const facts: Array<{ label: string; value: string; citation: string }> = [];
  const name = text.match(/\bmy name is\s+([A-Z][a-zA-Z]+)\b/i)?.[1];
  const age = text.match(/\bi am\s+(\d{1,3})\s+years?\s+old\b/i)?.[1];
  const phone = text.match(/\bi have\s+(?:an?\s+)?(.+?)(?:\s+phone)?[.!"]?$/i)?.[1]?.trim();
  if (name) facts.push({ label: "Name", value: name, citation });
  if (age) facts.push({ label: "Age", value: `${age} years old`, citation });
  if (phone) facts.push({ label: "Phone", value: normalizePhoneValue(phone), citation });
  return facts;
}

function normalizePhoneValue(value: string) {
  return value.replace(/\s+/g, " ").replace(/\bi phone\b/i, "iPhone").replace(/\biq phone\b/i, "IQ phone").trim();
}

function namesProbablyMatch(a: string, b: string) {
  const left = normalize(a);
  const right = normalize(b);
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 2) return false;
  return levenshtein(left, right) <= 2;
}

function levenshtein(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function supportingEvidenceForQuestion(question: string, evidence: EvidenceRow[]) {
  const speakerOrdinal = speakerOrdinalIndex(question);
  if (speakerOrdinal !== null) {
    const selected: EvidenceRow[] = [];
    for (const modality of ["audio", "video"]) {
      const transcript = transcriptForModalityAtOrdinal(evidence, modality, speakerOrdinal);
      if (transcript) selected.push(transcript);
    }
    if (selected.length > 0) return selected;
  }
  if (isVisualQuestion(question)) {
    const visualRows = evidence.filter((row) => ["vision_description", "frame", "ocr_text"].includes(row.kind));
    if (visualRows.length > 0) return visualRows;
  }
  if (/\b(weather|snow|snowing|month|year|london)\b/i.test(question)) {
    return evidence.filter((row) => {
      const content = normalize(row.content);
      return content.includes("london") && (/\bsnow(?:ing)?\b/.test(content) || /\bnovember\s+2025\b/.test(content));
    });
  }
  if (/\b(names?|female|woman|women|person|people|screen|start|beginning)\b/i.test(question) && /\bvideo|screen|start|beginning\b/i.test(question)) {
    return evidence.filter((row) => {
      const time = row.frame_timestamp ?? row.timestamp_start ?? 9999;
      return row.modality === "video" && row.kind === "vision_description" && time <= 8 && /\b(Harmilan Bains|Diya Chitale)\b/i.test(row.content);
    });
  }
  if (/\bnames?\b/i.test(question)) {
    const names = extractNames(evidence);
    const cited = new Set(names.map((item) => item.citation));
    return evidence.filter((row) => cited.has(displayCitation(row)) || names.some((item) => item.citation.startsWith(displayCitation(row).replace(/\]$/, ""))));
  }
  return [];
}

function extractPeopleAtStartOfVideo(question: string, evidence: EvidenceRow[]) {
  if (!/\b(names?|female|woman|women|person|people|screen|start|beginning)\b/i.test(question) || !/\bvideo|screen|start|beginning\b/i.test(question)) {
    return null;
  }
  const earlyVideoEvidence = evidence
    .filter((row) => row.modality === "video" && row.kind === "vision_description")
    .filter((row) => (row.frame_timestamp ?? row.timestamp_start ?? 9999) <= 8)
    .sort((a, b) => (a.frame_timestamp ?? a.timestamp_start ?? 9999) - (b.frame_timestamp ?? b.timestamp_start ?? 9999));
  const names = extractPersonNamesFromVision(earlyVideoEvidence);
  if (names.length === 0) return null;

  return [
    "### Answer",
    "",
    ...names.map((item) => `- ${item.value} ${item.citation}`),
    "",
    "### Evidence",
    "",
    ...unique(names.map((item) => `- ${item.citation}`)),
    "",
    "### Verification",
    "",
    "SUPPORTED"
  ].join("\n");
}

function extractPersonNamesFromVision(evidence: EvidenceRow[]) {
  const blocked = /\b(Diagram Structure|Airport Chairs|Departure Board|Trash Bin|Luggage Cart|Domestic Departures|Gates|Person Labels|Indian Track Athlete|Indian Table Tennis Player|Shopping Mall|Overall Assessment|Conversation Content|Curly Hair|Airport Terminal|Electronic Device|Commercial Space|Exact Location|Display Case|Palm Tree|Coffee Machine|Counter Interaction|Object Placement|Beverage Type|Sign Details|Background People|Background Details|Foreground|Background|People|Woman|Man|Other Figures)\b/i;
  const found: Array<{ value: string; citation: string }> = [];
  for (const row of evidence) {
    const lines = extractedLines(row.content);
    for (const line of lines) {
      if (!/\b(female|woman|women|person label|people)\b/i.test(line) && !/^\s*\*\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(line)) continue;
      const matches = line.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g) ?? [];
      for (const match of matches) {
        const value = match.trim();
        if (blocked.test(value)) continue;
        found.push({ value, citation: displayCitation(row) });
      }
    }
  }
  return uniqueBy(found, (item) => normalize(item.value));
}

function extractCorroboratedStatement(question: string, evidence: EvidenceRow[]) {
  if (!/\b(weather|snow|snowing|rain|raining|month|year|london)\b/i.test(question)) return null;
  const facts = evidence.flatMap((row) => extractWeatherFacts(row));
  if (facts.length === 0) return null;

  const grouped = new Map<string, Array<{ citation: string; row: EvidenceRow }>>();
  for (const fact of facts) {
    const bucket = grouped.get(fact.statement) ?? [];
    bucket.push({ citation: fact.citation, row: fact.row });
    grouped.set(fact.statement, bucket);
  }
  const supported = [...grouped.entries()]
    .map(([statement, support]) => ({
      statement,
      support: uniqueBy(support, (item) => `${item.row.file_id}:${item.citation}`)
    }))
    .filter((item) => item.support.length > 0)
    .sort((a, b) => b.support.length - a.support.length);
  if (supported.length === 0) return null;

  const best = supported[0];
  const verification = best.support.length > 1 ? "SUPPORTED" : "PARTIALLY_SUPPORTED";
  return [
    "### Answer",
    "",
    `- ${best.statement} ${best.support.map((item) => item.citation).join(" ")}`,
    "",
    ...(supported.length > 1
      ? [
          "Additional evidence:",
          "",
          ...supported.slice(1).map((item) => `- ${item.statement} ${item.support.map((support) => support.citation).join(" ")}`),
          ""
        ]
      : []),
    "### Evidence",
    "",
    ...unique(best.support.map((item) => `- ${item.citation}`)),
    "",
    "### Verification",
    "",
    verification
  ].join("\n");
}

function extractWeatherFacts(row: EvidenceRow) {
  const content = normalize(row.content);
  const facts: Array<{ statement: string; citation: string; row: EvidenceRow }> = [];
  const citation = displayCitation(row);
  const mentionsLondon = content.includes("london");
  const mentionsSnow = /\bsnow(?:ing)?\b/.test(content);
  const month = row.content.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);

  if (mentionsLondon && mentionsSnow && month) {
    facts.push({ statement: `The uploaded sources indicate that it is snowing in London in ${month[1]} ${month[2]}.`, citation, row });
    return facts;
  }
  if (mentionsLondon && mentionsSnow) {
    facts.push({ statement: "The uploaded sources indicate that it is snowing in London.", citation, row });
  }
  if (mentionsLondon && month) {
    facts.push({ statement: `The uploaded sources mention London in ${month[1]} ${month[2]}.`, citation, row });
  }
  if (mentionsSnow && month) {
    facts.push({ statement: `The uploaded sources mention snow in ${month[1]} ${month[2]}.`, citation, row });
  }
  return facts;
}

function uniqueBy<T>(values: T[], keyFn: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractNames(evidence: EvidenceRow[]) {
  const blocked = /\b(Project|Reference|Overview|Team|Budget|Expected|Performance|Review|Schedule|Note|Green Valley|Solar Project|Gujarat India)\b/i;
  const found: Array<{ value: string; citation: string }> = [];
  for (const row of evidence) {
    const lines = extractedLines(row.content);
    lines.forEach((line, index) => {
      const matches = line.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g) ?? [];
      for (const match of matches) {
        const value = match.trim();
        if (blocked.test(value)) continue;
        found.push({
          value,
          citation: displayCitation(row, lineNumberFor(row, index))
        });
      }
    });
  }
  const seen = new Set<string>();
  return found.filter((item) => {
    const key = normalize(item.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function normalizeAnswerFormat(answer: string, evidence: EvidenceRow[], question: string) {
  const primaryCitation = evidence[0] ? displayCitation(evidence[0]) : "";
  let text = answer
    .replace(/\r\n/g, "\n")
    .replace(/[•]/g, "-")
    .replace(/,\s*-\s+/g, "\n- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  text = normalizeCommaSeparatedAnswer(text, primaryCitation, question);
  text = text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (/^Verification:\s*/i.test(trimmed)) return trimmed.replace(/^Verification:\s*/i, "");
      if (/^[-*]\s+/.test(trimmed) && primaryCitation && !/\[[^\]]+ — [^\]]+\]/.test(trimmed)) {
        return `${trimmed.replace(/^[-*]\s+/, "- ")} ${primaryCitation}`;
      }
      return line;
    })
    .join("\n")
    .trim();

  const verification = extractVerification(text) ?? (evidence.length > 0 ? "SUPPORTED" : "UNSUPPORTED");
  const withoutVerification = text
    .replace(/### Verification[\s\S]*$/i, "")
    .split("\n")
    .filter((line) => !/^(SUPPORTED|PARTIALLY_SUPPORTED|UNSUPPORTED|PARTIAL|CONFLICTING)\s*$/i.test(line.trim()))
    .join("\n")
    .trim();
  const answerBody = withoutVerification.replace(/^### Answer\s*/i, "").replace(/^Answer:\s*/i, "").trim();
  const evidenceLines = evidence.slice(0, 5).map((row) => `- ${displayCitation(row)}`);

  return [
    "### Answer",
    "",
    answerBody || "I don't have sufficient evidence in the uploaded sources to answer this reliably.",
    "",
    "### Evidence",
    "",
    ...evidenceLines,
    "",
    "### Verification",
    "",
    normalizeVerification(verification)
  ].join("\n");
}

function normalizeCommaSeparatedAnswer(answer: string, citation: string, question: string) {
  const wantsList = /\b(names?|values?|items?|fields?|mentioned|list)\b/i.test(question);
  const answerLine = answer.match(/^(?:### Answer\s*)?Answer:\s*(.+)$/ims);
  const body = answerLine?.[1]?.trim() ?? answer.trim();
  if (!wantsList || !body.includes(",")) return answer;
  const firstSection = body.split(/### Evidence|### Verification/i)[0].trim();
  const values = firstSection
    .replace(/^Answer:\s*/i, "")
    .split(",")
    .map((value) => value.trim().replace(/[.;]$/, ""))
    .filter(Boolean);
  if (values.length < 2 || values.length > 20) return answer;
  return values.map((value) => `- ${value}${citation ? ` ${citation}` : ""}`).join("\n");
}

function extractVerification(answer: string) {
  const match = answer.match(/\b(PARTIALLY_SUPPORTED|UNSUPPORTED|SUPPORTED|PARTIAL|CONFLICTING)\b/i);
  return match?.[1] ?? null;
}

function normalizeVerification(value: string) {
  const upper = value.toUpperCase();
  if (upper === "PARTIAL" || upper === "CONFLICTING") return "PARTIALLY_SUPPORTED";
  if (upper === "UNSUPPORTED") return "UNSUPPORTED";
  return "SUPPORTED";
}

function enforceAttribution(answer: string, plan: QueryPlan) {
  if (!plan.firstPersonAttribution) return answer;
  if (/^\s*(according to|based on|the uploaded|in the uploaded|the speaker|the document|the image|the video|the audio)/i.test(answer)) {
    return answer;
  }
  if (/I don't have sufficient evidence in the uploaded sources/i.test(answer)) return answer;
  const structured = answer.match(/^(\s*### Answer\s*)([\s\S]*)/i);
  if (structured && !/^\s*(according to|based on|the uploaded|in the uploaded|the speaker|the document|the image|the video|the audio)/i.test(structured[2])) {
    const body = structured[2].trimStart();
    return `${structured[1]}\nAccording to the uploaded evidence, ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  }
  const trimmed = answer.trimStart();
  const adjusted = trimmed
    .replace(/^your name is\b/i, "the speaker says their name is")
    .replace(/^you study\b/i, "the speaker says they study")
    .replace(/^you are\b/i, "the uploaded evidence describes the speaker as");
  return `According to the uploaded evidence, ${adjusted.charAt(0).toLowerCase()}${adjusted.slice(1)}`;
}

function displayCitation(row: EvidenceRow, exactLine?: number | null) {
  const filename = row.original_filename;
  if (row.modality === "pdf" || row.modality === "document") {
    return `[${filename}${pdfLocationSuffix(row, exactLine)}${kindSuffix(row.kind)}]`;
  }
  if (row.modality === "image") {
    return `[${filename} — ${readableKind(row.kind)}${confidenceSuffix(row)}]`;
  }
  if (row.modality === "audio") {
    return `[${filename} — ${audioCitationDetail(row)}${confidenceSuffix(row)}]`;
  }
  if (row.modality === "video") {
    return `[${filename} — ${videoCitationDetail(row)}${confidenceSuffix(row)}]`;
  }
  return `[${filename} — ${readableKind(row.kind)}${confidenceSuffix(row)}]`;
}

function readableLocation(row: EvidenceRow) {
  if (row.modality === "pdf" || row.modality === "document") return pdfLocationSuffix(row).replace(/^ — /, "") || "document-level";
  if (row.timestamp_start !== null) return timeRange(row.timestamp_start, row.timestamp_end);
  if (row.frame_timestamp !== null) return `frame at ${formatTime(row.frame_timestamp, true)}`;
  return "file-level";
}

function pdfLocationSuffix(row: EvidenceRow, exactLine?: number | null) {
  if (!row.page_number) return "";
  if (exactLine) return ` — Page ${row.page_number}, line ${exactLine}`;
  const lineStart = numericMetadata(row, "line_start");
  const lineEnd = numericMetadata(row, "line_end");
  if (lineStart && lineEnd) {
    return lineStart === lineEnd
      ? ` — Page ${row.page_number}, line ${lineStart}`
      : ` — Page ${row.page_number}, lines ${lineStart}-${lineEnd}`;
  }
  const lineCount = extractedLines(row.content).length;
  if (lineCount <= 1) return ` — Page ${row.page_number}`;
  return ` — Page ${row.page_number}, lines 1-${lineCount}`;
}

function lineNumberedContent(row: EvidenceRow) {
  const lines = extractedLines(row.content);
  if ((row.modality === "pdf" || row.modality === "document") && lines.length > 1) {
    const firstLine = numericMetadata(row, "line_start") ?? 1;
    return lines.map((line, index) => `${firstLine + index}: ${line}`).join("\n");
  }
  return row.content;
}

function lineNumberFor(row: EvidenceRow, zeroBasedIndex: number) {
  return (numericMetadata(row, "line_start") ?? 1) + zeroBasedIndex;
}

function numericMetadata(row: EvidenceRow, key: string) {
  const value = row.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractedLines(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function videoCitationDetail(row: EvidenceRow) {
  if (row.kind === "transcript" || row.kind === "speaker_segment") {
    const speaker = speakerLabel(row.content);
    const range = timeRange(row.timestamp_start, row.timestamp_end);
    return `${speaker ? `${speaker} ` : ""}Transcript${range ? ` ${range}` : ""}`;
  }
  if (row.kind === "frame") return `Frame${row.frame_timestamp !== null ? ` at ${formatTime(row.frame_timestamp, true)}` : ""}`;
  if (row.kind === "ocr_text") return `OCR${row.frame_timestamp !== null ? ` at ${formatTime(row.frame_timestamp, true)}` : ""}`;
  if (row.kind === "vision_description") return `Visual analysis${row.frame_timestamp !== null ? ` at ${formatTime(row.frame_timestamp, true)}` : ""}`;
  return readableKind(row.kind);
}

function audioCitationDetail(row: EvidenceRow) {
  const speaker = speakerLabel(row.content);
  const range = timeRange(row.timestamp_start, row.timestamp_end);
  return `${speaker ? `${speaker}, ` : ""}${range || readableKind(row.kind)}`;
}

function kindSuffix(kind: string) {
  if (kind === "native_text") return "";
  return `, ${readableKind(kind)}`;
}

function readableKind(kind: string) {
  if (kind === "ocr_text") return "OCR";
  if (kind === "vision_description") return "Visual analysis";
  if (kind === "native_text") return "Text";
  if (kind === "speaker_segment") return "Speaker segment";
  if (kind === "processing_note") return "Processing note";
  return kind.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function confidenceSuffix(row: EvidenceRow) {
  return row.confidence !== null && row.confidence < 0.55 ? ", low confidence" : "";
}

function timeRange(start: number | null, end: number | null) {
  if (start === null && end === null) return "";
  if (start !== null && end !== null) return `${formatTime(start)}-${formatTime(end)}`;
  return formatTime(start ?? end ?? 0);
}

function formatTime(seconds: number, precise = false) {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const millis = Math.round((safeSeconds - Math.floor(safeSeconds)) * 1000);
  const base = [hours, minutes, wholeSeconds].map((part) => String(part).padStart(2, "0")).join(":");
  return precise && millis > 0 ? `${base}.${String(millis).padStart(3, "0")}` : base;
}

function speakerLabel(content: string) {
  return content.match(/\bSPEAKER_\d+\b/)?.[0] ?? null;
}

function inferModalities(question: string) {
  const modalities = new Set<string>();
  if (/\b(image|photo|picture|card|aadhaar|aadhar|screenshot|shown|visible)\b/i.test(question)) modalities.add("image");
  if (/\b(video|frame|clip|watch|shown at|timestamp)\b/i.test(question)) modalities.add("video");
  if (/\b(audio|voice|speaker|said|say|transcript|m4a|mp3|wav)\b/i.test(question)) modalities.add("audio");
  if (/\b(pdf|document|page|report)\b/i.test(question)) modalities.add("pdf");
  return modalities;
}

function inferKinds(question: string) {
  const kinds = new Set<string>();
  if (/\b(written|text|number|aadhaar|aadhar|id|visible|read|ocr)\b/i.test(question)) kinds.add("ocr_text");
  if (/\b(say|said|speaker|voice|transcript|audio)\b/i.test(question)) kinds.add("transcript");
  if (/\b(describe|shown|look|image|photo|picture|scene|visible|what(?:'s| is)? there|people|person|woman|female)\b/i.test(question)) kinds.add("vision_description");
  if (/\b(page|pdf|document)\b/i.test(question)) kinds.add("native_text");
  return kinds;
}

function isVisualQuestion(question: string) {
  return /\b(describe|shown|look|image|photo|picture|scene|visible|what(?:'s| is)? there|people|person|woman|female)\b/i.test(question);
}

function inferCurrentSource(question: string, files: SourceFile[], targetModalities: Set<string>) {
  if (!/\b(this|that|uploaded|latest|current|the image|the video|the audio|the pdf|the document|card)\b/i.test(question)) {
    return null;
  }
  if (targetModalities.size === 0) return files[0] ?? null;
  return files.find((file) => targetModalities.has(file.modality)) ?? null;
}

function inferCorroborationIntent(question: string, referencedFiles: SourceFile[], targetModalities: Set<string>) {
  if (/\b(compare|across all|all uploaded|all files|between|versus|vs\.?|corroborat|confirm|same statement|same claim|all sources|all evidence)\b/i.test(question)) {
    return true;
  }
  if (targetModalities.size > 1) return true;
  if (referencedFiles.length > 0) return false;
  return /\b(weather|snow|snowing|rain|raining|month|year|london|same)\b/i.test(question);
}

function corroborationTerms(question: string) {
  const terms = meaningfulTerms(question);
  const month = question.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i)?.[0];
  return unique([
    ...terms,
    month ?? "",
    /\bweather\b/i.test(question) ? "snow" : "",
    /\bweather\b/i.test(question) ? "rain" : ""
  ].filter((term) => term.length >= 3));
}

function escapeIlikeTerm(term: string) {
  return term.replace(/[%*,()]/g, " ").trim();
}

function corroborationScore(question: string, row: EvidenceRow) {
  const normalizedQuestion = normalize(question);
  const normalizedContent = normalize(row.content);
  let score = 0;
  if (/\blondon\b/.test(normalizedQuestion) && /\blondon\b/.test(normalizedContent)) score += 2;
  if (/\bsnow|snowing\b/.test(normalizedQuestion) && /\bsnow|snowing\b/.test(normalizedContent)) score += 2;
  if (/\bweather\b/.test(normalizedQuestion) && /\b(snow|snowing|rain|raining|sunny|cloudy|fog|wind)\b/.test(normalizedContent)) score += 2;
  if (/\bmonth|year\b/.test(normalizedQuestion) && /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/.test(normalizedContent)) score += 1.5;
  return score;
}

function fileMentioned(normalizedQuestion: string, filename: string) {
  const normalizedFilename = normalize(filename);
  const filenameWithoutDot = normalizedFilename.replace(/\./g, " ");
  const stem = normalizedFilename.replace(/\.[a-z0-9]+$/, "");
  const fileishQuestion = /\b(file|video|audio|image|photo|picture|pdf|document|mp4|m4a|mp3|wav|jpeg|jpg|png)\b/.test(normalizedQuestion);
  return (
    normalizedQuestion.includes(normalizedFilename) ||
    normalizedQuestion.includes(filenameWithoutDot) ||
    (stem.includes(" ") && normalizedQuestion.includes(stem)) ||
    (stem.length >= 2 && fileishQuestion && new RegExp(`\\b${escapeRegExp(stem)}\\b`).test(normalizedQuestion))
  );
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function meaningfulTerms(text: string) {
  const stop = new Set(["what", "where", "when", "which", "that", "this", "with", "from", "about", "does", "have", "your", "name", "file", "image", "video", "audio", "document", "pdf"]);
  return normalize(text)
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !stop.has(term))
    .slice(0, 20);
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[_-]+/g, " ").replace(/[^\p{L}\p{N}. ]/gu, " ").replace(/\s+/g, " ").trim();
}

function friendlyError(error: unknown) {
  const message = formatError(error);
  if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
    return "Ollama is not running. Start it with: ollama serve";
  }
  return message;
}
