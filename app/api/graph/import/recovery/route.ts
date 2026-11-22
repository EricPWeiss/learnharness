import { emit } from "@/src/core";
import { extraction, notesImportJournal, NotesImportError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try { return Response.json({ imports: notesImportJournal.list() }); }
  catch { return Response.json({ error: "Could not read saved import progress." }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    if (Number(request.headers.get("content-length")) > 4096) return Response.json({ error: "Request too large." }, { status: 413 });
    const raw = await request.text();
    if (raw.length > 4096) return Response.json({ error: "Request too large." }, { status: 413 });
    body = JSON.parse(raw);
  } catch { return Response.json({ error: "Invalid recovery request." }, { status: 400 }); }
  const input = body as { sourceId?: unknown; action?: unknown } | null;
  if (!input || !["resume", "reaudit"].includes(String(input.action)) ||
    typeof input.sourceId !== "string" || !/^src_[a-f0-9]{12}$/.test(input.sourceId))
    return Response.json({ error: "Invalid recovery action or source." }, { status: 400 });
  try {
    const stats = await extraction.resumeNotes(input.sourceId, input.action === "reaudit");
    return Response.json({ ok: true, stats });
  } catch (error) {
    const busy = error instanceof NotesImportError && error.outcome === "busy";
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Recovery failed." }, { status: busy ? 409 : 422 });
  } finally { emit("sources-changed", {}); }
}
