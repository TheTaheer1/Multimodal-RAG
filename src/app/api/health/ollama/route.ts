import { NextResponse } from "next/server";
import { getOllamaHealth } from "@/lib/ollama";

export const runtime = "nodejs";

export async function GET() {
  try {
    const health = await getOllamaHealth();
    return NextResponse.json({ success: health.ok, ...health }, { status: health.ok ? 200 : 503 });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        ok: false,
        error: error instanceof Error ? error.message : "Ollama health check failed."
      },
      { status: 500 }
    );
  }
}
