/**
 * Private, local-only notes-import journal. Checkpoints are written atomically;
 * the (potentially large) normalized PDF text lives in a separate .txt file,
 * so chunk updates never rewrite it. Both live under LH_DATA_DIR/graph.
 *
 * A "merging" chunk means a crash could have happened after some ledger
 * writes but before the checkpoint. Never retry it automatically.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync, removeLeftoverTemps } from "./atomic-write.ts";
import { chunkImportedNotes, type NotesImportCheckpoint, type NotesImportJournal, type NotesImportProgress } from "../core/notes-import-journal.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const sourceIdPattern = /^src_[a-f0-9]{12}$/;
function validId(id: string): void {
  if (!sourceIdPattern.test(id)) throw new Error("Invalid import source id.");
}
const safeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createNotesImportJournal(root = path.join(PATHS.graph, "import-recovery")): NotesImportJournal {
  const names = (id: string) => {
    validId(id);
    return { meta: path.join(root, id + ".json"), text: path.join(root, id + ".txt") };
  };
  const read = (id: string): NotesImportCheckpoint | null => {
    const { meta } = names(id);
    let body: string;
    try { body = fs.readFileSync(meta, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    let record: NotesImportCheckpoint;
    try { record = JSON.parse(body) as NotesImportCheckpoint; }
    catch { throw new Error("Import checkpoint is corrupted: " + id); }
    if (record.version !== 1 || record.sourceId !== id || !Array.isArray(record.chunks) ||
      typeof record.filePath !== "string" || typeof record.contentHash !== "string" ||
      !Number.isInteger(record.chunkBudget) || record.chunkBudget <= 0 ||
      typeof record.importedAt !== "string" || typeof record.updatedAt !== "string" ||
      !record.chunks.every(c => c && typeof c.hash === "string" &&
        ["pending", "extracted", "audited", "merging", "merged"].includes(c.stage)))
      throw new Error("Import checkpoint has an invalid or newer format: " + id);
    return record;
  };
  const save = (record: NotesImportCheckpoint): void => {
    fs.mkdirSync(root, { recursive: true });
    writeFileAtomicSync(names(record.sourceId).meta, JSON.stringify(record, null, 2), { mode: 0o600 });
  };
  const load: NotesImportJournal["load"] = (id) => {
    const record = read(id);
    if (!record) return null;
    let text: string;
    try { text = fs.readFileSync(names(id).text, "utf8"); }
    catch { throw new Error("Saved import text is missing or unreadable for: " + record.filePath); }
    if (sha(text) !== record.contentHash) throw new Error("Saved import text has changed: " + record.filePath);
    const pieces = chunkImportedNotes(text, record.chunkBudget);
    if (pieces.length !== record.chunks.length ||
      pieces.some((piece, i) => sha(piece) !== record.chunks[i]!.hash))
      throw new Error("Saved import chunk boundaries do not match: " + record.filePath);
    return { record, text };
  };
  return {
    begin(input) {
      const existing = load(input.sourceId);
      const digest = sha(input.text);
      if (existing) {
        if (existing.record.filePath !== input.filePath || existing.record.contentHash !== digest)
          throw new Error("This source has a saved import with different content. Delete the old source and its graph traces before importing a changed version.");
        // Keep the stored chunk size even if the current model budget changed.
        return existing.record;
      }
      if (input.chunkBudget <= 0 || !Number.isInteger(input.chunkBudget)) throw new Error("Invalid notes chunk budget.");
      const record: NotesImportCheckpoint = {
        version: 1, sourceId: input.sourceId, filePath: input.filePath,
        contentHash: digest, chunkBudget: input.chunkBudget,
        importedAt: input.importedAt, updatedAt: new Date().toISOString(),
        chunks: input.chunks.map(piece => ({ hash: sha(piece), stage: "pending" })),
      };
      fs.mkdirSync(root, { recursive: true });
      writeFileAtomicSync(names(input.sourceId).text, input.text, { mode: 0o600 });
      save(record);
      return record;
    },
    load,
    patchChunk(id, index, patch) {
      const record = read(id);
      if (!record || !Number.isInteger(index) || index < 0 || index >= record.chunks.length)
        throw new Error("No such saved import chunk.");
      const old = record.chunks[index]!;
      if (patch.hash !== undefined && patch.hash !== old.hash)
        throw new Error("Cannot change the fingerprint of a saved import chunk.");
      const updated = { ...old, ...patch, hash: old.hash };
      record.chunks[index] = updated;
      record.updatedAt = new Date().toISOString();
      save(record);
      return updated;
    },
    list(): NotesImportProgress[] {
      let entries: string[];
      try { entries = fs.readdirSync(root); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
      return entries.filter(name => /^src_[a-f0-9]{12}\.json$/.test(name))
        .map(name => read(name.slice(0, -5))!)
        .map(r => ({
          sourceId: r.sourceId, filePath: r.filePath, total: r.chunks.length,
          merged: r.chunks.filter(c => c.stage === "merged").length,
          extracted: r.chunks.filter(c => Boolean(c.findings) && c.stage !== "merged").length,
          failed: r.chunks.filter(c => Boolean(c.error)).length,
          needsReview: r.chunks.some(c => c.stage === "merging"),
          completed: r.chunks.every(c => c.stage === "merged"),
          lastError: r.chunks.findLast(c => Boolean(c.error))?.error,
          updatedAt: r.updatedAt,
        })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    remove(ids) {
      for (const id of ids) {
        const { meta, text } = names(id);
        for (const file of [meta, text]) {
          try { fs.unlinkSync(file); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not delete saved import: " + safeError(e)); }
          removeLeftoverTemps(file);
        }
      }
    },
  };
}
export const notesImportJournal = createNotesImportJournal();
