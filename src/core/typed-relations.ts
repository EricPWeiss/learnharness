/** Durable typed relations derived from human-accepted audit suggestions.
 *
 * The existing-node audit record is the single source of truth: accepting a
 * directional verdict creates a relation in graph snapshots, dismissing it
 * removes the relation. This avoids partial dual-file writes and preserves
 * the original proposition and reasoning-chain ledgers unchanged.
 */
import {
  currentExistingNodeAudit, type ExistingNodeAuditRecord, type ExistingNodeAuditItem,
  type ExistingNodeText,
} from "./existing-node-audit.ts";

export type TypedRelationKind = "specializes" | "implies";

/** Direction: "from" is the SPECIAL CASE or the IMPLYING proposition;
 * "to" is the GENERAL CASE or the IMPLIED proposition.
 *
 * Every relation retains its audit evidence. Unlike an extracted proof
 * chain, a typed implication is an approved classification, not a proof.
 */
export interface TypedGraphRelation {
  key: string;
  from: string;
  to: string;
  kind: TypedRelationKind;
  explanation: string;
  auditedAt: string;
}

/** Returns null for equivalent/related/unrelated/uncertain or unaccepted
 * suggestions. Specialization never collapses two distinct propositions. */
export function typedRelationFromAudit(item: ExistingNodeAuditItem): TypedGraphRelation | null {
  if (item.status !== "accepted" || item.a === item.b) return null;
  const base = { key: item.key, explanation: item.explanation, auditedAt: item.auditedAt };
  switch (item.relation) {
    case "a_specializes_b": return { ...base, from: item.a, to: item.b, kind: "specializes" };
    case "b_specializes_a": return { ...base, from: item.b, to: item.a, kind: "specializes" };
    case "a_implies_b": return { ...base, from: item.a, to: item.b, kind: "implies" };
    case "b_implies_a": return { ...base, from: item.b, to: item.a, kind: "implies" };
    default: return null;
  }
}

/** Revalidate both endpoint fingerprints at READ time. A node deletion or
 * edited proposition invalidates its old audit claim without leaving a
 * dangling edge; it remains historical data until a subsequent rescan. */
export function acceptedTypedRelations(
  nodes: readonly ExistingNodeText[], record: ExistingNodeAuditRecord,
): TypedGraphRelation[] {
  const { items } = currentExistingNodeAudit(nodes, record);
  return items.flatMap(item => {
    const relation = typedRelationFromAudit(item);
    return relation === null ? [] : [relation];
  }).sort((a, b) => a.key.localeCompare(b.key));
}
