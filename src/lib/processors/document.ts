import fs from "node:fs/promises";
import type { ProcessingResult } from "../types";

export async function processDocument(fileId: string, filePath: string): Promise<ProcessingResult> {
  const text = await fs.readFile(filePath, "utf8");
  const chunks = text.split(/\n{2,}/g).map((chunk) => chunk.trim()).filter(Boolean);
  return {
    observations: chunks.map((content, index) => ({
      fileId,
      modality: "document",
      kind: "native_text",
      content,
      confidence: 1,
      metadata: { section_index: index }
    })),
    warnings: []
  };
}
