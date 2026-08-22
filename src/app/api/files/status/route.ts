import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const userId = request.nextUrl.searchParams.get("userId") ?? "anonymous";
    const { data, error } = await getSupabaseAdmin()
      .from("files")
      .select("id, original_filename, modality, status, processing_progress, processing_error, created_at, updated_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      return NextResponse.json({ success: false, error: { code: "STATUS_FAILED", message: error.message } }, { status: 500 });
    }
    return NextResponse.json({ success: true, files: data });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        files: [],
        error: {
          code: "SETUP_REQUIRED",
          message: setupMessage(error)
        }
      },
      { status: 200 }
    );
  }
}

function setupMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Supabase is not configured.";
  if (message.includes("NEXT_PUBLIC_SUPABASE_URL") || message.includes("SUPABASE_SERVICE_ROLE_KEY")) {
    return "Supabase environment variables are missing. Copy .env.example to .env.local, fill the Supabase values, create the storage bucket, and run supabase/schema.sql.";
  }
  return message;
}
