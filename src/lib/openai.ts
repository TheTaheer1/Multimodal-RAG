import OpenAI from "openai";
import { getOptionalEnv } from "./env";

export function getOpenAI() {
  const env = getOptionalEnv();
  if (!env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}
