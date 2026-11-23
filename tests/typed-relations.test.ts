import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptedTypedRelations, typedRelationFromAudit,
} from "../src/core/typed-relations.ts";
import {
  emptyExistingNodeAudit, existingNodeCandidates,
  type ExistingNodeAuditItem,
} from "../src/core/existing-node-audit.ts";

const nodes = [
  { id: "n_a", name: "General theorem", statement: "Every finite tree is bipartite" },
  { id: "n_b", name: "Special case", statement: "Every finite path is bipartite" },
];
const pair = existingNodeCandidates(nodes)[0];
assert.ok(pair);
function audit(relation: ExistingNodeAuditItem["relation"], status: ExistingNodeAuditItem["status"] = "accepted"): ExistingNodeAuditItem {
  return { ...pair!, relation, status, explanation: "Finite paths are trees.", auditedAt: "2026-11-23" };
}
describe("approved typed knowledge relationships", () => {
  it("respects A/B direction for specialization", () => {
    assert.deepEqual(typedRelationFromAudit(audit("a_specializes_b")), {
      key: pair!.key, from: pair!.a, to: pair!.b,
      kind: "specializes", explanation: "Finite paths are trees.", auditedAt: "2026-11-23",
    });
    assert.equal(typedRelationFromAudit(audit("b_specializes_a"))?.from, pair!.b);
    assert.equal(typedRelationFromAudit(audit("b_specializes_a"))?.to, pair!.a);
  });
  it("respects implication direction but never creates a proof chain", () => {
    const direct = typedRelationFromAudit(audit("a_implies_b"));
    const inverse = typedRelationFromAudit(audit("b_implies_a"));
    assert.equal(direct?.kind, "implies");
    assert.equal(direct?.from, pair!.a);
    assert.equal(inverse?.from, pair!.b);
    assert.equal(inverse?.to, pair!.a);
    assert.ok(!("premises" in direct!));
  });
  it("does not connect equivalent or unreviewed propositions", () => {
    for (const relation of ["equivalent", "related", "unrelated", "uncertain"] as const)
      assert.equal(typedRelationFromAudit(audit(relation)), null);
    assert.equal(typedRelationFromAudit(audit("a_implies_b", "suggested")), null);
    assert.equal(typedRelationFromAudit(audit("a_specializes_b", "dismissed")), null);
  });
  it("adds on acceptance, removes on dismissal, invalidates missing or changed nodes", () => {
    const record = emptyExistingNodeAudit();
    const item = audit("b_specializes_a", "suggested");
    record.items[item.key] = item;
    assert.deepEqual(acceptedTypedRelations(nodes, record), []);
    item.status = "accepted";
    assert.equal(acceptedTypedRelations(nodes, record).length, 1);
    assert.deepEqual(acceptedTypedRelations(nodes.slice(0, 1), record), []);
    assert.deepEqual(acceptedTypedRelations(nodes.map(n => ({ ...n, statement: "changed " + n.statement })), record), []);
    item.status = "dismissed";
    assert.deepEqual(acceptedTypedRelations(nodes, record), []);
  });
});
