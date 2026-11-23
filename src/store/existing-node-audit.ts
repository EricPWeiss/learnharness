/** Persistent, non-destructive suggestions about existing graph nodes.
 * No graph ledgers are modified by this store. */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";
import {
  emptyExistingNodeAudit, existingNodePairKey,
  type ExistingNodeAuditItem, type ExistingNodeAuditRecord, type ExistingNodeReviewStatus,
} from "../core/existing-node-audit.ts";

export const AUDIT_FILE = path.join(PATHS.graph, "existing-node-audit.json");

export function createExistingNodeAuditStore(file = AUDIT_FILE) {
  const read = (): ExistingNodeAuditRecord => {
    let contents: string;
    try { contents = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyExistingNodeAudit();
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(contents); }
    catch { throw new Error("Existing-node audit record is unreadable."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid node audit data.");
    const v = value as ExistingNodeAuditRecord;
    if (v.version !== 1 || !v.items || typeof v.items !== "object" || Array.isArray(v.items))
      throw new Error("Unrecognized node audit format.");
    for (const [key, item] of Object.entries(v.items)) {
      if (!item || item.key !== key || existingNodePairKey(item.a, item.b) !== key
        || typeof item.aFingerprint !== "string" || typeof item.bFingerprint !== "string"
        || typeof item.explanation !== "string" || typeof item.auditedAt !== "string"
        || !["equivalent", "a_specializes_b", "b_specializes_a", "a_implies_b", "b_implies_a",
          "related", "unrelated", "uncertain"].includes(item.relation)
        || !["suggested", "accepted", "dismissed"].includes(item.status))
        throw new Error("Invalid existing-node audit entry.");
    }
    return v;
  };
  const write = (record: ExistingNodeAuditRecord) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, JSON.stringify(record, null, 2));
  };
  return {
    read,
    add(items: ExistingNodeAuditItem[]) {
      const record = read();
      for (const item of items) {
        const old = record.items[item.key];
        // Preserve explicit decisions for an unchanged pair.
        record.items[item.key] = old && old.aFingerprint === item.aFingerprint
          && old.bFingerprint === item.bFingerprint && old.status !== "suggested" ? old : item;
      }
      write(record);
    },
    review(key: string, status: Exclude<ExistingNodeReviewStatus, "suggested">,
      active: ReadonlySet<string>) {
      const record = read();
      const item = record.items[key];
      if (!item || !active.has(item.a) || !active.has(item.b))
        throw new Error("Suggestion no longer exists in the graph.");
      item.status = status;
      write(record);
      return item;
    },
  };
}
export const existingNodeAuditStore = createExistingNodeAuditStore();
