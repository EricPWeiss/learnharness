import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { chunkImportedNotes } from "../src/core/notes-import-journal.ts";
import { createNotesImportJournal } from "../src/store/notes-import-journal.ts";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-import-journal-"));
after(() => fs.rmSync(directory, { force: true, recursive: true }));
const id = "src_" + createHash("sha256").update("study.pdf").digest("hex").slice(0, 12);
const text = "# A\nfirst item\n# B\nsecond item\n";
const journal = createNotesImportJournal(directory);
describe("durable notes import journal", () => {
  it("stores page-marked content and fixed chunks without altering the input", () => {
    const chunks = chunkImportedNotes(text, 5);
    const r = journal.begin({ sourceId: id, filePath: "study.pdf", text, chunks, chunkBudget: 5, importedAt: "2026-11-22" });
    assert.equal(r.chunks.length, chunks.length);
    assert.equal(journal.load(id)?.text, text);
    assert.equal(journal.load(id)?.record.chunks[0]?.stage, "pending");
    assert.equal(journal.begin({ sourceId: id, filePath: "study.pdf", text, chunks, chunkBudget: 10, importedAt: "later" }).chunkBudget, 5);
  });
  it("saves extracted results, audit judgments and committed status", () => {
    journal.patchChunk(id, 0, { stage: "extracted", findings: { propositions: [], chains: [] } });
    journal.patchChunk(id, 0, { stage: "audited", audit: { links: [] } });
    journal.patchChunk(id, 0, { stage: "merging" });
    assert.equal(journal.list()[0]?.needsReview, true);
    journal.patchChunk(id, 0, { stage: "merged", finishedAt: new Date().toISOString() });
    assert.equal(journal.load(id)?.record.chunks[0]?.stage, "merged");
    assert.equal(journal.list()[0]?.merged, 1);
  });
  it("refuses changed content instead of silently replaying an old source", () => {
    assert.throws(() => journal.begin({ sourceId: id, filePath: "study.pdf", text: "changed", chunks: ["changed"], chunkBudget: 5, importedAt: "later" }), /different content/);
    assert.equal(journal.load(id)?.text, text);
  });
  it("guards source IDs and removes checkpoints alongside deleted sources", () => {
    assert.throws(() => journal.load("../outside"), /Invalid import source id/);
    journal.remove(new Set([id]));
    assert.equal(journal.load(id), null);
    assert.deepEqual(journal.list(), []);
  });
});
