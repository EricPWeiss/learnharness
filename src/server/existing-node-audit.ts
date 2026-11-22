/** Explicit audit of existing graph propositions.
 * This is NOT the import auditor. Never auto-merge nodes or write chains.
 * A bounded set of candidates is proposed locally; an LLM judges pairs
 * and the results are stored as reviewable suggestions. */
import { Type, type Static } from "typebox";
import { randomUUID } from "node:crypto";
import { piEngineForSpec } from "../agent/models.ts";
import { runSubmitAgent } from "../agent/subagents/submit-agent.ts";
import { ROLE_SLOT } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import {
  currentExistingNodeAudit, existingNodeCandidates, existingNodeFingerprint,
  type ExistingNodeAuditItem, type ExistingNodeCandidate, type ExistingNodeRelation,
} from "../core/existing-node-audit.ts";
import { stores } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";
import { existingNodeAuditStore } from "../store/existing-node-audit.ts";
import { getGraph } from "../core/graph.ts";

const relations = [
  "equivalent", "a_specializes_b", "b_specializes_a",
  "a_implies_b", "b_implies_a", "related", "unrelated", "uncertain",
] as const;

const verdictSchema = Type.Object({
  verdicts: Type.Array(Type.Object({
    key: Type.String(),
    relation: Type.Union(relations.map(relation => Type.Literal(relation))),
    explanation: Type.String(),
  })),
});
type Verdicts = Static<typeof verdictSchema>;
const INSTRUCTIONS = [
  "You are auditing pairs of EXISTING mathematical and conceptual propositions in a knowledge graph.",
  "Classify semantic relationships. Treat the statements as claims, not names or source-file identities.",
  "equivalent means logically the same proposition under the same assumptions.",
  "a_specializes_b means A is strictly more specific than B (B's statement covers A).",
  "b_specializes_a means B is strictly more specific than A.",
  "a_implies_b or b_implies_a means a one-way implication that is not just a specialization.",
  "related means meaningfully connected but not provably equivalent or implied from the stated assumptions.",
  "unrelated means there is no meaningful relationship evident from the statements.",
  "uncertain means missing hypotheses or ambiguity prevent a defensible classification.",
  "Never treat shared terminology or matching titles alone as logical equivalence.",
  "For implications and specializations, explain the logical reason and identify relevant conditions.",
  "Do not invent theorems or missing assumptions. Prefer uncertain when unsure.",
  "Return exactly one verdict for each pair in the prompt, and use its exact key.",
  "You cannot modify the graph; all verdicts are provisional suggestions for human review.",
].join("\n");

let active = false;
export function existingNodeAuditStatus(): boolean { return active; }

export function existingNodeAuditView() {
  const nodes = getGraph(stores.graphStore).nodes.filter(n => n.id.startsWith("n_"));
  const view = currentExistingNodeAudit(nodes, existingNodeAuditStore.read());
  return {
    running: active,
    totalNodes: nodes.length,
    candidateCount: view.candidates.length,
    remaining: view.remaining.length,
    items: view.items.sort((a, b) => b.auditedAt.localeCompare(a.auditedAt)),
    // Provide titles for compact UI, no raw source text or provider secrets.
    names: Object.fromEntries(nodes.map(node => [node.id, node.name])),
  };
}

/** Review a maximum of one model batch per click to bound cost and avoid
 * tying a request to hours of processing. Repeat the button to continue.
 * Every model batch is validated before its suggestions are saved. */
export async function scanExistingNodeAudit(batchSize = 12) {
  if (active) throw new Error("A node audit is already running.");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 12)
    throw new Error("Invalid audit batch size.");
  active = true;
  try {
    const nodes = getGraph(stores.graphStore).nodes.filter(n => n.id.startsWith("n_"));
    const initial = currentExistingNodeAudit(nodes, existingNodeAuditStore.read());
    const candidates = initial.remaining.slice(0, batchSize);
    if (candidates.length === 0) return { processed: 0, ...existingNodeAuditView() };
    const spec = resolveRoleSpec("auditor", stores.settingsStore.readSettings());
    if (!spec) throw new Error("Configure an auditor model in Settings before scanning.");
    if (!providerKeyPresent(spec.provider)) throw new Error("The configured auditor provider key is missing.");
    const engine = piEngineForSpec(spec, true);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const request = candidates.map(pair => {
      const a = byId.get(pair.a)!, b = byId.get(pair.b)!;
      return { key: pair.key, a: { name: a.name, statement: a.statement },
        b: { name: b.name, statement: b.statement } };
    });
    const expected = new Set(candidates.map(pair => pair.key));
    const result = await runSubmitAgent<Verdicts>({
      role: "auditor",
      chatId: "node-audit-" + randomUUID(),
      toolName: "submit_relationships",
      toolDescription: "Return relationship judgments for existing graph proposition pairs.",
      parameters: verdictSchema,
      fill: (value: Verdicts) => value,
      systemPrompt: INSTRUCTIONS,
      prompt: JSON.stringify(request),
      engine, signal: undefined,
      neverSubmitted: "The relationship auditor did not submit classifications.",
      onStep: () => {},
      validate: value => {
        if (value.verdicts.length !== candidates.length) return "Submit exactly one verdict per pair.";
        const seen = new Set<string>();
        for (const verdict of value.verdicts) {
          if (!expected.has(verdict.key) || seen.has(verdict.key) || !verdict.explanation.trim())
            return "Verdict keys must match the supplied pairs uniquely, with non-empty explanations.";
          seen.add(verdict.key);
        }
        return null;
      },
    });
    // Another operation may have deleted or modified nodes while the
    // external model was running. Never save stale conclusions.
    const latestNodes = getGraph(stores.graphStore).nodes.filter(n => n.id.startsWith("n_"));
    const latest = new Map(latestNodes.map(n => [n.id, existingNodeFingerprint(n)]));
    const byKey = new Map(candidates.map(candidate => [candidate.key, candidate]));
    const items = result.verdicts.flatMap(v => {
      const pair = byKey.get(v.key)!;
      if (latest.get(pair.a) !== pair.aFingerprint || latest.get(pair.b) !== pair.bFingerprint) return [];
      return [{
        ...pair, relation: v.relation as ExistingNodeRelation,
        explanation: v.explanation.trim(), status: "suggested" as const,
        auditedAt: new Date().toISOString(),
      }];
    });
    existingNodeAuditStore.add(items);
    return { processed: items.length, ...existingNodeAuditView() };
  } finally { active = false; }
}

export function reviewExistingNodeAudit(key: string, status: "accepted" | "dismissed") {
  if (active) throw new Error("Cannot change audit decisions during an active scan.");
  const nodes = getGraph(stores.graphStore).nodes.filter(n => n.id.startsWith("n_"));
  const selected = currentExistingNodeAudit(nodes, existingNodeAuditStore.read()).items.find(item => item.key === key);
  if (!selected) throw new Error("Suggestion is stale or missing.");
  const activeIds = new Set(nodes.map(n => n.id));
  existingNodeAuditStore.review(key, status, activeIds);
  return existingNodeAuditView();
}
