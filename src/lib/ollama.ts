import { getEnv } from "./env";

type OllamaTag = {
  name: string;
  model?: string;
};

type OllamaTagsResponse = {
  models?: OllamaTag[];
};

type OllamaChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OllamaHealth = {
  ok: boolean;
  baseUrl: string;
  model: string;
  embeddingModel: string;
  visionModel?: string;
  hasModel: boolean;
  hasEmbeddingModel: boolean;
  hasVisionModel: boolean;
  models: string[];
  error?: string;
};

export async function getOllamaHealth(): Promise<OllamaHealth> {
  const env = getEnv();
  const baseUrl = normalizeBaseUrl(env.OLLAMA_BASE_URL);
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) {
      return {
        ok: false,
        baseUrl,
        model: env.OLLAMA_MODEL,
        embeddingModel: env.OLLAMA_EMBEDDING_MODEL,
        visionModel: env.OLLAMA_VISION_MODEL,
        hasModel: false,
        hasEmbeddingModel: false,
        hasVisionModel: false,
        models: [],
        error: `Ollama connection failure (${response.status}).`
      };
    }
    const payload = (await response.json()) as OllamaTagsResponse;
    const models = (payload.models ?? []).map((item) => item.name || item.model || "").filter(Boolean);
    const hasModel = hasOllamaModel(models, env.OLLAMA_MODEL);
    const hasEmbeddingModel = hasOllamaModel(models, env.OLLAMA_EMBEDDING_MODEL);
    const hasVisionModel = env.OLLAMA_VISION_MODEL ? hasOllamaModel(models, env.OLLAMA_VISION_MODEL) : true;
    return {
      ok: hasModel && hasEmbeddingModel && hasVisionModel,
      baseUrl,
      model: env.OLLAMA_MODEL,
      embeddingModel: env.OLLAMA_EMBEDDING_MODEL,
      visionModel: env.OLLAMA_VISION_MODEL,
      hasModel,
      hasEmbeddingModel,
      hasVisionModel,
      models,
      error: healthError(hasModel, hasEmbeddingModel, hasVisionModel, env.OLLAMA_MODEL, env.OLLAMA_EMBEDDING_MODEL, env.OLLAMA_VISION_MODEL)
    };
  } catch {
    return {
      ok: false,
      baseUrl,
      model: env.OLLAMA_MODEL,
      embeddingModel: env.OLLAMA_EMBEDDING_MODEL,
      visionModel: env.OLLAMA_VISION_MODEL,
      hasModel: false,
      hasEmbeddingModel: false,
      hasVisionModel: false,
      models: [],
      error: "Ollama is not running. Start it with: ollama serve"
    };
  }
}

export async function createOllamaEmbedding(input: string) {
  const env = getEnv();
  const health = await getOllamaHealth();
  if (!health.hasEmbeddingModel) {
    throw new Error(`Ollama embedding model ${env.OLLAMA_EMBEDDING_MODEL} is not installed. Run: ollama pull ${env.OLLAMA_EMBEDDING_MODEL}`);
  }

  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(env.OLLAMA_BASE_URL)}/api/embeddings`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.OLLAMA_EMBEDDING_MODEL, prompt: input })
    },
    60_000
  );
  if (!response.ok) {
    throw new Error(`Ollama embedding generation failed (${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as { embedding?: number[] };
  const embedding = payload.embedding;
  if (!embedding?.length) {
    throw new Error("Ollama embedding generation failed: empty embedding returned.");
  }
  if (embedding.length !== env.OLLAMA_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch. Ollama returned ${embedding.length}, but Supabase pgvector is configured for ${env.OLLAMA_EMBEDDING_DIMENSIONS}.`
    );
  }
  return embedding;
}

export async function createOllamaChat(messages: OllamaChatMessage[], options?: { json?: boolean }) {
  const env = getEnv();
  const health = await getOllamaHealth();
  if (!health.hasModel) {
    throw new Error(`Ollama model ${env.OLLAMA_MODEL} is not installed. Run: ollama pull ${env.OLLAMA_MODEL}`);
  }

  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(env.OLLAMA_BASE_URL)}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        messages,
        stream: false,
        format: options?.json ? "json" : undefined,
        options: { temperature: 0 }
      })
    },
    120_000
  );
  if (!response.ok) {
    throw new Error(`Ollama LLM generation failed (${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as { message?: { content?: string } };
  return payload.message?.content?.trim() ?? "";
}

export async function createOllamaVision(prompt: string, base64Image: string) {
  const env = getEnv();
  if (!env.OLLAMA_VISION_MODEL) {
    return {
      text: "",
      warning: "OLLAMA_VISION_MODEL is not configured; vision understanding skipped."
    };
  }
  const health = await getOllamaHealth();
  if (!health.hasVisionModel) {
    return {
      text: "",
      warning: `Ollama vision model ${env.OLLAMA_VISION_MODEL} is not installed. Run: ollama pull ${env.OLLAMA_VISION_MODEL}`
    };
  }
  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(env.OLLAMA_BASE_URL)}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OLLAMA_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: prompt,
            images: [base64Image]
          }
        ],
        stream: false,
        options: { temperature: 0 }
      })
    },
    120_000
  );
  if (!response.ok) {
    const body = await response.text();
    return {
      text: "",
      warning: visionFailureMessage(env.OLLAMA_VISION_MODEL, response.status, body)
    };
  }
  const payload = (await response.json()) as { message?: { content?: string } };
  return { text: payload.message?.content?.trim() ?? "", warning: null };
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/$/, "");
}

function visionFailureMessage(model: string, status: number, body: string) {
  if (body.includes("unknown model architecture")) {
    return `Ollama cannot load vision model ${model} with the installed Ollama runtime. Use a compatible vision model such as gemma3:latest, or update Ollama.`;
  }
  return `Ollama vision generation failed (${status}): ${body}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Ollama request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function hasOllamaModel(models: string[], requested: string) {
  return models.some((model) => model === requested || model === `${requested}:latest` || model.split(":")[0] === requested);
}

function healthError(
  hasModel: boolean,
  hasEmbeddingModel: boolean,
  hasVisionModel: boolean,
  model: string,
  embeddingModel: string,
  visionModel?: string
) {
  if (!hasModel) return `Ollama model ${model} is not installed. Run: ollama pull ${model}`;
  if (!hasEmbeddingModel) return `Ollama embedding model ${embeddingModel} is not installed. Run: ollama pull ${embeddingModel}`;
  if (!hasVisionModel && visionModel) return `Ollama vision model ${visionModel} is not installed. Run: ollama pull ${visionModel}`;
  return undefined;
}
