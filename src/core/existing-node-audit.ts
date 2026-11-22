/** Read-only candidate discovery for auditing EXISTING propositions.
 *
 * Candidate recall is deliberately approximate: shared technical terms are
 * used to bound model comparisons. It is not a proof that omitted pairs are
 * unrelated. The evaluator never writes graph nodes or reasoning chains.
 */
import { createHash } from "node:crypto";

export type ExistingNodeRelation =
  | "equivalent"
  | "a_specializes_b"
  | "b_specializes_a"
  | "a_implies_b"
  | "b_implies_a"
  | "related"
  | "unrelated"
  | "uncertain";

export type ExistingNodeReviewStatus = "suggested" | "accepted" | "dismissed";

export interface ExistingNodeCandidate {
  a: string;
  b: string;
  key: string;
  score: number;
  aFingerprint: string;
  bFingerprint: string;
}

export interface ExistingNodeAuditItem extends ExistingNodeCandidate {
  relation: ExistingNodeRelation;
  explanation: string;
  status: ExistingNodeReviewStatus;
  auditedAt: string;
}

export interface ExistingNodeAuditRecord {
  version: 1;
  items: Record<string, ExistingNodeAuditItem>;
}

export type ExistingNodeText = { id: string; name: string; statement: string };

const stop = new Set([
  "a", "an", "the", "of", "to", "and", "or", "in", "on", "for", "at",
  "with", "by", "from", "as", "is", "are", "be", "been", "being", "if",
  "then", "that", "this", "there", "each", "every", "all", "some",
  "any", "it", "its", "which", "where", "we", "can", "may", "has",
  "have", "had", "not", "does", "do", "one", "two", "given", "such",
  "only", "than", "under", "over", "into", "between",
]);

export const emptyExistingNodeAudit = (): ExistingNodeAuditRecord => ({ version: 1, items: {} });
export const existingNodeFingerprint = (node: ExistingNodeText): string =>
  createHash("sha256").update(JSON.stringify([node.name, node.statement])).digest("hex");

export const existingNodePairKey = (a: string, b: string): string =>
  a < b ? a + "|" + b : b + "|" + a;

const words = (text: string): Set<string> =>
  new Set((text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter(word => !stop.has(word)));

function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const word of a) if (b.has(word)) count++;
  return count;
}

/** Candidate pairs are selected via an inverted token index, avoiding
 * a graph-wide n² comparison. Rank order is deterministic and repeated
 * scans can skip already-reviewed fingerprints.
 *
 * This will miss pairs with no shared vocabulary: the UI must describe
 * the scan as "candidate audit", not "full logical verification".
 */
export function existingNodeCandidates(nodes: readonly ExistingNodeText[], limit = 3000): ExistingNodeCandidate[] {
  if (nodes.length < 2 || limit <= 0) return [];
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const tokenized = ordered.map(node => ({
    node, terms: words(node.name + " " + node.statement),
    name: node.name.trim().toLocaleLowerCase("en"),
    fingerprint: existingNodeFingerprint(node),
  }));
  const index = new Map<string, number[]>();
  for (let i = 0; i < tokenized.length; i++) {
    for (const term of tokenized[i]!.terms) {
      const posting = index.get(term) ?? [];
      posting.push(i);
      index.set(term, posting);
    }
  }
  const found = new Map<string, ExistingNodeCandidate>();
  for (let i = 0; i < tokenized.length; i++) {
    const from = tokenized[i]!;
    const possible = new Map<number, number>();
    for (const term of from.terms) {
      const posting = index.get(term) ?? [];
      // A ubiquitous word is not evidence for a mathematical relationship.
      if (posting.length > Math.max(20, Math.floor(ordered.length * 0.4))) continue;
      for (const j of posting) if (j > i) possible.set(j, (possible.get(j) ?? 0) + 1);
    }
    const scored: ExistingNodeCandidate[] = [];
    for (const [j, shared] of possible) {
      const to = tokenized[j]!;
      const sameName = from.name.length >= 3 && from.name === to.name;
      if (shared < 2 && !sameName) continue;
      const intersect = intersectionSize(from.terms, to.terms);
      const minSize = Math.max(1, Math.min(from.terms.size, to.terms.size));
      const unionSize = Math.max(1, from.terms.size + to.terms.size - intersect);
      const score = (sameName ? 1 : 0) + 0.65 * intersect / minSize + 0.35 * intersect / unionSize;
      if (score < 0.27 && !sameName) continue;
      scored.push({
        a: from.node.id, b: to.node.id, key: existingNodePairKey(from.node.id, to.node.id),
        score, aFingerprint: from.fingerprint, bFingerprint: to.fingerprint,
      });
    }
    scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    for (const candidate of scored.slice(0, 5)) found.set(candidate.key, candidate);
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, limit);
}

/** An audit conclusion must not survive changes to the underlying claim.
 * Removed nodes also disappear from the active suggestion view. */
export function currentExistingNodeAudit(
  nodes: readonly ExistingNodeText[], record: ExistingNodeAuditRecord,
  candidateLimit = 3000,
): {
  candidates: ExistingNodeCandidate[];
  items: ExistingNodeAuditItem[];
  remaining: ExistingNodeCandidate[];
} {
  const candidates = existingNodeCandidates(nodes, candidateLimit);
  const active = new Map(nodes.map(node => [node.id, existingNodeFingerprint(node)]));
  const items = Object.values(record.items).filter(item =>
    active.get(item.a) === item.aFingerprint && active.get(item.b) === item.bFingerprint);
  const considered = new Set(items.map(item => item.key));
  return { candidates, items, remaining: candidates.filter(pair => !considered.has(pair.key)) };
}
