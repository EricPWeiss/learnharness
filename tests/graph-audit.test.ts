import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphNode, GraphChain } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { auditGraph, mergeAuditedNodes } from "../src/core/graph-audit.ts";
import { getGraph } from "../src/core/graph.ts";

const node = (id: string, statement: string, source: string): GraphNode =>
  ({ id, name: id, statement, aliases: [], createdAt: "", provenance: [{ chatId: source, messageId: "" }] });
const chain = (id: string, premises: string[], conclusion: string): GraphChain =>
  ({ id, premises, conclusion, provenance: [{ chatId: "source", messageId: "" }], createdAt: "" });
const a = node("n_a", "For all S, the inequality holds.", "s_a");
const b = node("n_b", "For all S, the inequality holds.", "s_b");
const c = node("n_c", "Every allocation is efficient.", "s_c");
const d = node("n_d", "All allocations are efficient.", "s_d");
const e = node("n_e", "Every allocation is inefficient.", "s_e");

function fixture(nodes: GraphNode[], chains: GraphChain[]) {
  let n = [...nodes], ch = [...chains];
  let positions: Record<string, { x: number; y: number }> = {
    n_a: { x: 1, y: 1 }, n_b: { x: 2, y: 2 }, arg_loop: { x: 3, y: 3 },
  };
  const graph = {
    readNodes: () => n,
    readChains: () => ch,
    rewriteLedgers: (next: {nodes?: GraphNode[]; chains?: GraphChain[]}) => {
      if (next.nodes) n = next.nodes;
      if (next.chains) ch = next.chains;
    },
    readPositions: () => positions,
    writePositions: (next: typeof positions) => { positions = next; },
  } as GraphStore;
  return { graph, read: () => ({ nodes: n, chains: ch, positions }) };
}

describe("post-import graph audit", () => {
  it("identifies exact duplicates but does not merge them during read", () => {
    const before = JSON.stringify([a, b, c, d, e]);
    const report = auditGraph([a, b, c, d, e], []);
    assert.equal(report.exactCount, 1);
    assert.deepEqual([report.candidates[0]?.leftId, report.candidates[0]?.rightId], ["n_a", "n_b"]);
    assert.equal(report.candidates[0]?.kind, "exact");
    assert.equal(JSON.stringify([a, b, c, d, e]), before);
  });
  it("flags similar but logically different statements for manual review only", () => {
    const report = auditGraph([c, d, e], []);
    assert.ok(report.candidates.every(item => item.kind === "possible"));
    assert.equal(report.exactCount, 0);
  });
  it("reports dangling chains and isolated propositions independently", () => {
    const report = auditGraph([a, b, c], [chain("arg_missing", ["n_a", "missing"], "n_b")]);
    assert.equal(report.danglingChains, 1);
    assert.equal(report.isolatedNodes, 3);
  });
  it("explicitly approved merge preserves provenance, aliases, and rewrites chain endpoints", () => {
    const f = fixture([a, b, c], [
      chain("arg_redirect", ["n_b"], "n_c"),
      chain("arg_loop", ["n_a"], "n_b"),
      chain("arg_keep", ["n_c"], "n_a"),
    ]);
    const stats = mergeAuditedNodes(f.graph, "n_a", "n_b");
    assert.equal(stats.removedNodes, 1);
    assert.equal(stats.chainsRedirected, 1);
    assert.equal(stats.degenerateChainsRemoved, 1);
    const derived = getGraph(f.graph);
    assert.equal(derived.nodes.length, 2);
    assert.deepEqual(derived.nodes.find(n => n.id === "n_a")!.provenance.map(p => p.chatId), ["s_a", "s_b"]);
    assert.ok(derived.chains.some(ch => ch.premises.includes("n_a") && ch.conclusion === "n_c"));
    assert.ok(!derived.chains.some(ch => ch.id === "arg_loop"));
    assert.equal(f.read().positions.n_b, undefined);
    assert.equal(f.read().positions.arg_loop, undefined);
  });
  it("refuses arbitrary invalid merges without writes", () => {
    const f = fixture([a], []);
    assert.throws(() => mergeAuditedNodes(f.graph, "n_a", "n_missing"), /no longer exist/);
    assert.equal(f.read().nodes.length, 1);
  });
});
