import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Cluster, GraphChain, GraphNode } from "../src/core/contracts.ts";
import type { SourceOrganization } from "../src/core/source-organization.ts";
import { clusterByFolder, folderAffinityGroups } from "../src/core/folder-clusters.ts";
import { computeInteractiveClusters, DEFAULT_CLUSTER_SETTINGS, sanitizeInteractiveClusterSettings } from "../src/core/interactive-clusters.ts";

const proposition = (id: string, src: string): GraphNode => ({
  id, name: id, statement: id, aliases: [], createdAt: "",
  provenance: [{ chatId: src, messageId: "" }],
});
const nodes = [
  proposition("n_a","src_a"), proposition("n_b","src_a"),
  proposition("n_c","src_b"), proposition("n_d","src_b"),
  proposition("n_e","src_c"), proposition("n_f","src_c"),
  proposition("n_g","src_d"), proposition("n_h","src_d"), proposition("n_i","src_d"),
];
const chains: GraphChain[] = [{id:"arg_test",premises:["n_a","n_b"],conclusion:"n_c",provenance:[],createdAt:""}];
const sources: Cluster[] = [{id:"src_a",label:"Paper A",members:["n_a","n_b"]},{id:"src_b",label:"Paper B",members:["n_c","n_d"]},{id:"src_d",label:"Paper D",members:["n_g","n_h","n_i"]}];
const organization: SourceOrganization = {
  version: 1,
  folders: [
    {id:"folder_root",name:"Economics",parentId:null,createdAt:""},
    {id:"folder_child",name:"Mechanism Design",parentId:"folder_root",createdAt:""},
  ],
  placements: {src_a:{folderId:"folder_child"},src_b:{folderId:"folder_child"},src_c:{folderId:"folder_root"},src_d:{folderId:null}},
};

describe("folder-based clusters", () => {
  it("groups PDFs in the same folder and leaves unfoldered PDFs independent", () => {
    const grouped = clusterByFolder(nodes, chains, sources, organization);
    assert.equal(grouped.find(g=>g.id==="folder:folder_child")?.label,"Mechanism Design");
    assert.deepEqual(grouped.find(g=>g.id==="folder:folder_child")?.members,["arg_test","n_a","n_b","n_c","n_d"]);
    assert.equal(grouped.find(g=>g.id==="source:src_d")?.label,"Paper D");
    assert.equal(grouped.some(g=>g.id==="folder:folder_root"),false);
  });
  it("can group subfolders under their top-level folder", () => {
    const grouped = clusterByFolder(nodes,[],sources,organization,"top");
    assert.deepEqual(grouped.find(g=>g.id==="folder:folder_root")?.members,["n_a","n_b","n_c","n_d","n_e","n_f"]);
  });
  it("uses latest folder names without rewriting graph data", () => {
    const before = JSON.stringify([nodes,chains,sources]);
    const renamed: SourceOrganization = {...organization,folders:organization.folders.map(f=>f.id==="folder_child"?{...f,name:"Renamed folder"}:f)};
    const grouped = computeInteractiveClusters(nodes,chains,sources,{...DEFAULT_CLUSTER_SETTINGS,mode:"folder"},renamed);
    assert.equal(grouped.find(g=>g.id==="folder:folder_child")?.label,"Renamed folder");
    assert.equal(JSON.stringify([nodes,chains,sources]),before);
  });
  it("folder hybrid uses additive parent/subfolder groups and no source fallback", () => {
    const groups = folderAffinityGroups(nodes, organization);
    assert.deepEqual(groups.find(g => g.folderId === "folder_child")?.members, ["n_a", "n_b", "n_c", "n_d"]);
    assert.deepEqual(groups.find(g => g.folderId === "folder_root")?.members, ["n_a", "n_b", "n_c", "n_d", "n_e", "n_f"]);
    assert.equal(groups.filter(g => g.members.includes("n_a") && g.members.includes("n_b")).length, 2);
    assert.equal(groups.filter(g => g.members.includes("n_a") && g.members.includes("n_e")).length, 1);
    assert.ok(groups.every(g => !g.members.includes("n_g")), "unfiled sources do not get PDF priors");
  });
  it("folder hybrid remains distinct from the existing PDF-based hybrid", () => {
    const tuned = { ...DEFAULT_CLUSTER_SETTINGS, mode: "folder-hybrid" as const, logicalWeight: 0 };
    const groups = computeInteractiveClusters(nodes, [], sources, tuned, organization);
    assert.ok(groups.length > 0, "a folder prior should produce visible communities without logical chains");
    assert.ok(groups.some(group => ["n_a", "n_b", "n_c", "n_d"].every(id => group.members.includes(id))),
      "the immediate subfolder should remain a visible group at the default granularity");
    assert.deepEqual(computeInteractiveClusters(nodes, [], sources, tuned, undefined), []);
    assert.ok(computeInteractiveClusters(nodes, [], sources,
      { ...DEFAULT_CLUSTER_SETTINGS, mode: "hybrid", logicalWeight: 0 }, undefined).length > 0);
  });
  it("accepts folder-hybrid in saved settings", () => {
    assert.equal(sanitizeInteractiveClusterSettings({ mode: "folder-hybrid" }).mode, "folder-hybrid");
  });
  it("sanitizes folder mode and level and preserves old configs", () => {
    assert.equal(sanitizeInteractiveClusterSettings({mode:"folder",folderLevel:"top"}).folderLevel,"top");
    assert.equal(sanitizeInteractiveClusterSettings({mode:"folder",folderLevel:"invalid"}).folderLevel,"direct");
    assert.equal(sanitizeInteractiveClusterSettings({mode:"hybrid"}).mode,"hybrid");
  });
});
