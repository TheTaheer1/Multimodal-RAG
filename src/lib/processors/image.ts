import fs from "node:fs/promises";
import path from "node:path";
import exifr from "exifr";
import { getEnv } from "../env";
import { getOpenAI } from "../openai";
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
      metadata: { engine: "openai-vision", exif: await safeExif(filePath) }
    });
  }

  return { observations, warnings };
}

async function describeImage(filePath: string) {
  const client = getOpenAI();
  if (!client) return { text: "", warning: "OPENAI_API_KEY is not configured; vision understanding skipped." };
  const env = getEnv();
  const image = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase().replace(".", "") || "jpeg";
  const mime = ext === "jpg" ? "jpeg" : ext;
  const response = await client.chat.completions.create({
    model: env.OPENAI_VISION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Describe only visible evidence. Extract diagram structure, entities, labels, relationships, and uncertainty. Do not invent hidden text."
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this image for a multimodal evidence graph." },
          { type: "image_url", image_url: { url: `data:image/${mime};base64,${image.toString("base64")}` } }
        ]
      }
    ],
    temperature: 0
  });
  return { text: response.choices[0]?.message.content?.trim() ?? "", warning: null };
}

async function safeExif(filePath: string) {
  try {
    return (await exifr.parse(filePath)) ?? {};
  } catch {
    return {};
  }
}
