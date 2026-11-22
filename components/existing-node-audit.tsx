"use client";

import { useEffect, useState } from "react";
import { ScanSearchIcon, Loader2Icon } from "lucide-react";
import { Hint } from "@/components/ui/hint";

type Relation = "equivalent" | "a_specializes_b" | "b_specializes_a" |
  "a_implies_b" | "b_implies_a" | "related" | "unrelated" | "uncertain";
interface Item {
  key: string; a: string; b: string; explanation: string; relation: Relation;
  status: "suggested" | "accepted" | "dismissed";
}
interface View {
  running: boolean; totalNodes: number; candidateCount: number;
  remaining: number; items: Item[]; names: Record<string, string>;
}
const relationship: Record<Relation, string> = {
  equivalent: "Possible duplicate / equivalent",
  a_specializes_b: "A is a special case of B",
  b_specializes_a: "B is a special case of A",
  a_implies_b: "A implies B",
  b_implies_a: "B implies A",
  related: "Related propositions",
  unrelated: "No evident relation",
  uncertain: "Uncertain: review assumptions",
};
export function ExistingNodeAuditControl() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  async function load() {
    const response = await fetch("/api/graph/existing-node-audit", { cache: "no-store" });
    const data = await response.json() as View & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Could not load audit.");
    setView(data);
  }
  useEffect(() => { if (open) void load().catch(e => setError(String(e))); }, [open]);
  async function action(value: { action: "scan"; batchSize: number } |
    { action: "review"; key: string; status: "accepted" | "dismissed" }) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/graph/existing-node-audit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      const data = await response.json() as View & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Audit failed.");
      setView(data);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const interesting = view?.items.filter(item =>
    item.relation !== "unrelated" && (showAll || item.status !== "dismissed")) ?? [];
  return <div className="relative shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
    <Hint label="Audit existing nodes for redundancy and special cases" side="bottom">
      <button type="button" data-testid="audit-existing-nodes" aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent">
        <ScanSearchIcon className="size-3.5" />Audit nodes
      </button>
    </Hint>
    {open && <div role="dialog" aria-label="Existing node audit" className="absolute right-0 top-full z-50 mt-2 max-h-[70vh] w-[min(90vw,28rem)] overflow-y-auto rounded-xl border bg-card p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <strong className="text-sm">Existing-node redundancy audit</strong>
        <button type="button" onClick={() => setOpen(false)} className="rounded px-2 py-1 text-xs hover:bg-accent">Close</button>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Scans existing propositions for potential equivalents, special cases and implications.
        Only promising text-based candidates are checked. Results are AI suggestions, not formal proofs.
        No graph nodes are changed or merged.
      </p>
      {view && <p className="mb-2 text-xs text-muted-foreground">
        {view.totalNodes} nodes · {view.candidateCount} candidate pairs · {view.remaining} not yet audited
      </p>}
      <button type="button" disabled={busy || view?.remaining === 0}
        onClick={() => void action({ action: "scan", batchSize: 12 })}
        className="mb-2 inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
        {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <ScanSearchIcon className="size-3.5" />}
        {busy ? "Auditing…" : "Audit next 12 candidate pairs"}
      </button>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Each batch uses the configured auditor model and may incur provider charges.
      </p>
      {error && <p role="alert" className="mb-2 text-xs text-error">{error}</p>}
      <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
        Include dismissed suggestions
      </label>
      <div className="flex flex-col gap-2">
        {interesting.map(item => <div key={item.key} className="rounded-md border p-2 text-xs">
          <div className="mb-1 font-medium">{relationship[item.relation]}</div>
          <div className="break-words">A: {view?.names[item.a] ?? item.a}</div>
          <div className="break-words">B: {view?.names[item.b] ?? item.b}</div>
          <p className="my-2 whitespace-pre-wrap text-muted-foreground">{item.explanation}</p>
          {item.status === "suggested" ? <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void action({
              action: "review", key: item.key, status: "accepted",
            })} className="rounded border px-2 py-1 hover:bg-accent">Keep suggestion</button>
            <button type="button" disabled={busy} onClick={() => void action({
              action: "review", key: item.key, status: "dismissed",
            })} className="rounded border px-2 py-1 hover:bg-accent">Dismiss</button>
          </div> : <p className="text-muted-foreground">Reviewed: {item.status}</p>}
        </div>)}
        {view && interesting.length === 0 && <p className="text-xs text-muted-foreground">
          No relationships to review yet. Use the audit button to inspect candidate pairs.
        </p>}
      </div>
    </div>}
  </div>;
}
