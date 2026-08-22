import fs from "node:fs/promises";
import exifr from "exifr";
import { createOllamaVision } from "../ollama";
import type { ProcessingResult } from "../types";
import { runImageOcr } from "./pdf";

export async function processImage(fileId: string, filePath: string, artifactPath?: string): Promise<ProcessingResult> {
  const warnings: string[] = [];
  const observations: ProcessingResult["observations"] = [];
  const ocr = await runImageOcr(filePath);
  if (ocr.warning) warnings.push(ocr.warning);
  if (ocr.text) {
    observations.push({
      fileId,
      modality: "image",
      kind: "ocr_text",
      content: ocr.text,
      artifactPath,
      confidence: 0.8,
      metadata: { engine: "tesseract" }
    });
  }

  const description = await describeImage(filePath);
  if (description.warning) warnings.push(description.warning);
  if (description.text) {
    observations.push({
      fileId,
      modality: "image",
      kind: "vision_description",
      content: description.text,
      artifactPath,
      confidence: 0.78,
      metadata: { engine: "ollama-vision", exif: await safeExif(filePath) }
    });
  }

  return { observations, warnings };
}

async function describeImage(filePath: string) {
  const image = await fs.readFile(filePath);
  return createOllamaVision(
    "Describe only visible evidence. Extract diagram structure, entities, labels, relationships, and uncertainty. Do not invent hidden text.",
    image.toString("base64")
  );
}

async function safeExif(filePath: string) {
  try {
    return (await exifr.parse(filePath)) ?? {};
  } catch {
    return {};
  }
}
