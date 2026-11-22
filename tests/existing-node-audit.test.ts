import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  currentExistingNodeAudit, emptyExistingNodeAudit, existingNodeCandidates,
  existingNodePairKey, type ExistingNodeAuditItem,
} from "../src/core/existing-node-audit.ts";

const nodes = [
  { id: "n_a", name: "Tree bipartite theorem", statement: "Every finite tree is bipartite." },
  { id: "n_b", name: "Path bipartite theorem", statement: "Every finite path is bipartite." },
  { id: "n_c", name: "Tree bipartite theorem", statement: "Every finite tree is bipartite." },
  { id: "n_d", name: "Monotone allocation", statement: "Incentive compatibility requires monotone allocation." },
];

describe("existing node audit candidates", () => {
  it("finds repetitions and potential generalization relations", () => {
    const pairs = existingNodeCandidates(nodes);
    const keys = new Set(pairs.map(p => p.key));
    assert.ok(keys.has(existingNodePairKey("n_a", "n_c")));
    assert.ok(keys.has(existingNodePairKey("n_a", "n_b")));
    assert.equal(keys.size, pairs.length);
  });
  it("is independent of input ordering and honors its limit", () => {
    const left = existingNodeCandidates(nodes, 2);
    const right = existingNodeCandidates([...nodes].reverse(), 2);
    assert.deepEqual(left, right);
    assert.equal(left.length, 2);
  });
  it("skips reviewed pairs but not suggestions for changed statements", () => {
    const record = emptyExistingNodeAudit();
    const [pair] = existingNodeCandidates(nodes);
    assert.ok(pair);
    const item: ExistingNodeAuditItem = {
      ...pair, relation: "equivalent", explanation: "Same formal proposition.",
      status: "suggested", auditedAt: "2026-11-22",
    };
    record.items[pair.key] = item;
    const view = currentExistingNodeAudit(nodes, record);
    assert.equal(view.items.length, 1);
    assert.ok(!view.remaining.some(p => p.key === pair.key));
    const changed = nodes.map(n => n.id === pair.b ? { ...n, statement: "A different statement." } : n);
    assert.equal(currentExistingNodeAudit(changed, record).items.length, 0);
  });
  it("does not invent a relation from source provenance", () => {
    const pairs = existingNodeCandidates(nodes);
    assert.ok(pairs.every(p => !p.key.includes("n_d|")));
    assert.deepEqual(existingNodeCandidates([], 100), []);
  });
});
