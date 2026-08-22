import { NextRequest, NextResponse } from "next/server";
import { answerQuestion, querySchema } from "@/lib/retrieval/query";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const input = querySchema.parse(body);
    const result = await answerQuestion(input.question, input.userId);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Query failed.";
    const code = message.includes("NEXT_PUBLIC_SUPABASE_URL") || message.includes("SUPABASE_SERVICE_ROLE_KEY")
      ? "SETUP_REQUIRED"
      : "QUERY_FAILED";
    return NextResponse.json(
      { success: false, error: { code, message: code === "SETUP_REQUIRED" ? "Supabase environment variables are missing. Configure .env.local before querying." : message } },
      { status: 500 }
    );
  }
}
