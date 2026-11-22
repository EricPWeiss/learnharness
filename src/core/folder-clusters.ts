/**
 * Presentation-only cluster grouping by LearnHarness's existing source folders.
 * No modification to node/chain provenance or persisted folder organization.
 */
import type { Cluster, GraphChain, GraphNode } from "./contracts.ts";
import type { SourceOrganization } from "./source-organization.ts";
import { MIN_CLUSTER_SIZE } from "./clusters.ts";

export type FolderGroupingLevel = "direct" | "top";

/**
 * Additive folder hierarchy prior for Folder Hybrid clustering.
 * Each proposition belongs to its immediate folder and all ancestors,
 * so sharing a subfolder generates more affinities than sharing only a
 * parent folder. The source's PDF identity is not used as a prior.
 */
export function folderAffinityGroups(
  propositions: readonly GraphNode[],
  organization: SourceOrganization | undefined,
): Array<{ folderId: string; members: string[] }> {
  if (!organization) return [];
  const folders = new Map(organization.folders.map(folder => [folder.id, folder]));
  const membership = new Map<string, Set<string>>();
  for (const node of propositions) {
    const birth = node.provenance[0]?.chatId;
    let folderId: string | null = birth ? organization.placements[birth]?.folderId ?? null : null;
    const seen = new Set<string>();
    while (folderId !== null && folders.has(folderId) && !seen.has(folderId)) {
      seen.add(folderId);
      const members = membership.get(folderId) ?? new Set<string>();
      members.add(node.id);
      membership.set(folderId, members);
      folderId = folders.get(folderId)!.parentId;
    }
  }
  return [...membership]
    .map(([folderId, members]) => ({ folderId, members: [...members].sort() }))
    .filter(group => group.members.length >= 2)
    .sort((a, b) => a.folderId.localeCompare(b.folderId));
}


export function clusterByFolder(
  propositions: readonly GraphNode[],
  chains: readonly GraphChain[],
  sourceClusters: readonly Cluster[],
  organization: SourceOrganization | undefined,
  level: FolderGroupingLevel = "direct",
): Cluster[] {
  const folderById = new Map((organization?.folders ?? []).map(folder => [folder.id, folder]));
  const sourceLabels = new Map(sourceClusters.map(cluster => [cluster.id, cluster.label]));
  const buckets = new Map<string, Cluster>();
  const communityOf = new Map<string, string>();
  const live = new Set(propositions.map(node => node.id));

  const groupingFolder = (direct: string): string => {
    if (level !== "top") return direct;
    let id = direct;
    const visited = new Set<string>();
    while (folderById.has(id) && !visited.has(id)) {
      visited.add(id);
      const parent = folderById.get(id)!.parentId;
      if (!parent || !folderById.has(parent)) break;
      id = parent;
    }
    return id;
  };

  for (const node of propositions) {
    const birth = node.provenance[0]?.chatId;
    if (!birth || communityOf.has(node.id)) continue;
    const placement = organization?.placements[birth]?.folderId;
    const folderId = placement && folderById.has(placement) ? groupingFolder(placement) : null;
    const key = folderId ? "folder:" + folderId : "source:" + birth;
    const label = folderId ? folderById.get(folderId)!.name : (sourceLabels.get(birth) ?? null);
    let community = buckets.get(key);
    if (!community) {
      community = { id: key, label, members: [] };
      buckets.set(key, community);
    }
    community.members.push(node.id);
    communityOf.set(node.id, key);
  }

  // The minimum size is based on propositions, excluding implication nodes.
  const visible = [...buckets.values()].filter(c => c.members.length >= MIN_CLUSTER_SIZE);
  const visibleById = new Map(visible.map(c => [c.id, c]));
  for (const chain of chains) {
    if (chain.premises.length < 2 || !live.has(chain.conclusion) || !chain.premises.every(p => live.has(p))) continue;
    const votes = new Map<string, number>();
    for (const premise of chain.premises) {
      const key = communityOf.get(premise);
      if (key && visibleById.has(key)) votes.set(key, (votes.get(key) ?? 0) + 1);
    }
    const winner = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (winner) visibleById.get(winner)!.members.push(chain.id);
  }
  for (const c of visible) c.members.sort();
  return visible.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
}
