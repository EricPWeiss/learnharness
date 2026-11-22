import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { chunkImportedNotes } from "../src/core/notes-import-journal.ts";
import { createNotesImportJournal } from "../src/store/notes-import-journal.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-recovery-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const sourceId = "src_" + createHash("sha256").update("theorems.pdf").digest("hex").slice(0, 12);
const text = "Definition A\nTheorem B\nProof C\n";
const chunks = chunkImportedNotes(text, 3);
describe("resumable PDF checkpoints", () => {
  it("survives reopening store and retains original chunk budget", () => {
    const store = createNotesImportJournal(dir);
    store.begin({ sourceId, filePath: "theorems.pdf", text, chunks, chunkBudget: 3, importedAt: "2026-11-22T00:00:00Z" });
    assert.ok(chunks.length > 1);
    store.patchChunk(sourceId, 0, { stage: "extracted", findings: { propositions: [], chains: [] } });
    const later = createNotesImportJournal(dir);
    assert.deepEqual(later.load(sourceId)?.record.chunks[0]?.findings, { propositions: [], chains: [] });
    assert.equal(later.begin({ sourceId, filePath: "theorems.pdf", text, chunks, chunkBudget: 100, importedAt: "later" }).chunkBudget, 3);
  });
  it("records uncertain merge state across restarts", () => {
    const store = createNotesImportJournal(dir);
    store.patchChunk(sourceId, 0, { stage: "audited", audit: { links: [] } });
    store.patchChunk(sourceId, 0, { stage: "merging" });
    assert.equal(createNotesImportJournal(dir).list()[0]?.needsReview, true);
  });
  it("never includes saved PDF text in the progress API model", () => {
    assert.equal(JSON.stringify(createNotesImportJournal(dir).list()).includes("Definition A"), false);
  });
});
