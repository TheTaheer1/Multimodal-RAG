export function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isErrorLike(error)) {
    return [error.message, error.details, error.hint, error.code]
      .filter(Boolean)
      .join(" ");
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function formatDatabaseError(error: unknown) {
  const message = formatError(error);
  if (
    message.includes("expected 1536 dimensions") ||
    message.includes("different vector dimensions") ||
    message.includes("vector(1536)") ||
    message.includes("expected 768 dimensions")
  ) {
    return `${message} Run supabase/ollama_embedding_migration.sql so pgvector uses vector(768) for Ollama nomic-embed-text.`;
  }
  return message;
}

function isErrorLike(error: unknown): error is { message?: string; details?: string; hint?: string; code?: string } {
  return typeof error === "object" && error !== null;
}
