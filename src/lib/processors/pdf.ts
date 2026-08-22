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
    if (content.trim()) {
      observations.push({
        fileId,
        modality: "pdf",
        kind: "native_text",
        content: content.trim(),
        pageNumber: index + 1,
        confidence: 0.98,
        metadata: { extraction: "pdf-parse" }
      });
    }
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

export async function runImageOcr(imagePath: string) {
  const env = getEnv();
  if (!(await commandExists(env.TESSERACT_PATH))) {
    return { text: "", warning: "Tesseract is not installed or not on TESSERACT_PATH." };
  }
  const { stdout } = await runCommand(env.TESSERACT_PATH, [imagePath, "stdout", "--psm", "6"], 120_000);
  return { text: stdout.trim(), warning: null };
}
