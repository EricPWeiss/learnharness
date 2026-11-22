import type { AuditVerdicts, SessionFindings } from "./contracts.ts";

/** A durable record for the notes-only extract → audit → merge pipeline.
 * The source text is kept separately in a private local file. */
export type NotesChunkStage = "pending" | "extracted" | "audited" | "merging" | "merged";
export interface NotesChunkCheckpoint {
  hash: string;
  stage: NotesChunkStage;
  findings?: SessionFindings;
  audit?: AuditVerdicts;
  error?: string;
  finishedAt?: string;
}
export interface NotesImportCheckpoint {
  version: 1;
  sourceId: string;
  filePath: string;
  contentHash: string;
  chunkBudget: number;
  importedAt: string;
  updatedAt: string;
  chunks: NotesChunkCheckpoint[];
}
export interface NotesImportProgress {
  sourceId: string;
  filePath: string;
  total: number;
  merged: number;
  extracted: number;
  failed: number;
  needsReview: boolean;
  completed: boolean;
  lastError?: string;
  updatedAt: string;
}
export interface NotesImportJournal {
  begin(input: {
    sourceId: string; filePath: string; text: string; chunkBudget: number;
    chunks: readonly string[]; importedAt: string;
  }): NotesImportCheckpoint;
  load(sourceId: string): { record: NotesImportCheckpoint; text: string } | null;
  patchChunk(sourceId: string, index: number, patch: Partial<NotesChunkCheckpoint>): NotesChunkCheckpoint;
  list(): NotesImportProgress[];
  remove(sourceIds: ReadonlySet<string>): void;
}

/** Greedy line-stable chunking shared by initial imports and recovery.
 * The original chunk budget is saved; later user settings never shift
 * the boundaries of an in-progress import. */
export function chunkImportedNotes(text: string, budget: number): string[] {
  if (text.trim().length === 0) return [];
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current.length === 0 ? line : current + "\n" + line;
    if (current.length > 0 && Math.ceil(candidate.length / 4) > budget) {
      out.push(current);
      current = line;
    } else current = candidate;
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
