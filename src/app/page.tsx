"use client";

import { useEffect, useState } from "react";
import { Database, FileUp, Loader2, Search, ShieldCheck, TriangleAlert } from "lucide-react";

type FileRow = {
  id: string;
  original_filename: string;
  modality: string;
  status: string;
  processing_progress: number;
  processing_error: string | null;
  created_at: string;
};

type QueryResult = {
  answer: string;
  citations: Array<{
    id: string;
    original_filename: string;
    modality: string;
    kind: string;
    content: string;
    page_number: number | null;
    timestamp_start: number | null;
    timestamp_end: number | null;
    frame_timestamp: number | null;
    confidence: number | null;
  }>;
};

const userId = "anonymous";

export default function Home() {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [question, setQuestion] = useState("");
  const [querying, setQuerying] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);

  async function refreshFiles() {
    const payload = await fetchJson(`/api/files/status?userId=${encodeURIComponent(userId)}`);
    if (payload.success) {
      setFiles(payload.files);
      return;
    }
    setFiles(payload.files ?? []);
    setMessage(payload.error?.message ?? "Unable to load processing status.");
  }

  useEffect(() => {
    refreshFiles();
    const timer = setInterval(refreshFiles, 4000);
    return () => clearInterval(timer);
  }, []);

  async function onUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setUploading(true);
    setMessage("");
    const form = new FormData();
    form.append("file", selected);
    form.append("userId", userId);
    const payload = await fetchJson("/api/files/upload", { method: "POST", body: form });
    setUploading(false);
    setMessage(payload.success ? payload.message ?? "Upload queued for processing." : payload.error.message);
    event.target.value = "";
    await refreshFiles();
  }

  async function ask() {
    if (!question.trim()) return;
    setQuerying(true);
    setResult(null);
    const payload = await fetchJson("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, userId })
    });
    setQuerying(false);
    if (payload.success) setResult(payload);
    else setMessage(payload.error.message);
  }

  return (
    <main className="min-h-screen">
      <section className="border-b border-ink/10 bg-paper">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-8 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-moss">
              <Database size={18} />
              Connected multimodal evidence graph
            </div>
            <h1 className="max-w-4xl text-4xl font-semibold tracking-normal text-ink md:text-6xl">
              Multimodal Evidence RAG
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-ink/70">
              Upload PDFs, images, video, and audio. The worker extracts evidence, preserves provenance, links timestamps and relationships, and answers only from cited sources.
            </p>
          </div>
          <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md bg-moss px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-moss/90">
            {uploading ? <Loader2 className="animate-spin" size={18} /> : <FileUp size={18} />}
            Upload
            <input
              type="file"
              className="hidden"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.mp3,.wav,.m4a,.txt,.md"
              onChange={onUpload}
            />
          </label>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_440px]">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Search size={20} className="text-rust" />
            <h2 className="text-xl font-semibold">Ask Across Evidence</h2>
          </div>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What architecture was discussed for reducing database load, who explained it, when, and which sources support it?"
            className="min-h-32 w-full resize-y rounded-md border border-ink/15 bg-white p-4 text-base outline-none ring-moss/30 focus:ring-4"
          />
          <button
            onClick={ask}
            disabled={querying}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            {querying ? <Loader2 className="animate-spin" size={18} /> : <ShieldCheck size={18} />}
            Answer with citations
          </button>
          {message ? (
            <div className="flex items-start gap-2 rounded-md border border-rust/30 bg-rust/5 p-3 text-sm text-ink/75">
              <TriangleAlert size={18} className="mt-0.5 shrink-0 text-rust" />
              {message}
            </div>
          ) : null}
          {result ? (
            <div className="space-y-4">
              <article className="rounded-md border border-ink/10 bg-white p-5 shadow-sm">
                <h3 className="mb-3 text-lg font-semibold">Answer</h3>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-ink/80">{result.answer}</pre>
              </article>
              <div className="grid gap-3">
                {result.citations.map((citation, index) => (
                  <article key={citation.id} className="rounded-md border border-ink/10 bg-white p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-normal text-steel">
                      <span>E{index + 1}</span>
                      <span>{citation.original_filename}</span>
                      <span>{citation.modality}</span>
                      <span>{citation.kind}</span>
                    </div>
                    <p className="line-clamp-5 text-sm leading-6 text-ink/75">{citation.content}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <aside className="space-y-3">
          <h2 className="text-xl font-semibold">Processing Queue</h2>
          {files.length === 0 ? (
            <div className="rounded-md border border-dashed border-ink/20 bg-white p-5 text-sm text-ink/60">
              No files yet.
            </div>
          ) : (
            files.map((file) => (
              <article key={file.id} className="rounded-md border border-ink/10 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="break-words text-sm font-semibold">{file.original_filename}</h3>
                    <p className="mt-1 text-xs uppercase tracking-normal text-steel">{file.modality}</p>
                  </div>
                  <span className="rounded-sm bg-paper px-2 py-1 text-xs font-semibold text-ink/70">{file.status}</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-sm bg-ink/10">
                  <div className="h-full bg-moss transition-all" style={{ width: `${file.processing_progress ?? 0}%` }} />
                </div>
                {file.processing_error ? <p className="mt-3 text-xs leading-5 text-rust">{file.processing_error}</p> : null}
              </article>
            ))
          )}
        </aside>
      </section>
    </main>
  );
}

async function fetchJson(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  const text = await response.text();
  if (!text.trim()) {
    return { success: false, error: { message: `Server returned an empty ${response.status} response.` } };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, error: { message: text.slice(0, 240) || "Server returned non-JSON output." } };
  }
}
