import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceOrganization } from "../src/core/source-organization.ts";
import { sourceFolderBreadcrumb } from "../src/core/source-folder-breadcrumb.ts";

const state: SourceOrganization = {
  version: 1,
  folders: [
    { id: "root", name: "Economics", parentId: null, createdAt: "" },
    { id: "child", name: "Mechanism Design", parentId: "root", createdAt: "" },
  ],
  placements: { src_1: { folderId: "child" }, src_2: { folderId: null } },
};
describe("source provenance folder breadcrumbs", () => {
  it("shows full parent and subfolder hierarchy", () => {
    assert.equal(sourceFolderBreadcrumb(state, "src_1"), "Economics / Mechanism Design");
  });
  it("reflects renaming and moving without changing the original metadata", () => {
    const changed = structuredClone(state);
    changed.folders[1]!.name = "Social Choice";
    changed.folders[1]!.parentId = null;
    assert.equal(sourceFolderBreadcrumb(changed, "src_1"), "Social Choice");
    assert.equal(sourceFolderBreadcrumb(state, "src_1"), "Economics / Mechanism Design");
  });
  it("never invents folder locations for unfiled or missing sources", () => {
    assert.equal(sourceFolderBreadcrumb(state, "src_2"), null);
    assert.equal(sourceFolderBreadcrumb(state, "unknown"), null);
    assert.equal(sourceFolderBreadcrumb(undefined, "src_1"), null);
  });
});
