import fs from "node:fs/promises";
import pdfParse from "pdf-parse";
import { getEnv } from "../env";
import type { ProcessingResult } from "../types";
import { commandExists, runCommand } from "./util";

export async function processPdf(fileId: string, filePath: string): Promise<ProcessingResult> {
  const buffer = await fs.readFile(filePath);
  const parsed = await pdfParse(buffer);
  const observations: ProcessingResult["observations"] = [];
  const warnings: string[] = [];
  const pages = splitPdfPages(parsed.text);

  pages.forEach((content, index) => {
    const chunks = chunkPageLines(content);
    chunks.forEach((chunk) => {
      observations.push({
        fileId,
        modality: "pdf",
        kind: "native_text",
        content: chunk.content,
        pageNumber: index + 1,
        confidence: 0.98,
        metadata: { extraction: "pdf-parse", line_start: chunk.lineStart, line_end: chunk.lineEnd }
      });
    });
  });

  if (observations.length === 0 || parsed.text.trim().length < 80) {
    const env = getEnv();
    if (await commandExists(env.TESSERACT_PATH)) {
      warnings.push("PDF native text was sparse; configure pdftoppm/poppler for scanned-page OCR if needed.");
    } else {
      warnings.push("PDF native text was sparse and Tesseract is not available for scanned OCR fallback.");
    }
  }

  return { observations, warnings };
}

function splitPdfPages(text: string) {
  const explicit = text.split(/\f/g).map((page) => page.trim()).filter(Boolean);
  if (explicit.length > 1) return explicit;
  const chunks = text.split(/\n{3,}/g).map((page) => page.trim()).filter(Boolean);
  return chunks.length ? chunks : [text];
}

function chunkPageLines(content: string) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0 && content.trim()) {
    return [{ content: content.trim(), lineStart: null, lineEnd: null }];
  }

  const chunks: Array<{ content: string; lineStart: number; lineEnd: number }> = [];
  const maxLines = 12;
  for (let index = 0; index < lines.length; index += maxLines) {
    const slice = lines.slice(index, index + maxLines);
    chunks.push({
      content: slice.join("\n"),
      lineStart: index + 1,
      lineEnd: index + slice.length
    });
  }
  return chunks;
}

export async function runImageOcr(imagePath: string) {
  const env = getEnv();
  if (!(await commandExists(env.TESSERACT_PATH))) {
    return { text: "", warning: "Tesseract is not installed or not on TESSERACT_PATH." };
  }
  const { stdout } = await runCommand(env.TESSERACT_PATH, [imagePath, "stdout", "--psm", "6"], 120_000);
  return { text: stdout.trim(), warning: null };
}
