/**
 * View-only cluster exploration: source, logical, and hybrid partitions.
 * The underlying graph's proposition/chain ledgers are never rewritten.
 * No external services, embeddings, or mutable state.
 */
import type { Cluster, GraphChain, GraphNode } from "./contracts.ts";
import { MIN_CLUSTER_SIZE } from "./clusters.ts";

export type ClusterMode = "source" | "logical" | "hybrid";
export interface SavedClusterName { label: string; members: string[] }
export interface InteractiveClusterSettings {
  mode: ClusterMode;
  logicalWeight: number;
  granularity: number;
  bridgeInfluence: number;
  names: Record<string, SavedClusterName>;
}
export const DEFAULT_CLUSTER_SETTINGS: InteractiveClusterSettings = {
  mode: "hybrid", logicalWeight: 50, granularity: 50, bridgeInfluence: 60, names: {},
};
const percent = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(Math.max(0, Math.min(100, v))) : fallback;
export function sanitizeInteractiveClusterSettings(raw: unknown): InteractiveClusterSettings {
  const r: Partial<InteractiveClusterSettings> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<InteractiveClusterSettings> : {};
  const names: Record<string, SavedClusterName> = {};
  if (r.names && typeof r.names === "object" && !Array.isArray(r.names)) {
    for (const [key, value] of Object.entries(r.names).slice(0, 250)) {
      if (!/^(source|logical|hybrid):[A-Za-z0-9_-]+$/.test(key)) continue;
      if (!value || typeof value !== "object" || typeof value.label !== "string" || !value.label.trim()) continue;
      names[key] = {
        label: value.label.trim().slice(0, 100),
        members: Array.isArray(value.members)
          ? [...new Set(value.members.filter((x): x is string => typeof x === "string" && /^n_[0-9a-f]+$/.test(x)))].slice(0, 5000)
          : [],
      };
    }
  }
  return {
    mode: r.mode === "source" || r.mode === "logical" || r.mode === "hybrid" ? r.mode : "hybrid",
    logicalWeight: percent(r.logicalWeight, 50),
    granularity: percent(r.granularity, 50),
    bridgeInfluence: percent(r.bridgeInfluence, 60),
    names,
  };
}

/** Single-level, deterministic modularity-inspired partition; not Leiden. */
export function computeInteractiveClusters(
  propositions: readonly GraphNode[],
  chains: readonly GraphChain[],
  sourceClusters: readonly Cluster[],
  tuning: InteractiveClusterSettings,
): Cluster[] {
  const mode = tuning.mode;
  const rename = (groups: Cluster[]): Cluster[] => {
    const candidates = Object.entries(tuning.names)
      .filter(([k]) => k.startsWith(mode + ":"))
      .map(([key, rec]) => ({ key, rec, set: new Set(rec.members) }));
    const used = new Set<string>();
    return groups.map(group => {
      const key = mode + ":" + group.id;
      const exact = tuning.names[key];
      if (exact) { used.add(key); return { ...group, label: exact.label }; }
      const ids = group.members.filter(id => id.startsWith("n_"));
      let best: typeof candidates[number] | null = null;
      let bestOverlap = 0.55;
      for (const cand of candidates) {
        if (used.has(cand.key) || cand.set.size === 0) continue;
        const intersection = ids.filter(id => cand.set.has(id)).length;
        const overlap = intersection / Math.max(ids.length, cand.set.size);
        if (overlap > bestOverlap) { bestOverlap = overlap; best = cand; }
      }
      if (best) { used.add(best.key); return { ...group, label: best.rec.label }; }
      return group;
    });
  };
  if (mode === "source") return rename(sourceClusters.map(c => ({ ...c, members: [...c.members] })));
  const byId = new Map(propositions.map(n => [n.id, n]));
  const ids = [...byId.keys()].sort();
  if (!ids.length) return [];
  const source = (id: string): string => byId.get(id)?.provenance[0]?.chatId ?? "";
  const links = new Map(ids.map(id => [id, new Map<string, number>()]));
  const add = (a: string, b: string, w: number) => {
    if (a === b || !links.has(a) || !links.has(b) || w <= 0) return;
    const la = links.get(a)!; const lb = links.get(b)!;
    la.set(b, (la.get(b) ?? 0) + w);
    lb.set(a, (lb.get(a) ?? 0) + w);
  };
  const alpha = tuning.logicalWeight / 100;
  const logicalWeight = mode === "logical" ? 1.8 : 0.05 + 2.3 * alpha;
  for (const ch of chains) {
    if (!byId.has(ch.conclusion)) continue;
    const premises = [...new Set(ch.premises)].filter(p => byId.has(p) && p !== ch.conclusion);
    for (const p of premises) {
      // Until a bridge-only document kind exists, cross-source chains are a proxy.
      const acrossSource = source(p) !== source(ch.conclusion);
      const boost = acrossSource ? 1 + 2 * tuning.bridgeInfluence / 100 : 1;
      add(p, ch.conclusion, logicalWeight * boost / Math.sqrt(premises.length));
    }
  }
  if (mode === "hybrid" && alpha < 1) {
    const sourceGroups = new Map<string, string[]>();
    for (const id of ids) {
      const s = source(id);
      if (!s) continue;
      const arr = sourceGroups.get(s) ?? [];
      arr.push(id); sourceGroups.set(s, arr);
    }
    for (const members of sourceGroups.values()) {
      if (members.length < 2) continue;
      for (let i = 0; i < members.length; i++) {
        for (let delta = 1; delta <= Math.min(2, members.length - 1); delta++)
          add(members[i]!, members[(i + delta) % members.length]!, (1 - alpha) * 2 / delta);
      }
    }
  }
  const degrees = new Map(ids.map(id => [id, [...links.get(id)!.values()].reduce((a,b)=>a+b,0)]));
  const total2m = [...degrees.values()].reduce((a,b)=>a+b,0);
  if (total2m <= 0) return [];
  const gamma = 0.35 + 2.7 * tuning.granularity / 100;
  const community = new Map(ids.map(id => [id,id]));
  const volumes = new Map(ids.map(id => [id,degrees.get(id)!]));
  for (let iteration = 0; iteration < 35; iteration++) {
    let moved = 0;
    for (const id of ids) {
      const own = community.get(id)!;
      const d = degrees.get(id)!;
      if (d <= 0) continue;
      volumes.set(own, (volumes.get(own) ?? 0) - d);
      const byCommunity = new Map<string, number>();
      for (const [neighbor, weight] of links.get(id)!) {
        const key = community.get(neighbor)!;
        byCommunity.set(key, (byCommunity.get(key) ?? 0) + weight);
      }
      byCommunity.set(own, byCommunity.get(own) ?? 0);
      let best = own, bestScore = (byCommunity.get(own) ?? 0) - gamma * d * (volumes.get(own) ?? 0) / total2m;
      for (const [key, weight] of byCommunity) {
        const score = weight - gamma * d * (volumes.get(key) ?? 0) / total2m;
        if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && key < best)) {
          best = key; bestScore = score;
        }
      }
      community.set(id, best); volumes.set(best, (volumes.get(best) ?? 0) + d);
      if (best !== own) moved++;
    }
    if (!moved) break;
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) { const key = community.get(id)!; const arr = groups.get(key) ?? []; arr.push(id); groups.set(key, arr); }
  const sourceLabels = new Map(sourceClusters.map(c => [c.id, c.label]));
  const result: Cluster[] = [];
  for (const members of groups.values()) {
    if (members.length < MIN_CLUSTER_SIZE) continue;
    const counts = new Map<string, number>();
    for (const id of members) { const s = source(id); counts.set(s, (counts.get(s) ?? 0) + 1); }
    const lead = [...counts].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))[0];
    const central = [...members].sort((a,b) => degrees.get(b)!-degrees.get(a)! || a.localeCompare(b))[0]!;
    const label = (lead && lead[1] / members.length >= 0.72 ? sourceLabels.get(lead[0]) : null)
      ?? byId.get(central)?.name ?? "Related propositions";
    result.push({ id: mode + "_" + members[0], label, members: [...members] });
  }
  const owner = new Map<string, Cluster>();
  for (const c of result) for (const member of c.members) owner.set(member, c);
  for (const ch of chains) {
    if (ch.premises.length < 2 || !byId.has(ch.conclusion) || !ch.premises.every(p => byId.has(p))) continue;
    const votes = new Map<Cluster, number>();
    for (const p of ch.premises) {
      const c = owner.get(p); if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
    }
    const pick = [...votes].sort((a,b) => b[1]-a[1] || a[0].id.localeCompare(b[0].id))[0];
    if (pick) pick[0].members.push(ch.id);
  }
  for (const c of result) c.members.sort();
  result.sort((a,b) => b.members.length-a.members.length || a.id.localeCompare(b.id));
  return rename(result);
}
