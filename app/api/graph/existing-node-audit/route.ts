import {
  existingNodeAuditView, reviewExistingNodeAudit, scanExistingNodeAudit,
} from "@/src/server/existing-node-audit.ts";

export const dynamic = "force-dynamic";
export function GET() {
  try { return Response.json(existingNodeAuditView()); }
  catch { return Response.json({ error: "Unable to read node audit results." }, { status: 500 }); }
}
export async function POST(request: Request) {
  let raw: unknown;
  try {
    if (Number(request.headers.get("content-length")) > 4096) return Response.json({ error: "Request too large." }, { status: 413 });
    const body = await request.text();
    if (body.length > 4096) return Response.json({ error: "Request too large." }, { status: 413 });
    raw = JSON.parse(body);
  } catch { return Response.json({ error: "Malformed audit request." }, { status: 400 }); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return Response.json({ error: "Invalid audit action." }, { status: 400 });
  const action = raw as Record<string, unknown>;
  try {
    if (action.action === "scan" && (action.batchSize === undefined ||
      (Number.isInteger(action.batchSize) && Number(action.batchSize) >= 1 && Number(action.batchSize) <= 12)))
      return Response.json(await scanExistingNodeAudit(action.batchSize === undefined ? 12 : Number(action.batchSize)));
    if (action.action === "review" && typeof action.key === "string" &&
      (action.status === "accepted" || action.status === "dismissed"))
      return Response.json(reviewExistingNodeAudit(action.key, action.status));
    return Response.json({ error: "Invalid audit action." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Audit failed." },
      { status: 409 });
  }
}
