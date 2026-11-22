/**
 * Post-import graph audit: conservative duplicate suggestions and
 * explicitly approved node consolidation.
 *
 * No LLM equivalence claims: exact means identical statement text after
 * whitespace normalization, and possible means lexical similarity only.
 * Reading an audit never changes persistent graph data.
 */
import { createHash } from "node:crypto";
import type { GraphChain, GraphNode } from "./contracts.ts";
import type { GraphStore } from "./ports.ts";
import { getGraph } from "./graph.ts";

export type GraphAuditKind = "exact" | "possible";
export interface GraphAuditCandidate {
  id: string;
  leftId: string;
  rightId: string;
  kind: GraphAuditKind;
  score: number;
  reason: string;
}
export interface GraphAuditReport {
  nodeCount: number;
  chainCount: number;
  exactCount: number;
  possibleCount: number;
  danglingChains: number;
  isolatedNodes: number;
  truncated: boolean;
  candidates: GraphAuditCandidate[];
}

export const normalizeAuditStatement = (text: string): string =>
  text.normalize("NFC").replace(/\s+/g, " ").trim();

const simpleName = (text: string): string => text.normalize("NFC").trim().toLowerCase();
const candidateId = (a: GraphNode, b: GraphNode): string =>
  createHash("sha256").update(JSON.stringify([
    a.id, b.id, normalizeAuditStatement(a.statement), normalizeAuditStatement(b.statement),
  ])).digest("hex").slice(0, 24);

function trigrams(text: string): Set<string> {
  const textNormalized = normalizeAuditStatement(text).toLowerCase();
  const output = new Set<string>();
  for (let i = 0; i + 3 <= textNormalized.length; i++) output.add(textNormalized.slice(i, i + 3));
  return output;
}
function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const token of a) if (b.has(token)) hits++;
  return 2 * hits / (a.size + b.size);
}

/** Pure, deterministic scan over the fully folded graph. */
export function auditGraph(
  nodes: readonly GraphNode[],
  chains: readonly GraphChain[],
  options: { maxSuggestions?: number } = {},
): GraphAuditReport {
  const limit = Math.max(1, Math.min(500, Math.floor(options.maxSuggestions ?? 200)));
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const exactGroups = new Map<string, GraphNode[]>();
  for (const node of ordered) {
    const key = normalizeAuditStatement(node.statement);
    if (!key) continue;
    const group = exactGroups.get(key) ?? [];
    group.push(node);
    exactGroups.set(key, group);
  }
  const found: GraphAuditCandidate[] = [];
  const usedPairs = new Set<string>();
  const offer = (left: GraphNode, right: GraphNode, kind: GraphAuditKind, score: number, reason: string) => {
    const id = candidateId(left, right);
    if (usedPairs.has(id)) return;
    usedPairs.add(id);
    found.push({ id, leftId: left.id, rightId: right.id, kind, score, reason });
  };
  for (const group of exactGroups.values()) {
    if (group.length < 2) continue;
    // Anchor multi-duplicate sets to one keeper, rather than emit O(k^2) pairs.
    for (const node of group.slice(1)) offer(group[0]!, node, "exact", 1,
      "Identical proposition statements after whitespace normalization");
  }

  // Small, bounded lexical scan: exact results always take precedence.
  // Matching titles by themselves only recommend REVIEW, never auto-merging.
  const nearAllowed = ordered.length <= 3000;
  if (nearAllowed) {
    const grams = ordered.map(n => trigrams(n.statement));
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const left = ordered[i]!, right = ordered[j]!;
        if (normalizeAuditStatement(left.statement) === normalizeAuditStatement(right.statement)) continue;
        const equalTitle = simpleName(left.name) === simpleName(right.name) && left.name.trim().length >= 6;
        const maxLength = Math.max(left.statement.length, right.statement.length);
        const minLength = Math.min(left.statement.length, right.statement.length);
        if (!equalTitle && (maxLength < 35 || minLength / maxLength < 0.76)) continue;
        const similarity = dice(grams[i]!, grams[j]!);
        if (equalTitle || similarity >= 0.87) {
          offer(left, right, "possible", Math.round(similarity * 100) / 100,
            equalTitle ? "Same concept title; statements must be compared" :
              "Similar wording; verify hypotheses and quantifiers before merging");
        }
      }
    }
  }
  found.sort((a, b) => (a.kind === b.kind ? b.score - a.score || a.id.localeCompare(b.id)
    : a.kind === "exact" ? -1 : 1));
  const connected = new Set<string>();
  const known = new Set(nodes.map(n => n.id));
  let danglingChains = 0;
  for (const chain of chains) {
    if (!known.has(chain.conclusion) || chain.premises.some(p => !known.has(p))) {
      danglingChains++;
      continue;
    }
    connected.add(chain.conclusion);
    for (const p of chain.premises) connected.add(p);
  }
  return {
    nodeCount: nodes.length,
    chainCount: chains.length,
    exactCount: found.filter(c => c.kind === "exact").length,
    possibleCount: found.filter(c => c.kind === "possible").length,
    danglingChains,
    isolatedNodes: nodes.filter(n => !connected.has(n.id)).length,
    truncated: found.length > limit || !nearAllowed,
    candidates: found.slice(0, limit),
  };
}

/** Find the exact report candidate again to prevent stale or arbitrary merges. */
export function auditCandidateFromReport(
  report: GraphAuditReport,
  id: string,
): GraphAuditCandidate | null {
  return report.candidates.find(candidate => candidate.id === id) ?? null;
}

export interface AuditMergeStats {
  survivorId: string;
  removedId: string;
  removedNodes: number;
  chainsRedirected: number;
  degenerateChainsRemoved: number;
}

/** Synchronous, explicit merge against raw ledgers; caller handles backup/gate. */
export function mergeAuditedNodes(
  store: GraphStore,
  keepId: string,
  removeId: string,
): AuditMergeStats {
  if (keepId === removeId) throw new Error("Cannot merge a proposition into itself");
  const graph = getGraph(store);
  if (!graph.nodes.some(n => n.id === keepId) || !graph.nodes.some(n => n.id === removeId))
    throw new Error("One or both propositions no longer exist");

  const rawNodes = store.readNodes();
  const rawChains = store.readChains();
  const duplicateLines = rawNodes.filter(line => line.id === removeId);
  const nextNodes = [
    ...rawNodes.filter(line => line.id !== removeId),
    ...duplicateLines.map(line => ({ ...line, id: keepId })),
  ];

  let chainsRedirected = 0, degenerateChainsRemoved = 0;
  const removedChainIds = new Set<string>();
  const nextChains: GraphChain[] = [];
  for (const line of rawChains) {
    const substitute = (id: string) => id === removeId ? keepId : id;
    const premises = [...new Set(line.premises.map(substitute))];
    const conclusion = substitute(line.conclusion);
    const changed = conclusion !== line.conclusion || premises.some((p, i) => p !== line.premises[i]) ||
      premises.length !== line.premises.length;
    if (conclusion === keepId && premises.includes(keepId)) {
      // Merging two equivalent statements turns arguments between them
      // into self-implications; such edges carry no derivational content.
      degenerateChainsRemoved++;
      removedChainIds.add(line.id);
      continue;
    }
    if (changed) chainsRedirected++;
    nextChains.push(changed ? { ...line, premises, conclusion } : line);
  }

  // A chain ID might have another surviving assertion, so only remove the
  // position if the ID disappeared entirely from the resulting ledger.
  const survivingChainIds = new Set(nextChains.map(line => line.id));
  const oldPositions = store.readPositions();
  const nextPositions = { ...oldPositions };
  if (!nextPositions[keepId] && nextPositions[removeId]) nextPositions[keepId] = nextPositions[removeId]!;
  delete nextPositions[removeId];
  for (const id of removedChainIds) if (!survivingChainIds.has(id)) delete nextPositions[id];

  store.rewriteLedgers({ nodes: nextNodes, chains: nextChains });
  store.writePositions(nextPositions);
  return {
    survivorId: keepId, removedId: removeId, removedNodes: 1,
    chainsRedirected, degenerateChainsRemoved,
  };
}
